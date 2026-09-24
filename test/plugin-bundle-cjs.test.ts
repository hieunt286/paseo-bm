import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// The entry resolves the install home from $HOME when Paseo's config names no
// plugin path; point it at an empty directory so this machine's real
// ~/.paseo-bm (and any role-extras.json in it) never leaks into the test.
const realHome = process.env.HOME;
const isolatedHome = mkdtempSync(join(tmpdir(), "bm-isolated-home-"));
beforeAll(() => {
  process.env.HOME = isolatedHome;
});
afterAll(() => {
  process.env.HOME = realHome;
  rmSync(isolatedHome, { recursive: true, force: true });
});

/**
 * Regression for bm-dnc: the plugin must load the way Paseo 0.8 loads it.
 *
 * Paseo's `compileTarget` bundles `index.server.ts` with esbuild as CommonJS
 * (`format: "cjs"`, `platform: "node"`, `target: "node20"`, SDK and zod
 * external) and runs it in a forked worker without setting `cwd`. In that
 * bundle `import.meta` is empty, and neither `__dirname` nor `process.cwd()`
 * points at the payload. So the server entry may not locate anything on disk.
 *
 * The bundle is evaluated through the same wrapper and interop transform the
 * daemon applies (see loadBundle), with a fake Paseo SDK. No daemon is
 * contacted.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const entry = join(repoRoot, "plugin", "index.server.ts");
const managerMd = readFileSync(join(repoRoot, "plugin", "roles", "manager.md"), "utf8");
const workerMd = readFileSync(join(repoRoot, "plugin", "roles", "worker.md"), "utf8");
const reviewerMd = readFileSync(join(repoRoot, "plugin", "roles", "reviewer.md"), "utf8");

async function bundleServerEntry(): Promise<string> {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: "cjs",
    jsx: "automatic",
    platform: "node",
    target: "node20",
    external: ["@getpaseo/*", "zod"],
    write: false,
    logLevel: "silent",
  });
  expect(result.outputFiles).toHaveLength(1);
  return result.outputFiles[0]!.text;
}

type Handler = (input: unknown, context: { paseo: unknown }) => unknown;
type BeforeHandler = (input: { request: unknown }, context: unknown) => unknown;
type OnHandler = (event: unknown, context: { paseo: unknown; signal: AbortSignal }) => unknown;

/**
 * Evaluates the bundle exactly as Paseo 0.8 does (read from app.asar,
 * plugins/compiler.js and the plugin worker):
 *
 *   compileTarget -> wrapCommonJsBundle(makeHermesInteropEager(output))
 *   worker        -> factory = globalThis.eval(bundle); exports = factory(runtimeRequire);
 *                    setup = Reflect.get(exports, "default"); must be a function
 *
 * `makeHermesInteropEager` turns esbuild's lazy export getters into eager
 * copies, so a default export bound late (`const x = ...; export default x;`)
 * is copied while still undefined. Only a hoisted `export default function`
 * survives — which is what Paseo's own plugin template uses.
 */
function makeHermesInteropEager(code: string): string {
  return code.replaceAll("get: () => from[key]", "value: from[key]");
}

function wrapCommonJsBundle(code: string): string {
  return `(function(require) {\nconst module = { exports: {} };\nconst exports = module.exports;\n${code}\nreturn module.exports;\n})`;
}

function loadBundle(code: string): (server: unknown) => () => void {
  const requireFromRepo = createRequire(join(repoRoot, "package.json"));
  const runtimeRequire = (name: string): unknown => (name === "@getpaseo/plugin/server" ? {} : requireFromRepo(name));
  const evaluate = globalThis.eval as (source: string) => unknown;
  const factory = evaluate(wrapCommonJsBundle(makeHermesInteropEager(code)));
  expect(typeof factory).toBe("function");
  const exported = (factory as (req: typeof runtimeRequire) => unknown)(runtimeRequire);
  const setup = exported !== null && typeof exported === "object" ? Reflect.get(exported, "default") : undefined;
  if (typeof setup !== "function") {
    throw new Error("Plugin server bundle must default export a function");
  }
  return setup as (server: unknown) => () => void;
}

function fakeServer() {
  const handlers = new Map<string, Handler>();
  const beforeHooks = new Map<string, BeforeHandler>();
  // Two features now hook agent.turn_ended (bm-wq6 stop propagation and the
  // WP-205 trace collector), so this is a multimap, not a map.
  const onHooks = new Map<string, OnHandler[]>();
  const server = {
    registerSettings: vi.fn(),
    handle: vi.fn((contract: { name: string }, handler: Handler) => {
      handlers.set(contract.name, handler);
    }),
    before: vi.fn((name: string, handler: BeforeHandler) => {
      beforeHooks.set(name, handler);
      return () => {
        beforeHooks.delete(name);
      };
    }),
    on: vi.fn((name: string, handler: OnHandler) => {
      const existing = onHooks.get(name) ?? [];
      onHooks.set(name, [...existing, handler]);
      return () => {
        const left = (onHooks.get(name) ?? []).filter((entry) => entry !== handler);
        if (left.length === 0) onHooks.delete(name);
        else onHooks.set(name, left);
      };
    }),
  };
  return { server, handlers, beforeHooks, onHooks };
}

