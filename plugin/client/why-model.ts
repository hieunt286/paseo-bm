/**
 * Work → request → Why? (autonomy design §E.2; change-011 C7): what the view
 * of the chain behind a request shows, without a renderer. `why.tsx` reads
 * `links.why` and draws it.
 *
 * - **In order**: Decisions → Beads → Changes → Checks → Reviews → Turns. Each
 *   is `found`, `none` (absent: never expected, and the chain says why) or
 *   `missing` (expected and not found, with its reason).
 * - **Supersession** reads "replaced by": a decision a later one superseded,
 *   a standing answer a newer one replaced, a bead split into another
 *   (`Split-from:`), a Worker that handed over or was replaced.
 * - **Checks and claims** carry the labels of `verification-view.ts`.
 * - **Turns** per agent — role, count, first → last — not a second timeline:
 *   the request's card already has one.
 * - **Unknown is never zero**: a missing verdict, blocking count or title says
 *   so.
 * - **Ids only under Details**: decision, bead, agent and batch ids, paths and
 *   commit hashes. The body names things by their text or their role.
 *
 * It is read when the view opens and on Refresh, never on Work's poll
 * (`WHY_QUERY_OPTIONS`).
 *
 * Pure: no React, no React Native, no JSX.
 */
import type { LinksWhyOutput, WhyChain, WhyEdge } from "../shared/contracts";
import { plural, shorten } from "../shared/text";
import { ago, confidenceSuffix, excerptLine, localTimeText } from "./format";
import type { Tone } from "./tone";
import { FINISHED_UNVERIFIED_CHIP, checkLabelText, claimCountsText } from "./verification-view";

/** The view's query key: under Work's, beside no key Work's requests invalidate or poll. */
export const whyQueryKey = (workspaceId: string, requestId: string) => ["paseo-bm", "work", "why", workspaceId, requestId] as const;

/**
 * How the view reads `links.why`: once when it opens (`refetchOnMount`, and
 * forgotten when it closes), again only on Refresh (`refetch`) — never on an
 * interval, a window focus or a reconnect, and never on Work's 10 s poll.
 */
export const WHY_QUERY_OPTIONS = {
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: 0,
  refetchInterval: false,
  refetchOnMount: "always",
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  retry: false,
} as const;

export const WHY_TITLE = "Why?";
export const WHY_NOTE = "What this request asked, decided, changed and proved, as the stores record it.";

export type WhySectionKey = "decisions" | "beads" | "changes" | "checks" | "reviews" | "turns";

/** The chain's links, in order. */
export const WHY_SECTIONS: ReadonlyArray<{ key: WhySectionKey; title: string }> = [
  { key: "decisions", title: "Decisions" },
  { key: "beads", title: "Beads" },
  { key: "changes", title: "Changes" },
  { key: "checks", title: "Checks" },
  { key: "reviews", title: "Reviews" },
  { key: "turns", title: "Turns" },
];

export interface WhyLine {
  key: string;
  text: string;
  tone: Tone;
}

export interface WhySection {
  key: WhySectionKey;
  title: string;
  status: "found" | "absent" | "missing";
  /** `found`, `none`, `missing`. */
  statusText: string;
  statusTone: Tone;
  /** Why it is absent or missing; null when found. */
  reason: string | null;
  lines: WhyLine[];
  accessibilityLabel: string;
}

export interface WhyView {
  title: string;
  /** `Finished · Medium · asked 2 h ago`. */
  meta: string;
  notices: string[];
  sections: WhySection[];
  /** Ids, for Details only. */
  details: string[];
  accessibilityLabel: string;
}

export type WhyState =
  | { kind: "loading" }
  | { kind: "error"; text: string }
  | { kind: "empty"; text: string }
  /** `error`: the last Refresh failed; the chain shown is the one read before. */
  | { kind: "ready"; view: WhyView; error: string | null };

const STATUS: Readonly<Record<WhySection["status"], { text: string; tone: Tone }>> = {
  found: { text: "found", tone: "success" },
  absent: { text: "none", tone: "muted" },
  missing: { text: "missing", tone: "warning" },
};

