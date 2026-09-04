import * as React from "react";

import {
  getAgentObserverSnapshot,
  getArchivedChannelEvents,
  subscribeAgentObserverStore,
} from "@/features/agents/observerRelayStore";
import { useManagedAgentsQuery } from "@/features/agents/hooks";
import { useLoadArchivedObserverEvents } from "@/features/agents/ui/useObserverEvents";
import { useChannelsQuery } from "@/features/channels/hooks";
import { usePresenceQuery } from "@/features/presence/hooks";
import { useProjectsQuery } from "@/features/projects/hooks";
import { useNow } from "@/shared/lib/useNow";
import { projectControlTowerSnapshot } from "./controlTowerProjection";

/**
 * Buzz application-boundary adapter for the directly ported Control Tower
 * projection. The adapter owns no identity, relay, updater, or configuration;
 * it reads the stores and queries already mounted by Buzz Desktop.
 */
export function useFleetRows(archiveChannelId: string | null = null) {
  const managedAgentsQuery = useManagedAgentsQuery();
  const managedAgents = managedAgentsQuery.data ?? [];
  const channelsQuery = useChannelsQuery();
  const channels = channelsQuery.data ?? [];
  const projectsQuery = useProjectsQuery();
  const projects = projectsQuery.data ?? [];
  const presenceQuery = usePresenceQuery(
    managedAgents.map((agent) => agent.pubkey),
    { enabled: managedAgents.length > 0 },
  );
  const [, refresh] = React.useReducer((version: number) => version + 1, 0);
  const now = useNow(1_000);

  useLoadArchivedObserverEvents(Boolean(archiveChannelId), archiveChannelId);

  React.useEffect(() => subscribeAgentObserverStore(refresh), []);

  const sources = managedAgents.map((agent) => {
    const observer = getAgentObserverSnapshot(agent.pubkey);
    return {
      agent,
      observerConnectionState: observer.connectionState,
      liveEvents: observer.events,
      archivedEventsByChannel: new Map(
        channels.map((channel) => [
          channel.id,
          getArchivedChannelEvents(agent.pubkey, channel.id),
        ]),
      ),
    };
  });
  const snapshot = projectControlTowerSnapshot({
    sources,
    channels,
    projects,
    presence: presenceQuery.data ?? {},
    now,
  });

  return {
    snapshot,
    channels,
    managedAgents,
    managedAgentsQuery,
    projectsQuery,
    presenceResolution: presenceQuery.isError
      ? ("error" as const)
      : presenceQuery.isSuccess || managedAgents.length === 0
        ? ("ready" as const)
        : ("loading" as const),
    isLoading:
      managedAgentsQuery.isLoading ||
      channelsQuery.isLoading ||
      projectsQuery.isLoading,
  };
}
