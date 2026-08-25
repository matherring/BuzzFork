//! Interactive agent prompt requests (v1) — parsing and validation.
//!
//! Mirrors `buzz-sdk`'s `prompt` module on the read side. A prompt request is an
//! ordinary kind 9 message carrying bounded `prompt` / `prompt-option` tags plus
//! a single `p` tag naming the one identity allowed to answer.
//!
//! Everything here is a pure function over an event's tags: nothing trusts
//! renderer-supplied state. `send_prompt_response` re-parses the signed request
//! event straight from the relay before it will sign anything.

/// Tag name for the prompt request descriptor.
pub const PROMPT_TAG: &str = "prompt";
/// Tag name for a single selectable prompt option.
pub const PROMPT_OPTION_TAG: &str = "prompt-option";
/// Tag name for a prompt response.
pub const PROMPT_RESPONSE_TAG: &str = "prompt-response";
/// The only prompt schema version accepted by this slice.
pub const PROMPT_VERSION: &str = "v1";
/// The only prompt kind accepted by this slice.
pub const PROMPT_KIND_EXEC_APPROVAL: &str = "exec-approval";
/// Option id meaning "allow this one execution".
pub const PROMPT_OPTION_ONCE: &str = "once";
/// Option id meaning "deny this execution".
pub const PROMPT_OPTION_DENY: &str = "deny";

/// Option ids this slice knows how to render and resolve.
pub const KNOWN_OPTION_IDS: [&str; 2] = [PROMPT_OPTION_ONCE, PROMPT_OPTION_DENY];

/// Maximum number of options on a single prompt.
pub const MAX_PROMPT_OPTIONS: usize = 4;
/// Maximum rendered length of an option label.
pub const MAX_OPTION_LABEL_LEN: usize = 32;
/// Minimum prompt id length — matches the SDK's unpredictability floor.
pub const MIN_PROMPT_ID_LEN: usize = 8;
/// Maximum prompt id length.
pub const MAX_PROMPT_ID_LEN: usize = 64;

/// One selectable option on a prompt request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptOption {
    /// Semantic option id — always one of [`KNOWN_OPTION_IDS`].
    pub id: String,
    /// Human-readable button label.
    pub label: String,
    /// Render style — always one of [`KNOWN_OPTION_STYLES`].
    pub style: String,
}

/// A validated prompt request parsed from a signed event's tags.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptRequest {
    /// Opaque prompt id.
    pub prompt_id: String,
    /// Prompt kind — always [`PROMPT_KIND_EXEC_APPROVAL`] in this slice.
    pub prompt_kind: String,
    /// Unix timestamp after which the prompt is dead.
    pub expires_at: i64,
    /// Options in tag order.
    pub options: Vec<PromptOption>,
    /// The single pubkey permitted to answer, lowercase hex.
    pub authorized_responder: String,
}

impl PromptRequest {
    /// Look up an option by its semantic id.
    pub fn option(&self, option_id: &str) -> Option<&PromptOption> {
        self.options.iter().find(|option| option.id == option_id)
    }

    /// Whether this prompt is still live at `now`.
    pub fn is_live_at(&self, now: i64) -> bool {
        now < self.expires_at
    }
}

