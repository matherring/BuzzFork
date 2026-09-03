/**
 * Observer/archive projection for the embedded Control Tower.
 *
 * The turn reducer is adapted from Control Tower v0.8.2's
 * `src-tauri/src/observer_stream.rs` and `src/dataSource.ts`. Buzz Desktop
 * already decrypts, orders, deduplicates, and archives kind-24200 frames, so
 * this port starts at that trusted boundary and preserves every turn identity.
 */

import { buildTranscriptState } from "@/features/agents/ui/agentSessionTranscript";
import type {
  ObserverEvent,
  TranscriptItem,
} from "@/features/agents/ui/agentSessionTypes";
import type { Channel, ManagedAgent, PresenceLookup } from "@/shared/api/types";
import type {
  ActivityEvent,
  AgentTurn,
  Artifact,
  ContextSource,
  Evidence,
  FleetAgentStatus,
  FleetChannel,
  FleetConnectionState,
  TowerSnapshot,
} from "./controlTowerDomain";
import { turnIdentityKey } from "./controlTowerSelectors";

export const CONTROL_TOWER_STALE_MS = 30_000;
const MAX_VISIBLE_CHARS = 4_000;

export type FleetObserverConnection =
  | "idle"
  | "connecting"
  | "open"
  | "closed"
  | "error";

export type FleetProject = {
  id: string;
  name: string;
  description: string;
  projectChannelId: string | null;
  relatedChannelIds: string[];
  repositories: Array<{ name: string; webUrl: string | null }>;
};

export type FleetProjectionSource = {
  agent: ManagedAgent;
  liveEvents: readonly ObserverEvent[];
  archivedEventsByChannel?: ReadonlyMap<string, readonly ObserverEvent[]>;
};

type SourcedObserverEvent = {
  event: ObserverEvent;
  archived: boolean;
};

type TurnBucket = {
  agent: ManagedAgent;
  channelId: string;
  turnId: string;
  sessionId: string;
  events: SourcedObserverEvent[];
};