const STATE_TEXT: Readonly<Record<WhyChain["request"]["state"], string | null>> = {
  running: "Running",
  waiting_user: "Waiting for you",
  completed: "Finished",
  stopped: "Stopped",
  failed: "Failed",
  unknown: null,
};

type Decision = WhyChain["decisions"]["items"][number];

const DECISION_KIND: Readonly<Record<NonNullable<Decision["kind"]>, string>> = {
  question: "Question",
  orchestrator: "Orchestrator's question",
  fallback: "Fallback choice",
  override: "Override",
  held: "Held action",
};

const ANSWERED_BY: Readonly<Record<NonNullable<Decision["answeredBy"]>, string>> = {
  owner: "you",
  orchestrator: "the Orchestrator",
  policy: "your policy",
  precedent: "a standing answer",
};

function decisionStatusText(decision: Decision): string {
  switch (decision.status) {
    case "answered":
      return decision.answeredBy === null ? "answered" : `answered by ${ANSWERED_BY[decision.answeredBy]}`;
    case "needs-confirmation":
      return "waiting for your confirmation";
    case "superseded":
      return "replaced";
    default:
      return decision.status;
  }
}

const RUNTIME_ROLE: Readonly<Record<WhyChain["turns"]["items"][number]["role"], string>> = {
  manager: "Manager",
  worker: "Worker",
  reviewer: "Reviewer",
  orchestrator: "Orchestrator",
  unknown: "Agent",
};

/**
 * The request's agents by role, never by id: `Worker`, or `Worker 1`,
 * `Worker 2` when there are several, in the order of their first turn.
 */
function agentNames(chain: WhyChain): (agentId: string) => string {
  const names = new Map<string, string>();
  const byRole = new Map<string, string[]>();
  const ordered = [...chain.turns.items].sort((a, b) => (a.first < b.first ? -1 : a.first > b.first ? 1 : 0));
  const add = (agentId: string, role: string) => {
    if (names.has(agentId)) return;
    names.set(agentId, role);
    byRole.set(role, [...(byRole.get(role) ?? []), agentId]);
  };
  for (const agent of ordered) add(agent.agentId, RUNTIME_ROLE[agent.role]);
  for (const id of chain.request.workerIds) add(id, "Worker");
  for (const id of chain.request.reviewerIds) add(id, "Reviewer");
  for (const [role, ids] of byRole) if (ids.length > 1) ids.forEach((id, index) => names.set(id, `${role} ${index + 1}`));
  return (agentId) => names.get(agentId) ?? "an agent outside this request";
}

/** A moment as the other screens write it; "time unknown" when it does not read. */
function momentText(at: string, now: Date): string {
  const text = localTimeText(new Date(at), now);
  return text === "" ? "time unknown" : text;
}

const moreLine = (key: string, more: number): WhyLine[] => (more > 0 ? [{ key: `${key}-more`, text: `+${more} more not shown`, tone: "muted" }] : []);

