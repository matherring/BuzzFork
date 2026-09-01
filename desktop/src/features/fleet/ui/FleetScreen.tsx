import * as React from "react";
import { AlertTriangle, Bot, RadioTower } from "lucide-react";

import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import { useAgentAccessOwnerOnlyQuery } from "@/features/agents/useAgentAccessOwnerOnly";
import { useOpenAgentActivity } from "@/features/agents/useOpenAgentActivity";
import { formatElapsed } from "@/features/agents/ui/agentSessionUtils";
import { Avatar, AvatarFallback, AvatarImage } from "@/shared/ui/avatar";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import {
  filterAndSortFleetAgents,
  type FleetAgentRow,
  type FleetObservationState,
} from "../fleetAggregation";
import { useFleetRows } from "../useFleetRows";

const STATUS_OPTIONS: Array<{
  value: FleetObservationState | "all";
  label: string;
}> = [
  { value: "all", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "failed", label: "Failed" },
  { value: "stale", label: "Stale" },
  { value: "online", label: "Online" },
  { value: "idle", label: "Idle" },
  { value: "unknown", label: "Unknown" },
  { value: "offline", label: "Offline" },
];

const STATUS_TONE: Record<FleetObservationState, string> = {
  active: "bg-primary/15 text-primary",
  failed: "bg-destructive/15 text-destructive",
  stale: "bg-warning/15 text-warning-foreground",
  online: "bg-success/15 text-success-foreground",
  idle: "bg-muted text-muted-foreground",
  unknown: "bg-muted text-muted-foreground",
  offline: "bg-muted text-muted-foreground",
};

function formatTimestamp(timestamp: number | null, now: number): string {
  if (timestamp === null) return "Unknown";
  return `${formatElapsed(Math.max(0, now - timestamp))} ago`;
}

function AgentAvatar({ row }: { row: FleetAgentRow }) {
  return (
    <Avatar className="h-10 w-10">
      {row.avatarUrl ? <AvatarImage alt="" src={row.avatarUrl} /> : null}
      <AvatarFallback aria-hidden="true" className="text-sm font-semibold">
        {row.name.trim().slice(0, 1).toUpperCase() || (
          <Bot className="h-4 w-4" />
        )}
      </AvatarFallback>
    </Avatar>
  );
}

function FleetRow({ row, now }: { row: FleetAgentRow; now: number }) {
  const { goAgentProfile, goChannel } = useAppNavigation();
  const { canOpenAgentActivity, openAgentActivity } = useOpenAgentActivity();
  const canOpenActivity = canOpenAgentActivity(row.pubkey);

  return (
    <article
      className="grid gap-4 border-b border-border/50 px-5 py-4 last:border-b-0 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.5fr)]"
      data-testid={`fleet-agent-${row.pubkey}`}
    >
      <div className="flex min-w-0 items-start gap-3">
        <AgentAvatar row={row} />
        <div className="min-w-0">
          <button
            className="block max-w-full truncate text-left text-base font-semibold hover:underline"
            onClick={() => void goAgentProfile(row.pubkey)}
            type="button"
          >
            {row.name}
          </button>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span>{row.runtimeLabel ?? "—"}</span>
            <span aria-hidden="true">·</span>
            <span>{row.modelLabel ?? "—"}</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge
              className={STATUS_TONE[row.observationState]}
              variant="secondary"
            >
              {row.observationState[0]?.toUpperCase()}
              {row.observationState.slice(1)}
            </Badge>
            <Badge variant="outline">{row.lifecycleLabel}</Badge>
          </div>
        </div>
      </div>

      <div className="min-w-0 space-y-1 text-sm">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Current work
        </p>
        {row.currentChannelId ? (
          <button
            className="block max-w-full truncate text-left font-medium text-primary hover:underline"
            onClick={() => {
              if (row.currentChannelId) void goChannel(row.currentChannelId);
            }}
            type="button"
          >
            #{row.currentChannelName ?? "Unknown channel"}
          </button>
        ) : (
          <p className="text-muted-foreground">No active turn</p>
        )}
        <p className="truncate text-xs text-muted-foreground">
          Turn {row.currentTurnId ?? "Unknown"}
          {row.turnStartedAt !== null
            ? ` · ${formatElapsed(Math.max(0, now - row.turnStartedAt))}`
            : ""}
        </p>
      </div>

      <div className="min-w-0 space-y-2">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Last sanitized activity
          </p>
          <p className="mt-1 line-clamp-2 text-sm">
            {row.lastActivity ?? "No sanitized activity available"}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>Observer {formatTimestamp(row.lastObserverAt, now)}</span>
          {canOpenActivity ? (
            <Button
              onClick={() =>
                openAgentActivity(row.pubkey, {
                  channelId: row.currentChannelId,
                })
              }
              size="xs"
              type="button"
              variant="ghost"
            >
              View activity
            </Button>
          ) : null}
        </div>
        {row.error ? (
          <p className="flex items-center gap-1.5 text-xs text-destructive">
            <AlertTriangle className="h-3.5 w-3.5" />
            {row.error}
          </p>
        ) : null}
      </div>
    </article>
  );
}

