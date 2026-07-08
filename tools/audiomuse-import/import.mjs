#!/usr/bin/env node
// Import pre-computed analysis from an AudioMuse-AI instance into SUB/WAVE's
// library.db, so a user who already tagged their library in AudioMuse can skip
// SUB/WAVE's slow LLM tagging + BPM/key pass.
//
// Standalone — imports nothing from the controller. It talks only to AudioMuse
// over HTTP (GET /api/sync) and to state/library.db over SQLite. Because
// AudioMuse keys everything by the media-server track id, and SUB/WAVE's
// tracks.id IS the Navidrome/Subsonic song id, the join is exact and needs no
// Navidrome auth. See README.md.
//
// What it imports:  tempo -> bpm, key+scale -> Camelot musical_key,
//                   energy -> low/medium/high, mood_vector/other_features ->
//                   SUB/WAVE moods (static map), top genre tag -> genre.
// What it does NOT: CLAP/MusiCNN embeddings (different vector space), and it
//                   deliberately leaves analysis_version NULL so a later
//                   `npm run analyze` still adds outro/structure/embeddings.

import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { mapTrack } from './map.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Column-set version this tool writes against; matches TAGGER_VERSION in
// controller/src/music/library-db.ts (imported moods count as current tags so
// `npm run tag` won't redo them). MIN_USER_VERSION is the earliest schema that
// has every column we write: moods/energy/source/tagger_version/tagged_at land
// in v1, bpm/musical_key in v2 — so v2 is the floor. (We intentionally do NOT
// touch v11 audio_moods or v12 outro_json.) Below the floor we refuse and tell
// the user to boot the controller once to migrate.
const TAGGER_VERSION = 3;
const MIN_USER_VERSION = 2;

// --- args -------------------------------------------------------------------
function parseArgs(argv) {
  const args = { concurrency: 8, moodCutoff: 0.4 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--audiomuse-url') args.audiomuseUrl = next();
    else if (a === '--library-db') args.libraryDb = next();
    else if (a === '--concurrency') args.concurrency = Math.max(1, Number(next()) || 8);
    else if (a === '--limit') args.limit = Number(next()) || undefined;
    else if (a === '--mood-cutoff') {
      // Guard NaN/out-of-range the way --concurrency/--limit already do — an
      // unparseable value must not silently disable mood filtering (score < NaN
      // is always false, so every tag would pass). #934 review.
      const mc = Number(next());
      args.moodCutoff = Number.isFinite(mc) ? Math.min(1, Math.max(0, mc)) : 0.4;
    }
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--overwrite') args.overwrite = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else {
      console.error(`Unknown argument: ${a}`);
      args.badArg = true;
    }
  }
  return args;
}

const HELP = `audiomuse-import — import AudioMuse-AI analysis into SUB/WAVE's library.db

Usage:
  AUDIOMUSE_URL=http://audiomuse:8000 node import.mjs [options]

Options:
  --audiomuse-url <url>   AudioMuse base URL (or AUDIOMUSE_URL env). Required.
  --library-db <path>     Path to library.db (default: <STATE_DIR>/library.db
                          or ../../state/library.db).
  --overwrite             Overwrite existing bpm/moods/key/energy (default:
                          fill only empty fields, never clobber SUB/WAVE's own).
  --dry-run               Map and report, write nothing.
  --concurrency <n>       Reserved; paging is currently sequential.
  --mood-cutoff <0..1>    Min tag score to count a mood (default 0.4).
  --limit <n>             Stop after N AudioMuse tracks (testing).
  -h, --help              This help.
`;

