import type { OutputStreams } from './output.js';

/**
 * Injected environment for a single CLI invocation. `runCli` never touches the
 * real `process` (streams, cwd, env, exit code) directly — everything flows
 * through `io`, so tests can drive the dispatcher in-process with captured
 * output and a temp-dir KB.
 */
export interface CliIo extends OutputStreams {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /**
   * The launcher entry script (`process.argv[1]`), reported by `kb version` as `entry`
   * so a preflight can tell which binary is running (02 §2). Optional: in-process tests
   * omit it, and `kb version` then reports `entry: null`.
   */
  entry?: string;
}
