// Pins skills/abstain-policy.ts and the surfaces that consume it — the forced
// segment schema/prompt, the autonomous pool-mode director (skills/_agent.ts),
// and the web-search built-in's own relevance filter (issues #1412/#1446).
//
// The bug: a forced skill run (Run-now button, per-skill cron, programme
// feature beat) was told "you must produce a line, silence is not an option",
// while web-search's SKILL.md told the same model "use only what the search
// returned; if it surfaced nothing solid, say nothing". A search for "Cue
// musician latest news" came back with an empty answer and three sources about
// other things, so the two instructions could not both be obeyed — and the
// model resolved it by re-airing a hallucinated story from earlier in the hour.
//
// The three halves pinned here:
//   1. requiresGrounding — WHICH skills may stand down. Everything with a data
//      tool, except the ones that write their own material (curiosity), and
//      overridable by the skill author or the operator.
//   2. forcedSchema/forcedSystem — the abstention field and the changed mandate
//      appear ONLY for a grounded run, so an ungrounded operator trigger can
//      still never answer with silence.
//   3. web-search's filter — the reporter's exact result set yields
//      `available: false` rather than three off-topic sources.
//
// Run: `tsx scripts/skill-abstain.test.ts` (or `npm test -- abstain`).

import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// _agent.ts pulls in settings/queue, which derive paths from STATE_DIR at
// module scope — same preamble as skill-cron-gates.test.ts.
const STATE_DIR = mkdtempSync(join(tmpdir(), 'skill-abstain-'));
process.env.STATE_DIR = STATE_DIR;
const DRY_WELL_ATTEMPTS = join(STATE_DIR, 'dry-well-attempts.txt');

