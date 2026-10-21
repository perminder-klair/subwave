// Only an unpinned primary with a usable backup may skip refusal retries.
// Keep the SDK and controller retry decisions in the same per-attempt scope.
import { AsyncLocalStorage } from 'node:async_hooks';
import { isConnectionRefused } from './pure.js';

const refusalFailover = new AsyncLocalStorage<() => boolean>();

// Enter a scope even when failover is disabled, so nested pinned/backup calls
// cannot inherit an enclosing primary's eligibility. Resolve the backup lazily.
export function withRefusalFailover<T>(canFailover: () => boolean, fn: () => Promise<T>): Promise<T> {
  return refusalFailover.run(canFailover, fn);
}

export function shouldFailoverRefusal(err: Parameters<typeof isConnectionRefused>[0]): boolean {
  return isConnectionRefused(err) && refusalFailover.getStore()?.() === true;
}
