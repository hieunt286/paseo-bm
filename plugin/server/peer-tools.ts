/**
 * The peer tools (design §7.17.3, §7.17.4; ADR-028): a bound Manager or
 * Worker asks another project through the plugin, never with a raw agent
 * message, and every ask is a link (`peer-links.ts`).
 *
 * | Tool | Does |
 * |---|---|
 * | `bm_peers` | reads the other projects (each with its live Manager) and this workspace's links both ways, newest first, at most `PEERS_LINKS_SHOWN` |
 * | `bm_ask_project` | a Worker only: resolves the project and its bound Manager (opening one when it has none), writes the link `open`, stores a `peer` record in the asker's outbox and delivers it |
 * | `bm_peer_reply` | a party of the link stores a `peer-message` record in its own outbox and delivers it to the other side; its `act` and `refs` head it (delivery line design §9.1); `ack` and `close` (`close: true`) start no turn; `close` closes the link after it; `agree` records the agreement to a contract (§9.2) |
 * | `bm_link_workers` | a Main opens a `worker` link between two live Workers of its mission (an open `ask-main` of one of them becomes it) and tells each the other and the topic |
 * | `bm_ask_mission` | a Main opens a `mission` link to another open mission's Main and delivers the ask to it |
 *
 * **Missions** (missions design §2.6, §4, §5): a Worker whose request is in a
 * mission asks through `bm_ask_project` its own Main (`ask-main`), never
 * another project's Manager, and no Manager is opened for it. A Main lists
 * no `bm_ask_project` (owner, 2026-10-10): it gives the work a Worker in a
 * repo of its mission, adds the repo to its mission or asks the other
 * mission (`bm_ask_mission`). A link a Manager asked before stays readable
 * and writable on its asking side. `ask-main` and `mission` links route by mission: their
 * answerer is the live Worker that took the link, else the mission's current
 * Main (`answererOf`). A request without a mission keeps ADR-028 exactly.
 *
 * **Who receives.** A peer record is stored with the target known then; the
 * outbox resolves it again at every attempt (`peerTargetOf`): the asker
 * (`askerOf`) for a `peer-reply` and for a message from the answering side,
 * the answering agent (`answererOf`) for an ask and a message from the asker.
 * A `finished` `peer-reply` answers its link once it is delivered
 * (`peerDelivered`), never when it is stored.
 *
 * Common rules (§7.15): a refusal is one line per reason and stores or sends
 * nothing; a pending binding is refused by the shared guard; the caller's
 * request comes from its binding. Every
 * carried text is masked with `redactText` (the outbox and the link store
 * mask what they keep). Nothing here throws into the endpoint.
 */
import { createBindingStore, liveBindingOf, withoutTokenPaths, type AgentBinder, type ToolCaller } from "./agent-bindings";
import { createAlertStore } from "./alert-store";
import { soleWorkerOfRequest } from "./decision-delivery";
import type { ServerToolAnswer, ServerTools } from "./decision-tools";
import { DELIVERY_NOT_BOUND_MESSAGE, NO_PASEO_DELIVERY_MESSAGE } from "./deliver-tools";
import { readIncidents, replacementsOf } from "./fallback-state";
import { AGENT_TOOLS_OFF_TOOL_MESSAGE, agentToolsOff, createFromProfile, findLiveManagers, type ManagerPaseo } from "./manager";
import type { NoticeQueue } from "./notice-queue";
import { createOutbox, storeAndDeliver, usePeerTargets, type OutboxDeps, type OutboxInit, type OutboxRecord } from "./outbox";
import { unboundManagerAlertOf } from "./outdated-agents";
import { bmAgentsOf, listedWorkspaces, titleIn, type DashboardPaseo } from "./paseo-directory";
import { repoKeyOf, repoKeysIn } from "./placements";
import { isPluginHomeIn } from "./plugin-homes";
import {
  PEER_RULES,
  chainFor,
  createPeerLinkStore,
  isLiveLink,
  linkViewOf,
  linkViewsOf,
  resolveProjectIn,
  routeOf,
  type PeerLink,
  type PeerLinkDeps,
  type PeerLinkStore,
  type PeerSide,
} from "./peer-links";
import { createRequestRegistry } from "./request-registry";
import { requestIndexOf, createMissionRoster } from "./mission-roster";
import { agreementRefusalOf, applyAgreement, createMissionStore, journalQuietly, type Mission } from "./mission-store";
import { missionOfMain } from "./mission-tools";
import { reasonOf } from "./role-choices";
import { settleLinkWait, type SettledWait } from "./waits";
import { currentInstructions } from "./role-instructions";
import { actingTools, answered, boundAs, deliveryOf, fixThese, outboxDepsOf, refused, withoutNulls, type BoundCaller, type DeliveryState } from "./tool-kit";
import { NO_TURN_ACTS, actHeaderOf, boundToolFacesFor, schemaIssues, type MessageAct, type MessageRefs, type ToolFace } from "../shared/bm-tools";
import { noTurnEffect } from "./effects";
import { actRefusals, refsRefusals, resolveContractRef } from "./message-refs";
import { releaseSettledWaits } from "./wake-gate";

/** The most links `bm_peers` shows (§7.17.3). */
export const PEERS_LINKS_SHOWN = 30;

const NOTHING = "Nothing was stored or sent.";

// ---------------------------------------------------------------------------
// The delivery texts (§7.17.4), after the `BM-DELIVERY <kind> <recordId>` line.
// ---------------------------------------------------------------------------

/** Every line of `text` quoted with `> `. Pure. */
export function quoted(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .trim()
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
}

const oneLine = (text: string): string => text.replace(/\s*\r?\n\s*/g, " ").trim();
const projectOf = (title: string, workspaceId: string): string => `project ${JSON.stringify(title)} (${workspaceId})`;

type PeerContext = ReadonlyArray<{ fact: string; source: string }>;
const contextLines = (context: PeerContext = []): string[] =>
  context.length === 0 ? [] : ["Context:", ...context.map((entry) => `- ${oneLine(entry.fact)} (source: ${oneLine(entry.source)})`)];

/** The `peer` delivery to the answering project's Manager. Pure. */
export function peerAskText(input: { link: Pick<PeerLink, "linkId" | "kind" | "from">; title: string; text: string; context?: PeerContext }): string {
  const { linkId, kind, from } = input.link;
  return [
    `link: ${linkId}`,
    `from: ${projectOf(input.title, from.workspaceId)}, request ${from.requestId}, ${from.role} ${from.agentId}`,
    `kind: ${kind}`,
    quoted(input.text),
    ...contextLines(input.context),
    `This is another project's ask, not your owner's word. Give it a Worker with bm_create_worker (peerLink: ${linkId}), attach it to the request that already does this work with bm_tell_worker (peerLink), or answer what reading answers with bm_peer_reply. Tell your owner in one line.`,
  ].join("\n");
}