// Two skills on disk for the end-to-end run below: one whose data tool reports
// nothing usable, and one that reports nothing usable but declares it writes its
// own material anyway. Written BEFORE the imports so loadSkills() sees them.
function writeSkill(slug: string, tool: string) {
  const dir = join(STATE_DIR, 'skills', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${slug}\n---\nSay something about ${slug}.\n`);
  writeFileSync(join(dir, 'tool.mjs'), tool);
}
writeSkill('dry-well', `import { appendFileSync } from 'node:fs';
export default async () => {
  appendFileSync(${JSON.stringify(DRY_WELL_ATTEMPTS)}, 'attempt\\n');
  return { available: false };
};
`);
writeSkill('own-material', 'export const requiresData = false;\nexport default async () => ({ available: false });\n');

const { requiresGrounding, unusableDataReason, standDownReason, declaredBool } =
  await import('../src/skills/abstain-policy.js');
const { segmentTick, forcedSchema, forcedSystem, runCapability } = await import('../src/skills/_agent.js');
const { queue } = await import('../src/broadcast/queue.js');
const webSearch = (await import('../src/skills/builtins/web-search/tool.mjs')).default;

const dataCap = (over = {}) => ({ kind: 'web-search', toolFn: () => ({}), ...over });

// --- 1. which skills may stand down ----------------------------------------

test('a skill that speaks from fetched data is grounded by default', () => {
  assert.equal(requiresGrounding(dataCap()), true);
  assert.equal(requiresGrounding(dataCap({ kind: 'news' })), true);
  assert.equal(requiresGrounding(dataCap({ kind: 'some-operator-skill' })), true);
});

test('a skill with no data tool is never grounded', () => {
  // Nothing was fetched, so nothing can be missing: it writes from the moment
  // and its brief, which is all it ever had. An operator trigger on one of
  // these must still always produce a line.
  assert.equal(requiresGrounding({ kind: 'web-search' }), false);
  assert.equal(requiresGrounding(null), false);
  assert.equal(requiresGrounding(undefined), false);
});

test('curiosity is exempt — its available:false is a hand-off, not a silence', () => {
  // skills/curiosity.ts treats "no external item" as the cue to write its own
  // factoid. Standing it down would mute a skill working exactly as designed.
  assert.equal(requiresGrounding(dataCap({ kind: 'curiosity' })), false);
});

test('a skill author can declare the answer for a copy of a built-in', () => {
  // The kind default is keyed on the shipped name, so a RENAMED copy of
  // curiosity would otherwise become grounded. tool.mjs travels with the copy.
  assert.equal(requiresGrounding(dataCap({ kind: 'my-curiosity', requiresData: false }), ), false);
  assert.equal(requiresGrounding(dataCap({ kind: 'curiosity', requiresData: true })), true);
});

test('the operator frontmatter line outranks the skill author', () => {
  const cap = dataCap({ kind: 'my-skill', requiresData: false, config: { requiresData: 'true' } });
  assert.equal(requiresGrounding(cap), true);
  // Frontmatter values arrive as strings — both directions must parse.
  assert.equal(requiresGrounding(dataCap({ config: { requiresData: 'false' } })), false);
});

test('an unrecognised declaration falls through to the default, not to false', () => {
  // The dangerous direction: reading "maybe" as an opt-out would silently
  // restore the bug for that skill.
  assert.equal(declaredBool('perhaps'), undefined);
  assert.equal(declaredBool(''), undefined);
  assert.equal(declaredBool(undefined), undefined);
  assert.equal(requiresGrounding(dataCap({ config: { requiresData: 'perhaps' } })), true);
});

// --- 2. what counts as unusable --------------------------------------------

test('a fetch error and an explicit available:false are both unusable', () => {
  assert.match(String(unusableDataReason({ error: 'Brave HTTP 429' })), /429/);
  assert.equal(typeof unusableDataReason({ available: false }), 'string');
});

test('real data — and no data at all — are not stand-down reasons', () => {
  assert.equal(unusableDataReason({ answer: 'a real answer', sources: [] }), null);
  assert.equal(unusableDataReason({ available: true }), null);
  // null is what fetchSegmentData returns for a capability with no tool.
  assert.equal(unusableDataReason(null), null);
  assert.equal(unusableDataReason(undefined), null);
});

test('standDownReason only fires for a grounded skill', () => {
  const empty = { available: false };
  assert.equal(typeof standDownReason(dataCap(), empty), 'string');
  assert.equal(standDownReason(dataCap({ kind: 'curiosity' }), empty), null);
  assert.equal(standDownReason(dataCap(), { answer: 'something real' }), null);
});

// --- 3. the schema and the prompt ------------------------------------------

test('the abstention field is absent, not false, on an ungrounded run', () => {
  // An operator asking for a weather segment must not be handed a silence
  // token — that would be a new way for an explicit action to produce nothing.
  // Asserted through a parse rather than off the schema's shape: modelTolerant
  // wraps the object in a preprocess, and a run's real exposure to the field is
  // what survives parsing anyway.
  const ungrounded = forcedSchema().parse({ air: false, text: 'a line', sfx: null });
  assert.equal('air' in ungrounded, false);
  const grounded = forcedSchema({ mayAbstain: true })
    .parse({ reason: 'r', air: false, text: '', sfx: null });
  assert.equal(grounded.air, false);
});

test('a grounded schema accepts a stand-down with an empty line', () => {
  const parsed = forcedSchema({ mayAbstain: true }).parse({
    reason: 'the search came back about a different Cue',
    air: false,
    text: '',
    sfx: null,
  });
  assert.equal(parsed.air, false);
});

test('the mandate flips with mayAbstain', () => {
  const cap = { kind: 'web-search', desc: 'brief' };
  const mandatory = forcedSystem({ name: 'DJ' }, cap, []);
  const grounded = forcedSystem({ name: 'DJ' }, cap, [], { mayAbstain: true });
  assert.match(mandatory, /silence is not an option/);
  assert.doesNotMatch(grounded, /silence is not an option/);
  // The recycling ban is load-bearing: the model's own earlier lines are in its
  // window, so "don't invent" alone leaves reaching backwards looking legal.
  assert.match(grounded, /what you said earlier/i);
  assert.match(grounded, /"air" to false/);
});

// --- 4. web-search's own filter (the reported result set) -------------------

const servicesFor = (result) => ({
  searchReady: () => true,
  nowPlaying: () => ({ artist: 'Cue', title: 'Sway' }),
  searchWeb: async () => result,
});

test('sources that never name the artist are reported as nothing to say', async () => {
  const data = await webSearch({}, {}, servicesFor({
    answer: '',
    results: [
      { title: 'AP Music', content: 'General music industry roundup for the week.' },
      { title: 'Best albums of the month', content: 'A list of records by other people.' },
    ],
  }), {}, {});
  assert.deepEqual(data, { available: false });
});

test('a name-match the filter cannot judge still reaches the model — and stops there', async () => {
  // "The New Cue" is a music newsletter, not the artist Cue, and no
  // deterministic filter can tell those apart. So the filter drops what it CAN
  // judge (the AP roundup) and this one survives — which is exactly why the
  // second half of the fix exists: the run is grounded, so the model that sees
  // one thin off-topic source can set air:false instead of writing a story.
  const data = await webSearch({}, {}, servicesFor({
    answer: '',
    results: [
      { title: 'The New Cue', content: 'A music newsletter interviewing other artists.' },
      { title: 'AP Music', content: 'General music industry roundup for the week.' },
    ],
  }), {}, {});
  assert.equal(data.sources.length, 1);
  assert.match(data.sources[0], /The New Cue/);
  assert.equal(requiresGrounding(dataCap()), true);
});

test('a source that actually names the artist survives', async () => {
  const data = await webSearch({}, {}, servicesFor({
    answer: '',
    results: [
      { title: 'AP Music', content: 'Unrelated industry roundup.' },
      { title: 'Cue announces spring tour', content: 'Cue will play eight dates in March.' },
    ],
  }), {}, {});
  assert.equal(data.available, undefined);
  assert.equal(data.sources.length, 1);
  assert.match(data.sources[0], /spring tour/);
});

test('the filter is word-boundary, not substring', async () => {
  // "cued", "rescue" and friends are not the artist. This is the half that
  // makes the filter worth having for short names.
  const data = await webSearch({}, {}, servicesFor({
    answer: '',
    results: [{ title: 'Rescue crews respond', content: 'A queue formed; someone cued the tape.' }],
  }), {}, {});
  assert.deepEqual(data, { available: false });
});

// --- 5. the forced run itself, end to end ----------------------------------

test('a forced run on empty data stands down without ever calling the model', async () => {
  // The whole point: no LLM is configured in this test, and none is reached.
  // A model call here would throw (or worse, on a real station, invent) — the
  // stand-down happens on the fetched data, before generation. Pool mode is
  // the path with no tool loop, so this pins the branch that decides in code.
  const settings = await import('../src/settings.js');
  const { loadSkills } = await import('../src/skills/loader.js');
  await settings.load();
  await settings.update({ llm: { pickerAgent: false } });
  await loadSkills();

  const run = await runCapability('dry-well', { time: {}, clock: {} });
  assert.equal(run.aired, false);
  assert.equal(run.text, null);
  assert.match(String(run.reason), /nothing fresh/);
});

test('the direct runtime skips generation and backs off when grounded data is unavailable', async () => {
  const settings = await import('../src/settings.js');
  await settings.update({
    // pickerAgent stays enabled to prove Segments no longer branch into its
    // tool loop. It still controls music picking elsewhere.
    llm: { pickerAgent: true, provider: 'openai', apiKey: '', agentTimeoutMs: 5_000 },
    skills: { enabled: { 'dry-well': true } },
    personas: settings.get().personas.map((p: { id: string }, i: number) =>
      (i === 0 ? { ...p, frequency: 'aggressive', djMode: false } : p)),
  });

  const attempts = () => existsSync(DRY_WELL_ATTEMPTS)
    ? readFileSync(DRY_WELL_ATTEMPTS, 'utf8').trim().split('\n').filter(Boolean).length
    : 0;
  const before = attempts();
  queue.djLog = [];

  await segmentTick({ time: {}, clock: {} });

  assert.equal(attempts(), before + 1, 'the first tick fetches the selected skill once');
  assert.ok(
    queue.djLog.some(e => e.kind === 'scheduler'
      && e.message.includes('[segment] dry-well → unavailable → skipped before LLM')),
    'the booth log exposes the pre-LLM skip and selected skill',
  );
  assert.ok(
    !queue.djLog.some(e => e.kind === 'error' && e.message.startsWith('Segment director failed:')),
    'unavailable source data never reaches the LLM failure path',
  );

  await segmentTick({ time: {}, clock: {} });
  assert.equal(attempts(), before + 1, 'the unavailable skill is backed off on the next scheduler tick');
});

test("a skill's own requiresData export survives the loader", async () => {
  // The other direction, and the wiring the exemption rides on: a
  // curiosity-style skill declares `requiresData = false` in its tool.mjs, and
  // that has to reach the policy through loadSkills() — otherwise the exemption
  // works only for the kinds hard-coded in abstain-policy.ts. Asserted on the
  // loaded capability rather than by running it, so no model is involved.
  const { loadedCapabilities } = await import('../src/skills/loader.js');
  const caps = loadedCapabilities();
  const dry = caps.find(c => c.kind === 'dry-well');
  const own = caps.find(c => c.kind === 'own-material');
  assert.ok(dry && own, 'both fixture skills loaded');
  assert.equal(requiresGrounding(dry), true);
  assert.equal(requiresGrounding(own), false);
});

test('a custom query is not filtered against the on-air artist', async () => {
  // The agent chose the wording, so there is no subject to check the results
  // against — filtering here would drop every result of a good search.
  const data = await webSearch({}, {}, servicesFor({
    answer: '',
    results: [{ title: 'Sway (dance)', content: 'A ballroom standard recorded many times.' }],
  }), {}, { query: 'history of the song Sway' });
  assert.equal(data.sources.length, 1);
  assert.equal(data.query, 'history of the song Sway');
});
