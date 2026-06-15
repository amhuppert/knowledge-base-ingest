import type { Repositories } from '../../db/repositories/index.js';
import type { SourceStore } from '../../ingest/sourceStore.js';

/**
 * Shared dependencies for services. `now` is injected so timestamps are
 * deterministic in tests; production passes the wall clock.
 */
export interface ServiceContext {
  readonly repos: Repositories;
  readonly store: SourceStore;
  readonly now: () => string;
}

export function systemClock(): string {
  return new Date().toISOString();
}
