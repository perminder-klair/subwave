#!/usr/bin/env node
// Bulk-pull license-clear (Creative Commons) tracks from the Jamendo v3 API.
//
// Downloads MP3s, embeds ID3 tags (so SUB/WAVE's library tagger + Observatory
// have genre/mood signal), lays them out as Artist/Album/Track for Navidrome,
// and emits an attribution file (CC-BY requires credit). Resumable: re-running
// skips anything already in _manifest.json. Standalone — imports nothing from
// the controller. See README.md.

import { mkdir, writeFile, readFile, rename, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import NodeID3 from 'node-id3';

const API = 'https://api.jamendo.com/v3.0/tracks/';
const REGISTER_URL = 'https://developer.jamendo.com/v3.0/apps';
const PAGE = 200; // Jamendo's max page size.

// --- license handling -------------------------------------------------------
// We filter client-side on license_ccurl rather than trusting server params, so
// nothing un-redistributable ever lands on disk. Map short aliases -> CC slug.
const LICENSE_SLUGS = {
  ccby: 'by',
  ccbysa: 'by-sa',
  ccbync: 'by-nc',
  ccbyncsa: 'by-nc-sa',
  ccbyncnd: 'by-nc-nd',
  ccbynd: 'by-nd',
  cc0: 'zero',
};

// Pull the license slug out of a Creative Commons URL.
// e.g. http://creativecommons.org/licenses/by-nc-nd/3.0/ -> "by-nc-nd"
//      http://creativecommons.org/publicdomain/zero/1.0/ -> "zero"
function slugFromCcUrl(url) {
  if (!url) return null;
  const m = url.match(/creativecommons\.org\/(?:licenses|publicdomain)\/([a-z-]+)\//i);
  return m ? m[1].toLowerCase() : null;
}

// --- arg / env parsing ------------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true; // boolean flag
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const clientId = process.env.JAMENDO_CLIENT_ID || args['client-id'];
if (!clientId) {
  console.error(
    'Missing Jamendo client_id.\n' +
      '  Register a free app at ' + REGISTER_URL + '\n' +
      '  then: JAMENDO_CLIENT_ID=xxxx node pull.mjs [options]'
  );
  process.exit(1);
}

const config = {
  out: args.out || './jamendo-music',
  limit: Number(args.limit || 2000),
  // Accepted CC licenses (aliases). NC / ND are fine for a non-commercial demo
  // that rebroadcasts the music unmodified.
  licenses: String(args.licenses || 'ccby,ccbysa,ccbync,ccbyncnd')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  tags: args.tags ? String(args.tags) : null,
  fuzzytags: args.fuzzytags ? String(args.fuzzytags) : null,
  order: args.order || 'popularity_total',
  concurrency: Math.max(1, Number(args.concurrency || 4)),
};

// Resolve requested aliases -> the set of CC slugs we'll accept.
const allowedSlugs = new Set(
  config.licenses.map((a) => LICENSE_SLUGS[a]).filter(Boolean)
);
if (allowedSlugs.size === 0) {
  console.error('No valid licenses in --licenses. Known: ' + Object.keys(LICENSE_SLUGS).join(', '));
  process.exit(1);
}

const MANIFEST = join(config.out, '_manifest.json');

// --- small utils ------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Make a path segment safe across filesystems; never empty.
function safe(name, fallback) {
  const cleaned = String(name ?? '')
    .replace(/[/\\:*?"<>|\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '') // no leading dots (hidden / traversal)
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

// Jamendo returns HTML-encoded text (e.g. "AC&#39;s Crew", "Funk &amp; Soul",
// "Beyonc&eacute;"). Decode entities once so names land clean in paths, ID3
// tags, and credits — otherwise they show up verbatim and the DJ reads them
// literally. Covers HTML4/Latin-1 named entities + decimal/hex numeric refs.
const NAMED_ENTITIES = {nbsp:160,iexcl:161,cent:162,pound:163,curren:164,yen:165,brvbar:166,sect:167,uml:168,copy:169,ordf:170,laquo:171,not:172,shy:173,reg:174,macr:175,deg:176,plusmn:177,sup2:178,sup3:179,acute:180,micro:181,para:182,middot:183,cedil:184,sup1:185,ordm:186,raquo:187,frac14:188,frac12:189,frac34:190,iquest:191,Agrave:192,Aacute:193,Acirc:194,Atilde:195,Auml:196,Aring:197,AElig:198,Ccedil:199,Egrave:200,Eacute:201,Ecirc:202,Euml:203,Igrave:204,Iacute:205,Icirc:206,Iuml:207,ETH:208,Ntilde:209,Ograve:210,Oacute:211,Ocirc:212,Otilde:213,Ouml:214,times:215,Oslash:216,Ugrave:217,Uacute:218,Ucirc:219,Uuml:220,Yacute:221,THORN:222,szlig:223,agrave:224,aacute:225,acirc:226,atilde:227,auml:228,aring:229,aelig:230,ccedil:231,egrave:232,eacute:233,ecirc:234,euml:235,igrave:236,iacute:237,icirc:238,iuml:239,eth:240,ntilde:241,ograve:242,oacute:243,ocirc:244,otilde:245,ouml:246,divide:247,oslash:248,ugrave:249,uacute:250,ucirc:251,uuml:252,yacute:253,thorn:254,yuml:255,amp:38,lt:60,gt:62,quot:34,apos:39,OElig:338,oelig:339,Scaron:352,scaron:353,Yuml:376,circ:710,tilde:732,ndash:8211,mdash:8212,lsquo:8216,rsquo:8217,sbquo:8218,ldquo:8220,rdquo:8221,bdquo:8222,dagger:8224,Dagger:8225,bull:8226,hellip:8230,permil:8240,lsaquo:8249,rsaquo:8250,euro:8364,trade:8482};
function decodeEntities(s) {
  if (s == null) return s;
  return String(s).replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    const code = NAMED_ENTITIES[e]; // named refs are case-sensitive (Aacute ≠ aacute)
    return code != null ? String.fromCodePoint(code) : m;
  });
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// fetch with retry/backoff for 429 + 5xx + transient network errors.
async function fetchWithRetry(url, { binary = false, tries = 5 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(30000, 1000 * 2 ** attempt);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return binary ? Buffer.from(await res.arrayBuffer()) : await res.json();
    } catch (err) {
      lastErr = err;
      await sleep(Math.min(30000, 1000 * 2 ** attempt));
    }
  }
  throw lastErr || new Error('fetch failed: ' + url);
}

// --- manifest / credits -----------------------------------------------------
// manifest: array of { id, name, artist, album, license_ccurl, file }
async function loadManifest() {
  try {
    const raw = await readFile(MANIFEST, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function writeManifestAndCredits(manifest) {
  await writeFile(MANIFEST, JSON.stringify(manifest, null, 2));

  // CREDITS.md — drop-in for a public attribution page.
  const lines = [
    '# Music credits',
    '',
    'All tracks are Creative Commons, sourced from [Jamendo](https://www.jamendo.com).',
    'Each entry links its license. Please keep this credit intact when redistributing.',
    '',
    '| Track | Artist | Album | License |',
    '| --- | --- | --- | --- |',
  ];
  for (const e of manifest) {
    const slug = slugFromCcUrl(e.license_ccurl) || 'cc';
    lines.push(
      `| ${mdCell(e.name)} | ${mdCell(e.artist)} | ${mdCell(e.album)} | [${slug}](${e.license_ccurl}) |`
    );
  }
  await writeFile(join(config.out, 'CREDITS.md'), lines.join('\n') + '\n');

  // credits.csv — same data, machine-readable.
  const csv = ['id,track,artist,album,license_url'];
  for (const e of manifest) {
    csv.push([e.id, e.name, e.artist, e.album, e.license_ccurl].map(csvCell).join(','));
  }
  await writeFile(join(config.out, 'credits.csv'), csv.join('\n') + '\n');
}

function mdCell(v) {
  return String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// --- download + tag a single track ------------------------------------------
const coverCache = new Map(); // album_id -> Buffer | null

async function getCover(track) {
  const key = track.album_id || track.id;
  if (coverCache.has(key)) return coverCache.get(key);
  const url = track.album_image || track.image;
  let buf = null;
  if (url) {
    try {
      buf = await fetchWithRetry(url, { binary: true });
    } catch {
      buf = null; // cover is best-effort
    }
  }
  coverCache.set(key, buf);
  return buf;
}

// Read the Jamendo id we stamped into a file's ID3, so a path collision can tell
// "same track, already pulled" (resume) from "different track, same name".
function existingTrackId(file) {
  try {
    const t = NodeID3.read(file);
    const f = (t.userDefinedText || []).find((x) => x.description === 'JAMENDO_ID');
    return f ? f.value : null;
  } catch {
    return null;
  }
}

async function downloadTrack(track) {
  const artist = safe(track.artist_name, 'Unknown Artist');
  const album = safe(track.album_name, 'Singles');
  const title = safe(track.name, 'Track ' + track.id);
  const pos = Number(track.position);
  const prefix = Number.isFinite(pos) && pos > 0 ? String(pos).padStart(2, '0') + ' - ' : '';

  const dir = join(config.out, artist, album);
  // Different tracks can sanitise to the same Artist/Album/NN-Title path; append
  // the Jamendo id on a genuine collision so neither track is silently dropped.
  let file = join(dir, prefix + title + '.mp3');
  if (existsSync(file) && String(existingTrackId(file)) !== String(track.id)) {
    file = join(dir, prefix + title + ' [' + track.id + '].mp3');
  }
  if (existsSync(file)) return { file, skipped: true };

  await mkdir(dir, { recursive: true });

  const audio = await fetchWithRetry(track.audiodownload, { binary: true });
  const part = file + '.part';
  await writeFile(part, audio);
  await rename(part, file);

  // Tag it. musicinfo.tags holds genres / instruments / vibes when we asked for
  // include=musicinfo. Flatten the lot into a TXXX frame so the SUB/WAVE tagger
  // has mood/genre signal even before its own pass.
  const mi = track.musicinfo?.tags || {};
  const allTags = [...(mi.genres || []), ...(mi.instruments || []), ...(mi.vibes || [])];
  const year = (track.releasedate || '').slice(0, 4);
  const cover = await getCover(track);

  const tags = {
    title: track.name || title,
    artist: track.artist_name || artist,
    album: track.album_name || album,
    ...(year && /^\d{4}$/.test(year) ? { year } : {}),
    ...(Number.isFinite(pos) && pos > 0 ? { trackNumber: String(pos) } : {}),
    ...(mi.genres?.length ? { genre: mi.genres[0] } : {}),
    comment: {
      language: 'eng',
      text: `License: ${slugFromCcUrl(track.license_ccurl) || 'cc'} ${track.license_ccurl} | jamendo:${track.id}`,
    },
    userDefinedText: [
      { description: 'JAMENDO_ID', value: String(track.id) },
      { description: 'LICENSE_URL', value: String(track.license_ccurl || '') },
      ...(allTags.length ? [{ description: 'TAGS', value: allTags.join(', ') }] : []),
    ],
    ...(cover ? { image: { mime: 'image/jpeg', type: { id: 3 }, description: 'Cover', imageBuffer: cover } } : {}),
  };

  NodeID3.write(tags, file); // synchronous, returns true/Error
  return { file, skipped: false };
}

// --- bounded-concurrency worker pool ----------------------------------------
async function runPool(items, worker, concurrency) {
  let i = 0;
  const runNext = async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runNext));
}

// --- main -------------------------------------------------------------------
async function main() {
  await mkdir(config.out, { recursive: true });

  const manifest = await loadManifest();
  const seen = new Set(manifest.map((e) => String(e.id)));
  console.log(
    `Jamendo pull → ${config.out}\n` +
      `  target: ${config.limit} tracks | licenses: ${[...allowedSlugs].join(', ')} | order: ${config.order}` +
      (config.tags ? ` | tags: ${config.tags}` : '') +
      (config.fuzzytags ? ` | fuzzytags: ${config.fuzzytags}` : '') +
      `\n  already have: ${seen.size}\n`
  );

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;
  let rejected = 0; // dropped by license / not downloadable
  let offset = 0;
  let sinceFlush = 0;

  // seen already counts pre-existing + everything pulled this run, so it alone
  // is "how many we have" — adding `downloaded` would double-count new tracks
  // and stop a multi-page pull at ~limit/2.
  while (seen.size < config.limit) {
    const url = new URL(API);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('format', 'json');
    url.searchParams.set('limit', String(PAGE));
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('audioformat', 'mp32');
    url.searchParams.set('include', 'musicinfo licenses');
    url.searchParams.set('order', config.order);
    if (config.tags) url.searchParams.set('tags', config.tags);
    if (config.fuzzytags) url.searchParams.set('fuzzytags', config.fuzzytags);

    let body;
    try {
      body = await fetchWithRetry(url.toString());
    } catch (err) {
      console.error('Page fetch failed at offset ' + offset + ': ' + err.message);
      break;
    }

    if (body?.headers?.status && body.headers.status !== 'success') {
      console.error('Jamendo API error: ' + (body.headers.error_message || body.headers.code));
      break;
    }

    const results = body?.results || [];
    if (results.length === 0) {
      console.log('No more results from Jamendo.');
      break;
    }

    // Decode HTML entities once, up front, so paths / tags / credits are all clean.
    for (const t of results) {
      t.name = decodeEntities(t.name);
      t.artist_name = decodeEntities(t.artist_name);
      t.album_name = decodeEntities(t.album_name);
      const mi = t.musicinfo?.tags;
      if (mi) {
        if (mi.genres) mi.genres = mi.genres.map(decodeEntities);
        if (mi.instruments) mi.instruments = mi.instruments.map(decodeEntities);
        if (mi.vibes) mi.vibes = mi.vibes.map(decodeEntities);
      }
    }

    // Keep only redistributable, downloadable tracks we don't already have.
    const eligible = results.filter((t) => {
      if (seen.has(String(t.id))) return false;
      if (!t.audiodownload || t.audiodownload_allowed !== true) {
        rejected++;
        return false;
      }
      const slug = slugFromCcUrl(t.license_ccurl);
      if (!slug || !allowedSlugs.has(slug)) {
        rejected++;
        return false;
      }
      return true;
    });

    // Respect the overall target within this page.
    const room = config.limit - seen.size;
    const batch = eligible.slice(0, Math.max(0, room));

    await runPool(
      batch,
      async (track) => {
        try {
          const { file, skipped: wasSkipped } = await downloadTrack(track);
          if (wasSkipped) {
            skipped++;
          } else {
            downloaded++;
            sinceFlush++;
          }
          seen.add(String(track.id));
          manifest.push({
            id: track.id,
            name: track.name,
            artist: track.artist_name,
            album: track.album_name,
            license_ccurl: track.license_ccurl,
            file,
          });
        } catch (err) {
          failed++;
          console.error('  ✗ ' + (track.name || track.id) + ': ' + err.message);
        }
      },
      config.concurrency
    );

    // Periodically persist so a long run is crash-safe / resumable.
    if (sinceFlush >= 50) {
      await writeManifestAndCredits(manifest);
      sinceFlush = 0;
    }

    console.log(
      `offset ${offset}: +${batch.length} eligible | total downloaded ${downloaded}, ` +
        `skipped ${skipped}, failed ${failed}, rejected ${rejected}`
    );

    offset += PAGE;
  }

  await writeManifestAndCredits(manifest);

  console.log(
    `\nDone. downloaded ${downloaded}, skipped ${skipped}, failed ${failed}, rejected ${rejected}.\n` +
      `  Library: ${config.out}\n` +
      `  Credits: ${join(config.out, 'CREDITS.md')} (and credits.csv)\n` +
      `  Next: rsync/copy the library onto the Navidrome host and trigger a scan.`
  );
}

main().catch((err) => {
  console.error('Fatal: ' + (err?.stack || err));
  process.exit(1);
});
