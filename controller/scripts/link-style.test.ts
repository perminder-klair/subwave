// Per-persona linkStyle:'natural' | 'announce' — the operator control for a
// matter-of-fact station whose links are exactly "This is <artist>." or
// "Next up, <artist>." instead of the ordinary "set it up, name the artist"
// contract. Covers: persona normalisation (absent/valid/garbage), the
// settings.announceLinks() helper, the two pure prompt builders that carry a
// fallback announce contract to the model (dj-agent's buildLinkClause and
// llm/internal/prompts/scripts.ts's linkPrompt), and announce-line.ts — the
// module that actually COMPOSES the announcement in code, since a model can
// neither hold a fixed string reliably nor alternate with a line it is never
// shown.
//
// Run: npx tsx scripts/link-style.test.ts (auto-discovered by npm test).
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-link-style-'));

const { normalizePersona } = await import('../src/settings/normalize.js');
const { announceLinks } = await import('../src/settings/persona.js');
const { buildLinkClause } = await import('../src/broadcast/dj-agent/link-clause.js');
const { linkPrompt, generateLink } = await import('../src/llm/internal/prompts/scripts.js');
const { announceLine, resetAnnounceAlternation } = await import('../src/broadcast/announce-line.js');

const basePersona = () => ({
  name: 'Nova',
  soul: 'warm and dry',
  frequency: 'moderate',
  tts: { engine: 'piper', cloudProvider: 'openai', voice: '' },
});

// ── persona normalisation ────────────────────────────────────────────────────

test('linkStyle absent normalises to natural', () => {
  const p = normalizePersona(basePersona());
  assert.equal(p?.linkStyle, 'natural');
});

test('linkStyle "announce" survives normalisation', () => {
  const p = normalizePersona({ ...basePersona(), linkStyle: 'announce' });
  assert.equal(p?.linkStyle, 'announce');
});

test('garbage linkStyle falls back to natural and does not throw', () => {
  assert.doesNotThrow(() => {
    const p = normalizePersona({ ...basePersona(), linkStyle: 'shout-it-from-the-rooftops' });
    assert.equal(p?.linkStyle, 'natural');
  });
});

// ── announceLinks() helper ───────────────────────────────────────────────────

test('announceLinks is true only when linkStyle is exactly "announce"', () => {
  assert.equal(announceLinks({ linkStyle: 'announce' }), true);
  assert.equal(announceLinks({ linkStyle: 'natural' }), false);
  assert.equal(announceLinks({}), false);
  assert.equal(announceLinks(null), false);
  assert.equal(announceLinks(undefined), false);
});

// ── dj-agent's per-pick event clause (buildLinkClause) ───────────────────────

test('announce link clause carries the fixed two-form contract, not the variety instructions or the alternate instruction', () => {
  const clause = buildLinkClause({ djMode: true, announce: true, angle: null, recentOpeners: [] });
  assert.match(clause, /This is/);
  assert.match(clause, /Next up,/);
  assert.doesNotMatch(clause, /Approach for this link/);
  assert.doesNotMatch(clause, /start this one differently/);
  // The station composes and alternates the final line (announce-line.ts) —
  // the model is never asked to alternate with a line it can't see.
  assert.doesNotMatch(clause, /[Aa]lternate/);
});

test('natural link clause keeps the pre-existing variety contract', () => {
  const clause = buildLinkClause({
    djMode: false,
    announce: false,
    angle: 'lead with one specific image from the track itself.',
    recentOpeners: [],
  });
  assert.match(clause, /Approach for this link/);
});

