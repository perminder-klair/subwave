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
// A bad value throws rather than being clamped, and that includes a flag given
// no value: `npm test -- picker -j` must not quietly run serially. An empty
// TEST_CONCURRENCY is different — that reads as "not set", so it means 1.
export function parseRunArgs(args: readonly string[], env: NodeJS.ProcessEnv = process.env): RunArgs {
  let jobsArg: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--jobs' || a === '-j') jobsArg = args[++i] ?? '';
    else if (a.startsWith('--jobs=')) jobsArg = a.slice('--jobs='.length);
    else rest.push(a);
  }
  const jobs = jobsArg !== undefined
    ? parseJobs(jobsArg, '--jobs')
    : env.TEST_CONCURRENCY === undefined || env.TEST_CONCURRENCY === ''
      ? 1
      : parseJobs(env.TEST_CONCURRENCY, 'TEST_CONCURRENCY');
  return { jobs, filter: rest[0] };
}

function parseJobs(raw: string, source: string): number {
  if (raw === 'auto') return Math.max(1, availableParallelism());
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${source} must be a positive integer or "auto", got "${raw}".`);
  }
  return n;
}
