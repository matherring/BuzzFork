/**
 * Direct UI port from Buzz Control Tower v0.8.2 `src/App.tsx`.
 * Application-shell and data-source controls were intentionally removed; the
 * tab contents, terminology, hierarchy, and inspector interactions are kept.
 */

import * as React from "react";
import {
  Activity,
  Archive,
  Braces,
  Check,
  ChevronRight,
  CircleDot,
  Clock3,
  Code2,
  FileText,
  Image,
  Layers3,
  Link2,
  LockKeyhole,
  Radio,
  ShieldCheck,
  X,
} from "lucide-react";

import type {
  ActivityEvent,
  AgentTurn,
  Artifact,
  ContextSource,
} from "../controlTowerDomain";

export type ControlTowerDetailTab =
  | "live"
  | "context"
  | "evidence"
  | "artifacts";

const TABS = [
  { id: "live", label: "Live", icon: Radio },
  { id: "context", label: "Context", icon: Braces },
  { id: "evidence", label: "Evidence", icon: ShieldCheck },
  { id: "artifacts", label: "Artifacts", icon: Archive },
] as const;

export function ControlTowerTabs({
  activeTab,
  onChange,
  turn,
}: {
  activeTab: ControlTowerDetailTab;
  onChange: (tab: ControlTowerDetailTab) => void;
  turn: AgentTurn;
}) {
  return (
    <div className="tower-tabs" role="tablist">
      {TABS.map((tab) => {
        const Icon = tab.icon;
        const count =
          tab.id === "live"
            ? turn.activity.length
            : tab.id === "context"
              ? turn.context.length
              : tab.id === "evidence"
                ? turn.evidence.length
                : turn.artifacts.length;
        return (
          <button
            aria-selected={activeTab === tab.id}
            className={activeTab === tab.id ? "active" : ""}
            key={tab.id}
            onClick={() => onChange(tab.id)}
            role="tab"
            type="button"
          >
            <Icon size={16} />
            {tab.label}
            <span>{count}</span>
          </button>
        );
      })}
    </div>
  );
}

export function ControlTowerDetailPanel({
  activeTab,
  turn,
}: {
  activeTab: ControlTowerDetailTab;
  turn: AgentTurn;
}) {
  return (
    <section className="tower-detail-panel">
      {activeTab === "live" ? (
        <LiveView events={turn.activity} turn={turn} />
      ) : null}
      {activeTab === "context" ? <ContextView sources={turn.context} /> : null}
      {activeTab === "evidence" ? <EvidenceView turn={turn} /> : null}
      {activeTab === "artifacts" ? (
        <ArtifactsView artifacts={turn.artifacts} />
      ) : null}
    </section>
  );
}

function PanelHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="tower-panel-heading">
      <div>
        <span className="tower-eyebrow">{eyebrow}</span>
        <h2>{title}</h2>
      </div>
      <p>{description}</p>
    </div>
  );
}

