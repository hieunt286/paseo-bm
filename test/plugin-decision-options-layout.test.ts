import { describe, expect, it, vi } from "vitest";
import { pressables, renderTree, texts, type RNode } from "./helpers/element-tree";
import { DECISION_UI_IDLE, decisionCardOf, decisionCardView, type DecisionUi } from "../plugin/client/chat-cards";
import { seedOf } from "../plugin/client/inbox-model";
import type { Decision } from "../plugin/shared/decisions";

/**
 * The decision card's options must never run past the card (owner report,
 * 2026-09-30: a long recommended option overflowed the card to the right edge
 * of the chat). Short answers stay side by side; once one is a sentence, every
 * option takes the card's width and its text wraps.
 */

vi.mock("react-native", () => {
  const make = (name: string) => Object.assign(() => null, { displayName: name, primitive: true });
  return { Pressable: make("Pressable"), ScrollView: make("ScrollView"), Text: make("Text"), TextInput: make("TextInput"), View: make("View") };
});
vi.mock("@getpaseo/plugin/client/react-native", () => ({ Icon: Object.assign(() => null, { displayName: "Icon", primitive: true }) }));

// The root tsconfig has no `jsx`, so the .tsx module loads through a non-literal specifier.
const cardPath = "../plugin/client/chat-card.tsx";
const { DecisionCardBody, optionsStacked, OPTION_ROW_MAX_CHARS } = (await import(cardPath)) as {
  DecisionCardBody: (props: Record<string, unknown>) => unknown;
  optionsStacked: (labels: readonly string[]) => boolean;
  OPTION_ROW_MAX_CHARS: number;
};

const styles = new Proxy({}, { get: (_target, key) => ({ name: String(key) }) });
const theme = { colors: new Proxy({}, { get: (_target, key) => `#${String(key)}` }) };
const noop = () => undefined;

const LONG =
  'Ghim lại sang commit HEAD hiện tại (df6b182) qua một PRD delta, và ghi rõ "có trong 0.5.0, chưa phát hành" trên các phần mới';

function decision(labels: readonly string[]): Decision {
  return {
    id: "q:req-20260930T031055Z:Q1",
    workspaceId: "wks_demo",
    requestId: "req-20260930T031055Z",
    askedBy: { role: "worker", agentId: "worker-1" },
    askedAt: "2026-09-30T03:14:58.000Z",
    round: 1,
    question: "Which version should the site describe?",
    subject: null,
    options: labels.map((label, index) => ({ key: String.fromCharCode(97 + index), label, recommended: index === 0, effects: ["none"] })),
    status: "open",
    settledAt: null,
    needsConfirmation: null,
    answer: null,
    grant: null,
    delivery: null,
    supersedes: null,
    supersededBy: null,
  } as unknown as Decision;
}

function draw(labels: readonly string[], ui: DecisionUi = DECISION_UI_IDLE): Array<RNode | string> {
  const stored = decision(labels);
  const view = decisionCardView({
    card: decisionCardOf(seedOf(stored), stored.requestId),
    lookup: { state: "found", decision: stored },
    agents: [],
    ui,
    cardAt: new Date("2026-09-30T03:14:58.000Z"),
    now: new Date("2026-09-30T03:15:30.000Z"),
  });
  return renderTree(
    DecisionCardBody({
      view,
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
      compact: false,
    }),
  );
}

const optionButtons = (nodes: Array<RNode | string>) =>
  pressables(nodes).filter((node) => String(node.props["accessibilityLabel"]).startsWith("Answer: "));

describe("decision options never run past the card", () => {
  it("stacks the options once one label is a sentence", () => {
    expect(optionsStacked(["Yes", "Hold"])).toBe(false);
    expect(optionsStacked(["x".repeat(OPTION_ROW_MAX_CHARS)])).toBe(false);
    expect(optionsStacked(["Yes", "x".repeat(OPTION_ROW_MAX_CHARS + 1)])).toBe(true);
  });

  it("draws a sentence-long option full width, left-aligned and wrapping — every option, not only the long one", () => {
    const nodes = draw([LONG, "Keep 0.4.1 pinned", "Pin HEAD, no label"]);
    expect(texts(nodes).some((text) => text.startsWith("Ghim lại sang commit HEAD"))).toBe(true);
    const buttons = optionButtons(nodes);
    expect(buttons).toHaveLength(3);
    for (const button of buttons) {
      const style = (button.props["style"] as object[]).reduce((all, part) => ({ ...all, ...part }), {});
      expect(style).toMatchObject({ alignSelf: "stretch", alignItems: "flex-start" });
      const label = (button.children.find((child): child is RNode => typeof child !== "string" && child.type === "Text")!).props["style"] as object[];
      expect(label.reduce((all, part) => ({ ...all, ...part }), {})).toMatchObject({ flexShrink: 1, textAlign: "left" });
    }
  });

  it("keeps short options side by side, still allowed to shrink within the card", () => {
    const buttons = optionButtons(draw(["Yes", "Hold"]));
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      const style = (button.props["style"] as object[]).reduce((all, part) => ({ ...all, ...part }), {});
      expect(style).toMatchObject({ maxWidth: "100%", flexShrink: 1 });
      expect(style).not.toHaveProperty("alignSelf");
    }
  });
});
