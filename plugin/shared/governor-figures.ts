/**
 * The governor's figure definitions (missions design §9.2; ADR-029): its
 * families, every figure and its family, one figure's shape and its words.
 * The figures themselves are read in `server/governor-figures.ts`; the ladder
 * (`server/governor-store.ts`) and the event bus read these definitions.
 *
 * `shared/`, pure: no import at all, so no module that reads the definitions
 * joins an import cycle through the stores the figures read.
 */

export const GOVERNOR_FAMILIES = ["mess", "overengineering", "drift", "stuck", "budget"] as const;
export type GovernorFamily = (typeof GOVERNOR_FAMILIES)[number];

/** Every figure and its family, in the order of the design's table. */
export const GOVERNOR_FIGURES = {
  writersOnOneFile: "mess",
  workersInOneRepo: "mess",
  reAsks: "mess",
  dropped: "mess",
  processDocsPerCriterion: "overengineering",
  beadsPerFinishedRequest: "overengineering",
  tierRaised: "overengineering",
  reviewBudgetExhausted: "overengineering",
  openApprovals: "overengineering",
  mainTurnsSinceCriterion: "drift",
  finishedSinceCriterion: "drift",
  outsideCharter: "drift",
  stalled: "stuck",
  unansweredLinks: "stuck",
  oldCards: "stuck",
  requestsBudget: "budget",
  workersBudget: "budget",
  reviewCallsBudget: "budget",
  daysBudget: "budget",
} as const satisfies Record<string, GovernorFamily>;
export type GovernorFigureId = keyof typeof GOVERNOR_FIGURES;

/** Every figure id, in `GOVERNOR_FIGURES` order. */
export const GOVERNOR_FIGURE_IDS = Object.keys(GOVERNOR_FIGURES) as [GovernorFigureId, ...GovernorFigureId[]];

/** Longest `detail` a figure keeps. */
export const MAX_FIGURE_DETAIL = 200;

/** One figure now. */
export interface GovernorFigure {
  family: GovernorFamily;
  id: GovernorFigureId;
  value: number;
  threshold: number;
  /** `>=`: crossed on reaching the threshold; `>`: on passing it. */
  op: ">=" | ">";
  crossed: boolean;
  /** Which file, repo or request it is about, when that helps; else null. */
  detail: string | null;
}

/** The figures of one family. Pure. */
export function familyFiguresOf(figures: readonly GovernorFigure[], family: GovernorFamily): GovernorFigure[] {
  return figures.filter((entry) => entry.family === family);
}

/** One figure in words: `writersOnOneFile 2 (threshold ≥ 2; repo-a: src/a.ts)`. Pure. */
export function figureText(entry: Pick<GovernorFigure, "id" | "value" | "threshold" | "op" | "detail">): string {
  const detail = entry.detail === null ? "" : `; ${entry.detail}`;
  return `${entry.id} ${entry.value} (threshold ${entry.op === ">=" ? "≥" : ">"} ${entry.threshold}${detail})`;
}