test('natural link clause output is unchanged versus the pre-extraction template', () => {
  const angle = 'lead with one specific image from the track itself.';
  const withoutDjMode = buildLinkClause({ djMode: false, announce: false, angle, recentOpeners: [] });
  assert.equal(
    withoutDjMode,
    ` Also write the "say" link — it airs as your pick starts.`
      + ` Approach for this link: ${angle} Vary your first words — don't default to "here's", "this is", or "coming up".`,
  );

  const withDjMode = buildLinkClause({ djMode: true, announce: false, angle, recentOpeners: ['Here we go'] });
  assert.equal(
    withDjMode,
    ` Also write the "say" link — it airs as your pick starts. If the track you pick shows an intro_ms, keep the link short enough to finish before then, so you land just as the vocals come in.`
      + ` Approach for this link: ${angle} Vary your first words — don't default to "here's", "this is", or "coming up".`
      + ` You opened recent lines with "Here we go…" — start this one differently.`,
  );
});

// ── scripts.ts's pure prompt builder (linkPrompt) ────────────────────────────

test('announce link prompt names the artist in the fixed two-form contract', () => {
  const prompt = linkPrompt({
    announce: true,
    current: { artist: 'Marvin Gaye' },
    teaseClause: ' Name the artist or capture the feel so listeners know what they\'re hearing.',
    patterClause: '',
    budget: null,
    lengthPhraseText: 'one or two sentences',
    clockClause: ' Never state the clock time.',
    feelClause: ' A feel note...',
  });
  assert.match(prompt, /This is Marvin Gaye\./);
  assert.match(prompt, /Next up, Marvin Gaye\./);
  assert.doesNotMatch(prompt, /Vary how you open/);
  assert.doesNotMatch(prompt, /feel note/);
  assert.doesNotMatch(prompt, /Never state the clock time/);
  assert.doesNotMatch(prompt, /[Aa]lternate/);
});

// ── announce-line.ts — the station composes and alternates, the model never does ──

test('announceLine alternates This is -> Next up -> This is, and trims the artist', () => {
  resetAnnounceAlternation();
  assert.equal(announceLine('  Marvin Gaye  '), 'This is Marvin Gaye.');
  assert.equal(announceLine('Kim Weston'), 'Next up, Kim Weston.');
  assert.equal(announceLine('Lee Hazlewood'), 'This is Lee Hazlewood.');
});

test('announceLine returns empty string for an empty/whitespace-only artist', () => {
  resetAnnounceAlternation();
  assert.equal(announceLine(''), '');
  assert.equal(announceLine('   '), '');
});

// ── generateLink composes in code and never calls the model when it has an artist ──

test('generateLink in announce mode returns the composed line with no LLM call', async () => {
  resetAnnounceAlternation();
  const persona = { linkStyle: 'announce', name: 'Nova', soul: 'warm and dry' };
  const result = await generateLink({
    previous: null,
    current: { title: 'Ain\'t No Mountain High Enough', artist: 'Chris Stapleton' },
    context: {},
    persona,
  });
  // Deterministic: alternation was just reset, so the first call is 'This is'.
  // If this ever fell through to the model, either the LLM call would throw
  // (no provider configured in this throwaway STATE_DIR) or return different
  // text — either way this exact-equality assertion fails.
  assert.equal(result, 'This is Chris Stapleton.');
});

test('natural link prompt is unchanged versus the pre-extraction template', () => {
  const prompt = linkPrompt({
    announce: false,
    current: { artist: 'Marvin Gaye' },
    teaseClause: ' Name the artist or capture the feel so listeners know what they\'re hearing.',
    patterClause: '',
    budget: null,
    lengthPhraseText: 'one or two sentences',
    clockClause: ' Never state the clock time.',
    feelClause: '',
  });
  assert.equal(
    prompt,
    `Write a short DJ link to carry into the track now starting — set it up, capture its feel, weave in the moment.`
      + ` Name the artist or capture the feel so listeners know what they're hearing. one or two sentences, conversational.`
      + ` Vary how you open — don't default to "here's", "this is", "coming up", or "that was"; find a different way in each time.`
      + ` Keep it forward-looking: don't back-announce, recap, or name the track that just played — focus on what's playing now.`
      + ` Never state the clock time.`,
  );
});
