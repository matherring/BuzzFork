//! Source-redacted Control Tower manifest for a Buzz ACP turn.
//!
//! This is a direct adaptation of Buzz Control Tower v0.8.2's
//! `local_workstream.rs` context projection. The harness already has the exact
//! `(channel, turn, session)` boundary, so it can publish provenance without
//! re-reading private runtime rollout files in the desktop process.

use std::fs;
use std::path::{Path, PathBuf};

use regex::Regex;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::prompt_project::PromptProjectInfo;
use crate::queue::{ConversationContext, FlushBatch, PromptChannelInfo, StandingContext};
use crate::scope::SessionScope;

const MAX_VISIBLE_TEXT: usize = 1_200;
const MAX_CONTEXT_SOURCES: usize = 16;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ManifestField {
    label: String,
    value: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ManifestContextSource {
    id: String,
    kind: String,
    label: String,
    detail: String,
    hash: String,
    size: String,
    visibility: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    fields: Vec<ManifestField>,
    #[serde(skip_serializing_if = "Option::is_none")]
    withheld_reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ManifestEvidence {
    stage: String,
    label: String,
    detail: String,
    complete: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    facts: Vec<ManifestField>,
}

pub(crate) struct TurnManifestInput<'a> {
    pub turn_id: &'a str,
    pub session_id: &'a str,
    pub cwd: &'a str,
    pub model: Option<&'a str>,
    pub scope: &'a SessionScope,
    pub channel_info: Option<&'a PromptChannelInfo>,
    pub batch: &'a FlushBatch,
    pub conversation_context: Option<&'a ConversationContext>,
    pub standing: &'a StandingContext<'a>,
}

fn short_hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))[..12].to_string()
}

fn byte_size(bytes: usize) -> String {
    if bytes >= 1024 {
        format!("{:.1} KiB", bytes as f64 / 1024.0)
    } else {
        format!("{bytes} B")
    }
}

fn truncate_to(value: &str, limit: usize) -> String {
    let mut result = value.chars().take(limit).collect::<String>();
    if value.chars().count() > limit {
        result.push('…');
    }
    result
}

// Adapted from Control Tower's source-side redactor. Invalid static patterns
// fail closed by leaving that replacement step out; no runtime data can turn a
// pattern invalid.
fn redact_with_limit(value: &str, limit: usize) -> String {
    let mut redacted = value.to_string();
    if let Ok(pattern) = Regex::new(
        r#"(?i)\b(api[_-]?key|secret|token|password|private[_-]?key)\s*[:=]\s*[\"']?[^\s\"'`]+"#,
    ) {
        redacted = pattern.replace_all(&redacted, "$1=[redacted]").into_owned();
    }
    if let Ok(pattern) = Regex::new(r"\b(?:nsec1|sk-|gh[pousr]_|tskey-)[A-Za-z0-9_-]{8,}\b") {
        redacted = pattern
            .replace_all(&redacted, "[redacted-credential]")
            .into_owned();
    }
    if let Ok(pattern) = Regex::new(r"\b[0-9a-fA-F]{64}\b") {
        redacted = pattern.replace_all(&redacted, "[redacted-64]").into_owned();
    }
    truncate_to(&redacted, limit)
}

struct ManifestSourceInput<'a> {
    id: String,
    kind: &'a str,
    label: &'a str,
    raw: &'a str,
    detail: &'a str,
    visibility: &'a str,
    content: Option<String>,
    fields: Vec<ManifestField>,
    withheld_reason: Option<&'a str>,
}

fn manifest_source(input: ManifestSourceInput<'_>) -> ManifestContextSource {
    ManifestContextSource {
        id: input.id,
        kind: input.kind.into(),
        label: input.label.into(),
        detail: input.detail.into(),
        hash: short_hash(input.raw.as_bytes()),
        size: byte_size(input.raw.len()),
        visibility: input.visibility.into(),
        content: input.content,
        fields: input.fields,
        withheld_reason: input.withheld_reason.map(str::to_string),
    }
}

fn project_standing_source(
    turn_id: &str,
    index: usize,
    kind: &str,
    label: &str,
    raw: Option<&str>,
    reason: &str,
) -> Option<ManifestContextSource> {
    let raw = raw.map(str::trim).filter(|value| !value.is_empty())?;
    Some(manifest_source(ManifestSourceInput {
        id: format!("{turn_id}-context-{index}"),
        kind,
        label,
        raw,
        detail:
            "This context was supplied to the runtime; select it to inspect its visibility boundary.",
        visibility: "provenance",
        content: None,
        fields: Vec::new(),
        withheld_reason: Some(reason),
    }))
}

