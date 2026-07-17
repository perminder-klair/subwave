// Listener-selectable stream format. The station always serves the MP3 floor;
// Opus / FLAC / AAC are optional mounts the operator enables per station (they
// ride the `stream` flags on /now-playing). Which of them a listener can pick
// is ALSO a platform question: iOS AVPlayer cannot demux the Ogg container, so
// the Ogg-encapsulated mounts (Opus, FLAC) are Android/ExoPlayer-only; AAC
// (ADTS) and MP3 decode everywhere. The preference is stored per station —
// different stations enable different mounts — as one AsyncStorage JSON map
// keyed by base URL (same swallow-failures contract as volume.ts).

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import type { StreamInfo } from './types';

export type StreamFormat = 'mp3' | 'aac' | 'opus' | 'flac';

export interface StreamFormatOption {
  format: StreamFormat;
  label: string;
  detail: string;
}

// Display order: universal floor first, then rising fidelity/cost.
const OPTION_META: readonly StreamFormatOption[] = [
  { format: 'mp3', label: 'MP3', detail: 'universal · most reliable' },
  { format: 'aac', label: 'AAC', detail: 'efficient · easy on data' },
  { format: 'opus', label: 'Opus', detail: 'best quality per bit' },
  { format: 'flac', label: 'FLAC', detail: 'lossless · heavy on data' },
];

const ALL_FORMATS = OPTION_META.map((o) => o.format);

export function isStreamFormat(v: unknown): v is StreamFormat {
  return typeof v === 'string' && (ALL_FORMATS as string[]).includes(v);
}

/** Icecast mount path for a format — matches the Liquidsoap outputs and the
 *  Caddy route table (`/stream.mp3`, `/stream.opus`, …). */
export function mountFor(format: StreamFormat): string {
  return `/stream.${format}`;
}

/** Can THIS device's player engine decode the format? ExoPlayer (Android)
 *  demuxes Ogg, so everything plays; AVPlayer (iOS) does not, which rules out
 *  the Ogg-encapsulated Opus and FLAC mounts. Anything else (defensive) gets
 *  the MP3 floor only. */
export function platformSupports(format: StreamFormat): boolean {
  if (format === 'mp3') return true;
  if (Platform.OS === 'android') return true;
  if (Platform.OS === 'ios') return format === 'aac';
  return false;
}

/** Does the station advertise the mount as live? MP3 is the always-on floor;
 *  the rest need their explicit flag. Unknown info (pre-first-poll) counts as
 *  NOT advertised — pickers should only offer what's confirmed. */
export function stationEnables(info: StreamInfo | null | undefined, format: StreamFormat): boolean {
  if (format === 'mp3') return true;
  if (!info) return false;
  if (format === 'aac') return info.aacEnabled === true;
  if (format === 'opus') return info.opusEnabled === true;
  return info.flacEnabled === true;
}

/** The formats the listener can pick right now: platform-decodable AND
 *  advertised by the station. Always contains at least MP3. */
export function availableFormats(info: StreamInfo | null | undefined): StreamFormatOption[] {
  return OPTION_META.filter((o) => platformSupports(o.format) && stationEnables(info, o.format));
}

/** The format to actually tune with. The stored preference wins while the
 *  platform can decode it and the station still (or plausibly) serves it;
 *  before the first poll lands (info null/undefined) the preference is trusted
 *  optimistically — if the mount is gone the reconnect loop self-corrects to
 *  MP3 once the poll arrives and this flips. Everything else falls back to the
 *  universal MP3 floor. */
export function effectiveFormat(
  pref: StreamFormat,
  info: StreamInfo | null | undefined,
): StreamFormat {
  if (!platformSupports(pref)) return 'mp3';
  if (info && !stationEnables(info, pref)) return 'mp3';
  return pref;
}

export function formatLabel(format: StreamFormat): string {
  return OPTION_META.find((o) => o.format === format)?.label ?? format.toUpperCase();
}

// --- persistence -----------------------------------------------------------

const STORAGE_KEY = 'subwave.streamFormat.v1';

async function loadMap(): Promise<Record<string, string>> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    /* corrupt / unavailable — behave as unset */
  }
  return {};
}

/** Read the stored format for a station base URL, or null when unset/invalid
 *  so the caller keeps its MP3 default. */
export async function loadFormatPref(base: string): Promise<StreamFormat | null> {
  if (!base) return null;
  const map = await loadMap();
  const v = map[base];
  return isStreamFormat(v) ? v : null;
}

/** Persist the format for a station base URL. MP3 (the default) removes the
 *  entry — an unset key and the default are the same thing. Failures are
 *  swallowed; playback is unaffected. */
export async function saveFormatPref(base: string, format: StreamFormat): Promise<void> {
  if (!base) return;
  try {
    const map = await loadMap();
    if (format === 'mp3') delete map[base];
    else map[base] = format;
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* storage full / unavailable — non-fatal */
  }
}
