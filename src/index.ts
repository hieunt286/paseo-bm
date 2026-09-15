import { readVersion } from "./version.js";

const USAGE = `paseo-bm — Beads Management for Paseo

Usage:
  npx paseo-bm [command] [options]

Commands are not implemented yet; this build only reports its own version.

Options:
  -h, --help     Show this message
  -v, --version  Print the version and exit
`;

export function run(argv: readonly string[]): number {
  if (argv.includes("-v") || argv.includes("--version")) {
    process.stdout.write(`${readVersion()}\n`);
    return 0;
  }
  process.stdout.write(USAGE);
  return 0;
}

process.exitCode = run(process.argv.slice(2));
