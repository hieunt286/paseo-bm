import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Structural guard for the plugin payload (WP-108).
 *
 * It asserts shape, not behaviour: the manifest, the split runtime entries, the
 * Paseo 0.8 import boundaries, and the six mandatory headings of every role
 * instruction file. Behaviour is checked by WP-112, WP-113 and WP-114..116.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const pluginRoot = join(repoRoot, "plugin");

function read(relativePath: string): string {
  return readFileSync(join(pluginRoot, relativePath), "utf8");
}

function exists(relativePath: string): boolean {
  try {
    statSync(join(pluginRoot, relativePath));
    return true;
  } catch {
    return false;
  }
}

function sourceFilesUnder(relativeDir: string): string[] {
  const absolute = join(pluginRoot, relativeDir);
  const out: string[] = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFilesUnder(child));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(child);
    }
  }
  return out;
}

describe("plugin manifest", () => {
  it("declares the paseo-bm id and requires Paseo 0.8 or newer", () => {
    const manifest = JSON.parse(read("paseo-plugin.json")) as {
      id: string;
      requirements: { paseo: string };
    };
    expect(manifest.id).toBe("paseo-bm");
    expect(manifest.requirements.paseo).toBe(">=0.8.0");
  });

  // The payload ships as its own npm package, paseo-bm-plugin, and the
  // paseo.cafe registry compares the version in git against the one it resolves
  // on npm. Three files carry that version and none of them may drift:
  // package.json at the repo root is the source, and the build regenerates the
  // other two. ADR-009, design delta 20260923 §4.
  it("carries the same version in package.json, the payload package and PLUGIN_VERSION", () => {
    const root = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string };
    const payload = JSON.parse(read("package.json")) as { name: string; version: string };
    const baked = /PLUGIN_VERSION = "([^"]+)"/.exec(read("shared/version.ts"))?.[1];

    expect(payload.name).toBe("paseo-bm-plugin");
    expect(payload.version).toBe(root.version);
    expect(baked).toBe(root.version);
  });

  it("declares no dependencies and no test script it cannot honour", () => {
    const payload = JSON.parse(read("package.json")) as Record<string, unknown> & {
      scripts?: Record<string, string>;
    };
    // Paseo provides the runtime modules to a plugin, so the payload package
    // must not pull any of its own (ADR-001 Context).
    expect(payload.dependencies).toBeUndefined();
    expect(payload.devDependencies).toBeUndefined();
    // There is no test under plugin/. A `test` script here would exist only to
    // turn the registry's health badge green, which is a fake check.
    expect(payload.scripts?.test).toBeUndefined();
  });

  // The payload is published as a standalone package, and MIT requires the
  // notice in every copy, so plugin/LICENSE ships with it and must stay the
  // repository's own licence rather than drifting into a second one.
  it("ships the repository's licence, byte for byte", () => {
    expect(read("LICENSE")).toBe(readFileSync(join(repoRoot, "LICENSE"), "utf8"));
  });

  // There is deliberately no copy at the repo root. One existed while the
  // paseo.cafe entry pointed at the repository root; now that the entry
  // declares `path: "plugin"` and the payload package, nothing reads a root
  // manifest, and leaving one would make a direct `paseo plugin add` find a
  // plugin with no runtime entry beside it. ADR-009, listing record §10.
  it("is the repository's only manifest", () => {
    expect(existsSync(join(repoRoot, "paseo-plugin.json"))).toBe(false);
  });
});

