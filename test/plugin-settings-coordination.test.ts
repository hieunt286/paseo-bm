import { describe, expect, it, vi } from "vitest";
import {
  COORDINATION_CARDS,
  COORDINATION_MEANING,
  MECHANISM_THRESHOLDS,
  REVIEW_KEYS,
  REVIEW_WORDS,
  CI_CARD_WORDS,
  changedReview,
  changedThresholds,
  ciCardView,
  ciToggleChange,
  coordinationDefaultsDraft,
  coordinationInputText,
  helpedText,
  inputErrorsOf,
  parseCoordinationInput,
  coordinationResetView,
  defaultsDraft,
  mechanismCardView,
  reviewCapsText,
  reviewCardView,
  reviewDefaultsDraft,
  reviewValueText,
  stepReview,
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
const { MechanismCard, ReviewCard } = (await import(cardPath)) as { MechanismCard: Component; ReviewCard: Component };

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

describe("a Main's context tokens on the compaction card (delivery line design §18.4)", () => {
  it("reads, steps and refuses `main.contextTokens` as a context-token figure within 50 K to 2 M; Save sends its own change", () => {
    expect(MECHANISM_THRESHOLDS.compact).toContain("main.contextTokens");
    expect(thresholdValueText("main.contextTokens", 150_000)).toBe("context 150k");
    expect(coordinationInputText("main.contextTokens", 150_000)).toBe("150 K");
    expect(parseCoordinationInput("main.contextTokens", "200 K")).toEqual({ value: 200_000, error: null });
    expect(parseCoordinationInput("main.contextTokens", "1.5M")).toEqual({ value: 1_500_000, error: null });
    expect(parseCoordinationInput("main.contextTokens", "40k")).toEqual({ value: null, error: "Compact a Main at: a number from 50 K to 2 M." });
    expect(parseCoordinationInput("main.contextTokens", "3M").error).toBe("Compact a Main at: a number from 50 K to 2 M.");
    expect([stepThreshold("main.contextTokens", 150_000, 1), stepThreshold("main.contextTokens", 150_000, -1)]).toEqual([200_000, 120_000]);
    expect(stepThreshold("main.contextTokens", 50_000, -1)).toBe(50_000);
    expect(stepThreshold("main.contextTokens", 2_000_000, 1)).toBe(2_000_000);
    const row = view({ draft: { "main.contextTokens": 200_000 } }).rows.find((entry) => entry.key === "main.contextTokens")!;
    expect(row).toMatchObject({ label: "Compact a Main at", valueText: "context 200k", inputText: "200 K" });
    expect(row.decrease.accessibilityLabel).toBe("Main compaction context: lower to context 150k");
    expect(changedThresholds("compact", D, { "main.contextTokens": 200_000 })).toEqual([{ key: "main.contextTokens", value: 200_000 }]);
    expect(defaultsDraft("compact", D)["main.contextTokens"]).toBe(D.main.contextTokens);
  });
});

describe("the fields' text (the approved mockup's number inputs)", () => {
  it("shows a token count with K or M, the context share in percent, a count as it is", () => {
    expect(coordinationInputText("compact.managerTokensPerTurn", 390_000)).toBe("390 K");
    expect(coordinationInputText("compact.workerTokensPerTurn", 5_700_000)).toBe("5.7 M");
    expect(coordinationInputText("handoff.requestTokens", 150_000_000)).toBe("150 M");
    expect(coordinationInputText("compact.contextShare", 0.5)).toBe("50 %");
    expect(coordinationInputText("compact.maxPerAgent", 2)).toBe("2");
    expect(coordinationInputText("advice.everyFinished", 0)).toBe("0");
  });

  it("reads typed text in the same units, and refuses what is not a number or is out of bounds, in the field's own words", () => {
    expect(parseCoordinationInput("compact.managerTokensPerTurn", "400k")).toEqual({ value: 400_000, error: null });
    expect(parseCoordinationInput("compact.managerTokensPerTurn", " 1.2 M ")).toEqual({ value: 1_200_000, error: null });
    expect(parseCoordinationInput("compact.managerTokensPerTurn", "390000")).toEqual({ value: 390_000, error: null });
    expect(parseCoordinationInput("compact.contextShare", "55 %")).toEqual({ value: 0.55, error: null });
    expect(parseCoordinationInput("compact.contextShare", "60")).toEqual({ value: 0.6, error: null });
    expect(parseCoordinationInput("review.callsPerBatch", "6")).toEqual({ value: 6, error: null });
    expect(parseCoordinationInput("advice.everyFinished", "0")).toEqual({ value: 0, error: null });
    expect(parseCoordinationInput("compact.maxPerAgent", "9")).toEqual({ value: null, error: "At most, per agent: a number from 1 to 5." });
    expect(parseCoordinationInput("compact.managerTokensPerTurn", "lots").error).toBe("Main reads more than, per turn: a number from 50 K to 100 M.");
    expect(parseCoordinationInput("compact.contextShare", "95").error).toBe("Or its context window is fuller than: a number from 10 % to 90 %.");
    expect(parseCoordinationInput("review.callsPerBatch", "1").error).toBe("Calls per milestone batch: a number from 2 to 6.");
    expect(parseCoordinationInput("review.maxRereviews", "7").error).toBe("Re-reviews per batch: a number from 1 to 6.");
    expect(inputErrorsOf(["compact.maxPerAgent", "compact.contextShare"], { "compact.maxPerAgent": "3", "compact.contextShare": "x" })).toEqual([
      "Or its context window is fuller than: a number from 10 % to 90 %.",
    ]);
  });

  it("says how often a mechanism helped by the figures paseo-bm switched it off on, else a dash", () => {
    expect(helpedText("compact", D)).toBe("helped —");
    expect(helpedText("handoff", switchedOff("handoff"))).toBe("helped 6 of 10");
  });
});

describe("a mechanism's card (autonomy design §G.7)", () => {
  it("at the defaults: On, Turn off, each threshold with − and +, nothing to save, no defaults to restore", () => {
    const card = view();
    expect(card).toMatchObject({ title: "Compact", helped: "helped —", status: { text: "On", tone: "success" }, save: { enabled: false, label: "Save" }, reset: null });
    expect(card.meaning).toBe("Shrink a Main's or Worker's conversation at a safe point, then restore what matters from the records.");
    expect(card.note).toBe(
      'A Claude turn is judged by its tokens read, a Codex or OpenCode turn by how full its context is. A mission\'s Main is compacted at "Compact a Main at" or its window share even with this switch off.',
    );
    expect(card.toggle).toEqual({ turnsOn: false, enabled: true, label: "Turn off", accessibilityLabel: "Turn compaction off now" });
    expect(card.rows.map((row) => [row.label, row.valueText, row.inputText])).toEqual([
      ["Main reads more than, per turn", "390k tokens read", "390 K"],
      ["Worker reads more than, per turn", "5.7M tokens read", "5.7 M"],
      ["Or its context window is fuller than", "50% of the window", "50 %"],
      ["Compact a Main at", "context 150k", "150 K"],
      ["At most, per agent", "at most 2", "2"],
    ]);
    expect(card.rows[3]!.accessibilityLabel).toBe("Main compaction context: context 150k");
    expect(card.rows[0]!.accessibilityLabel).toBe("Main turn threshold: 390k tokens read");
    expect(card.rows[0]!.decrease).toEqual({ enabled: true, label: "−", accessibilityLabel: "Main turn threshold: lower to 300k tokens read" });
    expect(card.rows[0]!.increase).toEqual({ enabled: true, label: "+", accessibilityLabel: "Main turn threshold: raise to 400k tokens read" });
    const handoff = view({ mechanism: "handoff" });
    expect(handoff.title).toBe("Handoff");
    expect(handoff.note).toBeNull();
    expect(handoff.meaning).toBe("Move a heavy request to a fresh Worker with a brief and the old Worker's note.");
    expect(handoff.rows.map((row) => [row.label, row.inputText])).toEqual([
      ["A request has read more than", "150 M"],
      ["At most, per request", "2"],
    ]);
    expect(MECHANISM_THRESHOLDS.handoff).toEqual(["handoff.requestTokens", "handoff.maxPerRequest"]);
  });

  it("offers Save for a changed threshold and the defaults away from them; Save sends one change per setting, in order", () => {
    const draft = { "compact.contextShare": 0.6, "compact.managerTokensPerTurn": 390_000, "compact.maxPerAgent": 1 };
    const card = view({ draft });
    expect(card.save).toEqual({ enabled: true, label: "Save", accessibilityLabel: "Save the compaction thresholds" });
    expect(card.reset).toEqual({ enabled: true, label: "Use the defaults", accessibilityLabel: "Set the compaction thresholds back to their defaults" });
    expect(card.rows[4]!.decrease.enabled).toBe(false);
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
      body: "paseo-bm may then hand a heavy request to a fresh Worker under its Main without asking you, when it crosses your thresholds. paseo-bm switched it off because only 6 of its last 10 met their goal (target 8). Its record counts afresh from now.",
      confirmLabel: "Turn on",
      cancelLabel: "Cancel",
      confirmAccessibilityLabel: "Turn handoff on",
      cancelAccessibilityLabel: "Keep handoff off",
      defaultAction: "cancel",
    });
    expect(turnOnDialog("compact", ownerOff("compact")).body).toBe(
      "paseo-bm may then compact a Main's or a Worker's conversation without asking you, when it crosses your thresholds. Its record counts afresh from now.",
    );
  });
});

