/**
 * the Dash's line for the playing file's own format, e.g.
 * "FLAC · 44.1 kHz · 16-bit · 979 kbps" or "DSF · DSD128 · 5.6 MHz".
 * Takes what GET /now-playing/file returns; unknown parts are left out,
 * never shown as 0, and nothing known renders null (no line at all).
 */
export interface FileFormat {
  suffix?: string;
  bitRate?: number;
  samplingRate?: number;
  bitDepth?: number;
  channelCount?: number;
}

// DSD rates are multiples of 44.1 kHz, or (rarer) of 48 kHz; the MHz shown
// beside the name tells the two families apart.
const DSD_BASES = [44_100, 48_000];

function dsdMultiple(sr: number): number | null {
  for (const base of DSD_BASES) {
    if (sr % base === 0 && sr / base >= 64) return sr / base;
  }
  return null;
}

function trimZero(n: number, digits: number): string {
  return n.toFixed(digits).replace(/\.0+$/, '');
}

export function formatFileFormat(f: FileFormat | null | undefined): string | null {
  if (!f) return null;
  const parts: string[] = [];
  if (f.suffix) parts.push(f.suffix.toUpperCase());

  const sr = f.samplingRate;
  // A 1-bit stream at a whole multiple of 44.1 or 48 kHz is DSD: its multiple
  // is the name people use, and its "bit rate" (11,290 kbps) reads as a typo.
  const dsd = f.bitDepth === 1 && sr ? dsdMultiple(sr) : null;
  if (dsd && sr) {
    parts.push(`DSD${dsd}`, `${trimZero(sr / 1_000_000, 1)} MHz`);
  } else {
    if (sr) parts.push(`${trimZero(sr / 1000, 1)} kHz`);
    if (f.bitDepth) parts.push(`${f.bitDepth}-bit`);
    if (f.bitRate) parts.push(`${f.bitRate.toLocaleString('en-GB')} kbps`);
  }
  if (f.channelCount === 1) parts.push('mono');
  else if (f.channelCount && f.channelCount > 2) parts.push(`${f.channelCount} ch`);

  return parts.length ? parts.join(' · ') : null;
}
