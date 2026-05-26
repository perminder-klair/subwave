// One-shot library tagger.
// Walks the entire Navidrome library, sends batches of unseen tracks to the
// LLM for {moods, energy} classification, persists results in state/moods.json.
// Resumable — already-tagged tracks are skipped, so you can re-run any time.
//
// Run:  docker exec sub-wave-controller node src/music/tag-library.js
//   or  docker exec sub-wave-controller node src/music/tag-library.js --limit 100
//   or  docker exec sub-wave-controller node src/music/tag-library.js --batch 10
//
// Batched: one LLM call classifies ~20 tracks at a time. On any batch failure
// (schema mismatch, length mismatch, transport error) the buffer is replayed
// one track at a time via tagOne(), so a bad LLM response never loses tags.
//
// The single-track tagOne() primitive in tagger-core.ts is also reused by the
// inline retag route (controller/src/routes/library.ts → POST /library/retag).

import * as subsonic from './subsonic.js';
import * as library from './library.js';
import * as settings from '../settings.js';
import { config } from '../config.js';
import { loadSecretsIntoEnv } from '../setup/secrets.js';
import { loadSetupConfig } from '../setup/config.js';
import { activeModelLabel } from '../llm/provider.js';
import { tagOne, tagBatch, TaggableSong, TagResult } from './tagger-core.js';

// Mirrors server.ts boot: cloud API keys from secrets.env, Navidrome creds
// from setup-config.json. Standalone CLIs skip server.ts, so without this
// they fall back to the hardcoded `http://navidrome:4533` and ENOTFOUND on
// any install with a custom Navidrome host (issue #122).
async function applyWizardOverlay() {
  try {
    await loadSecretsIntoEnv();
  } catch (err: any) {
    console.error('[secrets] load failed:', err.message);
  }
  try {
    const sc = await loadSetupConfig();
    if (sc.navidrome) {
      if (!process.env.NAVIDROME_URL && sc.navidrome.url) config.navidrome.url = sc.navidrome.url;
      if (!process.env.NAVIDROME_USER && sc.navidrome.user) config.navidrome.user = sc.navidrome.user;
      if (!process.env.NAVIDROME_PASS && sc.navidrome.pass)
        config.navidrome.password = sc.navidrome.pass;
    }
  } catch (err: any) {
    console.error('[setup-config] load failed:', err.message);
  }
}

function parseIntFlag(args: string[], name: string): number | null {
  const idx = args.indexOf(name);
  if (idx < 0) return null;
  const n = parseInt(args[idx + 1], 10);
  return Number.isFinite(n) ? n : null;
}

async function main() {
  const args = process.argv.slice(2);
  const limit = parseIntFlag(args, '--limit') ?? Infinity;
  const batchRaw = parseIntFlag(args, '--batch') ?? 20;
  const BATCH_SIZE = Math.max(1, Math.min(50, batchRaw));

  await applyWizardOverlay();
  await library.load();
  await settings.load();
  console.log(`[tag] starting. ${library.allTaggedIds().length} tracks already tagged.`);
  console.log(`[tag] model: ${activeModelLabel()}`);
  console.log(`[tag] batch size: ${BATCH_SIZE}`);
  if (limit !== Infinity) console.log(`[tag] limit: ${limit} new tracks`);

  type BufferEntry = TaggableSong & { id: string };
  let processed = 0;
  let saved = 0;
  let failed = 0;
  const startedAt = Date.now();
  const SAVE_EVERY = 25;
  const buffer: BufferEntry[] = [];

  async function flushBuffer() {
    if (buffer.length === 0) return;
    const batch = buffer.splice(0, buffer.length);
    let results: TagResult[] | null = null;
    try {
      results = await tagBatch(batch);
    } catch (err: any) {
      console.error(`[tag] batch failed (${batch.length} tracks): ${err.message} — falling back to per-track`);
    }
    for (let i = 0; i < batch.length; i++) {
      const song = batch[i];
      try {
        const { moods, energy } = results ? results[i] : await tagOne(song);
        library.set(song.id, {
          title: song.title,
          artist: song.artist,
          album: song.album,
          year: song.year,
          genre: song.genre,
          moods,
          energy,
        });
        saved++;
        const tagStr = moods.length ? moods.join(', ') : '(none)';
        console.log(`[${saved}/${processed}] ${song.artist} — ${song.title} → ${tagStr} [${energy || '?'}]`);

        if (saved % SAVE_EVERY === 0) {
          await library.save();
          const elapsed = (Date.now() - startedAt) / 1000;
          const rate = saved / elapsed;
          console.log(`[tag] flushed. ${saved} new tags, ${(rate * 60).toFixed(1)}/min`);
        }
      } catch (err: any) {
        failed++;
        console.error(`[tag] FAIL ${song.id} (${song.title}): ${err.message}`);
      }
    }
  }

  for await (const song of subsonic.iterateAllSongs()) {
    processed++;
    if (library.has(song.id)) continue;
    if (saved + buffer.length >= limit) break;

    buffer.push({
      id: song.id,
      title: song.title,
      artist: song.artist,
      album: song.album,
      year: song.year,
      genre: song.genre,
    });

    if (buffer.length >= BATCH_SIZE) {
      await flushBuffer();
    }
  }
  await flushBuffer();

  await library.save();
  const elapsed = (Date.now() - startedAt) / 1000;
  console.log(`\n[tag] done in ${elapsed.toFixed(0)}s. saved=${saved} failed=${failed} processed=${processed}`);
  console.log('[stats]', JSON.stringify(library.stats(), null, 2));
}

main().catch(err => { console.error(err); process.exit(1); });
