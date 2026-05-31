// Standalone acoustic-analysis CLI — `npm run analyze [-- --limit N]`.
//
// Runs ONLY the analysis pass (bpm / key / intro), independent of mood
// tagging. The same pass also runs as a final phase of `npm run tag`
// (music/tag-library.ts); this entry point is for re-running analysis without
// re-tagging, or for an operator who wants to analyse before tagging.
//
// Flags:
//   --limit N      cap tracks analysed this run (default: all that need it)
//   --re-analyze   drop existing analysis and redo everything
//   --skip-walk    don't refresh track metadata from Navidrome first
//
// The heavy DSP lives in music/analyzer.ts's backend (tts-heavy sidecar or a
// local librosa venv via ANALYZE_PYTHON). With no backend the pass is a no-op.

import * as subsonic from './subsonic.js';
import * as db from './library-db.js';
import * as settings from '../settings.js';
import * as embeddings from './embeddings.js';
import { config } from '../config.js';
import { loadSecretsIntoEnv } from '../setup/secrets.js';
import { loadSetupConfig } from '../setup/config.js';
import { runAnalysisPass } from './analyze.js';
import * as analyzer from './analyzer.js';

function parseIntFlag(args: string[], name: string): number | undefined {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  const n = parseInt(args[idx + 1], 10);
  return Number.isFinite(n) ? n : undefined;
}

// Mirror of tag-library.ts applyWizardOverlay — env wins, setup-config fills gaps.
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
      if (!process.env.NAVIDROME_PASS && sc.navidrome.pass) config.navidrome.password = sc.navidrome.pass;
    }
  } catch (err: any) {
    console.error('[setup-config] load failed:', err.message);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const limit = parseIntFlag(args, '--limit');
  const reAnalyze = args.includes('--re-analyze');
  const skipWalk = args.includes('--skip-walk');

  await applyWizardOverlay();
  await settings.load();
  const embeddingDim = embeddings.resolveEmbeddingDim();
  await db.open({ embeddingDim });

  if (!skipWalk) {
    console.log('[analyze] walking Navidrome to refresh track metadata...');
    let walked = 0;
    for await (const song of subsonic.iterateAllSongs()) {
      db.upsertTrackMeta(song.id, {
        title: song.title,
        artist: song.artist,
        album: song.album,
        year: song.year,
        genre: song.genre,
        duration: song.duration,
      });
      walked += 1;
      if (walked % 500 === 0) console.log(`[analyze] walked ${walked} tracks`);
    }
    console.log(`[analyze] walked ${walked} total tracks`);
  }

  const stats = await runAnalysisPass({ limit, reAnalyze });
  analyzer.shutdown();
  console.log('[analyze] stats:', JSON.stringify(stats));
  process.exit(stats.available ? 0 : 0);
}

main().catch((err) => {
  console.error('[analyze] fatal:', err);
  process.exit(1);
});
