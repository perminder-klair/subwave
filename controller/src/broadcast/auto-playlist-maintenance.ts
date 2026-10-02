// Routine fallback refreshes avoid the session boundary and :02 cleanup.
// Rotate the whole legacy minute set, retaining even its short rollover gap.
// intervalMinutes is the positive integer already validated by config.
export function autoPlaylistRefreshCron(intervalMinutes: number): string {
  if (intervalMinutes === 1) return '* * * * *';
  const minutes: number[] = [];
  for (let m = 0; m < 60; m += intervalMinutes) minutes.push(m);
  for (let candidate = 7; candidate < 67; candidate++) {
    const offset = candidate % 60;
    if (offset === 0) continue;
    const rotated = minutes.map(m => (m + offset) % 60).sort((a, b) => a - b);
    if (!rotated.includes(0) && !rotated.includes(2)) {
      return `${rotated.join(',')} * * * *`;
    }
  }
  throw new Error('No off-boundary auto-playlist schedule for interval');
}

// Immediate show/operator work must never join a potentially stale build.
// Only expendable periodic work stands down, with no queue or trailing retry.
export function createAutoPlaylistRefreshRunner(build: () => Promise<void>) {
  let activeBuilds = 0;
  async function refresh(): Promise<void> {
    activeBuilds++;
    try {
      await build();
    } finally {
      activeBuilds--;
    }
  }
  async function refreshScheduled(): Promise<boolean> {
    if (activeBuilds > 0) return false;
    await refresh();
    return true;
  }
  return { refresh, refreshScheduled };
}
