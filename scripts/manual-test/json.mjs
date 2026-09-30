// Prints one value of the JSON read on stdin, by a dotted path (array indexes
// are numbers): a string as is, anything else as JSON. Exits 1 when the path is
// missing, so `X=$(… | json.mjs a.b)` never sets X to an empty value silently.
// Reads nothing but stdin and talks to no daemon.
//   node scripts/manual-test/rpc.mjs traces.list '{…}' | node scripts/manual-test/json.mjs traces.0.traceId
const [path] = process.argv.slice(2);
if (!path) {
  console.error("usage: <json on stdin> | json.mjs <dotted.path>");
  process.exit(2);
}
let raw = "";
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    console.error("ERROR stdin is not JSON:", raw.slice(0, 300));
    process.exit(1);
  }
  for (const key of path.split(".")) {
    if (value === null || typeof value !== "object" || !(key in value)) {
      console.error(`ERROR no value at ${path} (stopped at "${key}")`);
      process.exit(1);
    }
    value = value[key];
  }
  if (value === undefined || value === null || value === "") {
    console.error(`ERROR the value at ${path} is empty`);
    process.exit(1);
  }
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
});
