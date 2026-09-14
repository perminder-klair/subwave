export type DispatchOutcome<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown };

export interface AnalysisDispatchOptions<T> {
  concurrency: number;
  beforeStart: (index: number) => Promise<void>;
  run: (id: string, index: number) => Promise<T>;
  onOutcome: (outcome: DispatchOutcome<T>, id: string, index: number) => void | Promise<void>;
}

/**
 * Admit analysis jobs in source order, bounded by a fixed number of live runs,
 * while committing their outcomes back to the coordinator in source order.
 */
export async function dispatchAnalysis<T>(
  ids: readonly string[],
  options: AnalysisDispatchOptions<T>,
): Promise<void> {
  const concurrency = Math.max(1, Math.floor(options.concurrency));
  const outcomes = new Map<number, DispatchOutcome<T>>();
  const active = new Set<Promise<void>>();
  let nextAdmission = 0;
  let nextOutcome = 0;
  let commitChain = Promise.resolve();

  const commitReady = (): Promise<void> => {
    commitChain = commitChain.then(async () => {
      while (outcomes.has(nextOutcome)) {
        const outcome = outcomes.get(nextOutcome)!;
        outcomes.delete(nextOutcome);
        await options.onOutcome(outcome, ids[nextOutcome], nextOutcome);
        nextOutcome += 1;
      }
    });
    return commitChain;
  };

  while (nextAdmission < ids.length) {
    if (active.size >= concurrency) await Promise.race(active);
    const index = nextAdmission++;
    // Admission itself is serial and source-ordered. The callback runs only
    // after capacity exists, so a quiet-time pause cannot build a hidden queue
    // of downloads waiting behind the gate.
    await options.beforeStart(index);
    const task = (async () => {
      let outcome: DispatchOutcome<T>;
      try {
        outcome = { status: 'fulfilled', value: await options.run(ids[index], index) };
      } catch (reason) {
        outcome = { status: 'rejected', reason };
      }
      outcomes.set(index, outcome);
      await commitReady();
    })();
    active.add(task);
    void task.then(() => active.delete(task), () => active.delete(task));
  }

  await Promise.all(active);
  await commitChain;
}
