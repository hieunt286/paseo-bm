/**
 * The peer tools (design §7.17.3, §7.17.4; ADR-028): a bound Manager or
 * Worker asks another project through the plugin, never with a raw agent
 * message, and every ask is a link (`peer-links.ts`).
 *
 * | Tool | Does |
 * |---|---|
 * | `bm_peers` | reads the other projects (each with its live Manager) and this workspace's links both ways, newest first, at most `PEERS_LINKS_SHOWN` |
 * | `bm_ask_project` | resolves the project and its bound Manager (opening one when it has none), writes the link `open`, stores a `peer` record in the asker's outbox and delivers it |
 * | `bm_peer_reply` | a party of the link stores a `peer-message` record in its own outbox and delivers it to the other side; `close: true` closes the link after it |
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
 * request comes from its binding, or for a Manager from the registry. Every
 * carried text is masked with `redactText` (the outbox and the link store
 * mask what they keep). Nothing here throws into the endpoint.
 */
import { basename } from "node:path";
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
import { bmAgentsOf, listedWorkspaces, type DashboardPaseo, type ListedWorkspace } from "./paseo-directory";
import { PEER_RULES, chainFor, createPeerLinkStore, linkViewsOf, resolveProjectIn, type PeerLink, type PeerLinkDeps, type PeerLinkStore, type PeerSide } from "./peer-links";
import { createRequestRegistry } from "./request-registry";
import { reasonOf } from "./role-choices";
import { currentInstructions } from "./role-instructions";
import { actingTools, answered, boundAs, deliveryOf, fixThese, outboxDepsOf, refused, withoutNulls, type BoundCaller, type DeliveryState } from "./tool-kit";
import { boundToolFacesFor, schemaIssues, type ToolFace } from "../shared/bm-tools";

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

