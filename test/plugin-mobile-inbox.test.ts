import { describe, expect, it } from "vitest";
import { allNodes, pressables, renderTree, texts, type RNode } from "./helpers/element-tree";
import { makeDecision } from "./helpers/decisions";
import { decisionCardOf } from "../plugin/client/chat-card-parse";
import { DECISION_UI_IDLE, decisionCardView, type DecisionCardView } from "../plugin/client/chat-card-decision";
import { seedOf } from "../plugin/client/inbox-model";
import type { OrchestratorHeaderView } from "../plugin/client/orchestrator-model";

/**
 * The phone layout of the shell header and the Inbox (the MobileInbox
 * artboard, 390 wide): the header in two rows with four equal tabs, the
 * filter on its own row, option rows with the label under the key line, the
 * card's last row and a held action's buttons as equal cells. The wide
 * layout is unchanged; the existing render tests pin it.
 */

// The root tsconfig has no `jsx`, so the .tsx modules load through non-literal specifiers.
const headerPath = "../plugin/client/shell-header.tsx";
const cardPath = "../plugin/client/chat-card.tsx";
const inboxPath = "../plugin/client/inbox.tsx";
type Component = (props: Record<string, unknown>) => unknown;
const { ShellHeaderBar, compactStatusText, compactTabs } = (await import(headerPath)) as {
  ShellHeaderBar: Component;
  compactStatusText: (text: string) => string;
  compactTabs: (tabs: ReadonlyArray<{ key: string; label: string; accessibilityLabel?: string }>) => Array<{ key: string; label: string; accessibilityLabel?: string }>;
};
const { DecisionCardBody } = (await import(cardPath)) as { DecisionCardBody: Component };
const { InboxTitleRow, AlertRow, DigestRowView } = (await import(inboxPath)) as {
  InboxTitleRow: Component;
  AlertRow: Component;
  DigestRowView: Component;
};

const styles = new Proxy({}, { get: (_target, key) => ({ name: String(key) }) });
const theme = { colors: new Proxy({}, { get: (_target, key) => `#${String(key)}` }) };
const noop = () => undefined;
const flat = (style: unknown) => [style].flat(Infinity).reduce<Record<string, unknown>>((all, part) => ({ ...all, ...(part as object) }), {});

const TABS = [
  { key: "inbox", label: "Inbox", badge: 13, accessibilityLabel: "Inbox: 13 need you" },
  { key: "projects", label: "Projects" },
  { key: "settings", label: "Settings" },
  { key: "tools", label: "Tools & skills" },
];
const IDLE: OrchestratorHeaderView = {
  action: "open",
  agentId: "agent-o",
  warning: null,
  replaced: null,
  dot: "accent",
  text: "Orchestrator idle · 2 projects watched",
  button: null,
} as unknown as OrchestratorHeaderView;
const NOT_OPEN = { ...IDLE, agentId: null, action: "start", dot: "muted", text: "Orchestrator not open", button: "Start…" } as unknown as OrchestratorHeaderView;

function header(view: OrchestratorHeaderView | null, compact: boolean) {
  return renderTree(ShellHeaderBar({ tabs: TABS, selected: "inbox", onSelect: noop, view, busy: false, onPress: noop, theme, compact }));
}

