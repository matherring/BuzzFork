/**
 * Directly ported and adapted from Buzz Control Tower v0.8.2
 * (`src/selectors.ts`, commit 8f65a14c5b049b03e8382fd4baba68fa914b1ab0).
 */

import type {
  AgentTurn,
  FleetAgentStatus,
  TowerSnapshot,
  TurnIdentity,
} from "./controlTowerDomain";

function identityPart(value: string): string {
  return `${value.length}:${value}`;
}

/** Collision-safe key for exact observer turn attribution. */
export function turnIdentityKey(identity: TurnIdentity): string {
  return [
    identity.agentPubkey.toLowerCase(),
    identity.channelId,
    identity.turnId,
    identity.sessionId,
  ]
    .map(identityPart)
    .join("|");
}

export function allTurns(snapshot: TowerSnapshot): AgentTurn[] {
  return snapshot.channels.flatMap((channel) =>
    channel.workstreams.flatMap((workstream) => workstream.turns),
  );
}

export function findTurn(
  snapshot: TowerSnapshot,
  turnKey: string,
): AgentTurn | undefined {
  return allTurns(snapshot).find((turn) => turn.id === turnKey);
}

export function countWorkingTurns(snapshot: TowerSnapshot): number {
  return allTurns(snapshot).filter((turn) => turn.status === "working").length;
}

export function turnsByStatus(
  snapshot: TowerSnapshot,
  status: FleetAgentStatus | "all",
): AgentTurn[] {
  if (status === "all") return allTurns(snapshot);
  return allTurns(snapshot).filter((turn) => turn.status === status);
}

export function matchesTurnSearch(turn: AgentTurn, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return true;
  return [
    turn.agentName,
    turn.role,
    turn.operation,
    turn.branch,
    turn.turnId,
    turn.sessionId,
  ].some((value) => value.toLocaleLowerCase().includes(normalized));
}
