import { formatAgentModelLabel } from "@/features/agents/lib/formatAgentModelLabel";
import type { ActiveTurnSummary } from "@/features/agents/activeAgentTurnsStore";
import { findManagedAgentRuntime } from "@/features/agents/managedAgentRuntimeStatus";
import type {
  AcpRuntimeCatalogEntry,
  Channel,
  ManagedAgent,
  ManagedAgentRuntimeStatus,
  PresenceLookup,
} from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";
import type {
  ObserverEvent,
  TranscriptItem,
} from "@/features/agents/ui/agentSessionTypes";

/** Observer liveness is emitted every ten seconds. Two dropped frames plus
 * slack stop Fleet from claiming that an in-flight turn is active. */
export const FLEET_ACTIVE_FRAME_STALE_MS = 30_000;
export const FLEET_ACTIVITY_PREVIEW_MAX_CHARS = 140;

export type FleetObservationState =
  | "active"
  | "failed"
  | "stale"
  | "online"
  | "idle"
  | "unknown"
  | "offline";

export type FleetPresenceResolution = "loading" | "ready" | "error";

export type FleetAgentSource = {
  agent: ManagedAgent;
  activeTurns: readonly ActiveTurnSummary[];
  events: readonly ObserverEvent[];
  transcript: readonly TranscriptItem[];
  observerConnectionState: "idle" | "connecting" | "open" | "closed" | "error";
  observerErrorMessage: string | null;
};

export type FleetAgentRow = {
  pubkey: string;
  name: string;
  avatarUrl: string | null;
  runtimeLabel: string | null;
  modelLabel: string | null;
  lifecycleLabel: string;
  observationState: FleetObservationState;
  currentChannelId: string | null;
  currentChannelName: string | null;
  currentTurnId: string | null;
  turnStartedAt: number | null;
  lastActivity: string | null;
  lastObserverAt: number | null;
  error: string | null;
  observerConnectionState: FleetAgentSource["observerConnectionState"];
};

export type FleetFilter = {
  status?: FleetObservationState | "all";
  channelId?: string | "all";
};

const STATE_PRIORITY: Record<FleetObservationState, number> = {
  active: 0,
  failed: 1,
  stale: 2,
  online: 3,
  idle: 4,
  unknown: 5,
  offline: 6,
};

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function latestObserverAt(events: readonly ObserverEvent[]): number | null {
  let latest: number | null = null;
  for (const event of events) {
    const timestamp = parseTimestamp(event.timestamp);
    if (timestamp !== null && (latest === null || timestamp > latest)) {
      latest = timestamp;
    }
  }
  return latest;
}

function boundedPlainText(value: string): string | null {
  const plain = value.replace(/\s+/g, " ").trim();
  if (!plain) return null;
  return plain.length > FLEET_ACTIVITY_PREVIEW_MAX_CHARS
    ? `${plain.slice(0, FLEET_ACTIVITY_PREVIEW_MAX_CHARS - 1)}…`
    : plain;
}

/**
 * Compact activity from the already-sanitized transcript. This is deliberately
 * stricter than the full transcript renderer: raw metadata, thoughts/plans,
 * user prompts, permission detail, tool args/results/previews, and error bodies
 * are never eligible.
 */
export function summarizeFleetActivity(
  transcript: readonly TranscriptItem[],
): string | null {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const item = transcript[index];
    if (!item) continue;
    if (item.type === "message" && item.role === "assistant") {
      return boundedPlainText(item.text) ?? "Responded";
    }
    if (item.type === "tool" && item.renderClass !== "suppressed") {
      // Action objects and previews can be derived from command arguments.
      // The catalog label is the only compact tool field admitted here.
      return boundedPlainText(item.descriptor.label) ?? "Used a tool";
    }
    if (
      item.type === "lifecycle" &&
      item.renderClass !== "permission" &&
      item.renderClass !== "error"
    ) {
      return boundedPlainText(item.title);
    }
  }
  return null;
}

function resolveRuntimeLabel(
  agent: ManagedAgent,
  runtimes: readonly AcpRuntimeCatalogEntry[],
): string | null {
  const runtime = agent.runtime
    ? runtimes.find((candidate) => candidate.id === agent.runtime)
    : runtimes.find(
        (candidate) =>
          candidate.command !== null &&
          candidate.command === agent.agentCommand,
      );
  return runtime?.label ?? null;
}

function resolveLifecycleLabel(
  agent: ManagedAgent,
  runtime: ManagedAgentRuntimeStatus | undefined,
): string {
  if (runtime) {
    switch (runtime.lifecycle) {
      case "starting":
        return "Starting";
      case "listening":
        return "Listening";
      case "waking":
        return "Waking";
      case "ready":
        return "Ready";
      case "failed":
        return "Failed";
      case "stopped":
        return "Stopped";
    }
  }
  switch (agent.status) {
    case "running":
      return "Running";
    case "deployed":
      return "Deployed";
    case "stopped":
      return "Stopped";
    case "not_deployed":
      return "Not deployed";
  }
}

function safeError(
  agent: ManagedAgent,
  runtime: ManagedAgentRuntimeStatus | undefined,
): string | null {
  if (!agent.lastError && runtime?.lifecycle !== "failed") return null;
  if (agent.lastErrorCode === -32001) return "Community access denied";
  if (agent.lastErrorCode === -32002) return "Configured model unavailable";
  return runtime?.lifecycle === "failed"
    ? "Runtime failed"
    : "Agent reported an error";
}

