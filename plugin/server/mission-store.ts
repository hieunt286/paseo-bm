/**
 * Missions (missions design §2.1, §2.2; ADR-029): what a mission is, its
 * index and its journal.
 *
 * - `<data folder>/missions/<missionId>.json` — one mission, the source of
 *   everything a successor Main needs (§1 principle 3).
 * - `missions/index.json` — `{ missionId, code, name, state, mainId, repos }`
 *   per mission, rewritten with each mission write, for lists and code
 *   lookups. A missing or stale index (a mission file newer than it, or the
 *   set of missions changed) is rebuilt from the mission files.
 * - `missions/<missionId>.journal.jsonl` — append-only, one line per event,
 *   the newest `MAX_JOURNAL_LINES` kept. What happened, never a source of state.
 *
 * Files are `createJsonFileStore` files (`0700` folder, `0600` files, atomic
 * writes, no symlink, a newer `schemaVersion` read as empty and never
 * written); a mission file that cannot be used is never overwritten. Every
 * change is one synchronous read-modify-write: the plugin server is one
 * thread. Every text field is masked with `redactText` and kept to its bound
 * on each write. Readers never throw; a change the rules refuse is a result
 * with one line per reason.
 */
import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { redactText } from "./collector";
import {
  appendToFile,
  assertNoSymlink,
  createJsonFileStore,
  ensureDataDir,
  entriesOf,
  writeFileAtomically,
  type JsonFileStore,
} from "./data-files";

/** The missions' folder in the data folder (§2); the cleanup button deletes it. */
export const MISSIONS_DIR_NAME = "missions";
export const MISSIONS_VERSION = 1;
export const MISSION_INDEX_FILE_NAME = "index.json";
/** `mis-` + 10 hex digits: stable, never shown alone. */
export const MISSION_ID_PATTERN = /^mis-[0-9a-f]{10}$/;
/** The owner's short code, unique among open missions. */
export const MISSION_CODE_PATTERN = /^[A-Z][A-Z0-9]{1,7}$/;
export const MAX_MISSION_NAME = 80;
export const MAX_MISSION_GOAL = 4_000;
export const MAX_NON_GOAL = 300;
export const MAX_NON_GOALS = 20;
export const MAX_CRITERION_TEXT = 500;
export const MAX_CRITERION_EVIDENCE = 500;
export const MAX_MISSION_PLAN = 20_000;
export const MAX_CONTRACT_TEXT = 4_000;
/** Not bounded by §2.1: kept to one line's worth. */
export const MAX_CONTRACT_TITLE = 200;
/** Not bounded by §2.1: as long as a memory entry's source (§2.5). */
export const MAX_CONTRACT_SOURCE = 300;
/** Not bounded by §2.1: as long as a criterion. */
export const MAX_SPLIT_REASON = 500;
/** A split suggestion's bounds (`bm_split_mission`, §9.6): as `bm_create_main`'s. */
export const MAX_SPLIT_REPOS = 20;
export const MAX_SPLIT_REQUESTS = 50;
/** The newest journal lines kept (§2.2). */
export const MAX_JOURNAL_LINES = 5_000;
export const MAX_JOURNAL_TEXT = 500;

export const MISSION_CREATORS = ["owner", "orchestrator", "legacy"] as const;
export const MAIN_CHANGE_REASONS = ["created", "replaced", "fallback", "handoff", "owner"] as const;
export const JOURNAL_KINDS = ["charter", "plan", "criterion", "contract", "worker", "link", "decision", "main", "governor", "note", "split-suggested"] as const;
export type JournalKind = (typeof JOURNAL_KINDS)[number];

const isoOrNull = z.string().nullable();

const criterionSchema = z.object({
  id: z.string().regex(/^D\d{1,4}$/),
  text: z.string(),
  status: z.enum(["open", "met", "dropped"]),
  at: isoOrNull,
  evidence: z.string().nullable(),
});

