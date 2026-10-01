import { describe, expect, it, vi } from "vitest";
import {
  COORDINATION_MEANING,
  MECHANISM_THRESHOLDS,
  REVIEW_BUDGET_WORDS,
  changedReviewBudget,
  changedThresholds,
  coordinationDefaultsDraft,
  coordinationResetView,
  defaultsDraft,
  mechanismCardView,
  reviewBudgetCardView,
  reviewBudgetDefaultsDraft,
  reviewBudgetValueText,
  stepReviewBudget,
  mechanismsText,
  stepThreshold,
  switchedOffMechanisms,
  thresholdValueText,
  tokenCountText,
  turnOnDialog,
} from "../plugin/client/settings-coordination-model";
import { SETTINGS_GROUPS, coordinationGroupState } from "../plugin/client/settings-model";
import { DEFAULT_COORDINATION_SETTINGS, type CoordinationSettings } from "../plugin/shared/coordination";
import { allNodes, pressables, renderTree, texts } from "./helpers/element-tree";

/**
 * Settings → Coordination's compaction and handoff cards (autonomy design
 * §G.7; bead 7gxw.9): the pure model, and the hook-free card expanded with the
 * element-tree helper (`react-native` and the SDK being named stand-ins).
 */

// The root tsconfig has no `jsx`, so the .tsx module loads through a non-literal specifier.
const cardPath = "../plugin/client/settings-coordination.tsx";
type Component = (props: Record<string, unknown>) => unknown;
const { MechanismCard, ReviewBudgetCard } = (await import(cardPath)) as { MechanismCard: Component; ReviewBudgetCard: Component };

const styles = new Proxy({}, { get: (_target, key) => ({ name: String(key) }) });
const theme = { colors: new Proxy({}, { get: (_target, key) => `#${String(key)}` }) };
const noop = () => undefined;

const NOW = new Date("2026-10-01T12:00:00.000Z");
const D = DEFAULT_COORDINATION_SETTINGS;
const switchedOff = (mechanism: "compact" | "handoff", met = 6): CoordinationSettings => ({
  ...D,
  [mechanism]: { ...D[mechanism], enabled: false },
  guard: { ...D.guard, [mechanism]: { countsFrom: null, switchedOff: { at: "2026-10-01T09:00:00.000Z", met, checked: 10 } } },
});
const ownerOff = (mechanism: "compact" | "handoff"): CoordinationSettings => ({ ...D, [mechanism]: { ...D[mechanism], enabled: false } });
const view = (over: Partial<Parameters<typeof mechanismCardView>[0]> = {}) =>
  mechanismCardView({ mechanism: "compact", settings: D, defaults: D, draft: {}, saving: false, now: NOW, ...over });

