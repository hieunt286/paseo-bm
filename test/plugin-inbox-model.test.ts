import { describe, expect, it, vi } from "vitest";
import {
  DECIDED_FOR_YOU_EMPTY,
  DECIDED_FOR_YOU_TRUNCATED,
  EMPTY_INBOX,
  INTERVENTIONS_TRUNCATED,
  digestOutcomeOf,
  interventionRowOf,
  OVERRIDE_DONE,
  OVERRIDE_WAITING,
  decidedForYouOf,
  digestRowOf,
  INBOX_POLL_MS,
  RESEND_FOLLOW_UP_MS,
  UNKNOWN_PROJECT,
  alertRowOf,
  emptySentence,
  fallbackOutcomeOf,
  inboxTab,
  inboxView,
  needsYouGroups,
  orderedAlerts,
  resendFollowUps,
  sectionHeading,
  seedOf,
  type DigestDecisionRow,
  type DigestRow,
  type InboxInput,
} from "../plugin/client/inbox-model";
import { DECISION_UI_IDLE, HELD_CARD_LINE, OVERRIDE_CARD_LINE, choiceNeedsConfirmation, decisionCardView, type DecisionUi } from "../plugin/client/chat-card-decision";
import { heldDecisionOf } from "../plugin/server/action-boundary";
import { boundaryVerdictOfCommand } from "../plugin/shared/effectful-actions";
import { precedentSuggestionView } from "../plugin/client/chat-card-precedent";
import type { Precedent } from "../plugin/shared/precedents";
import { OPEN_IN_APP_TEXT, TOOLS_STALE_TEXT, openDialog, orchestratorLineView } from "../plugin/client/orchestrator-model";
import { ALERT_KINDS, alertKeyOf, type Alert, type AlertKind } from "../plugin/shared/alerts";
import { digestInterventionSchema, type DigestIntervention, type FallbackIncident } from "../plugin/shared/contracts";
import { EXPECTED_OUTCOME_OF, INTERVENTION_KINDS, INTERVENTION_WINDOW_MS, type InterventionKind } from "../plugin/shared/interventions";
import {
  CONFIRM_EFFECTS,
  EFFECTS,
  answerDecision,
  markNeedsConfirmation,
  openingPrediction,
  type AnswerInput,
  type Decision,
  type DecisionOption,
  type Effect,
} from "../plugin/shared/decisions";
import { DECISION_WS, makeDecision, storedOrchestratorAnswer } from "./helpers/decisions";
import { allNodes, pressables, renderTree, textOf, texts, type RNode } from "./helpers/element-tree";

/**
 * The Inbox (experience concept §4.1, autonomy design §A.12): its model is
 * pure and tested here; its hook-free pieces (`AlertRow`, `EmptyInbox`,
 * `OutcomeLine`, and the chats' `DecisionCardBody` it reuses) are expanded
 * with the element-tree helper. `react-native` and the SDK icon are named
 * stand-ins.
 */

// The root tsconfig has no `jsx`, so the .tsx modules load through non-literal specifiers.
const inboxPath = "../plugin/client/inbox.tsx";
const uiPath = "../plugin/client/ui.tsx";
const cardPath = "../plugin/client/chat-card.tsx";
const orchestratorLinePath = "../plugin/client/orchestrator-line.tsx";
type Component = (props: Record<string, unknown>) => unknown;
const { AlertRow, DigestRowView, EmptyInbox, OutcomeLine, InboxActionButton } = (await import(inboxPath)) as {
  AlertRow: Component;
  DigestRowView: Component;
  EmptyInbox: Component;
  OutcomeLine: Component;
  InboxActionButton: Component;
};
const { StatusTabs } = (await import(uiPath)) as { StatusTabs: Component };
const { DecisionCardBody } = (await import(cardPath)) as { DecisionCardBody: Component };
const { OrchestratorLineRow } = (await import(orchestratorLinePath)) as { OrchestratorLineRow: Component };

const styles = new Proxy({}, { get: (_target, key) => ({ name: String(key) }) });
const theme = { colors: new Proxy({}, { get: (_target, key) => `#${String(key)}` }) };
const noop = () => undefined;

