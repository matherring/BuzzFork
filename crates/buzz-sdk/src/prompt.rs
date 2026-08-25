//! Interactive agent prompt requests (v1).
//!
//! An agent prompt is an ordinary kind 9 channel message carrying a bounded set
//! of `prompt` tags, so it reuses the existing relay authorization, timeline,
//! threading, signing, and subscription paths. Clients that don't understand the
//! tags still render the message content as plain text.
//!
//! This module is deliberately narrow: callers pick a prompt kind, not arbitrary
//! tags. The only kind in this slice is `exec-approval`, whose options are the
//! two built-ins `once` / `deny`.
//!
//! ```text
//! ["prompt", "v1", <prompt-id>, "exec-approval", <expires-at-unix>]
//! ["prompt-option", <prompt-id>, "once", "Allow once", "primary"]
//! ["prompt-option", <prompt-id>, "deny", "Deny", "danger"]
//! ["p", <authorized-responder-pubkey>]
//! ```

use nostr::{EventBuilder, Kind, Tag};
use uuid::Uuid;

use crate::SdkError;

/// Tag name for the prompt request descriptor.
pub const PROMPT_TAG: &str = "prompt";
/// Tag name for a single selectable prompt option.
pub const PROMPT_OPTION_TAG: &str = "prompt-option";
/// Tag name for a prompt response.
pub const PROMPT_RESPONSE_TAG: &str = "prompt-response";
/// Prompt schema version emitted and accepted by this slice.
pub const PROMPT_VERSION: &str = "v1";
/// The only prompt kind supported by this slice.
pub const PROMPT_KIND_EXEC_APPROVAL: &str = "exec-approval";
/// Option id meaning "allow this one execution".
pub const PROMPT_OPTION_ONCE: &str = "once";
/// Option id meaning "deny this execution".
pub const PROMPT_OPTION_DENY: &str = "deny";

/// Minimum prompt id length — ids must be opaque and unpredictable, so a short
/// id (which a peer could guess or enumerate) is rejected outright.
pub const MIN_PROMPT_ID_LEN: usize = 8;
/// Maximum prompt id length.
pub const MAX_PROMPT_ID_LEN: usize = 64;
/// Maximum lifetime of a prompt, in seconds, measured from now.
pub const MAX_PROMPT_TTL_SECS: i64 = 24 * 60 * 60;
/// Maximum request content size, matching `build_message`.
pub const MAX_PROMPT_CONTENT_BYTES: usize = 64 * 1024;

/// Built-in options for `exec-approval`, in render order.
///
/// Each entry is `(option id, label, style)`. Callers cannot add, remove, or
/// relabel these — the option set is part of the kind, not caller input.
pub const EXEC_APPROVAL_OPTIONS: [(&str, &str, &str); 2] = [
    (PROMPT_OPTION_ONCE, "Allow once", "primary"),
    (PROMPT_OPTION_DENY, "Deny", "danger"),
];

fn tag(parts: &[&str]) -> Result<Tag, SdkError> {
    Tag::parse(parts.iter().copied()).map_err(|e| SdkError::InvalidTag(e.to_string()))
}

/// Validate an opaque prompt id.
///
/// Ids are transport-safe (`[A-Za-z0-9._-]`) and bounded. Nothing here can prove
/// unpredictability, but the length floor rules out trivially guessable ids.
pub fn validate_prompt_id(prompt_id: &str) -> Result<(), SdkError> {
    if prompt_id.len() < MIN_PROMPT_ID_LEN || prompt_id.len() > MAX_PROMPT_ID_LEN {
        return Err(SdkError::InvalidInput(format!(
            "prompt id must be {MIN_PROMPT_ID_LEN}–{MAX_PROMPT_ID_LEN} characters (got {})",
            prompt_id.len()
        )));
    }
    if !prompt_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
    {
        return Err(SdkError::InvalidInput(
            "prompt id may only contain [A-Za-z0-9._-]".into(),
        ));
    }
    Ok(())
}

