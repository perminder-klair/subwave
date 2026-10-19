// the playing FILE's own format, for the operator's Dash.
//
// These are properties of the file Navidrome stores (suffix, sample rate, bit
// depth, bit rate, channels), not of the stream the mixer sends: /debug's
// sampleRate is the mixer's output and says nothing about a 24/96 FLAC or a
// DSD128 file. Navidrome (OpenSubsonic) carries all of them on the song
// record, so one getSong per TRACK answers it exactly — never one per poll:
// the Dash asks every 3 s, and a lookup per ask is the read-path load the
// library-coverage rule exists to forbid.
//
// Unknown is ABSENT, never zero: Navidrome reports bitDepth 0 for a lossy
// file, and "0-bit" is not a property any file has.

export interface FileFormat {
  suffix?: string;
  contentType?: string;
  /** kbps, as Subsonic reports it. */
  bitRate?: number;
  /** Hz. */
  samplingRate?: number;
  bitDepth?: number;
  channelCount?: number;
}

const pos = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : undefined;

/** Pure projection of a Subsonic song onto the fields the Dash shows. */
export function fileFormatOf(song: unknown): FileFormat {
  const s = (song && typeof song === 'object' ? song : {}) as Record<string, unknown>;
  const out: FileFormat = {};
  if (typeof s.suffix === 'string' && s.suffix.trim()) out.suffix = s.suffix.trim().toLowerCase();
  if (typeof s.contentType === 'string' && s.contentType.trim()) out.contentType = s.contentType.trim();
  const bitRate = pos(s.bitRate); if (bitRate) out.bitRate = bitRate;
  const samplingRate = pos(s.samplingRate); if (samplingRate) out.samplingRate = samplingRate;
  const bitDepth = pos(s.bitDepth); if (bitDepth) out.bitDepth = bitDepth;
  const channelCount = pos(s.channelCount); if (channelCount) out.channelCount = channelCount;
  return out;
}

/** A failed lookup is not retried before this: a Dash polling a down
 *  Navidrome every 3 s must cost one call a minute, not twenty. */
export const FAILURE_RETRY_MS = 60_000;

type Entry = { format: FileFormat } | { failedAt: number };

/**
 * One getSong per track id, shared by every concurrent ask, held in a small
 * LRU (the Dash only ever asks about the track on air, so a handful covers a
 * skip back and forth). A failure answers null and backs off.
 */
export function createFileFormatLookup(deps: {
  getSong: (id: string) => Promise<unknown>;
  max?: number;
  now?: () => number;
}): (id: string) => Promise<FileFormat | null> {
  const max = deps.max ?? 16;
  const now = deps.now ?? Date.now;
  const memo = new Map<string, Entry>();
  const inflight = new Map<string, Promise<FileFormat | null>>();

  const remember = (id: string, e: Entry) => {
    memo.delete(id);
    memo.set(id, e);
    while (memo.size > max) memo.delete(memo.keys().next().value as string);
  };

  return async (id: string) => {
    const hit = memo.get(id);
    if (hit && 'format' in hit) {
      remember(id, hit); // LRU touch
      return hit.format;
    }
    if (hit && now() - hit.failedAt < FAILURE_RETRY_MS) return null;
    const running = inflight.get(id);
    if (running) return running;
    const p = (async () => {
      try {
        const format = fileFormatOf(await deps.getSong(id));
        remember(id, { format });
        return format;
      } catch {
        remember(id, { failedAt: now() });
        return null;
      } finally {
        inflight.delete(id);
      }
    })();
    inflight.set(id, p);
    return p;
  };
}