function fakePaseo() {
  const created: Array<{ workspaceId: string; options: { config: { systemPrompt?: string } } }> = [];
  const paseo = {
    agents: {
      async list() {
        return { entries: [], pageInfo: { nextCursor: null, hasMore: false } };
      },
    },
    workspaces: {
      ref(workspaceId: string) {
        return {
          agents: {
            async create(options: { config: { systemPrompt?: string } }) {
              created.push({ workspaceId, options });
              return {
                id: "created-1",
                current: () => ({ id: "created-1", createdAt: "2026-09-15T12:00:00.000Z", status: "initializing", labels: {} }),
                archive: async () => ({}),
              };
            },
          },
        };
      },
    },
    config: {
      async get() {
        return {
          requestId: "r-1",
          config: {
            providers: {
              claude: {},
              "bm-manager": { extends: "claude", label: "Beads Manager", paseoTools: { enabled: true } },
              "bm-worker": { extends: "codex", label: "Beads Worker", paseoTools: { enabled: true } },
              "bm-reviewer": { extends: "claude", label: "Beads Reviewer" },
            },
            agentProfiles: [
              { id: "bm-manager", name: "Beads Manager", provider: "bm-manager", model: "opus" },
              { id: "bm-worker", name: "Beads Worker", provider: "bm-worker", model: "gpt-5.6-sol" },
              { id: "bm-reviewer", name: "Beads Reviewer", provider: "bm-reviewer", model: "sonnet" },
            ],
          },
        };
      },
    },
  };
  return { paseo, created };
}

function pluginSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, dirent.name);
    if (dirent.isDirectory()) out.push(...pluginSourceFiles(path));
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(dirent.name)) out.push(path);
  }
  return out;
}

describe("no run-time file location in the plugin payload", () => {
  const files = pluginSourceFiles(join(repoRoot, "plugin"));

  it("finds the payload sources", () => {
    expect(files.map((file) => relative(repoRoot, file))).toContain("plugin/index.server.ts");
  });

  it.each(files.map((file) => [relative(repoRoot, file), file]))(
    "%s uses no import.meta, __dirname or process.cwd()",
    (_name, file) => {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/import\.meta/);
      expect(source).not.toMatch(/__dirname/);
      expect(source).not.toMatch(/process\.cwd\s*\(/);
    },
  );
});

describe("embedded role instructions", () => {
  it("server/manager-instructions.ts matches roles/manager.md byte for byte (run `npm run build` after editing the markdown)", async () => {
    const generated = await import("../plugin/server/manager-instructions");
    expect(Buffer.from(generated.MANAGER_INSTRUCTIONS, "utf8").equals(readFileSync(join(repoRoot, "plugin", "roles", "manager.md")))).toBe(true);
    expect(generated.MANAGER_INSTRUCTIONS_NAME).toBe("roles/manager.md");
  });

  it("server/worker-instructions.ts matches roles/worker.md byte for byte (run `npm run build` after editing the markdown)", async () => {
    const generated = await import("../plugin/server/worker-instructions");
    expect(Buffer.from(generated.WORKER_INSTRUCTIONS, "utf8").equals(readFileSync(join(repoRoot, "plugin", "roles", "worker.md")))).toBe(true);
    expect(generated.WORKER_INSTRUCTIONS_NAME).toBe("roles/worker.md");
  });

  it("server/reviewer-instructions.ts matches roles/reviewer.md byte for byte (run `npm run build` after editing the markdown)", async () => {
    const generated = await import("../plugin/server/reviewer-instructions");
    expect(Buffer.from(generated.REVIEWER_INSTRUCTIONS, "utf8").equals(readFileSync(join(repoRoot, "plugin", "roles", "reviewer.md")))).toBe(true);
    expect(generated.REVIEWER_INSTRUCTIONS_NAME).toBe("roles/reviewer.md");
  });
});

