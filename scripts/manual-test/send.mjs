// Sends a message to an agent exactly like the app does: with a messageId, so
// the timeline item carries clientMessageId and counts as the user's own message.
//   node scripts/manual-test/send.mjs <agentId> "<text>"
import { randomUUID } from "node:crypto";
import { withClient } from "./client.mjs";

const [agentId, text] = process.argv.slice(2);
if (!agentId || !text) {
  console.error('usage: send.mjs <agentId> "<text>"');
  process.exit(2);
}
await withClient("send", async (client) => {
  await client.sendAgentMessage(agentId, text, { messageId: randomUUID() });
  console.log("sent");
});
