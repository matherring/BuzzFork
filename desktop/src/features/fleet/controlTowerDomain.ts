/**
 * Directly ported and adapted from Buzz Control Tower v0.8.2
 * (`src/domain.ts`, commit 8f65a14c5b049b03e8382fd4baba68fa914b1ab0).
 *
 * The standalone app keyed a visible row by one runtime page. Buzz Desktop can
 * observe concurrent turns for the same managed agent, so the adapted identity
 * is deliberately the full agent + channel + turn + session tuple.
 */

export type FleetAgentStatus =
  | "working"
  | "blocked"
  | "idle"
  | "complete"
  | "active"
  | "offline"
  | "stale"
  | "unavailable"
  | "archived";

export type FleetConnectionState =
  | "connected"
  | "reconnecting"
  | "stale"
  | "unavailable";

export type DeliveryStage =
  | "local"
  | "committed"
  | "pushed"
  | "pr-open"
  | "merged"
  | "deployed";

export type ActivityEvent = {
  id: string;
  at: string;
  kind: "lifecycle" | "tool" | "message" | "evidence";
  title: string;
  detail: string;
  status?: "running" | "complete" | "failed";
  parameters?: Array<{ label: string; value: string }>;
  result?: string;
};

export type ContextSource = {
  id: string;
  kind:
    | "base"
    | "team"
    | "memory"
    | "thread"
    | "canvas"
    | "repository"
    | "project";
  label: string;
  detail: string;
  hash: string;
  size: string;
  visibility: "summary" | "provenance" | "full";
  content?: string;
  fields?: Array<{ label: string; value: string }>;
  withheldReason?: string;
};

export type Evidence = {
  stage: DeliveryStage;
  label: string;
  detail: string;
  complete: boolean;
  facts?: Array<{ label: string; value: string }>;
  href?: string;
};

export type Artifact = {
  id: string;
  kind: "code" | "document" | "image" | "link";
  name: string;
  detail: string;
  changedAt: string;
  href?: string;
};

export type TurnIdentity = {
  agentPubkey: string;
  channelId: string;
  turnId: string;
  sessionId: string;
};

export type AgentTurn = TurnIdentity & {
  /** Stable serialization of the complete turn identity. */
  id: string;
  agentName: string;
  avatarUrl: string | null;
  role: string;
  status: FleetAgentStatus;
  statusLabel: string;
  operation: string;
  startedAt: string | null;
  completedAt: string | null;
  lastActivityAt: string | null;
  model: string;
  branch: string;
  head: string;
  helperCount: number;
  archived: boolean;
  activity: ActivityEvent[];
  liveText?: string;
  liveThought?: string;
  context: ContextSource[];
  evidence: Evidence[];
  artifacts: Artifact[];
};

export type Workstream = {
  id: string;
  title: string;
  phase: string;
  turns: AgentTurn[];
};

export type FleetChannel = {
  id: string;
  name: string;
  description: string;
  workstreams: Workstream[];
};

export type TowerSnapshot = {
  generatedAt: string;
  source: "observer" | "archive" | "unavailable";
  connection: FleetConnectionState;
  channels: FleetChannel[];
};

