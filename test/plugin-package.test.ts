import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * plugin-package/, the published form of the plugin (ADR-026): what the
 * paseo.cafe listing reads in Git and what npm publishes. It is generated from
 * plugin/ by `npm run build` and committed, so these checks hold it to the
 * source and to the limits of paseo.cafe's security scan.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const packageRoot = join(repoRoot, "plugin-package");
const read = (name: string) => readFileSync(join(packageRoot, name), "utf8");

/** paseo.cafe's scan: at most 200 reachable files and 2,000,000 bytes (static-scan.ts, paseo-cafe 4608732). */
const SCAN_MAX_BYTES = 2_000_000;

/** Modules Paseo provides at run time, as the scan's `isHostProvidedModule` lists them. */
const HOST_PROVIDED = /^(?:@getpaseo\/plugin(?:\/.*)?|zod(?:\/.*)?|react(?:\/.*)?|react-native(?:\/.*)?|@tanstack\/react-query)$/;
const NODE_BUILTIN = (specifier: string) => specifier.startsWith("node:") || builtinModules.includes(specifier);

/** Every module specifier a bundle imports or re-exports: esbuild hoists them all to the top level. */
function importsOf(code: string): string[] {
  const source = ts.createSourceFile("bundle.tsx", code, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  const out = new Set<string>();
  for (const statement of source.statements) {
    const specifier = ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) ? statement.moduleSpecifier : undefined;
    if (specifier !== undefined && ts.isStringLiteral(specifier)) out.add(specifier.text);
  }
  return [...out].sort();
}

function filesUnder(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...filesUnder(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

describe("plugin-package/ (ADR-026)", () => {
  it("is what a fresh build writes from plugin/ (run `npm run build` after changing plugin/)", () => {
    // --check exits 1 and names every file that differs, or that the build does not write.
    expect(() => execFileSync(process.execPath, [join(repoRoot, "scripts", "generate-plugin-package.mjs"), "--check"], { stdio: "pipe" })).not.toThrow();
  }, 60_000);

  it("holds the two bundled entries, the manifest, package.json, README.md, LICENSE and the listing's images, nothing else", () => {
    const files = filesUnder(packageRoot).sort();
    const images = readdirSync(join(repoRoot, "plugin", "images")).filter((name) => !name.startsWith(".")).map((name) => `images/${name}`);
    expect(files).toEqual(["LICENSE", "README.md", "index.client.tsx", "index.server.ts", "package.json", "paseo-plugin.json", ...images].sort());
  });

  it("stays within paseo.cafe's scan budget", () => {
    const bytes = Buffer.byteLength(read("index.server.ts")) + Buffer.byteLength(read("index.client.tsx"));
    expect(bytes).toBeLessThanOrEqual(SCAN_MAX_BYTES);
  });

  it("copies the manifest, README.md and LICENSE from plugin/ byte for byte", () => {
    for (const name of ["paseo-plugin.json", "README.md", "LICENSE"]) {
      expect(read(name), name).toBe(readFileSync(join(repoRoot, "plugin", name), "utf8"));
    }
  });

  it("publishes as paseo-bm-plugin at the plugin's version, with no scripts and no dependencies", () => {
    const source = JSON.parse(readFileSync(join(repoRoot, "plugin", "package.json"), "utf8")) as Record<string, unknown>;
    const published = JSON.parse(read("package.json")) as Record<string, unknown>;
    expect(published.name).toBe("paseo-bm-plugin");
    expect(published.version).toBe(source.version);
    expect(published.files).toEqual(["paseo-plugin.json", "index.client.tsx", "index.server.ts", "LICENSE", "README.md"]);
    expect(published.repository).toEqual({ type: "git", url: "git+https://github.com/hieunt286/paseo-bm.git", directory: "plugin-package" });
    // A typecheck script would have nothing to check here: a fake check (AGENTS.md).
    expect(published).not.toHaveProperty("scripts");
    expect(published).not.toHaveProperty("dependencies");
  });

  it("server bundle imports only what Paseo provides to a server", () => {
    const imports = importsOf(read("index.server.ts"));
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((specifier) => !HOST_PROVIDED.test(specifier) && !NODE_BUILTIN(specifier))).toEqual([]);
    // Client-only modules in a server bundle are refused by the scan (runtime-module-import).
    expect(imports.filter((specifier) => /^(?:react|react-native)(?:\/|$)|^@getpaseo\/plugin\/client/.test(specifier))).toEqual([]);
  });

  it("client bundle imports only what Paseo provides to a client: no Node built-in and no server SDK", () => {
    const imports = importsOf(read("index.client.tsx"));
    expect(imports).toContain("react");
    expect(imports.filter((specifier) => !HOST_PROVIDED.test(specifier))).toEqual([]);
    expect(imports.filter((specifier) => NODE_BUILTIN(specifier) || specifier.startsWith("@getpaseo/plugin/server"))).toEqual([]);
  });

  it.each(["index.server.ts", "index.client.tsx"])("%s default-exports the entry's hoisted contribute function", (name) => {
    // Paseo's eager interop copies the default export at load: only a hoisted function survives (plugin-bundle-cjs.test.ts).
    const code = read(name);
    expect(code).toMatch(/\bfunction contribute\(/);
    expect(code).toMatch(/export\s*\{[^}]*\bcontribute as default\b/);
  });
});