function decisionLines(chain: WhyChain, edges: readonly WhyEdge[]): WhyLine[] {
  const byId = new Map(chain.decisions.items.map((decision) => [decision.id, decision]));
  const precedents = new Map(chain.precedents.items.map((precedent) => [precedent.decisionId, precedent]));
  const lines: WhyLine[] = [];
  for (const decision of chain.decisions.items) {
    const kind = decision.kind === null ? "Decision" : DECISION_KIND[decision.kind];
    const replacedBy = edges.find((edge) => edge.kind === "superseded-by" && edge.from === decision.id);
    const successor = replacedBy === undefined ? undefined : byId.get(replacedBy.to);
    const replaced =
      replacedBy === undefined
        ? null
        : `replaced by ${successor === undefined ? "a decision outside this request" : `a later ${(successor.kind === null ? "decision" : DECISION_KIND[successor.kind]).toLowerCase()}`}`;
    const question = decision.question === null ? "question not recorded" : shorten(decision.question, 140);
    const parts = [`${kind}: ${question}`, decisionStatusText(decision), replaced].filter((part) => part !== null);
    const tone: Tone = replaced !== null || decision.status === "superseded" || decision.status === "withdrawn" || decision.status === "expired"
      ? "muted"
      : decision.status === "open" || decision.status === "needs-confirmation"
        ? "warning"
        : "plain";
    lines.push({ key: `d-${decision.id}`, text: parts.join(" · "), tone });
    const precedent = precedents.get(decision.id);
    if (precedent !== undefined) {
      const newer = edges.some((edge) => edge.kind === "superseded-by" && edge.from === precedent.id);
      lines.push(
        precedent.found
          ? {
              key: `p-${decision.id}`,
              text: `↳ Standing answer: ${precedent.text === null ? "text not recorded" : shorten(precedent.text, 140)}${newer ? " · replaced by a newer standing answer" : ""}`,
              tone: newer ? "muted" : "plain",
            }
          : { key: `p-${decision.id}`, text: "↳ Standing answer no longer stored", tone: "warning" },
      );
    }
  }
  if (chain.precedents.status === "missing" && chain.precedents.items.length === 0 && chain.precedents.reason !== null) {
    lines.push({ key: "p-missing", text: `Standing answers not read: ${chain.precedents.reason}`, tone: "warning" });
  }
  return [...lines, ...moreLine("decisions", chain.decisions.more)];
}

const beadName = (bead: { title: string | null }): string => (bead.title === null ? "a bead whose title was not read" : `“${shorten(bead.title, 80)}”`);

function beadLines(chain: WhyChain, edges: readonly WhyEdge[]): WhyLine[] {
  const byId = new Map(chain.beads.items.map((bead) => [bead.id, bead]));
  const lines = chain.beads.items.map((bead): WhyLine => {
    const title = bead.title === null ? (bead.inStore === false ? "A bead not in the bead store" : "A bead (title not read)") : shorten(bead.title, 120);
    const splitInto = edges.filter((edge) => edge.kind === "split-into" && edge.from === bead.id).map((edge) => byId.get(edge.to));
    const splitFrom = bead.splitFrom.map((id) => byId.get(id));
    const parts = [
      `${title} — ${bead.actions.join(", ")}${confidenceSuffix(bead.confidence)}`,
      bead.status,
      ...splitFrom.map((parent) => (parent === undefined ? "replaces an earlier bead (split)" : `split from ${beadName(parent)}`)),
      ...splitInto.map((child) => `replaced by ${child === undefined ? "a later bead" : beadName(child)} (split)`),
    ].filter((part): part is string => part !== null && part !== "");
    const tone: Tone = bead.inStore === false ? "warning" : splitInto.length > 0 ? "muted" : "plain";
    return { key: `b-${bead.id}`, text: parts.join(" · "), tone };
  });
  return [...lines, ...moreLine("beads", chain.beads.more)];
}

function changeLines(chain: WhyChain): WhyLine[] {
  const lines: WhyLine[] = [];
  const items = chain.changes.items;
  const labelled = items.flatMap((change) => (change.label === null ? [] : [{ label: change.label }]));
  const shown = items.length + chain.changes.more;
  if (labelled.length > 0) {
    lines.push({ key: "files", text: `${plural(labelled.length, "file")} changed — ${claimCountsText(labelled)}`, tone: "plain" });
  }
  const commitOnly = items.length - labelled.length;
  if (commitOnly > 0) lines.push({ key: "commit-only", text: `${plural(commitOnly, "file")} named only by a commit`, tone: "plain" });
  const byTime = items.filter((change) => change.onlyCommitByTime).length;
  if (byTime > 0) lines.push({ key: "by-time", text: `${plural(byTime, "file")} linked only by a commit's time`, tone: "warning" });
  if (chain.changes.more > 0) lines.push({ key: "changes-more", text: `${shown} files in all; the first ${items.length} are in Details`, tone: "muted" });

  const commits = chain.commits;
  if (commits.status === "found") {
    const byBead = commits.items.filter((commit) => commit.link === "bead").length;
    const byPath = commits.items.length - byBead;
    const how = [byBead > 0 ? `${byBead} name a bead of the request` : null, byPath > 0 ? `${byPath} matched by file and time` : null].filter((part) => part !== null);
    lines.push({ key: "commits", text: `${plural(commits.items.length + commits.more, "commit")} — ${how.join(", ")}`, tone: "plain" });
  } else if (commits.reason !== null) {
    lines.push({ key: "commits", text: commits.status === "missing" ? `Commits not read: ${commits.reason}` : commits.reason, tone: commits.status === "missing" ? "warning" : "muted" });
  }
  if (commits.unlinked > 0) lines.push({ key: "unlinked", text: `${plural(commits.unlinked, "other commit")} in its span, linked to nothing of it`, tone: "muted" });
  return lines;
}

