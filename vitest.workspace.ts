import { configDefaults, defineWorkspace } from "vitest/config";

// Three projects, and every test file lands in exactly one of them:
//
//   default  `npm test`            the product tests
//   bench    `npm run test:bench`  wall-clock benchmarks; they fail when other
//                                  files load the machine, so they run alone
//   eval     `npm run test:eval`   the eval tooling (scripts/eval): slow, spawns
//                                  git and tsc
//
// `npm run verify` runs all three. eval-metrics.test.ts stays in the default run:
// Insights reads those metrics, so it is a product test.

const BENCH = ["test/**/*-benchmark.test.ts"];
const EVAL = [
  "test/eval-links-audit.test.ts",
  "test/eval-owner.test.ts",
  "test/eval-replay.test.ts",
  "test/eval-scenarios.test.ts",
  "test/eval-score.test.ts",
  "test/eval-suite.test.ts",
];

export default defineWorkspace([
  {
    extends: "./vitest.config.ts",
    test: {
      name: "default",
      include: ["test/**/*.test.ts"],
      exclude: [...configDefaults.exclude, ...BENCH, ...EVAL],
    },
  },
  {
    extends: "./vitest.config.ts",
    test: {
      name: "bench",
      include: BENCH,
      // One file at a time, in one fork. `fileParallelism` is a root-only option
      // in Vitest 2; `singleFork` is the per-project way, and it also runs these
      // after every other project's files when all projects run together.
      pool: "forks",
      poolOptions: { forks: { singleFork: true } },
    },
  },
  {
    extends: "./vitest.config.ts",
    test: {
      name: "eval",
      include: EVAL,
    },
  },
]);
