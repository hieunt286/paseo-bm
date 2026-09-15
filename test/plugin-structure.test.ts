import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
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
});

describe("payload layout", () => {
  it.each([
    "paseo-plugin.json",
    "tsconfig.json",
    "index.client.tsx",
    "index.server.ts",
    "shared/contracts.ts",
    "shared/version.ts",
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

  it.each(["manager.ensure", "agents.list", "roles.describe"])(
    "defines the %s RPC",
    (name) => {
      expect(source).toContain(`name: "${name}"`);
    },
  );
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
  const requiredHeadings = [
    "## Role",
    "## Responsibilities",
    "## Hard boundaries",
    "## Workflow",
    "## Reporting",
    "## Stop conditions",
  ];

  it.each(roleFiles)("roles/%s exists", (file) => {
    expect(exists(join("roles", file))).toBe(true);
  });

  it.each(roleFiles)("roles/%s carries every required heading, in order", (file) => {
    const lines = read(join("roles", file)).split("\n");
    const found = requiredHeadings.filter((heading) =>
      lines.some((line) => line.trim() === heading),
    );
    expect(found).toEqual(requiredHeadings);

    const positions = requiredHeadings.map((heading) =>
      lines.findIndex((line) => line.trim() === heading),
    );
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it.each(roleFiles)("roles/%s is written in English", (file) => {
    // Agent-facing content is English (REQ-032a). Vietnamese-only letters are
    // the cheapest reliable signal that the rule was broken.
    const vietnameseLetters =
      /[ăâđêôơưĂÂĐÊÔƠƯàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụỳýỷỹỵ]/;
    expect(read(join("roles", file))).not.toMatch(vietnameseLetters);
  });
});