type TurnManifest = {
  operation?: string;
  role?: string;
  model?: string;
  branch?: string;
  head?: string;
  helperCount?: number;
  workstreamId?: string;
  workstreamTitle?: string;
  phase?: string;
  context: ContextSource[];
  evidence: Evidence[];
  artifacts: Artifact[];
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function bounded(value: string | undefined): string {
  if (!value) return "";
  return value.length > MAX_VISIBLE_CHARS
    ? `${value.slice(0, MAX_VISIBLE_CHARS - 1)}…`
    : value;
}

// Directly adapted from Control Tower's source-side presentation redactor. A
// Fleet inspector must never become a second raw tool-output surface.
function redacted(value: string | undefined): string {
  return bounded(value)
    .replace(
      /\b(api[_-]?key|secret|token|password|private[_-]?key)\s*[:=]\s*["']?[^\s"'`]+/gi,
      "$1=[redacted]",
    )
    .replace(
      /\b(?:nsec1|sk-|gh[pousr]_|tskey-)[A-Za-z0-9_-]{8,}\b/g,
      "[redacted-credential]",
    )
    .replace(/\b[0-9a-fA-F]{64}\b/g, "[redacted-64]");
}

function eventOrder(left: ObserverEvent, right: ObserverEvent): number {
  const leftAt = Date.parse(left.timestamp);
  const rightAt = Date.parse(right.timestamp);
  if (
    Number.isFinite(leftAt) &&
    Number.isFinite(rightAt) &&
    leftAt !== rightAt
  ) {
    return leftAt - rightAt;
  }
  return left.seq - right.seq;
}

function eventDedupKey(event: ObserverEvent): string {
  return [
    event.timestamp,
    String(event.seq),
    event.channelId ?? "",
    event.turnId ?? "",
    event.sessionId ?? "",
    event.kind,
  ]
    .map((part) => `${part.length}:${part}`)
    .join("|");
}

function uniqueEvents(
  events: readonly SourcedObserverEvent[],
): SourcedObserverEvent[] {
  const byKey = new Map<string, SourcedObserverEvent>();
  for (const candidate of events) {
    const key = eventDedupKey(candidate.event);
    const current = byKey.get(key);
    if (!current || (current.archived && !candidate.archived)) {
      byKey.set(key, candidate);
    }
  }
  return [...byKey.values()].sort((left, right) =>
    eventOrder(left.event, right.event),
  );
}

function baseTurnKey(channelId: string, turnId: string): string {
  return `${channelId.length}:${channelId}|${turnId.length}:${turnId}`;
}

/**
 * Bucket frames without ever using an agent-only or channel-only fallback.
 * Early `turn_started` frames legitimately lack a session ID; they can join a
 * later session only when that `(channel, turnId)` has exactly one known
 * session. Ambiguity stays in an explicit unknown-session bucket.
 */
function bucketTurns(source: FleetProjectionSource): TurnBucket[] {
  const sourced: SourcedObserverEvent[] = source.liveEvents.map((event) => ({
    event,
    archived: false,
  }));
  for (const events of source.archivedEventsByChannel?.values() ?? []) {
    sourced.push(...events.map((event) => ({ event, archived: true })));
  }

  const unique = uniqueEvents(sourced).filter(({ event }) =>
    Boolean(event.channelId && event.turnId),
  );
  const sessionsByBase = new Map<string, Set<string>>();
  for (const { event } of unique) {
    if (!event.channelId || !event.turnId || !event.sessionId) continue;
    const key = baseTurnKey(event.channelId, event.turnId);
    const sessions = sessionsByBase.get(key) ?? new Set<string>();
    sessions.add(event.sessionId);
    sessionsByBase.set(key, sessions);
  }

  const buckets = new Map<string, TurnBucket>();
  for (const sourcedEvent of unique) {
    const { event } = sourcedEvent;
    if (!event.channelId || !event.turnId) continue;
    const candidates = sessionsByBase.get(
      baseTurnKey(event.channelId, event.turnId),
    );
    const inferredSession =
      !event.sessionId && candidates?.size === 1
        ? candidates.values().next().value
        : undefined;
    const sessionId = event.sessionId ?? inferredSession ?? "unknown-session";
    const identity = {
      agentPubkey: source.agent.pubkey,
      channelId: event.channelId,
      turnId: event.turnId,
      sessionId,
    };
    const key = turnIdentityKey(identity);
    const bucket = buckets.get(key) ?? {
      agent: source.agent,
      channelId: event.channelId,
      turnId: event.turnId,
      sessionId,
      events: [],
    };
    bucket.events.push(sourcedEvent);
    buckets.set(key, bucket);
  }
  return [...buckets.values()];
}

function parseContext(value: unknown): ContextSource[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate, index) => {
    const item = asRecord(candidate);
    const kind = asString(item.kind);
    const label = asString(item.label);
    const hash = asString(item.hash);
    const size = asString(item.size);
    if (
      !kind ||
      !label ||
      !hash ||
      !size ||
      ![
        "base",
        "team",
        "memory",
        "thread",
        "canvas",
        "repository",
        "project",
      ].includes(kind)
    ) {
      return [];
    }
    const visibility = asString(item.visibility);
    const fields = Array.isArray(item.fields)
      ? item.fields.flatMap((field) => {
          const record = asRecord(field);
          const fieldLabel = asString(record.label);
          const fieldValue = asString(record.value);
          return fieldLabel && fieldValue
            ? [{ label: fieldLabel, value: fieldValue }]
            : [];
        })
      : undefined;
    return [
      {
        id: asString(item.id) ?? `context-${index}`,
        kind: kind as ContextSource["kind"],
        label,
        detail: bounded(asString(item.detail)),
        hash,
        size,
        visibility: (["summary", "provenance", "full"].includes(
          visibility ?? "",
        )
          ? visibility
          : "provenance") as ContextSource["visibility"],
        content: bounded(asString(item.content)) || undefined,
        fields,
        withheldReason: bounded(asString(item.withheldReason)) || undefined,
      },
    ];
  });
}