const contractSchema = z.object({
  id: z.string().regex(/^C\d{1,4}$/),
  title: z.string(),
  providerRepo: z.string().min(1),
  consumerRepos: z.array(z.string().min(1)),
  text: z.string(),
  version: z.number().int().min(1),
  updatedAt: z.string(),
  source: z.string(),
});

const budgetSchema = z.object({
  requests: z.number().int().min(0).nullable(),
  workers: z.number().int().min(0).nullable(),
  reviewCalls: z.number().int().min(0).nullable(),
  days: z.number().min(0).nullable(),
});

export const missionSchema = z.object({
  missionId: z.string().regex(MISSION_ID_PATTERN),
  code: z.string().regex(MISSION_CODE_PATTERN),
  name: z.string(),
  state: z.enum(["open", "closed"]),
  createdAt: z.string(),
  closedAt: isoOrNull,
  createdBy: z.enum(MISSION_CREATORS),
  parentMissionId: z.string().regex(MISSION_ID_PATTERN).nullable(),
  splitReason: z.string().nullable(),
  legacyWorkspaceId: z.string().min(1).nullable(),
  mainId: z.string().min(1).nullable(),
  mainHistory: z.array(z.object({ agentId: z.string().min(1), from: z.string(), to: isoOrNull, reason: z.enum(MAIN_CHANGE_REASONS) })),
  charter: z.object({
    goal: z.string(),
    repos: z.array(z.string().min(1)),
    nonGoals: z.array(z.string()),
    doneCriteria: z.array(criterionSchema),
    budget: budgetSchema.nullable(),
    confirmedAt: isoOrNull,
  }),
  plan: z.object({ text: z.string(), updatedAt: isoOrNull }),
  contracts: z.array(contractSchema),
});

export type Mission = z.infer<typeof missionSchema>;
export type MissionCriterion = z.infer<typeof criterionSchema>;
export type MissionContract = z.infer<typeof contractSchema>;

const indexEntrySchema = z.object({
  missionId: z.string().regex(MISSION_ID_PATTERN),
  code: z.string(),
  name: z.string(),
  state: z.enum(["open", "closed"]),
  mainId: z.string().nullable(),
  repos: z.array(z.string()),
});

export type MissionIndexEntry = z.infer<typeof indexEntrySchema>;

/** What a `split-suggested` line carries (§9.6): the fields `bm_create_main` takes, bar the source mission. */
const splitSuggestionSchema = z.object({
  code: z.string(),
  name: z.string(),
  goal: z.string(),
  repos: z.array(z.string()),
  requestIds: z.array(z.string()),
  reason: z.string(),
});

export type SplitSuggestionFields = z.infer<typeof splitSuggestionSchema>;

const journalSchema = z.object({
  at: z.string(),
  kind: z.enum(JOURNAL_KINDS),
  by: z.string().min(1),
  text: z.string(),
  ref: z.string().optional(),
  /** Only on a `split-suggested` line. */
  split: splitSuggestionSchema.optional(),
});

export type JournalEntry = z.infer<typeof journalSchema>;

/** A change the store made, or why it refused (one line per reason). */
export type MissionResult = { ok: true; mission: Mission } | { ok: false; reasons: string[] };

/** A fresh mission id: `mis-` + 10 hex digits. */
export function newMissionId(): string {
  return `mis-${randomBytes(5).toString("hex")}`;
}

/** `text` masked and kept to `limit` characters. */
function bounded(text: string, limit: number, env: NodeJS.ProcessEnv): string {
  return redactText(text, env).slice(0, limit);
}

