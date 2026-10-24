// Independent library language pass. It is intentionally separate from mood
// tagging: a fully mood-tagged library can still have unresolved languages,
// and language tags never feed the existing mood embedding graph.

import * as db from '../library-db.js';
import * as subsonic from '../subsonic.js';
import * as musicbrainz from '../musicbrainz.js';
import * as settings from '../../settings.js';
import { reportProgress } from '../tagger-progress.js';
import { logEvent } from './log.js';
import {
  detectLocalLanguage,
  detectWithAi,
  languageFromLyricsTag,
  sampleLyrics,
  unknownLanguage,
  LANGUAGE_BATCH_MAX,
  LANGUAGE_TAG_CONTRACT_VERSION,
  type LanguageDecision,
} from '../language-tagger.js';

interface PendingAi { id: string; sample: string }

function write(id: string, decision: LanguageDecision): void {
  db.upsertTrackLanguage(id, {
    ...decision,
    contractVersion: LANGUAGE_TAG_CONTRACT_VERSION,
    model: decision.model ?? null,
  });
}

export async function phaseLanguage(ids: string[], retry: boolean): Promise<void> {
  if (!ids.length) {
    logEvent('info', retry
      ? 'Language tagging skipped — no automatic language results need re-checking'
      : 'Language tagging skipped — all tracks already have language results');
    return;
  }
  if (retry) musicbrainz.clearLanguageCache();
  const enrichCfg = (settings.get() as any).embedding?.enrichment ?? {};
  const mbEnabled = enrichCfg.musicBrainzLanguage !== false;
  const lyricsEnabled = enrichCfg.lyrics !== false;
  const aiEnabled = enrichCfg.languageAiFallback !== false;
  const pending: PendingAi[] = [];
  let completed = 0;
  let automatic = 0;
  let aiTagged = 0;
  let unknown = 0;

  logEvent(
    'info',
    `Detecting languages for ${ids.length.toLocaleString('en-GB')} tracks ` +
      `(lyrics/local evidence → MusicBrainz → ${aiEnabled ? 'AI fallback' : 'no AI fallback'})${retry ? ' · re-checking automatic results' : ''}`,
  );
  reportProgress({ phase: 'language', label: 'Tagging languages', done: 0, total: ids.length });

  const reportLanguageProgress = () => {
    console.log(
      `[tag] language-tagged ${completed}/${ids.length} ` +
        `(automatic: ${automatic}, AI: ${aiTagged}, unknown: ${unknown})`,
    );
    reportProgress({ phase: 'language', label: 'Tagging languages', done: completed, total: ids.length });
  };
  for (const id of ids) {
    const track = db.getTrack(id);
    if (!track) {
      completed += 1;
      if (completed % 25 === 0) reportLanguageProgress();
      continue;
    }
    let evidence: { text: string; taggedLanguage: string | null } | null = null;
    // The enrichment phase already fetched and persisted the lyric excerpt.
    // Reuse it on the normal pipeline pass, but refresh the evidence seam when
    // an enriched row has no provider language metadata yet.
    if (lyricsEnabled && (!track.enrichedAt || !track.lyricLanguage)) {
      try { evidence = await subsonic.getLyricsEvidence(id); } catch { /* best effort */ }
    }
    const sample = sampleLyrics(track.lyricExcerpt ?? evidence?.text);
    let decision = languageFromLyricsTag(track.lyricLanguage ?? evidence?.taggedLanguage);
    if (!decision) decision = detectLocalLanguage(sample);
    if (decision && decision.confidence !== 'review') {
      write(id, decision);
      automatic += 1;
    } else {
      if (mbEnabled && track.musicBrainzId) {
        const codes = await musicbrainz.lookupLanguagesByRecordingMbid(track.musicBrainzId);
        if (codes.length) {
          write(id, {
            primaryLanguage: codes[0] ?? null,
            languages: codes,
            mode: codes.length > 1 ? 'mixed' : 'single',
            source: 'musicbrainz',
            confidence: 'high',
          });
          automatic += 1;
          completed += 1;
          if (completed % 25 === 0) reportLanguageProgress();
          continue;
        }
      }
      if (aiEnabled && sample.length >= 80) {
        pending.push({ id, sample });
        continue;
      } else {
        // A review-level local guess is not reliable enough to expose as a
        // language filter or request constraint. Keep it unknown when there is
        // no exact MusicBrainz evidence and no AI fallback available.
        write(id, decision && decision.confidence !== 'review' ? decision : unknownLanguage('local'));
        unknown += 1;
      }
    }
    completed += 1;
    if (completed % 25 === 0) reportLanguageProgress();
  }

  for (let i = 0; i < pending.length; i += LANGUAGE_BATCH_MAX) {
    const batch = pending.slice(i, i + LANGUAGE_BATCH_MAX);
    try {
      const decisions = await detectWithAi(batch.map(x => x.sample));
      decisions.forEach((decision, index) => {
        const item = batch[index];
        if (!item) return;
        write(item.id, decision);
        if (decision.mode === 'unknown') unknown += 1; else aiTagged += 1;
      });
    } catch (err: any) {
      logEvent('warning', `Language AI fallback failed for ${batch.length} track(s): ${err?.message || err}`);
      // Clear the checked timestamp. A provider outage is not evidence of an
      // unknown language and must remain retryable on the next normal run
      // rather than hiding a whole batch permanently.
      batch.forEach(item => db.deferAutomaticTrackLanguage(item.id));
    }
    completed += batch.length;
    reportLanguageProgress();
  }
  if (completed !== ids.length) {
    completed = ids.length;
    reportLanguageProgress();
  }
  logEvent('info', `Language tags checked for ${ids.length.toLocaleString('en-GB')} tracks (${automatic} automatic, ${aiTagged} AI, ${unknown} unknown)`);
}