fn valid_prompt_id(prompt_id: &str) -> bool {
    (MIN_PROMPT_ID_LEN..=MAX_PROMPT_ID_LEN).contains(&prompt_id.len())
        && prompt_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

fn valid_label(label: &str) -> bool {
    !label.trim().is_empty()
        && label.chars().count() <= MAX_OPTION_LABEL_LEN
        && !label.chars().any(|c| c.is_control())
}

fn valid_pubkey(pubkey: &str) -> bool {
    pubkey.len() == 64 && pubkey.chars().all(|c| c.is_ascii_hexdigit())
}

/// Parse a prompt request from an event's raw tags.
///
/// Returns `None` for anything that is not exactly one well-formed v1 request:
/// a message with no prompt tags, duplicate `prompt` tags, a malformed or
/// unknown-kind descriptor, an invalid expiry, options belonging to another
/// prompt id, unknown or duplicate option ids, overlong labels, too many
/// options, or anything other than exactly one authorized responder.
///
/// Expiry is *parsed*, not enforced, so callers can render an expired card;
/// enforcement lives in [`PromptRequest::is_live_at`] and the response command.
pub fn parse_prompt_request(tags: &[Vec<String>]) -> Option<PromptRequest> {
    let mut descriptor: Option<(String, String, i64)> = None;
    for tag in tags {
        if tag.first().map(String::as_str) != Some(PROMPT_TAG) {
            continue;
        }
        if descriptor.is_some() {
            // Duplicate descriptors are ambiguous — reject the whole request
            // rather than picking one.
            return None;
        }
        if tag.len() != 5 || tag[1] != PROMPT_VERSION {
            return None;
        }
        let prompt_id = tag[2].clone();
        if !valid_prompt_id(&prompt_id) {
            return None;
        }
        if tag[3] != PROMPT_KIND_EXEC_APPROVAL {
            return None;
        }
        let expires_at = tag[4].parse::<i64>().ok()?;
        if expires_at <= 0 {
            return None;
        }
        descriptor = Some((prompt_id, tag[3].clone(), expires_at));
    }

    let (prompt_id, prompt_kind, expires_at) = descriptor?;

    let mut options: Vec<PromptOption> = Vec::new();
    for tag in tags {
        if tag.first().map(String::as_str) != Some(PROMPT_OPTION_TAG) {
            continue;
        }
        if tag.len() != 5 {
            return None;
        }
        // An option tag naming a different prompt id has no place on this event.
        if tag[1] != prompt_id {
            return None;
        }
        let (id, label, style) = (tag[2].clone(), tag[3].clone(), tag[4].clone());
        let expected = match id.as_str() {
            PROMPT_OPTION_ONCE => ("Allow once", "primary"),
            PROMPT_OPTION_DENY => ("Deny", "danger"),
            _ => return None,
        };
        if label != expected.0
            || style != expected.1
            || !valid_label(&label)
        {
            return None;
        }
        if options.iter().any(|existing| existing.id == id) {
            return None;
        }
        if options.len() == MAX_PROMPT_OPTIONS {
            return None;
        }
        options.push(PromptOption { id, label, style });
    }

    // `exec-approval` is defined by its two built-in options; a request missing
    // one (or carrying only one) is not the prompt this slice knows how to answer.
    if options.len() != KNOWN_OPTION_IDS.len() {
        return None;
    }

    let responders: Vec<&String> = tags
        .iter()
        .filter(|tag| tag.first().map(String::as_str) == Some("p"))
        .filter_map(|tag| tag.get(1))
        .collect();
    let [responder] = responders.as_slice() else {
        // Zero responders means nobody is authorized; more than one means the
        // request never named a single accountable answerer.
        return None;
    };
    if !valid_pubkey(responder) {
        return None;
    }

    Some(PromptRequest {
        prompt_id,
        prompt_kind,
        expires_at,
        options,
        authorized_responder: responder.to_ascii_lowercase(),
    })
}

/// Convert a signed event's tags into the raw string vectors the parser takes.
pub fn event_tag_vecs(event: &nostr::Event) -> Vec<Vec<String>> {
    event
        .tags
        .iter()
        .map(|tag| tag.as_slice().to_vec())
        .collect()
}

/// The descriptive, non-executable content of a prompt response.
pub fn prompt_response_content(label: &str) -> String {
    format!("Responded: {label}")
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROMPT_ID: &str = "prompt-abc123";
    const RESPONDER: &str =
        "abababababababababababababababababababababababababababababababab";

    fn tags() -> Vec<Vec<String>> {
        vec![
            vec!["h".into(), "11111111-2222-3333-4444-555555555555".into()],
            vec![
                PROMPT_TAG.into(),
                PROMPT_VERSION.into(),
                PROMPT_ID.into(),
                PROMPT_KIND_EXEC_APPROVAL.into(),
                "1800000060".into(),
            ],
            vec![
                PROMPT_OPTION_TAG.into(),
                PROMPT_ID.into(),
                PROMPT_OPTION_ONCE.into(),
                "Allow once".into(),
                "primary".into(),
            ],
            vec![
                PROMPT_OPTION_TAG.into(),
                PROMPT_ID.into(),
                PROMPT_OPTION_DENY.into(),
                "Deny".into(),
                "danger".into(),
            ],
            vec!["p".into(), RESPONDER.into()],
        ]
    }

    #[test]
    fn parses_exact_contract() {
        let prompt = parse_prompt_request(&tags()).expect("valid prompt");
        assert_eq!(prompt.prompt_id, PROMPT_ID);
        assert_eq!(prompt.authorized_responder, RESPONDER);
        assert_eq!(prompt.options.len(), 2);
        assert!(prompt.option(PROMPT_OPTION_ONCE).is_some());
        assert!(prompt.option(PROMPT_OPTION_DENY).is_some());
    }

    #[test]
    fn rejects_misleading_label_or_style() {
        let mut misleading_label = tags();
        misleading_label[2][3] = "Deny".into();
        assert!(parse_prompt_request(&misleading_label).is_none());

        let mut misleading_style = tags();
        misleading_style[2][4] = "danger".into();
        assert!(parse_prompt_request(&misleading_style).is_none());
    }

    #[test]
    fn rejects_duplicate_or_cross_prompt_tags() {
        let mut duplicate = tags();
        duplicate.push(duplicate[1].clone());
        assert!(parse_prompt_request(&duplicate).is_none());

        let mut crossed = tags();
        crossed[2][1] = "another-prompt".into();
        assert!(parse_prompt_request(&crossed).is_none());
    }

    #[test]
    fn rejects_ambiguous_responder() {
        let mut ambiguous = tags();
        ambiguous.push(vec!["p".into(), "cd".repeat(32)]);
        assert!(parse_prompt_request(&ambiguous).is_none());
    }

    #[test]
    fn checks_expiry_at_authorization_time() {
        let prompt = parse_prompt_request(&tags()).expect("valid prompt");
        assert!(prompt.is_live_at(1_800_000_059));
        assert!(!prompt.is_live_at(1_800_000_060));
    }
}
