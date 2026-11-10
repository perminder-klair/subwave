// Routine fallback refreshes avoid the session boundary and :02 cleanup.
// Rotate the whole legacy minute set, retaining even its short rollover gap.
// intervalMinutes is the positive integer already validated by config.
//
// The session boundary is the STATION's :00 (#2234), which a fractional-offset
// zone puts at process :15, :30 or :45 (`stationHourMinute`, from time.ts
// stationHourStartProcessMinute). The cron fires on process minutes, so it
// avoids that minute as well, and a whole-hour station (0) gets the schedule
// it always had. When no rotation can miss all three (an every-2-minute
// refresh against a :15 or :45 boundary), it keeps clear of process :00 and
// :02 as before: a refresh that shares the roll's minute is a wasted build,
// never a wrong one, since the roll's own refresh never joins it.
export function autoPlaylistRefreshCron(intervalMinutes: number, stationHourMinute = 0): string {
  if (intervalMinutes === 1) return '* * * * *';
  const boundary = ((Math.trunc(stationHourMinute) % 60) + 60) % 60;
  return rotateOff(intervalMinutes, [0, 2, boundary])
    ?? rotateOff(intervalMinutes, [0, 2])
    ?? (() => { throw new Error('No off-boundary auto-playlist schedule for interval'); })();
}

function rotateOff(intervalMinutes: number, avoid: number[]): string | null {
  const minutes: number[] = [];
  for (let m = 0; m < 60; m += intervalMinutes) minutes.push(m);
  for (let candidate = 7; candidate < 67; candidate++) {
    const offset = candidate % 60;
    if (offset === 0) continue;
    const rotated = minutes.map(m => (m + offset) % 60).sort((a, b) => a - b);
    if (!avoid.some(m => rotated.includes(m))) {
      return `${rotated.join(',')} * * * *`;
    }
  }
  return null;
}

// Immediate show/operator work must never join a potentially stale build.
// Only expendable periodic work stands down, with no queue or trailing retry.
export function createAutoPlaylistRefreshRunner(build: () => Promise<void>, isBusy = () => false) {
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
    // The idle-aware writer also sees immediate and resume requests, including
    // ones waiting to publish after another build. Do not queue periodic work.
    if (activeBuilds > 0 || isBusy()) return false;
    await refresh();
    return true;
  }
  return { refresh, refreshScheduled };
}