describe("the Coordination group's line", () => {
  it("names both switches, and puts a mechanism paseo-bm switched off first, as a warning; the retired advice cadence is not named", () => {
    // Coordination is open on the screen (change-014): not one of More's folded groups.
    expect(SETTINGS_GROUPS.map((group) => group.key)).not.toContain("coordination");
    expect(COORDINATION_MEANING.split("\n")).toHaveLength(1);
    // Compaction and handoff run in the plugin's code (missions design §9.5, §17), not the Orchestrator's.
    expect(COORDINATION_MEANING).toBe("When paseo-bm compacts an agent or hands a request to a fresh Worker, for every project. Each switches itself off if it stops helping.");
    expect(mechanismsText(D)).toBe("compaction and handoff on");
    expect(mechanismsText(ownerOff("handoff"))).toBe("compaction on, handoff off");
    expect(mechanismsText({ ...ownerOff("compact"), handoff: { ...D.handoff, enabled: false } })).toBe("compaction and handoff off");
    expect(coordinationGroupState(ownerOff("compact"))).toEqual({ text: "compaction off, handoff on", tone: "muted" });
    expect(switchedOffMechanisms(switchedOff("compact"))).toEqual(["compact"]);
    expect(coordinationGroupState(switchedOff("compact"))).toEqual({ text: "Compaction switched off below its target", tone: "warning" });
    const both: CoordinationSettings = { ...switchedOff("compact"), handoff: { ...D.handoff, enabled: false }, guard: { ...switchedOff("compact").guard, handoff: switchedOff("handoff").guard.handoff } };
    expect(coordinationGroupState(both).text).toBe("Compaction and handoff switched off below their target");
  });
});

