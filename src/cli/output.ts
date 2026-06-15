/** The single output envelope every command emits. */
export interface Envelope<T> {
  ok: boolean;
  data: T | null;
  warnings: string[];
  errors: string[];
}

export function ok<T>(data: T, warnings: string[] = []): Envelope<T> {
  return { ok: true, data, warnings, errors: [] };
}

export function fail(errors: string[], warnings: string[] = []): Envelope<null> {
  return { ok: false, data: null, warnings, errors };
}

/** Print an envelope as pretty JSON (machine) or a compact human summary. */
export function emit(env: Envelope<unknown>, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(env, null, 2) + '\n');
    return;
  }
  for (const w of env.warnings) process.stderr.write(`! ${w}\n`);
  if (!env.ok) {
    for (const e of env.errors) process.stderr.write(`✗ ${e}\n`);
    return;
  }
  process.stdout.write(formatHuman(env.data) + '\n');
}

function formatHuman(data: unknown): string {
  if (data === null || data === undefined) return 'ok';
  if (typeof data === 'string') return data;
  return JSON.stringify(data, null, 2);
}