/// Validate a prompt expiry against a caller-supplied clock.
///
/// The expiry must be strictly in the future and no further out than
/// [`MAX_PROMPT_TTL_SECS`]; an unbounded expiry would leave a clickable
/// approval sitting in a timeline indefinitely.
pub fn validate_prompt_expiry(expires_at: i64, now: i64) -> Result<(), SdkError> {
    if expires_at <= now {
        return Err(SdkError::InvalidInput(format!(
            "prompt expiry {expires_at} is not in the future (now {now})"
        )));
    }
    if expires_at - now > MAX_PROMPT_TTL_SECS {
        return Err(SdkError::InvalidInput(format!(
            "prompt expiry {expires_at} exceeds the maximum lifetime of {MAX_PROMPT_TTL_SECS}s"
        )));
    }
    Ok(())
}

fn validate_responder(pubkey: &str) -> Result<String, SdkError> {
    if pubkey.len() != 64 || !pubkey.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(SdkError::InvalidInput(
            "authorized responder must be a 64-character hex pubkey".into(),
        ));
    }
    Ok(pubkey.to_ascii_lowercase())
}

/// Build an `exec-approval` prompt request (kind 9).
///
/// `content` is the human-readable command/reason plus any typed fallback; it is
/// rendered verbatim by clients that don't understand prompt tags. `expires_at`
/// is a Unix timestamp validated against the current clock.
///
/// The emitted tag set is exactly: `h`, `prompt`, one `prompt-option` per
/// built-in option, and a single `p` tag for the authorized responder.
pub fn build_exec_approval_prompt(
    channel_id: Uuid,
    content: &str,
    prompt_id: &str,
    expires_at: i64,
    authorized_responder: &str,
) -> Result<EventBuilder, SdkError> {
    build_exec_approval_prompt_at(
        channel_id,
        content,
        prompt_id,
        expires_at,
        authorized_responder,
        nostr::Timestamp::now().as_secs() as i64,
    )
}

