// The admin Library download: the operator takes tracks out of the station
// library through the browser (to prepare live DJ sets on another computer,
// say). Two routes, the same shape as the preview player (preview.ts):
//
// - `POST /library/download` (admin) names a selection: the ticked rows
//   (`ids`), the Browse list's own filter (`filter`: every page of the list on
//   screen, read with the list's own query, library-db browse.ts `filterAll`),
//   or the Tracks tab's Liked list (`liked`: every liked track, in the view's
//   order for its sort, read by the view's own `likedRows`). A whole list never
//   means the whole library: an unnarrowed Browse filter is refused, and so is
//   any list above LIBRARY_DOWNLOAD_LIST_MAX tracks (400 `{ error, count, cap }`,
//   music/download-policy.ts); ticked ids keep their own limit. The selection is
//   resolved to track ids now and kept in memory under a random token; the
//   answer is a short-lived signed link to it, plus the count and the
//   estimated size (the walk's `file_size`) for the confirm.
// - `GET /library/download/:token?exp=&sig=` streams it. The browser navigates
//   to the link, so a many-GB body goes straight to disk and never through
//   fetch() into memory, and the link carries its own proof, because a
//   navigation cannot send the console's Basic header (util/signed-link.ts).
//
// One track: its original file (Subsonic `download`, else `stream` with
// format=raw when the server refuses downloads), Range passed through so the
// browser can resume, saved as `Artist - Title.ext`. Several: one zip, STORED
// (audio is already compressed), built as it streams (util/zip-stream.ts),
// fetching the tracks one at a time. Each track's upstream answer is opened
// before its entry header is written: a track the server cannot serve is
// skipped and listed in a `_missing.txt` at the end of the archive. That
// includes a heart left on an id a re-import retired: the likes store keeps
// it, the mirror and the music server do not, so its name comes from the
// heart's own snapshot. A selection of one such track is answered 404 before
// any link is minted, since a browser navigating to a bare 404 shows nothing.
// A failure after a track's first byte cannot be finished into a valid
// archive, so the connection is dropped and the browser shows the download as
// failed. When the
// browser goes away, the current upstream request is aborted and no further
// track is fetched.
//
// Neither endpoint scrobbles, so nothing moves the play counts the smart
// playlists read. The blocklist governs airplay, not the operator's own
// collection: a never-play track downloads like any other. The calls count in
// `/debug` as `download` (or `stream`) / `admin-download`.
import express from 'express';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { requireAdmin } from '../../middleware/auth.js';
import { validateBody } from '../../middleware/validate.js';
import * as library from '../../music/library.js';
import * as likes from '../../broadcast/likes.js';
import * as db from '../../music/library-db.js';
import * as subsonic from '../../music/subsonic.js';
import { recordHttpAttempt } from '../../music/subsonic-log.js';
import {
  MISSING_LIST_NAME, attachmentDisposition, missingListText, trackFileName, uniqueName, zipFileName,
  type NameParts,
} from '../../music/download-names.js';
import { LIBRARY_DOWNLOAD_LIST_MAX, libraryDownloadSchema, type LibraryDownloadBody } from '../../schemas/library-download.js';
import { signedLinkValid, signedQuery } from '../../util/signed-link.js';
import { StoreZipWriter } from '../../util/zip-stream.js';
import { browseFilterFromQuery, likedRows, likedViewFromQuery } from './browse.js';
import { browseListNarrowed, listDownloadRefusal, type ListDownloadRefusal } from '../../music/download-policy.js';

export const router = express.Router();

export const DOWNLOAD_TTL_SEC = 6 * 3600;
// Selections kept at once; the oldest goes first. Each is a list of ids.
export const DOWNLOAD_SELECTIONS_MAX = 16;
// Navidrome's answer must start within this; the body then streams for as long
// as the browser keeps reading.
const UPSTREAM_HEADERS_TIMEOUT_MS = 15_000;
const TOKEN_RE = /^[\w-]{16,64}$/;

