// Creates an agent directly, bypassing the Manager: the way to check what the
// plugin's before("agent.create") hook does to a request.
//   node scripts/manual-test/create-agent.mjs <provider> <model> <thinking|-> <mode|-> <cwd> <workspaceId> "<prompt>"
// e.g. create-agent.mjs bm-worker claude-opus-5-5 max full-access "$repo" wks_… "Reply with the single word OK."
import { withClient } from "./client.mjs";

const [provider, model, thinking, mode, cwd, workspaceId, prompt] = process.argv.slice(2);
if (!provider || !model || !cwd || !workspaceId || !prompt) {
  console.error('usage: create-agent.mjs <provider> <model> <thinking|-> <mode|-> <cwd> <workspaceId> "<prompt>"');
  process.exit(2);
}
await withClient("create", async (client) => {
  const agent = await client.createAgent({
    provider,
    model,
    ...(thinking && thinking !== "-" ? { thinkingOptionId: thinking } : {}),
    ...(mode && mode !== "-" ? { modeId: mode } : {}),
    cwd,
    workspaceId,
    initialPrompt: prompt,
    title: "manual create-agent check",
  });
  console.log(agent.id ?? agent.agentId);
});
