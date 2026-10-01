/**
 * Who sent a chat card, who gets it (chat cards v2, autonomy design §A.12):
 * roles even when the agents are unknown, ids only when exactly one agent
 * fits. Split from `chat-cards.ts` (code review 2026-09-30 §4).
 *
 * Pure: no React, no React Native, no `server/` import.
 */
import type { ChatPeer } from "../shared/contracts";
import { soleWorkerOf } from "../shared/sole-worker";
import { ROLE_NAME, type ChatCard, type ChatRole } from "./chat-card-parse";
import type { RoleMarkKind } from "./tone";

export interface Party {
  role: ChatRole | null;
  /** Null when the agent cannot be established. */
  id: string | null;
  title: string | null;
}

/** A peer's role as a card names it; an agent without a known role has none. */
function chatRoleOf(role: ChatPeer["role"]): ChatRole | null {
  return role === "unknown" ? null : role;
}

/** A peer as a party of a card; `fallback` is its role when the peer is unknown or has none. */
export function party(peer: ChatPeer | undefined | null, fallback: ChatRole | null): Party {
  if (peer === undefined || peer === null) return { role: fallback, id: null, title: null };
  const role = chatRoleOf(peer.role) ?? fallback;
  return { role, id: peer.id, title: peer.title };
}

/** Exactly one match, or nothing: a card never picks between candidates. */
function only<T>(items: readonly T[]): T | undefined {
  return items.length === 1 ? items[0] : undefined;
}

/**
 * Sender and recipient of a card in the chat of `owner`. Returns roles even
 * when the agents are unknown, and ids only when exactly one agent fits.
 */
export function partiesOf(card: ChatCard, owner: ChatPeer | null, peers: readonly ChatPeer[]): { from: Party; to: Party } {
  const ownerRole = owner === null ? null : chatRoleOf(owner.role);
  const self = owner === null ? party(undefined, null) : party(owner, ownerRole);
  const byId = (id: string | null) => (id === null ? undefined : peers.find((peer) => peer.id === id));
  const ofRole = (role: ChatRole) => peers.filter((peer) => peer.role === role);
  // The one live Worker of the request; an old card of a Worker that has since
  // been archived keeps its name (delta 20260918f F12).
  const workerOf = (requestId: string | null) =>
    soleWorkerOf(peers, requestId) ?? only(ofRole("worker").filter((peer) => requestId !== null && peer.requestId === requestId));
  const manager = () => {
    const parent = byId(owner?.parentId ?? null);
    return parent?.role === "manager" ? parent : only(ofRole("manager"));
  };
  const parentWorker = () => {
    const parent = byId(owner?.parentId ?? null);
    return parent?.role === "worker" ? parent : undefined;
  };
  const fromReport = card.type === "progress" || card.type === "finished" || (card.type === "decision" && card.decision?.asker === "worker");

  if (card.direction === "sent") {
    const role = ownerRole ?? (card.type === "verdict" ? "reviewer" : fromReport ? "worker" : null);
    const to = card.type === "verdict" ? party(parentWorker() ?? workerOf(card.requestId), "worker") : party(manager(), "manager");
    return { from: { ...self, role }, to };
  }

  if (fromReport) return { from: party(workerOf(card.requestId), "worker"), to: self };
  if (card.type === "notice" || card.type === "decision") return { from: party(undefined, null), to: self };
  if (card.type === "verdict") {
    const batch = card.review?.batchId ?? null;
    const reviewers = ofRole("reviewer").filter(
      (peer) => (card.requestId === null || peer.requestId === card.requestId) && (batch === null || peer.batchId === batch),
    );
    return { from: party(only(reviewers), "reviewer"), to: self };
  }
  switch (ownerRole) {
    case "worker":
      return { from: party(manager(), "manager"), to: self };
    case "reviewer":
      return { from: party(parentWorker(), "worker"), to: self };
    case "manager":
      return { from: party(workerOf(card.requestId), "worker"), to: self };
    default:
      return { from: party(undefined, null), to: self };
  }
}

/** A party as a card's actor line names it: role and title, never an id (experience concept §5.1). */
export function actorName(p: Party): string {
  const role = p.role === null ? "Agent" : ROLE_NAME[p.role];
  return p.title !== null && p.title.trim() !== "" ? `${role} · ${p.title.trim()}` : role;
}

/**
 * Whether the renderer should draw the card at all. A chat that is not a
 * paseo-bm agent's, or a block the chat's agent only quoted (a Manager quoting
 * a review), is shown as plain text instead of pretending to be a card.
 */
export function drawAsCard(card: ChatCard, owner: ChatPeer | null): boolean {
  if (owner === null || owner.role === "unknown") return false;
  if (card.direction === "received") return true;
  return card.type === "verdict" ? owner.role === "reviewer" : owner.role === "worker";
}

/**
 * What Details says about the chat of an agent that carries no `bm.role`
 * label — started outside Beads Manager and recognised by its provider (delta
 * 20260918g §4.4) — or null for every other chat.
 */
export function ownerWarning(owner: ChatPeer | null): string | null {
  if (owner === null || owner.labelled !== false) return null;
  return "This agent has no bm.role label: it was started outside Beads Manager, and paseo-bm recognised it by its provider.";
}

/** The graph node kind whose icon and colour a role uses (`ROLE_MARK`). */
export function markOf(role: ChatRole | null): RoleMarkKind | null {
  return role === "manager" ? "request" : role;
}
