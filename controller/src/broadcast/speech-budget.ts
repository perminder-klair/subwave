// Operational timing only; never a factual or editorial assessment.
export interface SpeechDeadline {
  finishByMs: number;
  trackId: string;
  startedAt: string;
}
export interface SpeechBudget extends SpeechDeadline {
  maxWords: number;
  minWords: number;
  generationWps: number;
  spokenWps: number;
}
export const SPEECH_BUFFER_SECONDS = 8;
export const SPEECH_LINE_OVERHEAD_SECONDS = 2;
const positive = (value: number | null | undefined, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;

export function planSpeechBudget(input: {
  nowMs: number;
  remainingSeconds: number;
  crossfadeSeconds: number;
  writingSeconds: number;
  generationWps: number | null;
  spokenWps: number | null;
  castSize: number;
  maxWords: number;
  trackId: string;
  startedAt: string;
}): SpeechBudget {
  const generationWps = positive(input.generationWps, 3),
    spokenWps = positive(input.spokenWps, 2.3);
  const finishByMs =
    input.nowMs +
    (input.remainingSeconds - Math.max(0, input.crossfadeSeconds) - SPEECH_BUFFER_SECONDS) * 1000;
  const lines = input.castSize > 1 ? input.castSize + 1 : 1;
  const available =
    (finishByMs - input.nowMs) / 1000 -
    Math.max(5, input.writingSeconds) -
    lines * SPEECH_LINE_OVERHEAD_SECONDS;
  const maxWords = Math.max(
    0,
    Math.min(input.maxWords, Math.floor(available / (1 / generationWps + 1 / spokenWps))),
  );
  return {
    finishByMs,
    trackId: input.trackId,
    startedAt: input.startedAt,
    maxWords,
    minWords: input.castSize > 1 ? Math.max(24, input.castSize * 8) : 12,
    generationWps,
    spokenWps,
  };
}

export function fitsSpeechBudget(
  budget: SpeechBudget,
  words: number,
  lines: number,
  nowMs = Date.now(),
): boolean {
  return (
    words / budget.generationWps +
      words / budget.spokenWps +
      lines * SPEECH_LINE_OVERHEAD_SECONDS <=
    (budget.finishByMs - nowMs) / 1000
  );
}

export function speechBudgetPrompt(budget: SpeechBudget): string {
  const lower = Math.max(budget.minWords, Math.floor(budget.maxWords * 0.75));
  return `Broadcast timing: aim for ${lower}–${budget.maxWords} spoken words TOTAL across all contributions, with an upper target of ${budget.maxWords} words. This replaces other length targets. Keep every required speaker, use short turns and stop when the point has landed. This is a ceiling, not a quota; do not pad to reach it. Timing information is backstage and must never be spoken.`;
}

export function fitsSpeechDeadline(
  deadline: SpeechDeadline,
  current: { track?: { id?: string | null }; startedAt?: string | null } | null,
  durationMs: number,
  nowMs = Date.now(),
): boolean {
  return (
    current?.track?.id === deadline.trackId &&
    current.startedAt === deadline.startedAt &&
    Number.isFinite(durationMs) &&
    nowMs + durationMs <= deadline.finishByMs
  );
}
