// The admin's preview player (Library rows): a library track played in the
// operator's own browser, never on air. Two routes:
//
// - `POST /library/:id/preview` (admin) answers a short-lived link to the
//   audio. An <audio> element cannot send the console's Basic header, so the
//   link carries its own proof: an HMAC over the track id and an expiry, keyed
//   by a per-process secret (util/signed-link.ts: never derived from
//   ADMIN_PASS, and a restart voids every link). A link
//   names one track and lapses after PREVIEW_TTL_SEC, so leaking one (a log,
//   a history entry) exposes that track's audio for a few hours, nothing else.
// - `GET /library/preview/:id?exp=&sig=` streams it from Navidrome through
//   the Subsonic client's own credentials (format=raw: the original file, so
//   the browser seeks with Range on real bytes), forwarding Range and the
//   headers a media element needs to seek. Nothing is buffered: the body is
//   piped, and the upstream request ends when the browser goes away.
//
// Subsonic `stream` does not scrobble (only `scrobble` does), so a preview
// moves no play count the smart playlists read. The blocklist governs airplay,
// not the operator's own ears: a never-play track still previews.
import express from 'express';
import { Readable } from 'node:stream';
import { requireAdmin } from '../../middleware/auth.js';
import * as subsonic from '../../music/subsonic.js';
import { recordHttpAttempt } from '../../music/subsonic-log.js';
import { signedLinkValid, signedQuery } from '../../util/signed-link.js';

export const router = express.Router();

export const PREVIEW_TTL_SEC = 6 * 3600;
// Navidrome's answer must start within this; the body then streams for as long
// as the listener keeps it.
const UPSTREAM_HEADERS_TIMEOUT_MS = 15_000;
// Subsonic ids are short alphanumerics; anything else would make the proxy an
// SSRF surface (the same rule as /cover/:id).
export const ID_RE = /^[\w-]{1,64}$/;

// The signing rule is util/signed-link.ts, shared with the Library download.
export function previewPath(id: string, nowMs = Date.now()): string {
  return `/library/preview/${encodeURIComponent(id)}?${signedQuery('preview', id, PREVIEW_TTL_SEC, nowMs)}`;
}

export function previewLinkValid(id: string, exp: unknown, sig: unknown, nowMs = Date.now()): boolean {
  return signedLinkValid('preview', id, exp, sig, nowMs);
}

router.post('/library/:id/preview', requireAdmin, (req, res) => {
  const { id } = req.params;
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'bad track id' });
  res.json({ path: previewPath(id), expiresInSec: PREVIEW_TTL_SEC });
});

// What a media element needs back to play and seek.
const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];

router.get('/library/preview/:id', async (req, res) => {
  const { id } = req.params;
  if (!ID_RE.test(id)) return res.status(400).end();
  if (!previewLinkValid(id, req.query.exp, req.query.sig)) return res.status(403).end();

  const upstream = new AbortController();
  const headersTimer = setTimeout(() => upstream.abort(), UPSTREAM_HEADERS_TIMEOUT_MS);
  res.on('close', () => upstream.abort());
  try {
    recordHttpAttempt('stream', 'admin-preview');
    const headers: Record<string, string> = {};
    if (typeof req.headers.range === 'string') headers.Range = req.headers.range;
    const r = await fetch(subsonic.getRawStreamUrl(id), { headers, signal: upstream.signal });
    clearTimeout(headersTimer);
    const type = r.headers.get('content-type') || '';
    // A Subsonic error comes back as a 200 JSON/XML document, not audio.
    if (!r.ok && r.status !== 416) return res.status(r.status === 404 ? 404 : 502).end();
    if (/json|xml/i.test(type)) return res.status(404).end();
    res.status(r.status);
    for (const h of PASS_HEADERS) {
      const v = r.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    // The link is a private capability: never cache it in a shared cache.
    res.setHeader('Cache-Control', 'private, max-age=0, no-store');
    if (!r.body) return res.end();
    const body = Readable.fromWeb(r.body as import('node:stream/web').ReadableStream);
    body.on('error', () => res.destroy());
    body.pipe(res);
  } catch {
    clearTimeout(headersTimer);
    if (!res.headersSent) res.status(502).end();
    else res.destroy();
  }
});
