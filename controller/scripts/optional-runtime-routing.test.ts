// Guards the promise made by DJ Behaviour: these alternatives are explicit
// routes, not UI labels over hidden tool-loop fallbacks.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(resolve(here, path), 'utf8');
const djAgent = read('../src/broadcast/dj-agent.ts');
const skills = read('../src/skills/_agent.ts');
const cohosted = read('../src/skills/cohosted.ts');

const pickerStart = djAgent.indexOf('async function pickViaAgent');
const pickerEnd = djAgent.indexOf('\n// The link\'s context', pickerStart);
const picker = djAgent.slice(pickerStart, pickerEnd);
const shortlistStart = picker.indexOf('if (useShortlist) {');
const shortlistEnd = picker.indexOf('\n  } else {', shortlistStart);
const shortlistRoute = picker.slice(shortlistStart, shortlistEnd);

assert.ok(shortlistStart >= 0 && shortlistEnd > shortlistStart, 'Shortlist must have its own explicit route');
assert.match(shortlistRoute, /buildShortlist\(/, 'Shortlist discovery is controller-led');
assert.match(shortlistRoute, /djPick\(/, 'Shortlist makes one bounded structured choice');
assert.doesNotMatch(shortlistRoute, /pickerAgent\.run/, 'Shortlist must not instantiate the picker tool loop');
assert.match(picker, /shortlistSelectionReason\(song, object\.reason\)/,
  'the final queued shortlist track must validate its own Booth reason');
assert.match(djAgent, /shortlistRepick \? shortlistPickSchema\(ids\)/,
  'a shortlist corrective re-pick must use the shortlist selection schema');
assert.match(djAgent, /prompt: shortlistRepick\s+\? shortlistPickPrompt/,
  'a shortlist corrective re-pick must use the shortlist prompt');

assert.match(djAgent, /requestMatching !== 'agentic'/,
  'direct request matching must bypass the request tool loop');
assert.match(skills, /segmentRuntime === 'direct'/,
  'direct segments must be independently selectable');
assert.match(cohosted, /segmentRuntime === 'direct'/,
  'co-hosted skills must follow the same direct-runtime boundary');

console.log('optional runtime routing: all assertions passed');
