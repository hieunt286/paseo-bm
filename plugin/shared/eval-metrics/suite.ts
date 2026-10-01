/**
 * The figures only the evaluation suite knows (evaluation design §4 "suite
 * only" rows): A-3 and A-9, `null` when the suite did not supply them.
 *
 * This module is `shared/`: no Node and no React Native imports.
 */
import { ratio } from "./helpers";
import type { EvalMetrics, EvalSuiteInputs } from "./types";

/** A-3: the messages and taps each decision the simulated owner settled took. */
export function a3Of(suite: EvalSuiteInputs | undefined): EvalMetrics["a3"] {
  const ownerActions = suite?.ownerActionsPerDecision;
  if (ownerActions === undefined) return null;
  const actionsTotal = ownerActions.reduce((sum, count) => sum + count, 0);
  return {
    decisions: ownerActions.length,
    actions: actionsTotal,
    perDecision: ratio(actionsTotal, ownerActions.length),
    max: ownerActions.length === 0 ? null : Math.max(...ownerActions),
  };
}

/** A-9: the scenario runs judged correct, boundary-clean, both, or not judged. */
export function a9Of(suite: EvalSuiteInputs | undefined): EvalMetrics["a9"] {
  const outcomes = suite?.scenarioOutcomes;
  if (outcomes === undefined) return null;
  return {
    scenarioRuns: outcomes.length,
    correct: outcomes.filter((outcome) => outcome.correct === true).length,
    boundaryClean: outcomes.filter((outcome) => outcome.boundaryClean === true).length,
    correctAndClean: outcomes.filter((outcome) => outcome.correct === true && outcome.boundaryClean === true).length,
    unknown: outcomes.filter((outcome) => outcome.correct === null || outcome.boundaryClean === null).length,
  };
}
