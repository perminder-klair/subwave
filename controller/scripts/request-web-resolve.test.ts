import assert from 'node:assert/strict';
import test from 'node:test';
import { instruction } from '../src/llm/internal/prompts/instructions.js';

test('request agent instructions route lyric descriptions through web resolution', () => {
  const frame = instruction('request', 'frame', { ackFields: 'the "ack" line' });
  assert.match(frame, /identifyRequestedTrack/);
  assert.match(frame, /pastes lyrics/);
  assert.match(frame, /when identifyRequestedTrack is available/);
  assert.match(instruction('request', 'classification'), /never return kind: "chat"/);
});