function checkLines(chain: WhyChain): WhyLine[] {
  const checks = chain.checks;
  if (checks.status !== "found" || checks.verdict === null) return [];
  if (checks.verdict === "not-checked") {
    return [{ key: "verdict", text: "Not checked: recorded before checks were labelled", tone: "muted" }];
  }
  const verdict = { checks: checks.verdict };
  const head: WhyLine = checks.unverified
    ? { key: "verdict", text: `${FINISHED_UNVERIFIED_CHIP}: not every check was seen to pass after the last edit`, tone: "warning" }
    : checks.named.length === 0 && checks.verdict === "unverified"
      ? { key: "verdict", text: "unverified, none shown to run", tone: "warning" }
      : { key: "verdict", text: `Checks: ${checks.verdict === "detected" ? "detected ✓" : checks.verdict}`, tone: checks.verdict === "detected" ? "success" : "plain" };
  const named = checks.named.map(
    (claim, index): WhyLine => ({
      key: `c-${index}`,
      text: `${shorten(claim.check, 100)} — ${checkLabelText(verdict, claim)}`,
      tone: checks.verdict === "unverified" ? "warning" : claim.label === "detected" ? "success" : "plain",
    }),
  );
  return [head, ...named];
}

function verdictTone(verdict: string | null): Tone {
  if (verdict === null) return "muted";
  if (/pass|approve|lgtm|ok\b/i.test(verdict)) return "success";
  if (/change|block|fail|reject/i.test(verdict)) return "warning";
  return "plain";
}

function reviewLines(chain: WhyChain): WhyLine[] {
  const batches = chain.reviews.items;
  const lines = batches.map((batch, index): WhyLine => {
    const latest = batch.reviews.at(-1);
    const blocking = latest === undefined || latest.blockingCount === null ? "blocking findings unknown" : `${latest.blockingCount} blocking`;
    const name = batches.length === 1 ? "Review" : `Review ${index + 1}`;
    return {
      key: `r-${index}`,
      text: `${name}: ${batch.verdict ?? "verdict not recorded"} · ${plural(batch.reviews.length, "review")} · ${blocking}`,
      tone: verdictTone(batch.verdict),
    };
  });
  return [...lines, ...moreLine("reviews", chain.reviews.more)];
}

function turnLines(chain: WhyChain, now: Date): WhyLine[] {
  const name = agentNames(chain);
  const lines = chain.turns.items.map((agent): WhyLine => {
    const first = momentText(agent.first, now);
    const span = agent.first === agent.last ? first : `${first} → ${momentText(agent.last, now)}`;
    return { key: `t-${agent.agentId}`, text: `${name(agent.agentId)} — ${plural(agent.count, "turn")} · ${span}`, tone: "plain" };
  });
  const handoffs = chain.handoffs.items.map(
    (edge, index): WhyLine => ({
      key: `h-${index}`,
      text: edge.kind === "handoff" ? `${name(edge.from)} handed over to ${name(edge.to)}` : `${name(edge.from)} was replaced by ${name(edge.to)}`,
      tone: "muted",
    }),
  );
  const handoffNote: WhyLine[] =
    chain.handoffs.status === "missing" && chain.handoffs.reason !== null ? [{ key: "h-missing", text: `Handovers not known: ${chain.handoffs.reason}`, tone: "muted" }] : [];
  return [...lines, ...moreLine("turns", chain.turns.more), ...handoffs, ...handoffNote];
}

