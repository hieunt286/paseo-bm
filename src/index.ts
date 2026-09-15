import { runCli } from "./cli.js";
import type { CommandHandlers } from "./cli.js";
import { doctorCommand } from "./commands/doctor.js";
import { installCommand } from "./commands/install/index.js";
import { uninstallCommand } from "./commands/uninstall.js";

/** The handler table: one entry per command of Design §4.1. */
export const handlers: CommandHandlers = {
  install: installCommand,
  doctor: doctorCommand,
  uninstall: uninstallCommand,
};

process.exitCode = await runCli(process.argv.slice(2), { handlers });
