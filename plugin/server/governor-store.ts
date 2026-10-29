/**
 * The governor's ladder (missions design §9.3, §9.4; ADR-029):
 * `<data folder>/orchestrator/governor.json` =
 * `{ version: 1, missions: { <missionId>: { <family>: { step, since, figures,
 * lastAction: { at, kind, id, figures? } | null, mainTurnsAt, held?, underSince? } } },
 * digests?: { <missionId>: <at> } }`, and the code that
 * climbs it. Steps 1 and 2 are code's, with no model; step 3 is only recorded
 * as due here (the governor's wake reads it).
 *
 * - **When.** `recompute` runs for one mission on each recorded turn of its
 *   agents (`turnRecorded`: a Worker's request in the request index, or a
 *   Main of an open mission) and for every open mission on the 60-second
 *   stall pass (`pass`, `index.server.ts`). Each needs a Paseo handle: which
 *   Workers are live is read from its agent list. One recomputation per
 *   mission at a time.
 * - **The figures** are `governor-figures.ts`'s, against the owner's
 *   `governor.*` settings, read at each recomputation.
 * - **The steps** (`ladderStepOf`, pure), per family:
 *   - 0 → 1 *record*: a figure of the family crossed; a journal line names
 *     the crossed figures.
 *   - 1 → 2 *nudge*: still crossed at the next recomputation; a `BM-COMMAND`
 *     to the mission's current Main (`nudgeCommandOf`: `from: orchestrator`,
 *     `authority: governor:nudge`, `effects: none`, `by: code`) through
 *     `command-send.ts`, whose loop guard counts per mission in the code-nudge
 *     pool; once delivered it is logged as a `govern` intervention
 *     (`interventionOfGovern`). With that pool spent (delivery line design
 *     §8.3) the family stays at 1 and records `held: { pool, until }` with one
 *     journal line; it is nudged again only once `until` has passed. A mission
 *     without a Main, a refused or undelivered command leaves the family at 1
 *     (`nudge-failed`), tried again after `NUDGE_RETRY_MS`.
 *   - 2 → 3 *re-plan due*: still crossed `governor.windowMinutes` after the
 *     nudge **and** `governor.windowTurns` Main turns after it; a journal
 *     line. A `bm_govern` step on a family at step 1 or 2 restarts both
 *     (`governedLadderOf`, `command-authority.ts`). Steps 3 and 4 are the
 *     model's.
 *   - Any step → 0 *reset*: no figure of the family crossed for
 *     `governor.windowMinutes` (delivery line design §8.4: `underSince`, so a
 *     figure that flickers under and back keeps its step); a journal line.
 * - **Journal lines** are kind `governor`, by `governor`, in the mission's
 *   journal (`mission-store.ts`); a nudge's names its command id as `ref`.
 * - **The daily digest** (delivery line design §8.3): while a family of the
 *   mission is held, its Main gets, at most once in 24 hours, one `message`
 *   from `plugin` through the outbox (`BM-DELIVERY message`, on the Main's
 *   channel): the held families, their crossed figures and the charter line
 *   each concerns. It is not a command and spends no pool; when it went is
 *   kept in the file's `digests`.
 * - **The write** (`GovernorStore.update`) replaces only the families the file
 *   still holds as the recomputation read them: a `bm_govern` step written
 *   while a nudge was being delivered stands.
 *
 * The file rules are every store's (`data-files.ts`): `0700` folder created
 * only by a write, `0600` file replaced atomically, no symlink; a missing or
 * corrupt file reads as empty, a family state that does not validate is
 * skipped on its own, a newer `version` reads as empty and is never written.
 * Nothing here throws into the plugin: a failure is one log line.
 */