/** `mission` with every text field masked and every bound of §2.1 applied. Pure but for `env`. */
export function boundedMission(mission: Mission, env: NodeJS.ProcessEnv = process.env): Mission {
  const text = (value: string, limit: number) => bounded(value, limit, env);
  const orNull = (value: string | null, limit: number) => (value === null ? null : text(value, limit));
  return {
    ...mission,
    name: text(mission.name, MAX_MISSION_NAME),
    splitReason: orNull(mission.splitReason, MAX_SPLIT_REASON),
    charter: {
      ...mission.charter,
      goal: text(mission.charter.goal, MAX_MISSION_GOAL),
      nonGoals: mission.charter.nonGoals.slice(0, MAX_NON_GOALS).map((goal) => text(goal, MAX_NON_GOAL)),
      doneCriteria: mission.charter.doneCriteria.map((criterion) => ({
        ...criterion,
        text: text(criterion.text, MAX_CRITERION_TEXT),
        evidence: orNull(criterion.evidence, MAX_CRITERION_EVIDENCE),
      })),
    },
    plan: { ...mission.plan, text: text(mission.plan.text, MAX_MISSION_PLAN) },
    contracts: mission.contracts.map((contract) => ({
      ...contract,
      title: text(contract.title, MAX_CONTRACT_TITLE),
      text: text(contract.text, MAX_CONTRACT_TEXT),
      source: text(contract.source, MAX_CONTRACT_SOURCE),
    })),
  };
}

/** A split suggestion masked and kept to its bounds. Pure but for `env`. */
function boundedSplit(split: SplitSuggestionFields, env: NodeJS.ProcessEnv): SplitSuggestionFields {
  return {
    code: split.code,
    name: bounded(split.name, MAX_MISSION_NAME, env),
    goal: bounded(split.goal, MAX_MISSION_GOAL, env),
    repos: split.repos.slice(0, MAX_SPLIT_REPOS),
    requestIds: split.requestIds.slice(0, MAX_SPLIT_REQUESTS),
    reason: bounded(split.reason, MAX_SPLIT_REASON, env),
  };
}

/** The index entry of a mission. Pure. */
export function indexEntryOf(mission: Mission): MissionIndexEntry {
  const { missionId, code, name, state, mainId } = mission;
  return { missionId, code, name, state, mainId, repos: [...mission.charter.repos] };
}

/** What a new mission starts with; the rest is empty. */
export interface NewMission {
  code: string;
  name: string;
  goal: string;
  repos: readonly string[];
  createdBy: Mission["createdBy"];
  mainId?: string | null;
  parentMissionId?: string | null;
  splitReason?: string | null;
  legacyWorkspaceId?: string | null;
}

/** What a journal line says; `at` is now. Text masked, on one line, cut to `MAX_JOURNAL_TEXT`. */
export interface NewJournalEntry {
  kind: JournalKind;
  by: string;
  text: string;
  ref?: string;
  /** A `split-suggested` line's suggestion; masked and bounded like a mission's fields. */
  split?: SplitSuggestionFields;
}

export interface MissionStoreDeps {
  now?: () => Date;
  /** The mission id generator; `newMissionId` by default (tests pin it). */
  newId?: () => string;
  /** Secrets to mask; the process's own by default. */
  env?: NodeJS.ProcessEnv;
}

export interface MissionStore {
  /** `<data folder>/missions`. */
  readonly dir: string;
  /** One mission, or null. Never throws. */
  get(missionId: string): Mission | null;
  /** Every mission's index entry, as the mission files say (rebuilt when missing or stale). Never throws. */
  list(): MissionIndexEntry[];
  /** The open mission with this code, else the newest closed one, else null. Never throws. */
  byCode(code: string): MissionIndexEntry | null;
  /** A new open mission. Refused: a code of another shape or one an open mission holds. Throws when a file cannot be written. */
  create(init: NewMission): MissionResult;
  /**
   * One read-modify-write of a mission: `change` returns the mission as it
   * should be, null for no change, or the refusal. Refused as well: a missing
   * mission, a change of `missionId`, a code another open mission holds (also
   * when reopening). Throws when a file cannot be written.
   */
  update(missionId: string, change: (mission: Mission) => Mission | null | { reasons: string[] }): MissionResult;
  /** The mission's Main becomes `agentId`: the current history entry ends now and a new one starts. Throws when a file cannot be written. */
  setMain(missionId: string, agentId: string, reason: Mission["mainHistory"][number]["reason"]): MissionResult;
  /** Appends a journal line (the newest `MAX_JOURNAL_LINES` kept). Throws when the file cannot be written. */
  appendJournal(missionId: string, entry: NewJournalEntry): JournalEntry;
  /** The newest `limit` journal lines, oldest first; a line that does not parse is skipped. Never throws. */
  journal(missionId: string, limit?: number): JournalEntry[];
}