/// [`build_exec_approval_prompt`] with an injectable clock, for tests.
pub fn build_exec_approval_prompt_at(
    channel_id: Uuid,
    content: &str,
    prompt_id: &str,
    expires_at: i64,
    authorized_responder: &str,
    now: i64,
) -> Result<EventBuilder, SdkError> {
    if content.trim().is_empty() {
        return Err(SdkError::InvalidInput(
            "prompt content must not be empty".into(),
        ));
    }
    if content.len() > MAX_PROMPT_CONTENT_BYTES {
        return Err(SdkError::ContentTooLarge {
            max: MAX_PROMPT_CONTENT_BYTES,
            got: content.len(),
        });
    }
    validate_prompt_id(prompt_id)?;
    validate_prompt_expiry(expires_at, now)?;
    let responder = validate_responder(authorized_responder)?;

    let expires = expires_at.to_string();
    let mut tags = vec![
        tag(&["h", &channel_id.to_string()])?,
        tag(&[
            PROMPT_TAG,
            PROMPT_VERSION,
            prompt_id,
            PROMPT_KIND_EXEC_APPROVAL,
            &expires,
        ])?,
    ];
    for (option_id, label, style) in EXEC_APPROVAL_OPTIONS {
        tags.push(tag(&[
            PROMPT_OPTION_TAG,
            prompt_id,
            option_id,
            label,
            style,
        ])?);
    }
    tags.push(tag(&["p", &responder])?);

    Ok(EventBuilder::new(Kind::Custom(9), content)
        .tags(tags)
        .allow_self_tagging())
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHANNEL: &str = "11111111-2222-3333-4444-555555555555";
    const RESPONDER: &str = "AB";
    const NOW: i64 = 1_800_000_000;

    fn responder() -> String {
        RESPONDER.repeat(32)
    }

    fn channel() -> Uuid {
        Uuid::parse_str(CHANNEL).expect("valid uuid")
    }

    fn build(prompt_id: &str, expires_at: i64) -> Result<Vec<Vec<String>>, SdkError> {
        let builder = build_exec_approval_prompt_at(
            channel(),
            "Run `just ci`?",
            prompt_id,
            expires_at,
            &responder(),
            NOW,
        )?;
        let keys = nostr::Keys::generate();
        let event = builder.sign_with_keys(&keys).expect("sign");
        Ok(event
            .tags
            .iter()
            .map(|t| t.as_slice().to_vec())
            .collect::<Vec<_>>())
    }

    #[test]
    fn emits_exact_bounded_tags() {
        let tags = build("prompt-abc123", NOW + 60).expect("builds");
        assert_eq!(
            tags,
            vec![
                vec!["h".to_string(), CHANNEL.to_string()],
                vec![
                    "prompt".to_string(),
                    "v1".to_string(),
                    "prompt-abc123".to_string(),
                    "exec-approval".to_string(),
                    (NOW + 60).to_string(),
                ],
                vec![
                    "prompt-option".to_string(),
                    "prompt-abc123".to_string(),
                    "once".to_string(),
                    "Allow once".to_string(),
                    "primary".to_string(),
                ],
                vec![
                    "prompt-option".to_string(),
                    "prompt-abc123".to_string(),
                    "deny".to_string(),
                    "Deny".to_string(),
                    "danger".to_string(),
                ],
                vec!["p".to_string(), responder().to_ascii_lowercase()],
            ]
        );
    }

    #[test]
    fn lowercases_the_authorized_responder() {
        let tags = build("prompt-abc123", NOW + 60).expect("builds");
        let p = tags.last().expect("p tag");
        assert_eq!(p[1], responder().to_ascii_lowercase());
        assert!(!p[1].chars().any(|c| c.is_ascii_uppercase()));
    }

    #[test]
    fn rejects_short_or_overlong_prompt_ids() {
        assert!(build("short", NOW + 60).is_err());
        assert!(build(&"a".repeat(MAX_PROMPT_ID_LEN + 1), NOW + 60).is_err());
        assert!(build(&"a".repeat(MAX_PROMPT_ID_LEN), NOW + 60).is_ok());
    }

    #[test]
    fn rejects_prompt_ids_with_unsafe_characters() {
        for bad in ["rm -rf /tmp", "prompt id", "prompt\tid", "prompt\"id"] {
            assert!(build(bad, NOW + 60).is_err(), "accepted {bad:?}");
        }
    }

    #[test]
    fn rejects_expiry_in_the_past_or_now() {
        assert!(build("prompt-abc123", NOW - 1).is_err());
        assert!(build("prompt-abc123", NOW).is_err());
        assert!(build("prompt-abc123", 0).is_err());
        assert!(build("prompt-abc123", -1).is_err());
    }

    #[test]
    fn rejects_expiry_beyond_the_maximum_lifetime() {
        assert!(build("prompt-abc123", NOW + MAX_PROMPT_TTL_SECS).is_ok());
        assert!(build("prompt-abc123", NOW + MAX_PROMPT_TTL_SECS + 1).is_err());
    }

    #[test]
    fn rejects_malformed_responders() {
        for bad in ["", "not-hex", &"ab".repeat(31), &"ab".repeat(33)] {
            let result = build_exec_approval_prompt_at(
                channel(),
                "Run `just ci`?",
                "prompt-abc123",
                NOW + 60,
                bad,
                NOW,
            );
            assert!(result.is_err(), "accepted {bad:?}");
        }
    }

    #[test]
    fn rejects_empty_content() {
        let result = build_exec_approval_prompt_at(
            channel(),
            "   \n ",
            "prompt-abc123",
            NOW + 60,
            &responder(),
            NOW,
        );
        assert!(result.is_err());
    }

    #[test]
    fn rejects_oversized_content() {
        let content = "a".repeat(MAX_PROMPT_CONTENT_BYTES + 1);
        let result = build_exec_approval_prompt_at(
            channel(),
            &content,
            "prompt-abc123",
            NOW + 60,
            &responder(),
            NOW,
        );
        assert!(matches!(result, Err(SdkError::ContentTooLarge { .. })));
    }

    #[test]
    fn keeps_content_verbatim_as_the_plain_text_fallback() {
        let content = "Allow `just ci`?\nReply /approve or /deny.";
        let builder = build_exec_approval_prompt_at(
            channel(),
            content,
            "prompt-abc123",
            NOW + 60,
            &responder(),
            NOW,
        )
        .expect("builds");
        let event = builder
            .sign_with_keys(&nostr::Keys::generate())
            .expect("sign");
        assert_eq!(event.content, content);
        assert_eq!(event.kind, Kind::Custom(9));
    }
}
