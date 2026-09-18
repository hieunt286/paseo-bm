/**
 * Everything the Beads screen shows and decides, without a renderer
 * (design delta 20260916-beads-screen).
 *
 * Pure: no React, no React Native, no `server/` import.
 */
import type { BeadAction, BeadRow, BeadStats, BeadWork } from "../shared/contracts";
import { formatDuration, type Badge, type Bar, type OverviewCard, type Tone } from "./dashboard-model";

const DAY_MS = 86_400_000;

export function priorityLabel(priority: number | null): string {
  return priority === null ? "P?" : `P${priority}`;
}

export type StatusBucket = "ready" | "blocked" | "in_progress" | "closed";

/** The bucket a bead is filtered and counted under. */
export function statusBucket(bead: Pick<BeadRow, "status" | "ready">): StatusBucket {
  if (bead.status === "closed") return "closed";
  if (bead.status === "in_progress") return "in_progress";
  if (bead.status === "blocked") return "blocked";
  return bead.ready ? "ready" : "blocked";
}

/**
 * The one colour of each status (owner decisions Q3 and Q8, delta 20260918e):
 * the title and the chip of a bead both read it, so they cannot disagree.
 */
export const STATUS_TONE: Readonly<Record<StatusBucket, Tone>> = {
  ready: "info", // accent: not started
  in_progress: "warning",
  blocked: "danger",
  closed: "success",
};

const STATUS_TEXT: Readonly<Record<StatusBucket, string>> = {
  ready: "Ready",
  in_progress: "In progress",
  blocked: "Blocked",
  closed: "Closed",
};

export function statusBadge(bead: Pick<BeadRow, "status" | "ready">): Badge {
  const bucket = statusBucket(bead);
  return { text: STATUS_TEXT[bucket], tone: STATUS_TONE[bucket] };
}