/** A mission file's content: the mission, or `{}` for a missing one. */
type MissionFile = Mission | Record<string, never>;

function isMission(value: MissionFile): value is Mission {
  return "missionId" in value;
}

const UNWRITABLE = "E_TRACE_STORE_UNWRITABLE" as const;
const MISSION_FILE = /^(mis-[0-9a-f]{10})\.json$/;

function mtimeOf(path: string): number | null {
  try {
    return lstatSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** The mission store of the data folder `home`. Creating it touches nothing on disk. */
export function createMissionStore(home: string, deps: MissionStoreDeps = {}): MissionStore {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? newMissionId;
  const env = deps.env ?? process.env;
  const dir = join(home, MISSIONS_DIR_NAME);

  // The file is the mission itself, its version first; a missing one reads as `{}`.
  const missionFile = (missionId: string): JsonFileStore<MissionFile> =>
    createJsonFileStore<MissionFile>({
      home,
      dir: MISSIONS_DIR_NAME,
      file: `${missionId}.json`,
      version: MISSIONS_VERSION,
      versionKey: "schemaVersion",
      parse: (body) => missionSchema.parse(body),
      empty: () => ({}),
      cap: (value) => (isMission(value) ? boundedMission(value, env) : value),
      codes: { unwritable: UNWRITABLE },
      keepUnusable: true,
      cached: true,
    });

  const indexFile = createJsonFileStore<{ missions: MissionIndexEntry[] }>({
    home,
    dir: MISSIONS_DIR_NAME,
    file: MISSION_INDEX_FILE_NAME,
    version: MISSIONS_VERSION,
    versionKey: "schemaVersion",
    parse: (body) => ({ missions: entriesOf(indexEntrySchema, body["missions"]) }),
    empty: () => ({ missions: [] }),
    codes: { unwritable: UNWRITABLE },
    // Derived from the mission files: an unusable index is simply rebuilt.
  });

  /** The ids and mtimes of the mission files. */
  const missionFiles = (): Array<{ missionId: string; mtimeMs: number }> => {
    try {
      assertNoSymlink(home, dir, UNWRITABLE);
      return readdirSync(dir)
        .flatMap((name) => {
          const match = MISSION_FILE.exec(name);
          const mtimeMs = match === null ? null : mtimeOf(join(dir, name));
          return match === null || mtimeMs === null ? [] : [{ missionId: match[1]!, mtimeMs }];
        })
        .sort((a, b) => a.missionId.localeCompare(b.missionId));
    } catch {
      return [];
    }
  };

  const get = (missionId: string): Mission | null => {
    if (!MISSION_ID_PATTERN.test(missionId)) return null;
    try {
      const found = missionFile(missionId).read();
      return isMission(found) ? found : null;
    } catch {
      return null;
    }
  };

  /** Writes the index; a failure leaves the old one, which the next read finds stale. */
  const writeIndex = (missions: MissionIndexEntry[]): void => {
    try {
      indexFile.write({ missions });
    } catch {
      // Rebuilt from the mission files at the next read.
    }
  };

  const list = (): MissionIndexEntry[] => {
    const files = missionFiles();
    try {
      const found = indexFile.inspect();
      const indexAt = mtimeOf(indexFile.path);
      const ids = found.value.missions.map((entry) => entry.missionId).sort();
      const fresh =
        found.state === "ok" &&
        indexAt !== null &&
        ids.length === files.length &&
        files.every((file, at) => file.missionId === ids[at] && file.mtimeMs <= indexAt);
      if (fresh) return found.value.missions;
    } catch {
      // A symlinked index: rebuilt below, in memory.
    }
    const rebuilt = files.flatMap((file) => {
      const mission = get(file.missionId);
      return mission === null ? [] : [indexEntryOf(mission)];
    });
    if (files.length > 0) writeIndex(rebuilt);
    return rebuilt;
  };

  const codeTakenBy = (code: string, missionId: string | null): MissionIndexEntry | undefined =>
    list().find((entry) => entry.state === "open" && entry.code === code && entry.missionId !== missionId);

  /** Writes a mission, then its index entry. */
  const put = (mission: Mission): Mission => {
    const before = list().filter((entry) => entry.missionId !== mission.missionId);
    const written = missionFile(mission.missionId).write(mission) as Mission;
    writeIndex([...before, indexEntryOf(written)]);
    return written;
  };

  const update: MissionStore["update"] = (missionId, change) => {
    const current = get(missionId);
    if (current === null) return { ok: false, reasons: [`unknown mission ${missionId}`] };
    const next = change(current);
    if (next === null) return { ok: true, mission: current };
    if ("reasons" in next) return { ok: false, reasons: next.reasons };
    const valid = missionSchema.safeParse(next);
    if (!valid.success) return { ok: false, reasons: valid.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) };
    if (valid.data.missionId !== missionId) return { ok: false, reasons: ["a mission's id never changes"] };
    const taken = valid.data.state === "open" ? codeTakenBy(valid.data.code, missionId) : undefined;
    if (taken !== undefined) return { ok: false, reasons: [`code ${valid.data.code} is taken by the open mission ${taken.name} (${taken.missionId})`] };
    return { ok: true, mission: put(valid.data) };
  };

  const journalPath = (missionId: string): string => join(dir, `${missionId}.journal.jsonl`);

  /** The journal's lines, and whether its last line is whole (ends the file with a newline). */
  const journalLines = (missionId: string): { lines: string[]; whole: boolean } => {
    const path = journalPath(missionId);
    assertNoSymlink(home, path, UNWRITABLE);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return { lines: [], whole: true };
    }
    return { lines: text.split("\n").filter((line) => line.trim() !== ""), whole: text === "" || text.endsWith("\n") };
  };

  return {
    dir,
    get,
    list,
    byCode(code) {
      const named = list().filter((entry) => entry.code === code);
      return named.find((entry) => entry.state === "open") ?? named.at(-1) ?? null;
    },
    create(init) {
      const reasons: string[] = [];
      if (!MISSION_CODE_PATTERN.test(init.code)) reasons.push(`code ${JSON.stringify(init.code)} is not 2 to 8 capital letters or digits starting with a letter`);
      const taken = MISSION_CODE_PATTERN.test(init.code) ? codeTakenBy(init.code, null) : undefined;
      if (taken !== undefined) reasons.push(`code ${init.code} is taken by the open mission ${taken.name} (${taken.missionId})`);
      if (reasons.length > 0) return { ok: false, reasons };
      const known = new Set(missionFiles().map((file) => file.missionId));
      let missionId = newId();
      while (known.has(missionId)) missionId = newId();
      const at = now().toISOString();
      const mainId = init.mainId ?? null;
      const mission = missionSchema.parse({
        missionId,
        code: init.code,
        name: init.name,
        state: "open",
        createdAt: at,
        closedAt: null,
        createdBy: init.createdBy,
        parentMissionId: init.parentMissionId ?? null,
        splitReason: init.splitReason ?? null,
        legacyWorkspaceId: init.legacyWorkspaceId ?? null,
        mainId,
        mainHistory: mainId === null ? [] : [{ agentId: mainId, from: at, to: null, reason: "created" }],
        charter: { goal: init.goal, repos: [...new Set(init.repos)], nonGoals: [], doneCriteria: [], budget: null, confirmedAt: null },
        plan: { text: "", updatedAt: null },
        contracts: [],
      });
      return { ok: true, mission: put(mission) };
    },
    update,
    setMain(missionId, agentId, reason) {
      return update(missionId, (mission) => {
        if (mission.mainId === agentId) return null;
        const at = now().toISOString();
        const mainHistory = mission.mainHistory.map((entry) => (entry.to === null ? { ...entry, to: at } : entry));
        return { ...mission, mainId: agentId, mainHistory: [...mainHistory, { agentId, from: at, to: null, reason }] };
      });
    },
    appendJournal(missionId, entry) {
      if (!MISSION_ID_PATTERN.test(missionId)) throw new Error(`not a mission id: ${JSON.stringify(missionId)}`);
      const line = journalSchema.parse({
        at: now().toISOString(),
        kind: entry.kind,
        by: entry.by,
        text: bounded(entry.text.replace(/\s+/g, " ").trim(), MAX_JOURNAL_TEXT, env),
        ...(entry.ref === undefined ? {} : { ref: entry.ref }),
        ...(entry.split === undefined ? {} : { split: boundedSplit(entry.split, env) }),
      });
      const path = journalPath(missionId);
      ensureDataDir(home, dir, UNWRITABLE);
      const { lines, whole } = journalLines(missionId);
      const text = JSON.stringify(line);
      if (lines.length >= MAX_JOURNAL_LINES) {
        writeFileAtomically(home, path, `${[...lines.slice(-(MAX_JOURNAL_LINES - 1)), text].join("\n")}\n`, UNWRITABLE);
      } else {
        // After a half-written last line (a process killed mid-write), on a line of its own.
        appendToFile(path, `${whole ? "" : "\n"}${text}\n`, UNWRITABLE);
      }
      return line;
    },
    journal(missionId, limit = 50) {
      if (!MISSION_ID_PATTERN.test(missionId)) return [];
      try {
        const entries = journalLines(missionId).lines.flatMap((line) => {
          try {
            const valid = journalSchema.safeParse(JSON.parse(line));
            return valid.success ? [valid.data] : [];
          } catch {
            return [];
          }
        });
        return limit <= 0 ? [] : entries.slice(-limit);
      } catch {
        return [];
      }
    },
  };
}