describe("the thresholds' words and steps", () => {
  it("writes token counts in a few characters and each threshold in words", () => {
    expect([390_000, 5_700_000, 150_000_000, 1_250_000, 50_000, 999].map(tokenCountText)).toEqual(["390k", "5.7M", "150M", "1.25M", "50k", "999"]);
    expect(thresholdValueText("compact.workerTokensPerTurn", 5_700_000)).toBe("5.7M tokens read");
    expect(thresholdValueText("compact.contextShare", 0.55)).toBe("55% of the window");
    expect(thresholdValueText("handoff.maxPerRequest", 2)).toBe("at most 2");
  });

  it("steps a token threshold along 1-1.2-1.5-2-2.5-3-4-5-6-8 per decade, the context share by 5 points, a count by one, within the bounds", () => {
    expect([stepThreshold("compact.managerTokensPerTurn", 390_000, 1), stepThreshold("compact.managerTokensPerTurn", 390_000, -1)]).toEqual([400_000, 300_000]);
    expect([stepThreshold("compact.workerTokensPerTurn", 5_700_000, 1), stepThreshold("compact.workerTokensPerTurn", 5_700_000, -1)]).toEqual([6_000_000, 5_000_000]);
    expect([stepThreshold("handoff.requestTokens", 150_000_000, 1), stepThreshold("handoff.requestTokens", 150_000_000, -1)]).toEqual([200_000_000, 120_000_000]);
    expect(stepThreshold("compact.workerTokensPerTurn", 8_000_000, 1)).toBe(10_000_000);
    expect(stepThreshold("compact.workerTokensPerTurn", 1_000_000, -1)).toBe(800_000);
    // The bounds hold.
    expect(stepThreshold("compact.managerTokensPerTurn", 50_000, -1)).toBe(50_000);
    expect(stepThreshold("compact.managerTokensPerTurn", 100_000_000, 1)).toBe(100_000_000);
    expect(stepThreshold("handoff.requestTokens", 10_000_000, -1)).toBe(10_000_000);
    expect([stepThreshold("compact.contextShare", 0.5, 1), stepThreshold("compact.contextShare", 0.5, -1)]).toEqual([0.55, 0.45]);
    expect([stepThreshold("compact.contextShare", 0.9, 1), stepThreshold("compact.contextShare", 0.1, -1)]).toEqual([0.9, 0.1]);
    expect([stepThreshold("compact.maxPerAgent", 2, 1), stepThreshold("compact.maxPerAgent", 1, -1), stepThreshold("handoff.maxPerRequest", 5, 1)]).toEqual([3, 1, 5]);
  });
});