/** The colour of a bead's title in a list: only the title is coloured, never the row (Q8). */
export function beadTitleTone(bead: Pick<BeadRow, "status" | "ready">): Tone {
  return STATUS_TONE[statusBucket(bead)];
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function formatDays(ms: number | null): string {
  if (ms === null) return "—";
  const days = ms / DAY_MS;
  if (days < 1) return `${Math.max(1, Math.round(ms / 3_600_000))}h`;
  return `${days < 10 ? days.toFixed(1) : Math.round(days)}d`;
}

const parse = (at: string | null): number | null => {
  if (at === null) return null;
  const value = Date.parse(at);
  return Number.isNaN(value) ? null : value;
};

export interface BeadsOverview {
  /** 1. Status. */
  status: OverviewCard[];
  /** 2. Progress, epics excluded. */
  progress: { closed: number; total: number; share: number; label: string };
  /** 3. By type. (The per-day created/closed count was dropped at the owner's request, delta 20260918e REQ-060 m.) */
  byType: Bar[];
  /** 4. By priority. */
  byPriority: Bar[];
  /** 5. Time. */
  timing: OverviewCard[];
}

const STALE_MS = 7 * DAY_MS;

export function beadsOverview(beads: readonly BeadRow[], stats: BeadStats, now: Date): BeadsOverview {
  const work = beads.filter((bead) => bead.issueType !== "epic");
  const closedWork = work.filter((bead) => bead.status === "closed").length;

  const count = (key: (bead: BeadRow) => string, order?: readonly string[]): Bar[] => {
    const counts = new Map<string, number>();
    for (const bead of beads) counts.set(key(bead), (counts.get(key(bead)) ?? 0) + 1);
    const entries = [...counts.entries()];
    entries.sort((a, b) =>
      order === undefined ? b[1] - a[1] : order.indexOf(a[0]) - order.indexOf(b[0]) || a[0].localeCompare(b[0]),
    );
    return entries.map(([label, value]) => ({ label, value, display: String(value) }));
  };

  const cycle = beads
    .map((bead) => {
      const created = parse(bead.createdAt);
      const closed = parse(bead.closedAt);
      return created === null || closed === null ? null : closed - created;
    })
    .filter((value): value is number => value !== null && value >= 0);
  const oldestInProgress = Math.max(
    -1,
    ...beads
      .filter((bead) => bead.status === "in_progress")
      .map((bead) => {
        const since = parse(bead.work?.started?.at ?? null) ?? parse(bead.updatedAt) ?? parse(bead.createdAt);
        return since === null ? -1 : now.getTime() - since;
      }),
  );
  const stale = beads.filter((bead) => {
    if (bead.status === "closed") return false;
    const updated = parse(bead.updatedAt);
    return updated !== null && now.getTime() - updated > STALE_MS;
  }).length;

  return {
    status: [
      { label: "Total", value: String(stats.total), hint: stats.present ? "in .beads/issues.jsonl" : "no .beads/ here" },
      { label: "Ready", value: String(stats.ready), hint: "can start now" },
      { label: "In progress", value: String(stats.inProgress), hint: "being worked on" },
      { label: "Blocked", value: String(stats.blocked), hint: "waiting on other beads" },
      { label: "Closed", value: String(stats.closed), hint: "done" },
    ],
    progress: {
      closed: closedWork,
      total: work.length,
      share: work.length === 0 ? 0 : closedWork / work.length,
      label:
        work.length === 0
          ? "No work beads yet"
          : `${Math.round((closedWork / work.length) * 100)}% done · ${closedWork}/${work.length} (epics not counted)`,
    },
    byType: count((bead) => bead.issueType),
    byPriority: count((bead) => priorityLabel(bead.priority), ["P0", "P1", "P2", "P3", "P4", "P?"]),
    timing: [
      { label: "Median time to close", value: formatDays(median(cycle)), hint: `over ${cycle.length} closed bead(s)` },
      {
        label: "Longest in progress",
        value: oldestInProgress < 0 ? "—" : formatDays(oldestInProgress),
        hint: "since it started, or its last update",
      },
      { label: "Stale", value: String(stale), hint: "open, no update for 7+ days" },
    ],
  };
}

/**
 * The done / total figure at the top of the Beads screen (owner decision Q11):
 * it reads `beadsOverview(...).progress`, so it counts exactly like the
 * Progress card — every bead but epics, whatever the filters show.
 */
export function doneText(progress: { closed: number; total: number }): { text: string; label: string } {
  return {
    text: `✓ ${progress.closed} / ${progress.total} done`,
    label: `${progress.closed} of ${progress.total} beads done, epics not counted`,
  };
}

// ---------------------------------------------------------------------------
// Filters.
// ---------------------------------------------------------------------------

export interface BeadFilter {
  statuses: ReadonlySet<string>;
  types: ReadonlySet<string>;
  priorities: ReadonlySet<string>;
  labels: ReadonlySet<string>;
  text: string;
}

export const EMPTY_FILTER: BeadFilter = {
  statuses: new Set(),
  types: new Set(),
  priorities: new Set(),
  labels: new Set(),
  text: "",
};

export interface FacetValue {
  value: string;
  /** Beads this value would show, given every OTHER active filter. */
  count: number;
}

export interface Facets {
  statuses: FacetValue[];
  types: FacetValue[];
  priorities: FacetValue[];
  /** Label prefixes (`feature`, `wp`, …) with their values, most useful first. */
  labelGroups: Array<{ category: string; values: FacetValue[]; selected: number }>;
}

export const STATUS_ORDER = ["ready", "in_progress", "blocked", "closed"] as const;

/** Categories people filter by most, shown first; `other` (no prefix) last. */
const CATEGORY_ORDER = ["feature", "area", "component", "stack", "risk", "phase", "wp", "change", "service"];

/** How many values a label group shows before "+N more". */
export const LABEL_PREVIEW = 5;

/**
 * Facets with counts, the way faceted search usually works: a value's count
 * is the number of beads it would show when combined with the other facets.
 * Values that would show nothing are dropped unless they are selected, so a
 * long label list shrinks as soon as anything else is filtered.
 */
export function facetsOf(beads: readonly BeadRow[], filter: BeadFilter = EMPTY_FILTER): Facets {
  const without = (patch: Partial<BeadFilter>) => filterBeads(beads, { ...filter, ...patch });
  const counted = (
    rows: readonly BeadRow[],
    valuesOf: (bead: BeadRow) => string[],
    selected: ReadonlySet<string>,
  ): FacetValue[] => {
    const counts = new Map<string, number>();
    for (const bead of rows) for (const value of valuesOf(bead)) counts.set(value, (counts.get(value) ?? 0) + 1);
    for (const value of selected) if (!counts.has(value)) counts.set(value, 0);
    return [...counts.entries()].map(([value, count]) => ({ value, count }));
  };

  const statuses = counted(without({ statuses: new Set() }), (bead) => [statusBucket(bead)], filter.statuses).sort(
    (a, b) => STATUS_ORDER.indexOf(a.value as never) - STATUS_ORDER.indexOf(b.value as never),
  );
  const types = counted(without({ types: new Set() }), (bead) => [bead.issueType], filter.types).sort(
    (a, b) => b.count - a.count || a.value.localeCompare(b.value),
  );
  const priorities = counted(without({ priorities: new Set() }), (bead) => [priorityLabel(bead.priority)], filter.priorities).sort(
    (a, b) => a.value.localeCompare(b.value),
  );

  const labelRows = without({ labels: new Set() });
  const categoryOf = (label: string) => (label.includes(":") ? label.slice(0, label.indexOf(":")) : "other");
  const byCategory = new Map<string, FacetValue[]>();
  for (const entry of counted(labelRows, (bead) => bead.labels, filter.labels)) {
    const list = byCategory.get(categoryOf(entry.value)) ?? [];
    list.push(entry);
    byCategory.set(categoryOf(entry.value), list);
  }
  const rank = (category: string) => {
    const index = CATEGORY_ORDER.indexOf(category);
    return category === "other" ? 1000 : index === -1 ? 500 : index;
  };
  const labelGroups = [...byCategory.entries()]
    .map(([category, values]) => ({
      category,
      values: values.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
      selected: values.filter((value) => filter.labels.has(value.value)).length,
    }))
    // A group where every bead has the same label cannot narrow anything.
    .filter((group) => group.selected > 0 || !(group.values.length === 1 && group.values[0]!.count === labelRows.length))
    .sort((a, b) => rank(a.category) - rank(b.category) || a.category.localeCompare(b.category));

  const visible = (values: FacetValue[], selected: ReadonlySet<string>) =>
    values.filter((value) => value.count > 0 || selected.has(value.value));
  return {
    statuses: visible(statuses, filter.statuses),
    types: visible(types, filter.types),
    priorities: visible(priorities, filter.priorities),
    labelGroups: labelGroups
      .map((group) => ({ ...group, values: visible(group.values, filter.labels) }))
      .filter((group) => group.values.length > 0),
  };
}

/**
 * The values a label group shows: selected ones always, then the most common
 * up to `LABEL_PREVIEW` unless the group is expanded.
 */
export function previewValues(values: readonly FacetValue[], selected: ReadonlySet<string>, expanded: boolean): {
  shown: FacetValue[];
  hidden: number;
} {
  if (expanded) return { shown: [...values], hidden: 0 };
  const picked = values.filter((value) => selected.has(value.value));
  for (const value of values) {
    if (picked.length >= LABEL_PREVIEW) break;
    if (!selected.has(value.value)) picked.push(value);
  }
  return { shown: picked, hidden: values.length - picked.length };
}

/** Every active filter as a removable chip. */
export function activeFilters(filter: BeadFilter): Array<{ facet: keyof Omit<BeadFilter, "text">; value: string }> {
  return (["statuses", "types", "priorities", "labels"] as const).flatMap((facet) =>
    [...filter[facet]].map((value) => ({ facet, value })),
  );
}

// ---------------------------------------------------------------------------
// Sorting.
// ---------------------------------------------------------------------------

export type SortKey = "updated" | "created" | "closed" | "priority";

export const SORT_OPTIONS: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: "updated", label: "Updated" },
  { key: "created", label: "Created" },
  { key: "closed", label: "Closed" },
  { key: "priority", label: "Priority" },
];

