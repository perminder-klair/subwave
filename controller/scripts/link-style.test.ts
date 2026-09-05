// Per-persona linkStyle:'natural' | 'announce' — the operator control for a
// matter-of-fact station whose links are exactly "This is <artist>." or
// "Next up, <artist>." instead of the ordinary "set it up, name the artist"
// contract. Covers: persona normalisation (absent/valid/garbage), the
// settings.announceLinks() helper, the two pure prompt builders that carry a
// fallback announce contract to the model (dj-agent's buildLinkClause and
// llm/internal/prompts/scripts.ts's linkPrompt), and announce-line.ts — the
// module that actually COMPOSES the announcement in code, since a model can
// neither hold a fixed string reliably nor alternate with a line it is never
// shown. The compose is PURE: it alternates against the link that last AIRED
// (handed in by the caller), refuses the artists an English frame cannot carry,
// and pins the /dj/segment button's link to the only form true of a track
// already playing.
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
const { announceLine, nextAnnounceForm } = await import('../src/broadcast/announce-line.js');
const { queue } = await import('../src/broadcast/queue.js');

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

// ── scripts.ts's isolated writer prompt ─────────────────────────────────────

test('the isolated writer prompt never carries the announce-model contract', () => {
  const prompt = linkPrompt({
    current: { title: 'Unknown', artist: 'Marvin Gaye' },
    context: null,
  });
  assert.match(prompt, /Verified Facts:/);
  assert.doesNotMatch(prompt, /This is Marvin Gaye\.|Next up, Marvin Gaye\./);
});

// ── announce-line.ts — the station composes and alternates, the model never does ──

test('announceLine alternates against the line that last aired, and trims the artist', () => {
  assert.equal(announceLine('  Marvin Gaye  ', null, { lastLine: null }), 'This is Marvin Gaye.');
  assert.equal(
    announceLine('Kim Weston', null, { lastLine: 'This is Marvin Gaye.' }),
    'Next up, Kim Weston.',
  );
  assert.equal(
    announceLine('Lee Hazlewood', null, { lastLine: 'Next up, Kim Weston.' }),
    'This is Lee Hazlewood.',
  );
});

// The whole point of anchoring on the AIRED line rather than a counter: a
// composed line that never airs (silence ordered, intro budget, refused pick)
// must not flip the form, or the next line the listener hears repeats the last
// one they heard.
test('a composed link that never airs does not disturb the alternation', () => {
  const aired = announceLine('A', null, { lastLine: null });
  assert.equal(aired, 'This is A.');
  // Composed for a pick that was then deduped/dropped — never logged, so the
  // next compose still sees the same last-aired line.
  assert.equal(announceLine('B', null, { lastLine: aired }), 'Next up, B.');
  assert.equal(announceLine('C', null, { lastLine: aired }), 'Next up, C.');
});

test('nextAnnounceForm restarts the sequence after a non-announce line', () => {
  assert.equal(nextAnnounceForm(null), 'this-is');
  assert.equal(nextAnnounceForm('Dust motes are dancing in the sun.'), 'this-is');
  assert.equal(nextAnnounceForm('"Next up, Kim Weston."'), 'this-is');
  assert.equal(nextAnnounceForm('this is marvin gaye.'), 'next-up');
});

// A link fired from /dj/segment airs OVER the track already playing, so
// "Next up, <artist>." would be a false claim about what the listener is
// hearing. Only "This is" is true there, whatever the alternation says.
test('a link for the track already on air is pinned to the This is form', () => {
  assert.equal(
    announceLine('Marvin Gaye', null, { lastLine: 'Next up, Kim Weston.', currentIsOnAir: true }),
    'This is Marvin Gaye.',
  );
  assert.equal(
    announceLine('Marvin Gaye', null, { lastLine: 'This is Kim Weston.', currentIsOnAir: true }),
    'This is Marvin Gaye.',
  );
});

test('announceLine returns empty string for an empty/whitespace-only artist', () => {
  assert.equal(announceLine('', null), '');
  assert.equal(announceLine('   ', null), '');
  assert.equal(announceLine(null, null), '');
  assert.equal(announceLine(undefined, null), '');
});

// languageDirective binds a persona to speak exclusively in its own language;
// a hardcoded English frame would put an English line on a Turkish station.
test('announceLine refuses to compose for a persona that does not speak English', () => {
  assert.equal(announceLine('Barış Manço', { language: 'Turkish' }), '');
  assert.equal(announceLine('Marvin Gaye', { language: 'Punjabi' }), '');
  // Unset and an explicit English both mean English.
  assert.equal(announceLine('Marvin Gaye', { language: '' }), 'This is Marvin Gaye.');
  assert.equal(announceLine('Marvin Gaye', { language: 'english' }), 'This is Marvin Gaye.');
});

// spokenProperNounDirective requires ZERO CJK characters in a spoken field and
// tells the MODEL to romanize. Composed code can't romanize, so it stands down
// rather than handing an English voice characters it cannot read.
test('announceLine refuses to compose a non-Latin artist name', () => {
  assert.equal(announceLine('ウルフルズ', null), '');
  assert.equal(announceLine('周杰倫', null), '');
  assert.equal(announceLine('방탄소년단', null), '');
  // A Latin name with accents is fine — the directive is about CJK scripts.
  assert.equal(announceLine('Café Tacvba', null), 'This is Café Tacvba.');
});

