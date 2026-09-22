/**
 * Which Worker a request belongs to (delta 20260918f F12, owner decision Q7 a).
 *
 * The one live `worker` carrying the request id; nobody when there is none, or
 * more than one. An archived agent never counts: sending to it would bring it
 * back (ADR-005), and a broken Worker the Manager replaced keeps the request's
 * label. Nor does a Worker a fallback Worker replaced (`replaced`, delta
 * 20260921 §4.4.8): the replacement carries the same request id. `chat.waiting` (server) and the chat card (client) both decide with
 * this, so a pill and its card always agree.
 *
 * Pure and environment-neutral.
 */
export function soleWorkerOf<P extends { role: string; requestId: string | null; archived: boolean; replaced?: boolean }>(
  peers: readonly P[],
  requestId: string | null,
): P | null {
  if (requestId === null) return null;
  const live = peers.filter((peer) => peer.role === "worker" && !peer.archived && peer.replaced !== true && peer.requestId === requestId);
  return live.length === 1 ? live[0]! : null;
}
