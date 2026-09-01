import * as React from "react";

import {
  getActiveTurnsForAgent,
  subscribeActiveAgentTurns,
} from "@/features/agents/activeAgentTurnsStore";
import {
  getAgentObserverSnapshot,
  getAgentTranscript,
  subscribeAgentObserverStore,
} from "@/features/agents/observerRelayStore";
import {
  useAcpRuntimesQuery,
  useManagedAgentsQuery,
} from "@/features/agents/hooks";
import { useManagedAgentRuntimesQuery } from "@/features/agents/managedAgentRuntimeHooks";
import { useChannelsQuery } from "@/features/channels/hooks";
import { usePresenceQuery } from "@/features/presence/hooks";
import { useNow } from "@/shared/lib/useNow";
import {
  aggregateFleetAgents,
  type FleetAgentSource,
  type FleetPresenceResolution,
} from "./fleetAggregation";

export function useFleetRows() {
  const managedAgentsQuery = useManagedAgentsQuery();
  const managedAgents = managedAgentsQuery.data ?? [];
  const runtimesQuery = useAcpRuntimesQuery();
  const runtimeStatusesQuery = useManagedAgentRuntimesQuery();
  const channelsQuery = useChannelsQuery();
  const presenceQuery = usePresenceQuery(
    managedAgents.map((agent) => agent.pubkey),
    { enabled: managedAgents.length > 0 },
  );
  const [, refresh] = React.useReducer((version: number) => version + 1, 0);
  const now = useNow(1_000);

  React.useEffect(() => {
    const unsubscribeObserver = subscribeAgentObserverStore(refresh);
    const unsubscribeTurns = subscribeActiveAgentTurns(refresh);
    return () => {
      unsubscribeObserver();
      unsubscribeTurns();
    };
  }, []);

  const sources = managedAgents.map<FleetAgentSource>((agent) => {
    const snapshot = getAgentObserverSnapshot(agent.pubkey);
    return {
      agent,
      activeTurns: getActiveTurnsForAgent(agent.pubkey),
      events: snapshot.events,
      transcript: getAgentTranscript(agent.pubkey),
      observerConnectionState: snapshot.connectionState,
      observerErrorMessage: snapshot.errorMessage,
    };
  });
  const presenceResolution: FleetPresenceResolution = presenceQuery.isError
    ? "error"
    : presenceQuery.isSuccess || managedAgents.length === 0
      ? "ready"
      : "loading";
  const rows = aggregateFleetAgents({
    sources,
    runtimes: runtimesQuery.data ?? [],
    runtimeStatuses: runtimeStatusesQuery.data ?? [],
    channels: channelsQuery.data ?? [],
    presence: presenceQuery.data ?? {},
    presenceResolution,
    now,
  });
  const observerConnectionState =
    sources.find((source) => source.observerConnectionState === "error")
      ?.observerConnectionState ??
    sources.find((source) => source.observerConnectionState === "closed")
      ?.observerConnectionState ??
    sources.find((source) => source.observerConnectionState === "connecting")
      ?.observerConnectionState ??
    sources.find((source) => source.observerConnectionState === "open")
      ?.observerConnectionState ??
    "idle";

  return {
    rows,
    channels: channelsQuery.data ?? [],
    managedAgents,
    managedAgentsQuery,
    observerConnectionState,
    presenceResolution,
    isLoading:
      managedAgentsQuery.isLoading ||
      runtimesQuery.isLoading ||
      runtimeStatusesQuery.isLoading ||
      channelsQuery.isLoading,
  };
}