export function FleetScreen() {
  const ownerOnlyQuery = useAgentAccessOwnerOnlyQuery();
  const { goAgents } = useAppNavigation();
  const fleet = useFleetRows();
  const [status, setStatus] = React.useState<FleetObservationState | "all">(
    "all",
  );
  const [channelId, setChannelId] = React.useState<string | "all">("all");
  const now = Date.now();

  React.useEffect(() => {
    if (ownerOnlyQuery.data === false) {
      void goAgents({ replace: true });
    }
  }, [goAgents, ownerOnlyQuery.data]);

  if (ownerOnlyQuery.isLoading || fleet.isLoading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
        Loading fleet…
      </div>
    );
  }
  if (ownerOnlyQuery.data !== true) return null;

  const rows = filterAndSortFleetAgents(fleet.rows, { status, channelId });
  const fleetChannelIds = new Set(
    fleet.rows
      .map((row) => row.currentChannelId)
      .filter((id): id is string => id !== null),
  );
  const channels = fleet.channels
    .filter((channel) => fleetChannelIds.has(channel.id))
    .sort((left, right) => left.name.localeCompare(right.name));

  return (
    <main
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      data-testid="fleet-screen"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
          <PageHeader
            description="Read-only status from Buzz's managed-agent, presence, and encrypted observer pipelines."
            title="Fleet"
          />

          {fleet.observerConnectionState === "error" ||
          fleet.observerConnectionState === "closed" ||
          fleet.presenceResolution === "error" ? (
            <div
              className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm"
              data-testid="fleet-source-warning"
              role="status"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 text-destructive" />
              <div>
                <p className="font-medium">Some live status is unavailable</p>
                <p className="text-muted-foreground">
                  Fleet keeps unresolved agents Unknown and preserves the last
                  admitted observer timestamp.
                </p>
              </div>
            </div>
          ) : null}

          {fleet.managedAgents.length === 0 ? (
            <div
              className="flex flex-col items-center gap-3 rounded-xl border border-dashed p-10 text-center"
              data-testid="fleet-empty"
            >
              <RadioTower className="h-8 w-8 text-muted-foreground" />
              <div>
                <h2 className="text-lg font-semibold">No managed agents</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Fleet will appear here when this owner-managed context has
                  agents.
                </p>
              </div>
              <Button
                onClick={() => void goAgents()}
                type="button"
                variant="outline"
              >
                Open Agents
              </Button>
            </div>
          ) : (
            <>
              <fieldset className="flex flex-wrap gap-3 rounded-xl border bg-card p-3">
                <legend className="sr-only">Fleet filters</legend>
                <label className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground">Status</span>
                  <select
                    className="h-8 rounded-lg border border-input/40 bg-background px-2 text-sm"
                    data-testid="fleet-status-filter"
                    onChange={(event) =>
                      setStatus(
                        event.target.value as FleetObservationState | "all",
                      )
                    }
                    value={status}
                  >
                    {STATUS_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground">Channel</span>
                  <select
                    className="h-8 rounded-lg border border-input/40 bg-background px-2 text-sm"
                    data-testid="fleet-channel-filter"
                    onChange={(event) => setChannelId(event.target.value)}
                    value={channelId}
                  >
                    <option value="all">All channels</option>
                    {channels.map((channel) => (
                      <option key={channel.id} value={channel.id}>
                        #{channel.name}
                      </option>
                    ))}
                  </select>
                </label>
              </fieldset>

              <section
                className="overflow-hidden rounded-xl border bg-card"
                aria-label="Managed agent fleet"
              >
                {rows.length > 0 ? (
                  rows.map((row) => (
                    <FleetRow key={row.pubkey} now={now} row={row} />
                  ))
                ) : (
                  <div
                    className="p-10 text-center"
                    data-testid="fleet-filter-empty"
                  >
                    <p className="font-medium">No agents match these filters</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Try another status or channel.
                    </p>
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