describe("a mechanism's card (autonomy design §G.7)", () => {
  it("at the defaults: On, Turn off, each threshold with − and +, nothing to save, no defaults to restore", () => {
    const card = view();
    expect(card).toMatchObject({ title: "Compaction", status: { text: "On", tone: "success" }, save: { enabled: false, label: "Save" }, reset: null });
    expect(card.meaning).toBe("When an agent's turns grow heavy, the Orchestrator may have it compact its conversation, without asking you.");
    expect(card.note).toBe("A Claude turn is judged by its tokens read, a Codex or OpenCode turn by how full its context is.");
    expect(card.toggle).toEqual({ turnsOn: false, enabled: true, label: "Turn off", accessibilityLabel: "Turn compaction off now" });
    expect(card.rows.map((row) => [row.label, row.valueText])).toEqual([
      ["Manager turn", "390k tokens read"],
      ["Worker turn", "5.7M tokens read"],
      ["Context", "50% of the window"],
      ["Per agent", "at most 2"],
    ]);
    expect(card.rows[0]!.decrease).toEqual({ enabled: true, label: "−", accessibilityLabel: "Manager turn threshold: lower to 300k tokens read" });
    expect(card.rows[0]!.increase).toEqual({ enabled: true, label: "+", accessibilityLabel: "Manager turn threshold: raise to 400k tokens read" });
    const handoff = view({ mechanism: "handoff" });
    expect(handoff.title).toBe("Handoff");
    expect(handoff.note).toBeNull();
    expect(handoff.rows.map((row) => [row.label, row.valueText])).toEqual([
      ["Request", "150M tokens read"],
      ["Per request", "at most 2"],
    ]);
    expect(MECHANISM_THRESHOLDS.handoff).toEqual(["handoff.requestTokens", "handoff.maxPerRequest"]);
  });

  it("offers Save for a changed threshold and the defaults away from them; Save sends one change per setting, in order", () => {
    const draft = { "compact.contextShare": 0.6, "compact.managerTokensPerTurn": 390_000, "compact.maxPerAgent": 1 };
    const card = view({ draft });
    expect(card.save).toEqual({ enabled: true, label: "Save", accessibilityLabel: "Save the compaction thresholds" });
    expect(card.reset).toEqual({ enabled: true, label: "Use the defaults", accessibilityLabel: "Set the compaction thresholds back to their defaults" });
    expect(card.rows[3]!.decrease.enabled).toBe(false);
    expect(changedThresholds("compact", D, draft)).toEqual([
      { key: "compact.contextShare", value: 0.6 },
      { key: "compact.maxPerAgent", value: 1 },
    ]);
    // Stored away from the defaults: "Use the defaults" puts them in the draft, which Save sends.
    const stored = { ...D, handoff: { ...D.handoff, requestTokens: 200_000_000 } };
    expect(view({ mechanism: "handoff", settings: stored }).reset).not.toBeNull();
    expect(defaultsDraft("handoff", D)).toEqual({ "handoff.requestTokens": 150_000_000, "handoff.maxPerRequest": 2 });
    expect(changedThresholds("handoff", stored, defaultsDraft("handoff", D))).toEqual([{ key: "handoff.requestTokens", value: 150_000_000 }]);
  });

  it("disables everything while saving", () => {
    const card = view({ draft: { "compact.maxPerAgent": 3 }, saving: true });
    expect(card.save).toMatchObject({ enabled: false, label: "Saving…" });
    expect([card.toggle.enabled, card.reset?.enabled, ...card.rows.flatMap((row) => [row.decrease.enabled, row.increase.enabled])].every((enabled) => enabled === false)).toBe(true);
  });

  it("says Off when the owner switched it off, and why when paseo-bm did, with Turn on… after a confirmation that defaults to Cancel", () => {
    expect(view({ settings: ownerOff("compact") }).status).toEqual({ text: "Off", tone: "muted" });
    const card = view({ mechanism: "handoff", settings: switchedOff("handoff") });
    expect(card.status).toEqual({ text: "Switched off by paseo-bm 3 h ago: only 6 of its last 10 met their goal (target 8).", tone: "warning" });
    expect(card.toggle).toEqual({ turnsOn: true, enabled: true, label: "Turn on…", accessibilityLabel: "Turn handoff on, after a confirmation" });
    expect(turnOnDialog("handoff", switchedOff("handoff"))).toEqual({
      title: "Turn handoff on?",
      body: "The Orchestrator may then have the Manager hand a heavy request to a fresh Worker without asking you. paseo-bm switched it off because only 6 of its last 10 met their goal (target 8). Its record counts afresh from now.",
      confirmLabel: "Turn on",
      cancelLabel: "Cancel",
      confirmAccessibilityLabel: "Turn handoff on",
      cancelAccessibilityLabel: "Keep handoff off",
      defaultAction: "cancel",
    });
    expect(turnOnDialog("compact", ownerOff("compact")).body).toBe(
      "The Orchestrator may then have a Manager or a Worker compact its conversation without asking you. Its record counts afresh from now.",
    );
  });
});

describe("the Coordination group's line", () => {
  it("names the cadence and both switches, and puts a mechanism paseo-bm switched off first, as a warning", () => {
    // Coordination is open on the screen (change-014): not one of More's folded groups.
    expect(SETTINGS_GROUPS.map((group) => group.key)).not.toContain("coordination");
    expect(COORDINATION_MEANING.split("\n")).toHaveLength(1);
    expect(mechanismsText(D)).toBe("compaction and handoff on");
    expect(mechanismsText(ownerOff("handoff"))).toBe("compaction on, handoff off");
    expect(mechanismsText({ ...ownerOff("compact"), handoff: { ...D.handoff, enabled: false } })).toBe("compaction and handoff off");
    expect(coordinationGroupState(ownerOff("compact"))).toEqual({ text: "Advice after every 5 finished requests · compaction off, handoff on", tone: "muted" });
    expect(switchedOffMechanisms(switchedOff("compact"))).toEqual(["compact"]);
    expect(coordinationGroupState(switchedOff("compact"))).toEqual({ text: "Compaction switched off below its target · Advice after every 5 finished requests", tone: "warning" });
    const both: CoordinationSettings = { ...switchedOff("compact"), handoff: { ...D.handoff, enabled: false }, guard: { ...switchedOff("compact").guard, handoff: switchedOff("handoff").guard.handoff } };
    expect(coordinationGroupState(both).text).toBe("Compaction and handoff switched off below their target · Advice after every 5 finished requests");
  });
});