// `hints`: names for ids the mirror does not hold (a liked id a re-import
// retired), from the likes store's snapshot.
interface Selection { ids: string[]; name: string; hints: Map<string, NameParts>; expMs: number }
const selections = new Map<string, Selection>();

function remember(ids: string[], name: string, hints: Map<string, NameParts>, nowMs = Date.now()): string {
  for (const [token, sel] of selections) if (sel.expMs <= nowMs) selections.delete(token);
  while (selections.size >= DOWNLOAD_SELECTIONS_MAX) {
    const oldest = selections.keys().next().value as string;
    selections.delete(oldest);
  }
  const token = randomBytes(16).toString('base64url');
  selections.set(token, { ids, name, hints, expMs: nowMs + DOWNLOAD_TTL_SEC * 1000 });
  return token;
}

/** Test hook: forget every selection. */
export function _resetDownloadSelections(): void { selections.clear(); }

// The whole-list cap (LIBRARY_DOWNLOAD_LIST_MAX); a test lowers it rather than
// seeding thousands of rows.
let listCap = LIBRARY_DOWNLOAD_LIST_MAX;
/** Test hook: set the whole-list cap. */
export function _setListDownloadCap(n: number): void { listCap = n; }

type Resolved =
  | { ids: string[]; reindexing: boolean; refused?: undefined }
  | { refused: ListDownloadRefusal };

// A whole list (`filter`, `liked`) passes the guard of music/download-policy.ts:
// an unnarrowed Browse list is refused before a row is read, and any list above
// the cap once counted. Ticked `ids` keep only their schema limit.
function resolveSelection(body: LibraryDownloadBody): Resolved {
  if (body.ids) {
    const seen = new Set<string>();
    const ids = body.ids.filter(id => (seen.has(id) ? false : (seen.add(id), true)));
    return { ids, reindexing: false };
  }
  if (body.liked) {
    // The view's own rows and order; it hides the station archive itself.
    const ids = likedRows(likedViewFromQuery(body.liked)).map(r => r.id);
    const refused = listDownloadRefusal({ narrowed: true, count: ids.length, cap: listCap });
    return refused ? { refused } : { ids, reindexing: false };
  }
  const { opts } = browseFilterFromQuery(body.filter ?? {});
  const unnarrowed = listDownloadRefusal({ narrowed: browseListNarrowed(opts), count: null, cap: listCap });
  if (unnarrowed) return { refused: unnarrowed };
  const { rows, reindexing } = db.filterAll(opts);
  // The list hides station-archive rows an old tagger wrote (#273); so does this.
  const ids = rows.filter(r => !subsonic.isStationArchive(r)).map(r => r.id);
  const refused = listDownloadRefusal({ narrowed: true, count: ids.length, cap: listCap });
  return refused ? { refused } : { ids, reindexing: !!reindexing };
}

// Names for the ids the mirror does not hold, from the likes store's snapshot
// (a heart keeps the artist and title it was given). Needs the store loaded.
function nameHints(ids: readonly string[], rows: Map<string, unknown>): Map<string, NameParts> {
  const out = new Map<string, NameParts>();
  const absent = new Set(ids.filter(id => !rows.has(id)));
  if (absent.size === 0) return out;
  for (const entry of likes.likedSongs()) {
    if (!absent.has(entry.songId)) continue;
    out.set(entry.songId, { id: entry.songId, artist: entry.track.artist ?? null, title: entry.track.title ?? null });
  }
  return out;
}

// True only when the music server itself says the id is unknown (Subsonic
// code 70). Anything else, an outage included, mints the link as before and
// leaves the answer to the download itself.
async function goneFromServer(id: string): Promise<boolean> {
  try {
    return !(await subsonic.getSong(id));
  } catch (err) {
    return (err as { subsonicCode?: number }).subsonicCode === 70;
  }
}