import { z } from "zod";
import type { TraceRecord } from "../shared/contracts";
import type { GovernorSettings } from "../shared/coordination";
import { governorAuthorityOf, type CommandInput } from "../shared/orchestrator-command";
import { timeOrZero } from "../shared/time";
import { missionPoolSpentUntil, sendCommand } from "./command-send";
import { GOVERNOR_POOLS } from "../shared/orchestrator";
import { readCoordinationSettings } from "./coordination-rpc";
import { createJsonFileStore } from "./data-files";
import { resolveDataHome, type DataHomeDeps } from "./data-home";
import { GOVERNOR_FAMILIES, GOVERNOR_FIGURE_IDS, familyFiguresOf, figureText, storedFigureIdOf, type GovernorFamily, type GovernorFigure } from "../shared/governor-figures";

import { governorFiguresOf, readGovernorSnapshot, type ListedAgent } from "./governor-figures";
import { retryPendingMerges } from "./lane-merge";
import { checkLaneOverlaps } from "./lane-overlap";
import { refreshLines, type LinePaseo } from "./line-watch";
import { interventionOfGovern, recordIntervention } from "./intervention-store";
import { requestIndexOf } from "./mission-roster";
import { createMissionStore, type Mission } from "./mission-store";
import { missionsHomeIdOf } from "./missions-home";
import type { NoticeQueue } from "./notice-queue";
import { agentsOf, type OrchestratorStatePaseo } from "./orchestrator-state";
import { ORCHESTRATOR_DIR_NAME, type OrchestratorStoreDeps } from "./orchestrator-store";
import { storeAndDeliver } from "./outbox";
import type { NoticePaseo } from "./notice-queue";
import { errorText } from "./rpc-kit";

export const GOVERNOR_FILE = "governor.json";
export const GOVERNOR_FILE_VERSION = 1;
/** A nudge that could not go is tried again after this long; a spent pool holds the family instead (delivery line design §8.3). */
export const NUDGE_RETRY_MS = 10 * 60_000;
/** A mission's Main gets at most one daily digest in this long (§8.3). */
export const DIGEST_EVERY_MS = 24 * 3_600_000;

/** What the ladder last did for a family; `replan` and `arbitrate` are the model's `bm_govern` (`command-authority.ts`). */
export const LADDER_ACTIONS = ["record", "nudge", "nudge-failed", "replan-due", "reset", "replan", "arbitrate"] as const;

/** A figure id as stored: one an older build named differently reads by its new name (delivery line design §5.6). */
const figureIdSchema = z.preprocess(storedFigureIdOf, z.enum(GOVERNOR_FIGURE_IDS));

const figureSchema = z.object({
  family: z.enum(GOVERNOR_FAMILIES),
  id: figureIdSchema,
  value: z.number(),
  threshold: z.number(),
  op: z.enum([">=", ">"]),
  crossed: z.boolean(),
  detail: z.string().nullable(),
});

const familyStateSchema = z.object({
  step: z.number().int().min(0).max(4),
  /** When the family crossed (step 1); null at step 0. */
  since: z.string().nullable(),
  /** The family's figures at the last recomputation. */
  figures: z.array(figureSchema),
  /**
   * `id`: the command's id (a nudge, a `bm_govern` step); null for every other
   * action. `figures`: a re-plan's figure values as it went (delivery line
   * design §8.2: a repeat with figures no worse is free); additive.
   */
  lastAction: z
    .object({
      at: z.string(),
      kind: z.enum(LADDER_ACTIONS),
      id: z.string().nullable(),
      figures: z.array(z.object({ id: figureIdSchema, value: z.number() })).optional(),
    })
    .nullable(),
  /** How many Main turns the mission had when the nudge (or a later `bm_govern` step at step 1 or 2) went: the window's turns count from there. */
  mainTurnsAt: z.number().int().nonnegative().nullable(),
  /** The code-nudge pool was spent (delivery line design §8.3): the family waits at its step until `until`. Additive. */
  held: z.object({ pool: z.enum(GOVERNOR_POOLS), until: z.string() }).optional(),
  /**
   * When every figure of the family went back under its threshold (delivery
   * line design §8.4): above step 0 the family resets only once they stayed
   * under for `governor.windowMinutes`; after a reset, when that quiet began.
   * Additive.
   */
  underSince: z.string().optional(),
});