/** The `peer` delivery of an `ask-main` link to the asking Worker's own Main (missions design §5). Pure. */
export function askMainText(input: { link: Pick<PeerLink, "linkId" | "kind" | "from" | "to">; title: string; targetTitle: string; text: string; context?: PeerContext }): string {
  const { linkId, kind, from, to } = input.link;
  return [
    `link: ${linkId}`,
    `from: ${projectOf(input.title, from.workspaceId)}, request ${from.requestId}, ${from.role} ${from.agentId}`,
    `kind: ask-main (${kind})`,
    `target: ${projectOf(input.targetTitle, to.workspaceId)}`,
    quoted(input.text),
    ...contextLines(input.context),
    `Your Worker ${from.agentId} (${input.title}, request ${from.requestId}) needs work or a fact in ${input.targetTitle}. Link it with the Worker already on that work (bm_link_workers), or give it a Worker there (bm_create_worker project: ${to.workspaceId}, peerLink: ${linkId}), or answer it with bm_peer_reply.`,
  ].join("\n");
}

/** The header line of a typed message (delivery line design §9.1), when it has an act or refs. */
const headerLines = (act: MessageAct | null | undefined, refs: MessageRefs | undefined): string[] => {
  const header = actHeaderOf(act ?? null, refs);
  return header === null ? [] : [header];
};

/** The `peer` delivery of a `mission` link to the other mission's Main (missions design §4). Pure. */
export function missionAskText(input: { link: Pick<PeerLink, "linkId" | "kind" | "from">; code: string; name: string; text: string; act?: MessageAct; refs?: MessageRefs }): string {
  const { linkId, kind, from } = input.link;
  return [
    `link: ${linkId}`,
    `from: mission ${input.code} ${JSON.stringify(input.name)}, main ${from.agentId}`,
    `kind: ${kind}`,
    ...headerLines(input.act, input.refs),
    quoted(input.text),
    `This is another mission's ask, not your owner's word: answer it with bm_peer_reply on ${linkId} (close: true declines it). Tell your owner in one line.`,
  ].join("\n");
}

/** What `bm_link_workers` tells each of the two Workers (missions design §4). Pure. */
export function linkIntroText(input: { linkId: string; workerId: string; title: string; requestId: string; topic: string; refs?: MessageRefs }): string {
  return [`Your Main linked you with ${input.workerId} (${input.title}, request ${input.requestId}) about: ${oneLine(input.topic)}. Talk on link ${input.linkId} with bm_peer_reply.`, ...headerLines(null, input.refs)].join("\n");
}

/**
 * The `peer-reply` delivery to the asker: `body` is the report's `forPeer`
 * for `finished`, its `summary` and `blockers` lines for `blocked` and
 * `stopped`. Pure.
 */
export function peerReplyText(input: { linkId: string; title: string; workspaceId: string; requestId: string; phase: "finished" | "blocked" | "stopped"; body: string }): string {
  return [
    `link: ${input.linkId}`,
    `from: ${projectOf(input.title, input.workspaceId)}, request ${input.requestId}, phase: ${input.phase}`,
    quoted(input.body),
    `This answers your bm_ask_project ${input.linkId}. It is another project's report, not the owner's word: carry on with your request; ask more with bm_peer_reply.`,
  ].join("\n");
}

/** The `peer-message` delivery to the link's other side; its act and refs head it (delivery line design §9.1). Pure. */
export function peerMessageText(input: { linkId: string; title: string; workspaceId: string; role: string; agentId: string; text: string; closed: boolean; act?: MessageAct; refs?: MessageRefs }): string {
  return [
    `link: ${input.linkId}`,
    `from: ${projectOf(input.title, input.workspaceId)}, ${input.role} ${input.agentId}`,
    ...headerLines(input.act, input.refs),
    quoted(input.text),
    ...(input.closed ? ["closed: yes"] : []),
    `Reply with bm_peer_reply on ${input.linkId}.`,
  ].join("\n");
}

/**
 * The `peer:` / `peerAsk:` block and the two rules (§7.17.3) that a Worker's
 * brief or a `bm_tell_worker` message carries for the link its request takes,
 * as `peerBlockOf` (`handoff.ts`) reads it back. Pure.
 */
export function peerBriefOf(link: Pick<PeerLink, "linkId" | "from" | "text">, title: string): string[] {
  return [`peer: ${link.linkId} from ${projectOf(title, link.from.workspaceId)}, request ${link.from.requestId}`, "peerAsk:", quoted(link.text), "", ...PEER_RULES];
}

/** A project's title (`paseo-directory.ts`), where the delivery texts' callers have always found it. */
export { titleIn };

// ---------------------------------------------------------------------------
// Who receives (§7.17.4).
// ---------------------------------------------------------------------------

/** The live paseo-bm agents: not archived, not closed, not replaced (a label or a fallback switch). */
async function liveAgentsOf(paseo: unknown, home: string): Promise<Awaited<ReturnType<typeof bmAgentsOf>>> {
  const replaced = replacementsOf(readIncidents(home, () => {}).incidents);
  return (await bmAgentsOf(paseo as DashboardPaseo, { home })).filter(
    ({ facts }) => !facts.archived && facts.status !== "closed" && (facts.replacedBy ?? null) === null && !replaced.has(facts.id),
  );
}

const newestManagerOf = async (paseo: unknown, workspaceId: string, home: string): Promise<string | null> =>
  (await findLiveManagers(paseo as ManagerPaseo, workspaceId, { home }))[0]?.id ?? null;

/** Every agent that is or was a mission's Main (its Main history) → that mission's id, the first mission in the index winning. Never throws. */
function missionIdsByMain(home: string): Map<string, string> {
  const store = createMissionStore(home);
  const byMain = new Map<string, string>();
  for (const entry of store.list()) {
    const mission = store.get(entry.missionId);
    for (const agentId of mission === null ? [] : [mission.mainId, ...mission.mainHistory.map((main) => main.agentId)]) {
      if (agentId !== null && !byMain.has(agentId)) byMain.set(agentId, entry.missionId);
    }
  }
  return byMain;
}

