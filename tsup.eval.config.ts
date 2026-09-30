import { defineConfig } from "tsup";

/**
 * Bundles the evaluation scripts (docs/design/paseo-bm-evaluation.md §2) into
 * the git-ignored `.eval-dist/`, because the plugin modules they import use
 * extension-less paths that Node cannot load directly. Separate from
 * `tsup.config.ts` on purpose: the published build (`src/index.ts` → `dist/`)
 * must not change. Each npm script runs this config and then its own bundle;
 * a new script adds its entry here. `suite` must never import `replay`: with
 * code splitting a shared entry moves into a chunk and its "am I the main
 * module" check would stop matching, so the suite runs the replay bundle instead.
 */
export default defineConfig({
  entry: {
    replay: "scripts/eval/replay.ts",
    suite: "scripts/eval/suite.ts",
  },
  outDir: ".eval-dist",
  format: ["esm"],
  target: "node22",
  platform: "node",
  sourcemap: true,
  clean: true,
  silent: true,
});