export type FamilyState = z.infer<typeof familyStateSchema>;
export type MissionLadder = Partial<Record<GovernorFamily, FamilyState>>;

interface GovernorFile {
  missions: Record<string, MissionLadder>;
  /** When each mission's Main last got its daily digest (§8.3). Additive. */
  digests: Record<string, string>;
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The ladders a file body holds; a family state that does not validate is skipped on its own. */
function ladderFileOf(body: Record<string, unknown>): GovernorFile {
  const missions: Record<string, MissionLadder> = {};
  for (const [missionId, raw] of Object.entries(objectOf(body["missions"]) ?? {})) {
    const ladder: MissionLadder = {};
    for (const family of GOVERNOR_FAMILIES) {
      const parsed = familyStateSchema.safeParse(objectOf(raw)?.[family]);
      if (parsed.success) ladder[family] = parsed.data;
    }
    missions[missionId] = ladder;
  }
  const digests: Record<string, string> = {};
  for (const [missionId, at] of Object.entries(objectOf(body["digests"]) ?? {})) if (typeof at === "string") digests[missionId] = at;
  return { missions, digests };
}

export interface GovernorStore {
  /** `<data folder>/orchestrator/governor.json`. */
  readonly path: string;
  /** One mission's ladder; empty when it has none. Never throws. */
  ladder(missionId: string): MissionLadder;
  /** Every mission's ladder. Never throws. */
  list(): Record<string, MissionLadder>;
  /** Replaces one mission's ladder. Throws when the file cannot be written. */
  put(missionId: string, ladder: MissionLadder): void;
  /**
   * Replaces one mission's ladder with what `change` makes of it as the file
   * holds it now, read inside the write (no await between): a ladder written
   * meanwhile is never lost. Returns the ladder written. Throws when the file
   * cannot be written.
   */
  update(missionId: string, change: (current: MissionLadder) => MissionLadder): MissionLadder;
  /** When the mission's Main last got its daily digest; null for never. Never throws. */
  digestAt(missionId: string): string | null;
  /** Records the mission's daily digest as sent at `at`. Throws when the file cannot be written. */
  markDigest(missionId: string, at: string): void;
}

/** The ladder store of the data folder `home`. Creating it touches nothing on disk. */
export function createGovernorStore(home: string): GovernorStore {
  const file = createJsonFileStore<GovernorFile>({
    home,
    dir: ORCHESTRATOR_DIR_NAME,
    file: GOVERNOR_FILE,
    version: GOVERNOR_FILE_VERSION,
    parse: ladderFileOf,
    empty: () => ({ missions: {}, digests: {} }),
    codes: { unwritable: "E_TRACE_STORE_UNWRITABLE" },
  });
  const read = (): GovernorFile => {
    try {
      return file.read();
    } catch {
      return { missions: {}, digests: {} };
    }
  };
  const list = (): Record<string, MissionLadder> => read().missions;
  return {
    path: file.path,
    ladder: (missionId) => list()[missionId] ?? {},
    list,
    put(missionId, ladder) {
      file.update((current) => ({ ...current, missions: { ...current.missions, [missionId]: ladder } }));
    },
    update(missionId, change) {
      let next: MissionLadder = {};
      file.update((current) => {
        next = change(current.missions[missionId] ?? {});
        return { ...current, missions: { ...current.missions, [missionId]: next } };
      });
      return next;
    },
    digestAt: (missionId) => read().digests[missionId] ?? null,
    markDigest(missionId, at) {
      file.update((current) => ({ ...current, digests: { ...current.digests, [missionId]: at } }));
    },
  };
}

// ---------------------------------------------------------------------------
// The steps (pure).
// ---------------------------------------------------------------------------

/** What `ladderStepOf` reads besides the family's state and figures. */
export interface LadderFacts {
  now: Date;
  /** The mission's Main turns so far. */
  mainTurns: number;
  settings: Pick<GovernorSettings, "windowMinutes" | "windowTurns">;
}

/** What the runner does after a step: nothing, or the action the new state records. */
export type LadderAction = "none" | "record" | "nudge" | "replan-due" | "reset";

const RESTING: FamilyState = { step: 0, since: null, figures: [], lastAction: null, mainTurnsAt: null };

/**
 * The family's next state and the action it takes (see the module comment).
 * `nudge` presumes the command goes: the runner records its id, or puts the
 * family back at 1 with `nudge-failed`. Pure.
 */
export function ladderStepOf(current: FamilyState | null | undefined, figures: readonly GovernorFigure[], facts: LadderFacts): { state: FamilyState; action: LadderAction } {
  const base: FamilyState = { ...(current ?? RESTING), figures: [...figures] };
  const at = facts.now.toISOString();
  const now = facts.now.getTime();
  const crossed = figures.some((entry) => entry.crossed);
  if (!crossed) {
    if (base.step === 0) return { state: base, action: "none" };
    // Delivery line design §8.4: back to 0 only after the figures stayed under their thresholds for the window.
    const underSince = base.underSince ?? at;
    if (now - timeOrZero(underSince) < facts.settings.windowMinutes * 60_000) return { state: { ...base, underSince }, action: "none" };
    return { state: { ...RESTING, figures: [...figures], lastAction: { at, kind: "reset", id: null }, underSince }, action: "reset" };
  }
  // Crossed again: the quiet, if any, is over.
  delete base.underSince;
  switch (base.step) {
    case 0:
      return { state: { ...base, step: 1, since: at, lastAction: { at, kind: "record", id: null }, mainTurnsAt: null }, action: "record" };
    case 1: {
      // Delivery line design §8.3: a family held for a spent pool waits, with no retry, until the pool has room.
      if (base.held !== undefined && now < timeOrZero(base.held.until)) return { state: base, action: "none" };
      const failed = base.lastAction?.kind === "nudge-failed" && now - timeOrZero(base.lastAction.at) < NUDGE_RETRY_MS;
      if (failed) return { state: base, action: "none" };
      const next: FamilyState = { ...base, step: 2, lastAction: { at, kind: "nudge", id: null }, mainTurnsAt: facts.mainTurns };
      delete next.held;
      return { state: next, action: "nudge" };
    }
    case 2: {
      const nudgedAt = timeOrZero(base.lastAction?.at ?? base.since);
      const minutes = now - nudgedAt >= facts.settings.windowMinutes * 60_000;
      const turns = facts.mainTurns - (base.mainTurnsAt ?? facts.mainTurns) >= facts.settings.windowTurns;
      if (!minutes || !turns) return { state: base, action: "none" };
      return { state: { ...base, step: 3, lastAction: { at, kind: "replan-due", id: null } }, action: "replan-due" };
    }
    default:
      // Steps 3 and 4 are the model's (§9.3).
      return { state: base, action: "none" };
  }
}

/** The charter line a family's figures concern, at most 300 characters. Pure. */
export function charterLineOf(mission: Pick<Mission, "charter">, family: GovernorFamily): string {
  const { charter } = mission;
  const goal = `Goal: ${charter.goal.split("\n").find((line) => line.trim() !== "")?.trim() ?? "(none yet)"}`;
  const open = charter.doneCriteria.filter((criterion) => criterion.status === "open");
  let line: string;
  switch (family) {
    case "mess":
      line = `Repos: ${charter.repos.join(", ") || "(none yet)"}${(charter.budget?.workers ?? null) === null ? "" : `; at most ${charter.budget!.workers} Workers`}`;
      break;
    case "overengineering":
      line = `Done criteria: ${charter.doneCriteria.length}${open[0] === undefined ? "" : `, first open ${open[0].id} ${open[0].text}`}`;
      break;
    case "drift":
      line = open.length === 0 ? goal : `Open done criteria: ${open.map((criterion) => `${criterion.id} ${criterion.text}`).join("; ")}`;
      break;
    case "stuck":
      line = goal;
      break;
    case "budget": {
      const budget = charter.budget;
      const field = (name: string, value: number | null | undefined) => `${name} ${value ?? "none"}`;
      line = `Budget: ${field("requests", budget?.requests)}, ${field("workers", budget?.workers)}, ${field("review calls", budget?.reviewCalls)}, ${field("days", budget?.days)}`;
      break;
    }
  }
  return line.replace(/\s+/g, " ").trim().slice(0, 300);
}

/** The window in words: `30 minutes and 5 more of your turns`. */
function windowText(settings: Pick<GovernorSettings, "windowMinutes" | "windowTurns">): string {
  return `${settings.windowMinutes} minutes and ${settings.windowTurns} more of your turns`;
}

/**
 * The step-2 nudge of one family (§9.3): the family, its crossed figures with
 * their thresholds, the charter line they concern, and what the Main is asked.
 * Pure.
 */
export function nudgeCommandOf(mission: Pick<Mission, "code" | "charter">, family: GovernorFamily, figures: readonly GovernorFigure[], settings: Pick<GovernorSettings, "windowMinutes" | "windowTurns">): CommandInput {
  const crossed = figures.filter((entry) => entry.crossed);
  const body = [
    `The governor's ${family} figures of mission ${mission.code} crossed their thresholds:`,
    ...crossed.map((entry) => `- ${figureText(entry)}`),
    `Charter: ${charterLineOf(mission, family)}`,
    "",
    `Re-plan or explain in one line in your next reply; the governor checks again in ${windowText(settings)}.`,
  ].join("\n");
  return {
    from: "orchestrator",
    via: "chat",
    to: "manager",
    requestId: null,
    re: `Governor: ${family} figures of mission ${mission.code} crossed`,
    body: body.slice(0, 4_000),
    intent: "other",
    effects: [],
    authority: governorAuthorityOf("nudge"),
    approved: [],
  };
}

// ---------------------------------------------------------------------------
// The runner.
// ---------------------------------------------------------------------------

/** The SDK slice the governor uses: the agent list (the nudge goes through the notice queue, `GovernorDeps.queue`). */
export type GovernorPaseo = Pick<OrchestratorStatePaseo, "agents">;

export interface GovernorDeps extends DataHomeDeps {
  /** The data folder; `resolveDataHome` by default. */
  home?: () => string | null;
  now?: () => Date;
  log?: (message: string) => void;
  /** The queue a nudge goes through; the plugin's shared one by default. */
  queue?: Pick<NoticeQueue, "enqueue">;
  /** The commands store's deps (fixed command ids in tests). */
  store?: OrchestratorStoreDeps;
  redactEnv?: NodeJS.ProcessEnv;
}

/** What one recomputation did, per family that moved; `held`: the code-nudge pool was spent (§8.3). */
export interface GovernorOutcome {
  missionId: string;
  figures: GovernorFigure[];
  actions: Array<{ family: GovernorFamily; action: Exclude<LadderAction, "none"> | "nudge-failed" | "held"; commandId: string | null; reason: string | null }>;
  /** The daily digest's outbox record, when this recomputation sent one. */
  digest?: string;
}

export interface Governor {
  /** One open mission now (see the module comment); null when it is not open, or a recomputation of it is under way. Never rejects. */
  recompute(missionId: string, paseo: GovernorPaseo, agents?: readonly ListedAgent[]): Promise<GovernorOutcome | null>;
  /** Every open mission (the 60-second pass). Never rejects. */
  pass(paseo: GovernorPaseo): Promise<GovernorOutcome[]>;
  /** A recorded turn: its mission's recomputation, when it is an agent of one. Never rejects. */
  turnRecorded(record: Pick<TraceRecord, "agentId" | "requestId"> | null | undefined, paseo: GovernorPaseo): Promise<GovernorOutcome | null>;
}

const journalText = {
  record: (family: GovernorFamily, figures: readonly GovernorFigure[]) => `${family} crossed: ${figures.filter((entry) => entry.crossed).map(figureText).join("; ")}`,
  nudge: (family: GovernorFamily, id: string) => `${family}: nudged the Main (command ${id})`,
  replan: (family: GovernorFamily, settings: Pick<GovernorSettings, "windowMinutes" | "windowTurns">) =>
    `${family} still crossed ${settings.windowMinutes} minutes and ${settings.windowTurns} Main turns after the nudge: re-plan due (step 3)`,
  reset: (family: GovernorFamily) => `${family} back under its thresholds`,
  held: (family: GovernorFamily, until: string) => `${family}: the code-nudge commands are spent until ${until}; held at step 1, in the Main's daily digest`,
};

/**
 * The daily digest to the Main (delivery line design §8.3): each held
 * family, its crossed figures and the charter line it concerns. Not a
 * command. Pure.
 */
export function digestTextOf(mission: Pick<Mission, "code" | "charter">, ladder: MissionLadder): string | null {
  const held = GOVERNOR_FAMILIES.filter((family) => ladder[family]?.held !== undefined);
  if (held.length === 0) return null;
  const lines = held.flatMap((family) => {
    const state = ladder[family]!;
    return [
      `${family} (held until ${state.held!.until}):`,
      ...state.figures.filter((entry) => entry.crossed).map((entry) => `- ${figureText(entry)}`),
      `- Charter: ${charterLineOf(mission, family)}`,
    ];
  });
  return [
    `The governor's daily digest of mission ${mission.code}: its code-nudge commands are spent, so these figures come here instead of a nudge.`,
    ...lines,
    "",
    "This is not a command: read the figures against your plan, and re-plan where they show it.",
  ]
    .join("\n")
    .slice(0, 4_000);
}

export function createGovernor(deps: GovernorDeps = {}): Governor {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const now = deps.now ?? (() => new Date());
  const homeOf =
    deps.home ??
    (() => {
      try {
        return resolveDataHome(deps).home;
      } catch {
        return null;
      }
    });
  const running = new Set<string>();

  const journal = (home: string, missionId: string, text: string, ref?: string): void => {
    try {
      createMissionStore(home).appendJournal(missionId, { kind: "governor", by: "governor", text, ...(ref === undefined ? {} : { ref }) });
    } catch (error) {
      log(`[paseo-bm] the governor could not write the journal of mission ${missionId}: ${errorText(error)}`);
    }
  };

  async function climb(home: string, mission: Mission, paseo: GovernorPaseo, agents: readonly ListedAgent[]): Promise<GovernorOutcome> {
    const at = now();
    const settings = readCoordinationSettings({ home, log });
    const snapshot = readGovernorSnapshot(home, mission, { now: at, agents, settings, log });
    const figures = governorFiguresOf(snapshot, settings.governor);
    const store = createGovernorStore(home);
    const before = store.ladder(mission.missionId);
    const ladder: MissionLadder = {};
    const outcome: GovernorOutcome = { missionId: mission.missionId, figures, actions: [] };
    const facts: LadderFacts = { now: at, mainTurns: snapshot.mainTurnEnds.length, settings: settings.governor };

    const workspaceId = mission.workspaceId ?? missionsHomeIdOf(home) ?? mission.legacyWorkspaceId ?? mission.missionId;
    for (const family of GOVERNOR_FAMILIES) {
      const own = familyFiguresOf(figures, family);
      const { state, action } = ladderStepOf(before[family], own, facts);
      ladder[family] = state;
      if (action === "none") continue;
      if (action === "record") journal(home, mission.missionId, journalText.record(family, own));
      if (action === "replan-due") journal(home, mission.missionId, journalText.replan(family, settings.governor));
      if (action === "reset") journal(home, mission.missionId, journalText.reset(family));
      if (action !== "nudge") {
        outcome.actions.push({ family, action, commandId: null, reason: null });
        continue;
      }
      // Delivery line design §8.3: a spent code-nudge pool holds the family at 1, one journal line, no retry loop.
      const until = missionPoolSpentUntil(home, mission.missionId, "codeNudge", at, { store: { now, ...deps.store }, settings: settings.governor, log });
      if (until !== null) {
        const held = { pool: "codeNudge" as const, until: until.toISOString() };
        ladder[family] = { ...state, step: 1, lastAction: before[family]?.lastAction ?? null, mainTurnsAt: null, held };
        journal(home, mission.missionId, journalText.held(family, held.until));
        outcome.actions.push({ family, action: "held", commandId: null, reason: `the code-nudge pool is spent until ${held.until}` });
        continue;
      }
      const sent =
        mission.mainId === null
          ? ({ ok: false, reason: `mission ${mission.code} has no Main` } as const)
          : await sendCommand({
              home,
              now: at,
              paseo,
              workspaceId,
              command: nudgeCommandOf(mission, family, own, settings.governor),
              targetId: mission.mainId,
              missionId: mission.missionId,
              governorBy: "code",
              copyTo: null,
              // Code wrote the text: it declares no effect and asks for none.
              backstop: false,
              loopGuard: "refuse",
              intervention: null,
              ...(deps.queue === undefined ? {} : { queue: deps.queue }),
              store: { now, ...deps.store },
              ...(deps.redactEnv === undefined ? {} : { redactEnv: deps.redactEnv }),
              log,
            }).catch((error: unknown) => ({ ok: false, reason: errorText(error) }) as const);
      if (sent.ok) {
        ladder[family] = { ...state, lastAction: { at: at.toISOString(), kind: "nudge", id: sent.id } };
        journal(home, mission.missionId, journalText.nudge(family, sent.id), sent.id);
        // Missions design §9.3: the intervention log (A-12) records each step 2–4.
        recordIntervention(
          home,
          interventionOfGovern({ workspaceId, missionId: mission.missionId, mainId: mission.mainId, step: "nudge", families: [family], commandId: sent.id }),
          { now: () => at, log },
        );
        outcome.actions.push({ family, action: "nudge", commandId: sent.id, reason: null });
      } else {
        ladder[family] = { ...state, step: 1, lastAction: { at: at.toISOString(), kind: "nudge-failed", id: null }, mainTurnsAt: null };
        log(`[paseo-bm] the governor could not nudge the Main of mission ${mission.code} on ${family}: ${sent.reason}`);
        outcome.actions.push({ family, action: "nudge-failed", commandId: null, reason: sent.reason });
      }
    }
    if (JSON.stringify(ladder) !== JSON.stringify(before)) {
      try {
        // The nudge awaited its delivery: a family `bm_govern` wrote meanwhile keeps that write (§9.4).
        store.update(mission.missionId, (current) => {
          const merged: MissionLadder = { ...current };
          for (const family of GOVERNOR_FAMILIES) if (JSON.stringify(current[family]) === JSON.stringify(before[family])) merged[family] = ladder[family];
          return merged;
        });
      } catch (error) {
        log(`[paseo-bm] the governor could not write the ladder of mission ${mission.code}: ${errorText(error)}`);
      }
    }
    const digest = await sendDigest(home, mission, ladder, at, paseo, workspaceId);
    if (digest !== null) outcome.digest = digest;
    return outcome;
  }

  /**
   * The daily digest (§8.3): while a family is held, one `message` to the
   * Main from `plugin`, at most once in `DIGEST_EVERY_MS`. Returns its record
   * id, or null when none went. Never throws.
   */
  async function sendDigest(home: string, mission: Mission, ladder: MissionLadder, at: Date, paseo: GovernorPaseo, workspaceId: string): Promise<string | null> {
    const text = digestTextOf(mission, ladder);
    if (text === null || mission.mainId === null) return null;
    const store = createGovernorStore(home);
    const last = store.digestAt(mission.missionId);
    if (last !== null && at.getTime() - timeOrZero(last) < DIGEST_EVERY_MS) return null;
    try {
      // Addressed by the mission (`requestId`): the outbox delivers it to whichever Main holds the mission.
      const { record } = await storeAndDeliver(
        workspaceId,
        { kind: "message", requestId: mission.missionId, from: "plugin", to: mission.mainId, text },
        { home, now: () => at, log, paseo: paseo as unknown as NoticePaseo, ...(deps.queue === undefined ? {} : { queue: deps.queue }) },
      );
      store.markDigest(mission.missionId, at.toISOString());
      return record.id;
    } catch (error) {
      log(`[paseo-bm] the governor could not send the daily digest of mission ${mission.code}: ${errorText(error)}`);
      return null;
    }
  }

  async function recompute(missionId: string, paseo: GovernorPaseo, agents?: readonly ListedAgent[]): Promise<GovernorOutcome | null> {
    const home = homeOf();
    if (home === null || running.has(missionId)) return null;
    const mission = createMissionStore(home).get(missionId);
    if (mission === null || mission.state !== "open") return null;
    running.add(missionId);
    try {
      return await climb(home, mission, paseo, agents ?? (await agentsOf(paseo)).bm);
    } catch (error) {
      log(`[paseo-bm] the governor could not recompute mission ${mission.code}: ${errorText(error)}`);
      return null;
    } finally {
      running.delete(missionId);
    }
  }

  /** The open mission a turn belongs to: its request's, else the one whose Main it is. */
  const missionOfTurn = (home: string, record: Pick<TraceRecord, "agentId" | "requestId">): string | null => {
    const place = record.requestId === null ? null : requestIndexOf(home, record.requestId);
    if (place !== null) return place.missionId;
    return createMissionStore(home).openByMain(record.agentId)?.missionId ?? null;
  };

  return {
    recompute,
    async pass(paseo) {
      const home = homeOf();
      if (home === null) return [];
      try {
        const open = createMissionStore(home).list().filter((entry) => entry.state === "open");
        if (open.length === 0) return [];
        // Delivery line design §19.2: a lane's merge git refused is tried again, at most every 10 minutes.
        await retryPendingMerges(home, { now, log });
        // Delivery line design §4.9: the lines are read here, at most once a minute each; a turn's recomputation reads them as they are.
        await refreshLines(home, { now, paseo: paseo as unknown as LinePaseo, log });
        // Delivery line design §19.3: two lanes of one repo changing the same files are told to the Main.
        await checkLaneOverlaps(home, { now, log, paseo: paseo as unknown as NoticePaseo });
        const agents = (await agentsOf(paseo)).bm;
        const outcomes: GovernorOutcome[] = [];
        for (const entry of open) {
          const outcome = await recompute(entry.missionId, paseo, agents);
          if (outcome !== null) outcomes.push(outcome);
        }
        return outcomes;
      } catch (error) {
        log(`[paseo-bm] a governor pass failed: ${errorText(error)}`);
        return [];
      }
    },
    async turnRecorded(record, paseo) {
      const home = homeOf();
      if (home === null || record === null || record === undefined) return null;
      try {
        const missionId = missionOfTurn(home, record);
        return missionId === null ? null : await recompute(missionId, paseo);
      } catch (error) {
        log(`[paseo-bm] the governor could not place a recorded turn: ${errorText(error)}`);
        return null;
      }
    },
  };
}