const DELIVERY_STAGES = [
  "local",
  "committed",
  "pushed",
  "pr-open",
  "merged",
  "deployed",
] as const;

function parseEvidence(value: unknown): Evidence[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const item = asRecord(candidate);
    const stage = asString(item.stage);
    const label = asString(item.label);
    if (!stage || !label || !DELIVERY_STAGES.includes(stage as never))
      return [];
    const facts = Array.isArray(item.facts)
      ? item.facts.flatMap((fact) => {
          const record = asRecord(fact);
          const factLabel = asString(record.label);
          const factValue = asString(record.value);
          return factLabel && factValue
            ? [{ label: factLabel, value: factValue }]
            : [];
        })
      : undefined;
    return [
      {
        stage: stage as Evidence["stage"],
        label,
        detail: bounded(asString(item.detail)),
        complete: item.complete === true,
        facts,
        href: asString(item.href),
      },
    ];
  });
}

function artifactKind(value: string | undefined): Artifact["kind"] {
  return ["code", "document", "image", "link"].includes(value ?? "")
    ? (value as Artifact["kind"])
    : "code";
}

function parseArtifacts(value: unknown): Artifact[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate, index) => {
    const item = asRecord(candidate);
    const name = asString(item.name);
    if (!name) return [];
    return [
      {
        id: asString(item.id) ?? `artifact-${index}`,
        kind: artifactKind(asString(item.kind)),
        name,
        detail: bounded(asString(item.detail)),
        changedAt: asString(item.changedAt) ?? "",
        href: asString(item.href),
      },
    ];
  });
}

function readManifest(events: readonly ObserverEvent[]): TurnManifest {
  const manifest: TurnManifest = { context: [], evidence: [], artifacts: [] };
  for (const event of events) {
    if (
      ![
        "turn_context",
        "turn_manifest",
        "turn_evidence",
        "turn_artifact",
      ].includes(event.kind)
    ) {
      continue;
    }
    const payload = asRecord(event.payload);
    manifest.operation = asString(payload.operation) ?? manifest.operation;
    manifest.role = asString(payload.role) ?? manifest.role;
    manifest.model = asString(payload.model) ?? manifest.model;
    manifest.branch = asString(payload.branch) ?? manifest.branch;
    manifest.head = asString(payload.head) ?? manifest.head;
    manifest.helperCount =
      asNumber(payload.helperCount) ?? manifest.helperCount;
    manifest.workstreamId =
      asString(payload.workstreamId) ?? manifest.workstreamId;
    manifest.workstreamTitle =
      asString(payload.workstreamTitle) ?? manifest.workstreamTitle;
    manifest.phase = asString(payload.phase) ?? manifest.phase;
    const context = parseContext(payload.context);
    const evidence = parseEvidence(payload.evidence);
    const artifacts = parseArtifacts(payload.artifacts);
    if (context.length > 0) manifest.context = context;
    if (evidence.length > 0) manifest.evidence = evidence;
    if (artifacts.length > 0) manifest.artifacts = artifacts;
    if (event.kind === "turn_artifact") {
      manifest.artifacts.push(...parseArtifacts([payload]));
    }
    if (event.kind === "turn_evidence") {
      manifest.evidence = parseEvidence([payload]);
    }
  }
  return manifest;
}

function scalarParameters(value: Record<string, unknown>) {
  return Object.entries(value)
    .filter(([, item]) => ["string", "number", "boolean"].includes(typeof item))
    .slice(0, 8)
    .map(([label, item]) => ({ label, value: redacted(String(item)) }));
}

function artifactPath(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/");
  if (!normalized.startsWith("/")) return normalized;
  return normalized.split("/").filter(Boolean).at(-1) ?? "workspace artifact";
}

function artifactType(path: string): Artifact["kind"] {
  const extension = path.split(".").at(-1)?.toLowerCase();
  if (["md", "txt", "pdf", "doc", "docx"].includes(extension ?? ""))
    return "document";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(extension ?? ""))
    return "image";
  return "code";
}

