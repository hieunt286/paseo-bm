import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MIGRATION_BANNER_COMMAND, MIGRATION_BANNER_TEXT } from "../plugin/client/setup-model";

/**
 * WP-405: nothing in the payload sends a user back to the retired installer.
 *
 * From 0.4.0 the plugin is the whole product (ADR-012): it creates its own
 * roles, runs the skills CLI from Setup, and cleans up from Setup. The one
 * place `npx paseo-bm` may still appear is the banner that asks a 0.3.x
 * directory install to move to npm — and even that names the exact version.
 * A grep over the shipped payload is what keeps a stale sentence from coming
 * back with the next feature.
 */

const payload = join(dirname(fileURLToPath(import.meta.url)), "..", "plugin");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "node_modules" || entry === "images") continue;
      out.push(...sourceFiles(path));
      continue;
    }
    if (/\.(ts|tsx|md|json)$/.test(entry)) out.push(path);
  }
  return out;
}

/** Everything that ships inside the plugin package, except its user docs. */
const shipped = sourceFiles(payload).filter((path) => !/README\.md$/.test(path));

describe("the payload's own wording", () => {
  it("names `npx paseo-bm` only in the migration banner", () => {
    const offenders = shipped.filter((path) => {
      const text = readFileSync(path, "utf8");
      return text.includes("npx paseo-bm") && !text.includes(MIGRATION_BANNER_COMMAND);
    });

    expect(offenders.map((path) => relative(payload, path))).toEqual([]);

    // And in that one file, every mention is the versioned migration command.
    const model = readFileSync(join(payload, "client", "setup-model.ts"), "utf8");
    const mentions = model.match(/npx paseo-bm[^\s`"]*/g) ?? [];
    expect(mentions.length).toBeGreaterThan(0);
    expect([...new Set(mentions)]).toEqual([MIGRATION_BANNER_COMMAND]);
    expect(MIGRATION_BANNER_TEXT).toContain(MIGRATION_BANNER_COMMAND);
  });

  it("never calls the data folder an install home where a user can read it", () => {
    const offenders: string[] = [];
    for (const path of shipped) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        // Comments explain the history on purpose — `installHomeFromPluginPath`
        // really is about the installer's layout. Strings are what users see.
        const trimmed = line.trimStart();
        if (/^(\/\*|\*|\/\/|\{\/\*)/.test(trimmed)) continue;
        if (/install home/i.test(line)) offenders.push(`${relative(payload, path)}: ${line.trim()}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("points at Setup, not at a retired command, when something is missing", () => {
    const facts = readFileSync(join(payload, "server", "role-extras.ts"), "utf8");
    expect(facts).toContain("point to Beads Manager → Setup → Agent skills.");

    const tree = readFileSync(join(payload, "client", "agent-tree.ts"), "utf8");
    expect(tree).toContain("Open Beads Manager → Setup to create them.");
  });
});

describe("the plugin package's README, shown on npm and paseo.cafe", () => {
  const readme = readFileSync(join(payload, "README.md"), "utf8");

  it("names `npx paseo-bm` only in the section for users coming from it", () => {
    const section = readme.slice(readme.indexOf("## If you installed paseo-bm with"));
    const outside = readme.slice(0, readme.indexOf("## If you installed paseo-bm with"));

    expect(section).toContain(MIGRATION_BANNER_COMMAND);
    expect(outside).not.toContain("npx paseo-bm");
    // The refusal a user actually sees, so they can match it word for word.
    expect(section).toContain('Plugin ID "paseo-bm" is already configured; choose another ID with --id');
    expect(section).toContain("Do **not** choose another id");
  });

  it("gives the supported install, the Setup steps and the removal order", () => {
    expect(readme).toContain("paseo plugin add npm:paseo-bm-plugin");
    expect(readme).toContain("Paseo 0.9.0 or newer");
    expect(readme).toContain("Allow agent tools");
    expect(readme).toContain("Install skills");
    expect(readme).toContain("paseo plugin remove paseo-bm");
    expect(readme).toContain("paseo plugin update paseo-bm");
    expect(readme).toContain("https://github.com/cuongntr/agent-skills");
    expect(readme).toContain("paseo plugin logs paseo-bm");
  });

  it("never sends anyone to a command that no longer exists", () => {
    for (const gone of ["npx paseo-bm doctor", "paseo-bm uninstall", "paseo-bm install"]) {
      expect(readme).not.toContain(gone);
    }
  });
});

describe("the plugin package", () => {
  const pkg = JSON.parse(readFileSync(join(payload, "package.json"), "utf8")) as {
    description: string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
  };

  it("describes the paseo.cafe install, not the retired one", () => {
    expect(pkg.description).toBe(
      "Beads Management for Paseo: a Beads Manager agent that hands each request to a Beads Worker, " +
        'with Metric, Beads and Setup screens. Install from paseo.cafe or with "paseo plugin add npm:paseo-bm-plugin" (Paseo 0.9+).',
    );
  });

  it("has no dependencies and no test script", () => {
    // A `test` script here would exist only to turn the listing's health badge
    // green, and there is no test in `plugin/`: that is a fake check.
    expect(pkg.scripts?.test).toBeUndefined();
    expect(pkg.dependencies).toBeUndefined();
  });
});