describe("Reset coordination to defaults (change-014 outcome 5)", () => {
  it("fills every card's draft with the defaults — both mechanisms' thresholds, rollover's, the review settings — and saves nothing itself", () => {
    const changed: CoordinationSettings = { ...D, advice: { everyFinished: 9 } };
    const drafts = coordinationDefaultsDraft(D);
    expect(Object.keys(drafts).sort()).toEqual(["review", "thresholds"]);
    expect(drafts.thresholds).toEqual({ ...defaultsDraft("compact", D), ...defaultsDraft("handoff", D), ...defaultsDraft("rollover", D) });
    expect(Object.keys(drafts.thresholds).sort()).toEqual([...MECHANISM_THRESHOLDS.compact, ...MECHANISM_THRESHOLDS.handoff, ...MECHANISM_THRESHOLDS.rollover].sort());
    expect(drafts.review).toEqual(reviewDefaultsDraft(D));
    // Against stored defaults the drafts change nothing; a card's Save sends only what differs.
    expect(changedThresholds("compact", D, drafts.thresholds)).toEqual([]);
    expect(changedReview(changed, drafts.review)).toEqual([]);
    expect(coordinationResetView(false)).toEqual({
      enabled: true,
      label: "Reset coordination to defaults",
      accessibilityLabel: "Fill every coordination setting with its default; each card saves with its own Save",
    });
    expect(coordinationResetView(true).enabled).toBe(false);
  });
});

