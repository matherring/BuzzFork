/**
 * Directly ported and adapted from Buzz Control Tower v0.8.2 `src/App.tsx`.
 * Buzz's app shell and owner gate remain outside this component; this is the
 * dense observation cockpit, not an agent-configuration roster.
 */

import * as React from "react";
import {
  AlertTriangle,
  Archive,
  Bot,
  ChevronDown,
  ChevronRight,
  Code2,
  GitBranch,
  GitCommitHorizontal,
  Info,
  LockKeyhole,
  Radio,
  RefreshCw,
  Search,
  ShieldCheck,
  Users,
  X,
  Zap,
} from "lucide-react";

import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import { useAgentAccessOwnerOnlyQuery } from "@/features/agents/useAgentAccessOwnerOnly";
import { formatElapsed } from "@/features/agents/ui/agentSessionUtils";
import { Button } from "@/shared/ui/button";
import type { AgentTurn, FleetAgentStatus } from "../controlTowerDomain";
import {
  allTurns,
  countWorkingTurns,
  findTurn,
  matchesTurnSearch,
} from "../controlTowerSelectors";
import { useFleetRows } from "../useFleetRows";
import {
  ControlTowerDetailPanel,
  ControlTowerTabs,
  type ControlTowerDetailTab,
} from "./ControlTowerDetails";
import "./FleetScreen.css";

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

const STATUS_FILTERS: Array<FleetAgentStatus | "all"> = [
  "all",
  "working",
  "blocked",
  "stale",
  "archived",
];

function StatusDot({ status }: { status: FleetAgentStatus }) {
  return (
    <span
      aria-hidden="true"
      className={`tower-status-dot status-${status}${status === "working" || status === "active" ? " pulse" : ""}`}
    />
  );
}

function ageLabel(timestamp: string | null): string {
  if (!timestamp) return "Unknown";
  const at = Date.parse(timestamp);
  if (!Number.isFinite(at)) return "Unknown";
  return `${formatElapsed(Math.max(0, Date.now() - at))} ago`;
}

