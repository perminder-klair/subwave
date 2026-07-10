export type AudioFormat = 'mp3' | 'opus' | 'aac' | 'flac';
export type StreamEnablement = Record<AudioFormat, boolean>;
export type BrowserSupport = Record<AudioFormat, boolean>;
export interface AudioStreamUrls {
  mp3: string;
  opus: string | null;
  aac: string | null;
  flac: string | null;
}
export type FormatAvailability = Record<AudioFormat, {
  available: boolean;
  reason: 'Not enabled by this station' | 'Not supported by this browser' | null;
}>;

export const AUDIO_FORMATS = [
  { id: 'mp3', label: 'MP3', description: 'Universal compatibility' },
  { id: 'opus', label: 'Opus', description: 'Efficient, high-quality audio' },
  { id: 'aac', label: 'AAC', description: 'Modern compressed audio' },
  { id: 'flac', label: 'FLAC', description: 'Lossless broadcast audio' },
] as const satisfies readonly { id: AudioFormat; label: string; description: string }[];

const FORMAT_SET = new Set<AudioFormat>(AUDIO_FORMATS.map(x => x.id));

export function deriveSiblingMounts(mp3: string): AudioStreamUrls {
  const marker = '/stream.mp3';
  const index = mp3.lastIndexOf(marker);
  if (index === -1) return { mp3, opus: null, aac: null, flac: null };
  const prefix = mp3.slice(0, index);
  const suffix = mp3.slice(index + marker.length);
  return {
    mp3,
    opus: `${prefix}/stream.opus${suffix}`,
    aac: `${prefix}/stream.aac${suffix}`,
    flac: `${prefix}/stream.flac${suffix}`,
  };
}

export function availabilityFor(
  enabled: StreamEnablement,
  supported: BrowserSupport,
): FormatAvailability {
  return Object.fromEntries(AUDIO_FORMATS.map(({ id }) => {
    const reason = !enabled[id]
      ? 'Not enabled by this station'
      : !supported[id]
        ? 'Not supported by this browser'
        : null;
    return [id, { available: reason === null, reason }];
  })) as FormatAvailability;
}

export function preferenceKey(stationId: string): string {
  return `subwave:audio-format:${encodeURIComponent(stationId)}`;
}

export function loadFormatPreference(
  storage: Pick<Storage, 'getItem'>,
  stationId: string,
): AudioFormat | null {
  const value = storage.getItem(preferenceKey(stationId));
  return value && FORMAT_SET.has(value as AudioFormat) ? value as AudioFormat : null;
}

export function saveFormatPreference(
  storage: Pick<Storage, 'setItem'>,
  stationId: string,
  format: AudioFormat,
): void {
  storage.setItem(preferenceKey(stationId), format);
}

export function effectiveFormat(
  preferred: AudioFormat | null,
  availability: FormatAvailability,
): AudioFormat {
  return preferred && availability[preferred].available ? preferred : 'mp3';
}
