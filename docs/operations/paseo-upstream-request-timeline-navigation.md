> Ghi chú: tài liệu này viết bằng tiếng Anh (ngoại lệ của quy tắc `docs/` tiếng Việt) vì người đọc là maintainer của Paseo.

# Upstream request: let a plugin's timeline renderer open an agent

| Field | Value |
|---|---|
| Status | **Draft — not sent** |
| Target | Paseo maintainers (`@getpaseo/plugin`) |
| Checked against | `@getpaseo/plugin` 0.8.0, `@getpaseo/client` 0.8.0 (type declarations only) |
| Origin | paseo-bm request `req-20260918T041426Z`, batch `b4`, owner decision Q12 (a); bead `bm-wp-257-card-b4-zwx7.4`; PRD delta `docs/product/paseo-bm-prd-delta-20260918d-card-replies.md` §1.3 |
| Date | 2026-09-18 |

## Summary

A plugin can render a chat message as a card, and that card can name the agent
the message came from. It cannot let the user open that agent: timeline renderers
do not receive the `navigation` object that surfaces and panels already get. We
ask for the same optional `navigation` on timeline renderer props.

## Use case

paseo-bm is a plugin that runs three agent roles in one workspace. A **Beads
Manager** creates **Beads Workers** with the `create_agent` MCP tool, and each
Worker reports to the Manager with `send_agent_prompt`. The plugin turns every
report into a card in the Manager's chat (`addTimelineTransformer` +
`addTimelineRenderer`). The card shows the sending Worker's name, its request id,
its status and, when the Worker waits for the user, its questions with option
buttons.

Several Workers often run at once. The owner asked that pressing a Worker's name
on its card opens that Worker, so they can read its full conversation and answer
it there. The card already knows the Worker's agent id (it resolves it from the
plugin's own RPC, never from the message text).

## Current behaviour

`@getpaseo/plugin` 0.8.0, `dist/client/contracts.d.ts`:

- line 8: `PluginHostProps` — `theme`, `host`, `layout`.
- line 19: `PluginNavigableHostProps extends PluginHostProps` adds
  `navigation?: { openAgent({ agentId }); openWorkspace({ workspaceId }) }`,
  documented on line 20 as *"Client-owned navigation. Undefined on older hosts;
  hide dependent affordances when absent."*
- lines 30, 47, 51: `PluginSurfaceProps`, `PluginWorkspacePanelProps` and
  `PluginAgentPanelProps` extend `PluginNavigableHostProps`, so surfaces and
  panels can open an agent.
- line 111: `PluginTimelineItemProps<Data> extends PluginHostProps` — **not**
  `PluginNavigableHostProps`. A timeline renderer receives `agentId`, `item` and
  `timestamp`, and no `navigation`.

`@getpaseo/client` 0.8.0 (`PaseoApi`, reachable from a renderer through
`usePaseo()`) has no call that opens an agent in the app: in `dist/index.d.ts`,
`PaseoAgentActions` offers `list`, `ref`, `create`, `subscribe`, and
`PaseoAgentHandle` offers `current`, `refresh`, `send`, `respondToPermission`,
`run`, `waitForFinish`, `commands`, `archive`, `detach`, `subscribe` — all of
them act on the agent, none of them on the app's view.

paseo-bm already uses `navigation.openAgent` from its Dashboard and Beads
surfaces, so the host capability exists; only the timeline renderer props lack it.

## Request

Pass the same optional `navigation` to timeline renderers:

```ts
export interface PluginTimelineItemProps<Data = unknown> extends PluginNavigableHostProps {
  agentId: string;
  item: { type: "plugin"; kind: string; version: number; data: Data };
  timestamp: Date;
}
```

Nothing else is needed. The shape, the semantics and the "undefined on older
hosts" rule stay exactly as they are for surfaces and panels.

## Why the existing primitives are not enough

- A renderer cannot reach `PluginClientContext` (`openPanel`,
  `openSurface`): it only gets its props.
- A workaround through a plugin panel — the card opens a panel whose only job is
  a button that calls `navigation.openAgent` — adds a panel and an extra tap, and
  moves the user away from the chat to do something the app does in one tap
  elsewhere.
- Copying the agent id for the user to search by hand is not a real answer.

## Compatibility

The field is optional, as it already is for surfaces and panels. A plugin that
renders timeline items today keeps working unchanged. A plugin that uses the new
field hides the affordance when `navigation` is `undefined` (older hosts), which
is the rule the SDK comment already states.

## What paseo-bm does meanwhile

The Worker's name on a card is plain text. The user opens the Worker from Paseo's
agent list or from paseo-bm's Dashboard, which does have `navigation`. When a
Paseo release passes `navigation` to timeline renderers, the card's name becomes
a button that calls `navigation.openAgent({ agentId })`, shown only when the
field is present.