function toolArtifactPaths(item: Extract<TranscriptItem, { type: "tool" }>) {
  if (item.renderClass !== "file-edit") return [];
  const paths = new Set<string>();
  for (const key of ["path", "filePath", "file_path", "target"]) {
    const value = item.args[key];
    if (typeof value === "string" && value.trim())
      paths.add(artifactPath(value));
  }
  const patch = [item.args.input, item.args.patch]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  for (const match of patch.matchAll(
    /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm,
  )) {
    if (match[1]) paths.add(artifactPath(match[1]));
  }
  const object = item.descriptor.action?.object ?? item.descriptor.object;
  if (object?.trim() && /[/\\]|\.[A-Za-z0-9]{1,8}$/.test(object)) {
    paths.add(artifactPath(object));
  }
  return [...paths].filter(Boolean);
}

function artifactsFromTranscript(items: readonly TranscriptItem[]): Artifact[] {
  const artifacts = new Map<string, Artifact>();
  for (const item of items) {
    if (item.type !== "tool") continue;
    for (const path of toolArtifactPaths(item)) {
      artifacts.set(path, {
        id: `${item.id}:${path}`,
        kind: artifactType(path),
        name: path.split("/").at(-1) ?? path,
        detail: redacted(path),
        changedAt: item.completedAt ?? item.timestamp,
      });
    }
  }
  return [...artifacts.values()].sort((left, right) =>
    right.changedAt.localeCompare(left.changedAt),
  );
}

function transcriptActivity(item: TranscriptItem): ActivityEvent | null {
  if (item.type === "metadata") return null;
  if (item.type === "tool") {
    return {
      id: item.id,
      at: item.timestamp,
      kind: "tool",
      title: item.descriptor.label || item.title || "Tool call",
      detail: redacted(
        item.descriptor.preview ??
          item.descriptor.action?.object ??
          item.descriptor.operation ??
          "Agent tool activity.",
      ),
      status:
        item.status === "failed"
          ? "failed"
          : item.status === "completed"
            ? "complete"
            : "running",
      parameters: scalarParameters(item.args),
      result: redacted(item.result) || undefined,
    };
  }
  if (item.type === "message") {
    if (item.role !== "assistant") return null;
    return {
      id: item.id,
      at: item.timestamp,
      kind: "message",
      title: "Reply update",
      detail: bounded(item.text),
      status: "complete",
    };
  }
  if (item.type === "thought") {
    return {
      id: item.id,
      at: item.timestamp,
      kind: "lifecycle",
      title: "Reasoning summary",
      detail: bounded(item.text),
      status: "complete",
    };
  }
  if (item.type === "plan") {
    return {
      id: item.id,
      at: item.timestamp,
      kind: "lifecycle",
      title: item.title || "Plan updated",
      detail: bounded(item.text),
      status: "complete",
    };
  }
  return {
    id: item.id,
    at: item.timestamp,
    kind: "lifecycle",
    title: item.title,
    detail: bounded(item.text),
    status:
      item.renderClass === "error"
        ? "failed"
        : item.renderClass === "permission" && !item.outcome
          ? "running"
          : "complete",
  };
}

function lastTimestamp(events: readonly ObserverEvent[]): string | null {
  return events.at(-1)?.timestamp ?? null;
}

function resolveStatus(input: {
  events: readonly ObserverEvent[];
  onlyArchived: boolean;
  connection: FleetConnectionState;
  now: number;
}): FleetAgentStatus {
  const terminal = [...input.events]
    .reverse()
    .find((event) =>
      ["turn_completed", "turn_error", "agent_panic"].includes(event.kind),
    );
  if (terminal?.kind === "turn_error" || terminal?.kind === "agent_panic") {
    return "blocked";
  }
  if (terminal?.kind === "turn_completed") {
    return input.onlyArchived ? "archived" : "complete";
  }
  if (input.connection === "unavailable") return "unavailable";
  const lastAt = Date.parse(lastTimestamp(input.events) ?? "");
  if (
    input.connection !== "connected" ||
    !Number.isFinite(lastAt) ||
    input.now - lastAt > CONTROL_TOWER_STALE_MS
  ) {
    return "stale";
  }
  return "working";
}