fn context_summary(context: &ConversationContext) -> (String, Vec<ManifestField>) {
    match context {
        ConversationContext::Thread {
            messages,
            total,
            root_present,
            truncated,
        } => {
            let raw = messages
                .iter()
                .map(|message| {
                    format!(
                        "{}\n{}\n{}\n{}",
                        message.event_id, message.pubkey, message.timestamp, message.content
                    )
                })
                .collect::<Vec<_>>()
                .join("\n---\n");
            (
                raw,
                vec![
                    ManifestField {
                        label: "Visible messages".into(),
                        value: messages.len().to_string(),
                    },
                    ManifestField {
                        label: "Known total".into(),
                        value: total.to_string(),
                    },
                    ManifestField {
                        label: "Root present".into(),
                        value: root_present.to_string(),
                    },
                    ManifestField {
                        label: "Truncated".into(),
                        value: truncated.to_string(),
                    },
                ],
            )
        }
        ConversationContext::Dm {
            messages,
            total,
            truncated,
        } => {
            let raw = messages
                .iter()
                .map(|message| {
                    format!(
                        "{}\n{}\n{}\n{}",
                        message.event_id, message.pubkey, message.timestamp, message.content
                    )
                })
                .collect::<Vec<_>>()
                .join("\n---\n");
            (
                raw,
                vec![
                    ManifestField {
                        label: "Visible messages".into(),
                        value: messages.len().to_string(),
                    },
                    ManifestField {
                        label: "Known total".into(),
                        value: total.to_string(),
                    },
                    ManifestField {
                        label: "Truncated".into(),
                        value: truncated.to_string(),
                    },
                ],
            )
        }
    }
}

fn project_info_source(turn_id: &str, project: &PromptProjectInfo) -> ManifestContextSource {
    let raw = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        project.name,
        project.slug,
        project.owner,
        project.coordinate,
        project.default_repo_owner.as_deref().unwrap_or_default(),
        project.default_repo_id.as_deref().unwrap_or_default()
    );
    let mut fields = vec![
        ManifestField {
            label: "Project".into(),
            value: redact_with_limit(&project.name, 160),
        },
        ManifestField {
            label: "Coordinate".into(),
            value: redact_with_limit(&project.coordinate, 240),
        },
    ];
    if let (Some(owner), Some(id)) = (&project.default_repo_owner, &project.default_repo_id) {
        fields.push(ManifestField {
            label: "Repository".into(),
            value: redact_with_limit(&format!("{owner}/{id}"), 240),
        });
    }
    manifest_source(ManifestSourceInput {
        id: format!("{turn_id}-project"),
        kind: "project",
        label: "Buzz project",
        raw: &raw,
        detail: "Authoritative NIP-MP project metadata resolved for this channel.",
        visibility: "full",
        content: None,
        fields,
        withheld_reason: None,
    })
}

fn git_directory(cwd: &Path) -> Option<PathBuf> {
    let dot_git = cwd.join(".git");
    if dot_git.is_dir() {
        return Some(dot_git);
    }
    let marker = fs::read_to_string(dot_git).ok()?;
    let relative = marker.trim().strip_prefix("gitdir:")?.trim();
    let candidate = PathBuf::from(relative);
    Some(if candidate.is_absolute() {
        candidate
    } else {
        cwd.join(candidate)
    })
}

fn git_provenance(cwd: &str) -> (Option<String>, Option<String>) {
    let git_dir = git_directory(Path::new(cwd));
    let Some(git_dir) = git_dir else {
        return (None, None);
    };
    let Ok(head) = fs::read_to_string(git_dir.join("HEAD")) else {
        return (None, None);
    };
    let head = head.trim();
    if let Some(reference) = head.strip_prefix("ref: ") {
        let branch = reference.strip_prefix("refs/heads/").unwrap_or(reference);
        let direct = fs::read_to_string(git_dir.join(reference)).ok();
        let common = fs::read_to_string(git_dir.join("commondir"))
            .ok()
            .map(|path| git_dir.join(path.trim()).join(reference))
            .and_then(|path| fs::read_to_string(path).ok());
        let revision = direct.or(common).map(|value| value.trim().to_string());
        return (Some(truncate_to(branch, 200)), revision);
    }
    let revision = (!head.is_empty()).then(|| truncate_to(head, 64));
    (Some("detached HEAD".into()), revision)
}

fn workstream(input: &TurnManifestInput<'_>) -> (String, String) {
    if let Some(project) = input.channel_info.and_then(|info| info.project.as_ref()) {
        return (project.coordinate.clone(), project.name.clone());
    }
    let title = input
        .channel_info
        .map(|info| info.name.trim())
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("Channel {}", input.scope.channel_id()));
    let id = input
        .scope
        .root_event_id()
        .map(str::to_string)
        .unwrap_or_else(|| input.session_id.to_string());
    (id, title)
}