describe("Reset coordination to defaults (change-014 outcome 5)", () => {
  it("fills every card's draft with the defaults — the cadence, both mechanisms' thresholds, the review budget — and saves nothing itself", () => {
    const changed: CoordinationSettings = { ...D, advice: { everyFinished: 9 } };
    const drafts = coordinationDefaultsDraft(D);
    expect(drafts.advice).toBe(D.advice.everyFinished);
    expect(drafts.thresholds).toEqual({ ...defaultsDraft("compact", D), ...defaultsDraft("handoff", D) });
    expect(Object.keys(drafts.thresholds).sort()).toEqual([...MECHANISM_THRESHOLDS.compact, ...MECHANISM_THRESHOLDS.handoff].sort());
    expect(drafts.review).toEqual(reviewBudgetDefaultsDraft(D));
    // Against stored defaults the drafts change nothing; a card's Save sends only what differs.
    expect(changedThresholds("compact", D, drafts.thresholds)).toEqual([]);
    expect(changedReviewBudget(changed, drafts.review)).toEqual([]);
    expect(coordinationResetView(false)).toEqual({
      enabled: true,
      label: "Reset coordination to defaults",
      accessibilityLabel: "Fill every coordination setting with its default; each card saves with its own Save",
    });
    expect(coordinationResetView(true).enabled).toBe(false);
  });
});

describe("MechanismCard (hook-free)", () => {
  const draw = (props: Record<string, unknown>) =>
    renderTree(
      MechanismCard({
        dialog: null,
        busy: false,
        error: null,
        onToggle: noop,
        onConfirm: noop,
        onCancel: noop,
        onStep: noop,
        onSave: noop,
        onReset: noop,
        styles,
        theme,
        ...props,
      }),
    );

  it("draws the title and switch, the status, the meaning, each threshold with − and +, the note, Save and the defaults; every pressable a labelled button", () => {
    const onStep = vi.fn();
    const onToggle = vi.fn();
    const onSave = vi.fn();
    const onReset = vi.fn();
    const card = view({ draft: { "compact.workerTokensPerTurn": 6_000_000 } });
    const nodes = draw({ view: card, onStep, onToggle, onSave, onReset });
    expect(texts(nodes)).toEqual([
      "Compaction",
      "Turn off",
      "On",
      card.meaning,
      "Manager turn",
      "−",
      "390k tokens read",
      "+",
      "Worker turn",
      "−",
      "6M tokens read",
      "+",
      "Context",
      "−",
      "50% of the window",
      "+",
      "Per agent",
      "−",
      "at most 2",
      "+",
      card.note,
      "Save",
      "Use the defaults",
    ]);
    const buttons = pressables(nodes);
    expect(buttons.every((button) => button.props.accessibilityRole === "button" && typeof button.props.accessibilityLabel === "string")).toBe(true);
    expect(buttons.map((button) => button.props.accessibilityLabel)).toContain("Worker turn threshold: raise to 8M tokens read");
    for (const button of buttons) (button.props.onPress as () => void)();
    expect(onToggle).toHaveBeenCalledOnce();
    expect(onStep.mock.calls).toEqual([
      ["compact.managerTokensPerTurn", -1],
      ["compact.managerTokensPerTurn", 1],
      ["compact.workerTokensPerTurn", -1],
      ["compact.workerTokensPerTurn", 1],
      ["compact.contextShare", -1],
      ["compact.contextShare", 1],
      ["compact.maxPerAgent", -1],
      ["compact.maxPerAgent", 1],
    ]);
    expect(onSave).toHaveBeenCalledOnce();
    expect(onReset).toHaveBeenCalledOnce();
    const status = allNodes(nodes).find((node) => node.type === "Text" && texts([node])[0] === "On")!;
    expect(JSON.stringify(status.props.style)).toContain("#statusSuccess");
  });

  it("while turning on is asked: the switch gives way to the confirmation, Cancel first; a failed save shows in the danger colour", () => {
    const settings = switchedOff("compact");
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const nodes = draw({
      view: view({ settings }),
      dialog: turnOnDialog("compact", settings),
      onCancel,
      onConfirm,
      error: "E_COORDINATION_WRITE_FAILED: cannot save the coordination settings",
    });
    const labels = pressables(nodes).map((button) => texts([button])[0]);
    expect(labels).not.toContain("Turn on…");
    expect(labels.slice(0, 2)).toEqual(["Cancel", "Turn on"]);
    (pressables(nodes)[0]!.props.onPress as () => void)();
    (pressables(nodes)[1]!.props.onPress as () => void)();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).toHaveBeenCalledOnce();
    const status = allNodes(nodes).find((node) => node.type === "Text" && texts([node])[0]?.startsWith("Switched off by paseo-bm"))!;
    expect(JSON.stringify(status.props.style)).toContain("#statusWarning");
    const error = allNodes(nodes).find((node) => node.type === "Text" && texts([node])[0]?.startsWith("E_COORDINATION_WRITE_FAILED"))!;
    expect(JSON.stringify(error.props.style)).toContain("#statusDanger");
  });
});