function resolveCurrentTurn(
  activeTurns: readonly ActiveTurnSummary[],
  events: readonly ObserverEvent[],
): {
  channelId: string | null;
  turnId: string | null;
  startedAt: number | null;
} {
  if (activeTurns.length === 0) {
    return { channelId: null, turnId: null, startedAt: null };
  }
  const selected = [...activeTurns].sort(
    (left, right) =>
      left.anchorAt - right.anchorAt ||
      left.channelId.localeCompare(right.channelId),
  )[0];
  if (!selected) return { channelId: null, turnId: null, startedAt: null };

  let turnId: string | null = null;
  let latest: ObserverEvent | null = null;
  for (const event of events) {
    if (event.channelId !== selected.channelId || !event.turnId) continue;
    if (!latest) {
      latest = event;
      turnId = event.turnId;
      continue;
    }
    const eventAt = parseTimestamp(event.timestamp);
    const latestAt = parseTimestamp(latest.timestamp);
    if (
      eventAt !== null &&
      (latestAt === null ||
        eventAt > latestAt ||
        (eventAt === latestAt && event.seq > latest.seq))
    ) {
      latest = event;
      turnId = event.turnId;
    }
  }
  return {
    channelId: selected.channelId,
    turnId,
    startedAt: selected.anchorAt,
  };
}

function resolveObservationState(input: {
  activeTurn: boolean;
  agent: ManagedAgent;
  latestObserverAt: number | null;
  now: number;
  presence: "online" | "away" | "offline" | undefined;
  presenceResolution: FleetPresenceResolution;
  runtime: ManagedAgentRuntimeStatus | undefined;
}): FleetObservationState {
  const {
    activeTurn,
    agent,
    latestObserverAt,
    now,
    presence,
    presenceResolution,
    runtime,
  } = input;
  if (runtime?.lifecycle === "failed" || agent.lastError) return "failed";
  if (activeTurn) {
    if (latestObserverAt === null) return "unknown";
    if (latestObserverAt > now) return "unknown";
    return now - latestObserverAt > FLEET_ACTIVE_FRAME_STALE_MS
      ? "stale"
      : "active";
  }
  if (presenceResolution !== "ready") return "unknown";
  if (presence === "online") return "online";
  if (presence === "away") return "idle";
  return "offline";
}

export function aggregateFleetAgents(input: {
  sources: readonly FleetAgentSource[];
  runtimes: readonly AcpRuntimeCatalogEntry[];
  runtimeStatuses: readonly ManagedAgentRuntimeStatus[];
  channels: readonly Pick<Channel, "id" | "name">[];
  presence: PresenceLookup;
  presenceResolution: FleetPresenceResolution;
  now: number;
}): FleetAgentRow[] {
  const channelsById = new Map(
    input.channels.map((channel) => [channel.id, channel.name]),
  );
  return input.sources.map((source) => {
    const key = normalizePubkey(source.agent.pubkey);
    const pairRuntime = findManagedAgentRuntime(
      input.runtimeStatuses,
      source.agent.pubkey,
      source.agent.relayUrl,
    );
    const lastObserverAt = latestObserverAt(source.events);
    const currentTurn = resolveCurrentTurn(source.activeTurns, source.events);
    return {
      pubkey: source.agent.pubkey,
      name: source.agent.name,
      avatarUrl: source.agent.avatarUrl,
      runtimeLabel: resolveRuntimeLabel(source.agent, input.runtimes),
      modelLabel: source.agent.model
        ? formatAgentModelLabel(source.agent.model, source.agent.provider)
        : null,
      lifecycleLabel: resolveLifecycleLabel(source.agent, pairRuntime),
      observationState: resolveObservationState({
        activeTurn: currentTurn.channelId !== null,
        agent: source.agent,
        latestObserverAt: lastObserverAt,
        now: input.now,
        presence: input.presence[key],
        presenceResolution: input.presenceResolution,
        runtime: pairRuntime,
      }),
      currentChannelId: currentTurn.channelId,
      currentChannelName: currentTurn.channelId
        ? (channelsById.get(currentTurn.channelId) ?? null)
        : null,
      currentTurnId: currentTurn.turnId,
      turnStartedAt: currentTurn.startedAt,
      lastActivity: summarizeFleetActivity(source.transcript),
      lastObserverAt,
      error: safeError(source.agent, pairRuntime),
      observerConnectionState: source.observerConnectionState,
    };
  });
}

export function filterAndSortFleetAgents(
  rows: readonly FleetAgentRow[],
  filter: FleetFilter,
): FleetAgentRow[] {
  return rows
    .filter(
      (row) =>
        (!filter.status ||
          filter.status === "all" ||
          row.observationState === filter.status) &&
        (!filter.channelId ||
          filter.channelId === "all" ||
          row.currentChannelId === filter.channelId),
    )
    .map((row, index) => ({ row, index }))
    .sort(
      (left, right) =>
        STATE_PRIORITY[left.row.observationState] -
          STATE_PRIORITY[right.row.observationState] ||
        left.row.name.localeCompare(right.row.name, undefined, {
          sensitivity: "base",
        }) ||
        normalizePubkey(left.row.pubkey).localeCompare(
          normalizePubkey(right.row.pubkey),
        ) ||
        left.index - right.index,
    )
    .map(({ row }) => row);
}
