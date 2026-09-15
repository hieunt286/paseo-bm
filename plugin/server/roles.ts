/**
 * `roles.describe` on the daemon side (WP-112, design §5, §3.2, REQ-032d).
 *
 * The answer comes from the install record, `<install home>/install.json`. The
 * plugin runs inside the daemon and does not import the CLI's `src/record.ts`,
 * so this module validates only the fields it reads, with Zod, and never
 * writes. Reading the file is injected (index.server.ts supplies the real one),
 * which keeps this module free of Node imports and testable without a disk.
 */
import { z } from "zod";
import type { RoleDescriptor } from "../shared/contracts";
import { bmRoleSchema } from "../shared/contracts";

/** Record schema version this plugin understands (design §3.2, ADR-002 decision 9). */
export const SUPPORTED_RECORD_SCHEMA_VERSION = 1;

/** The part of `install.json` schema v1 this RPC reads. Other fields are ignored. */
const recordSubsetSchema = z.object({
  installHome: z.string().min(1),
  roles: z.array(
    z.object({
      role: bmRoleSchema,
      baseProvider: z.string(),
      model: z.string(),
      paseoTools: z.boolean(),
    }),
  ),
  versions: z.array(z.object({ dir: z.string().min(1), active: z.boolean() })),
});

const ROLE_ORDER = ["manager", "worker", "reviewer"] as const;

export interface DescribeRolesDeps {
  /** Text of `install.json`, or `null` when the file does not exist. */
  readRecord: () => Promise<string | null>;
}

/**
 * Handler body of `roles.describe`.
 *
 * - No record → `{ roles: [] }` (nothing is registered that paseo-bm owns).
 * - `schemaVersion` above 1 → throws `E_RECORD_SCHEMA_TOO_NEW: …`.
 * - Unparseable or invalid record → throws a plain error naming the field; the
 *   registry has no code for this (see WP-112 report).
 *
 * `provider` is the role's `baseProvider` (the user's own tool, as in the §4.4
 * JSON example); `instructionsPath` is `roles/<role>.md` inside the active
 * payload version `<installHome>/<versions[active].dir>`.
 */
export async function describeRoles(deps: DescribeRolesDeps): Promise<{ roles: RoleDescriptor[] }> {
  const text = await deps.readRecord();
  if (text === null) return { roles: [] };

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("install.json is not valid JSON; run `npx paseo-bm doctor`.");
  }

  const schemaVersion =
    typeof raw === "object" && raw !== null ? (raw as { schemaVersion?: unknown }).schemaVersion : undefined;
  if (typeof schemaVersion !== "number") {
    throw new Error("install.json is not a valid install record: schemaVersion is missing.");
  }
  if (schemaVersion > SUPPORTED_RECORD_SCHEMA_VERSION) {
    throw new Error(
      `E_RECORD_SCHEMA_TOO_NEW: install.json uses schema ${schemaVersion}; this plugin understands ${SUPPORTED_RECORD_SCHEMA_VERSION}. Upgrade paseo-bm.`,
    );
  }

  const parsed = recordSubsetSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue ? issue.path.join(".") : "";
    throw new Error(
      `install.json is not a valid install record: ${path || "(root)"} ${issue?.message ?? ""}`.trim(),
    );
  }
  const record = parsed.data;

  const active = record.versions.find((version) => version.active);
  if (!active) {
    throw new Error("install.json is not a valid install record: no active payload version.");
  }
  const payloadDir = `${record.installHome.replace(/\/+$/, "")}/${active.dir.replace(/^\/+|\/+$/g, "")}`;

  const roles = [...record.roles]
    .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role))
    .map(
      (entry): RoleDescriptor => ({
        role: entry.role,
        provider: entry.baseProvider,
        model: entry.model,
        paseoTools: entry.paseoTools,
        instructionsPath: `${payloadDir}/roles/${entry.role}.md`,
      }),
    );
  return { roles };
}