// Bead 7gxw.12 (autonomy design §C.4, §G.7; change-008 C6): the review budget per tier, below compaction and handoff.
describe("the review budget card (autonomy design §G.7)", () => {
  const budgetView = (over: Partial<Parameters<typeof reviewBudgetCardView>[0]> = {}) =>
    reviewBudgetCardView({ settings: D, defaults: D, draft: {}, saving: false, ...over });
  const stored = (small: number, medium: number, large: number): CoordinationSettings => ({ ...D, review: { smallBudget: small, mediumBudget: medium, largeBudget: large } });

  it("steps a tier's budget by one call, within 2 to 8: never below one review and its re-review", () => {
    expect(stepReviewBudget("review.smallBudget", 2, -1)).toBe(2);
    expect(stepReviewBudget("review.smallBudget", 2, 1)).toBe(3);
    expect(stepReviewBudget("review.largeBudget", 8, 1)).toBe(8);
    expect(stepReviewBudget("review.largeBudget", 8, -1)).toBe(7);
    expect(reviewBudgetValueText(2)).toBe("2 review calls");
  });

  it("at the defaults: Small, Medium and Large with − and +, − off at the minimum, nothing to save, no defaults to restore", () => {
    const card = budgetView();
    expect(card).toMatchObject({ title: "Review budget", meaning: REVIEW_BUDGET_WORDS.meaning, note: REVIEW_BUDGET_WORDS.note, reset: null });
    expect(card.rows.map((row) => [row.label, row.key, row.valueText, row.decrease.enabled, row.increase.enabled])).toEqual([
      ["Small", "review.smallBudget", "2 review calls", false, true],
      ["Medium", "review.mediumBudget", "2 review calls", false, true],
      ["Large", "review.largeBudget", "4 review calls", true, true],
    ]);
    expect(card.rows[2]!.increase.accessibilityLabel).toBe("Review budget of a Large request: raise to 5 review calls");
    expect(card.rows[2]!.decrease.accessibilityLabel).toBe("Review budget of a Large request: lower to 3 review calls");
    expect(card.save).toEqual({ enabled: false, label: "Save", accessibilityLabel: "Save the review budget" });
    // + off at the maximum.
    expect(budgetView({ settings: stored(8, 2, 4) }).rows[0]!.increase.enabled).toBe(false);
  });

  it("offers Save for a changed budget only, and the defaults away from them; Save sends one coordination.set per tier, Small first", () => {
    const draft = { "review.largeBudget": 6, "review.smallBudget": 3, "review.mediumBudget": 2 };
    const card = budgetView({ draft });
    expect(card.rows.map((row) => row.valueText)).toEqual(["3 review calls", "2 review calls", "6 review calls"]);
    expect(card.save.enabled).toBe(true);
    expect(card.reset).toEqual({ enabled: true, label: "Use the defaults", accessibilityLabel: "Set the review budget back to its defaults" });
    expect(changedReviewBudget(D, draft)).toEqual([
      { key: "review.smallBudget", value: 3 },
      { key: "review.largeBudget", value: 6 },
    ]);
    // A draft back at the stored value changes nothing: Save stays off.
    expect(budgetView({ draft: { "review.largeBudget": 4 } }).save.enabled).toBe(false);
    // Stored away from the defaults: "Use the defaults" shows them as a draft, which Save then sends.
    const owner = stored(3, 4, 6);
    expect(budgetView({ settings: owner }).reset).not.toBeNull();
    const back = reviewBudgetDefaultsDraft(D);
    expect(back).toEqual({ "review.smallBudget": 2, "review.mediumBudget": 2, "review.largeBudget": 4 });
    expect(budgetView({ settings: owner, draft: back })).toMatchObject({ reset: null, save: { enabled: true } });
    expect(changedReviewBudget(owner, back)).toEqual([
      { key: "review.smallBudget", value: 2 },
      { key: "review.mediumBudget", value: 2 },
      { key: "review.largeBudget", value: 4 },
    ]);
  });

  it("disables everything while saving", () => {
    const card = budgetView({ draft: { "review.largeBudget": 6 }, saving: true });
    expect(card.rows.every((row) => !row.decrease.enabled && !row.increase.enabled)).toBe(true);
    expect(card.save).toMatchObject({ enabled: false, label: "Saving…" });
    expect(card.reset).toMatchObject({ enabled: false });
  });

  it("ReviewBudgetCard (hook-free): the title, the meaning, each tier with − and +, the note, Save and the defaults; every pressable a labelled button", () => {
    const onStep = vi.fn();
    const onSave = vi.fn();
    const onReset = vi.fn();
    const card = budgetView({ draft: { "review.largeBudget": 6 } });
    const nodes = renderTree(ReviewBudgetCard({ view: card, error: null, onStep, onSave, onReset, styles, theme }));
    expect(texts(nodes)).toEqual([
      "Review budget",
      card.meaning,
      "Small",
      "−",
      "2 review calls",
      "+",
      "Medium",
      "−",
      "2 review calls",
      "+",
      "Large",
      "−",
      "6 review calls",
      "+",
      card.note,
      "Save",
      "Use the defaults",
    ]);
    const buttons = pressables(nodes);
    expect(buttons.every((button) => button.props.accessibilityRole === "button" && typeof button.props.accessibilityLabel === "string")).toBe(true);
    for (const button of buttons) (button.props.onPress as () => void)();
    expect(onStep.mock.calls).toEqual([
      ["review.smallBudget", -1],
      ["review.smallBudget", 1],
      ["review.mediumBudget", -1],
      ["review.mediumBudget", 1],
      ["review.largeBudget", -1],
      ["review.largeBudget", 1],
    ]);
    expect(onSave).toHaveBeenCalledOnce();
    expect(onReset).toHaveBeenCalledOnce();
    const failed = renderTree(ReviewBudgetCard({ view: card, error: "E_COORDINATION_INVALID: review.largeBudget must be a whole number from 2 to 8", onStep, onSave, onReset, styles, theme }));
    const error = allNodes(failed).find((node) => node.type === "Text" && texts([node])[0]?.startsWith("E_COORDINATION_INVALID"))!;
    expect(JSON.stringify(error.props.style)).toContain("#statusDanger");
  });
});
