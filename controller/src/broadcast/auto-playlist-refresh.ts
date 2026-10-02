// Serialize all fallback writers, retaining only a need to rebuild, never a
// snapshot of a show that may have ended while the programme was paused.
export type RefreshResult = 'refreshed' | 'deferred';

export function createAutoPlaylistRefresh({ isIdle, build, onDeferred = () => {} }: {
  isIdle: () => boolean;
  build: (canPublish: () => boolean) => Promise<RefreshResult>;
  onDeferred?: () => void;
}) {
  let pending = false;
  let tail: Promise<unknown> = Promise.resolve();
  let queuedAutomatic: Promise<RefreshResult> | null = null;
  let activeRequests = 0;

  function defer(): RefreshResult {
    if (!pending) onDeferred();
    pending = true;
    return 'deferred';
  }

  function request({ automatic }: { automatic: boolean }): Promise<RefreshResult> {
    if (automatic && isIdle()) return Promise.resolve(defer());
    if (automatic && queuedAutomatic) return queuedAutomatic;
    activeRequests++;
    const run = tail.then(async (): Promise<RefreshResult> => {
      if (automatic) queuedAutomatic = null;
      if (automatic && isIdle()) return defer();
      const wasPending = pending;
      pending = false;
      try {
        const result = await build(() => !automatic || !isIdle());
        if (result === 'deferred') return defer();
        return result;
      } catch (err) {
        if (automatic || wasPending) pending = true;
        throw err;
      }
    }).finally(() => { activeRequests--; });
    tail = run.catch(() => {});
    if (automatic) queuedAutomatic = run;
    return run;
  }

  async function flushPending(): Promise<void> {
    if (pending && !isIdle()) await request({ automatic: true });
  }

  return { request, flushPending, isBusy: () => activeRequests > 0 };
}
