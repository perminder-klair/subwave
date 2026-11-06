import { queue } from './queue.js';
import { currentTalkAir } from './talk-air.js';
import * as settings from '../settings.js';
import { ttsCalls, summarizeTtsRates } from '../stats.js';
import { recentCalls } from '../llm/log.js';
import { planSpeechBudget, type SpeechBudget } from './speech-budget.js';

/** Capture immediately before writing. A next-boundary segment speaks over a
 * different track, so the outgoing clock is deliberately not its speech budget. */
export function captureSpeechBudget(
  cast: readonly { name?: string }[],
  maxWords = 140,
): SpeechBudget | null {
  if (currentTalkAir() === 'next-track') return null;
  const current = queue.current,
    remaining = queue.remainingSecOnAir();
  if (!current?.track?.id || !current.startedAt || remaining == null || !Number.isFinite(remaining))
    return null;
  const overall = summarizeTtsRates(ttsCalls);
  const profile = cast.map(persona =>
    summarizeTtsRates(ttsCalls.filter(call => call.persona === persona.name)),
  );
  const generation = profile.map(rate =>
    rate.samples >= 5
      ? rate.generationWordsPerSecond!
      : overall.samples >= 5
        ? overall.generationWordsPerSecond!
        : 3,
  );
  const spoken = profile.map(rate =>
    rate.audioSamples >= 5
      ? rate.spokenWordsPerSecond!
      : overall.audioSamples >= 5
        ? overall.spokenWordsPerSecond!
        : 2.3,
  );
  const writing = recentCalls
    .filter(
      call =>
        call.ok &&
        ['generateSleeveNotesSegment', 'generateBanter'].includes(call.kind) &&
        Number.isFinite(call.ms) &&
        call.ms > 0,
    )
    .slice(0, 20)
    .map(call => call.ms / 1000)
    .sort((a, b) => a - b);
  return planSpeechBudget({
    nowMs: Date.now(),
    remainingSeconds: remaining,
    crossfadeSeconds: Number(current.track.crossSec ?? settings.get().crossfadeDuration) || 0,
    writingSeconds: writing.length
      ? writing[Math.min(writing.length - 1, Math.floor(writing.length * 0.95))]
      : 5,
    generationWps: generation.length
      ? Math.min(...generation)
      : overall.samples >= 5
        ? overall.generationWordsPerSecond
        : null,
    spokenWps: spoken.length
      ? Math.min(...spoken)
      : overall.audioSamples >= 5
        ? overall.spokenWordsPerSecond
        : null,
    castSize: cast.length,
    maxWords,
    trackId: current.track.id,
    startedAt: current.startedAt,
  });
}