const STATUS_LABELS: Record<FleetAgentStatus, string> = {
  working: "Working",
  blocked: "Blocked",
  idle: "Idle",
  complete: "Complete",
  active: "Active",
  offline: "Offline",
  stale: "Stale",
  unavailable: "Unavailable",
  archived: "Archived",
};

function fallbackEvidence(hasEvents: boolean): Evidence[] {
  if (!hasEvents) return [];
  return [
    {
      stage: "local",
      label: "Runtime observed",
      detail:
        "Lifecycle and tool events were received on the encrypted observer stream.",
      complete: true,
    },
    ...DELIVERY_STAGES.slice(1).map((stage) => ({
      stage,
      label:
        stage === "pr-open"
          ? "No pull request evidence"
          : `No ${stage} evidence`,
      detail: "Fleet does not infer delivery from agent activity.",
      complete: false,
    })),
  ];
}

function projectForChannel(
  projects: readonly FleetProject[],
  channelId: string,
): FleetProject | undefined {
  return projects.find(
    (project) =>
      project.projectChannelId === channelId ||
      project.relatedChannelIds.includes(channelId),
  );
}

function turnFromBucket(
  bucket: TurnBucket,
  connection: FleetConnectionState,
  now: number,
): AgentTurn & {
  workstreamId: string;
  workstreamTitle: string;
  phase: string;
} {
  const sourced = uniqueEvents(bucket.events);
  const events = sourced.map(({ event }) => event);
  const transcript = buildTranscriptState(events).items;
  const manifest = readManifest(events);
  const projectedArtifacts = artifactsFromTranscript(transcript);
  const messages = transcript.filter(
    (item): item is Extract<TranscriptItem, { type: "message" }> =>
      item.type === "message" && item.role === "assistant",
  );
  const thoughts = transcript.filter(
    (item): item is Extract<TranscriptItem, { type: "thought" }> =>
      item.type === "thought",
  );
  const onlyArchived = sourced.every(({ archived }) => archived);
  const status = resolveStatus({ events, onlyArchived, connection, now });
  const started = events.find((event) => event.kind === "turn_started");
  const completed = [...events]
    .reverse()
    .find((event) =>
      ["turn_completed", "turn_error", "agent_panic"].includes(event.kind),
    );
  const latestReply = messages.at(-1)?.text;
  const latestThought = thoughts.at(-1)?.text;
  const identity = {
    agentPubkey: bucket.agent.pubkey,
    channelId: bucket.channelId,
    turnId: bucket.turnId,
    sessionId: bucket.sessionId,
  };
  return {
    ...identity,
    id: turnIdentityKey(identity),
    agentName: bucket.agent.name,
    avatarUrl: bucket.agent.avatarUrl,
    role: manifest.role ?? "Managed agent",
    status,
    statusLabel: STATUS_LABELS[status],
    operation:
      manifest.operation ??
      latestReply?.replace(/\s+/g, " ").trim().slice(0, 120) ??
      "Observed agent turn",
    startedAt: started?.startedAt ?? started?.timestamp ?? null,
    completedAt: completed?.timestamp ?? null,
    lastActivityAt: lastTimestamp(events),
    model: manifest.model ?? bucket.agent.model ?? "Model unavailable",
    branch: manifest.branch ?? "Not reported",
    head: manifest.head ?? "Not reported",
    helperCount: manifest.helperCount ?? 0,
    archived: onlyArchived,
    activity: transcript
      .map(transcriptActivity)
      .filter((item): item is ActivityEvent => item !== null)
      .reverse(),
    liveText: bounded(latestReply) || undefined,
    liveThought: bounded(latestThought) || undefined,
    context: manifest.context,
    evidence:
      manifest.evidence.length > 0
        ? manifest.evidence
        : fallbackEvidence(events.length > 0),
    artifacts: [
      ...new Map(
        [...manifest.artifacts, ...projectedArtifacts].map((artifact) => [
          artifact.detail,
          artifact,
        ]),
      ).values(),
    ],
    workstreamId: manifest.workstreamId ?? bucket.sessionId,
    workstreamTitle:
      manifest.workstreamTitle ??
      (bucket.sessionId === "unknown-session"
        ? `Turn ${bucket.turnId.slice(0, 8)}`
        : `Session ${bucket.sessionId.slice(0, 8)}`),
    phase: manifest.phase ?? (status === "archived" ? "Archive" : "Observed"),
  };
}

