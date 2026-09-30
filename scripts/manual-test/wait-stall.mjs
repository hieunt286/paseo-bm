// Waits until the stall pass of the TEST daemon has raised a stalled request:
// polls $PASEO_BM_HOME/inbox/alerts.json every 30 s and prints the first open
// `request-stalled` alert whose detail names <reason> (with its key), then
// exits 0. Exits 1 after max-minutes (default 25). Reads that one file only
// and talks to no daemon.
// Refuses without BM_TEST_WS / BM_TEST_WORK / PASEO_BM_HOME, on port 6767, or
// when PASEO_BM_HOME is not inside the work dir: your real ~/.paseo-bm is
// never read.
//   node scripts/manual-test/wait-stall.mjs idle-unfinished [max-minutes]
import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const [situation, max] = process.argv.slice(2);
if (!situation) {
  console.error("usage: wait-stall.mjs <idle-unfinished|review-over-budget> [max-minutes]");
  process.exit(2);
}
const url = process.env.BM_TEST_WS;
const work = process.env.BM_TEST_WORK;
const home = process.env.PASEO_BM_HOME;
if (!url || !work || !home) {
  console.error("ERROR BM_TEST_WS, BM_TEST_WORK or PASEO_BM_HOME is not set: source <work-dir>/env.sh first");
  process.exit(1);
}
if (/:6767\b/.test(url)) {
  console.error("ERROR refusing port 6767: that is your real daemon");
  process.exit(1);
}
if (!resolve(home).startsWith(resolve(work) + sep)) {
  console.error(`ERROR PASEO_BM_HOME (${home}) is not inside ${work}: refusing to read it`);
  process.exit(1);
}

const file = join(home, "inbox", "alerts.json");
const deadline = Date.now() + Number(max ?? 25) * 60_000;
while (Date.now() < deadline) {
  let entries = {};
  try {
    entries = JSON.parse(readFileSync(file, "utf8")).entries ?? {};
  } catch {
    // Not written yet: the stall pass has raised nothing so far.
  }
  const found = Object.entries(entries).find(
    ([, entry]) => entry.kind === "request-stalled" && entry.clearedAt === null && String(entry.detail ?? "").includes(situation),
  );
  if (found) {
    console.log(JSON.stringify({ key: found[0], ...found[1] }, null, 2));
    process.exit(0);
  }
  console.log(new Date().toLocaleTimeString(), `no open ${situation} stall yet`);
  await sleep(30_000);
}
console.error(`ERROR no open ${situation} stall after ${max ?? 25} minutes`);
process.exit(1);