/** A Main's suggestion that work belongs to a new mission (§9.6), as its journal line keeps it. */
export interface SplitSuggestion extends SplitSuggestionFields {
  at: string;
  /** The Main that suggested it: its agent id (the line's `ref`). */
  by: string;
}

/**
 * The open split suggestions of mission `missionId` (`bm_split_mission`,
 * §9.6): its `split-suggested` journal lines whose code no mission has taken
 * since — no open mission holds it, and no mission was created with it at or
 * after the suggestion. None for a closed or missing mission. Never throws.
 */
export function openSplitSuggestionsOf(home: string, missionId: string): SplitSuggestion[] {
  try {
    const store = createMissionStore(home);
    if (store.get(missionId)?.state !== "open") return [];
    const index = store.list();
    const taken = (code: string, at: string): boolean =>
      index.some((entry) => {
        if (entry.code !== code) return false;
        if (entry.state === "open") return true;
        const created = store.get(entry.missionId)?.createdAt;
        return created !== undefined && Date.parse(created) >= Date.parse(at);
      });
    return store
      .journal(missionId, MAX_JOURNAL_LINES)
      .flatMap((line) => (line.kind === "split-suggested" && line.split !== undefined && !taken(line.split.code, line.at) ? [{ ...line.split, at: line.at, by: line.ref ?? line.by }] : []));
  } catch {
    return [];
  }
}
