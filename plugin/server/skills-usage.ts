/**
 * `skills.usage` (change-014 outcome 4): how often the recorded `BM-REPORT`s
 * named each skill in `skillsUsed`, for one workspace or all, over a window
 * ending now.
 *
 * Reads the trace store only (`traces/<workspaceId>/events-*.jsonl`, through
 * `trace-store.ts` `readRecords`, with its de-duplication): no lock, nothing
 * written, no other store opened. Only skill names, counts and times leave
 * this file — no message text, no path.
 */
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { skillsUsageRpc, type SkillsUsage, type SkillUsage, type TraceRecord } from "../shared/contracts";
import { TRACES_DIR_NAME } from "./data-home";
import { READ_FAILED, coded, requireDataHome, type RpcHomeDeps } from "./rpc-kit";
import { WORKSPACE_ID_PATTERN, readRecords, storedWorkspaceIds, type TraceStoreLocation } from "./trace-store";

export type SkillsUsageDeps = RpcHomeDeps & {
  /** The clock the window ends at; `new Date()` by default. */
  now?: () => Date;
};

const DAY_MS = 86_400_000;
export const SKILLS_USAGE_DEFAULT_DAYS = 30;

/**
 * The counts over `records`: every report whose time falls in
 * `[since, until]`. Names are trimmed and empty ones dropped; a report naming
 * one skill twice counts once.
 */
export function skillsUsageOf(records: readonly TraceRecord[], since: Date, until: Date): SkillUsage[] {
  const tally = new Map<string, { reports: number; requests: Set<string>; lastUsedAt: string; lastMs: number }>();
  for (const record of records) {
    for (const report of record.reports) {
      const atMs = Date.parse(report.at);
      if (Number.isNaN(atMs) || atMs < since.getTime() || atMs > until.getTime()) continue;
      const names = new Set((report.skillsUsed ?? []).map((name) => name.trim()).filter((name) => name !== ""));
      for (const name of names) {
        let entry = tally.get(name);
        if (entry === undefined) {
          entry = { reports: 0, requests: new Set(), lastUsedAt: report.at, lastMs: atMs };
          tally.set(name, entry);
        }
        entry.reports += 1;
        const requestId = report.requestId ?? record.requestId;
        if (requestId !== null) entry.requests.add(requestId);
        if (atMs > entry.lastMs) {
          entry.lastMs = atMs;
          entry.lastUsedAt = report.at;
        }
      }
    }
  }
  return [...tally.entries()]
    .map(([name, entry]) => ({ name, reports: entry.reports, requests: entry.requests.size, lastUsedAt: entry.lastUsedAt }))
    .sort((a, b) => b.reports - a.reports || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * `skills.usage`. No usable data folder → `E_DATA_HOME_UNAVAILABLE`; a store
 * that cannot be read (a symlink inside it) → `READ_FAILED`. A store or a
 * workspace with nothing recorded answers an empty list.
 */
export function handleSkillsUsage(input: { workspaceId?: string; sinceDays?: number }, deps: SkillsUsageDeps = {}): SkillsUsage {
  const until = (deps.now ?? (() => new Date()))();
  const since = new Date(until.getTime() - (input.sinceDays ?? SKILLS_USAGE_DEFAULT_DAYS) * DAY_MS);
  const window = { since: since.toISOString(), until: until.toISOString() };
  const home = requireDataHome(deps, "read skill usage");
  const location: TraceStoreLocation = { tracesDir: join(home, TRACES_DIR_NAME) };
  const records = coded(READ_FAILED, "read skill usage", () => {
    // An id the store could never hold has nothing recorded under it.
    const ids =
      input.workspaceId === undefined
        ? storedWorkspaceIds(location)
        : WORKSPACE_ID_PATTERN.test(input.workspaceId) && input.workspaceId !== "." && input.workspaceId !== ".."
          ? [input.workspaceId]
          : [];
    return ids.flatMap((workspaceId) => readRecords(location, workspaceId).records);
  });
  return { skills: skillsUsageOf(records, since, until), window };
}

export function registerSkillsUsageRpcs(server: PluginServerContext, deps: SkillsUsageDeps = {}): void {
  server.handle(skillsUsageRpc, (input) => handleSkillsUsage(input, deps));
}
