// When the talk tick rolls the DJ session (#2234, #2254). Pure, so the
// station-clock walks in scripts/station-hour-roll.test.ts drive the same
// decision talkTick makes.
//
// The tick rolls when the station's position MOVED since it last looked, not
// on station minute 0. Two things move it:
//
//   - the station hour (time.ts stationHourKey): the show grid changes there.
//     An edge test on minute 0 missed every hour that opens without a :00
//     reaching a tick: a timezone saved mid-hour, the 30- and 45-minute DST
//     shifts of Lord Howe and Chatham, a late tick. With it, the zone's UTC
//     offset: a fall-back repeats the hour's key, and the repeated hour rolls
//     again (a no-op roll) so the hourly row pairs with a roll of its own pass
//     and cannot re-air the first pass's show welcome;
//   - the active show itself (settings.resolveActiveShow): a schedule edit or a
//     takeover's expiry changes the show inside an hour, and the session should
//     follow on the next tick rather than at the next :00.
//
// A roll from any other call site (a takeover route, the janitor) records the
// position too, through rollSessionNow, so the tick does not roll a second time
// for a change someone else already rolled for.
//
// The baseline is seeded when the scheduler starts, never on the first tick: a
// controller started at 09:59:30 must still roll at 10:00, and one started at
// 10:20 must not roll for an hour it booted into.

export type StationPosition = {
  hourKey: string;
  // time.ts stationUtcOffsetMinutes; it moves at a DST transition.
  utcOffset: number;
  // The resolved active show's id; null when the hour runs autonomously.
  showId: string | null;
};

export function stationPosition(hourKey: string, utcOffset: number, show: { id?: unknown } | null | undefined): StationPosition {
  const id = show?.id;
  return { hourKey, utcOffset, showId: typeof id === 'string' && id ? id : null };
}

// Whether the tick at `now` rolls, given where the station last was. No
// baseline means the scheduler has not started, so nothing rolls.
export function sessionRollDue(last: StationPosition | null, now: StationPosition): boolean {
  if (!last) return false;
  return last.hourKey !== now.hourKey || last.utcOffset !== now.utcOffset || last.showId !== now.showId;
}
