#!/usr/bin/env node
import { runCli } from './runCli.js';

process.exitCode = await runCli(process.argv.slice(2), {
  stdout: (chunk) => process.stdout.write(chunk),
  stderr: (chunk) => process.stderr.write(chunk),
  cwd: process.cwd(),
  env: process.env,
  entry: process.argv[1]!,
});
