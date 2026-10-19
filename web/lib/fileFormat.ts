/**
 * the Dash's line for the playing file's own format, e.g.
 * "FLAC · 44.1 kHz · 16-bit · 979 kbps" or "DSF · DSD128 · 5.6 MHz".
 * Takes what GET /now-playing/file returns; unknown parts are left out,
 * never shown as 0, and nothing known renders null (no line at all).
 */
export interface FileFormat {
  suffix?: string;
  contentType?: string;
  bitRate?: number;
  samplingRate?: number;
  bitDepth?: number;
  channelCount?: number;
}

const DSD_BASE = 44_100;

function trimZero(n: number, digits: number): string {
  return n.toFixed(digits).replace(/\.0+$/, '');
}

export function formatFileFormat(f: FileFormat | null | undefined): string | null {
  if (!f) return null;
  const parts: string[] = [];
  if (f.suffix) parts.push(f.suffix.toUpperCase());

  const sr = f.samplingRate;
  // A 1-bit stream at a whole multiple of 44.1 kHz is DSD: its multiple is
  // the name people use, and its "bit rate" (11,290 kbps) reads as a typo.
  const dsd = f.bitDepth === 1 && sr && sr % DSD_BASE === 0 && sr / DSD_BASE >= 64;
  if (dsd && sr) {
    parts.push(`DSD${sr / DSD_BASE}`, `${trimZero(sr / 1_000_000, 1)} MHz`);
  } else {
    if (sr) parts.push(`${trimZero(sr / 1000, 1)} kHz`);
    if (f.bitDepth) parts.push(`${f.bitDepth}-bit`);
    if (f.bitRate) parts.push(`${f.bitRate.toLocaleString('en-GB')} kbps`);
  }
  if (f.channelCount === 1) parts.push('mono');
  else if (f.channelCount && f.channelCount > 2) parts.push(`${f.channelCount} ch`);

  return parts.length ? parts.join(' · ') : null;
}
