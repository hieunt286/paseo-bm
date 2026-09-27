// Waits until no agent of the test daemon is running (two checks in a row),
// printing one status line every 10 s. Stops at the first pending permission.
//   node scripts/manual-test/wait-idle.mjs [max-minutes]   (default 15)
import { setTimeout as sleep } from "node:timers/promises";
import { withClient } from "./client.mjs";

const maxMinutes = Number(process.argv[2] ?? 15);
await withClient("wait", async (client) => {
  const deadline = Date.now() + maxMinutes * 60_000;
  let quiet = 0;
  while (Date.now() < deadline) {
    await sleep(10_000);
    const list = await client.fetchAgents({});
    const agents = (list.entries ?? list.agents ?? []).map((entry) => entry.agent ?? entry);
    console.log(new Date().toLocaleTimeString(), agents.map((agent) => `${agent.title}:${agent.status}`).join(" | "));
    if (agents.some((agent) => (agent.pendingPermissions ?? []).length > 0)) {
      console.log("an agent is waiting for a permission: answer it in the app, then run this again");
      return;
    }
    quiet = agents.some((agent) => agent.status === "running") ? 0 : quiet + 1;
    if (quiet >= 2) return;
  }
  throw new Error(`still running after ${maxMinutes} minutes`);
});
