// Argument parsing for scripts/run-tests.ts, kept apart so run-args.test.ts can
// drive it without starting a run.
import { availableParallelism } from 'node:os';

export interface RunArgs {
  jobs: number;
  filter: string | undefined;
}

// --jobs N / -j N / --jobs=N, else TEST_CONCURRENCY, else 1. 'auto' means one
// file per available CPU. The first remaining argument is the name filter.
//
// A bad value throws rather than being clamped or skipped: a flag given no
// value (`npm test -- picker -j` must not quietly run serially), a count that
// is not plain digits (Number() would read `0x10` or `1e1`), and an earlier
// flag a later one overrides. `-j4` is refused by name, since as a filter it
// would only report that no file matches. An empty TEST_CONCURRENCY is
// different — that reads as "not set", so it means 1.
export function parseRunArgs(args: readonly string[], env: NodeJS.ProcessEnv = process.env): RunArgs {
  let jobs: number | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--jobs' || a === '-j') jobs = parseJobs(args[++i] ?? '', '--jobs');
    else if (a.startsWith('--jobs=')) jobs = parseJobs(a.slice('--jobs='.length), '--jobs');
    else if (a.startsWith('-j') || a.startsWith('--jobs')) {
      throw new Error(`Unknown option "${a}": give the count as its own argument (-j 4, --jobs 4) or as --jobs=4.`);
    } else rest.push(a);
  }
  jobs ??= env.TEST_CONCURRENCY ? parseJobs(env.TEST_CONCURRENCY, 'TEST_CONCURRENCY') : 1;
  return { jobs, filter: rest[0] };
}

function parseJobs(raw: string, source: string): number {
  if (raw === 'auto') return availableParallelism();
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new Error(`${source} must be a positive integer or "auto", got "${raw}".`);
  }
  return n;
}