describe("the shell header on a phone", () => {
  it("is two rows: a 48px brand-and-status row, then four equal 44px tabs with the short Tools", () => {
    const nodes = header(IDLE, true);
    const root = nodes[0] as RNode;
    const [top, nav] = root.children as RNode[];
    expect(flat(top!.props["style"])).toMatchObject({ height: 48, paddingHorizontal: 16 });
    expect(texts([top!])).toEqual(["Beads Manager", "Orchestrator idle"]);
    expect(flat(nav!.props["style"])).toMatchObject({ height: 44 });
    const tabs = pressables([nav!]);
    expect(tabs.map((tab) => tab.props["accessibilityLabel"])).toEqual(["Inbox: 13 need you", "Projects", "Settings", "Tools & skills"]);
    expect(texts([nav!])).toEqual(["Inbox", "13", "Projects", "Settings", "Tools"]);
    for (const tab of tabs) expect(flat(tab.props["style"])).toMatchObject({ flex: 1 });
  });

  it("says Orchestrator not open with Start… when there is none", () => {
    const nodes = header(NOT_OPEN, true);
    expect(texts(nodes)).toEqual(expect.arrayContaining(["Orchestrator not open", "Start…"]));
    expect(pressables(nodes).some((node) => node.props["accessibilityLabel"] === "Start the Orchestrator")).toBe(true);
  });

  it("keeps the wide bar as it was: one row, the full status and Tools & skills", () => {
    const nodes = header(IDLE, false);
    expect(flat((nodes[0] as RNode).props["style"])).toMatchObject({ height: 57, flexDirection: "row" });
    expect(texts(nodes)).toEqual(expect.arrayContaining(["Tools & skills", "Orchestrator idle · 2 projects watched"]));
  });

  it("shortens the status and the Tools label only", () => {
    expect(compactStatusText("Orchestrator idle · 2 projects watched")).toBe("Orchestrator idle");
    expect(compactStatusText("Orchestrator not open")).toBe("Orchestrator not open");
    expect(compactTabs(TABS).map((tab) => [tab.label, tab.accessibilityLabel])).toEqual([
      ["Inbox", "Inbox: 13 need you"],
      ["Projects", undefined],
      ["Settings", undefined],
      ["Tools", "Tools & skills"],
    ]);
  });
});

function cardView(): DecisionCardView {
  const decision = makeDecision();
  return decisionCardView({
    card: decisionCardOf(seedOf(decision), decision.requestId),
    lookup: { state: "found", decision },
    agents: [],
    ui: DECISION_UI_IDLE,
    cardAt: new Date("2026-09-29T07:40:00.000Z"),
    now: new Date("2026-09-29T07:45:00.000Z"),
  });
}

function card(view: DecisionCardView, compact: boolean, ask = true) {
  return renderTree(
    DecisionCardBody({
      view,
      ui: DECISION_UI_IDLE,
      detailsOpen: false,
      onToggleDetails: noop,
      onChoose: noop,
      onOpenWords: noop,
      onWords: noop,
      onSendWords: noop,
      onCancel: noop,
      onConfirm: noop,
      onCloseInChat: noop,
      ...(ask ? { onAsk: { open: noop, text: noop, cancel: noop, send: noop } } : {}),
      text: "",
      styles,
      theme,
      compact,
    }),
  );
}

const optionButtons = (nodes: Array<RNode | string>) =>
  pressables(nodes).filter((node) => String(node.props["accessibilityLabel"]).startsWith("Answer: "));

describe("the decision card on a phone", () => {
  it("draws an option as a key line (letter left, mark right, 11px) and the label under it at full width", () => {
    const [first, second] = optionButtons(card(cardView(), true));
    const [line, label] = first!.children as RNode[];
    expect(line!.type).toBe("View");
    expect(texts([line!])).toEqual(["a", "Recommended"]);
    for (const text of allNodes([line!]).filter((node) => node.type === "Text")) expect(flat(text.props["style"])).toMatchObject({ fontSize: 11 });
    expect(flat(allNodes([line!]).filter((node) => node.type === "Text")[1]!.props["style"])).toMatchObject({ marginLeft: "auto" });
    expect(label!.type).toBe("Text");
    expect(texts([label!])).toEqual(["Push contract only"]);
    expect(flat(label!.props["style"])).not.toHaveProperty("flex");
    expect(flat(first!.props["style"])).toMatchObject({ padding: 12, backgroundColor: "#accent" });
    expect(texts([second!])).toEqual(["b", "Push both and publish"]);
  });

  it("lays the last row out as equal cells with Details after them", () => {
    const nodes = card(cardView(), true);
    const details = pressables(nodes).find((node) => node.props["accessibilityLabel"] === "Show details")!;
    const row = allNodes(nodes).find((node) => node.type === "View" && node.children.includes(details))!;
    const cells = row.children.filter((child): child is RNode => typeof child !== "string" && child !== details);
    expect(cells.map((cell) => texts([cell]))).toEqual([["Ask back"], ["Own words…"]]);
    for (const cell of cells) expect(flat(cell.props["style"])).toMatchObject({ flex: 1, minWidth: 0 });
  });

  it("keeps the wide card's footer as plain buttons", () => {
    const nodes = card(cardView(), false);
    const details = pressables(nodes).find((node) => node.props["accessibilityLabel"] === "Show details")!;
    const row = allNodes(nodes).find((node) => node.type === "View" && node.children.includes(details))!;
    expect(row.children.every((child) => typeof child === "string" || child.type === "Pressable")).toBe(true);
  });

  it("draws a held action's Deny and Allow once as two equal buttons", () => {
    const base = cardView();
    const held: DecisionCardView = {
      ...base,
      held: true,
      options: [
        { ...base.options[0]!, key: "allow", label: "Allow once", primary: true, accessibilityLabel: "Answer: Allow once" },
        { ...base.options[1]!, key: "deny", label: "Deny", primary: false, accessibilityLabel: "Answer: Deny" },
      ],
    };
    const buttons = optionButtons(card(held, true, false));
    expect(buttons.map((button) => texts([button]))).toEqual([["Deny"], ["Allow once"]]);
    for (const button of buttons) expect(flat(button.props["style"])).toMatchObject({ flex: 1, minWidth: 0 });
  });

  it("keeps the kind label whole and lets the asker truncate on the meta line", () => {
    const nodes = card(cardView(), true);
    const meta = allNodes(nodes).filter((node) => node.type === "Text" && typeof flat(node.props["style"])["fontFamily"] === "string");
    expect(meta.length).toBeGreaterThan(0);
    const kind = meta.find((node) => texts([node])[0]!.includes("DECISION"))!;
    expect(flat(kind.props["style"])).toMatchObject({ fontSize: 11, flexShrink: 0 });
  });
});

