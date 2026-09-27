// The DaemonClient the Paseo app uses, pointed at the ISOLATED test daemon only.
// It refuses to run without BM_TEST_WS (from <work-dir>/env.sh) and refuses
// port 6767, so a test script can never reach your real daemon.
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(`${repoRoot}package.json`);
const { WebSocket } = require("ws");
const { DaemonClient } = await import(`${repoRoot}node_modules/@getpaseo/client/dist/daemon-client.js`);

export async function connect(tag) {
  const url = process.env.BM_TEST_WS;
  if (!url) throw new Error("BM_TEST_WS is not set: source <work-dir>/env.sh first");
  if (/:6767\b/.test(url)) throw new Error("refusing to connect to port 6767: that is your real daemon");
  const client = new DaemonClient({
    url,
    clientId: `bm-manual-${tag}-${randomUUID()}`,
    clientType: "cli",
    webSocketFactory: (target) => new WebSocket(target),
    reconnect: { enabled: false },
    connectTimeoutMs: 15000,
  });
  await client.connect();
  return client;
}

/** Runs `body` with a client, closes it, and exits with the right code. */
export async function withClient(tag, body) {
  let code = 0;
  let client = null;
  try {
    client = await connect(tag);
    await body(client);
  } catch (error) {
    console.error("ERROR", error instanceof Error ? error.message : String(error));
    code = 1;
  } finally {
    await client?.close?.();
    process.exit(code);
  }
}
