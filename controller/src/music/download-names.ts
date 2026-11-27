// File names for the Library download (routes/library/download.ts): one rule
// for a single track's attachment name and a zip's entry names, so the same
// track saves under the same name either way. Pure, apart from the zip's day,
// which is the station's (time.ts).
//
// A name is `Artist - Title.ext`, made safe on every desktop system the operator
// may unpack on: no path separators or characters Windows refuses, no control
// characters, no trailing dot or space, no DOS device name, and short enough for
// a deep target folder. The extension is the file's own (the library walk's
// suffix), else the music server's file name, else its content type.

import { zonedISODate } from '../time.js';

const TYPE_EXT: Record<string, string> = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/flac': 'flac', 'audio/x-flac': 'flac',
  'audio/ogg': 'ogg', 'audio/vorbis': 'ogg', 'audio/opus': 'opus',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
  'audio/aiff': 'aiff', 'audio/x-aiff': 'aiff',
  'audio/x-ms-wma': 'wma', 'audio/x-ape': 'ape', 'audio/ape': 'ape',
  'audio/x-wavpack': 'wv', 'audio/dsf': 'dsf', 'audio/x-dsf': 'dsf',
};

const NAME_MAX_CHARS = 120;
const DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function cleanExt(ext: unknown): string | null {
  if (typeof ext !== 'string') return null;
  const e = ext.trim().replace(/^\./, '').toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(e) ? e : null;
}

// The extension of a `Content-Disposition` file name, either form.
export function extFromDisposition(header: string | null | undefined): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(header);
  let name: string | null = null;
  if (star) {
    try { name = decodeURIComponent(star[1].trim()); } catch { name = null; }
  }
  if (!name) {
    const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
    name = plain ? (plain[2] ?? plain[1]).trim() : null;
  }
  const m = name ? /\.([^./\\]+)$/.exec(name) : null;
  return m ? cleanExt(m[1]) : null;
}

export function extFromContentType(type: string | null | undefined): string | null {
  const t = (type || '').split(';')[0].trim().toLowerCase();
  return TYPE_EXT[t] ?? null;
}

// One path segment, safe to create anywhere.
export function safeSegment(raw: string): string {
  let s = raw.normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[/\\:]/g, '-')
    .replace(/"/g, "'")
    .replace(/[*?<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(s);
  if (chars.length > NAME_MAX_CHARS) s = chars.slice(0, NAME_MAX_CHARS).join('').trim();
  s = s.replace(/[. ]+$/, '');
  if (DEVICE_NAMES.test(s)) s = `_${s}`;
  return s;
}

export interface NameParts {
  id: string;
  artist?: string | null;
  title?: string | null;
  fileSuffix?: string | null;
}

export function trackFileName(
  t: NameParts,
  upstream: { contentType?: string | null; disposition?: string | null } = {},
): string {
  const parts = [t.artist, t.title]
    .map(v => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean);
  const base = safeSegment(parts.join(' - ')) || safeSegment(`track ${t.id}`) || 'track';
  const ext = cleanExt(t.fileSuffix)
    ?? extFromDisposition(upstream.disposition)
    ?? extFromContentType(upstream.contentType);
  return ext ? `${base}.${ext}` : base;
}

// Keeps names unique inside one archive, the way a desktop names a copy:
// `Name (2).ext`. Compared case-insensitively, since Windows and macOS unpack
// `a.flac` and `A.flac` onto the same file.
export function uniqueName(name: string, used: Set<string>): string {
  const key = (n: string) => n.normalize('NFC').toLowerCase();
  if (!used.has(key(name))) {
    used.add(key(name));
    return name;
  }
  const m = /^(.*?)(\.[a-z0-9]{1,8})?$/i.exec(name)!;
  const stem = m[1];
  const ext = m[2] ?? '';
  for (let n = 2; ; n++) {
    const next = `${stem} (${n})${ext}`;
    if (!used.has(key(next))) {
      used.add(key(next));
      return next;
    }
  }
}

// `attachment` with the name twice: an ASCII fallback for old clients and the
// exact UTF-8 name (RFC 6266 / 5987) for every current browser.
export function attachmentDisposition(name: string): string {
  const ascii = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_');
  const star = encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${star}`;
}

// The day is the station's, like every other day the station names: a UTC
// date is a day off for part of the evening or the morning.
export function zipFileName(count: number, now = new Date()): string {
  const day = zonedISODate(now);
  return `library-${count}-tracks-${day}.zip`;
}

// The archive's `_missing.txt`: which tracks could not be fetched, and why.
export const MISSING_LIST_NAME = '_missing.txt';

export function missingListText(missing: Array<{ id: string; name: string; reason: string }>): string {
  const lines = missing.map(m => `${m.name}  [id ${m.id}]: ${m.reason}`);
  return [
    `${missing.length} track${missing.length === 1 ? '' : 's'} could not be fetched from the music server and ${missing.length === 1 ? 'is' : 'are'} not in this archive:`,
    '',
    ...lines,
    '',
  ].join('\r\n');
}
