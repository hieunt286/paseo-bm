import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * Regression for bm-dnc: the plugin must load the way Paseo 0.8 loads it.
 *
 * Paseo's `compileTarget` bundles `index.server.ts` with esbuild as CommonJS
 * (`format: "cjs"`, `platform: "node"`, `target: "node20"`, SDK and zod
 * external) and runs it in a forked worker without setting `cwd`. In that
 * bundle `import.meta` is empty, and neither `__dirname` nor `process.cwd()`
 * points at the payload. So the server entry may not locate anything on disk.
 *
 * The bundle is evaluated here with a CommonJS wrapper whose `require` resolves
 * the externals from this repository, `__dirname` pointing somewhere unrelated,
 * and a fake Paseo SDK. No daemon is contacted.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const entry = join(repoRoot, "plugin", "index.server.ts");
const managerMd = readFileSync(join(repoRoot, "plugin", "roles", "manager.md"), "utf8");

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

/** Evaluates the CJS bundle and returns its default export, as Paseo's worker would. */
function loadBundle(code: string): (server: unknown) => () => void {
  const module = { exports: {} as Record<string, unknown> };
  const requireFromRepo = createRequire(join(repoRoot, "package.json"));
  const unrelatedDir = "/nonexistent/paseo-worker";
  const wrapper = new Function("exports", "require", "module", "__filename", "__dirname", code);
  wrapper(module.exports, requireFromRepo, module, join(unrelatedDir, "index.js"), unrelatedDir);
  const exported = module.exports as { default?: unknown };
  const contribute = exported.default ?? module.exports;
  expect(typeof contribute).toBe("function");
  return contribute as (server: unknown) => () => void;
}

function fakeServer() {
  const handlers = new Map<string, Handler>();
  const server = {
    handle: vi.fn((contract: { name: string }, handler: Handler) => {
      handlers.set(contract.name, handler);
    }),
  };
  return { server, handlers };
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

describe("embedded Manager instructions", () => {
  it("server/manager-instructions.ts matches roles/manager.md byte for byte (run `npm run build` after editing the markdown)", async () => {
    const generated = await import("../plugin/server/manager-instructions");
    expect(Buffer.from(generated.MANAGER_INSTRUCTIONS, "utf8").equals(readFileSync(join(repoRoot, "plugin", "roles", "manager.md")))).toBe(true);
    expect(generated.MANAGER_INSTRUCTIONS_NAME).toBe("roles/manager.md");
  });
});

describe("server entry bundled as Paseo 0.8 bundles it (CJS)", () => {
  it("loads, registers the three RPCs, and manager.ensure / roles.describe run without throwing", async () => {
    const code = await bundleServerEntry();
    const contribute = loadBundle(code);

    const { server, handlers } = fakeServer();
    const cleanup = contribute(server);
    expect(typeof cleanup).toBe("function");
    expect([...handlers.keys()].sort()).toEqual(["agents.list", "manager.ensure", "roles.describe"]);

    const { paseo, created } = fakePaseo();
    const ensured = await handlers.get("manager.ensure")!({ workspaceId: "ws-1" }, { paseo });
    expect(ensured).toEqual({ agentId: "created-1", created: true, otherManagerIds: [] });
    expect(created).toHaveLength(1);
    expect(created[0]!.options.config.systemPrompt).toBe(managerMd);

    const described = await handlers.get("roles.describe")!({}, { paseo });
    expect(described).toEqual({
      roles: [
        { role: "manager", provider: "claude", model: "opus", paseoTools: true, instructionsPath: "roles/manager.md" },
        { role: "worker", provider: "codex", model: "gpt-5.6-sol", paseoTools: true, instructionsPath: "roles/worker.md" },
        { role: "reviewer", provider: "claude", model: "sonnet", paseoTools: false, instructionsPath: "roles/reviewer.md" },
      ],
    });
  });
});
