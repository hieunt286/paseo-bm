// Prints paseo-bm's part of the TEST daemon's configuration: every bm-*
// provider alias (agents.providers), every bm-* profile (daemon.agentProfiles)
// and the agent-tools switch (daemon.mcp.injectIntoAgents), keys sorted, so two
// runs can be compared with `diff`. Reads $PASEO_HOME/config.json only.
// Refuses without BM_TEST_WS / BM_TEST_WORK, on port 6767, or when PASEO_HOME is
// not inside the work dir: your real ~/.paseo is never read.
//   node scripts/manual-test/bm-config.mjs > "$BM_TEST_WORK/config-before.json"
import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const url = process.env.BM_TEST_WS;
const work = process.env.BM_TEST_WORK;
const home = process.env.PASEO_HOME;
if (!url || !work || !home) {
  console.error("ERROR BM_TEST_WS, BM_TEST_WORK or PASEO_HOME is not set: source <work-dir>/env.sh first");
  process.exit(1);
}
if (/:6767\b/.test(url)) {
  console.error("ERROR refusing port 6767: that is your real daemon");
  process.exit(1);
}
if (!resolve(home).startsWith(resolve(work) + sep)) {
  console.error(`ERROR PASEO_HOME (${home}) is not inside ${work}: refusing to read it`);
  process.exit(1);
}

const sorted = (value) =>
  Array.isArray(value)
    ? value.map(sorted)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]))
      : value;
const isBm = (id) => typeof id === "string" && id.startsWith("bm-");

const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
const providers = Object.fromEntries(Object.entries(config.agents?.providers ?? {}).filter(([id]) => isBm(id)));
const profiles = (config.daemon?.agentProfiles ?? []).filter((profile) => isBm(profile?.id)).sort((a, b) => a.id.localeCompare(b.id));
console.log(
  JSON.stringify(sorted({ providers, profiles, injectIntoAgents: config.daemon?.mcp?.injectIntoAgents ?? null }), null, 2),
);