describe("payload layout", () => {
  it.each([
    "paseo-plugin.json",
    "package.json",
    "README.md",
    "LICENSE",
    "tsconfig.json",
    "index.client.tsx",
    "index.server.ts",
    "shared/contracts.ts",
    "shared/version.ts",
    "server/manager-instructions.ts",
    "server/worker-instructions.ts",
    "server/reviewer-instructions.ts",
    "server/role-hook.ts",
    "client",
    "server",
    "roles",
  ])("ships %s", (relativePath) => {
    expect(exists(relativePath)).toBe(true);
  });

  it("keeps the payload free of node_modules", () => {
    expect(exists("node_modules")).toBe(false);
  });

  it("puts no code module other than the two entries in the plugin root", () => {
    const rootModules = readdirSync(pluginRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(ts|tsx)$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    expect(rootModules).toEqual(["index.client.tsx", "index.server.ts"]);
  });
});

describe("Paseo 0.8 import boundaries", () => {
  const clientFiles = ["index.client.tsx", ...sourceFilesUnder("client")];
  const serverFiles = ["index.server.ts", ...sourceFilesUnder("server")];
  const sharedFiles = sourceFilesUnder("shared");

  it.each(clientFiles)("%s imports no node: builtin", (file) => {
    expect(read(file)).not.toMatch(/from\s+["']node:/);
  });

  it.each(clientFiles)("%s does not reach into server/", (file) => {
    expect(read(file)).not.toMatch(/from\s+["'][^"']*\bserver\//);
  });

  it.each(serverFiles)("%s does not reach into client/", (file) => {
    expect(read(file)).not.toMatch(/from\s+["'][^"']*\bclient\//);
  });

  it.each(sharedFiles)("%s imports neither Node nor React Native", (file) => {
    const source = read(file);
    expect(source).not.toMatch(/from\s+["']node:/);
    expect(source).not.toMatch(/from\s+["']react-native["']/);
  });

  it.each(clientFiles)("%s uses no web-only UI constructs", (file) => {
    const source = read(file);
    expect(source).not.toMatch(/className=|onClick=|document\.|window\./);
  });
});

describe("shared/contracts.ts", () => {
  const source = read("shared/contracts.ts");

  it.each([
    "manager.ensure",
    "agents.list",
    "roles.describe",
    "traces.list",
    "traces.get",
    "traces.delete",
    "traces.reassign",
    "beads.stats",
    "beads.list",
    "beads.get",
    "beads.action",
    "traces.workspaces",
  ])("defines the %s RPC", (name) => {
    expect(source).toContain(`name: "${name}"`);
  });
});

describe("shared/version.ts", () => {
  it("carries the package version", () => {
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf8"),
    ) as { version: string };
    expect(read("shared/version.ts")).toContain(
      `export const PLUGIN_VERSION = "${manifest.version}";`,
    );
  });
});

describe("role instruction files", () => {
  const roleFiles = ["manager.md", "worker.md", "reviewer.md"];
  // Short files with the hard rules first (owner feedback, 2026-09-16).
  const requiredHeadings = ["## RULES", "## Stop"];
  // manager.md carries its stop handling inside the section that tells the user
  // what happens at each Worker phase (delta 20260917c §4.5).
  const STOP_ALIASES = ["## When to stop and report", "## Talking to the user"];

  it.each(roleFiles)("roles/%s exists", (file) => {
    expect(exists(join("roles", file))).toBe(true);
  });

  it.each(roleFiles)("roles/%s carries every required heading, in order", (file) => {
    const lines = read(join("roles", file)).split("\n");
    const found = requiredHeadings.filter((heading) =>
      lines.some((line) => line.trim() === heading || (heading === "## Stop" && STOP_ALIASES.includes(line.trim()))),
    );
    expect(found).toEqual(requiredHeadings);

    const positions = requiredHeadings.map((heading) =>
      lines.findIndex((line) => line.trim() === heading || (heading === "## Stop" && STOP_ALIASES.includes(line.trim()))),
    );
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it.each(roleFiles)("roles/%s is written in English", (file) => {
    // Agent-facing content is English (REQ-032a). Vietnamese-only letters are
    // the cheapest reliable signal that the rule was broken. Inline code spans
    // are literal sample data — e.g. a quoted user request that demonstrates
    // how diacritics are stripped from a label slug — not prose, so they are
    // removed before the check.
    const vietnameseLetters =
      /[ăâđêôơưĂÂĐÊÔƠƯàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụỳýỷỹỵ]/;
    const prose = read(join("roles", file)).replace(/`[^`\n]*`/g, "");
    expect(prose).not.toMatch(vietnameseLetters);
  });
});