function EmptyState({
  icon: Icon,
  title,
  text,
}: {
  icon: typeof Clock3;
  title: string;
  text: string;
}) {
  return (
    <div className="tower-empty-state">
      <div>
        <Icon size={18} />
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}

function LiveView({
  events,
  turn,
}: {
  events: ActivityEvent[];
  turn: AgentTurn;
}) {
  const live = turn.status === "working";
  return (
    <>
      <PanelHeading
        description={
          live
            ? "A safe semantic view of this exact turn, updated from the encrypted observer stream."
            : "The agent is not streaming right now; this is the most recent state for this exact turn."
        }
        eyebrow="Turn stream"
        title={live ? "Live activity" : "Last turn"}
      />
      {turn.liveText || turn.liveThought ? (
        <div className="tower-live-stream">
          {turn.liveText ? (
            <div className="tower-live-stream-block">
              <span className="tower-live-stream-label">
                {live ? "Streaming reply" : "Final reply"}
              </span>
              <pre className="tower-live-stream-text">{turn.liveText}</pre>
            </div>
          ) : null}
          {turn.liveThought ? (
            <details
              className="tower-live-stream-block tower-live-stream-thought"
              data-testid="fleet-reasoning"
            >
              <summary className="tower-live-stream-label">
                Reasoning stream
              </summary>
              <pre className="tower-live-stream-text">{turn.liveThought}</pre>
            </details>
          ) : null}
        </div>
      ) : null}
      {events.length > 0 ? (
        <div className="tower-timeline" data-testid="fleet-tool-timeline">
          {events.map((event, index) => (
            <article className="tower-timeline-item" key={event.id}>
              <div
                className={`tower-timeline-icon event-${event.status ?? "complete"}`}
              >
                {event.status === "running" ? (
                  <Activity size={15} />
                ) : event.status === "failed" ? (
                  <CircleDot size={15} />
                ) : (
                  <Check size={15} />
                )}
              </div>
              {index < events.length - 1 ? (
                <span className="tower-timeline-line" />
              ) : null}
              <time>{compactTime(event.at)}</time>
              <div className="tower-timeline-copy">
                <strong>{event.title}</strong>
                <p>{event.detail}</p>
                {(event.parameters?.length ?? 0) > 0 || event.result ? (
                  <details
                    className="tower-event-details"
                    open={event.status === "running"}
                  >
                    <summary>Details</summary>
                    {event.parameters?.map((parameter) => (
                      <div
                        className="tower-event-parameter"
                        key={`${event.id}-${parameter.label}`}
                      >
                        <span>{parameter.label}</span>
                        <pre>{parameter.value}</pre>
                      </div>
                    ))}
                    {event.result ? (
                      <div className="tower-event-parameter">
                        <span>Result</span>
                        <pre>{event.result}</pre>
                      </div>
                    ) : null}
                  </details>
                ) : null}
              </div>
              <span className={`tower-event-kind kind-${event.kind}`}>
                {event.kind}
              </span>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={Clock3}
          text={`${turn.agentName} has not published activity for this turn.`}
          title="No activity in this snapshot"
        />
      )}
    </>
  );
}

export function ContextView({ sources }: { sources: ContextSource[] }) {
  const [selectedSourceId, setSelectedSourceId] = React.useState<string>();
  const selectedSource = sources.find(
    (source) => source.id === selectedSourceId,
  );

  React.useEffect(() => {
    if (
      selectedSourceId &&
      !sources.some((source) => source.id === selectedSourceId)
    ) {
      setSelectedSourceId(undefined);
    }
  }, [selectedSourceId, sources]);

  return (
    <>
      <PanelHeading
        description="Select a source to inspect the safe content that shaped this turn, or see why its body remains withheld."
        eyebrow="Inspectable manifest"
        title="Supplied context"
      />
      {sources.length > 0 ? (
        <div
          className={`tower-context-layout${selectedSource ? " context-open" : ""}`}
          data-testid="fleet-context-manifest"
        >
          <div className="tower-card-grid tower-context-grid">
            {sources.map((source) => {
              const selected = source.id === selectedSourceId;
              return (
                <button
                  aria-controls="fleet-context-detail"
                  aria-expanded={selected}
                  className={`tower-info-card tower-context-card${selected ? " selected" : ""}`}
                  key={source.id}
                  onClick={() =>
                    setSelectedSourceId(selected ? undefined : source.id)
                  }
                  type="button"
                >
                  <div className="tower-card-icon">
                    <Layers3 size={17} />
                  </div>
                  <div className="tower-card-main">
                    <span className="tower-card-kicker">{source.kind}</span>
                    <h3>{source.label}</h3>
                    <p>{source.detail}</p>
                  </div>
                  <dl>
                    <div>
                      <dt>Hash</dt>
                      <dd>{source.hash}</dd>
                    </div>
                    <div>
                      <dt>Size</dt>
                      <dd>{source.size}</dd>
                    </div>
                  </dl>
                  <span
                    className={`tower-visibility visibility-${source.visibility}`}
                  >
                    {source.visibility}
                  </span>
                  <span className="tower-inspect-label">
                    {selected ? "Close" : "Inspect"}
                    <ChevronRight size={12} />
                  </span>
                </button>
              );
            })}
          </div>
          {selectedSource ? (
            <aside
              aria-labelledby="fleet-context-detail-title"
              className="tower-context-detail"
              data-testid="fleet-context-inspector"
              id="fleet-context-detail"
            >
              <div className="tower-context-detail-heading">
                <div>
                  <span className="tower-eyebrow">
                    {selectedSource.kind} context
                  </span>
                  <h3 id="fleet-context-detail-title">
                    {selectedSource.label}
                  </h3>
                </div>
                <button
                  aria-label="Close context detail"
                  onClick={() => setSelectedSourceId(undefined)}
                  type="button"
                >
                  <X size={16} />
                </button>
              </div>
              <p className="tower-context-summary">{selectedSource.detail}</p>
              {(selectedSource.fields?.length ?? 0) > 0 ? (
                <dl className="tower-context-fields">
                  {selectedSource.fields?.map((field) => (
                    <div key={`${selectedSource.id}-${field.label}`}>
                      <dt>{field.label}</dt>
                      <dd>{field.value}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              {selectedSource.content ? (
                <div className="tower-context-content">
                  <span>Safe content</span>
                  <pre>{selectedSource.content}</pre>
                </div>
              ) : null}
              {selectedSource.withheldReason ? (
                <div className="tower-withheld-note">
                  <LockKeyhole size={15} />
                  <div>
                    <strong>Body withheld at source</strong>
                    <p>{selectedSource.withheldReason}</p>
                  </div>
                </div>
              ) : null}
              <dl className="tower-context-integrity">
                <div>
                  <dt>Source hash</dt>
                  <dd>{selectedSource.hash}</dd>
                </div>
                <div>
                  <dt>Source size</dt>
                  <dd>{selectedSource.size}</dd>
                </div>
                <div>
                  <dt>Visibility</dt>
                  <dd>{selectedSource.visibility}</dd>
                </div>
              </dl>
            </aside>
          ) : null}
        </div>
      ) : (
        <EmptyState
          icon={Braces}
          text="This turn source did not provide inspectable context provenance."
          title="No context manifest"
        />
      )}
    </>
  );
}

function EvidenceView({ turn }: { turn: AgentTurn }) {
  const completed = turn.evidence.filter((item) => item.complete).length;
  return (
    <>
      <PanelHeading
        description="The exact path from local work to a deployed result. Later stages never infer success from agent activity."
        eyebrow="Delivery chain"
        title="Evidence, not activity"
      />
      {turn.evidence.length > 0 ? (
        <>
          <div className="tower-evidence-summary">
            <div className="tower-evidence-score">
              <strong>{completed}</strong>
              <span>of {turn.evidence.length} stages</span>
            </div>
            <div className="tower-progress-track">
              <span
                style={{
                  width: `${(completed / turn.evidence.length) * 100}%`,
                }}
              />
            </div>
            <span>
              {completed === turn.evidence.length ? "Delivered" : "In progress"}
            </span>
          </div>
          <div
            className="tower-delivery-chain"
            data-testid="fleet-delivery-evidence"
          >
            {turn.evidence.map((item, index) => (
              <article
                className={`tower-delivery-stage${item.complete ? " complete" : ""}`}
                key={item.stage}
              >
                <div className="tower-delivery-node">
                  {item.complete ? <Check size={15} /> : index + 1}
                </div>
                {index < turn.evidence.length - 1 ? (
                  <span className="tower-delivery-line" />
                ) : null}
                <span>{item.stage}</span>
                <strong>{item.label}</strong>
                <p>{item.detail}</p>
                {(item.facts?.length ?? 0) > 0 ? (
                  <dl className="tower-evidence-facts">
                    {item.facts?.map((fact) => (
                      <div key={`${item.stage}-${fact.label}`}>
                        <dt>{fact.label}</dt>
                        <dd>{fact.value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </article>
            ))}
          </div>
        </>
      ) : (
        <EmptyState
          icon={ShieldCheck}
          text="This source has not attached delivery facts to the selected turn."
          title="No delivery evidence"
        />
      )}
    </>
  );
}

function ArtifactsView({ artifacts }: { artifacts: Artifact[] }) {
  return (
    <>
      <PanelHeading
        description="Files and links attributed to this exact agent, channel, turn, and session."
        eyebrow="Turn output"
        title="Artifacts"
      />
      {artifacts.length > 0 ? (
        <div className="tower-artifact-list" data-testid="fleet-artifacts">
          {artifacts.map((artifact) => {
            const Icon =
              artifact.kind === "image"
                ? Image
                : artifact.kind === "document"
                  ? FileText
                  : artifact.kind === "link"
                    ? Link2
                    : Code2;
            return (
              <article key={artifact.id}>
                <div className="tower-card-icon">
                  <Icon size={17} />
                </div>
                <div>
                  <span>{artifact.kind}</span>
                  <strong>{artifact.name}</strong>
                </div>
                <code>{artifact.detail}</code>
                <time>{compactTime(artifact.changedAt)}</time>
              </article>
            );
          })}
        </div>
      ) : (
        <EmptyState
          icon={Archive}
          text="No files or links were attributed to this turn."
          title="No artifacts"
        />
      )}
    </>
  );
}

function compactTime(isoTime: string): string {
  const parsed = new Date(isoTime);
  if (!Number.isFinite(parsed.getTime())) return "—";
  return new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(parsed);
}
