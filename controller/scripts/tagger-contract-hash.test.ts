// The re-tagging stamp's inputs, pinned (#1548).
//
// `promptVocabHash(TAGGER_CONTRACT_VERSION)` is written to `prompt_hash` on
// every LLM-tagged row, and `staleTaggedIds` re-tags every row whose stamp
// differs on --upgrade / admin Re-scan → Re-decide moods. So a change to the
// hash's inputs is not a refactor: it is a decision to re-run the tagger over
// the whole library, ~1600 batch LLM calls on a 40k library, usually against a
// slow homelab Ollama box.
//
// This file exists to make that decision VISIBLE IN REVIEW rather than
// inferred from a diff three files away. Every way the stamp can move has a
// literal here, so moving it means editing this file in the same PR:
//
//   - the contract version itself (TAGGER_CONTRACT_VERSION);
//   - the shipped default mood vocabulary (settings/vocab.SHOW_MOODS);
//   - the hash recipe inside promptVocabHash.
//
// The other half of the #1548 change is the NEGATIVE assertion below: the
// prompt text is no longer an input, so a cosmetic reword of taggerSystem() /
// taggerBatchSystem() — #1541's transport-wording fix, a typo, a reflow — costs
// nothing. That is the whole point, and it is also the new hazard: a SEMANTIC
// prompt change now re-decides nothing unless someone bumps the version by
// hand. The loud comment on the constant carries the discipline; this pins it.
//
// Pure — no settings.load(), no DB. moodVocab() answers with MOOD_DEFAULTS
// pre-load, and promptVocabHash takes an explicit vocab for the fixed cases.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

import { promptVocabHash } from '../src/music/embeddings.js';
import { TAGGER_CONTRACT_VERSION, taggerBatchSystem, taggerSystem } from '../src/music/tagger-core.js';
import { SHOW_MOODS } from '../src/settings/vocab.js';
import { moodVocab } from '../src/settings.js';

// A vocabulary that is NOT the shipped one, so the fixed-input pin below can't
// pass by accidentally agreeing with the live default.
const FIXED_VOCAB = ['calm', 'energetic'];

test('the shipped contract version is 1', () => {
  // Bumping this is a full library re-tag on the next Re-decide. Read the
  // comment above TAGGER_CONTRACT_VERSION in music/tagger-core.ts first: a
  // reword does not earn a bump, a change to what the prompt ASKS FOR does.
  assert.equal(TAGGER_CONTRACT_VERSION, 1);
});

test('the stamp for the shipped vocabulary at the shipped version is pinned', () => {
  // Changing EITHER the version above or settings/vocab.MOOD_DEFAULTS moves
  // this literal. Both are legitimate; neither should land unnoticed.
  assert.equal(promptVocabHash(TAGGER_CONTRACT_VERSION, SHOW_MOODS), '322ce80896c5198b');
  // ...and that IS what production stamps: the live accessor falls back to the
  // shipped vocabulary, so an unloaded controller and a default install agree.
  assert.deepEqual(moodVocab(), [...SHOW_MOODS]);
  assert.equal(promptVocabHash(TAGGER_CONTRACT_VERSION), '322ce80896c5198b');
});

test('the hash recipe is version + vocabulary, in that order, joined by |', () => {
  // Spelled out rather than delegated, so a change to the recipe fails here
  // instead of computing the new answer on both sides and agreeing with itself.
  const expected = crypto
    .createHash('sha256')
    .update('tagger-contract-v1')
    .update('|')
    .update('calm,energetic')
    .digest('hex')
    .slice(0, 16);
  assert.equal(expected, '562c1235ad402def');
  assert.equal(promptVocabHash(1, FIXED_VOCAB), '562c1235ad402def');
});

test('a version bump moves the stamp, and a vocabulary edit moves it too', () => {
  // The two invalidation paths the design keeps. Without the first, a semantic
  // prompt change could never be pushed out to already-tagged rows; without the
  // second, an operator editing settings.moods would keep tags decided against
  // a vocabulary that no longer exists.
  assert.notEqual(
    promptVocabHash(TAGGER_CONTRACT_VERSION, SHOW_MOODS),
    promptVocabHash(TAGGER_CONTRACT_VERSION + 1, SHOW_MOODS),
  );
  assert.notEqual(
    promptVocabHash(TAGGER_CONTRACT_VERSION, SHOW_MOODS),
    promptVocabHash(TAGGER_CONTRACT_VERSION, [...SHOW_MOODS, 'nocturne']),
  );
  // Vocabulary ORDER is part of the stamp — moodVocab() preserves the operator's
  // list order, and a reorder is a cheap-looking edit that does re-tag.
  assert.notEqual(
    promptVocabHash(TAGGER_CONTRACT_VERSION, FIXED_VOCAB),
    promptVocabHash(TAGGER_CONTRACT_VERSION, [...FIXED_VOCAB].reverse()),
  );
});

test('the prompt text is not an input — a reword does not re-tag the library', () => {
  // The #1548 behaviour change, asserted the only way it can be: the stamp is
  // reproducible from (version, vocabulary) alone, so nothing the prompt
  // builders emit can reach it. If someone restores the prompt string as an
  // input, this recomputation stops matching.
  const fromInputsAlone = crypto
    .createHash('sha256')
    .update(`tagger-contract-v${TAGGER_CONTRACT_VERSION}`)
    .update('|')
    .update(SHOW_MOODS.join(','))
    .digest('hex')
    .slice(0, 16);
  assert.equal(promptVocabHash(TAGGER_CONTRACT_VERSION, SHOW_MOODS), fromInputsAlone);

  // And the prompts really are non-empty live strings carrying that vocabulary
  // — the stamp ignores them by design, not because they went missing.
  for (const prompt of [taggerSystem(), taggerBatchSystem()]) {
    assert.ok(prompt.length > 100);
    assert.ok(prompt.includes(SHOW_MOODS[0]));
  }
});
