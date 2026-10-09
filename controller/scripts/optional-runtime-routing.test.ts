// Guards the promise made by Music Selection and DJ Behaviour: these
// alternatives are explicit routes, not UI labels over hidden tool-loop
// fallbacks.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(resolve(here, path), 'utf8');
const djAgent = read('../src/broadcast/dj-agent.ts');
const skills = read('../src/skills/_agent.ts');
const cohosted = read('../src/skills/cohosted.ts');

const pickerStart = djAgent.indexOf('async function pickViaSelectionRoute');
const pickerEnd = djAgent.indexOf('\nfunction speechClockContext', pickerStart);
const picker = djAgent.slice(pickerStart, pickerEnd);
const shortlistStart = picker.indexOf('if (useShortlist) {');
const shortlistEnd = picker.indexOf('\n  } else {', shortlistStart);
const shortlistRoute = picker.slice(shortlistStart, shortlistEnd);

test('the slices under test are found, not silently the rest of the file', () => {
  assert.ok(pickerStart >= 0 && pickerEnd > pickerStart, 'pickViaSelectionRoute must be sliced to its own end');
  assert.ok(shortlistStart >= 0 && shortlistEnd > shortlistStart, 'Shortlist must have its own explicit route');
});

test('Track Shortlist is controller-led with one bounded model choice', () => {
  assert.match(shortlistRoute, /buildShortlist\(/, 'Shortlist discovery is controller-led');
  assert.match(shortlistRoute, /djPick\(/, 'Shortlist makes one bounded structured choice');
  assert.doesNotMatch(shortlistRoute, /pickerAgent\.run/, 'Shortlist must not instantiate the picker tool loop');
  assert.match(picker, /shortlistClauseSelectionReason\(song, object\.musicalReason\)/,
    'the final queued shortlist track must rebuild its Booth reason from verified identity');
  assert.match(djAgent, /shortlistRepick\s+\? shortlistPickSchema\(ids\)/,
    'a shortlist corrective re-pick must use the shortlist selection schema');
  assert.match(djAgent, /prompt: shortlistRepick\s+\? shortlistPickPrompt/,
    'a shortlist corrective re-pick must use the shortlist prompt');
});

test('the route switch is trackSelection, never the derived legacy toggle', () => {
  const dispatchStart = djAgent.indexOf("const shortlistSelected = settings.get().llm?.trackSelection === 'shortlist';");
  assert.ok(dispatchStart >= 0);
  assert.doesNotMatch(djAgent, /llm\?\.pickerAgent/, 'nothing on the pick path reads pickerAgent');
});

test('requests and segments choose their own runtime', () => {
  assert.match(djAgent, /requestMatching !== 'agentic'/,
    'direct request matching must bypass the request tool loop');
  assert.match(skills, /segmentRuntime === 'direct'/,
    'direct segments must be independently selectable');
  assert.match(cohosted, /segmentRuntime === 'direct'/,
    'co-hosted skills must follow the same direct-runtime boundary');
});
