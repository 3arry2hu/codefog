#!/usr/bin/env node
import { runCli } from "./cli.js";
import { shouldUseColor } from "./terminal-summary.js";

const exitCode = await runCli(process.argv.slice(2), {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  color: shouldUseColor(process.stdout.isTTY, process.env),
});
process.exitCode = exitCode;
