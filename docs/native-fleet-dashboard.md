# Native Fleet Dashboard

Status: V1 design and compatibility record
Owner: Buzz Desktop
Last reviewed: 2026-09-01

## Decision

Fleet is a read-only, owner-only Desktop view over state Buzz already owns. It
does not introduce a fleet service, protocol, database, identity, relay
connection, or control plane.

The sidebar entry is available only when both conditions are true:

1. the build reports owner-only agent access through the existing Rust-backed
   `agent_access_owner_only` capability; and
2. the active community has at least one existing managed agent.

The sidebar entry is hidden otherwise. Direct navigation returns to the existing
Agents surface when the build is not owner-only. An owner-only build with no
managed agents receives a safe empty state rather than an invented fleet.

## Native data flow

Fleet projects these existing sources:

- managed-agent records for identity, configured runtime id, model id,
  lifecycle bookkeeping, and concise classified errors;
- the Rust ACP runtime catalog for canonical harness labels and model metadata;
- the existing presence query for online, away, and offline state;
- the existing channel query for names and access-safe navigation;
- the app-global owner-scoped, encrypted kind-24200 observer store for the last
  admitted observer time and sanitized transcript items; and
- the active-turn store derived from those admitted observer frames.

A pure aggregation function receives snapshots from those stores and returns
render rows. The function owns no cache and performs no I/O. The React adapter
subscribes to existing stores only; it does not create another observer or
presence connection. Fleet state therefore disappears on ordinary React
remount and cannot leak across community switches.

The dashboard never reads raw relay event JSON. Its activity summary is a
strict allowlist over the existing transcript projection:

- assistant message text already admitted by that pipeline, bounded again for
  the compact row;
- lifecycle titles that the transcript already classified; and
- tool action labels only, never arguments, results, command output, or raw
  payload previews.

Thought, plan, metadata/raw-rail, user-prompt, permission-detail, environment,
credential, and unclassified error content are excluded from row summaries.
Existing transcript redaction and truncation remain upstream and authoritative.

## Status model and clocks

Lifecycle and observation status are separate fields. A stopped process is a
lifecycle fact; online presence is a liveness fact. Silence never becomes
“healthy.”

Observation states are ordered for display as `active`, `failed`, `stale`,
`online`, `idle`, `unknown`, then `offline`:

- **Active**: the existing active-turn store contains a turn and its latest
  valid observer frame is no more than 30 seconds old. This allows two missed
  10-second turn-liveness frames before the row stops claiming active work.
- **Stale**: an active turn remains tracked but its most recent valid observer
  frame is older than 30 seconds. The active-turn store may deliberately retain
  a turn during a bounded disconnect pause; Fleet makes that uncertainty
  visible instead of reporting active or healthy.
- **Failed**: the canonical pair runtime reports `failed` or the managed-agent
  record carries an error. Error copy is classified or generic; raw payload text
  is not surfaced.
- **Online**: authoritative presence says online and there is no active turn.
- **Idle**: authoritative presence says away and there is no active turn.
- **Offline**: a successfully loaded presence result says offline or omits the
  agent, and there is no active turn.
- **Unknown**: presence has not resolved, failed, or an active turn has no valid
  observer timestamp. Missing data stays missing.

The 30-second active-frame threshold is exported beside the selector and is
tested at both sides of its boundary. Observer timestamps are parsed strictly;
malformed or future-dated values cannot claim Active. Sorting is stable by state
priority, then case-insensitive display name, then normalized pubkey. Filters
do not change that ordering.

Duplicate and out-of-order observer frames are rejected by the existing
observer and active-turn store watermarks before projection. The selector still
treats malformed and missing values defensively. On disconnect, an existing
turn moves to Stale after the threshold; after reconnect, only a newer admitted
frame can restore Active.

## Navigation and controls

Agent identity and activity actions enter the existing Agents/profile and
agent-session surfaces. Channel actions use the existing access-checked channel
navigation. Fleet does not render transcripts itself and has no start, stop,
restart, send, approve, configure, edit, or other mutation action.

## Control Tower provenance and compatibility boundary

Behavior reference repository:
`https://github.com/endcorp-hq/buzz-control-tower`

Recorded review baseline:

- release tag: `v0.8.1`
- exact commit: `bcd86813f735c833cb1cf44795904c8c0afe860e`
- license status observed on 2026-09-01: no software license file or declared
  software license
- local review source: the read-only specimen named in the security review
- security review:
  `/Users/adminmat/.buzz/RESEARCH/BUZZ_CONTROL_TOWER_SECURITY_REVIEW_2026_09_01.md`

No Control Tower source, assets, text, package, dependency, commit, or git
history is incorporated. Its absence of a software license is treated as a
hard boundary, not an ambiguity to resolve in favor of reuse.

| Observed concept | BuzzFork-native equivalent | Compatibility decision |
| --- | --- | --- |
| Fleet overview | Pure projection over managed agents, presence, active turns, channels, and kind-24200 observer state | Independently implement the useful overview behavior |
| Per-agent state and recent activity | Existing lifecycle/presence facts plus allowlisted sanitized transcript summary | Independently implement with explicit Unknown/Stale |
| Status/channel filtering and attention-first order | Local selector inputs and stable sort | Independently implement |
| Drill-in to activity | Existing agent session/profile and channel routes | Reuse native Buzz surfaces |
| Device identity and key storage | Existing Buzz Desktop identity only | Excluded |
| Separate relay/session connection | Existing shared relay client and app-global observer bridge only | Excluded |
| Owner import or channel-membership changes | Existing owner context and memberships only | Excluded |
| SSH polling and local rollout-file scanning | No collector | Excluded |
| Kind 24201 command channel | No producer or consumer | Excluded |
| Start/stop/restart/send/approve/configure | No mutation controls in V1 | Excluded |
| Independent transcript/raw event rendering | Existing sanitized transcript and session UI only | Excluded |
| Updater or second app | Existing Buzz Desktop app and updater remain unchanged | Excluded |

## On-demand upstream review

`scripts/review-control-tower-upstream.sh --ref <ref>` performs an explicit,
read-only review in a temporary directory. It fetches the requested ref and the
recorded baseline, prints the exact requested commit, lists commits and changed
paths relative to the baseline, and reports license-file status at the
requested commit. Tests use local fixture remotes; CI does not need GitHub.

The script never checks out into BuzzFork, applies patches, copies files,
vendors dependencies, merges histories, cherry-picks, changes the recorded
baseline, or writes production state. Its output is a review report only.
Future changes are assessed concept by concept and independently reimplemented.
If the upstream repository later publishes an explicit compatible license,
that legal boundary must be reassessed deliberately; the script does not relax
it automatically.

## V1 validation

Focused tests cover aggregation, ordering, clock boundaries, duplicates,
out-of-order and malformed frames, missing channel/turn data,
disconnect/reconnect, owner-only route visibility, canonical runtime labels,
safe empty/error states, navigation, and absence of mutation or secret/tool
payload content. A mocked Desktop E2E proves the UI against the same Tauri
managed-agent commands and kind-24200 injection seam used by the existing
observer-store tests. A real owner canary remains required to validate relay
timing and archived/live handoff outside mocks.