router.post('/library/download', requireAdmin, validateBody(libraryDownloadSchema), async (req, res) => {
  try {
    await library.load();
    await likes.load();
    const resolved = resolveSelection(req.body as LibraryDownloadBody);
    if (resolved.refused) return res.status(400).json(resolved.refused);
    const { ids, reindexing } = resolved;
    if (ids.length === 0) return res.status(400).json({ error: 'no tracks to download' });
    let bytes = 0;
    let unsized = 0;
    const rows = db.downloadRowsByIds(ids);
    const hints = nameHints(ids, rows);
    if (ids.length === 1 && !rows.has(ids[0]) && await goneFromServer(ids[0])) {
      return res.status(404).json({ error: 'this track is no longer in the library', missing: ids });
    }
    for (const id of ids) {
      const size = rows.get(id)?.fileSize;
      if (typeof size === 'number' && size > 0) bytes += size; else unsized++;
    }
    const single = ids.length === 1;
    const name = single
      ? trackFileName({ id: ids[0], ...(rows.get(ids[0]) ?? hints.get(ids[0])) })
      : zipFileName(ids.length);
    const token = remember(ids, name, hints);
    res.json({
      path: `/library/download/${token}?${signedQuery('download', token, DOWNLOAD_TTL_SEC)}`,
      count: ids.length,
      // The walk's figures: an estimate, and `unsized` tracks have none.
      bytes,
      unsized,
      name,
      single,
      reindexing,
      expiresInSec: DOWNLOAD_TTL_SEC,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

type Opened =
  | { ok: true; r: Response }
  | { ok: false; status: number; reason: string };

const isErrorDoc = (r: Response) => /json|xml/i.test(r.headers.get('content-type') || '');

// The original file: `download` first, then `stream` format=raw (the same
// bytes) for a server that refuses downloads or does not offer them.
async function openTrack(id: string, signal: AbortSignal, range?: string): Promise<Opened> {
  const headers: Record<string, string> = {};
  if (range) headers.Range = range;
  recordHttpAttempt('download', 'admin-download');
  let r = await fetch(subsonic.getDownloadUrl(id), { headers, signal });
  if ((!r.ok && r.status !== 416) || isErrorDoc(r)) {
    await r.body?.cancel().catch(() => {});
    recordHttpAttempt('stream', 'admin-download');
    r = await fetch(subsonic.getRawStreamUrl(id), { headers, signal });
  }
  if (r.status === 416) return { ok: true, r };
  if (!r.ok) {
    await r.body?.cancel().catch(() => {});
    return { ok: false, status: r.status === 404 ? 404 : 502, reason: `music server answered HTTP ${r.status}` };
  }
  // A Subsonic error comes back as a 200 JSON/XML document, not audio.
  if (isErrorDoc(r)) {
    await r.body?.cancel().catch(() => {});
    return { ok: false, status: 404, reason: 'the music server does not have this track' };
  }
  return { ok: true, r };
}

// Opens one track with the headers deadline; `outer` is the client's abort.
async function openWithDeadline(id: string, outer: AbortController, range?: string) {
  const upstream = new AbortController();
  const onOuter = () => upstream.abort();
  // An 'abort' listener added after the fact never fires.
  if (outer.signal.aborted) upstream.abort();
  else outer.signal.addEventListener('abort', onOuter, { once: true });
  const timer = setTimeout(() => upstream.abort(), UPSTREAM_HEADERS_TIMEOUT_MS);
  try {
    const opened = await openTrack(id, upstream.signal, range);
    return { opened, upstream, release: () => outer.signal.removeEventListener('abort', onOuter) };
  } catch (err) {
    outer.signal.removeEventListener('abort', onOuter);
    const reason = outer.signal.aborted ? 'download cancelled'
      : upstream.signal.aborted ? 'the music server did not answer in time'
        : `could not reach the music server (${(err as Error).message})`;
    return { opened: { ok: false, status: 502, reason } as Opened, upstream, release: () => {} };
  } finally {
    clearTimeout(timer);
  }
}

const bodyOf = (r: Response) => Readable.fromWeb(r.body as import('node:stream/web').ReadableStream);

// Resolves once `chunk` is handed to the socket, waiting for drain; rejects
// when the browser has gone.
function sinkFor(res: express.Response) {
  return (chunk: Buffer) => new Promise<void>((resolve, reject) => {
    if (res.destroyed || res.writableEnded) return reject(new Error('client gone'));
    if (res.write(chunk)) return resolve();
    const done = (err?: Error) => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      if (err) reject(err); else resolve();
    };
    const onDrain = () => done();
    const onClose = () => done(new Error('client gone'));
    res.on('drain', onDrain);
    res.on('close', onClose);
  });
}

const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];

router.get('/library/download/:token', async (req, res) => {
  const { token } = req.params;
  if (!TOKEN_RE.test(token)) return res.status(400).end();
  if (!signedLinkValid('download', token, req.query.exp, req.query.sig)) return res.status(403).end();
  const sel = selections.get(token);
  if (!sel || sel.expMs <= Date.now()) return res.status(404).end();

  const client = new AbortController();
  res.on('close', () => client.abort());
  try {
    await library.load();
  } catch {
    return res.status(500).end();
  }

  if (sel.ids.length === 1) {
    const id = sel.ids[0];
    const range = typeof req.headers.range === 'string' ? req.headers.range : undefined;
    const { opened, release } = await openWithDeadline(id, client, range);
    if (!opened.ok) {
      release();
      if (!res.headersSent && !res.destroyed) res.status(opened.status).end();
      return;
    }
    const r = opened.r;
    res.status(r.status);
    for (const h of PASS_HEADERS) {
      const v = r.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    const name = trackFileName({ id, ...(db.downloadRowsByIds([id]).get(id) ?? sel.hints.get(id)) }, {
      contentType: r.headers.get('content-type'), disposition: r.headers.get('content-disposition'),
    });
    res.setHeader('Content-Disposition', attachmentDisposition(name));
    // The link is a private capability: never cache it in a shared cache.
    res.setHeader('Cache-Control', 'private, max-age=0, no-store');
    if (!r.body) { release(); return res.end(); }
    const body = bodyOf(r);
    body.on('error', () => res.destroy());
    body.on('end', release);
    body.pipe(res);
    return;
  }

  res.status(200);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', attachmentDisposition(sel.name));
  res.setHeader('Cache-Control', 'private, max-age=0, no-store');
  // Headers now, so the browser starts the download before the first track opens.
  res.flushHeaders();

  const zip = new StoreZipWriter(sinkFor(res));
  const used = new Set<string>([MISSING_LIST_NAME.toLowerCase()]);
  const missing: Array<{ id: string; name: string; reason: string }> = [];
  try {
    for (let i = 0; i < sel.ids.length; i += 200) {
      const chunk = sel.ids.slice(i, i + 200);
      const meta = db.downloadRowsByIds(chunk);
      for (const id of chunk) {
        if (client.signal.aborted) return;
        const { opened, release } = await openWithDeadline(id, client);
        if (client.signal.aborted) {
          if (opened.ok) await opened.r.body?.cancel().catch(() => {});
          return;
        }
        if (!opened.ok) {
          missing.push({ id, name: trackFileName({ id, ...(meta.get(id) ?? sel.hints.get(id)) }), reason: opened.reason });
          continue;
        }
        const r = opened.r;
        const name = uniqueName(trackFileName({ id, ...(meta.get(id) ?? sel.hints.get(id)) }, {
          contentType: r.headers.get('content-type'), disposition: r.headers.get('content-disposition'),
        }), used);
        const len = Number(r.headers.get('content-length'));
        const lastModified = Date.parse(r.headers.get('last-modified') || '');
        try {
          await zip.add(name, r.body ? bodyOf(r) : [], {
            size: Number.isFinite(len) && len >= 0 && r.headers.has('content-length') ? len : null,
            mtime: Number.isFinite(lastModified) ? new Date(lastModified) : new Date(),
          });
        } finally {
          release();
        }
      }
    }
    if (missing.length) {
      const list = Buffer.from(missingListText(missing), 'utf8');
      await zip.add(MISSING_LIST_NAME, [list], { size: list.length });
    }
    await zip.finish();
    res.end();
  } catch {
    // Mid-entry: the archive cannot be closed validly. Drop the connection so
    // the browser marks the download failed instead of saving a short zip.
    client.abort();
    res.destroy();
  }
});