/** The mission `agentId` is or was the Main of (its Main history), else null. Never throws. */
export function missionOfMainAgent(home: string, agentId: string): Mission | null {
  const missionId = missionIdsByMain(home).get(agentId);
  return missionId === undefined ? null : createMissionStore(home).get(missionId);
}

/** The current Main of `missionId` when it is live, else null. Never throws. */
const liveMainOf = (home: string, missionId: string | null | undefined, live: ReadonlySet<string>): string | null => {
  const mainId = missionId == null ? null : (createMissionStore(home).get(missionId)?.mainId ?? null);
  return mainId !== null && live.has(mainId) ? mainId : null;
};

const liveIdsOf = async (paseo: unknown, home: string): Promise<Set<string>> => new Set((await liveAgentsOf(paseo, home)).map(({ facts }) => facts.id));

/**
 * The asker of a link: `from.agentId` when live and not replaced; else the
 * sole live Worker of the asking request (a successor included); else that
 * request's Manager when live; else the asking project's newest live Manager.
 * Missions design §2.6: a `mission` link's asker is then the asking mission's
 * current Main; an `ask-main` link's has no one else (its Main is the
 * answerer); no route but `project` falls back to a project's Manager. Null
 * when none. Rejects when Paseo cannot be read.
 */
export async function askerOf(link: PeerLink, paseo: unknown, home: string): Promise<string | null> {
  const { workspaceId, requestId, agentId } = link.from;
  const route = routeOf(link);
  const live = await liveIdsOf(paseo, home);
  if (live.has(agentId)) return agentId;
  if (route === "mission" || requestId === null) return liveMainOf(home, missionOfMainAgent(home, agentId)?.missionId, live);
  const worker = await soleWorkerOfRequest({ workspaceId, requestId, home }, paseo as DashboardPaseo);
  if (worker !== null) return worker;
  if (route === "ask-main") return null;
  const managerId = createRequestRegistry(home).get(workspaceId, requestId)?.managerId ?? null;
  if (managerId !== null && live.has(managerId)) return managerId;
  return route === "project" ? newestManagerOf(paseo, workspaceId, home) : null;
}

/**
 * The answering agent of a link: the sole live Worker of the request that
 * took it; else the Manager it was delivered to when live; else the answering
 * project's newest live Manager. Missions design §2.6: any other route than
 * `project` goes, after the Worker, to the current Main of the link's
 * mission (else the Main it was delivered to, when live), never to a
 * project's Manager. Null when none. Rejects when Paseo cannot be read.
 */
export async function answererOf(link: PeerLink, paseo: unknown, home: string): Promise<string | null> {
  const { workspaceId, requestId, managerId } = link.to;
  if (requestId !== null) {
    const worker = await soleWorkerOfRequest({ workspaceId, requestId, home }, paseo as DashboardPaseo);
    if (worker !== null) return worker;
  }
  if (routeOf(link) !== "project") {
    const live = await liveIdsOf(paseo, home);
    return liveMainOf(home, link.missionId, live) ?? (managerId !== null && live.has(managerId) ? managerId : null);
  }
  if (managerId !== null && (await liveAgentsOf(paseo, home)).some(({ facts }) => facts.id === managerId)) return managerId;
  return newestManagerOf(paseo, workspaceId, home);
}

/** The link a peer record names on its first line after the marker. */
const linkIdIn = (text: string): string | undefined => /^link: (peer-[0-9a-f]{12})$/m.exec(text)?.[1];

/**
 * Who a peer record goes to now (§7.17.4), for the outbox's every attempt:
 * the link is named on the record's first line. A message goes to the side
 * that did not write it: the side its link noted for the record, else the
 * side of the workspace that stores it (two Workers of one repo, or two
 * Mains of one home, share a workspace: missions design §2.6). Undefined when
 * no link is found (the stored target stands); null when its side has no
 * live agent.
 */
export async function peerTargetOf(
  workspaceId: string,
  record: Pick<OutboxRecord, "kind" | "text"> & { id?: string },
  home: string,
  paseo: unknown,
): Promise<string | null | undefined> {
  const linkId = linkIdIn(record.text);
  const link = linkId === undefined ? null : createPeerLinkStore(home).get(linkId);
  if (link === null) return undefined;
  const side = record.id === undefined ? undefined : link.messages.find((entry) => entry.recordId === record.id)?.side;
  const fromAnswerer = side === undefined ? repoKeyOf(home, workspaceId) === repoKeyOf(home, link.to.workspaceId) : side === "answerer";
  const toAsker = record.kind === "peer-reply" || (record.kind === "peer-message" && fromAnswerer);
  return toAsker ? askerOf(link, paseo, home) : answererOf(link, paseo, home);
}

/**
 * What a delivered peer record does to its link (§7.17.1): a `finished`
 * `peer-reply` that reached the asker answers it (`taken` → `answered`; an
 * `answered` link stays so, a `closed` one is left as it is). Its phase is
 * the link's note of the record, else the reply's `from:` line. Throws only
 * when the link store cannot be written.
 */
export function peerDelivered(_workspaceId: string, record: Pick<OutboxRecord, "id" | "kind" | "text">, home: string, now: () => Date = () => new Date()): void {
  if (record.kind !== "peer-reply") return;
  const linkId = linkIdIn(record.text);
  if (linkId === undefined) return;
  const links = createPeerLinkStore(home, { now });
  const link = links.get(linkId);
  if (link === null) return;
  const phase = link.messages.find((entry) => entry.recordId === record.id)?.phase ?? /^from: .*, phase: (finished|blocked|stopped)$/m.exec(record.text)?.[1] ?? null;
  if (phase === "finished") links.markAnswered(linkId);
}

// The outbox resolves every peer record's target through the links (§7.17.4), and tells them a delivery, without importing them.
usePeerTargets(peerTargetOf, peerDelivered);

// ---------------------------------------------------------------------------
// The tools.
// ---------------------------------------------------------------------------

export interface PeerToolDeps {
  /** The last Paseo handle a hook or RPC brought; null before any did. */
  paseo: () => unknown;
  /** The data folder (the endpoint's: it serves no tools without one). */
  home: () => string;
  log?: (message: string) => void;
  now?: () => Date;
  /** The notice queue deliveries go through; the plugin's shared one by default. */
  queue?: Pick<NoticeQueue, "enqueue">;
  /** The outbox's record ids and masking; tests pin them. */
  outbox?: Pick<OutboxDeps, "newId" | "env">;
  /** The link store's ids and masking; tests pin them. */
  links?: Pick<PeerLinkDeps, "newId" | "env">;
  /** Binds a Manager opened for an ask (§7.17.2). */
  binder?: () => AgentBinder;
  /** Opens a Manager in a project with none, returning its id; `createFromProfile` by default (never creates roles). */
  openManager?: (paseo: unknown, workspaceId: string) => Promise<string>;
}