describe("server entry bundled as Paseo 0.8 bundles it (CJS)", () => {
  it("loads, registers every RPC, and manager.ensure / roles.describe run without throwing", async () => {
    const code = await bundleServerEntry();
    const contribute = loadBundle(code);

    const { server, handlers, beforeHooks, onHooks } = fakeServer();
    const cleanup = contribute(server);
    expect(typeof cleanup).toBe("function");
    // Phase 1's three, plus the Dashboard handlers registered so far (WP-208,
    // WP-210). All five Dashboard RPCs are registered.
    expect([...handlers.keys()].sort()).toEqual([
      "agents.list",
      "agents.stop-all",
      "answers.mark",
      "answers.marks",
      "beads.action",
      "beads.get",
      "beads.list",
      "beads.lookup",
      "beads.stats",
      "chat.beads",
      "chat.peers",
      "chat.waiting",
      "fallback.act",
      "fallback.incidents",
      "manager.ensure",
      "roles.describe",
      "roles.instructions",
      "roles.options",
      "roles.save-extra",
      "roles.save-fallback",
      "roles.save-settings",
      "roles.settings",
      "setup.install-tool",
      "setup.status",
      "traces.delete",
      "traces.get",
      "traces.list",
      "traces.reassign",
      "traces.workspaces",
      "workspaces.overview",
    ]);
    expect([...beforeHooks.keys()]).toEqual(["agent.create"]);
    // bm-wq6 propagates a Worker stop to its Reviewers on agent.turn_ended;
    // WP-205 adds the trace collector on turn_started and turn_ended; delta
    // 20260918g labels a bm-* agent created without bm.role on agent.created,
    // and starts its once-per-run label scan on agent.turn_started too; its
    // BM-FORMAT check runs on agent.turn_ended; delta 20260921 adds the
    // fallback detection on agent.turn_ended; delta 20260924 adds the
    // question–answer ledger on agent.turn_ended.
    expect([...onHooks.keys()].sort()).toEqual(["agent.created", "agent.turn_ended", "agent.turn_started"]);
    expect(onHooks.get("agent.turn_ended")).toHaveLength(5);
    expect(onHooks.get("agent.turn_started")).toHaveLength(2);
    expect(onHooks.get("agent.created")).toHaveLength(1);

    const { paseo, created } = fakePaseo();
    const ensured = await handlers.get("manager.ensure")!({ workspaceId: "ws-1" }, { paseo });
    expect(ensured).toEqual({ agentId: "created-1", created: true, otherManagerIds: [], modeNotice: null, toolsNotice: null });
    expect(created).toHaveLength(1);
    // The base, then the Runtime facts: `bm-worker` extends codex here, so the
    // plugin states the Worker's skills (design delta 20260924-instruction-quality
    // §3). Which skills this machine has is not the test's business.
    const prompt = created[0]!.options.config.systemPrompt as string;
    expect(prompt.startsWith(managerMd.trimEnd())).toBe(true);
    expect(prompt).toMatch(/\n## Runtime facts\n\n(?:Worker mode: [^\n]*\n)?Worker skills: (all present\.|missing `)/);

    const described = await handlers.get("roles.describe")!({}, { paseo });
    expect(described).toEqual({
      roles: [
        { role: "manager", provider: "claude", model: "opus", paseoTools: true, instructionsPath: "roles/manager.md" },
        { role: "worker", provider: "codex", model: "gpt-5.6-sol", paseoTools: true, instructionsPath: "roles/worker.md" },
        { role: "reviewer", provider: "claude", model: "sonnet", paseoTools: false, instructionsPath: "roles/reviewer.md" },
      ],
    });

    // bm-hld: the before("agent.create") hook injects role instructions from the bundle.
    const hook = beforeHooks.get("agent.create")!;
    const run = async (config: Record<string, unknown>) =>
      (await hook({ request: { config } }, { paseo })) as { config: { systemPrompt?: string } } | undefined;
    // This fake host lists no modes, so the bundled hook also gives the Worker
    // the fallback Reviewer mode `auto` (delta 20260918g §4.9, Q4 a / Q9 a).
    expect((await run({ provider: "bm-worker/gpt-5.6-sol", cwd: "/repo" }))?.config.systemPrompt).toBe(
      `${workerMd.trimEnd()}\n\n## Runtime facts\n\nReviewer mode: \`auto\` — pass it as \`settings.modeId\` when you create a Reviewer.\n`,
    );
    expect((await run({ provider: "bm-reviewer", cwd: "/repo" }))?.config.systemPrompt).toBe(reviewerMd);
    // A Manager that already carries its full instructions (base + Runtime facts) is left alone.
    expect(await run({ provider: "bm-manager", cwd: "/repo", systemPrompt: prompt })).toBeUndefined();
    // Another provider's agent is answered at once, without a lookup.
    expect(hook({ request: { config: { provider: "claude", cwd: "/repo" } } }, { paseo })).toBeUndefined();

    // Every bundled turn_ended hook resolves on an event it ignores (a non-bm
    // provider), without touching Paseo and without throwing into the turn.
    for (const handler of onHooks.get("agent.turn_ended")!) {
      await expect(
        Promise.resolve(
          handler(
            {
              agent: { id: "a-1", provider: "claude", workspaceId: "ws-1", parentAgentId: null, cwd: "/repo", title: null },
              turnId: "t-1",
              outcome: { kind: "canceled", reason: "x" },
              timeline: [],
            },
            { paseo, signal: new AbortController().signal },
          ),
        ),
      ).resolves.toBeUndefined();
    }

    cleanup();
    expect(beforeHooks.size).toBe(0);
    expect(onHooks.size).toBe(0);
  });
});

describe("entry default exports survive Paseo's eager interop", () => {
  it.each(["index.server.ts", "index.client.tsx"])(
    "plugin/%s default-exports a hoisted function declaration",
    (name) => {
      const source = readFileSync(join(repoRoot, "plugin", name), "utf8");
      expect(source).toMatch(/^export default function contribute\(/m);
      expect(source).not.toMatch(/^export default [A-Za-z_$][\w$]*;\s*$/m);
    },
  );
});
