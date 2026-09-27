// Calls a paseo-bm plugin RPC the way the app does.
//   node scripts/manual-test/rpc.mjs <method> ['<json input>']
// e.g. rpc.mjs setup.status   |   rpc.mjs manager.ensure '{"workspaceId":"wks_…"}'
import { withClient } from "./client.mjs";

const [method, raw] = process.argv.slice(2);
if (!method) {
  console.error("usage: rpc.mjs <method> ['<json input>']");
  process.exit(2);
}
await withClient("rpc", async (client) => {
  const output = await client.invokePluginRpc("paseo-bm", method, raw ? JSON.parse(raw) : {});
  console.log(JSON.stringify(output, null, 2));
});