fn initial_evidence(input: &TurnManifestInput<'_>) -> Vec<ManifestEvidence> {
    let local_fact = ManifestField {
        label: "Exact turn".into(),
        value: format!(
            "channel={} turn={} session={}",
            input.scope.channel_id(),
            input.turn_id,
            input.session_id
        ),
    };
    let mut evidence = vec![ManifestEvidence {
        stage: "local".into(),
        label: "Runtime observed".into(),
        detail: "The ACP harness accepted this turn and published its redacted manifest.".into(),
        complete: true,
        facts: vec![local_fact],
    }];
    for (stage, label) in [
        ("committed", "No commit evidence"),
        ("pushed", "No push evidence"),
        ("pr-open", "No pull request evidence"),
        ("merged", "No merge evidence"),
        ("deployed", "No deployment evidence"),
    ] {
        evidence.push(ManifestEvidence {
            stage: stage.into(),
            label: label.into(),
            detail: "Fleet does not infer delivery from agent activity.".into(),
            complete: false,
            facts: Vec::new(),
        });
    }
    evidence
}

pub(crate) fn build_turn_manifest(input: &TurnManifestInput<'_>) -> Value {
    let operation = input
        .batch
        .events
        .first()
        .map(|event| redact_with_limit(event.event.content.trim(), 240))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Observed Buzz turn".into());
    let model = input.model.unwrap_or("Model unavailable");
    let (branch, head) = git_provenance(input.cwd);
    let workspace = Path::new(input.cwd)
        .file_name()
        .map(|part| part.to_string_lossy().to_string())
        .unwrap_or_else(|| "Local workspace".into());
    let runtime_raw = format!("{}\n{}\n{:?}\n{:?}", input.cwd, model, branch, head);
    let mut runtime_fields = vec![
        ManifestField {
            label: "Workspace".into(),
            value: redact_with_limit(&workspace, 200),
        },
        ManifestField {
            label: "Model".into(),
            value: redact_with_limit(model, 200),
        },
    ];
    if let Some(value) = &branch {
        runtime_fields.push(ManifestField {
            label: "Branch".into(),
            value: redact_with_limit(value, 200),
        });
    }
    if let Some(value) = &head {
        runtime_fields.push(ManifestField {
            label: "Head".into(),
            value: redact_with_limit(value, 64),
        });
    }

    let mut context = vec![manifest_source(ManifestSourceInput {
        id: format!("{}-runtime-context", input.turn_id),
        kind: "repository",
        label: "Runtime context",
        raw: &runtime_raw,
        detail: "Safe runtime metadata for this exact ACP session.",
        visibility: "full",
        content: None,
        fields: runtime_fields,
        withheld_reason: None,
    })];

    let trigger_raw = input
        .batch
        .events
        .iter()
        .map(|event| format!("{}\n{}", event.event.id.to_hex(), event.event.content))
        .collect::<Vec<_>>()
        .join("\n---\n");
    context.push(manifest_source(ManifestSourceInput {
        id: format!("{}-trigger", input.turn_id),
        kind: "thread",
        label: "Triggering Buzz turn",
        raw: &trigger_raw,
        detail: "Human-authored Buzz request content that started this runtime turn.",
        visibility: "summary",
        content: Some(redact_with_limit(&trigger_raw, MAX_VISIBLE_TEXT)),
        fields: vec![ManifestField {
            label: "Events".into(),
            value: input.batch.events.len().to_string(),
        }],
        withheld_reason: None,
    }));

    if let Some(conversation) = input.conversation_context {
        let (raw, fields) = context_summary(conversation);
        context.push(manifest_source(ManifestSourceInput {
            id: format!("{}-conversation", input.turn_id),
            kind: "thread",
            label: "Conversation context",
            raw: &raw,
            detail: "Thread or direct-message history supplied to the runtime.",
            visibility: "provenance",
            content: None,
            fields,
            withheld_reason: Some(
                "Message bodies stay in Buzz; Fleet exposes provenance, counts, hash, and size.",
            ),
        }));
    }

    let standing = input.standing;
    for standing_source in [
        (
            "base",
            "Base instructions",
            standing.base_prompt,
            "Raw platform instructions stay at the harness because they can contain security policy and internal control text.",
        ),
        (
            "team",
            "System instructions",
            standing.system_prompt,
            "Raw system instructions stay at the harness because they can contain operational policy and private workspace guidance.",
        ),
        (
            "team",
            "Team instructions",
            standing.team_instructions,
            "Raw team instructions stay at the harness because they can contain private workspace guidance.",
        ),
        (
            "memory",
            "Agent memory",
            standing.agent_core,
            "Raw durable memory stays at the harness because it can contain private operational history or credential-adjacent material.",
        ),
        (
            "canvas",
            "Channel canvas",
            standing.agent_canvas,
            "The canvas body stays in Buzz; this record proves which injected revision shaped the turn without duplicating channel state.",
        ),
    ]
    .into_iter()
    .enumerate()
    .filter_map(|(index, (kind, label, raw, reason))| {
        project_standing_source(input.turn_id, index, kind, label, raw, reason)
    })
    {
        context.push(standing_source);
    }
    if let Some(project) = input.channel_info.and_then(|info| info.project.as_ref()) {
        context.push(project_info_source(input.turn_id, project));
    }
    context.truncate(MAX_CONTEXT_SOURCES);

    let (workstream_id, workstream_title) = workstream(input);
    json!({
        "operation": operation,
        "role": "Managed agent",
        "model": model,
        "branch": branch,
        "head": head,
        "helperCount": 0,
        "workstreamId": workstream_id,
        "workstreamTitle": workstream_title,
        "phase": "Live turn",
        "context": context,
        "evidence": initial_evidence(input),
        "artifacts": [],
    })
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use nostr::{EventBuilder, Keys, Kind};
    use uuid::Uuid;

    use super::{
        build_turn_manifest, git_provenance, redact_with_limit, short_hash, TurnManifestInput,
    };
    use crate::queue::{BatchEvent, FlushBatch, PromptChannelInfo, StandingContext};
    use crate::scope::SessionScope;

    #[test]
    fn redacts_common_secret_shapes_and_private_sized_hex() {
        let visible = redact_with_limit(
            "api_key=secret123 sk-examplecredential ghp_examplecredential123456 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            1_200,
        );
        assert_eq!(
            visible,
            "api_key=[redacted] [redacted-credential] [redacted-credential] [redacted-64]"
        );
    }

    #[test]
    fn hashes_are_short_stable_provenance() {
        assert_eq!(short_hash(b"context"), short_hash(b"context"));
        assert_ne!(short_hash(b"context"), short_hash(b"other"));
        assert_eq!(short_hash(b"context").len(), 12);
    }

    #[test]
    fn non_repository_provenance_is_explicitly_absent() {
        assert_eq!(git_provenance("/definitely/not/a/repository"), (None, None));
    }

    #[test]
    fn manifest_keeps_exact_identity_and_withholds_standing_context() {
        let channel_id = Uuid::new_v4();
        let event = EventBuilder::new(Kind::Custom(9), "ship it api_key=secret123")
            .tags([])
            .sign_with_keys(&Keys::generate())
            .unwrap();
        let batch = FlushBatch {
            channel_id,
            scope: SessionScope::Conversation { channel_id },
            events: vec![BatchEvent {
                event,
                prompt_tag: "@mention".into(),
                received_at: Instant::now(),
            }],
            cancelled_events: Vec::new(),
            cancel_reason: None,
        };
        let standing = StandingContext {
            base_prompt: Some("private base policy"),
            agent_core: Some("private durable memory"),
            ..Default::default()
        };
        let channel_info = PromptChannelInfo {
            name: "delivery".into(),
            ..Default::default()
        };
        let manifest = build_turn_manifest(&TurnManifestInput {
            turn_id: "turn-7",
            session_id: "session-9",
            cwd: "/definitely/not/a/repository",
            model: Some("test-model"),
            scope: &batch.scope,
            channel_info: Some(&channel_info),
            batch: &batch,
            conversation_context: None,
            standing: &standing,
        });
        let encoded = manifest.to_string();

        assert_eq!(manifest["workstreamId"], "session-9");
        assert_eq!(manifest["workstreamTitle"], "delivery");
        assert_eq!(manifest["phase"], "Live turn");
        assert!(encoded.contains("api_key=[redacted]"));
        assert!(!encoded.contains("secret123"));
        assert!(!encoded.contains("private base policy"));
        assert!(!encoded.contains("private durable memory"));
        assert!(encoded.contains("withheldReason"));
        assert!(encoded.contains("channel="));
        assert!(encoded.contains("turn=turn-7"));
        assert!(encoded.contains("session=session-9"));
        for source in manifest["context"].as_array().unwrap() {
            assert_eq!(source["hash"].as_str().unwrap().len(), 12);
            assert!(source["size"].as_str().is_some());
        }
    }
}
