# Interactive agent prompts in Buzz messages

Status: prototype contract for `feat/hermes-approval-actions`

## Goal

Render a signed, expiring agent prompt as buttons in Buzz Desktop and return a
signed semantic response to the originating agent. The first consumer is a
Hermes execution approval with **Allow once** and **Deny**. Plain text remains
the fallback.

## Event contract (v1)

Both request and response remain kind `9` channel messages so they use the
existing relay authorization, timeline, threading, signing, and subscription
paths.

### Request

The agent signs an ordinary channel message with:

```text
["prompt", "v1", <prompt-id>, "exec-approval", <expires-at-unix>]
["prompt-option", <prompt-id>, "once", "Allow once", "primary"]
["prompt-option", <prompt-id>, "deny", "Deny", "danger"]
["p", <authorized-responder-pubkey>]
```

Requirements:

- `prompt-id` is opaque and unpredictable; it contains no command text.
- `expires-at-unix` is enforced by Hermes, not only by the Desktop UI.
- The request content contains the existing readable command/reason and typed
  `/approve` / `/deny` fallback.
- The first slice rejects any request with duplicate IDs, malformed tags,
  unknown prompt kind, no authorized responder, more than one authorized
  responder, more than four options, duplicate option IDs, unknown option IDs,
  overlong labels, or an invalid expiry.
- The button payload is only `(request event id, prompt id, option id)`.

### Response

Buzz Desktop signs a kind `9` reply to the request with:

```text
["prompt-response", "v1", <prompt-id>, <option-id>]
["e", <request-event-id>, "", "root"]
["e", <request-event-id>, "", "reply"]
["p", <agent-pubkey>]
```

The visible content is descriptive only (for example, `Responded: Allow once`).
It is not executable command text.

## Hermes validation

Hermes keeps a bounded in-memory pending registry keyed by `prompt-id` with:

- session key;
- channel ID;
- request event ID;
- exact authorized responder pubkey;
- allowed option IDs;
- expiry.

Before resolving, Hermes verifies all of the following from the signed inbound
event:

1. response author equals the exact authorized responder;
2. channel equals the pending request channel;
3. version, prompt ID, and option ID are valid;
4. root/reply event reference equals the recorded request event ID;
5. request has not expired;
6. pending state is removed atomically before resolution.

Malformed, unauthorized, expired, duplicate, replayed, or unknown tagged
responses are consumed and never dispatched to the model. They cannot resolve a
command. Resolution maps only known semantic IDs: `once` to Hermes `once`, and
`deny` to Hermes `deny`.

If there is not exactly one configured authorized Buzz pubkey, if the custom
Buzz CLI does not support prompt sending, or if prompt publication fails,
`send_exec_approval` returns `success=False`; the existing Hermes gateway then
sends the unchanged plain-text fallback.

## Desktop behavior

- Render buttons only for valid `exec-approval` request tags.
- Enable them only when the current identity is the sole `p`-tagged responder
  and the expiry is still in the future.
- Disable the whole card after one local click while the signed response is
  submitted.
- Show pending, responded, expired, and error states without treating UI state
  as authorization.
- Keep accessibility labels and keyboard activation.

## CLI and SDK surface

Do not expose arbitrary extra tags. Add a narrow prompt-send surface that
validates the v1 schema and uses a dedicated SDK builder. Desktop response
submission likewise uses a dedicated Tauri command/builder rather than allowing
arbitrary renderer-supplied tags.

## Tests

Buzz:

- SDK/CLI request builder emits exact bounded tags and rejects malformed input.
- Desktop parser rejects malformed, duplicate, unknown, expired, and
  multi-responder requests.
- Buttons are visible only to the authorized identity.
- Response builder emits exact thread, recipient, and prompt-response tags.
- Double click submits once; expired cards submit nothing.
- Existing ordinary messages are unchanged.

Hermes:

- request sends through the narrow Buzz CLI command and registers only after a
  successful publication with a returned event ID;
- authorized `once` and `deny` resolve exactly once;
- wrong author, wrong channel, wrong request event, malformed option, expired
  request, duplicate response, and replay all fail closed and never reach the
  model;
- CLI failure and unsupported versions trigger the existing text fallback.

## Canary and rollback

Build and run an isolated BuzzFork Desktop and point only Woz at the matching
BuzzFork CLI. Do not replace the Block-signed app or change another profile.
Rollback is to stop the canary and restore Woz's prior `cli_path`; the relay data
remains ordinary signed kind `9` messages that older clients render as text.
