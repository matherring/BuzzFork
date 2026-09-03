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

## Source map

| Control Tower v0.8.2 source | BuzzFork adaptation |
| --- | --- |
| `src/domain.ts` | `desktop/src/features/fleet/controlTowerDomain.ts` |
| `src/selectors.ts` and `src/selectors.test.ts` | `controlTowerSelectors.ts` and `controlTowerSelectors.test.mjs` |
| `src/dataSource.ts`, `src-tauri/src/observer_stream.rs` | `controlTowerProjection.ts` and `controlTowerProjection.test.mjs` |
| `src/App.tsx` | `ui/FleetScreen.tsx` and `ui/ControlTowerDetails.tsx` |
| `src/styles.css` | `ui/FleetScreen.css` (scoped under `.fleet-tower`) |
| `src/fixtures.ts`, `src/App.test.tsx`, repository screenshots | `desktop/tests/e2e/fleet-dashboard.spec.ts` |
| `src-tauri/src/local_workstream.rs` | `crates/buzz-acp/src/turn_manifest.rs` |

The standalone `ChannelPicker`, onboarding, updater, device identity, relay
configuration, exporter processes, and Tauri shell are deliberately not copied.
Buzz already owns those application boundaries.

## Attribution and privacy boundary

Every turn is keyed with a length-prefixed composite of agent public key,
channel ID, turn ID, and session ID. Frames that do not have enough identity to
join exactly one session stay unresolved instead of being attached to another
turn. Live and archived copies deduplicate by frame identity before reduction.

The harness emits a source-redacted `turn_manifest` only after the ACP session
has resolved. It exposes safe trigger text and runtime/project fields, while raw
base, system, team, memory, conversation, and canvas bodies remain at source.
Each supplied context source still carries a SHA-256 prefix, byte size,
visibility boundary, and explicit withheld reason. Delivery begins with one
exact local-observation fact; commit, push, PR, merge, and deploy remain
incomplete until a semantic evidence event supplies supporting facts.