// ── generateLink composes in code and never calls the model when it has an artist ──

// Every generateLink assertion below is also a no-LLM-call assertion: nothing
// is configured to serve a model in this throwaway STATE_DIR, so a fall-through
// would either throw or return something else — the exact equality catches both.
const announcePersona = { linkStyle: 'announce', name: 'Nova', soul: 'warm and dry' };

test('generateLink in announce mode returns the composed line with no LLM call', async () => {
  const result = await generateLink({
    previous: null,
    current: { title: 'Ain\'t No Mountain High Enough', artist: 'Chris Stapleton' },
    context: {},
    persona: announcePersona,
  });
  assert.equal(result, 'This is Chris Stapleton.');
});

test('generateLink alternates announce mode against the link that last aired', async () => {
  assert.equal(
    await generateLink({
      previous: null, current: { artist: 'Chris Stapleton' }, context: {},
      persona: announcePersona, lastLink: 'This is Kim Weston.',
    }),
    'Next up, Chris Stapleton.',
  );
  assert.equal(
    await generateLink({
      previous: null, current: { artist: 'Chris Stapleton' }, context: {},
      persona: announcePersona, lastLink: 'Next up, Kim Weston.',
    }),
    'This is Chris Stapleton.',
  );
});

// scheduler.runLink (the /dj/segment button) airs over the track already
// playing and passes currentIsOnAir — "Next up" about it would be false.
test('generateLink announces the on-air track with This is, whatever the alternation', async () => {
  assert.equal(
    await generateLink({
      previous: null, current: { artist: 'Chris Stapleton' }, context: {},
      persona: announcePersona, lastLink: 'This is Kim Weston.', currentIsOnAir: true,
    }),
    'This is Chris Stapleton.',
  );
});

// The bug this replaces: with no artist, the announce prompt asked the model
// for a line whose only permitted forms were "This is <artist>." / "Next up,
// <artist>." — and a model at temperature 0.3 reads the placeholder out.
// There is nothing to announce, so there is no link.
test('generateLink in announce mode drops the link when the track has no artist', async () => {
  for (const current of [{ title: 'Untitled' }, { title: 'Untitled', artist: '' }, { title: 'Untitled', artist: '   ' }]) {
    assert.equal(
      await generateLink({ previous: null, current, context: {}, persona: announcePersona }),
      '',
    );
  }
});

test('the isolated writer prompt never carries an announce placeholder', () => {
  const prompt = linkPrompt({
    current: { title: 'Untitled', artist: '' },
    context: null,
  });
  assert.doesNotMatch(prompt, /<artist>/);
  assert.match(prompt, /Task: Give a brief spoken introduction/);
});

test('natural link prompt exposes only the bounded verified-facts packet', () => {
  const prompt = linkPrompt({
    current: { title: 'Unknown', artist: 'Marvin Gaye' },
    context: { time: { vibe: 'private selection steer' } },
  });
  assert.match(prompt, /Track on air:\n- Unknown by Marvin Gaye/);
  assert.doesNotMatch(prompt, /private selection steer/);
});

// ── the air-truth anchor the alternation reads ───────────────────────────────

// djLog entries for voice kinds are written by onSpoken, i.e. after the clip
// reached the stream — which is the whole reason announce mode alternates
// against this rather than a counter it advances while composing.
test('getLastLinkText returns the most recently aired link and ignores other kinds', () => {
  (queue as any).djLog = [];
  assert.equal(queue.getLastLinkText(), null);

  queue.log('link', 'This is Marvin Gaye.');
  queue.log('station-id', 'You are listening to SUB/WAVE.');
  queue.log('ai-pick', 'Helpless — Neil Young');
  assert.equal(queue.getLastLinkText(), 'This is Marvin Gaye.');
  assert.equal(nextAnnounceForm(queue.getLastLinkText()), 'next-up');

  queue.log('link', 'Next up, Kim Weston.');
  assert.equal(queue.getLastLinkText(), 'Next up, Kim Weston.');
  assert.equal(nextAnnounceForm(queue.getLastLinkText()), 'this-is');
  (queue as any).djLog = [];
});

// ── the announce contract follows the persona who SPEAKS the line ────────────

// The link is pinned to session.onAirPersona() at enqueue, and inside the
// handoff look-ahead that disagrees with the wall-clock getEffectivePersona()
// — which is what a bare announceLinks() resolves to. Written the incoming
// DJ's line under the outgoing DJ's link contract. Source-level because the
// two personas only diverge inside a live look-ahead window.
test('the deterministic announce writer resolves against its explicit persona', async () => {
  const { readFileSync } = await import('node:fs');
  for (const file of [
    '../src/llm/internal/prompts/scripts.ts',
  ]) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(
      src,
      /announceLinks\(\s*\)/,
      `${file} calls announceLinks() with no persona — it must pass session.onAirPersona()`,
    );
    assert.match(src, /announceLinks\(speaker\)/);
  }
});