function elapsedLabel(turn: AgentTurn): string {
  if (!turn.startedAt) return "—";
  const start = Date.parse(turn.startedAt);
  const end = turn.completedAt ? Date.parse(turn.completedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "—";
  return formatElapsed(Math.max(0, end - start));
}

export function FleetScreen() {
  const ownerOnlyQuery = useAgentAccessOwnerOnlyQuery();
  const { goAgents } = useAppNavigation();
  const [archiveChannelId, setArchiveChannelId] = React.useState<string | null>(
    null,
  );
  const fleet = useFleetRows(archiveChannelId);
  const [selectedId, setSelectedId] = React.useState<string>();
  const [activeTab, setActiveTab] =
    React.useState<ControlTowerDetailTab>("live");
  const [search, setSearch] = React.useState("");
  const [expandedChannels, setExpandedChannels] = React.useState(
    () => new Set<string>(),
  );
  const [statusFilter, setStatusFilter] = React.useState<
    FleetAgentStatus | "all"
  >("all");

  React.useEffect(() => {
    if (ownerOnlyQuery.data === false) {
      void goAgents({ replace: true });
    }
  }, [goAgents, ownerOnlyQuery.data]);

  React.useEffect(() => {
    const firstChannel = fleet.snapshot.channels[0];
    if (!archiveChannelId && firstChannel) {
      setArchiveChannelId(firstChannel.id);
      setExpandedChannels(new Set([firstChannel.id]));
    }
  }, [archiveChannelId, fleet.snapshot.channels]);

  const turns = allTurns(fleet.snapshot);
  const selectedTurn = selectedId
    ? findTurn(fleet.snapshot, selectedId)
    : undefined;

  React.useEffect(() => {
    if (selectedId && turns.some((turn) => turn.id === selectedId)) return;
    const first =
      turns.find((turn) => turn.status === "working") ?? turns[0] ?? undefined;
    setSelectedId(first?.id);
    if (first) {
      setArchiveChannelId(first.channelId);
      setExpandedChannels((current) => new Set(current).add(first.channelId));
    }
  }, [selectedId, turns]);

  if (ownerOnlyQuery.isLoading || fleet.isLoading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
        Assembling the work graph…
      </div>
    );
  }
  if (ownerOnlyQuery.data !== true) return null;

  const visibleTurnIds = new Set(
    turns
      .filter((turn) => statusFilter === "all" || turn.status === statusFilter)
      .filter((turn) => matchesTurnSearch(turn, search))
      .map((turn) => turn.id),
  );
  const hasSourceWarning =
    fleet.snapshot.connection !== "connected" ||
    fleet.presenceResolution === "error";

  const selectTurn = (turn: AgentTurn) => {
    setSelectedId(turn.id);
    setArchiveChannelId(turn.channelId);
    setActiveTab("live");
  };

  const toggleChannel = (channelId: string) => {
    setArchiveChannelId(channelId);
    setExpandedChannels((current) => {
      const next = new Set(current);
      if (next.has(channelId)) next.delete(channelId);
      else next.add(channelId);
      return next;
    });
  };

  return (
    <main
      className="fleet-tower"
      data-connection={fleet.snapshot.connection}
      data-testid="fleet-screen"
    >
      <header className="tower-topbar">
        <div className="tower-brand-block">
          <div className="tower-brand-mark">
            <Zap fill="currentColor" size={18} />
          </div>
          <div>
            <div className="tower-brand-name">Fleet Control Tower</div>
            <div className="tower-workspace-name">Buzz owner view</div>
          </div>
        </div>
        <div className="tower-topbar-center">
          <span className="tower-relay-indicator">
            <span className="tower-relay-pulse" />
            Encrypted observer
          </span>
          <span className="tower-topbar-divider" />
          <span
            className={`tower-source-state source-${fleet.snapshot.connection}`}
          >
            {fleet.snapshot.connection}
          </span>
          <span>
            Snapshot {new Date(fleet.snapshot.generatedAt).toLocaleTimeString()}
          </span>
        </div>
        <div className="tower-owner-boundary">
          <LockKeyhole size={14} />
          Owner only
        </div>
      </header>

      <aside className="tower-sidebar">
        <div className="tower-sidebar-heading">
          <div>
            <span className="tower-eyebrow">Workspace</span>
            <h2>Work graph</h2>
          </div>
          <div className="tower-live-count">
            <span>{countWorkingTurns(fleet.snapshot)}</span> live
          </div>
        </div>

        <label className="tower-search-box">
          <Search size={16} />
          <input
            aria-label="Find agents or work"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Find agents or work…"
            value={search}
          />
          {search ? (
            <button
              aria-label="Clear search"
              onClick={() => setSearch("")}
              type="button"
            >
              <X size={14} />
            </button>
          ) : null}
        </label>

        <fieldset
          aria-label="Filter turns by status"
          className="tower-filter-row"
        >
          {STATUS_FILTERS.map((filter) => (
            <button
              className={statusFilter === filter ? "active" : ""}
              key={filter}
              onClick={() => setStatusFilter(filter)}
              type="button"
            >
              {filter === "all" ? "All" : STATUS_LABELS[filter]}
            </button>
          ))}
        </fieldset>

        <nav
          aria-label="Channel work graph"
          className="tower-tree"
          data-testid="fleet-work-graph"
        >
          {fleet.snapshot.channels.map((channel) => {
            const channelTurns = channel.workstreams.flatMap(
              (workstream) => workstream.turns,
            );
            const channelVisible =
              channelTurns.some((turn) => visibleTurnIds.has(turn.id)) ||
              (channelTurns.length === 0 && !search && statusFilter === "all");
            if (!channelVisible) return null;
            const expanded = expandedChannels.has(channel.id);
            const workingCount = channelTurns.filter(
              (turn) => turn.status === "working",
            ).length;
            return (
              <div className="tower-channel-node" key={channel.id}>
                <button
                  className="tower-channel-button"
                  onClick={() => toggleChannel(channel.id)}
                  type="button"
                >
                  {expanded ? (
                    <ChevronDown size={15} />
                  ) : (
                    <ChevronRight size={15} />
                  )}
                  <span className="tower-hash">#</span>
                  <span>{channel.name}</span>
                  {workingCount > 0 ? (
                    <span className="tower-tree-count">{workingCount}</span>
                  ) : null}
                </button>
                {expanded ? (
                  <div className="tower-channel-children">
                    {channelTurns.length === 0 ? (
                      <div className="tower-empty-tree">
                        No observed turns yet. Archive history is loading for
                        this channel.
                      </div>
                    ) : null}
                    {channel.workstreams.map((workstream) => {
                      const visibleTurns = workstream.turns.filter((turn) =>
                        visibleTurnIds.has(turn.id),
                      );
                      if (visibleTurns.length === 0) return null;
                      return (
                        <div
                          className="tower-workstream-node"
                          key={workstream.id}
                        >
                          <div className="tower-workstream-label">
                            <GitBranch size={13} />
                            <span>{workstream.title}</span>
                            <span className="tower-phase-label">
                              {workstream.phase}
                            </span>
                          </div>
                          {visibleTurns.map((turn) => (
                            <button
                              className={`tower-agent-row${selectedTurn?.id === turn.id ? " selected" : ""}`}
                              data-testid={`fleet-turn-${turn.turnId}-${turn.channelId}`}
                              key={turn.id}
                              onClick={() => selectTurn(turn)}
                              type="button"
                            >
                              <StatusDot status={turn.status} />
                              <span className="tower-agent-row-copy">
                                <strong>{turn.agentName}</strong>
                                <span>{turn.operation}</span>
                              </span>
                              {turn.helperCount > 0 ? (
                                <span className="tower-helper-count">
                                  <Users size={11} />
                                  {turn.helperCount}
                                </span>
                              ) : turn.archived ? (
                                <Archive size={11} />
                              ) : null}
                            </button>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}
          {visibleTurnIds.size === 0 &&
          (search ||
            statusFilter !== "all" ||
            fleet.snapshot.channels.length === 0) ? (
            <div className="tower-empty-tree">No matching work found.</div>
          ) : null}
        </nav>

        <details className="tower-status-legend">
          <summary>
            <Info size={13} /> What the status chips mean
          </summary>
          <ul>
            <li>
              <StatusDot status="working" />
              <span>
                <strong>Working</strong> — fresh exact-turn observer frames.
              </span>
            </li>
            <li>
              <StatusDot status="stale" />
              <span>
                <strong>Stale</strong> — last verified state retained while
                frames are delayed or reconnecting.
              </span>
            </li>
            <li>
              <StatusDot status="archived" />
              <span>
                <strong>Archived</strong> — terminal turn reloaded from local
                kind-24200 history.
              </span>
            </li>
          </ul>
        </details>

        <div className="tower-security-note">
          <ShieldCheck size={15} />
          <div>
            <strong>Buzz identity boundary</strong>
            <span>
              Uses the existing signed-in owner identity, managed-agent catalog,
              observer stream, and archive.
            </span>
          </div>
        </div>
      </aside>

      <section className="tower-workspace">
        {hasSourceWarning ? (
          <div className="tower-relay-toast" role="status">
            {fleet.snapshot.connection === "reconnecting" ? (
              <RefreshCw className="tower-spin" size={15} />
            ) : (
              <AlertTriangle size={15} />
            )}
            <span>
              {fleet.snapshot.connection === "unavailable"
                ? "Observer unavailable. Select a channel to reload its archived turns."
                : "Live updates are interrupted; showing the last verified state."}
            </span>
          </div>
        ) : null}

        {fleet.managedAgents.length === 0 ? (
          <div className="tower-main-empty" data-testid="fleet-empty">
            <Bot size={30} />
            <h2>No managed agents</h2>
            <p>
              Fleet observes work. Configure an agent on the Agents screen, then
              return here to watch its turns.
            </p>
            <Button
              onClick={() => void goAgents()}
              type="button"
              variant="outline"
            >
              Open Agents
            </Button>
          </div>
        ) : !selectedTurn ? (
          <div className="tower-main-empty">
            <Radio size={30} />
            <h2>No observed turn selected</h2>
            <p>
              Expand a channel to load archived observer history or wait for a
              live managed-agent turn.
            </p>
          </div>
        ) : (
          <>
            <section className="tower-agent-hero">
              <div className="tower-agent-identity">
                <div
                  className={`tower-agent-glyph glyph-${selectedTurn.status}`}
                >
                  <Code2 size={23} />
                </div>
                <div>
                  <div className="tower-agent-meta">
                    <span>{selectedTurn.role}</span>
                    <span>•</span>
                    <span>{selectedTurn.model}</span>
                  </div>
                  <h1>{selectedTurn.agentName}</h1>
                  <div className="tower-operation-line">
                    <StatusDot status={selectedTurn.status} />
                    <strong>{selectedTurn.statusLabel}</strong>
                    <span>{selectedTurn.operation}</span>
                  </div>
                </div>
              </div>
              <div className="tower-hero-stats">
                <div>
                  <span>Elapsed</span>
                  <strong>{elapsedLabel(selectedTurn)}</strong>
                </div>
                <div>
                  <span>Last activity</span>
                  <strong>{ageLabel(selectedTurn.lastActivityAt)}</strong>
                </div>
                <div>
                  <span>Nested helpers</span>
                  <strong>{selectedTurn.helperCount}</strong>
                </div>
              </div>
            </section>
            <section className="tower-provenance-strip">
              <div>
                <GitBranch size={15} />
                <span>Branch</span>
                <strong>{selectedTurn.branch}</strong>
              </div>
              <div>
                <GitCommitHorizontal size={15} />
                <span>HEAD</span>
                <strong>{selectedTurn.head}</strong>
              </div>
              <div>
                <span>Turn</span>
                <strong>{selectedTurn.turnId}</strong>
              </div>
              <div className="tower-visibility-pill">
                <ShieldCheck size={14} />
                {selectedTurn.archived
                  ? "Local archive"
                  : "Encrypted live stream"}
              </div>
            </section>
            <ControlTowerTabs
              activeTab={activeTab}
              onChange={setActiveTab}
              turn={selectedTurn}
            />
            <ControlTowerDetailPanel
              activeTab={activeTab}
              turn={selectedTurn}
            />
          </>
        )}
      </section>
    </main>
  );
}