describe("the rollover card (delivery line design §2.6, §6.6, §12 item 4)", () => {
  const rollover = (over: Partial<Parameters<typeof mechanismCardView>[0]> = {}) => view({ mechanism: "rollover", ...over });

  it("lists the rollover figures, where it is asked now and the maintenance ceiling, in their units; no A-12 figures", () => {
    expect(COORDINATION_CARDS).toEqual(["compact", "handoff", "rollover"]);
    const card = rollover();
    expect(card).toMatchObject({ mechanism: "rollover", title: "Rollover", helped: null, status: { text: "On", tone: "success" }, toggle: { turnsOn: false, label: "Turn off" }, reset: null });
    expect(card.rows.map((row) => [row.key, row.label, row.inputText, row.valueText])).toEqual([
      ["rollover.beads", "A request has closed beads", "15", "15 beads"],
      ["rollover.turns", "Or its Worker turns reach", "40", "40 turns"],
      ["rollover.tokens", "Or it has read", "50 M", "50M tokens read"],
      ["rollover.contextTokens", "Or its context reaches", "250 K", "context 250k"],
      ["rollover.ceilingFactor", "Finish now at, × a figure", "2 ×", "2×"],
      ["maintenance.ceilingFactor", "Skip the safe point at, × a threshold", "2 ×", "2×"],
    ]);
  });

  it("reads and steps a factor by a half within 1.5 to 5, and refuses one out of bounds", () => {
    expect(parseCoordinationInput("maintenance.ceilingFactor", "2.5 ×")).toEqual({ value: 2.5, error: null });
    expect(parseCoordinationInput("rollover.ceilingFactor", "3")).toEqual({ value: 3, error: null });
    expect(parseCoordinationInput("rollover.ceilingFactor", "3x")).toEqual({ value: 3, error: null });
    expect(parseCoordinationInput("maintenance.ceilingFactor", "1.4")).toEqual({ value: null, error: "Skip the safe point at, × a threshold: a number from 1.5 × to 5 ×." });
    expect(parseCoordinationInput("rollover.tokens", "80M")).toEqual({ value: 80_000_000, error: null });
    expect(parseCoordinationInput("rollover.contextTokens", "300 K")).toEqual({ value: 300_000, error: null });
    expect(parseCoordinationInput("rollover.contextTokens", "1M")).toEqual({ value: null, error: "Or its context reaches: a number from 100 K to 900 K." });
    expect(stepThreshold("rollover.contextTokens", 250_000, 1)).toBe(300_000);
    expect(parseCoordinationInput("rollover.beads", "2")).toEqual({ value: null, error: "A request has closed beads: a number from 3 to 100." });
    expect(stepThreshold("maintenance.ceilingFactor", 2, 1)).toBe(2.5);
    expect(stepThreshold("maintenance.ceilingFactor", 1.5, -1)).toBe(1.5);
    expect(stepThreshold("rollover.ceilingFactor", 5, 1)).toBe(5);
  });

  it("Save sends one change per setting, the maintenance ceiling included; off, it turns on at once with no confirmation", () => {
    const draft = { "rollover.turns": 60, "maintenance.ceilingFactor": 3 };
    expect(changedThresholds("rollover", D, draft)).toEqual([
      { key: "rollover.turns", value: 60 },
      { key: "maintenance.ceilingFactor", value: 3 },
    ]);
    expect(rollover({ draft }).save).toMatchObject({ enabled: true, accessibilityLabel: "Save the rollover thresholds" });
    const off = rollover({ settings: { ...D, rollover: { ...D.rollover, enabled: false } } });
    expect(off.status).toEqual({ text: "Off", tone: "muted" });
    expect(off.toggle).toEqual({ turnsOn: true, enabled: true, label: "Turn on", accessibilityLabel: "Turn rollover on now" });
  });

  it("MechanismCard draws it without a helped line", () => {
    const nodes = renderTree(
      MechanismCard({ view: rollover(), inputs: {}, dialog: null, busy: false, error: null, onToggle: noop, onConfirm: noop, onCancel: noop, onInput: noop, onSave: noop, styles, theme }),
    );
    expect(texts(nodes)).toEqual(["Rollover", rollover().meaning, ...rollover().rows.map((row) => row.label)]);
  });
});

