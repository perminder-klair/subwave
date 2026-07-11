import {
  availabilityFor,
  resolveFormatPreference,
  type AudioFormat,
  type NativePlatform,
  type StreamEnablement,
} from './audioFormat.ts';

export type LoadResult =
  | { status: 'applied' }
  | { status: 'superseded' }
  | { status: 'rejected'; error: unknown };

export interface LatestLoadCoordinator<T> {
  request(value: T): Promise<LoadResult>;
  invalidate(): void;
}

/**
 * RNTP load/reset operations mutate one global player. Keep exactly one in
 * flight, retain only the newest queued request, and do not call an older
 * completion "applied" when a newer request or lifecycle invalidation exists.
 */
export function createLatestLoadCoordinator<T>(
  execute: (value: T) => Promise<void>,
): LatestLoadCoordinator<T> {
  type Entry = {
    value: T;
    revision: number;
    resolve: (result: LoadResult) => void;
  };
  let revision = 0;
  let running = false;
  let pending: Entry | null = null;

  const drain = async () => {
    if (running || !pending) return;
    running = true;
    const entry = pending;
    pending = null;
    let error: unknown;
    try {
      await execute(entry.value);
    } catch (caught) {
      error = caught;
    }
    const current = entry.revision === revision && pending === null;
    entry.resolve(current
      ? error === undefined ? { status: 'applied' } : { status: 'rejected', error }
      : { status: 'superseded' });
    running = false;
    void drain();
  };

  return {
    request(value) {
      const requestRevision = ++revision;
      if (pending) pending.resolve({ status: 'superseded' });
      return new Promise<LoadResult>((resolve) => {
        pending = { value, revision: requestRevision, resolve };
        void drain();
      });
    },
    invalidate() {
      revision += 1;
      if (pending) pending.resolve({ status: 'superseded' });
      pending = null;
    },
  };
}

export interface FirstTuneReadiness {
  resolveStorage(stored: AudioFormat | null): void;
  resolveCapabilities(enabled: StreamEnablement): void;
  select(format: AudioFormat): void;
  wait(platform: NativePlatform): Promise<AudioFormat | null>;
  invalidate(): void;
}

/** Waits for preference + authoritative capabilities, with a legacy timeout. */
export function createFirstTuneReadiness(
  _base: string,
  fallbackMs: number,
): FirstTuneReadiness {
  let stored: AudioFormat | null = null;
  let storageKnown = false;
  let capabilities: StreamEnablement | null = null;
  let selected: AudioFormat | null = null;
  let invalidated = false;
  const waiters = new Set<{
    platform: NativePlatform;
    resolve: (format: AudioFormat | null) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  const settle = (forceFallback = false) => {
    for (const waiter of [...waiters]) {
      if (!invalidated && !selected && !forceFallback && (!storageKnown || !capabilities)) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      if (invalidated) waiter.resolve(null);
      else if (selected) waiter.resolve(selected);
      else if (!storageKnown || !capabilities) waiter.resolve('mp3');
      else waiter.resolve(resolveFormatPreference(
        stored, availabilityFor(waiter.platform, capabilities, new Set()),
      ));
    }
  };

  return {
    resolveStorage(value) {
      stored = value;
      storageKnown = true;
      settle();
    },
    resolveCapabilities(value) {
      capabilities = value;
      settle();
    },
    select(value) {
      selected = value;
      settle();
    },
    wait(platform) {
      if (invalidated) return Promise.resolve(null);
      if (selected) return Promise.resolve(selected);
      if (storageKnown && capabilities) {
        return Promise.resolve(resolveFormatPreference(
          stored, availabilityFor(platform, capabilities, new Set()),
        ));
      }
      return new Promise((resolve) => {
        const waiter = {
          platform,
          resolve,
          timer: setTimeout(() => settle(true), fallbackMs),
        };
        waiters.add(waiter);
      });
    },
    invalidate() {
      invalidated = true;
      settle();
    },
  };
}