/** The `peer` delivery to the answering project's Manager. Pure. */
export function peerAskText(input: { link: Pick<PeerLink, "linkId" | "kind" | "from">; title: string; text: string; context?: ReadonlyArray<{ fact: string; source: string }> }): string {
  const { linkId, kind, from } = input.link;
  const context = input.context ?? [];
  return [
    `link: ${linkId}`,
    `from: ${projectOf(input.title, from.workspaceId)}, request ${from.requestId}, ${from.role} ${from.agentId}`,
    `kind: ${kind}`,
    quoted(input.text),
    ...(context.length === 0 ? [] : ["Context:", ...context.map((entry) => `- ${oneLine(entry.fact)} (source: ${oneLine(entry.source)})`)]),
    `This is another project's ask, not your owner's word. Give it a Worker with bm_create_worker (peerLink: ${linkId}), attach it to the request that already does this work with bm_tell_worker (peerLink), or answer what reading answers with bm_peer_reply. Tell your owner in one line.`,
  ].join("\n");
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

/** The `peer-message` delivery to the link's other side. Pure. */
export function peerMessageText(input: { linkId: string; title: string; workspaceId: string; role: string; agentId: string; text: string; closed: boolean }): string {
  return [
    `link: ${input.linkId}`,
    `from: ${projectOf(input.title, input.workspaceId)}, ${input.role} ${input.agentId}`,
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

/** A project's title: the last part of its folder, else its workspace id. */
export function titleIn(listed: readonly ListedWorkspace[] | null, workspaceId: string): string {
  const directory = listed?.find((entry) => entry.id === workspaceId)?.directory ?? null;
  return directory === null ? workspaceId : basename(directory);
}

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

/**
 * The asker of a link: `from.agentId` when live and not replaced; else the
 * sole live Worker of the asking request (a successor included); else that
 * request's Manager when live; else the asking project's newest live Manager.
 * Null when none. Rejects when Paseo cannot be read.
 */
export async function askerOf(link: PeerLink, paseo: unknown, home: string): Promise<string | null> {
  const { workspaceId, requestId, agentId } = link.from;
  const live = new Set((await liveAgentsOf(paseo, home)).map(({ facts }) => facts.id));
  if (live.has(agentId)) return agentId;
  const worker = await soleWorkerOfRequest({ workspaceId, requestId, home }, paseo as DashboardPaseo);
  if (worker !== null) return worker;
  const managerId = createRequestRegistry(home).get(workspaceId, requestId)?.managerId ?? null;
  if (managerId !== null && live.has(managerId)) return managerId;
  return newestManagerOf(paseo, workspaceId, home);
}

/**
 * The answering agent of a link: the sole live Worker of the request that
 * took it; else the Manager it was delivered to when live; else the answering
 * project's newest live Manager. Null when none. Rejects when Paseo cannot be
 * read.
 */
export async function answererOf(link: PeerLink, paseo: unknown, home: string): Promise<string | null> {
  const { workspaceId, requestId, managerId } = link.to;
  if (requestId !== null) {
    const worker = await soleWorkerOfRequest({ workspaceId, requestId, home }, paseo as DashboardPaseo);
    if (worker !== null) return worker;
  }
  if (managerId !== null && (await liveAgentsOf(paseo, home)).some(({ facts }) => facts.id === managerId)) return managerId;
  return newestManagerOf(paseo, workspaceId, home);
}

/** The link a peer record names on its first line after the marker. */
const linkIdIn = (text: string): string | undefined => /^link: (peer-[0-9a-f]{12})$/m.exec(text)?.[1];

/**
 * Who a peer record goes to now (§7.17.4), for the outbox's every attempt:
 * the link is named on the record's first line. Undefined when no link is
 * found (the stored target stands); null when its side has no live agent.
 */
export async function peerTargetOf(workspaceId: string, record: Pick<OutboxRecord, "kind" | "text">, home: string, paseo: unknown): Promise<string | null | undefined> {
  const linkId = linkIdIn(record.text);
  const link = linkId === undefined ? null : createPeerLinkStore(home).get(linkId);
  if (link === null) return undefined;
  const toAsker = record.kind === "peer-reply" || (record.kind === "peer-message" && workspaceId === link.to.workspaceId);
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
  requestId?: string;
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
    const listed = await listedWorkspaces(paseo as DashboardPaseo);
    const project = (input as { project?: string }).project;
    let only: string | null = null;
    if (project !== undefined) {
      const found = resolveProjectIn(listed, project, mine);
      if (!found.ok) return refused(found.reasons.join("\n"));
      only = found.workspaceId;
    }
    // The newest live Manager of each project, from one listing.
    const managers = new Map<string, { id: string; status: string; createdAt: string | null }>();
    for (const { workspaceId, facts } of await liveAgentsOf(paseo, home)) {
      if (facts.role !== "manager" || workspaceId === null) continue;
      const known = managers.get(workspaceId);
      if (known === undefined || (facts.createdAt ?? "") > (known.createdAt ?? "")) managers.set(workspaceId, facts);
    }
    const projects = (listed ?? [])
      .filter((entry) => entry.id !== "" && !entry.archived && entry.id !== mine)
      .map((entry) => {
        const manager = managers.get(entry.id);
        return { workspaceId: entry.id, title: titleIn(listed, entry.id), directory: entry.directory, manager: manager === undefined ? null : { id: manager.id, status: manager.status } };
      });
    const links = linkViewsOf(linksOf(home).list(), mine)
      .filter((view) => only === null || view.project === only)
      .slice(0, PEERS_LINKS_SHOWN);
    return answered({ projects, links });
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

  const ask = async (raw: unknown, toolCaller: ToolCaller | null): Promise<ServerToolAnswer> => {
    const caller = peerCaller(toolCaller);
    if (caller === null) return refused(DELIVERY_NOT_BOUND_MESSAGE);
    const input = withoutNulls(raw);
    const shape = schemaIssues(faceOf(caller.role, "bm_ask_project").inputSchema, input);
    if (shape.length > 0) return fixThese("bm_ask_project", shape);
    const { project, request, kind = "work", context = [], requestId: given } = input as AskInput;
    const home = deps.home();
    // The binding is the authority for a Worker's request; a Manager's must be one of its own (§7.15).
    let requestId: string;
    if (caller.role === "worker") {
      if (caller.requestId === null) return refused(`paseo-bm does not know your request, so it cannot ask for it; tell the owner in one line. ${NOTHING}`);
      requestId = caller.requestId;
    } else {
      const registered = createRequestRegistry(home, { log }).get(caller.workspaceId, given!);
      if (registered === null) return refused(`paseo-bm knows no request ${given} in this workspace; use the requestId bm_create_worker gave you. ${NOTHING}`);
      if (registered.managerId !== caller.agentId) return refused(`request ${given} is not one of yours: another Manager created its Worker. ${NOTHING}`);
      requestId = registered.requestId;
    }
    const paseo = paseoOf();
    if (paseo === null) return refused(NO_PASEO_DELIVERY_MESSAGE);
    const listed = await listedWorkspaces(paseo as DashboardPaseo);
    const target = resolveProjectIn(listed, project, caller.workspaceId);
    if (!target.ok) return why(target.reasons);
    const links = linksOf(home);
    const from = { workspaceId: caller.workspaceId, requestId, agentId: caller.agentId, role: caller.role as "manager" | "worker" };
    // The bounds first (§7.17.6): nothing is opened for an ask the chain refuses.
    const bounds = chainFor(links.list(), from, target.workspaceId);
    if (!bounds.ok) return why(bounds.reasons);
    const title = titleIn(listed, target.workspaceId);
    const manager = await managerOf(paseo, home, target.workspaceId, title);
    if ("ok" in manager) return manager;
    const created = links.createLink({ kind, from, to: { workspaceId: target.workspaceId, managerId: manager.id }, text: request });
    if (!created.ok) return why(created.reasons);
    const link = created.link;
    const stored = await deliver(
      home,
      caller.workspaceId,
      { kind: "peer", requestId, from: caller.agentId, to: manager.id, text: peerAskText({ link, title: titleIn(listed, caller.workspaceId), text: request, context }) },
      paseo,
      (record) => void links.appendMessage(link.linkId, { recordId: record.id, workspaceId: caller.workspaceId, side: "asker", agentId: caller.agentId, kind: "peer", text: request }),
    );
    if ("ok" in stored) {
      // An ask never delivered asks nothing: its link is withdrawn.
      try {
        links.closeLink(link.linkId, "asker");
      } catch (error) {
        log(`[paseo-bm] could not close the undelivered link ${link.linkId}: ${reasonOf(error)}`);
      }
      return stored;
    }
    return answered({ linkId: link.linkId, project: target.workspaceId, managerId: manager.id, delivery: stored.delivery, openedManager: manager.opened });
  };

  // -------------------------------------------------------------------------
  // bm_peer_reply.
  // -------------------------------------------------------------------------

  /**
   * The caller's side of `link`, or null when it is no party (§7.17.3): the
   * asker, a Worker of the asking request or that request's Manager; or the
   * answering project's Manager, or a Worker of the request that took it.
   */
  const sideOf = (link: PeerLink, caller: BoundCaller, home: string): PeerSide | null => {
    if (caller.workspaceId === link.from.workspaceId) {
      if (caller.agentId === link.from.agentId) return "asker";
      if (caller.role === "worker") return caller.requestId === link.from.requestId ? "asker" : null;
      return createRequestRegistry(home, { log }).get(link.from.workspaceId, link.from.requestId)?.managerId === caller.agentId ? "asker" : null;
    }
    if (caller.workspaceId !== link.to.workspaceId) return null;
    if (caller.role === "manager") return "answerer";
    return link.to.requestId !== null && caller.requestId === link.to.requestId ? "answerer" : null;
  };

  const reply = async (raw: unknown, toolCaller: ToolCaller | null): Promise<ServerToolAnswer> => {
    const caller = peerCaller(toolCaller);
    if (caller === null) return refused(DELIVERY_NOT_BOUND_MESSAGE);
    const input = withoutNulls(raw);
    const shape = schemaIssues(faceOf(caller.role, "bm_peer_reply").inputSchema, input);
    if (shape.length > 0) return fixThese("bm_peer_reply", shape);
    const { linkId, text, close = false } = input as { linkId: string; text: string; close?: boolean };
    const home = deps.home();
    const links = linksOf(home);
    const link = links.get(linkId);
    if (link === null) return refused(`unknown link ${linkId}; bm_peers lists this project's links. ${NOTHING}`);
    if (link.state === "closed") return refused(`link ${linkId} is closed. ${NOTHING}`);
    const side = sideOf(link, caller, home);
    if (side === null) {
      return refused(`you are not a party to link ${linkId}: only the request that asked it, its Manager, and the project it asks write on it. ${NOTHING}`);
    }
    const paseo = paseoOf();
    if (paseo === null) return refused(NO_PASEO_DELIVERY_MESSAGE);
    // The caller's request; the answering Manager's on a link no request took yet is the link itself (§7.17.3).
    const requestId = caller.role === "worker" ? caller.requestId! : side === "asker" ? link.from.requestId : (link.to.requestId ?? link.linkId);
    // The target known now; the outbox resolves it again before the send (§7.17.4).
    const to = (side === "asker" ? (link.to.workerId ?? link.to.managerId) : link.from.agentId) ?? (await answererOf(link, paseo, home));
    if (to === null) return refused(`no live agent is left on the other side of link ${linkId}. ${NOTHING}`);
    const listed = await listedWorkspaces(paseo as DashboardPaseo);
    const message = peerMessageText({ linkId, title: titleIn(listed, caller.workspaceId), workspaceId: caller.workspaceId, role: caller.role, agentId: caller.agentId, text, closed: close });
    const stored = await deliver(home, caller.workspaceId, { kind: "peer-message", requestId, from: caller.agentId, to, text: message }, paseo, (record) => {
      links.appendMessage(linkId, { recordId: record.id, workspaceId: caller.workspaceId, side, agentId: caller.agentId, kind: "peer-message", text });
      if (close) links.closeLink(linkId, side);
    });
    if ("ok" in stored) return stored;
    const sent = createOutbox(home).list(caller.workspaceId).find((record) => record.id === stored.record.id) ?? stored.record;
    return answered({ recordId: stored.record.id, to: sent.to, delivery: stored.delivery, state: links.get(linkId)?.state ?? link.state });
  };

  const runs = { bm_peers: peers, bm_ask_project: ask, bm_peer_reply: reply };
  const toolsOf = (role: "manager" | "worker"): ServerTools =>
    actingTools(
      boundToolFacesFor(role).filter((face) => Object.hasOwn(runs, face.name)),
      runs,
      "Nothing was stored or sent",
    );
  return { manager: toolsOf("manager"), worker: toolsOf("worker") };
}