describe("the CI card (ADR-036, delivery line design §17.1)", () => {
  const on: CoordinationSettings = { ...D, integration: { ci: "on" } };

  it("is off by default: Off, Turn on at once; on: On, Turn off at once; no figures, no Save, no reset", () => {
    expect(ciCardView(D, false)).toEqual({
      mechanism: "integration",
      title: "CI",
      helped: null,
      meaning: CI_CARD_WORDS.meaning,
      note: null,
      status: { text: "Off", tone: "muted" },
      toggle: { turnsOn: true, enabled: true, label: "Turn on", accessibilityLabel: "Turn CI on now" },
      rows: [],
      save: { enabled: false, label: "Save", accessibilityLabel: "Save the CI setting" },
      reset: null,
    });
    expect(ciCardView(on, false)).toMatchObject({ status: { text: "On", tone: "success" }, toggle: { turnsOn: false, enabled: true, label: "Turn off", accessibilityLabel: "Turn CI off now" } });
    expect(ciCardView(D, true).toggle.enabled).toBe(false);
  });

  it("its switch saves integration.ci the other way", () => {
    expect(ciToggleChange(D)).toEqual({ key: "integration.ci", value: "on" });
    expect(ciToggleChange(on)).toEqual({ key: "integration.ci", value: "off" });
  });

  it("MechanismCard draws it with its title, what it means and its switch, and no foot", () => {
    const onToggle = vi.fn();
    const nodes = renderTree(MechanismCard({ view: ciCardView(D, false), inputs: {}, dialog: null, busy: false, error: null, onToggle, onConfirm: noop, onCancel: noop, onInput: noop, onSave: noop, styles, theme }));
    expect(texts(nodes)).toEqual(["CI", CI_CARD_WORDS.meaning]);
    const toggle = allNodes(nodes).find((node) => node.props["accessibilityLabel"] === "Turn CI on now");
    expect(toggle).toBeDefined();
    (toggle!.props["onPress"] as () => void)();
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe("MechanismCard (hook-free)", () => {
  const draw = (props: Record<string, unknown>) =>
    renderTree(
      MechanismCard({
        inputs: {},
        dialog: null,
        busy: false,
        error: null,
        onToggle: noop,
        onConfirm: noop,
        onCancel: noop,
        onInput: noop,
        onSave: noop,
        styles,
        theme,
        ...props,
      }),
    );
  const inputsOf = (nodes: ReturnType<typeof draw>) => allNodes(nodes).filter((node) => node.type === "TextInput");

  it("draws the title, what it does, how often it helped and the square switch, then each threshold as a labelled number field; Save only once a field changed", () => {
    const atRest = draw({ view: view() });
    expect(texts(atRest)).toEqual([
      "Compact",
      view().meaning,
      "helped —",
      "Main reads more than, per turn",
      "Worker reads more than, per turn",
      "Or its context window is fuller than",
      "Compact a Main at",
      "At most, per agent",
    ]);
    expect(inputsOf(atRest).map((input) => input.props.value)).toEqual(["390 K", "5.7 M", "50 %", "150 K", "2"]);
    expect(inputsOf(atRest).map((input) => input.props.accessibilityLabel)).toEqual(view().rows.map((row) => row.accessibilityLabel));
    const [toggle] = pressables(atRest);
    expect(toggle!.props).toMatchObject({ accessibilityRole: "switch", accessibilityLabel: "Turn compaction off now", accessibilityState: { checked: true, disabled: false } });
    expect(pressables(atRest)).toHaveLength(1);

    const onInput = vi.fn();
    const onToggle = vi.fn();
    const onSave = vi.fn();
    const card = view({ draft: { "compact.workerTokensPerTurn": 6_000_000 } });
    const nodes = draw({ view: card, inputs: { "compact.workerTokensPerTurn": "6M" }, onInput, onToggle, onSave });
    expect(inputsOf(nodes).map((input) => input.props.value)).toEqual(["390 K", "6M", "50 %", "150 K", "2"]);
    (inputsOf(nodes)[0]!.props.onChangeText as (text: string) => void)("400k");
    expect(onInput.mock.calls).toEqual([["compact.managerTokensPerTurn", "400k"]]);
    const buttons = pressables(nodes);
    expect(buttons.map((button) => button.props.accessibilityRole)).toEqual(["switch", "button"]);
    expect(buttons[1]!.props.accessibilityLabel).toBe("Save the compaction thresholds");
    for (const button of buttons) (button.props.onPress as () => void)();
    expect(onToggle).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenCalledOnce();
  });

  it("refuses a field out of bounds in the danger colour, with Save off", () => {
    const nodes = draw({ view: view({ draft: { "compact.contextShare": 0.6 } }), inputs: { "compact.maxPerAgent": "9" } });
    const refusal = allNodes(nodes).find((node) => node.type === "Text" && texts([node])[0] === "At most, per agent: a number from 1 to 5.")!;
    expect(JSON.stringify(refusal.props.style)).toContain("#statusDanger");
    const save = pressables(nodes).find((button) => button.props.accessibilityRole === "button")!;
    expect(save.props.disabled).toBe(true);
    const field = allNodes(nodes).filter((node) => node.type === "TextInput")[4]!;
    expect(JSON.stringify(field.props.style)).toContain("#statusDanger");
  });

  it("while turning on is asked: the switch is held and the confirmation opens under the header, Cancel first; paseo-bm's switch-off and a failed save show in their colours", () => {
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
    const [toggle, ...buttons] = pressables(nodes);
    expect(toggle!.props).toMatchObject({ accessibilityRole: "switch", accessibilityState: { checked: false, disabled: true } });
    expect(buttons.map((button) => texts([button])[0]).slice(0, 2)).toEqual(["Cancel", "Turn on"]);
    (buttons[0]!.props.onPress as () => void)();
    (buttons[1]!.props.onPress as () => void)();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(texts(nodes)).toContain("helped 6 of 10");
    const status = allNodes(nodes).find((node) => node.type === "Text" && texts([node])[0]?.startsWith("Switched off by paseo-bm"))!;
    expect(JSON.stringify(status.props.style)).toContain("#statusWarning");
    const error = allNodes(nodes).find((node) => node.type === "Text" && texts([node])[0]?.startsWith("E_COORDINATION_WRITE_FAILED"))!;
    expect(JSON.stringify(error.props.style)).toContain("#statusDanger");
  });
});

// Delivery line design §5.6: the review card, below compaction and handoff — two settings with the existing controls and the caps they make, read-only.
describe("the review card (delivery line design §5.6)", () => {
  const reviewView = (over: Partial<Parameters<typeof reviewCardView>[0]> = {}) => reviewCardView({ settings: D, defaults: D, draft: {}, saving: false, ...over });
  const stored = (maxRereviews: number, callsPerBatch: number): CoordinationSettings => ({ ...D, review: { maxRereviews, callsPerBatch } });

  it("steps each setting by one within its bounds: re-reviews 1 to 6, calls per milestone batch 2 to 6", () => {
    expect(stepReview("review.maxRereviews", 1, -1)).toBe(1);
    expect(stepReview("review.maxRereviews", 3, 1)).toBe(4);
    expect(stepReview("review.maxRereviews", 6, 1)).toBe(6);
    expect(stepReview("review.callsPerBatch", 2, -1)).toBe(2);
    expect(stepReview("review.callsPerBatch", 6, 1)).toBe(6);
    expect(stepReview("review.callsPerBatch", 6, -1)).toBe(5);
    expect(reviewValueText("review.maxRereviews", 1)).toBe("1 re-review");
    expect(reviewValueText("review.maxRereviews", 3)).toBe("3 re-reviews");
    expect(reviewValueText("review.callsPerBatch", 3)).toBe("3 review calls");
  });

  it("computes the caps per request from the calls per milestone batch: Small 3, Medium 6, Large 12 at the defaults", () => {
    expect(reviewCapsText(3)).toBe("Cap per request: Small 3, Medium 6, Large 12 calls");
    expect(reviewCapsText(2)).toBe("Cap per request: Small 2, Medium 4, Large 8 calls");
    expect(reviewCapsText(6)).toBe("Cap per request: Small 6, Medium 12, Large 24 calls");
  });

  it("at the defaults: the two settings with − and +, the caps read-only, nothing to save, no defaults to restore", () => {
    const card = reviewView();
    expect(card).toMatchObject({ title: "Review", meaning: REVIEW_WORDS.meaning, caps: "Cap per request: Small 3, Medium 6, Large 12 calls", reset: null });
    expect(card.rows.map((row) => [row.label, row.key, row.valueText, row.decrease.enabled, row.increase.enabled])).toEqual([
      ["Re-reviews per batch", "review.maxRereviews", "3 re-reviews", true, true],
      ["Calls per milestone batch", "review.callsPerBatch", "3 review calls", true, true],
    ]);
    expect(card.rows.map((row) => row.key)).toEqual([...REVIEW_KEYS]);
    expect(card.rows[1]!.increase.accessibilityLabel).toBe("Review calls per milestone batch: raise to 4 review calls");
    expect(card.rows[0]!.decrease.accessibilityLabel).toBe("Re-reviews per batch: lower to 2 re-reviews");
    expect(card.save).toEqual({ enabled: false, label: "Save", accessibilityLabel: "Save the review settings" });
    // − off at the minimum, + off at the maximum.
    expect(reviewView({ settings: stored(1, 6) }).rows.map((row) => [row.decrease.enabled, row.increase.enabled])).toEqual([[false, true], [true, false]]);
  });

  it("follows the draft: the caps change with the calls per milestone batch before Save; Save sends one coordination.set per changed setting, in the card's order", () => {
    const draft = { "review.callsPerBatch": 4, "review.maxRereviews": 2 };
    const card = reviewView({ draft });
    expect(card.rows.map((row) => row.valueText)).toEqual(["2 re-reviews", "4 review calls"]);
    expect(card.caps).toBe("Cap per request: Small 4, Medium 8, Large 16 calls");
    expect(card.save.enabled).toBe(true);
    expect(card.reset).toEqual({ enabled: true, label: "Use the defaults", accessibilityLabel: "Set the review settings back to their defaults" });
    expect(changedReview(D, draft)).toEqual([
      { key: "review.maxRereviews", value: 2 },
      { key: "review.callsPerBatch", value: 4 },
    ]);
    // A draft back at the stored value changes nothing: Save stays off.
    expect(reviewView({ draft: { "review.callsPerBatch": 3 } }).save.enabled).toBe(false);
    // Stored away from the defaults: "Use the defaults" shows them as a draft, which Save then sends.
    const owner = stored(5, 2);
    expect(reviewView({ settings: owner }).reset).not.toBeNull();
    expect(reviewView({ settings: owner }).caps).toBe("Cap per request: Small 2, Medium 4, Large 8 calls");
    const back = reviewDefaultsDraft(D);
    expect(back).toEqual({ "review.maxRereviews": 3, "review.callsPerBatch": 3 });
    expect(reviewView({ settings: owner, draft: back })).toMatchObject({ reset: null, save: { enabled: true } });
    expect(changedReview(owner, back)).toEqual([
      { key: "review.maxRereviews", value: 3 },
      { key: "review.callsPerBatch", value: 3 },
    ]);
  });

  it("disables everything while saving", () => {
    const card = reviewView({ draft: { "review.callsPerBatch": 4 }, saving: true });
    expect(card.rows.every((row) => !row.decrease.enabled && !row.increase.enabled)).toBe(true);
    expect(card.save).toMatchObject({ enabled: false, label: "Saving…" });
    expect(card.reset).toMatchObject({ enabled: false });
  });

  it("ReviewCard (hook-free): the title, the two settings as joined number fields, the caps, what they mean, Save once one changed", () => {
    const onInput = vi.fn();
    const onSave = vi.fn();
    const draw = (props: Record<string, unknown>) =>
      renderTree(ReviewCard({ view: reviewView(), inputs: {}, busy: false, error: null, onInput, onSave, styles, theme, ...props }));
    const atRest = draw({});
    expect(texts(atRest)).toEqual(["Review", "Re-reviews per batch", "Calls per milestone batch", "Cap per request: Small 3, Medium 6, Large 12 calls", REVIEW_WORDS.meaning]);
    expect(pressables(atRest)).toHaveLength(0);
    const fields = allNodes(atRest).filter((node) => node.type === "TextInput");
    expect(fields.map((field) => field.props.value)).toEqual(["3", "3"]);
    expect(fields[1]!.props.accessibilityLabel).toBe("Review calls per milestone batch: 3 review calls");
    (fields[1]!.props.onChangeText as (text: string) => void)("4");
    expect(onInput.mock.calls).toEqual([["review.callsPerBatch", "4"]]);

    const card = reviewView({ draft: { "review.callsPerBatch": 4 } });
    const changed = draw({ view: card, inputs: { "review.callsPerBatch": "4" } });
    expect(texts(changed)).toContain("Cap per request: Small 4, Medium 8, Large 16 calls");
    const [save] = pressables(changed);
    expect(texts([save!])).toEqual(["Save"]);
    expect(save!.props.accessibilityLabel).toBe("Save the review settings");
    (save!.props.onPress as () => void)();
    expect(onSave).toHaveBeenCalledOnce();
    const failed = draw({ view: card, error: "E_COORDINATION_INVALID: review.callsPerBatch must be a whole number from 2 to 6" });
    const error = allNodes(failed).find((node) => node.type === "Text" && texts([node])[0]?.startsWith("E_COORDINATION_INVALID"))!;
    expect(JSON.stringify(error.props.style)).toContain("#statusDanger");
  });
});

describe("Coordination on a phone (MobileSettings.dc.html)", () => {
  type Style = Record<string, unknown>;
  const fieldWidths = (nodes: ReturnType<typeof renderTree>) => allNodes(nodes).filter((node) => node.type === "TextInput").map((node) => (node.props.style as Style).width);

  it("puts each threshold in a full-width row of its own — the label, then an 84px field — and how often it helped under the title", () => {
    const nodes = renderTree(
      MechanismCard({ view: view(), inputs: {}, dialog: null, busy: false, error: null, narrow: true, onToggle: noop, onConfirm: noop, onCancel: noop, onInput: noop, onSave: noop, styles, theme }),
    );
    expect(fieldWidths(nodes)).toEqual([84, 84, 84, 84, 84]);
    const cells = allNodes(nodes).filter((node) => node.type === "View" && (node.props.style as Style | undefined)?.width === "100%");
    expect(cells).toHaveLength(5);
    expect(texts(nodes).slice(0, 3)).toEqual(["Compact", view().meaning, "helped —"]);
  });

  it("stacks the review settings as rows with 84px fields, the caps under them, and puts Save across the card", () => {
    const onSave = vi.fn();
    const card = reviewCardView({ settings: D, defaults: D, draft: { "review.callsPerBatch": 4 }, saving: false });
    const nodes = renderTree(
      ReviewCard({ view: card, inputs: { "review.callsPerBatch": "4" }, busy: false, error: null, narrow: true, onInput: noop, onSave, styles, theme }),
    );
    expect(texts(nodes)).toEqual(["Review", card.meaning, "Re-reviews per batch", "Calls per milestone batch", "Cap per request: Small 4, Medium 8, Large 16 calls", "Save"]);
    expect(fieldWidths(nodes)).toEqual([84, 84]);
    const [save] = pressables(nodes);
    expect(JSON.stringify(save!.props.style)).toContain('"alignSelf":"stretch"');
    (save!.props.onPress as () => void)();
    expect(onSave).toHaveBeenCalledOnce();
  });
});
