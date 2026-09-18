/**
 * A minimal element tree for hook-free views (moved from test/agent-tree.test.ts
 * by delta 20260918f so several files can use it).
 *
 * The repo has no React Native renderer. A test file mocks `react-native` with
 * named stand-ins that carry `primitive: true` and a `displayName`; this
 * expands our own components by calling them and keeps the primitives as
 * nodes, so a test can read texts, styles and press handlers. Only hook-free
 * components can be expanded this way.
 */
export interface RNode {
  type: string;
  props: Record<string, unknown>;
  children: Array<RNode | string>;
}

export interface ElementLike {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown };
}

export function isElement(value: unknown): value is ElementLike {
  return typeof value === "object" && value !== null && "type" in value && "props" in value;
}

export function renderTree(value: unknown): Array<RNode | string> {
  if (value === null || value === undefined || typeof value === "boolean") return [];
  if (typeof value === "string" || typeof value === "number") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(renderTree);
  if (!isElement(value)) throw new Error(`unexpected render value: ${String(value)}`);
  const { type, props } = value;
  if (typeof type === "function") {
    const primitive = type as { primitive?: boolean; displayName?: string };
    if (primitive.primitive) {
      const { children, ...rest } = props;
      return [{ type: primitive.displayName!, props: rest, children: renderTree(children) }];
    }
    return renderTree((type as (p: unknown) => unknown)(props));
  }
  if (typeof type === "symbol") return renderTree(props.children); // Fragment
  throw new Error(`host element <${String(type)}> rendered; only React Native primitives are allowed`);
}

export function walk(nodes: Array<RNode | string>, visit: (node: RNode) => void) {
  for (const node of nodes) {
    if (typeof node === "string") continue;
    visit(node);
    walk(node.children, visit);
  }
}

export function allNodes(nodes: Array<RNode | string>): RNode[] {
  const out: RNode[] = [];
  walk(nodes, (node) => out.push(node));
  return out;
}

export function textOf(node: RNode | string): string {
  return typeof node === "string" ? node : node.children.map(textOf).join("");
}

export function texts(nodes: Array<RNode | string>): string[] {
  return allNodes(nodes)
    .filter((node) => node.type === "Text")
    .map(textOf);
}

export function pressables(nodes: Array<RNode | string>): RNode[] {
  return allNodes(nodes).filter((node) => node.type === "Pressable");
}
