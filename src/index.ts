import { runCli } from "./cli.js";
import type { CommandHandlers } from "./cli.js";
import { createMigrateCommand } from "./commands/migrate.js";

/**
 * The handler table.
 *
 * 0.4.0 does one thing, so `migrate` and the alias 0.3.x users type share a
 * handler. `doctor` and `uninstall` have none: `runCli` answers them with their
 * retirement before it parses anything (`src/retired.ts`).
 */
const migrate = createMigrateCommand();

export const handlers: CommandHandlers = { migrate, install: migrate };

process.exitCode = await runCli(process.argv.slice(2), { handlers });
