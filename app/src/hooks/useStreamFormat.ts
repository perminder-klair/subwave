// Per-station stream-format preference (MP3 / AAC / Opus / FLAC).
//
// The raw preference is what the listener picked in the format drawer,
// hydrated from AsyncStorage per station base URL (same async-restore contract
// as the volume pref: defaults render first, then snap to the stored value).
// `format` is the feed-validated EFFECTIVE format the player should tune with:
// the preference gated on platform decodability and on what the station's
// /now-playing `stream` flags currently advertise — so an operator turning a
// mount off flips tuned-in listeners back to the MP3 floor on their next
// reconnect instead of error-looping against a dead mount.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  availableFormats,
  effectiveFormat,
  loadFormatPref,
  saveFormatPref,
  type StreamFormat,
  type StreamFormatOption,
} from '@/lib/streamFormat';
import type { StreamInfo } from '@/lib/types';

export interface StreamFormatControl {
  /** Feed-validated format for the player to tune with. */
  format: StreamFormat;
  /** The listener's raw pick — what the drawer shows as selected. */
  preference: StreamFormat;
  /** Formats pickable right now (platform-decodable AND station-enabled).
   *  Always includes MP3; length 1 means there is nothing to choose. */
  options: StreamFormatOption[];
  setFormat: (f: StreamFormat) => void;
}

export function useStreamFormat(
  base: string | null,
  streamInfo: StreamInfo | null,
): StreamFormatControl {
  const [preference, setPreference] = useState<StreamFormat>('mp3');

  // Hydrate per station; on switch, reset to the default first so station B
  // never briefly tunes with station A's preference.
  const baseRef = useRef(base);
  useEffect(() => {
    baseRef.current = base;
    setPreference('mp3');
    if (!base) return;
    let alive = true;
    loadFormatPref(base).then((stored) => {
      if (alive && stored && baseRef.current === base) setPreference(stored);
    });
    return () => {
      alive = false;
    };
  }, [base]);

  const setFormat = useCallback((f: StreamFormat) => {
    setPreference(f);
    if (baseRef.current) void saveFormatPref(baseRef.current, f);
  }, []);

  const options = useMemo(() => availableFormats(streamInfo), [streamInfo]);
  const format = useMemo(() => effectiveFormat(preference, streamInfo), [preference, streamInfo]);

  return { format, preference, options, setFormat };
}