export interface PeerTools {
  manager: ServerTools;
  worker: ServerTools;
}

interface AskInput {
  project: string;
  request: string;
  kind?: "work" | "question";
  context?: Array<{ fact: string; source: string }>;
}

export function createPeerTools(deps: PeerToolDeps): PeerTools {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const now = deps.now ?? (() => new Date());
  const paseoOf = (): unknown => deps.paseo() ?? null;
  const linksOf = (home: string): PeerLinkStore => createPeerLinkStore(home, { ...deps.links, now });
  const openManager =
    deps.openManager ??
    (async (paseo: unknown, workspaceId: string) =>
      (
        await createFromProfile(
          { paseo: paseo as ManagerPaseo, readInstructions: (id) => currentInstructions("manager", paseo, { workspaceId: id }), binder: deps.binder?.(), log, home: deps.home() },
          workspaceId,
          { created: [], baseProvider: null, model: null, skipped: null },
        )
      ).agentId);

  /** A bound Manager or Worker, else null. */
  const peerCaller = (caller: ToolCaller | null): BoundCaller | null => boundAs(caller, "manager") ?? boundAs(caller, "worker");
  const faceOf = (role: string, name: string): ToolFace => boundToolFacesFor(role === "manager" ? "manager" : "worker").find((face) => face.name === name)!;
  const why = (reasons: readonly string[]): ServerToolAnswer => refused([...reasons, NOTHING].join("\n"));

  /** Stores and delivers one record; a record that cannot be stored is the refusal. */
  const deliver = async (
    home: string,
    workspaceId: string,
    init: OutboxInit,
    paseo: unknown,
    before: (record: OutboxRecord) => void,
  ): Promise<ServerToolAnswer | { record: OutboxRecord; delivery: DeliveryState }> => {
    try {
      const { record, outcome } = await storeAndDeliver(workspaceId, init, outboxDepsOf(home, { ...deps, now, log }, paseo), before);
      return { record, delivery: deliveryOf(outcome) };
    } catch (error) {
      return refused(`paseo-bm could not store your ${init.kind} (${reasonOf(error)}); nothing was sent. Tell the owner in one line.`);
    }
  };

  /**
   * Stores a record that starts no turn (delivery line design §9.1: `ack`,
   * `close`): `delivered` with reason `no-turn`, never enqueued, so neither
   * the queue nor the wake gate sees it; `before` runs once it is stored. A
   * record that cannot be stored is the refusal.
   */
  const storeNoTurn = (home: string, workspaceId: string, init: OutboxInit, before: (record: OutboxRecord) => void): ServerToolAnswer | { record: OutboxRecord } => {
    let record: OutboxRecord;
    try {
      record = createOutbox(home, { ...deps.outbox, now }).add(workspaceId, { ...init, noTurn: true });
    } catch (error) {
      return refused(`paseo-bm could not store your ${init.kind} (${reasonOf(error)}); nothing was sent. Tell the owner in one line.`);
    }
    try {
      before(record);
    } catch (error) {
      log(`[paseo-bm] after storing the ${init.kind} ${record.id}: ${reasonOf(error)}`);
    }
    return { record };
  };

  /** The missions a message on `link` may name contracts of (delivery line design §9.1): the caller's, the link's, the asking Main's. */
  const refMissionsOf = (home: string, caller: BoundCaller, link: Pick<PeerLink, "missionId" | "from"> | null): Array<string | null | undefined> => [
    caller.role === "manager" ? missionOfMain(home, caller)?.missionId : caller.requestId === null ? null : (requestIndexOf(home, caller.requestId)?.missionId ?? caller.missionId),
    link?.missionId,
    link === null ? null : missionOfMainAgent(home, link.from.agentId)?.missionId,
  ];

  /**
   * An `agree` act's contracts (delivery line design §9.2), each at its
   * current version — or why one is not: a stale version ("C2 is at v4; agree
   * to C2@v4 or reply."), a superseded or withdrawn contract.
   */
  const agreementsOf = (home: string, refs: MessageRefs | undefined, missionIds: ReadonlyArray<string | null | undefined>): Array<{ missionId: string; contractId: string; version: number }> | { reasons: string[] } => {
    const found: Array<{ missionId: string; contractId: string; version: number }> = [];
    const reasons: string[] = [];
    for (const ref of refs?.contracts ?? []) {
      const resolved = resolveContractRef(home, ref, missionIds);
      if (resolved === null) continue;
      const refusal = agreementRefusalOf(resolved.contract, resolved.version);
      if (refusal !== null) reasons.push(refusal);
      else found.push({ missionId: resolved.mission.missionId, contractId: resolved.contract.id, version: resolved.version });
    }
    return reasons.length > 0 ? { reasons } : found;
  };

  /** Records an `agree` on each contract (delivery line design §9.2); one both sides agreed to becomes `agreed`, with a journal `contract` line. Never throws. */
  const recordAgreements = (home: string, agreements: ReadonlyArray<{ missionId: string; contractId: string; version: number }>, by: { side: PeerSide; agentId: string; linkId: string }): void => {
    const store = createMissionStore(home, { now });
    const at = now().toISOString();
    for (const { missionId, contractId, version } of agreements) {
      try {
        let agreed = false;
        const written = store.update(missionId, (mission) => {
          const applied = applyAgreement(mission, contractId, { side: by.side, agentId: by.agentId, version, at });
          if ("reasons" in applied) return { reasons: applied.reasons };
          agreed = applied.nowAgreed;
          return applied.mission;
        });
        if (!written.ok) log(`[paseo-bm] could not record the agreement to ${contractId}@v${version}: ${written.reasons.join("; ")}`);
        else if (agreed) journalQuietly(store, missionId, { kind: "contract", by: by.agentId, text: `${contractId} v${version} is agreed by both sides of ${by.linkId}.`, ref: contractId }, log);
      } catch (error) {
        log(`[paseo-bm] could not record the agreement to ${contractId}@v${version}: ${reasonOf(error)}`);
      }
    }
  };

  // -------------------------------------------------------------------------
  // bm_peers.
  // -------------------------------------------------------------------------

  const peers = async (raw: unknown, toolCaller: ToolCaller | null): Promise<ServerToolAnswer> => {
    const caller = peerCaller(toolCaller);
    if (caller === null) return refused(DELIVERY_NOT_BOUND_MESSAGE);
    const input = withoutNulls(raw);
    const shape = schemaIssues(faceOf(caller.role, "bm_peers").inputSchema, input);
    if (shape.length > 0) return fixThese("bm_peers", shape);
    const paseo = paseoOf();
    if (paseo === null) return refused(NO_PASEO_DELIVERY_MESSAGE);
    const home = deps.home();
    const mine = caller.workspaceId;
    // Delivery line design §3.1: projects are repos — a placement lists as none, and its own repo is the caller's.
    const keyOf = repoKeysIn(home);
    const listed = await listedWorkspaces(paseo as DashboardPaseo);
    const project = (input as { project?: string }).project;
    let only: string | null = null;
    if (project !== undefined) {
      const found = resolveProjectIn(listed, project, mine, home);
      if (!found.ok) return refused(found.reasons.join("\n"));
      only = keyOf(found.workspaceId);
    }
    // The newest live Manager of each project, from one listing.
    const managers = new Map<string, { id: string; status: string; createdAt: string | null }>();
    for (const { workspaceId, facts } of await liveAgentsOf(paseo, home)) {
      if (facts.role !== "manager" || workspaceId === null) continue;
      const known = managers.get(workspaceId);
      if (known === undefined || (facts.createdAt ?? "") > (known.createdAt ?? "")) managers.set(workspaceId, facts);
    }
    const projects = (listed ?? [])
      // The plugin's own homes are not projects (missions design §3.1).
      .filter((entry) => entry.id !== "" && !entry.archived && keyOf(entry.id) === entry.id && entry.id !== keyOf(mine) && !isPluginHomeIn(entry.id, listed, home))
      .map((entry) => {
        const manager = managers.get(entry.id);
        return { workspaceId: entry.id, title: titleIn(listed, entry.id), directory: entry.directory, manager: manager === undefined ? null : { id: manager.id, status: manager.status } };
      });
    // A Main (missions design §4): the other open missions, and its mission's links of every kind too.
    const mission = caller.role === "manager" ? missionOfMain(home, caller) : null;
    const all = linksOf(home).list();
    const store = createMissionStore(home);
    // Read once for every link: the mission each asking Main is or was the Main of.
    const byMain = mission === null ? new Map<string, string>() : missionIdsByMain(home);
    const views =
      mission === null
        ? linkViewsOf(all, mine, keyOf)
        : all
            .flatMap((link) => {
              const route = routeOf(link);
              if (route === "project") return keyOf(link.from.workspaceId) === keyOf(mine) || keyOf(link.to.workspaceId) === keyOf(mine) ? [linkViewOf(link, mine, keyOf(link.from.workspaceId) === keyOf(mine))] : [];
              const askedBy = route === "mission" ? (byMain.get(link.from.agentId) ?? null) : link.missionId;
              if (askedBy !== mission.missionId && link.missionId !== mission.missionId) return [];
              if (route !== "mission") return [linkViewOf(link, mine, route === "worker")];
              const other = store.get(askedBy === mission.missionId ? (link.missionId ?? "") : (askedBy ?? ""));
              return [{ ...linkViewOf(link, mine, askedBy === mission.missionId), mission: other?.code ?? null }];
            })
            .reverse();
    const links = views.filter((view) => only === null || view.project === only).slice(0, PEERS_LINKS_SHOWN);
    if (mission === null) return answered({ projects, links });
    const missions = store
      .list()
      .filter((entry) => entry.state === "open" && entry.missionId !== mission.missionId)
      .map((entry) => ({ code: entry.code, name: entry.name, mainId: entry.mainId, repos: entry.repos }));
    return answered({ projects, missions, links });
  };

  // -------------------------------------------------------------------------
  // bm_ask_project.
  // -------------------------------------------------------------------------

  /**
   * The answering project's Manager (§7.17.2): the newest live one with a
   * bound binding; a live one without is refused, its owner alerted to
   * replace it; none live → one is opened.
   */
  const managerOf = async (paseo: unknown, home: string, workspaceId: string, title: string): Promise<ServerToolAnswer | { id: string; opened: boolean }> => {
    const live = await findLiveManagers(paseo as ManagerPaseo, workspaceId, { home, log });
    if (live.length > 0) {
      const bindings = createBindingStore(home, { log }).list();
      const bound = live.find((manager) => liveBindingOf(bindings, manager.id, "manager") !== null);
      if (bound !== undefined) return { id: bound.id, opened: false };
      try {
        createAlertStore(home, { now }).raise(unboundManagerAlertOf({ agentId: live[0]!.id, workspaceId }));
      } catch (error) {
        log(`[paseo-bm] could not raise the outdated-agent alert of Manager ${live[0]!.id}: ${reasonOf(error)}`);
      }
      return refused(`project ${title}'s Manager is on older instructions; the owner replaces it. ${NOTHING}`);
    }
    if (await agentToolsOff(paseo)) return refused(AGENT_TOOLS_OFF_TOOL_MESSAGE);
    try {
      return { id: await openManager(paseo, workspaceId), opened: true };
    } catch (error) {
      return refused(`paseo-bm could not open a Manager in project ${title} (${withoutTokenPaths(reasonOf(error))}): the owner needs to open Beads Manager in that project once; tell them in one line. ${NOTHING}`);
    }
  };

  /**
   * Stores the `peer` record of a new link in the asker's outbox (noted on the
   * link) and delivers it; a record that cannot be stored withdraws the link:
   * an ask never delivered asks nothing.
   */
  const sendAsk = async (
    home: string,
    workspaceId: string,
    link: PeerLink,
    init: { requestId: string; from: string; to: string; text: string },
    ask: string,
    paseo: unknown,
    typed: { act?: MessageAct; refs?: MessageRefs } = { act: "ask" },
  ): Promise<ServerToolAnswer | { record: OutboxRecord; delivery: DeliveryState }> => {
    const links = linksOf(home);
    const stored = await deliver(home, workspaceId, { kind: "peer", ...init }, paseo, (record) =>
      void links.appendMessage(link.linkId, { recordId: record.id, workspaceId, side: "asker", agentId: init.from, kind: "peer", text: ask, ...typed }),
    );
    if ("ok" in stored) {
      try {
        links.closeLink(link.linkId, "asker");
      } catch (error) {
        log(`[paseo-bm] could not close the undelivered link ${link.linkId}: ${reasonOf(error)}`);
      }
    }
    return stored;
  };

  /** A Worker's ask (missions design §5): only a Worker lists `bm_ask_project`, for its own request. */
  const ask = async (raw: unknown, toolCaller: ToolCaller | null): Promise<ServerToolAnswer> => {
    const caller = boundAs(toolCaller, "worker");
    if (caller === null) return refused(DELIVERY_NOT_BOUND_MESSAGE);
    const input = withoutNulls(raw);
    const shape = schemaIssues(faceOf(caller.role, "bm_ask_project").inputSchema, input);
    if (shape.length > 0) return fixThese("bm_ask_project", shape);
    const { project, request, kind = "work", context = [] } = input as AskInput;
    const home = deps.home();
    // The binding is the authority for a Worker's request (§7.15).
    if (caller.requestId === null) return refused(`paseo-bm does not know your request, so it cannot ask for it; tell the owner in one line. ${NOTHING}`);
    const requestId = caller.requestId;
    // Missions design §5: the roster says whether the request is a mission's (the binding's is a cache).
    const missionId = requestIndexOf(home, requestId)?.missionId ?? caller.missionId ?? null;
    const mission: Mission | null = missionId === null ? null : createMissionStore(home).get(missionId);
    const paseo = paseoOf();
    if (paseo === null) return refused(NO_PASEO_DELIVERY_MESSAGE);
    const listed = await listedWorkspaces(paseo as DashboardPaseo);
    const resolved = resolveProjectIn(listed, project, caller.workspaceId, home);
    if (!resolved.ok) return why(resolved.reasons);
    // Delivery line design §3.1: the link asks the repo; a placement's own repo is itself.
    const target = { ...resolved, workspaceId: repoKeyOf(home, resolved.workspaceId) };
    if (target.workspaceId === repoKeyOf(home, caller.workspaceId)) return why([`project ${JSON.stringify(project)} is your own workspace; ask another project`]);
    const links = linksOf(home);
    const from = { workspaceId: caller.workspaceId, requestId, agentId: caller.agentId, role: "worker" as const };
    const route = mission === null ? "project" : "ask-main";
    // The bounds first (§7.17.6): nothing is opened for an ask the chain refuses.
    const bounds = chainFor(links.list(), from, target.workspaceId, route, repoKeysIn(home));
    if (!bounds.ok) return why(bounds.reasons);
    const title = titleIn(listed, target.workspaceId);
    let manager: { id: string; opened: boolean };
    if (mission === null) {
      const found = await managerOf(paseo, home, target.workspaceId, title);
      if ("ok" in found) return found;
      manager = found;
    } else {
      // Never another project's Manager, and none is opened: the Worker's own Main routes it.
      if (mission.mainId === null) return why([`your mission ${mission.code} has no Main right now; try again in a moment`]);
      manager = { id: mission.mainId, opened: false };
    }
    const created = links.createLink({
      kind,
      ...(mission === null ? {} : { route, missionId: mission.missionId }),
      from,
      to: { workspaceId: target.workspaceId, managerId: manager.id },
      text: request,
    });
    if (!created.ok) return why(created.reasons);
    const link = created.link;
    const own = titleIn(listed, caller.workspaceId);
    const text = mission === null ? peerAskText({ link, title: own, text: request, context }) : askMainText({ link, title: own, targetTitle: title, text: request, context });
    const stored = await sendAsk(home, caller.workspaceId, link, { requestId, from: caller.agentId, to: manager.id, text }, request, paseo);
    if ("ok" in stored) return stored;
    return answered({ linkId: link.linkId, project: target.workspaceId, managerId: manager.id, delivery: stored.delivery, openedManager: manager.opened });
  };

  // -------------------------------------------------------------------------
  // bm_peer_reply.
  // -------------------------------------------------------------------------

  /**
   * The caller's side of `link`, or null when it is no party (§7.17.3): the
   * asker, a Worker of the asking request or that request's Manager; or the
   * answering project's Manager, or a Worker of the request that took it.
   * Missions design §2.6: the answering side of an `ask-main` or `mission`
   * link is the current Main of its mission, and the asking side of a
   * `mission` link the asking mission's current Main; a `worker` link has
   * only its two Workers.
   */
  const sideOf = (link: PeerLink, caller: BoundCaller, home: string): PeerSide | null => {
    if (caller.agentId === link.from.agentId) return "asker";
    if (caller.role === "worker") {
      if (caller.workspaceId === link.from.workspaceId && caller.requestId === link.from.requestId) return "asker";
      return repoKeyOf(home, caller.workspaceId) === repoKeyOf(home, link.to.workspaceId) && link.to.requestId !== null && caller.requestId === link.to.requestId ? "answerer" : null;
    }
    const route = routeOf(link);
    if (route === "project") {
      if (caller.workspaceId === link.from.workspaceId) {
        return link.from.requestId !== null && createRequestRegistry(home, { log }).get(link.from.workspaceId, link.from.requestId)?.managerId === caller.agentId ? "asker" : null;
      }
      return repoKeyOf(home, caller.workspaceId) === repoKeyOf(home, link.to.workspaceId) ? "answerer" : null;
    }
    const mission = route === "worker" ? null : missionOfMain(home, caller);
    if (mission === null) return null;
    if (mission.missionId === link.missionId) return "answerer";
    return route === "mission" && missionOfMainAgent(home, link.from.agentId)?.missionId === mission.missionId ? "asker" : null;
  };

  const reply = async (raw: unknown, toolCaller: ToolCaller | null): Promise<ServerToolAnswer> => {
    const caller = peerCaller(toolCaller);
    if (caller === null) return refused(DELIVERY_NOT_BOUND_MESSAGE);
    const input = withoutNulls(raw);
    const shape = schemaIssues(faceOf(caller.role, "bm_peer_reply").inputSchema, input);
    if (shape.length > 0) return fixThese("bm_peer_reply", shape);
    const { linkId, text, close = false, act: given, refs } = input as { linkId: string; text: string; close?: boolean; act?: MessageAct; refs?: MessageRefs };
    if (close && given !== undefined && given !== "close") return fixThese("bm_peer_reply", [`input.close: close: true is act close; give act ${given} or close, not both`]);
    const home = deps.home();
    const links = linksOf(home);
    const link = links.get(linkId);
    if (link === null) return refused(`unknown link ${linkId}; bm_peers lists this project's links. ${NOTHING}`);
    if (link.state === "closed") return refused(`link ${linkId} is closed. ${NOTHING}`);
    const side = sideOf(link, caller, home);
    if (side === null) {
      return refused(`you are not a party to link ${linkId}: only the request that asked it, its Manager, and the project it asks write on it. ${NOTHING}`);
    }
    // Delivery line design §9.1: the act, by default an answer from the answering side and an ask from the asker.
    const act: MessageAct = close ? "close" : (given ?? (side === "answerer" ? "answer" : "ask"));
    const missions = refMissionsOf(home, caller, link);
    const invalid = [...actRefusals(act, refs), ...refsRefusals(home, refs, missions)];
    if (invalid.length > 0) return why(invalid);
    const agreements = act === "agree" ? agreementsOf(home, refs, missions) : [];
    if ("reasons" in agreements) return why(agreements.reasons);
    const paseo = paseoOf();
    if (paseo === null) return refused(NO_PASEO_DELIVERY_MESSAGE);
    // The caller's request; the answering Manager's on a link no request took yet is the link itself (§7.17.3).
    const requestId = caller.role === "worker" ? caller.requestId! : ((side === "asker" ? link.from.requestId : link.to.requestId) ?? link.linkId);
    // The target known now; the outbox resolves it again before the send (§7.17.4).
    const to = (side === "asker" ? (link.to.workerId ?? link.to.managerId) : link.from.agentId) ?? (await answererOf(link, paseo, home));
    if (to === null) return refused(`no live agent is left on the other side of link ${linkId}. ${NOTHING}`);
    const listed = await listedWorkspaces(paseo as DashboardPaseo);
    const closing = act === "close";
    const message = peerMessageText({ linkId, title: titleIn(listed, caller.workspaceId), workspaceId: caller.workspaceId, role: caller.role, agentId: caller.agentId, text, closed: closing, act, ...(refs === undefined ? {} : { refs }) });
    const init: OutboxInit = { kind: "peer-message", requestId, from: caller.agentId, to, text: message };
    const settled: SettledWait[] = [];
    const before = (record: OutboxRecord): void => {
      links.appendMessage(linkId, { recordId: record.id, workspaceId: caller.workspaceId, side, agentId: caller.agentId, kind: "peer-message", text, act, ...(refs === undefined ? {} : { refs }) });
      if (closing) links.closeLink(linkId, side);
      recordAgreements(home, agreements, { side, agentId: caller.agentId, linkId });
      // Delivery line design §6.3: a word from the answering side, or the link closed, settles the asker's wait on it; an ack answers nothing (§9.1).
      const at = now().toISOString();
      if (act !== "ack") settled.push(...settleLinkWait(home, link, { kind: "message", side, text }, at, log));
      if (closing) settled.push(...settleLinkWait(home, link, { kind: "closed", by: side }, at, log));
    };
    if (NO_TURN_ACTS.includes(act)) {
      // Delivery line design §9.1: an ack or a close starts no turn; a wait its close met wakes its Worker with the fact (no delivery carries it).
      const stored = storeNoTurn(home, caller.workspaceId, init, before);
      if ("ok" in stored) return stored;
      await releaseSettledWaits(home, settled, outboxDepsOf(home, { ...deps, now, log }, paseo));
      return answered({ recordId: stored.record.id, to, delivery: "no-turn", state: links.get(linkId)?.state ?? link.state, note: noTurnEffect({ what: `Your ${act}`, to }).sentence });
    }
    const stored = await deliver(home, caller.workspaceId, init, paseo, before);
    if ("ok" in stored) return stored;
    const sent = createOutbox(home).list(caller.workspaceId).find((record) => record.id === stored.record.id) ?? stored.record;
    return answered({ recordId: stored.record.id, to: sent.to, delivery: stored.delivery, state: links.get(linkId)?.state ?? link.state });
  };

  // -------------------------------------------------------------------------
  // A Main's links (missions design §4, §5).
  // -------------------------------------------------------------------------

  /** The caller as the current Main of a mission, or its refusal. */
  const mainOf = (toolCaller: ToolCaller | null, home: string): { main: BoundCaller; mission: Mission } | ServerToolAnswer => {
    const main = boundAs(toolCaller, "manager");
    if (main === null) return refused(DELIVERY_NOT_BOUND_MESSAGE);
    const mission = missionOfMain(home, main);
    return mission === null ? refused(`You are not the Main of a mission: only a Main links its Workers or asks another mission. ${NOTHING}`) : { main, mission };
  };

  const linkWorkers = async (raw: unknown, toolCaller: ToolCaller | null): Promise<ServerToolAnswer> => {
    const home = deps.home();
    const found = mainOf(toolCaller, home);
    if ("ok" in found) return found;
    const { main, mission } = found;
    const input = withoutNulls(raw);
    const shape = schemaIssues(faceOf("manager", "bm_link_workers").inputSchema, input);
    if (shape.length > 0) return fixThese("bm_link_workers", shape);
    const { requestIds, topic, refs } = input as { requestIds: [string, string]; topic: string; refs?: MessageRefs };
    if (requestIds[0] === requestIds[1]) return fixThese("bm_link_workers", ["input.requestIds: name two different requests"]);
    // Delivery line design §9.1: every id it names exists.
    const unknown = refsRefusals(home, refs, [mission.missionId]);
    if (unknown.length > 0) return why(unknown);
    const paseo = paseoOf();
    if (paseo === null) return refused(NO_PASEO_DELIVERY_MESSAGE);
    // Both live requests of the caller's mission, each with its live Worker.
    const roster = createMissionRoster(home);
    const registry = createRequestRegistry(home, { log });
    const reasons: string[] = [];
    const sides: Array<{ workspaceId: string; requestId: string; workerId: string }> = [];
    for (const [index, requestId] of requestIds.entries()) {
      const entry = roster.get(mission.missionId, requestId);
      if (entry === null) {
        reasons.push(`input.requestIds[${index}]: ${requestId} is not a request of mission ${mission.code} (bm_mission lists them)`);
        continue;
      }
      const running = entry.state === "active" && (registry.get(entry.workspaceId, requestId)?.finishedAt ?? null) === null;
      const workerId = running ? await soleWorkerOfRequest({ workspaceId: entry.workspaceId, requestId, home }, paseo as DashboardPaseo) : null;
      if (workerId === null) reasons.push(`input.requestIds[${index}]: request ${requestId} has no live Worker`);
      else sides.push({ workspaceId: entry.workspaceId, requestId, workerId });
    }
    if (reasons.length > 0) return why(reasons);
    const [a, b] = sides as [(typeof sides)[number], (typeof sides)[number]];
    const links = linksOf(home);
    const all = links.list();
    const holds = (link: PeerLink, side: typeof a, end: "from" | "to") => link[end].workspaceId === side.workspaceId && link[end].requestId === side.requestId;
    const between = all.find((link) => isLiveLink(link) && ((holds(link, a, "from") && holds(link, b, "to")) || (holds(link, b, "from") && holds(link, a, "to"))));
    if (between !== undefined) return why([`requests ${a.requestId} and ${b.requestId} have a live link already: ${between.linkId}`]);
    // An open ask one of them made its Main becomes the link, taken by the other (§5).
    const asked = all.filter((link) => routeOf(link) === "ask-main" && link.state === "open" && link.missionId === mission.missionId && (holds(link, a, "from") || holds(link, b, "from"))).at(-1);
    const result =
      asked === undefined
        ? links.createLink({
            kind: "work",
            route: "worker",
            missionId: mission.missionId,
            from: { workspaceId: a.workspaceId, requestId: a.requestId, agentId: a.workerId, role: "worker" },
            to: { workspaceId: b.workspaceId, managerId: main.agentId, requestId: b.requestId, workerId: b.workerId },
            text: topic,
          })
        : links.turnToWorker(asked.linkId, { ...(holds(asked, a, "from") ? b : a), managerId: main.agentId });
    if (!result.ok) return why(result.reasons);
    const link = result.link;
    const listed = await listedWorkspaces(paseo as DashboardPaseo);
    const delivery: Record<string, DeliveryState> = {};
    for (const [self, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const text = linkIntroText({ linkId: link.linkId, workerId: other.workerId, title: titleIn(listed, other.workspaceId), requestId: other.requestId, topic, ...(refs === undefined ? {} : { refs }) });
      const stored = await deliver(home, self.workspaceId, { kind: "peer-message", requestId: self.requestId, from: main.agentId, to: self.workerId, text }, paseo, () => {});
      if ("ok" in stored) return stored;
      delivery[self.requestId] = stored.delivery;
    }
    const text = `The Main linked request ${a.requestId} (${a.workspaceId}) with ${b.requestId} (${b.workspaceId}) on ${link.linkId}: ${topic}`;
    journalQuietly(createMissionStore(home, { now }), mission.missionId, { kind: "link", by: main.agentId, text, ref: link.linkId }, log);
    return answered({ linkId: link.linkId, delivery });
  };

  const askMission = async (raw: unknown, toolCaller: ToolCaller | null): Promise<ServerToolAnswer> => {
    const home = deps.home();
    const found = mainOf(toolCaller, home);
    if ("ok" in found) return found;
    const { main, mission } = found;
    const input = withoutNulls(raw);
    const shape = schemaIssues(faceOf("manager", "bm_ask_mission").inputSchema, input);
    if (shape.length > 0) return fixThese("bm_ask_mission", shape);
    const { mission: code, text, kind = "work", act = "ask", refs } = input as { mission: string; text: string; kind?: "work" | "question"; act?: MessageAct; refs?: MessageRefs };
    // Delivery line design §9.1: a new link asks, agrees, supersedes or notes (ack); an answer or a close needs a link, on bm_peer_reply.
    if (act === "answer" || act === "close") return fixThese("bm_ask_mission", [`input.act: ${act} is for a link that exists; use bm_peer_reply on it`]);
    const entry = createMissionStore(home).byCode(code);
    if (entry === null) return why([`unknown mission ${code} (bm_peers lists the missions)`]);
    if (entry.missionId === mission.missionId) return why([`mission ${code} is your own; ask your Workers, or link them with bm_link_workers`]);
    if (entry.state !== "open") return why([`mission ${code} is closed`]);
    if (entry.mainId === null) return why([`mission ${code} has no Main right now; try again in a moment`]);
    const missions = [mission.missionId, entry.missionId];
    const invalid = [...actRefusals(act, refs), ...refsRefusals(home, refs, missions)];
    if (invalid.length > 0) return why(invalid);
    const agreements = act === "agree" ? agreementsOf(home, refs, missions) : [];
    if ("reasons" in agreements) return why(agreements.reasons);
    const paseo = paseoOf();
    if (paseo === null) return refused(NO_PASEO_DELIVERY_MESSAGE);
    const mainId = entry.mainId;
    const links = linksOf(home);
    const created = links.createLink({
      kind,
      route: "mission",
      missionId: entry.missionId,
      from: { workspaceId: main.workspaceId, requestId: null, agentId: main.agentId, role: "manager" },
      to: { workspaceId: liveBindingOf(createBindingStore(home, { log }).list(), mainId, "manager")?.workspaceId ?? main.workspaceId, managerId: mainId },
      text,
    });
    if (!created.ok) return why(created.reasons);
    const link = created.link;
    const message = missionAskText({ link, code: mission.code, name: mission.name, text, act, ...(refs === undefined ? {} : { refs }) });
    const typed = { act, ...(refs === undefined ? {} : { refs }) };
    // No asking request: the record is kept under the link id (§7.17.3).
    const init = { requestId: link.linkId, from: main.agentId, to: mainId, text: message };
    if (act === "ack") {
      // Delivery line design §9.1: a note that needs no answer opens the link and starts no turn.
      const noted = storeNoTurn(home, main.workspaceId, { kind: "peer", ...init }, (record) => void links.appendMessage(link.linkId, { recordId: record.id, workspaceId: main.workspaceId, side: "asker", agentId: main.agentId, kind: "peer", text, ...typed }));
      if ("ok" in noted) {
        links.closeLink(link.linkId, "asker");
        return noted;
      }
      return answered({ linkId: link.linkId, mission: entry.code, mainId, delivery: "no-turn", note: noTurnEffect({ what: "Your ack", to: mainId }).sentence });
    }
    const stored = await sendAsk(home, main.workspaceId, link, init, text, paseo, typed);
    if ("ok" in stored) return stored;
    recordAgreements(home, agreements, { side: "asker", agentId: main.agentId, linkId: link.linkId });
    return answered({ linkId: link.linkId, mission: entry.code, mainId, delivery: stored.delivery });
  };

  const runs = { bm_peers: peers, bm_ask_project: ask, bm_peer_reply: reply, bm_link_workers: linkWorkers, bm_ask_mission: askMission };
  // A role runs only the tools it lists: a Main has no bm_ask_project (owner, 2026-10-10).
  const toolsOf = (role: "manager" | "worker"): ServerTools => {
    const faces = boundToolFacesFor(role).filter((face) => Object.hasOwn(runs, face.name));
    return actingTools(faces, Object.fromEntries(faces.map((face) => [face.name, runs[face.name as keyof typeof runs]])), "Nothing was stored or sent");
  };
  return { manager: toolsOf("manager"), worker: toolsOf("worker") };
}
