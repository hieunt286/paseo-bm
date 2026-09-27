// Lists the test daemon's agents: title, provider, running model, status, mode, labels.
//   node scripts/manual-test/agents.mjs
import { withClient } from "./client.mjs";

await withClient("agents", async (client) => {
  const list = await client.fetchAgents({});
  const rows = (list.entries ?? list.agents ?? []).map((entry) => entry.agent ?? entry).map((agent) => ({
    id: agent.id,
    title: agent.title ?? null,
    provider: agent.provider,
    model: agent.runtimeInfo?.model ?? agent.model ?? null,
    status: agent.status,
    mode: agent.runtimeInfo?.modeId ?? agent.currentModeId ?? null,
    labels: agent.labels ?? {},
  }));
  console.log(JSON.stringify(rows, null, 2));
});