describe("the Inbox on a phone", () => {
  it("puts the filter on its own row, its cells sharing the width", () => {
    const nodes = renderTree(InboxTitleRow({ summary: "4 items · 2 projects", filter: "all", onFilter: noop, compact: true, theme }));
    const root = nodes[0] as RNode;
    const [title, filter] = root.children as RNode[];
    expect(texts([title!])).toEqual(["Needs you", "4 items · 2 projects"]);
    expect(flat(allNodes([title!]).find((node) => node.type === "Text")!.props["style"])).toMatchObject({ fontSize: 20 });
    expect(filter!.props["accessibilityRole"]).toBe("radiogroup");
    expect(flat(filter!.props["style"])).toMatchObject({ alignSelf: "stretch" });
    for (const cell of pressables([filter!])) expect(flat(cell.props["style"])).toMatchObject({ flex: 1 });
  });

  const alert = {
    key: "alert:1",
    kind: "stalled",
    tone: "warning",
    what: "Request stalled",
    time: "9 min",
    accessibilityLabel: "Request stalled, 9 min",
    details: ["id: x"],
    action: { kind: "open-agent", agentId: "a", label: "Open request", accessibilityLabel: "Open the request" },
  };

  it("draws an alert's action under its text, left aligned", () => {
    const nodes = renderTree(AlertRow({ row: alert, expanded: false, onToggle: noop, onRun: noop, resend: undefined, compact: true, styles, theme }));
    const inner = (nodes[0] as RNode).children[0] as RNode;
    expect(flat(inner.props["style"])).toMatchObject({ flexDirection: "column", alignItems: "flex-start" });
    expect(texts([inner])).toEqual(expect.arrayContaining(["Open request"]));
  });

  it("draws Decided for you's Why? under the line, left aligned", () => {
    const row = {
      kind: "intervention",
      key: "i:1",
      project: "paseo-bm site",
      what: "Compacted Worker 9fb1584",
      time: "3 min ago",
      by: "Orchestrator",
      reason: null,
      outcome: null,
      details: [],
      accessibilityLabel: "Compacted Worker",
    };
    const nodes = renderTree(DigestRowView({ row, expanded: false, onToggle: noop, onOverride: noop, state: undefined, compact: true, styles, theme }));
    const inner = (nodes[0] as RNode).children[0] as RNode;
    expect(flat(inner.props["style"])).toMatchObject({ flexDirection: "column", alignItems: "flex-start" });
    expect(texts([inner])).toEqual(expect.arrayContaining(["Why?"]));
  });
});
