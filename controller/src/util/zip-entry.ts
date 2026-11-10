// Reading members of an uploaded zip — the two checks every importer needs
// before it trusts a single byte of the archive.
//
// `isSafeZipEntry` is the zip-slip guard: no absolute paths, no drive letters,
// no '..' segment. adm-zip sanitises extraction paths too; this keeps the
// refusal explicit and testable at the call site.
//
// `readZipEntryCapped` bounds a member by its DECLARED uncompressed size
// BEFORE inflating it. A zip is free to pair a few kilobytes of deflate data
// with a declared size of gigabytes, and adm-zip (>= 0.6) caps inflation at
// exactly that declared size — so the declared figure is the one that has to
// be checked, and checking the inflated buffer afterwards is too late. The
// post-read length check covers a STORED member, whose bytes are copied as-is.
import type AdmZip from 'adm-zip';

export function isSafeZipEntry(entryName: string): boolean {
  const n = entryName.replace(/\\/g, '/');
  if (n.startsWith('/') || /^[a-zA-Z]:/.test(n)) return false;
  return !n.split('/').includes('..');
}

/** The uncompressed size the archive claims for `entry`. */
export function declaredSize(entry: AdmZip.IZipEntry): number {
  return Number(entry.header?.size) || 0;
}

/**
 * The member's bytes, or null when it is larger than `maxBytes` — declared or
 * actual. Never inflates a member whose declared size is over the cap.
 */
export function readZipEntryCapped(entry: AdmZip.IZipEntry, maxBytes: number): Buffer | null {
  if (declaredSize(entry) > maxBytes) return null;
  const data = entry.getData();
  return data.length > maxBytes ? null : data;
}