function sectionOf(key: WhySectionKey, title: string, link: { status: WhySection["status"]; reason: string | null }, lines: WhyLine[]): WhySection {
  const status = STATUS[link.status];
  return {
    key,
    title,
    status: link.status,
    statusText: status.text,
    statusTone: status.tone,
    reason: link.status === "found" ? null : link.reason,
    lines,
    accessibilityLabel: [`${title}: ${status.text}`, link.status === "found" ? null : link.reason].filter((part) => part !== null).join(". "),
  };
}

/** Ids, paths and hashes: Details only. */
function detailLines(chain: WhyChain): string[] {
  const name = agentNames(chain);
  const short = (hash: string) => hash.slice(0, 12);
  return [
    `Request: ${chain.request.requestId}`,
    `Trace: ${chain.request.traceId}`,
    ...chain.decisions.items.map((decision) => `Decision: ${decision.id} — ${decision.status}${decision.supersededBy === null ? "" : ` → ${decision.supersededBy}`}`),
    ...chain.precedents.items.map((precedent) => `Standing answer: ${precedent.id} (for ${precedent.decisionId})${precedent.supersededBy === null ? "" : ` → ${precedent.supersededBy}`}`),
    ...chain.beads.items.map((bead) => `Bead: ${bead.id} — ${bead.actions.join(", ")}${bead.splitFrom.length === 0 ? "" : ` · split from ${bead.splitFrom.join(", ")}`}`),
    ...chain.changes.items.map(
      (change) => `File: ${change.path} — ${change.label ?? "commit only"}${change.commits.length === 0 ? "" : ` · ${change.commits.map(short).join(", ")}`}`,
    ),
    ...chain.commits.items.map((commit) => `Commit: ${short(commit.hash)} ${commit.subject ?? ""}`.trimEnd()),
    ...chain.reviews.items.map((batch) => `Review batch: ${batch.batchId ?? "no batch id"} — ${batch.reviews.map((review) => review.agentId).join(", ")}`),
    ...chain.turns.items.map((agent) => `${name(agent.agentId)}: ${agent.agentId}`),
    ...chain.edges.map((edge) => `Edge: ${edge.from} ${edge.kind} ${edge.to}`),
  ];
}

/** The view of one chain. */
export function whyView(chain: WhyChain, now: Date): WhyView {
  const edges = chain.edges;
  const title = shorten(excerptLine(chain.request.text), 120);
  const meta = [STATE_TEXT[chain.request.state], chain.request.tier, `asked ${ago(chain.request.requestedAt, now)}`].filter((part) => part !== null).join(" · ");
  const notices = [
    ...(chain.request.basis === "store-only" ? ["Rebuilt from the stored history alone: Paseo's agent list was not read."] : []),
    ...chain.notices,
  ];
  const sections: WhySection[] = [
    sectionOf("decisions", "Decisions", chain.decisions, decisionLines(chain, edges)),
    sectionOf("beads", "Beads", chain.beads, beadLines(chain, edges)),
    sectionOf("changes", "Changes", chain.changes, changeLines(chain)),
    sectionOf("checks", "Checks", chain.checks, checkLines(chain)),
    sectionOf("reviews", "Reviews", chain.reviews, reviewLines(chain)),
    sectionOf("turns", "Turns", chain.turns, turnLines(chain, now)),
  ];
  return {
    title,
    meta,
    notices,
    sections,
    details: detailLines(chain),
    accessibilityLabel: `Why: ${title}. ${meta}`,
  };
}

/** What the view draws for a read: its spinner, its error, no chain (with the reason), or the chain. */
export function whyState(data: LinksWhyOutput | undefined, error: string | null, now: Date): WhyState {
  if (data === undefined) return error === null ? { kind: "loading" } : { kind: "error", text: `Could not read the chain. ${error}` };
  const chain = data.chains[0];
  if (chain === undefined) return { kind: "empty", text: data.reason ?? "No chain holds this request." };
  return { kind: "ready", view: whyView(chain, now), error: error === null ? null : `Could not read the chain again. ${error}` };
}
