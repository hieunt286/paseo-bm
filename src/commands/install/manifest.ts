/**
 * The payload manifest — what `planInstall` calls `payload: PayloadFile[]`.
 *
 * The planner compares destinations against hashes; something has to produce
 * those hashes from the `plugin/` directory shipped inside the npm package
 * (ADR-001 decision 1). That is this module. It only reads.
 *
 * Rules:
 *
 * - **Every regular file is payload**, `roles/*.md` included (Design §2.4,
 *   §3.2 `files[]`). There is no include/exclude list: the package's `files`
 *   field already decides what ships, and a second filter here would be a
 *   second, silently diverging definition of "the payload".
 * - **Symlinks and special files are refused**, not followed. A link inside the
 *   payload could point anywhere on the publisher's or the user's machine, and
 *   copying through it would put bytes nobody reviewed into the plugin.
 * - **Paths are POSIX and sorted**, so the same package always yields the same
 *   manifest and the same plan, on every platform.
 */

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FILE_MODE, sha256 } from "../../fsops.js";
import type { PayloadFile } from "./planner.js";

/** The payload as the applier needs it: where to copy from, and what. */
export interface PayloadManifest {
  /** Absolute directory the payload is copied from (the package's `plugin/`). */
  readonly root: string;
  /** Every file, POSIX-relative to `root`, sorted, hashed. */
  readonly files: readonly PayloadFile[];
}

export type PayloadManifestErrorReason = "unsupported-entry" | "empty-payload" | "payload-not-found";

export class PayloadManifestError extends Error {
  readonly reason: PayloadManifestErrorReason;
  readonly path: string;

  constructor(reason: PayloadManifestErrorReason, message: string, path: string) {
    super(message);
    this.name = "PayloadManifestError";
    this.reason = reason;
    this.path = path;
  }
}

/** Walks `root` and hashes every regular file in it. Reads only. */
export async function buildPayloadManifest(root: string): Promise<PayloadManifest> {
  const absoluteRoot = resolve(root);
  const files: PayloadFile[] = [];
  await walk(absoluteRoot, [], files);
  if (files.length === 0) {
    throw new PayloadManifestError("empty-payload", `The payload directory has no files: ${absoluteRoot}`, absoluteRoot);
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { root: absoluteRoot, files };
}

async function walk(directory: string, segments: readonly string[], out: PayloadFile[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    const path = [...segments, entry.name];
    if (entry.isDirectory()) {
      await walk(absolute, path, out);
    } else if (entry.isFile()) {
      out.push({ path: path.join("/"), sha256: sha256(await readFile(absolute)), mode: FILE_MODE });
    } else {
      throw new PayloadManifestError(
        "unsupported-entry",
        `The payload may only contain regular files and directories; refusing ${absolute}`,
        absolute,
      );
    }
  }
}

/**
 * Finds the package's `plugin/` directory by walking up from this module until
 * a directory holds both `package.json` and `plugin/paseo-plugin.json`. Works
 * from `src/commands/install/` under Vitest and from the bundled `dist/`.
 */
export function findPayloadRoot(from: string = fileURLToPath(import.meta.url)): string {
  let current = resolve(from);
  for (;;) {
    const candidate = join(current, "plugin");
    if (existsSync(join(current, "package.json")) && existsSync(join(candidate, "paseo-plugin.json"))) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new PayloadManifestError(
        "payload-not-found",
        `Could not find the paseo-bm plugin payload above ${from}`,
        resolve(from),
      );
    }
    current = parent;
  }
}