// --- AudioMuse /api/sync paging --------------------------------------------
async function* iterateAudioMuseTracks(baseUrl, { limit } = {}) {
  const root = baseUrl.replace(/\/+$/, '');
  let page = 1;
  let seen = 0;
  let providerChecked = false;
  while (true) {
    const url = `${root}/api/sync?page=${page}&limit=500&include_embeddings=false`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
    }
    // A proxy/login page can answer 200 with HTML, and a wrong-endpoint 200 can
    // return JSON with no `tracks` array — parse defensively so either is a clear
    // message, not a raw SyntaxError or a silent zero-track "success". #934 review.
    let body;
    try {
      body = await res.json();
    } catch {
      throw new Error(
        `GET ${url} returned ${res.status} but the body was not JSON — is ${root} ` +
          `an AudioMuse API? (a proxy or login page can answer 200 with HTML.)`,
      );
    }
    if (!body || !Array.isArray(body.tracks)) {
      const shape = body && typeof body === 'object'
        ? `keys: ${Object.keys(body).join(', ') || 'none'}`
        : `type: ${typeof body}`;
      throw new Error(
        `GET ${url} returned JSON with no "tracks" array (${shape}). ` +
          `Check the AudioMuse URL and that /api/sync is available.`,
      );
    }
    if (!providerChecked) {
      providerChecked = true;
      if (body.provider_type && body.provider_type.toLowerCase() !== 'navidrome') {
        throw new Error(
          `AudioMuse is configured for '${body.provider_type}', not navidrome. ` +
            `Its item ids won't match SUB/WAVE's Subsonic ids, so the import can't join. ` +
            `Point AudioMuse at the same Navidrome SUB/WAVE uses.`,
        );
      }
    }
    const tracks = body.tracks;
    for (const t of tracks) {
      if (limit && seen >= limit) return;
      seen++;
      yield t;
    }
    if (!body.has_more || (limit && seen >= limit)) return;
    page = body.next_page || page + 1;
  }
}

// --- library.db writes ------------------------------------------------------
function makeWriter(db) {
  const selectStmt = db.prepare(
    `SELECT bpm, musical_key, moods FROM tracks WHERE id = ?`,
  );
  const insertStmt = db.prepare(
    `INSERT INTO tracks (id, title, artist, album, year, genre, bpm, musical_key,
        moods, energy, source, tagger_version, tagged_at)
     VALUES (@id, @title, @artist, @album, @year, @genre, @bpm, @musicalKey,
        @moods, @energy, 'manual', @taggerVersion, @now)`,
  );

  return function writeTrack(id, meta, mapped, { overwrite }) {
    const existing = selectStmt.get(id);
    const now = new Date().toISOString();
    const moodsJson = mapped.moods.length ? JSON.stringify(mapped.moods) : null;

    if (!existing) {
      insertStmt.run({
        id,
        title: meta.title ?? null,
        artist: meta.artist ?? null,
        album: meta.album ?? null,
        year: Number.isFinite(meta.year) ? meta.year : null,
        genre: mapped.genre ?? null,
        bpm: mapped.bpm,
        musicalKey: mapped.musicalKey,
        moods: moodsJson,
        energy: mapped.energy,
        taggerVersion: moodsJson ? TAGGER_VERSION : null,
        now,
      });
      return moodsJson || mapped.bpm != null ? 'inserted' : 'inserted-empty';
    }

    // Existing row: fill gaps unless --overwrite. Build a targeted UPDATE.
    const sets = [];
    const params = { id };
    const wantBpm = overwrite || existing.bpm == null;
    const wantKey = overwrite || existing.musical_key == null;
    const wantMoods = overwrite || existing.moods == null;

    if (wantBpm && mapped.bpm != null) {
      sets.push('bpm = @bpm');
      params.bpm = mapped.bpm;
    }
    if (wantKey && mapped.musicalKey != null) {
      sets.push('musical_key = @musicalKey');
      params.musicalKey = mapped.musicalKey;
    }
    if (wantMoods && moodsJson) {
      sets.push('moods = @moods', "source = 'manual'",
        'tagger_version = @taggerVersion', 'tagged_at = @now');
      params.moods = moodsJson;
      params.taggerVersion = TAGGER_VERSION;
      params.now = now;
      // Energy rides with the mood write, but only when AudioMuse actually gave
      // one — the existence SELECT doesn't read energy, so writing a null mapped
      // energy here would clobber an energy SUB/WAVE already computed. #934 review.
      if (mapped.energy != null) {
        sets.push('energy = @energy');
        params.energy = mapped.energy;
      }
    }
    // Genre only fills a truly empty genre.
    if (mapped.genre != null) {
      sets.push('genre = COALESCE(genre, @genre)');
      params.genre = mapped.genre;
    }

    if (!sets.length) return 'skipped';
    db.prepare(`UPDATE tracks SET ${sets.join(', ')} WHERE id = @id`).run(params);
    return 'updated';
  };
}

