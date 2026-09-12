import assert from 'node:assert/strict';
import test from 'node:test';
import { shortlistContextWindow } from '../src/music/shortlist-context-window.js';

test('suggests a server context window from the peak successful shortlist picker prompt', () => {
  const result = shortlistContextWindow([
    { kind: 'djShortlistPick', ok: true, usage: { input: 11_989, output: 180 } },
    { kind: 'djShortlistPick', ok: true, usage: { input: 6_420, output: 170 } },
    { kind: 'djShortlistRepick', ok: true, usage: { input: 1_900, output: 120 } },
  ]);

  assert.deepEqual(result, {
    samples: 3,
    peakInputTokens: 11_989,
    suggestedTokens: 16_384,
    headroomPct: 25,
    responseReserveTokens: 1_024,
    message: 'Based on the largest successful final-picker prompt since this controller started.',
  });
});

test('waits for reported successful picker usage and ignores unrelated or failed calls', () => {
  const result = shortlistContextWindow([
    { kind: 'djAgentPick', ok: true, usage: { input: 99_999 } },
    { kind: 'djShortlistPick', ok: false, usage: { input: 99_999 } },
    { kind: 'djShortlistPick', ok: true, usage: {} },
  ]);

  assert.deepEqual(result, {
    samples: 0,
    peakInputTokens: null,
    suggestedTokens: null,
    message: 'Waiting for successful shortlist picker calls that report input-token usage.',
  });
});
