# Fleet Control Tower port

Fleet is the owner-only observation surface for managed agents. The Agents
screen remains the configuration surface.

This implementation directly ports and adapts Buzz Control Tower v0.8.2 from
`endcorp-hq/buzz-control-tower` at commit
`8f65a14c5b049b03e8382fd4baba68fa914b1ab0`.

The port keeps Control Tower's channel → workstream → agent-turn navigation,
dense two-pane layout, live reply and reasoning streams, tool/lifecycle
timeline, context manifest and inspector, delivery evidence, and artifacts.
Only the application boundary changes: Buzz Desktop supplies identity, managed
agents, channels, projects, repositories, observer frames, and local archive.
No Control Tower onboarding, updater, identity store, relay client, or
configuration system is copied.

Unlike the standalone source, a visible turn is keyed by all four attribution
fields: agent public key, channel ID, turn ID, and session ID. The observer and
archive projections must preserve that key before data reaches presentation.

Visual acceptance references from the pinned source:

- `docs/screenshots/hero-live-turn.png`
- `docs/screenshots/reasoning-stream.png`
- `docs/screenshots/context-manifest.png`
- `docs/screenshots/evidence-delivery-chain.png`
- `docs/screenshots/channel-picker.png`

