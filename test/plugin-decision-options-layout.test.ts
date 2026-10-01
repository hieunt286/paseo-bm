import { describe, expect, it } from "vitest";
import { pressables, renderTree, texts, type RNode } from "./helpers/element-tree";
import { decisionCardOf } from "../plugin/client/chat-card-parse";
import { DECISION_UI_IDLE, decisionCardView, type DecisionUi } from "../plugin/client/chat-card-decision";
import { seedOf } from "../plugin/client/inbox-model";
import type { Decision } from "../plugin/shared/decisions";

/**
 * The decision card's options must never run past the card (owner report,
 * 2026-09-30: a long recommended option overflowed the card to the right edge
 * of the chat). As the approved mockup draws them (change-014), every option
 * is a full-width row — key letter, label, mark — and its label wraps.
 */

// The root tsconfig has no `jsx`, so the .tsx module loads through a non-literal specifier.
const cardPath = "../plugin/client/chat-card.tsx";
const { DecisionCardBody } = (await import(cardPath)) as {
  DecisionCardBody: (props: Record<string, unknown>) => unknown;
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
  const flat = (style: unknown) => [style].flat(Infinity).reduce<Record<string, unknown>>((all, part) => ({ ...all, ...(part as object) }), {});

  it("draws every option as a full-width row whose label wraps — a sentence-long one and a short one alike", () => {
    for (const labels of [[LONG, "Keep 0.4.1 pinned", "Pin HEAD, no label"], ["Yes", "Hold"]]) {
      const nodes = draw(labels);
      const buttons = optionButtons(nodes);
      expect(buttons).toHaveLength(labels.length);
      for (const button of buttons) {
        expect(flat(button.props["style"])).toMatchObject({ alignSelf: "stretch", flexDirection: "row", alignItems: "flex-start" });
        const label = button.children.filter((child): child is RNode => typeof child !== "string" && child.type === "Text")[1]!;
        expect(flat(label.props["style"])).toMatchObject({ flex: 1, flexShrink: 1, textAlign: "left" });
      }
    }
    expect(texts(draw([LONG, "Keep 0.4.1 pinned"])).some((text) => text.startsWith("Ghim lại sang commit HEAD"))).toBe(true);
  });

  it("puts the key letter first and the recommended mark last, the recommended row filled with the accent", () => {
    const [first, second] = optionButtons(draw(["Yes", "Hold"]));
    expect(texts([first!])).toEqual(["a", "Yes", "Recommended"]);
    expect(texts([second!])).toEqual(["b", "Hold"]);
    expect(flat(first!.props["style"])).toMatchObject({ backgroundColor: "#accent" });
    expect(flat(second!.props["style"])).toMatchObject({ backgroundColor: "transparent", borderWidth: 1, borderColor: "#border" });
  });
});
