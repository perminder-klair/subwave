// One-shot library tagger.
// Walks the entire Navidrome library, sends each unseen track to the LLM for
// {moods, energy} classification, persists results in state/moods.json.
// Resumable — already-tagged tracks are skipped, so you can re-run any time.
//
// Run:  docker exec sub-wave-controller node src/music/tag-library.js
//   or  docker exec sub-wave-controller node src/music/tag-library.js --limit 100
//
// Per-track classification lives in tagger-core.ts so the inline retag route
// (controller/src/routes/library.ts → POST /library/retag) can reuse it.

import * as subsonic from './subsonic.js';
import * as library from './library.js';
import * as settings from '../settings.js';
import { config } from '../config.js';
import { loadSecretsIntoEnv } from '../setup/secrets.js';
import { loadSetupConfig } from '../setup/config.js';
import { activeModelLabel } from '../llm/provider.js';
import { tagOne } from './tagger-core.js';

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

async function main() {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : Infinity;

  await applyWizardOverlay();
  await library.load();
  await settings.load();
  console.log(`[tag] starting. ${library.allTaggedIds().length} tracks already tagged.`);
  console.log(`[tag] model: ${activeModelLabel()}`);
  if (limit !== Infinity) console.log(`[tag] limit: ${limit} new tracks`);

  let processed = 0;
  let saved = 0;
  let failed = 0;
  const startedAt = Date.now();
  const SAVE_EVERY = 25;

  for await (const song of subsonic.iterateAllSongs()) {
    processed++;
    if (library.has(song.id)) continue;
    if (saved >= limit) break;

    try {
      const { moods, energy } = await tagOne(song);
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
    } catch (err) {
      failed++;
      console.error(`[tag] FAIL ${song.id} (${song.title}): ${err.message}`);
    }
  }

  await library.save();
  const elapsed = (Date.now() - startedAt) / 1000;
  console.log(`\n[tag] done in ${elapsed.toFixed(0)}s. saved=${saved} failed=${failed} processed=${processed}`);
  console.log('[stats]', JSON.stringify(library.stats(), null, 2));
}

main().catch(err => { console.error(err); process.exit(1); });
