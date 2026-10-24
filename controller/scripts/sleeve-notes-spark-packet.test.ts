import {createTempDir, removeTempDir} from './test-utils/temp-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = createTempDir(join(tmpdir(), 'subwave-spark-packet-'));
process.env.STATE_DIR = root;
const { storySparkPacket, sparkSpeechWordBudget, sparkLinkSchema } = await import('../src/llm/internal/prompts/story-spark.js');
const { linkPrompt } = await import('../src/llm/internal/prompts/scripts.js');
const { close } = await import('../src/sleeve-notes/db.js');
const note = { claimId: 'claim', entityType: 'artist' as const, entityId: 'artist', category: 'artist-stories',
  topic: 'studio', wording: 'The band recorded in a converted barn.', fullWording: 'The band recorded in a converted barn.',
  shortWording: 'An obsolete short form.', provider: 'wikipedia', attribution: 'Wikipedia', sourceUrl: 'https://example.test',
  relationshipKey: null, localTrackId: 'song' };

test('the natural introduction is the task and the single researched claim stays optional', () => {
  const prompt = linkPrompt({ current: { title: 'Song', artist: 'Band' }, extendedSleeveNote: note });
  assert.ok(prompt.indexOf('Story Spark') < prompt.indexOf('Rules:'));
  assert.match(prompt, /About: the artist.*artist history/);
  assert.match(prompt, /Supported fact: The band recorded in a converted barn\./);
  assert.doesNotMatch(prompt, /obsolete short form|Category:|Full story wording/);
  assert.equal(prompt.split('FACTUAL GROUNDING:').length - 1, 1);
  assert.match(prompt, /Task: Write a natural, brief DJ introduction/);
  assert.match(prompt, /optional material to weave into that link, not a script to read out/);
  assert.match(prompt, /weave a complete supported detail.*wherever it flows naturally/);
  assert.doesNotMatch(prompt, /opening sentence|before greetings or atmosphere/);
  assert.match(prompt, /Track identification alone is not use/);
  assert.match(prompt, /supported detail and track identification cannot both fit naturally, pass on the Spark/);
});

test('a dated historical Spark retains its time framing in the link instructions', () => {
  const wording='Suede were honoured with the Inspiration Award at the 2010 Q Awards.';
  const prompt=linkPrompt({current:{artist:'Suede',title:'Lazy'},extendedSleeveNote:{...note,wording,fullWording:wording}});
  assert.match(prompt,/retain past-tense wording and any explicit date/);
  assert.match(prompt,/Do not recast a historical event as a recent development/);
  assert.ok(prompt.includes(`Supported fact: ${wording}`));
});

test('matching release and recording scopes identify the real subject', () => {
  assert.match(storySparkPacket({ ...note, airtimeScope: 'matching-release-only', matchingReleaseTitle: 'Another Album' }, null),
    /About: the album Another Album/);
  assert.match(storySparkPacket({ ...note, airtimeScope: 'matching-track-only', matchingTrackTitle: 'Another Song' }, null),
    /About: the recording Another Song/);
  assert.match(storySparkPacket({ ...note, entityType: 'release-group' }, null), /About: the album associated/);
});

test('a short vocal runway budgets the whole line without truncating the supplied claim', () => {
  const track = { title: 'Song', artist: 'Band', vocalRanges: [{ startMs: 4000, endMs: 5000 }] };
  const budget = sparkSpeechWordBudget(track, { scriptLength: 'concise' });
  assert.ok(budget != null && budget > 0 && budget <= 15);
  const packet = storySparkPacket(note, budget);
  assert.match(packet, /WHOLE link, including track identification/);
  assert.match(packet, /Supported fact: The band recorded in a converted barn\./);
  assert.equal(sparkSpeechWordBudget(track, {}, false), null, 'on-demand links do not reuse opening runway');
  assert.equal(sparkSpeechWordBudget({ vocalRanges: [{ startMs: 500, endMs: 1000 }] }, {}), 0);
  assert.equal(sparkSpeechWordBudget({ title: 'Unknown timing' }, {}), null);
  assert.match(storySparkPacket(note, null, true), /one short sentence for the whole link/);
});

test('the audited identity and biography failures have explicit, correctly labelled subjects', () => {
  const james = linkPrompt({ current: { artist: 'James', title: 'Hey' }, extendedSleeveNote: {
    ...note, wording: 'James are an English rock band from Manchester, formed in 1982.'} });
  assert.match(james, /Track identification: Artist: "James"; title: "Hey"/);
  assert.match(james, /a track title is not a band name/);
  const van = linkPrompt({ current: { artist: 'Van Morrison', title: 'Cyprus Avenue' }, extendedSleeveNote: {
    ...note, wording: 'Van Morrison started performing as a teenager.'} });
  assert.match(van, /Supported fact: Van Morrison started performing as a teenager/);
  assert.match(van, /Keep artist biography about the artist/);
  assert.match(van, /does not establish that they performed this particular song then/);
  assert.match(van, /misleading relative clause/);
});

test('a limited one-liner reserves identification and does not instruct a fact-only or forced link', () => {
  const prompt = linkPrompt({ current: { artist: 'Wolf Alice', title: 'Safe in the World', vocalRanges: [{ startMs: 4000, endMs: 5000 }] },
    persona: { scriptLength: 'one-liner' }, extendedSleeveNote: {
      ...note, wording: 'Wolf Alice were formed in 2010 by singer Ellie Rowsell and guitarist Joff Oddie.'} });
  assert.match(prompt, /Reserve room for the supplied artist and track title/);
  assert.match(prompt, /Never spend the whole link on the fact alone/);
  assert.match(prompt, /One-liner: Combine identification.*only if both fit/);
  assert.match(prompt, /Never invent a cause linking the fact to this track/);
  assert.match(prompt, /Never.*a fact that brings us the track/);
  assert.doesNotMatch(sparkLinkSchema.shape.speech.description ?? '', /opening sentence/);
  assert.match(sparkLinkSchema.shape.speech.description ?? '', /identifying the supplied artist and track/);
  assert.match(sparkLinkSchema.shape.speech.description ?? '', /wherever it fits/);
});

test('the output contract isolates private reasons from speech and requires meaningful passes', () => {
  assert.equal(sparkLinkSchema.parse({ speech: 'Here is Band.', sparkDecision: 'pass', reason: 'Too little speech space.' }).speech,
    'Here is Band.');
  assert.equal(sparkLinkSchema.safeParse({ speech: 'Here is Band.', sparkDecision: 'quality-concern', reason: '' }).success, false);
  const prompt = linkPrompt({ current: { title: 'Song', artist: 'Band' }, extendedSleeveNote: note, structuredSpark: true });
  assert.match(prompt, /private Spark decision and its reason separate/);
  assert.doesNotMatch(prompt, /Output only the words to be spoken on air/);
});

test.after(async () => { close(); await removeTempDir(root); });
