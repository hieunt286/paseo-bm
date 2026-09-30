// Lists the user messages in one agent's timeline, oldest first. fromApp: true
// means the item carries clientMessageId: typed by the user, or sent by the
// plugin through the app's path (agents.ref(id).send(), e.g. a BM-SETTINGS);
// fromApp: false means another agent sent it (send_agent_prompt, e.g. a
// BM-REPORT). With a prefix, lists only the
// messages that start with it and prints their count last.
//   node scripts/manual-test/prompts.mjs <agentId> [prefix]
// e.g. prompts.mjs "$WORKER" BM-SETTINGS
import { withClient } from "./client.mjs";

const [agentId, prefix] = process.argv.slice(2);
if (!agentId) {
  console.error("usage: prompts.mjs <agentId> [prefix]");
  process.exit(2);
}
const PAGE_LIMIT = 200;
const MAX_PAGES = 20;

await withClient("prompts", async (client) => {
  const pages = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const payload = await client.fetchAgentTimeline(
      agentId,
      cursor === null ? { direction: "tail", limit: PAGE_LIMIT } : { direction: "before", cursor, limit: PAGE_LIMIT },
    );
    if (payload.error) throw new Error(payload.error);
    pages.unshift(payload.entries ?? []);
    if (!payload.hasOlder || !payload.startCursor) break;
    cursor = payload.startCursor;
  }
  const messages = pages
    .flat()
    .filter((entry) => entry.item?.type === "user_message")
    .map((entry) => ({ at: entry.timestamp, fromApp: Boolean(entry.item.clientMessageId), text: entry.item.text }))
    .filter((message) => prefix === undefined || message.text.trimStart().startsWith(prefix));
  console.log(JSON.stringify(messages, null, 2));
  if (prefix !== undefined) console.log(`${messages.length} message(s) starting with ${prefix}`);
});
