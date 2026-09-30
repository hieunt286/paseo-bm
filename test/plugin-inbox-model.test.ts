import { describe, expect, it, vi } from "vitest";
import {
  DECIDED_FOR_YOU_EMPTY,
  EMPTY_INBOX,
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
  type InboxInput,
} from "../plugin/client/inbox-model";
import { DECISION_UI_IDLE, choiceNeedsConfirmation, decisionCardView, type DecisionUi } from "../plugin/client/chat-cards";
import { OPEN_IN_APP_TEXT, TOOLS_STALE_TEXT, openDialog, orchestratorLineView } from "../plugin/client/orchestrator-model";
import { ALERT_KINDS, alertKeyOf, type Alert, type AlertKind } from "../plugin/shared/alerts";
import type { FallbackIncident } from "../plugin/shared/contracts";
import { CONFIRM_EFFECTS, EFFECTS, answerDecision, markNeedsConfirmation, type Decision, type Effect } from "../plugin/shared/decisions";
import { DECISION_WS, makeDecision } from "./helpers/decisions";
import { allNodes, pressables, renderTree, texts, type RNode } from "./helpers/element-tree";

/**
 * The Inbox (experience concept §4.1, autonomy design §A.12): its model is
 * pure and tested here; its hook-free pieces (`AlertRow`, `EmptyInbox`,
 * `OutcomeLine`, and the chats' `DecisionCardBody` it reuses) are expanded
 * with the element-tree helper. `react-native` and the SDK icon are named
 * stand-ins.
 */

vi.mock("react-native", () => {
  const make = (name: string) => Object.assign(() => null, { displayName: name, primitive: true });
  return {
    ActivityIndicator: make("ActivityIndicator"),
    Pressable: make("Pressable"),
    ScrollView: make("ScrollView"),
    Text: make("Text"),
    TextInput: make("TextInput"),
    View: make("View"),
  };
});
vi.mock("@getpaseo/plugin/client/react-native", () => ({ Icon: Object.assign(() => null, { displayName: "Icon", primitive: true }) }));

// The root tsconfig has no `jsx`, so the .tsx modules load through non-literal specifiers.
const inboxPath = "../plugin/client/inbox.tsx";
const uiPath = "../plugin/client/ui.tsx";
const cardPath = "../plugin/client/chat-card.tsx";
const orchestratorLinePath = "../plugin/client/orchestrator-line.tsx";
type Component = (props: Record<string, unknown>) => unknown;
const { AlertRow, EmptyInbox, OutcomeLine, InboxActionButton } = (await import(inboxPath)) as {
  AlertRow: Component;
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
    const decided = answerDecision(open, { by: "orchestrator", via: "autopilot", optionKey: "c", reason: "Hold until the review is in.", at: minutesAgo(1) });
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

  it("has Decided for you empty until delegation exists, and headings with counts", () => {
    expect(inboxView(input({ decisions: [question("req-A", 1, 1)] })).decidedForYou).toEqual({ empty: DECIDED_FOR_YOU_EMPTY });
    expect(sectionHeading("Needs you", 2)).toBe("Needs you · 2");
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

  it("offers Keep open / Close as answered, and no option, on a decision that needs confirmation", () => {
    const decision = markNeedsConfirmation(question("req-A", 1, 10), { via: "chat-worker", at: minutesAgo(2) });
    if (!decision.ok) throw new Error("fixture");
    const shown = cardOf(decision.decision);
    expect([shown.confirmChat, shown.options, shown.ownWords]).toEqual([true, [], false]);
    const onCloseInChat = vi.fn();
    const nodes = draw(shown, DECISION_UI_IDLE, { onCloseInChat });
    const [keep, close] = pressables(nodes);
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