function resolveConnection(
  state: FleetObserverConnection,
  hasEvents: boolean,
): FleetConnectionState {
  if (state === "open") return "connected";
  if (state === "connecting" || state === "idle") return "reconnecting";
  return hasEvents ? "stale" : "unavailable";
}

/** Build the Control Tower work graph from Buzz's existing observer boundary. */
export function projectControlTowerSnapshot(input: {
  sources: readonly FleetProjectionSource[];
  channels: readonly Pick<Channel, "id" | "name" | "description">[];
  projects?: readonly FleetProject[];
  presence?: PresenceLookup;
  observerConnectionState: FleetObserverConnection;
  now: number;
}): TowerSnapshot {
  const hasLiveEvents = input.sources.some(
    (source) => source.liveEvents.length > 0,
  );
  const hasEvents = input.sources.some(
    (source) =>
      source.liveEvents.length > 0 ||
      [...(source.archivedEventsByChannel?.values() ?? [])].some(
        (events) => events.length > 0,
      ),
  );
  const connection = resolveConnection(
    input.observerConnectionState,
    hasEvents,
  );
  const turns = input.sources
    .flatMap(bucketTurns)
    .map((bucket) => turnFromBucket(bucket, connection, input.now));
  const projects = input.projects ?? [];

  const channels: FleetChannel[] = input.channels.map((channel) => {
    const channelTurns = turns.filter((turn) => turn.channelId === channel.id);
    const workstreamMap = new Map<
      string,
      { id: string; title: string; phase: string; turns: AgentTurn[] }
    >();
    for (const turn of channelTurns) {
      const current = workstreamMap.get(turn.workstreamId) ?? {
        id: turn.workstreamId,
        title: turn.workstreamTitle,
        phase: turn.phase,
        turns: [],
      };
      current.turns.push(turn);
      workstreamMap.set(turn.workstreamId, current);
    }
    const project = projectForChannel(projects, channel.id);
    return {
      id: channel.id,
      name: channel.name,
      description: channel.description || project?.description || "",
      workstreams: [...workstreamMap.values()].sort((left, right) =>
        left.title.localeCompare(right.title),
      ),
    };
  });

  // Retain attributable frames for a channel that disappeared from the current
  // directory, but label the boundary honestly instead of mixing it elsewhere.
  const known = new Set(channels.map((channel) => channel.id));
  for (const channelId of new Set(turns.map((turn) => turn.channelId))) {
    if (known.has(channelId)) continue;
    const orphanTurns = turns.filter((turn) => turn.channelId === channelId);
    channels.push({
      id: channelId,
      name: `archived-${channelId.slice(0, 8)}`,
      description: "Channel metadata is no longer available.",
      workstreams: [
        {
          id: `archived-${channelId}`,
          title: "Archived work",
          phase: "Archive",
          turns: orphanTurns,
        },
      ],
    });
  }

  // Presence remains a supporting signal only. It never creates a fake turn or
  // turns Fleet back into the Agents roster.
  void input.presence;

  return {
    generatedAt: new Date(input.now).toISOString(),
    source: hasEvents
      ? hasLiveEvents
        ? "observer"
        : "archive"
      : "unavailable",
    connection,
    channels,
  };
}