/**
 * Newest first by default (`descending`). Beads without the sorted value (an
 * open bead has no close time) always go last, whichever the direction.
 */
export function sortBeads(beads: readonly BeadRow[], key: SortKey, descending = true): BeadRow[] {
  const valueOf = (bead: BeadRow): string | number | null => {
    switch (key) {
      case "updated":
        return bead.updatedAt;
      case "created":
        return bead.createdAt;
      case "closed":
        return bead.closedAt;
      case "priority":
        // P0 is the most urgent, so "descending" urgency is ascending numbers.
        return bead.priority === null ? null : -bead.priority;
    }
  };
  return [...beads].sort((a, b) => {
    const left = valueOf(a);
    const right = valueOf(b);
    if (left === null && right === null) return a.id.localeCompare(b.id);
    if (left === null) return 1;
    if (right === null) return -1;
    const order = left < right ? -1 : left > right ? 1 : 0;
    return (descending ? -order : order) || a.id.localeCompare(b.id);
  });
}

/** Within one facet any selected value matches; across facets all must match. */
export function filterBeads(beads: readonly BeadRow[], filter: BeadFilter): BeadRow[] {
  const text = filter.text.trim().toLowerCase();
  return beads.filter((bead) => {
    if (filter.statuses.size > 0 && !filter.statuses.has(statusBucket(bead))) return false;
    if (filter.types.size > 0 && !filter.types.has(bead.issueType)) return false;
    if (filter.priorities.size > 0 && !filter.priorities.has(priorityLabel(bead.priority))) return false;
    if (filter.labels.size > 0 && !bead.labels.some((label) => filter.labels.has(label))) return false;
    if (text !== "" && !`${bead.id} ${bead.title ?? ""}`.toLowerCase().includes(text)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Groups and the closed-beads toggle (delta 20260918e §4.4, owner Q9 and Q10).
// ---------------------------------------------------------------------------

/** The order of the list's groups: work in progress first, then what is stuck. */
export const STATUS_GROUP_ORDER: readonly StatusBucket[] = ["in_progress", "blocked", "ready", "closed"];

export interface BeadGroup {
  bucket: StatusBucket;
  /** The chip's words, so a group header and its rows' chips read the same. */
  label: string;
  tone: Tone;
  /** Every bead of the group, even when the list limit shows fewer. */
  total: number;
  beads: BeadRow[];
}

/**
 * Splits an already filtered and sorted list into its status groups, keeping
 * the order inside each group. Empty groups are dropped, and so is Closed while
 * closed beads are hidden. The list limit is spent in display order: a group
 * the limit leaves empty is dropped too, and its beads count as truncated.
 */
export function groupBeads(
  beads: readonly BeadRow[],
  options: { showClosed: boolean; limit: number },
): { groups: BeadGroup[]; visible: number; closed: number; truncated: number } {
  const byBucket = new Map<StatusBucket, BeadRow[]>(STATUS_GROUP_ORDER.map((bucket) => [bucket, []]));
  for (const bead of beads) byBucket.get(statusBucket(bead))!.push(bead);
  const closed = byBucket.get("closed")!.length;
  const groups: BeadGroup[] = [];
  let visible = 0;
  let budget = options.limit;
  for (const bucket of STATUS_GROUP_ORDER) {
    if (bucket === "closed" && !options.showClosed) continue;
    const all = byBucket.get(bucket)!;
    visible += all.length;
    const taken = all.slice(0, Math.max(0, budget));
    budget -= taken.length;
    if (taken.length === 0) continue;
    groups.push({ bucket, label: STATUS_TEXT[bucket], tone: STATUS_TONE[bucket], total: all.length, beads: taken });
  }
  const drawn = groups.reduce((sum, group) => sum + group.beads.length, 0);
  return { groups, visible, closed, truncated: visible - drawn };
}

/** A boolean that outlives the screen but not the app session: one per loaded client bundle. */
export interface SessionToggle {
  get(): boolean;
  set(value: boolean): void;
  subscribe(listener: () => void): () => void;
}

export function createSessionToggle(initial: boolean): SessionToggle {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * Whether the Beads screen shows closed beads. Hidden by default, remembered
 * while the app runs, back to hidden after a reload (owner decision Q9). The
 * screen on the surface and the one in the "Beads" tab share it.
 */
export const closedBeadsVisibility = createSessionToggle(false);

export function toggle(set: ReadonlySet<string>, value: string): Set<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

// ---------------------------------------------------------------------------
// Actions.
// ---------------------------------------------------------------------------

export interface ActionSpec {
  label: string;
  title: string;
  body: string;
  confirmLabel: string;
  danger: boolean;
}

export function actionSpec(action: BeadAction, bead: Pick<BeadRow, "id" | "status">): ActionSpec {
  switch (action) {
    case "implement":
      return {
        label: "Assign a Worker",
        title: `Assign ${bead.id} to a Worker?`,
        body: "The Beads Manager creates a Worker that implements this bead until it is closed with evidence. This uses model quota.",
        confirmLabel: "Yes, assign a Worker",
        danger: false,
      };
    case "delete":
      return {
        label: "Delete",
        title: `Ask a Worker to delete ${bead.id}?`,
        body: "A Worker first checks whether this bead is still needed. It deletes the bead only if it is not, and tells you why either way.",
        confirmLabel: "Yes, assess and delete",
        danger: true,
      };
    case "close":
      return {
        label: "Close",
        title: `Ask a Worker to close ${bead.id}?`,
        body: "A Worker checks whether the acceptance criteria are met. It closes the bead with evidence only if they are, otherwise it reports what is missing.",
        confirmLabel: "Yes, check and close",
        danger: false,
      };
  }
}

/** Which actions make sense for a bead. A closed bead cannot be closed again. */
export function actionsFor(bead: Pick<BeadRow, "status">): BeadAction[] {
  return bead.status === "closed" ? ["delete"] : ["implement", "close", "delete"];
}

// ---------------------------------------------------------------------------
// Who is working on an in-progress bead.
// ---------------------------------------------------------------------------

type WorkMark = NonNullable<BeadWork["started"]>;

/** Local `DD/MM HH:MM`: the screen is read by the person at this machine. */
export function formatClock(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  const two = (value: number) => String(value).padStart(2, "0");
  return `${two(date.getDate())}/${two(date.getMonth() + 1)} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

function workerName(mark: WorkMark): string {
  return mark.title ?? `Worker ${mark.agentId.slice(0, 8)}`;
}

function agentState(mark: WorkMark): string {
  return mark.status === null ? "no longer in Paseo" : mark.status;
}

export interface WorkSummary {
  /** One line for the list row. */
  headline: string;
  /** Lines for the open bead. */
  lines: string[];
  /** The Worker to open: the one that started it, else the last one seen. */
  agentId: string | null;
  /** Tone of the headline: running work reads differently from a stalled bead. */
  tone: Badge["tone"];
}

/**
 * What the Beads screen says about an in-progress bead. Never guesses: a start
 * time is shown only when a Worker's command set the status.
 */
export function workSummary(bead: Pick<BeadRow, "status" | "work">, now: Date): WorkSummary | null {
  if (bead.status !== "in_progress") return null;
  const { started = null, last = null } = bead.work ?? {};
  const current = started !== null && (last === null || last.agentId === started.agentId || last.at <= started.at) ? started : last;
  if (current === null) {
    return {
      headline: "In progress · no Worker recorded on it",
      lines: ["No Worker command or report named this bead since paseo-bm started recording."],
      agentId: null,
      tone: "muted",
    };
  }
  // The start belongs to whoever started it; a Worker that picked the bead up
  // later is shown with its own last activity instead.
  const since =
    current === started
      ? `since ${formatClock(started.at)} (${formatDuration(Math.max(0, now.getTime() - Date.parse(started.at)))})`
      : started === null
        ? "start not recorded"
        : `last active ${formatClock(current.at)}`;
  const lines: string[] = [];
  lines.push(
    started === null
      ? "Started: not recorded (the status was set before recording, or not with a br command)."
      : `Started ${formatClock(started.at)} by ${workerName(started)}.`,
  );
  if (last !== null) lines.push(`Last activity ${formatClock(last.at)} by ${workerName(last)}.`);
  lines.push(`${workerName(current)} is ${agentState(current)} now.`);
  return {
    headline: `${workerName(current)} · ${since} · ${agentState(current)}`,
    lines,
    agentId: current.agentId,
    tone: current.status === "running" ? "info" : current.status === null ? "warning" : "muted",
  };
}

/** A bead as a chat chip: its title first, then its id. */
export function beadChipText(bead: Pick<BeadRow, "id" | "title">, maxTitle = 48): string {
  const title = bead.title?.trim() ?? "";
  if (title === "") return bead.id;
  const short = title.length > maxTitle ? `${title.slice(0, maxTitle - 1)}…` : title;
  return `${short} · ${bead.id}`;
}