const NOW = new Date("2026-09-29T08:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const WS2 = "wks_2";
const NAMES: Record<string, string> = { [DECISION_WS]: "shop", [WS2]: "xspace-master-data" };
const CAN = { openAgent: true, openWorkspace: true };

function input(overrides: Partial<InboxInput> = {}): InboxInput {
  return {
    decisions: [],
    settledHere: [],
    alerts: [],
    incidents: [],
    projectOf: (workspaceId) => NAMES[workspaceId] ?? null,
    runningWorkers: null,
    can: CAN,
    now: NOW,
    ...overrides,
  };
}

/** A Decided-for-you line that must be a decision's (not an intervention's). */
function decisionRow(row: DigestRow): DigestDecisionRow {
  if (row.kind !== "decision") throw new Error(`expected a decision line, got ${row.key}`);
  return row;
}

const question = (request: string, n: number, askedMinutesAgo: number, overrides: Partial<Decision> = {}) =>
  makeDecision({ id: `q:${request}:Q${n}`, requestId: request, askedAt: minutesAgo(askedMinutesAgo), ...overrides });

function alert(kind: AlertKind, subject: string, sinceMinutesAgo: number, overrides: Partial<Alert> = {}): Alert {
  const workspaceId = overrides.workspaceId === undefined ? DECISION_WS : overrides.workspaceId;
  return { key: alertKeyOf(kind, workspaceId, subject), workspaceId, kind, subject, since: minutesAgo(sinceMinutesAgo), clearedAt: null, ...overrides };
}

const CANDIDATE = { position: 1, alias: "bm-reviewer-fallback-1", baseProvider: "codex", model: "gpt-5.6-sol", thinkingOptionId: null, modeId: null };
function incident(overrides: Partial<FallbackIncident> = {}): FallbackIncident {
  return {
    id: "fb-000000000d01",
    role: "worker",
    workspaceId: DECISION_WS,
    requestId: "req-20260929T073348Z",
    agentId: "wrk-1",
    agentProvider: "bm-worker/claude-opus-5",
    agentModel: "claude-opus-5",
    parentId: "mgr-1",
    managerId: "mgr-1",
    class: "L1",
    signal: "failed",
    message: "You've hit your usage limit.",
    perModelWindow: false,
    resetsAt: null,
    candidate: CANDIDATE,
    status: "pending",
    detectedAt: minutesAgo(30),
    decidedAt: null,
    waitUntil: null,
    replacementId: null,
    error: null,
    ...overrides,
  };
}

/** The `f:` decision of an incident, answered in the Inbox with its Switch option. */
function fallbackDecision(incidentId: string, workspaceId = DECISION_WS): Decision {
  const open = makeDecision({
    id: `f:${incidentId}`,
    workspaceId,
    requestId: null,
    askedBy: { role: "plugin", agentId: null },
    askedAt: minutesAgo(20),
    round: null,
    subject: null,
    question: "The Worker was stopped by its provider plan",
    options: [
      { key: "switch", label: "Switch", recommended: true, effects: ["none"], action: { kind: "fallback", action: "switch", target: incidentId } },
      { key: "dismiss", label: "I'll handle it", recommended: false, effects: ["none"], action: { kind: "fallback", action: "dismiss", target: incidentId } },
    ],
  });
  const answered = answerDecision(open, { via: "inbox", optionKey: "switch", words: null, at: minutesAgo(1) });
  if (!answered.ok) throw new Error("fixture");
  return { ...answered.decision, delivery: { to: "mgr-1", kind: "fallback:switch", at: minutesAgo(1), outcome: "sent" } };
}

describe("Needs you: grouping and order", () => {
  it("groups by project, the project with the oldest question first, oldest question first inside", () => {
    const decisions = [
      question("req-A", 1, 10),
      question("req-B", 1, 40, { workspaceId: WS2 }),
      question("req-A", 2, 30),
      question("req-C", 1, 5, { workspaceId: WS2 }),
    ];
    const groups = needsYouGroups(input({ decisions }));
    expect(groups.map((group) => [group.label, group.items.map((item) => item.decision.id)])).toEqual([
      ["xspace-master-data", ["q:req-B:Q1", "q:req-C:Q1"]],
      ["shop", ["q:req-A:Q2", "q:req-A:Q1"]],
    ]);
    // The asking Worker's chat names the askers on the cards.
    expect(groups[0]!.peersOf).toBe("agent-worker");
    // Each card is a seed: the decision itself is read live.
    expect(groups[1]!.items[0]!.card).toMatchObject({ type: "decision", requestId: "req-A", decision: { id: "q:req-A:Q2", asker: "worker", questionId: "Q2" } });
  });

  it("names a project it no longer lists without its id, and never keeps a settled decision it did not settle", () => {
    const answered = answerDecision(question("req-A", 1, 10), { via: "chat-card", optionKey: "c", words: null, at: minutesAgo(2) });
    if (!answered.ok) throw new Error("fixture");
    const groups = needsYouGroups(input({ decisions: [question("req-Z", 1, 3, { workspaceId: "wks_gone" }), answered.decision] }));
    expect(groups.map((group) => group.label)).toEqual([UNKNOWN_PROJECT]);
    expect(UNKNOWN_PROJECT).not.toContain("wks");
  });

  it("drops a question the Orchestrator answered (bm_decide, change-004): it is settled, so it no longer needs you", () => {
    const open = question("req-A", 1, 10);
    const other = question("req-A", 2, 5);
    const decided = storedOrchestratorAnswer(open, { optionKey: "c", reason: "Hold until the review is in.", at: minutesAgo(1) });
    if (!decided.ok) throw new Error("fixture");
    // Whether the list still carries a stale copy or already left it out, only the open question needs the owner.
    for (const decisions of [[decided.decision, other], [other]]) {
      const shown = inboxView(input({ decisions }));
      expect(shown.needsYou.groups.flatMap((group) => group.items.map((item) => item.decision.id))).toEqual(["q:req-A:Q2"]);
      expect(shown.needsYou.count).toBe(1);
      expect(shown.count).toBe(1);
    }
  });

  it("keeps a decision settled here in its place, drawn settled and not counted; the list's stale copy loses", () => {
    const open = question("req-A", 1, 10);
    const other = question("req-A", 2, 5);
    const answered = answerDecision(open, { via: "inbox", optionKey: "c", words: null, at: minutesAgo(0) });
    if (!answered.ok) throw new Error("fixture");
    const shown = inboxView(input({ decisions: [open, other], settledHere: [answered.decision] }));
    expect(shown.needsYou.groups[0]!.items.map((item) => [item.decision.id, item.decision.status, item.settledHere])).toEqual([
      ["q:req-A:Q1", "answered", true],
      ["q:req-A:Q2", "open", false],
    ]);
    expect(shown.needsYou.count).toBe(1);
    expect(shown.count).toBe(1);
    // "Keep open" put it back to open: the list's copy is the one shown again.
    const reopened = inboxView(input({ decisions: [open], settledHere: [open] }));
    expect(reopened.needsYou.groups[0]!.items.map((item) => item.settledHere)).toEqual([false]);
  });

  it("seeds a card from a stored decision, every asker kind", () => {
    expect(seedOf(question("req-A", 3, 1))).toMatchObject({ asker: "worker", questionId: "Q3", options: [{ key: "a", recommended: true }, { key: "b" }, { key: "c" }] });
    expect(seedOf(fallbackDecision("fb-000000000d01"))).toMatchObject({ id: "f:fb-000000000d01", asker: "plugin", questionId: null });
    expect(seedOf(makeDecision({ id: "o:abc", requestId: null, askedBy: { role: "orchestrator", agentId: "orch" } }))).toMatchObject({ asker: "orchestrator", questionId: null });
  });
});

describe("the empty Inbox and the sections", () => {
  it("is one sentence, with the running Workers when known", () => {
    expect(inboxView(input()).empty).toBe(EMPTY_INBOX);
    expect(EMPTY_INBOX).toBe("Nothing needs you.");
    expect(inboxView(input({ runningWorkers: 0 })).empty).toBe("Nothing needs you.");
    expect(inboxView(input({ runningWorkers: 1 })).empty).toBe("Nothing needs you. 1 Worker is running.");
    expect(emptySentence(3)).toBe("Nothing needs you. 3 Workers are running.");
  });

  it("is not empty while a decision, an alert or a card settled here is shown", () => {
    expect(inboxView(input({ decisions: [question("req-A", 1, 1)] })).empty).toBeNull();
    expect(inboxView(input({ alerts: [alert("stuck", "wrk-1", 3)] })).empty).toBeNull();
    const answered = answerDecision(question("req-A", 1, 1), { via: "inbox", optionKey: "c", words: null, at: minutesAgo(0) });
    if (!answered.ok) throw new Error("fixture");
    expect(inboxView(input({ settledHere: [answered.decision] })).empty).toBeNull();
  });

  it("has Decided for you empty while nothing was decided for the owner, and headings with counts", () => {
    expect(inboxView(input({ decisions: [question("req-A", 1, 1)] })).decidedForYou).toEqual({ count: 0, rows: [], empty: DECIDED_FOR_YOU_EMPTY, truncated: false, interventionsTruncated: false });
    expect(DECIDED_FOR_YOU_EMPTY).toBe("Nothing was decided for you since you last looked.");
    expect(sectionHeading("Needs you", 2)).toBe("Needs you · 2");
    expect(sectionHeading("Decided for you", 1)).toBe("Decided for you · 1");
    expect(sectionHeading("Alerts", 0)).toBe("Alerts · 0");
  });

  it("polls every five seconds (the surface reads only while the Inbox shows)", () => {
    expect(INBOX_POLL_MS).toBe(5_000);
  });
});

describe("the Inbox tab carries the count (DQ-3: no sidebar badge)", () => {
  it("counts the unsettled decisions and the alerts, follow-ups included", () => {
    const shown = inboxView(
      input({
        decisions: [question("req-A", 1, 10), makeDecision({ ...question("req-A", 2, 5), status: "needs-confirmation", needsConfirmation: { via: "chat-worker", at: minutesAgo(1) } })],
        alerts: [alert("stuck", "wrk-1", 3), alert("danger", "wrk-2", 1)],
        incidents: [incident({ id: "fb-000000000e01", role: "reviewer", status: "switched", decidedAt: minutesAgo(10) })],
      }),
    );
    expect([shown.needsYou.count, shown.alerts.count, shown.count]).toEqual([2, 3, 5]);
  });

  it("labels the tab \"Inbox 5\", says it aloud, and shows no number when nothing needs the owner or nothing was read", () => {
    expect(inboxTab(5)).toEqual({ key: "inbox", label: "Inbox", count: 5, hint: "5 items need you" });
    expect(inboxTab(1).hint).toBe("1 item needs you");
    expect(inboxTab(0)).toEqual({ key: "inbox", label: "Inbox", hint: "nothing needs you" });
    expect(inboxTab(null)).toEqual({ key: "inbox", label: "Inbox" });
    const nodes = renderTree(
      StatusTabs({ tabs: [inboxTab(5), { key: "work", label: "Work" }, { key: "insights", label: "Insights" }, { key: "settings", label: "Settings" }], selected: "inbox", onSelect: noop, styles }),
    );
    expect(texts(nodes)).toEqual(["Inbox 5", "Work", "Insights", "Settings"]);
    expect(pressables(nodes).map((node) => [node.props["accessibilityRole"], node.props["accessibilityLabel"]])).toEqual([
      ["tab", "Inbox: 5 items need you"],
      ["tab", "Work"],
      ["tab", "Insights"],
      ["tab", "Settings"],
    ]);
  });
});

describe("the Inbox's decision cards", () => {
  const cardOf = (decision: Decision, ui: DecisionUi = DECISION_UI_IDLE) => {
    const item = needsYouGroups(input({ decisions: [decision] }))[0]!.items[0]!;
    return decisionCardView({ card: item.card, lookup: { state: "found", decision: item.decision }, agents: [], ui, cardAt: new Date(decision.askedAt), now: NOW });
  };
  const draw = (shown: ReturnType<typeof cardOf>, ui: DecisionUi = DECISION_UI_IDLE, handlers: Record<string, unknown> = {}) =>
    renderTree(
      DecisionCardBody({
        view: shown,
        ui,
        detailsOpen: false,
        onToggleDetails: noop,
        onChoose: noop,
        onOpenWords: noop,
        onWords: noop,
        onSendWords: noop,
        onCancel: noop,
        onConfirm: noop,
        onCloseInChat: noop,
        text: "",
        styles,
        theme,
        compact: true,
        ...handlers,
      }),
    );

  it("offers the options and Own words… beside Keep open / Close as answered on a decision that needs confirmation", () => {
    const decision = markNeedsConfirmation(question("req-A", 1, 10), { via: "chat-worker", at: minutesAgo(2) });
    if (!decision.ok) throw new Error("fixture");
    const shown = cardOf(decision.decision);
    expect([shown.confirmChat, shown.ownWords]).toEqual([true, true]);
    expect(shown.options.map((option) => option.key)).toEqual(decision.decision.options.map((option) => option.key));
    const onCloseInChat = vi.fn();
    const nodes = draw(shown, DECISION_UI_IDLE, { onCloseInChat });
    // The options, then Own words…, then Keep open and Close as answered.
    const [keep, close] = pressables(nodes).slice(shown.options.length + 1);
    expect([keep!.props["accessibilityLabel"], close!.props["accessibilityLabel"]]).toEqual(["Keep the decision open", "Close the decision as answered"]);
    expect(texts(nodes)).toEqual(expect.arrayContaining(["Needs confirmation", "Keep open", "Close as answered"]));
    (keep!.props["onPress"] as () => void)();
    (close!.props["onPress"] as () => void)();
    expect(onCloseInChat.mock.calls).toEqual([[false], [true]]);
  });

  it("asks for confirmation only for release, data, security and cost effects (X-4)", () => {
    // push/publish/deploy = release; real-data/migration = data; then security and cost.
    expect([...CONFIRM_EFFECTS].sort()).toEqual(["cost", "deploy", "migration", "publish", "push", "real-data", "security"].sort());
    for (const effect of EFFECTS) {
      const decision = question("req-A", 1, 1, {
        options: [
          { key: "a", label: "Do it", recommended: true, effects: [effect] },
          { key: "b", label: "Hold", recommended: false, effects: ["none"] },
        ],
      });
      const risky = (CONFIRM_EFFECTS as readonly Effect[]).includes(effect);
      expect(choiceNeedsConfirmation(decision, { optionKey: "a" }), effect).toBe(risky);
      expect(cardOf(decision).options[0]!.confirm, effect).toBe(risky);
      expect(choiceNeedsConfirmation(decision, { optionKey: "b" }), effect).toBe(false);
    }
  });

  it("shows the confirmation in place with Cancel first and as the default", () => {
    const decision = question("req-A", 1, 1);
    const ui = { ...DECISION_UI_IDLE, confirming: "a" };
    const shown = cardOf(decision, ui);
    expect(shown.confirm).toMatchObject({ confirmLabel: "Confirm and send", cancelLabel: "Cancel", defaultAction: "cancel" });
    expect(shown.options).toEqual([]);
    expect(pressables(draw(shown, ui)).map((node) => node.props["accessibilityLabel"]).slice(0, 2)).toEqual(["Cancel", "Confirm and send"]);
  });
});

describe("Alerts", () => {
  it("lists open alerts in ALERT_KINDS order, oldest first within a kind", () => {
    const alerts = [
      alert("fallback-failed", "f:fb-000000000d01", 1),
      alert("stuck", "wrk-2", 5),
      alert("stuck", "wrk-1", 9),
      alert("request-stalled", "req-A", 2),
      alert("danger", "wrk-3", 30, { clearedAt: minutesAgo(1) }),
    ];
    expect(orderedAlerts(alerts).map((entry) => `${entry.kind}:${entry.subject}`)).toEqual([
      "request-stalled:req-A",
      "stuck:wrk-1",
      "stuck:wrk-2",
      "fallback-failed:f:fb-000000000d01",
    ]);
    expect(ALERT_KINDS[0]).toBe("request-stalled");
  });

  it("says what happened and where, keeps ids and detail for Details, and offers what the surface can open", () => {
    const row = alertRowOf(alert("danger", "wrk-9", 12, { detail: "ran npm publish" }), input());
    expect(row).toMatchObject({ tone: "danger", text: "A Worker ran a risky command · shop", time: "12 min ago" });
    expect(row.text).not.toContain("wrk-9");
    expect(row.details).toEqual(["ran npm publish", `Alert: danger:${DECISION_WS}:wrk-9`, `Since: ${minutesAgo(12)}`]);
    expect(row.action).toEqual({ kind: "open-agent", agentId: "wrk-9", label: "Open Worker", accessibilityLabel: "Open the Worker" });
    expect(alertRowOf(alert("request-stalled", "req-A", 3), input()).action).toMatchObject({ kind: "open-project", workspaceId: DECISION_WS });
    // A host without navigation offers nothing it cannot run.
    expect(alertRowOf(alert("stuck", "wrk-1", 3), input({ can: { openAgent: false, openWorkspace: false } })).action).toBeNull();
    expect(alertRowOf(alert("pairing-mismatch", "a-1", 3, { workspaceId: null }), input()).text).toBe("An agent was created by the wrong role · no project");
  });

  it("names a class taken back after a reversal, with its project and time; the reason and ids on a tap; nothing to open (§B.4)", () => {
    const detail = `Scope decisions are back in Shadow: q:req-20260929T073348Z:Q1, answered for you by the recommended option, was overridden by you.`;
    const demoted = alert("autonomy-demoted", "scope", 7, { detail });
    const row = alertRowOf(demoted, input());
    expect(row).toMatchObject({ tone: "warning", text: "Scope decisions went back to Shadow after a reversal · shop", time: "7 min ago", action: null });
    expect(row.accessibilityLabel).toBe("Scope decisions went back to Shadow after a reversal · shop, 7 min ago");
    expect(row.details).toEqual([detail, `Alert: autonomy-demoted:${DECISION_WS}:scope`, `Since: ${minutesAgo(7)}`]);
    // A subject that is not a class still reads, without it.
    expect(alertRowOf(alert("autonomy-demoted", "style", 7), input()).text).toBe("A delegated class went back to Shadow after a reversal · shop");
    // Listed last, after the other kinds.
    expect(orderedAlerts([demoted, alert("fallback-failed", "f:fb-1", 1)]).map((entry) => entry.kind)).toEqual(["fallback-failed", "autonomy-demoted"]);
    // Drawn: the line without the decision id; the reason when opened.
    const closed = renderTree(AlertRow({ row, expanded: false, onToggle: noop, onRun: noop, resend: undefined, compact: true, styles, theme }));
    expect(texts(closed)).toEqual(["●", "Scope decisions went back to Shadow after a reversal · shop", "7 min ago ▸"]);
    expect(pressables(closed)).toHaveLength(1);
    const open = renderTree(AlertRow({ row, expanded: true, onToggle: noop, onRun: noop, resend: undefined, compact: true, styles, theme }));
    expect(texts(open)).toContain(detail);
  });

  it("offers to replace a Manager on older instructions, and only to open a Worker or a Reviewer", () => {
    expect(alertRowOf(alert("outdated-agent", "mgr-1", 3, { role: "manager" }), input()).action).toEqual({
      kind: "replace-manager",
      workspaceId: DECISION_WS,
      label: "Replace Manager",
      accessibilityLabel: "Replace the Beads Manager with one on the current instructions",
    });
    expect(alertRowOf(alert("outdated-agent", "wrk-1", 3, { role: "worker" }), input()).action).toMatchObject({ kind: "open-agent", agentId: "wrk-1" });
    // Without a project there is nothing to ensure a Manager in; without a role it is only opened.
    expect(alertRowOf(alert("outdated-agent", "mgr-1", 3, { role: "manager", workspaceId: null }), input()).action).toMatchObject({ kind: "open-agent" });
    expect(alertRowOf(alert("outdated-agent", "mgr-1", 3), input()).action).toMatchObject({ kind: "open-agent" });
  });

  it("names a Worker or Reviewer running without the action boundary, and only opens it (autonomy design §D.2, change-010 C6)", () => {
    const row = alertRowOf(alert("boundary-off", "wrk-1", 3), input());
    expect(row.action).toMatchObject({ kind: "open-agent", agentId: "wrk-1" });
    expect(JSON.stringify(row)).toContain("An agent runs without the action boundary");
  });
});

describe("fallback follow-ups (cards review)", () => {
  it("shows what became of the incident under a fallback card settled here: a new Beads Manager, with a way to open it", () => {
    const managerIncident = incident({ role: "manager", status: "switched", replacementId: "mgr-2", requestId: null, decidedAt: minutesAgo(1) });
    const decision = fallbackDecision(managerIncident.id);
    const shown = inboxView(input({ settledHere: [decision], incidents: [managerIncident] }));
    const item = shown.needsYou.groups[0]!.items[0]!;
    expect(item.outcome).toEqual({
      text: "A new Beads Manager is running on Codex · gpt-5.6-sol.",
      tone: "success",
      action: { kind: "open-agent", agentId: "mgr-2", label: "Open new Manager", accessibilityLabel: "Open the new Manager" },
    });
    // The same decision still open has no outcome yet.
    const open = { ...decision, status: "open" as const, answer: null, grant: null, settledAt: null, delivery: null };
    expect(inboxView(input({ decisions: [open], incidents: [managerIncident] })).needsYou.groups[0]!.items[0]!.outcome).toBeNull();
  });

  it("offers Resend under a switched Reviewer whose replacement never appeared, and not twice in Alerts", () => {
    const reviewer = incident({ role: "reviewer", status: "switched", decidedAt: minutesAgo(1), parentId: "wrk-1" });
    const shown = inboxView(input({ settledHere: [fallbackDecision(reviewer.id)], incidents: [reviewer] }));
    expect(shown.needsYou.groups[0]!.items[0]!.outcome).toMatchObject({ tone: "warning", action: { kind: "resend", incidentId: reviewer.id, label: "Resend to Worker" } });
    expect(shown.alerts.rows).toEqual([]);
  });

  it("follows up a switched Reviewer in Alerts for a day, until its replacement appears", () => {
    const recent = incident({ id: "fb-000000000e01", role: "reviewer", status: "switched", decidedAt: minutesAgo(60) });
    const old = incident({ id: "fb-000000000e02", role: "reviewer", status: "switched", decidedAt: new Date(NOW.getTime() - RESEND_FOLLOW_UP_MS - 60_000).toISOString() });
    const replaced = incident({ id: "fb-000000000e03", role: "reviewer", status: "switched", decidedAt: minutesAgo(5), replacementId: "rev-2" });
    const worker = incident({ id: "fb-000000000e04", role: "worker", status: "switched", decidedAt: minutesAgo(5) });
    const rows = resendFollowUps([recent, old, replaced, worker], new Set(), input());
    expect(rows.map((row) => row.key)).toEqual(["resend:fb-000000000e01"]);
    expect(rows[0]).toMatchObject({ text: "The new Reviewer has not appeared · shop", time: "1 h ago", action: { kind: "resend", incidentId: recent.id } });
    expect(rows[0]!.text).not.toContain("fb-");
    expect(rows[0]!.details).toContain(`Incident: ${recent.id}`);
  });

  it("words every other outcome", () => {
    const decision = fallbackDecision("fb-000000000d01");
    const at = (overrides: Partial<FallbackIncident>) => fallbackOutcomeOf(incident(overrides), decision, input())?.text ?? null;
    expect(at({ status: "switched", replacementId: "wrk-2" })).toBe("A new Worker is running on Codex · gpt-5.6-sol.");
    expect(at({ status: "dismissed" })).toBe("Recorded: you handle it.");
    expect(at({ status: "resumed" })).toBe("The limit reset and the Worker was asked to carry on.");
    expect(at({ status: "exhausted" })).toBe("No fallback was left to switch to.");
    expect(at({ status: "failed", error: "no slot" })).toBe("The fallback failed: no slot");
    expect(at({ status: "waiting", waitUntil: "not a time" })).toBe("Waiting for the usage reset; then the Worker carries on.");
    expect(at({ status: "pending" })).toBeNull();
    expect(fallbackOutcomeOf(incident({ status: "pending" }), { ...decision, delivery: { ...decision.delivery!, outcome: "failed" } }, input())?.tone).toBe("danger");
    expect(fallbackOutcomeOf(undefined, decision, input())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The hook-free pieces, drawn.
// ---------------------------------------------------------------------------

describe("the drawn Inbox pieces", () => {
  const row = alertRowOf(alert("stuck", "wrk-1", 4, { detail: "no tool call for 20 min" }), input());

  it("draws an alert as one line with its time and action; the detail only when opened", () => {
    const onToggle = vi.fn();
    const onRun = vi.fn();
    const closed = renderTree(AlertRow({ row, expanded: false, onToggle, onRun, resend: undefined, compact: false, styles, theme }));
    expect(texts(closed)).toEqual(["●", "A Worker looks stuck · shop", "4 min ago ▸", "Open Worker"]);
    const [toggle, action] = pressables(closed);
    expect(toggle!.props["accessibilityLabel"]).toBe("A Worker looks stuck · shop, 4 min ago. Show the details");
    expect(toggle!.props["accessibilityState"]).toEqual({ expanded: false });
    expect(action!.props["accessibilityLabel"]).toBe("Open the Worker");
    (toggle!.props["onPress"] as () => void)();
    (action!.props["onPress"] as () => void)();
    expect(onToggle).toHaveBeenCalledOnce();
    expect(onRun).toHaveBeenCalledWith(row.action);
    // The dot takes the alert's tone from the theme.
    expect((allNodes(closed).find((node) => node.type === "Text")!.props["style"] as unknown[])[1]).toEqual({ color: "#statusWarning" });

    const open = renderTree(AlertRow({ row, expanded: true, onToggle, onRun, resend: undefined, compact: false, styles, theme }));
    expect(texts(open)).toEqual(expect.arrayContaining(["no tool call for 20 min", `Alert: stuck:${DECISION_WS}:wrk-1`]));
  });

  it("puts the action under the line on a phone and at its end on a wide screen", () => {
    const lineOf = (compact: boolean) =>
      (renderTree(AlertRow({ row, expanded: false, onToggle: noop, onRun: noop, resend: undefined, compact, styles, theme }))[0] as RNode).children[0] as RNode;
    expect(lineOf(true).props["style"]).toMatchObject({ flexDirection: "column" });
    expect(lineOf(false).props["style"]).toMatchObject({ flexDirection: "row" });
  });

  it("greys out a Resend in flight and shows its error", () => {
    const followUp = resendFollowUps([incident({ role: "reviewer", status: "switched", decidedAt: minutesAgo(3) })], new Set(), input())[0]!;
    const busy = renderTree(AlertRow({ row: followUp, expanded: false, onToggle: noop, onRun: noop, resend: { busy: true, error: null }, compact: true, styles, theme }));
    const button = pressables(busy)[1]!;
    expect(button.props["disabled"]).toBe(true);
    expect(button.props["accessibilityState"]).toEqual({ disabled: true, busy: true });
    expect(texts(busy)).toContain("Sending…");
    const failed = renderTree(AlertRow({ row: followUp, expanded: false, onToggle: noop, onRun: noop, resend: { busy: false, error: "Could not resend: E_X" }, compact: true, styles, theme }));
    expect(texts(failed)).toContain("Could not resend: E_X");
  });

  it("draws the empty Inbox as its sentence and a way to Work", () => {
    const onOpenWork = vi.fn();
    const nodes = renderTree(EmptyInbox({ sentence: emptySentence(2), onOpenWork, styles }));
    expect(texts(nodes)).toEqual(["Nothing needs you. 2 Workers are running.", "Open Work"]);
    const [work] = pressables(nodes);
    expect(work!.props["accessibilityRole"]).toBe("button");
    (work!.props["onPress"] as () => void)();
    expect(onOpenWork).toHaveBeenCalledOnce();
  });

  it("draws a fallback outcome with its action", () => {
    const onRun = vi.fn();
    const outcome = { text: "A new Beads Manager is running.", tone: "success", action: { kind: "open-agent", agentId: "mgr-2", label: "Open new Manager", accessibilityLabel: "Open the new Manager" } };
    const nodes = renderTree(OutcomeLine({ outcome, resend: undefined, onRun, styles, theme }));
    expect(texts(nodes)).toEqual(["A new Beads Manager is running.", "Open new Manager"]);
    (pressables(nodes)[0]!.props["onPress"] as () => void)();
    expect(onRun).toHaveBeenCalledWith(outcome.action);
    const plain = renderTree(InboxActionButton({ action: outcome.action, busy: false, onRun, styles }));
    expect(pressables(plain)[0]!.props["accessibilityState"]).toEqual({ disabled: false, busy: false });
  });
});

describe("the Orchestrator line at the top of the Inbox (autonomy design §A.12)", () => {
  const view = (state: Parameters<typeof orchestratorLineView>[0]) => orchestratorLineView(state, NOW);
  const row = (overrides: Record<string, unknown> = {}) =>
    renderTree(
      OrchestratorLineRow({
        view: view({ agent: null, toolsStale: false, outdated: false }),
        onPress: noop,
        busy: false,
        note: null,
        error: null,
        dialog: null,
        onConfirm: noop,
        onCancel: noop,
        styles,
        theme,
        ...overrides,
      }),
    );

  it("starts an Orchestrator behind its dialog, Cancel first, and only the confirm starts it", () => {
    const onPress = vi.fn();
    const start = row({ onPress });
    expect(texts(start)).toEqual(["Beads Orchestrator — not open", "Start the Orchestrator…"]);
    const button = pressables(start)[0]!;
    expect(button.props["accessibilityLabel"]).toBe("Start the Orchestrator");
    (button.props["onPress"] as () => void)();
    expect(onPress).toHaveBeenCalledTimes(1);

    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const dialog = openDialog({ exists: false, provider: "claude", model: null, workspace: "own" });
    const asking = row({ dialog, onConfirm, onCancel });
    // While the dialog shows, the line's own button is gone; the dialog's Cancel comes first.
    const [cancel, confirm] = pressables(asking);
    expect(cancel!.props["accessibilityLabel"]).toBe("Cancel");
    expect(confirm!.props["accessibilityLabel"]).toBe("Open Orchestrator");
    (cancel!.props["onPress"] as () => void)();
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("opens the chat of a current Orchestrator, and offers a new one, with the reason, when it lost its tools", () => {
    const agent = { id: "o1", status: "idle", workspaceId: "w" };
    expect(texts(row({ view: view({ agent, toolsStale: false, outdated: false }) }))).toEqual(["Beads Orchestrator — idle", "Orchestrator chat ▸"]);
    const stale = row({ view: view({ agent, toolsStale: true, outdated: false }) });
    expect(texts(stale)).toEqual(expect.arrayContaining(["Start a new Orchestrator…", TOOLS_STALE_TEXT]));
  });

  it("says what went wrong, and what to do when the host cannot open an agent", () => {
    expect(texts(row({ error: "E_ORCHESTRATOR_UNAVAILABLE: no profile" }))).toContain("E_ORCHESTRATOR_UNAVAILABLE: no profile");
    expect(texts(row({ note: OPEN_IN_APP_TEXT }))).toContain(OPEN_IN_APP_TEXT);
    expect(pressables(row({ busy: true }))[0]!.props).toMatchObject({ disabled: true });
  });
});

// ---------------------------------------------------------------------------
// Decided for you (autonomy design §B.7; PRD REQ-125; bead t9lm.15).
// ---------------------------------------------------------------------------

describe("Decided for you: what the policy and precedents answered since the owner last looked", () => {
  const SCOPE: DecisionOption[] = [
    { key: "a", label: "dd/mm/yyyy", recommended: true, effects: ["none"] },
    { key: "b", label: "yyyy-mm-dd", recommended: false, effects: ["commit"] },
  ];
  const POLICY_REASON = "The recommended option: scope is delegated to it in this project";
  const PRECEDENT_REASON = 'The owner\'s precedent on "date-format", saved 2026-09-20';

  /** A scope question of req-A answered for the owner — by the policy's recommended option unless told otherwise. */
  function decided(n: number, answeredMinutesAgo: number, answer: Partial<AnswerInput> = {}, overrides: Partial<Decision> = {}): Decision {
    const open = question("req-A", n, 60, { question: "Which date format on the invoices?", subject: "date-format", class: "scope", options: SCOPE, prediction: openingPrediction(SCOPE), ...overrides });
    const result = answerDecision(open, { by: "policy", via: "inbox", optionKey: "a", class: "scope", predictor: "recommended", reason: POLICY_REASON, at: minutesAgo(answeredMinutesAgo), ...answer });
    if (!result.ok) throw new Error(result.message);
    return result.decision;
  }
  const byPolicy = decided(1, 2);
  const byOrchestrator = decided(2, 5, { predictor: "orchestrator", reason: "Day first, as the owner writes." });
  const byPrecedent = decided(3, 8, { by: "precedent", predictor: undefined, precedentId: "p:9f1c", reason: PRECEDENT_REASON, optionKey: null, words: "Day first, always" });

  it("lists each answer with what was decided, the project, who decided and the reason, the latest first", () => {
    const section = decidedForYouOf(input({ digest: [byPolicy, byOrchestrator, byPrecedent], digestSince: minutesAgo(30) }));
    expect(section.count).toBe(3);
    expect(section.empty).toBeNull();
    expect(section.rows.map(({ what, where, reason, time }) => ({ what, where, reason, time }))).toEqual([
      { what: "Which date format on the invoices? → dd/mm/yyyy", where: "shop · your policy (recommended option)", reason: POLICY_REASON, time: "2 min ago" },
      { what: "Which date format on the invoices? → dd/mm/yyyy", where: "shop · your policy (the Orchestrator)", reason: "Day first, as the owner writes.", time: "5 min ago" },
      { what: 'Which date format on the invoices? → "Day first, always"', where: "shop · your precedent", reason: PRECEDENT_REASON, time: "8 min ago" },
    ]);
    expect(section.rows[0]!.accessibilityLabel).toBe("Decided for you: Which date format on the invoices? → dd/mm/yyyy, shop · your policy (recommended option), 2 min ago");
    // An Orchestrator's decision shows its question's first line, not its recommendation.
    const asked = decided(4, 1, {}, { id: "o:4b1f0c2e", askedBy: { role: "orchestrator", agentId: "orch-1" }, requestId: null, round: null, question: "Merge the fix now?\n\nRecommendation: merge it." });
    expect(digestRowOf(asked, input()).what).toBe("Merge the fix now? → dd/mm/yyyy");
  });

  it("never lists an owner's answer, nor one answered before the owner last looked", () => {
    const owners = answerDecision(question("req-A", 5, 60), { via: "inbox", optionKey: "c", at: minutesAgo(1) });
    if (!owners.ok) throw new Error("fixture");
    const before = decided(6, 45);
    const section = decidedForYouOf(input({ digest: [owners.decision, byPolicy, before], digestSince: minutesAgo(30) }));
    expect(section.rows.map((row) => decisionRow(row).decisionId)).toEqual([byPolicy.id]);
    // Never looked before: everything the digest holds that was decided for the owner.
    expect(decidedForYouOf(input({ digest: [owners.decision, byPolicy, before], digestSince: null })).rows.map((row) => decisionRow(row).decisionId)).toEqual([byPolicy.id, before.id]);
  });

  it("keeps the ids under Details, never in what the owner reads first", () => {
    for (const decision of [byPolicy, byOrchestrator, byPrecedent]) {
      const row = digestRowOf(decision, input());
      const face = [row.what, row.where, row.reason ?? "", row.time, row.accessibilityLabel, row.override?.state === "offered" ? row.override.accessibilityLabel : (row.override?.text ?? "")].join(" ");
      for (const id of [decision.id, "req-A", "p:9f1c", "wks_1"]) expect(face).not.toContain(id);
    }
    expect(digestRowOf(byPrecedent, input()).details).toEqual([
      "Decision: q:req-A:Q3",
      "Request: req-A",
      "Class: scope",
      "Precedent: p:9f1c",
      `Answered: ${minutesAgo(8)}`,
    ]);
  });

  it("offers Override; once overridden, says the owner's answer is awaited in Needs you, then only that it was overridden", () => {
    expect(digestRowOf(byPolicy, input()).override).toEqual({
      state: "offered",
      label: "Override",
      accessibilityLabel: 'Override "Which date format on the invoices?": it comes back to you as a question, and your answer replaces this one',
    });
    const overridden: Decision = { ...byPolicy, reversals: [{ kind: "overridden", at: minutesAgo(1), ref: "r:ov-1" }] };
    const override = makeDecision({ id: "r:ov-1", requestId: "req-A", supersedes: byPolicy.id, askedAt: minutesAgo(1) });
    const waiting = decisionRow(decidedForYouOf(input({ digest: [overridden], decisions: [override] })).rows[0]!);
    expect(waiting.override).toEqual({ state: "waiting", text: OVERRIDE_WAITING, tone: "warning" });
    expect(waiting.details).toContain("Override: r:ov-1");
    expect(decisionRow(decidedForYouOf(input({ digest: [overridden], decisions: [] })).rows[0]!).override).toEqual({ state: "done", text: OVERRIDE_DONE, tone: "muted" });
  });

  it("is shown but never counted, keeps the Inbox from reading as empty, and says when more was decided than shown", () => {
    const view = inboxView(input({ digest: [byPolicy], digestTruncated: true, runningWorkers: 2 }));
    expect(view.decidedForYou).toMatchObject({ count: 1, empty: null, truncated: true });
    expect(view.empty).toBeNull();
    expect(view.count).toBe(0);
    expect(inboxTab(view.count)).toEqual({ key: "inbox", label: "Inbox", hint: "nothing needs you" });
    expect(DECIDED_FOR_YOU_TRUNCATED).toBe("More was decided for you than the Inbox shows; Work has every decision.");
    expect(inboxView(input({ digest: [] })).decidedForYou.empty).toBe(DECIDED_FOR_YOU_EMPTY);
  });

  it("draws a line with its reason and Override; the ids only when opened", () => {
    const row = digestRowOf(byPolicy, input());
    const onToggle = vi.fn();
    const onOverride = vi.fn();
    const closed = renderTree(DigestRowView({ row, expanded: false, onToggle, onOverride, state: undefined, compact: false, styles, theme }));
    expect(texts(closed)).toEqual(["✓", "Which date format on the invoices? → dd/mm/yyyy", "2 min ago ▸", "shop · your policy (recommended option)", POLICY_REASON, "Override"]);
    expect(texts(closed).join(" ")).not.toContain(byPolicy.id);
    const [toggle, override] = pressables(closed);
    expect(toggle!.props["accessibilityLabel"]).toBe(`${row.accessibilityLabel}. Show the details`);
    expect(toggle!.props["accessibilityRole"]).toBe("button");
    expect(override!.props["accessibilityRole"]).toBe("button");
    expect(override!.props["accessibilityLabel"]).toBe(row.override?.state === "offered" ? row.override.accessibilityLabel : "");
    (toggle!.props["onPress"] as () => void)();
    (override!.props["onPress"] as () => void)();
    expect(onToggle).toHaveBeenCalledOnce();
    expect(onOverride).toHaveBeenCalledWith(byPolicy.id);

    const open = renderTree(DigestRowView({ row, expanded: true, onToggle, onOverride, state: undefined, compact: false, styles, theme }));
    expect(texts(open)).toEqual(expect.arrayContaining([`Decision: ${byPolicy.id}`, "Request: req-A", "Class: scope"]));
  });

  it("puts Override under the line on a phone and at its end on a wide screen; greys it while it runs and says a failure", () => {
    const row = digestRowOf(byPolicy, input());
    const lineOf = (compact: boolean) =>
      (renderTree(DigestRowView({ row, expanded: false, onToggle: noop, onOverride: noop, state: undefined, compact, styles, theme }))[0] as RNode).children[0] as RNode;
    expect(lineOf(true).props["style"]).toMatchObject({ flexDirection: "column" });
    expect(lineOf(false).props["style"]).toMatchObject({ flexDirection: "row" });

    const busy = renderTree(DigestRowView({ row, expanded: false, onToggle: noop, onOverride: noop, state: { busy: true, error: null }, compact: true, styles, theme }));
    const button = pressables(busy)[1]!;
    expect(button.props["disabled"]).toBe(true);
    expect(button.props["accessibilityState"]).toEqual({ disabled: true, busy: true });
    expect(texts(busy)).toContain("Overriding…");
    const failed = renderTree(DigestRowView({ row, expanded: false, onToggle: noop, onOverride: noop, state: { busy: false, error: "Could not override: E_X" }, compact: true, styles, theme }));
    expect(texts(failed)).toContain("Could not override: E_X");

    const overridden = digestRowOf({ ...byPolicy, reversals: [{ kind: "overridden", at: minutesAgo(1), ref: "r:ov-1" }] }, input(), new Set(["r:ov-1"]));
    const waiting = renderTree(DigestRowView({ row: overridden, expanded: false, onToggle: noop, onOverride: noop, state: undefined, compact: true, styles, theme }));
    expect(pressables(waiting)).toHaveLength(1);
    expect(texts(waiting)).toContain(OVERRIDE_WAITING);
  });

  it("draws the override in Needs you as the owner's decision, saying what it corrects, with no precedent offered back", () => {
    const override = makeDecision({ id: "r:ov-1", requestId: "req-A", supersedes: byPrecedent.id, subject: "date-format", options: SCOPE, askedAt: minutesAgo(1) });
    const item = needsYouGroups(input({ decisions: [override] }))[0]!.items[0]!;
    const shown = decisionCardView({ card: item.card, lookup: { state: "found", decision: override }, agents: [], ui: DECISION_UI_IDLE, cardAt: new Date(override.askedAt), now: NOW });
    expect(shown.frame.body).toEqual([OVERRIDE_CARD_LINE]);
    expect(shown.options.map((option) => option.key)).toEqual(["a", "b"]);
    expect(shown.details).toContain(`Supersedes: ${byPrecedent.id}`);
    // Expired with its request (§A.3), it says so, as a Worker's question does.
    const expired: Decision = { ...override, status: "expired", settledAt: minutesAgo(0) };
    expect(decisionCardView({ card: item.card, lookup: { state: "found", decision: expired }, agents: [], ui: DECISION_UI_IDLE, cardAt: new Date(override.askedAt), now: NOW }).frame.body).toEqual([
      "The request finished.",
    ]);
    const precedent: Precedent = {
      id: "p:9f1c",
      scope: DECISION_WS,
      subject: "date-format",
      text: "Day first, always",
      sourceDecisionId: null,
      createdAt: minutesAgo(60 * 24),
      expiresAt: new Date(NOW.getTime() + 20 * 24 * 60 * 60_000).toISOString(),
      supersededBy: null,
    };
    expect(precedentSuggestionView(override, [precedent], DECISION_UI_IDLE, NOW)).toBeNull();
    expect(precedentSuggestionView({ ...override, id: "q:req-A:Q9" }, [precedent], DECISION_UI_IDLE, NOW)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The Orchestrator's interventions in Decided for you (autonomy design §G.3;
// PRD REQ-127 c; bead t9lm.23).
// ---------------------------------------------------------------------------

describe("Decided for you: the Orchestrator's interventions since the owner last looked", () => {
  /** One intervention as `inbox.digest` returns it: `kind` done `minutes` ago, for a Worker, pending. */
  function intervention(kind: InterventionKind, minutes: number, overrides: Partial<DigestIntervention> = {}): DigestIntervention {
    return digestInterventionSchema.parse({
      id: `iv-${kind}-${minutes}`,
      kind,
      workspaceId: DECISION_WS,
      requestId: "req-A",
      targetAgentId: "wrk-7",
      trigger: "orchestrator",
      expected: EXPECTED_OUTCOME_OF[kind],
      windowMs: INTERVENTION_WINDOW_MS[kind],
      at: minutesAgo(minutes),
      outcome: "pending",
      checkedAt: null,
      targetRole: "worker",
      reason: null,
      ...overrides,
    });
  }

  /** A scope question answered for the owner `minutes` ago, by the policy's recommended option unless told otherwise. */
  function decidedFor(n: number, minutes: number, answer: Partial<AnswerInput> = {}): Decision {
    const options: DecisionOption[] = [
      { key: "a", label: "dd/mm/yyyy", recommended: true, effects: ["none"] },
      { key: "b", label: "yyyy-mm-dd", recommended: false, effects: ["commit"] },
    ];
    const open = question("req-A", n, 60, { question: "Which date format on the invoices?", subject: "date-format", class: "scope", options, prediction: openingPrediction(options) });
    const result = answerDecision(open, { by: "policy", via: "inbox", optionKey: "a", class: "scope", predictor: "recommended", reason: "The recommended option", at: minutesAgo(minutes), ...answer });
    if (!result.ok) throw new Error(result.message);
    return result.decision;
  }

  const unblock = intervention("unblock", 3, {
    trigger: "request.stalled",
    alertKey: "request-stalled:wks_1:req-A",
    commandId: "cmd-1",
    outcome: "met",
    checkedAt: minutesAgo(1),
    reason: "Told it to rerun the failing test once, then report.",
  });
  const correct = intervention("correct", 6, { trigger: "owner", targetRole: "manager", targetAgentId: "mgr-1", commandId: "cmd-2" });
  const stop = intervention("stop", 10, { trigger: "worker.signal", signal: "danger", commandId: "cmd-3", outcome: "missed", checkedAt: minutesAgo(4) });
  const advice = intervention("advice", 12, {
    trigger: "advice.due",
    requestId: null,
    targetAgentId: null,
    targetRole: "owner",
    decisionId: "o:4b1f0c2e",
    reason: "Delegate scope questions in this project?",
  });
  const compact = intervention("compact", 14, { outcome: "unknown", checkedAt: minutesAgo(2), targetRole: null });

  it("lists each one since the last look — what it did and for whom, the project, why, its outcome — merged with the decisions, the latest first", () => {
    const byPolicy = decidedFor(1, 2);
    const byOrchestrator = decidedFor(2, 5, { predictor: "orchestrator", reason: "Day first, as the owner writes." });
    const before = intervention("unblock", 45);
    const section = decidedForYouOf(
      input({ digest: [byPolicy, byOrchestrator], interventions: [unblock, correct, stop, advice, compact, before], digestSince: minutesAgo(30) }),
    );
    expect(section.count).toBe(7);
    expect(section.empty).toBeNull();
    expect(section.rows.map((row) => row.key)).toEqual([byPolicy.id, "intervention:iv-unblock-3", byOrchestrator.id, "intervention:iv-correct-6", "intervention:iv-stop-10", "intervention:iv-advice-12", "intervention:iv-compact-14"]);
    const lines = section.rows.filter((row) => row.kind === "intervention").map(({ what, where, reason, outcome, time }) => ({ what, where, reason, outcome: outcome?.text, time }));
    expect(lines).toEqual([
      {
        what: "Unblocked the Worker",
        where: "shop · the Orchestrator",
        reason: "The request stopped moving: Told it to rerun the failing test once, then report.",
        outcome: "Met · expected: the request moves again within 15 min",
        time: "3 min ago",
      },
      { what: "Corrected the Manager", where: "shop · the Orchestrator", reason: "You asked for it in the Orchestrator's chat.", outcome: "Pending · expected: the problem clears or the checks pass within 1 h", time: "6 min ago" },
      { what: "Stopped the Worker's turn", where: "shop · the Orchestrator", reason: "The Worker ran a risky command.", outcome: "Missed · expected: the turn ends within 2 min", time: "10 min ago" },
      { what: "Advised you", where: "shop · the Orchestrator", reason: "Advice was due for the project: Delegate scope questions in this project?", outcome: "Pending · expected: you answer it within 7 d", time: "12 min ago" },
      { what: "Had an agent compact its context", where: "shop · the Orchestrator", reason: "On the Orchestrator's own look.", outcome: "Unknown · expected: fewer tokens per turn within 1 h", time: "14 min ago" },
    ]);
    expect(section.rows[1]!.accessibilityLabel).toBe("The Orchestrator: Unblocked the Worker, shop · the Orchestrator, Met · expected: the request moves again within 15 min, 3 min ago");
    // Never looked before: every intervention the digest holds.
    expect(decidedForYouOf(input({ interventions: [unblock, before], digestSince: null })).rows.map((row) => row.key)).toEqual(["intervention:iv-unblock-3", "intervention:iv-unblock-45"]);
    // Another project, named without its id; one the surface no longer lists, without its id either.
    expect(interventionRowOf({ ...unblock, workspaceId: WS2 }, input()).where).toBe("xspace-master-data · the Orchestrator");
    expect(interventionRowOf({ ...unblock, workspaceId: "wks_gone" }, input()).where).toBe(`${UNKNOWN_PROJECT} · the Orchestrator`);
  });

  it("says every outcome as such — pending, met, missed, unknown — in its colour, with what was expected and by when", () => {
    expect(["pending", "met", "missed", "unknown"].map((outcome) => digestOutcomeOf({ ...unblock, outcome: outcome as DigestIntervention["outcome"] }))).toEqual([
      { outcome: "pending", text: "Pending · expected: the request moves again within 15 min", tone: "info" },
      { outcome: "met", text: "Met · expected: the request moves again within 15 min", tone: "success" },
      { outcome: "missed", text: "Missed · expected: the request moves again within 15 min", tone: "warning" },
      { outcome: "unknown", text: "Unknown · expected: the request moves again within 15 min", tone: "muted" },
    ]);
    // Every kind has its words, whoever it targeted or could not name.
    for (const kind of INTERVENTION_KINDS) {
      for (const targetRole of ["worker", "manager", null] as const) {
        const row = interventionRowOf(intervention(kind, 1, { targetRole: kind === "advice" ? "owner" : targetRole }), input());
        expect(row.what).not.toMatch(/undefined|null/);
        expect(row.outcome!.text).toMatch(/^Pending · expected: .+ within \d/);
      }
    }
    expect(interventionRowOf(intervention("unblock", 1, { targetRole: null }), input()).what).toBe("Unblocked a request");
    expect(interventionRowOf(intervention("answer", 1, { trigger: "decision.opened", decisionId: "q:req-A:Q9" }), input()).what).toBe("Answered the Worker's question");
    expect(interventionRowOf(intervention("handoff", 1), input()).what).toBe("Handed the Worker's work to a new Worker");
  });

  it("joins the Orchestrator's answer to its decision's line — its outcome there, no second line — and lists an answer without one on its own", () => {
    const byOrchestrator = decidedFor(2, 5, { predictor: "orchestrator", reason: "Day first, as the owner writes." });
    const answered = intervention("answer", 5, { trigger: "decision.opened", decisionId: byOrchestrator.id, outcome: "met", checkedAt: minutesAgo(3), reason: "Day first, as the owner writes." });
    const elsewhere = intervention("answer", 7, { decisionId: "q:req-B:Q1", requestId: "req-B", reason: "The Worker's own recommendation." });
    const section = decidedForYouOf(input({ digest: [byOrchestrator], interventions: [answered, elsewhere] }));
    expect(section.rows.map((row) => row.key)).toEqual([byOrchestrator.id, "intervention:iv-answer-7"]);
    const line = decisionRow(section.rows[0]!);
    expect(line.outcome).toEqual({ outcome: "met", text: "Met · expected: the Worker resumes within 10 min", tone: "success" });
    expect(line.override?.state).toBe("offered");
    expect(line.details.slice(-2)).toEqual(["Intervention: iv-answer-5", `Checked: ${minutesAgo(3)}`]);
    expect(line.accessibilityLabel).toBe("Decided for you: Which date format on the invoices? → dd/mm/yyyy, shop · your policy (the Orchestrator), Met · expected: the Worker resumes within 10 min, 5 min ago");
    expect(section.rows[1]).toMatchObject({ kind: "intervention", what: "Answered the Worker's question", reason: "On the Orchestrator's own look: The Worker's own recommendation." });
    // A decision the policy answered by itself carries no outcome.
    expect(digestRowOf(decidedFor(1, 2), input()).outcome).toBeNull();
  });

  it("keeps the ids under Details, never in what the owner reads first, and offers no Override", () => {
    for (const entry of [unblock, correct, stop, advice, compact]) {
      const row = interventionRowOf(entry, input());
      expect(row).not.toHaveProperty("override");
      const face = [row.what, row.where, row.reason ?? "", row.outcome?.text ?? "", row.time, row.accessibilityLabel].join(" ");
      for (const id of [entry.id, "req-A", "wrk-7", "mgr-1", "cmd-1", "cmd-2", "cmd-3", "o:4b1f0c2e", "request-stalled:", "wks_1"]) expect(face).not.toContain(id);
    }
    expect(interventionRowOf(unblock, input()).details).toEqual([
      "Intervention: iv-unblock-3",
      "Kind: unblock · trigger: request.stalled",
      "Request: req-A",
      "Agent: wrk-7",
      "Command: cmd-1",
      "Alert: request-stalled:wks_1:req-A",
      `At: ${minutesAgo(3)}`,
      `Checked: ${minutesAgo(1)}`,
    ]);
    expect(interventionRowOf(advice, input()).details).toEqual(["Intervention: iv-advice-12", "Kind: advice · trigger: advice.due", "Decision: o:4b1f0c2e", `At: ${minutesAgo(12)}`]);
  });

  it("is counted in Decided for you and keeps the Inbox from reading as empty, never in the tab; says when more happened than shown; the empty state is unchanged", () => {
    const view = inboxView(input({ interventions: [stop], interventionsTruncated: true, runningWorkers: 1 }));
    expect(view.decidedForYou).toMatchObject({ count: 1, empty: null, truncated: false, interventionsTruncated: true });
    expect(view.empty).toBeNull();
    expect(view.count).toBe(0);
    expect(INTERVENTIONS_TRUNCATED).toBe("The Orchestrator intervened more often than the Inbox shows; Insights → Coordination counts every intervention.");
    // Nothing since the last look: the same sentence as before, whatever came earlier.
    const quiet = inboxView(input({ interventions: [stop], digestSince: minutesAgo(5) }));
    expect(quiet.decidedForYou).toMatchObject({ count: 0, rows: [], empty: DECIDED_FOR_YOU_EMPTY, interventionsTruncated: false });
    expect(DECIDED_FOR_YOU_EMPTY).toBe("Nothing was decided for you since you last looked.");
  });

  it("draws a line with its mark, why and outcome in the outcome's colour, nothing to press but the line; the ids only when opened", () => {
    const row = interventionRowOf(unblock, input());
    const onToggle = vi.fn();
    const onOverride = vi.fn();
    const closed = renderTree(DigestRowView({ row, expanded: false, onToggle, onOverride, state: undefined, compact: false, styles, theme }));
    expect(texts(closed)).toEqual([
      "↪",
      "Unblocked the Worker",
      "3 min ago ▸",
      "shop · the Orchestrator",
      "The request stopped moving: Told it to rerun the failing test once, then report.",
      "Met · expected: the request moves again within 15 min",
    ]);
    const outcome = allNodes(closed).find((node) => node.type === "Text" && textOf(node).startsWith("Met ·"))!;
    expect(outcome.props["style"]).toEqual([{ name: "body" }, { color: "#statusSuccess" }]);
    const [toggle, ...rest] = pressables(closed);
    expect(rest).toEqual([]);
    expect(toggle!.props["accessibilityRole"]).toBe("button");
    expect(toggle!.props["accessibilityLabel"]).toBe(`${row.accessibilityLabel}. Show the details`);
    (toggle!.props["onPress"] as () => void)();
    expect(onToggle).toHaveBeenCalledOnce();
    expect(onOverride).not.toHaveBeenCalled();
    expect(texts(closed).join(" ")).not.toContain("iv-unblock-3");

    const open = renderTree(DigestRowView({ row, expanded: true, onToggle, onOverride, state: undefined, compact: false, styles, theme }));
    expect(texts(open)).toEqual(expect.arrayContaining(["Intervention: iv-unblock-3", "Command: cmd-1", "Request: req-A", "Agent: wrk-7"]));
  });

  it("fits a phone and a wide screen: the line stacks on a phone, runs across on a wide screen, and clamps until opened", () => {
    const row = interventionRowOf(unblock, input());
    const draw = (compact: boolean, expanded = false) => renderTree(DigestRowView({ row, expanded, onToggle: noop, onOverride: noop, state: undefined, compact, styles, theme }));
    const lineOf = (compact: boolean) => ((draw(compact)[0] as RNode).children[0] as RNode);
    expect(lineOf(true).props["style"]).toMatchObject({ flexDirection: "column", alignItems: "stretch" });
    expect(lineOf(false).props["style"]).toMatchObject({ flexDirection: "row", alignItems: "center" });
    // The line takes the width on a wide screen; on a phone it sizes to its content.
    expect(pressables(draw(false))[0]!.props["style"]).toMatchObject({ flex: 1 });
    expect(pressables(draw(true))[0]!.props["style"]).toMatchObject({ flex: undefined });
    for (const compact of [true, false]) {
      expect(texts(draw(compact))).toEqual(texts(draw(!compact)));
      expect(pressables(draw(compact))).toHaveLength(1);
      const reason = allNodes(draw(compact)).find((node) => node.type === "Text" && textOf(node).startsWith("The request stopped moving"))!;
      expect(reason.props["numberOfLines"]).toBe(2);
      const opened = allNodes(draw(compact, true)).find((node) => node.type === "Text" && textOf(node).startsWith("The request stopped moving"))!;
      expect(opened.props["numberOfLines"]).toBeUndefined();
    }
  });
});

describe("the writers-observed alert (autonomy design §F.1; bead i8fc.1)", () => {
  const detail = "src/math.js: Worker wrk-1 (request req-A) and Worker wrk-2 (request req-B) wrote it in overlapping turns.";
  const observed = alert("writers-observed", "src/math.js", 6, { detail });

  it("is listed in ALERT_KINDS order: after the Worker signals, before the role and instruction alerts", () => {
    const listed = orderedAlerts([alert("pairing-mismatch", "a-1", 30), observed, alert("stuck", "wrk-1", 2), alert("request-stalled", "req-A", 1)]);
    expect(listed.map((entry) => entry.kind)).toEqual(["request-stalled", "stuck", "writers-observed", "pairing-mismatch"]);
    expect(ALERT_KINDS.indexOf("writers-observed")).toBe(ALERT_KINDS.indexOf("stuck") + 1);
  });

  it("says it in general words with its project and time, opens the project, and keeps the file, agents and ids for Details", () => {
    const row = alertRowOf(observed, input());
    expect(row).toMatchObject({ tone: "warning", text: "Two agents edited one file at the same time · shop", time: "6 min ago" });
    expect(row.text).not.toContain("wrk-1");
    expect(row.text).not.toContain("src/math.js");
    expect(row.details).toEqual([detail, `Alert: writers-observed:${DECISION_WS}:src/math.js`, `Since: ${minutesAgo(6)}`]);
    expect(row.action).toEqual({ kind: "open-project", workspaceId: DECISION_WS, label: "Open project", accessibilityLabel: "Open the project" });
    expect(alertRowOf(observed, input({ can: { openAgent: true, openWorkspace: false } })).action).toBeNull();
    // Counted in the Inbox tab like every alert.
    expect(inboxView(input({ alerts: [observed] })).count).toBe(1);
  });

  it("is drawn at both widths: the action under the line on a phone, at its end on a wide screen; the detail only when opened", () => {
    const row = alertRowOf(observed, input());
    for (const compact of [true, false]) {
      const closed = renderTree(AlertRow({ row, expanded: false, onToggle: noop, onRun: noop, resend: undefined, compact, styles, theme }));
      expect(texts(closed), `compact ${compact}`).toEqual(["●", "Two agents edited one file at the same time · shop", "6 min ago ▸", "Open project"]);
      expect(((closed[0] as RNode).children[0] as RNode).props["style"]).toMatchObject({ flexDirection: compact ? "column" : "row" });
      const [toggle, open] = pressables(closed);
      expect(toggle!.props["accessibilityLabel"]).toBe("Two agents edited one file at the same time · shop, 6 min ago. Show the details");
      expect(open!.props["accessibilityLabel"]).toBe("Open the project");
      expect(texts(closed)).not.toContain(detail);
      const expanded = renderTree(AlertRow({ row, expanded: true, onToggle: noop, onRun: noop, resend: undefined, compact, styles, theme }));
      expect(texts(expanded)).toEqual(expect.arrayContaining([detail, `Alert: writers-observed:${DECISION_WS}:src/math.js`]));
    }
  });
});

// ── A held permission request (autonomy design §D.2, change-009 C6) ─────────

describe("a held request in the Inbox (§D.2)", () => {
  const heldOf = (command: string, id = "perm-1") =>
    heldDecisionOf({
      agentId: "agent-worker",
      permissionId: id,
      workspaceId: DECISION_WS,
      requestId: "req-A",
      question: `The Worker asks to run \`${command}\`. Held: ${command}. Allow it once?`,
      findings: boundaryVerdictOfCommand(command, { cwd: "/work/app", workspaceDirectory: "/work/app" }).findings,
      at: new Date(NOW.getTime() - 60_000).toISOString(),
    });

  it("is one Needs-you item: its command, Allow and Deny, no own words; Allow on a release asks for the confirmation", () => {
    const decision = heldOf("git push origin main");
    const groups = needsYouGroups(input({ decisions: [decision] }));
    expect(groups.flatMap((group) => group.items)).toHaveLength(1);
    const item = groups[0]!.items[0]!;
    const shown = decisionCardView({ card: item.card, lookup: { state: "found", decision }, agents: [], ui: DECISION_UI_IDLE, cardAt: new Date(decision.askedAt), now: NOW });
    expect(shown.frame.title).toContain("`git push origin main`");
    expect(shown.frame.body).toEqual([HELD_CARD_LINE]);
    expect(shown.options.map((option) => [option.label, option.primary, option.confirm])).toEqual([
      ["Allow once", false, true],
      ["Deny", false, false],
    ]);
    expect(shown.ownWords).toBe(false);
    expect(choiceNeedsConfirmation(decision, { optionKey: "allow" })).toBe(true);
    // The confirmation defaults to Cancel.
    const confirming = decisionCardView({ card: item.card, lookup: { state: "found", decision }, agents: [], ui: { ...DECISION_UI_IDLE, confirming: "allow" }, cardAt: new Date(decision.askedAt), now: NOW });
    expect(confirming.confirm).toMatchObject({ cancelLabel: "Cancel", defaultAction: "cancel" });
  });

  it("a network hold's Allow needs no confirmation", () => {
    expect(choiceNeedsConfirmation(heldOf("curl https://example.com"), { optionKey: "allow" })).toBe(false);
  });

  it("allowed by the policy, it shows in Decided for you without an Override: it already ran", () => {
    const answered = answerDecision(heldOf("npm install left-pad"), {
      by: "policy",
      via: "inbox",
      optionKey: "allow",
      predictor: "recommended",
      class: "dependency",
      at: new Date(NOW.getTime() - 30_000).toISOString(),
    });
    if (!answered.ok) throw new Error(answered.message);
    const row = digestRowOf(answered.decision, input());
    expect(row.what).toContain("Allow once");
    expect(row.override).toBeNull();
  });
});
