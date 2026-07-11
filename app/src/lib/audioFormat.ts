export type AudioFormat = 'mp3' | 'opus' | 'aac' | 'flac';
export type NativePlatform = 'ios' | 'android';
export type UnavailableReason = 'station' | 'device' | 'failed';
export type StreamEnablement = Record<AudioFormat, boolean>;
export type StreamUrls = Record<AudioFormat, string>;
export type FormatAvailability = Record<AudioFormat, {
  available: boolean; reason?: UnavailableReason;
}>;

export const FORMAT_OPTIONS = [
  { id: 'mp3', label: 'MP3', description: 'Universal compatibility' },
  { id: 'opus', label: 'Opus', description: 'Efficient, high-quality audio' },
  { id: 'aac', label: 'AAC', description: 'Broadly compatible audio' },
  { id: 'flac', label: 'FLAC', description: 'Lossless processed broadcast' },
] as const;

const DEVICE_SUPPORT = {
  ios: { mp3: true, opus: false, aac: true, flac: false },
  android: { mp3: true, opus: false, aac: true, flac: false },
} as const;

export function availabilityFor(
  platform: NativePlatform, enabled: StreamEnablement,
  failed: ReadonlySet<AudioFormat>,
): FormatAvailability {
  return Object.fromEntries(FORMAT_OPTIONS.map(({ id }) => {
    if (!enabled[id]) return [id, { available: false, reason: 'station' }];
    if (!DEVICE_SUPPORT[platform][id]) return [id, { available: false, reason: 'device' }];
    if (failed.has(id)) return [id, { available: false, reason: 'failed' }];
    return [id, { available: true }];
  })) as FormatAvailability;
}

export function resolveFormatPreference(
  stored: AudioFormat | null, availability: FormatAvailability,
): AudioFormat {
  return stored && availability[stored].available ? stored : 'mp3';
}
export function streamPreferenceKey(base: string): string {
  return `subwave.audio-format.v1:${base.trim().replace(/\/+$/, '').toLowerCase()}`;
}
export function streamUrlFor(urls: StreamUrls, format: AudioFormat): string {
  return urls[format];
}