// --- main -------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.badArg) {
    console.log(HELP);
    process.exit(args.badArg ? 2 : 0);
  }

  const audiomuseUrl = args.audiomuseUrl || process.env.AUDIOMUSE_URL;
  if (!audiomuseUrl) {
    console.error('Missing AudioMuse URL. Pass --audiomuse-url or set AUDIOMUSE_URL.\n');
    console.log(HELP);
    process.exit(1);
  }

  const stateDir = process.env.STATE_DIR || resolve(__dirname, '../../state');
  const dbPath = args.libraryDb || resolve(stateDir, 'library.db');
  if (!existsSync(dbPath)) {
    console.error(
      `library.db not found at ${dbPath}. Start the SUB/WAVE controller once ` +
        `(or run \`npm run analyze\`) to create it, or pass --library-db.`,
    );
    process.exit(1);
  }

  const db = new Database(dbPath);
  db.pragma('busy_timeout = 5000');
  const userVersion = db.pragma('user_version', { simple: true }) || 0;
  if (userVersion < MIN_USER_VERSION) {
    console.error(
      `library.db schema is v${userVersion}, need >= v${MIN_USER_VERSION}. ` +
        `Boot the SUB/WAVE controller once to run migrations, then re-run.`,
    );
    db.close();
    process.exit(1);
  }

  console.log(`AudioMuse: ${audiomuseUrl}`);
  console.log(`library.db: ${dbPath} (schema v${userVersion})`);
  console.log(args.overwrite ? 'Mode: OVERWRITE existing fields' : 'Mode: fill gaps only');
  if (args.dryRun) console.log('Mode: DRY RUN (no writes)');
  console.log('');

  const writeTrack = makeWriter(db);
  const counts = { seen: 0, inserted: 0, updated: 0, skipped: 0, noSignal: 0 };
  const samples = [];

  const commit = db.transaction((batch) => {
    for (const t of batch) {
      const mapped = mapTrack(t, { moodCutoff: args.moodCutoff });
      const hasSignal = mapped.bpm != null || mapped.moods.length || mapped.musicalKey != null;
      if (!hasSignal) {
        counts.noSignal++;
        continue;
      }
      if (samples.length < 5) {
        samples.push({ title: t.title, artist: t.author, ...mapped });
      }
      if (args.dryRun) continue;
      const outcome = writeTrack(t.id, { title: t.title, artist: t.author, album: t.album, year: t.year }, mapped, { overwrite: args.overwrite });
      if (outcome === 'inserted' || outcome === 'inserted-empty') counts.inserted++;
      else if (outcome === 'updated') counts.updated++;
      else counts.skipped++;
    }
  });

  // Buffer pages and commit in batches for a fast single transaction per chunk.
  let batch = [];
  const BATCH = 500;
  for await (const t of iterateAudioMuseTracks(audiomuseUrl, { limit: args.limit })) {
    counts.seen++;
    batch.push(t);
    if (batch.length >= BATCH) {
      commit(batch);
      batch = [];
      process.stdout.write(`\r  processed ${counts.seen} tracks…`);
    }
  }
  if (batch.length) commit(batch);
  process.stdout.write('\r');

  db.close();

  console.log('Sample mappings:');
  for (const s of samples) {
    console.log(
      `  ${s.artist ?? '?'} — ${s.title ?? '?'}: bpm=${s.bpm ?? '—'} key=${s.musicalKey ?? '—'} ` +
        `energy=${s.energy ?? '—'} moods=[${s.moods.join(', ')}] genre=${s.genre ?? '—'}`,
    );
  }
  console.log('');
  console.log(`AudioMuse tracks read:  ${counts.seen}`);
  console.log(`  no usable signal:     ${counts.noSignal}`);
  if (args.dryRun) {
    console.log('(dry run — nothing written)');
  } else {
    console.log(`  rows inserted:        ${counts.inserted}`);
    console.log(`  rows updated:         ${counts.updated}`);
    console.log(`  left untouched:       ${counts.skipped}`);
  }
  console.log('');
  console.log(
    'Done. This imported moods/bpm/key only — embeddings and ending-aware\n' +
      'transition data are NOT included. Run `npm run analyze` in the controller\n' +
      '(heavy tier for sonic search) to add outro/structure/CLAP embeddings.',
  );
}

main().catch((err) => {
  console.error(`\nImport failed: ${err.message}`);
  process.exit(1);
});
