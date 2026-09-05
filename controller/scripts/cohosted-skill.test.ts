// Co-hosted skills: dynamic cast validation, persona mapping and grounded tool safety.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-cohosted-skill-'));

const { cohostedSkillSchema, cohostedSkillSystem } = await import('../src/llm/internal/prompts/cohosted-skill.js');
const { runCohostedCapability } = await import('../src/skills/cohosted.js');

const host = { id: 'p_host', name: 'Mara', soul: 'measured and sceptical', language: 'English', tts: { engine: 'piper' } };
const guests = [
  { id: 'p_ada', name: 'Ada', soul: 'forensic and precise', tts: { engine: 'openai' } },
  { id: 'p_sol', name: 'Sol', soul: 'empathetic and direct', tts: { engine: 'elevenlabs' } },
];
const cast = [host, ...guests];
const full = {
  reason: 'A grounded case gives the whole cast something distinct to discuss.',
  air: true,
  lines: [
    { speaker: 'p_host', text: 'The evidence changed how this case was understood. The investigation still raises difficult questions.' },
    { speaker: 'p_ada', text: 'The timeline is the part I keep returning to. It exposes where the inquiry lost focus.' },
    { speaker: 'p_sol', text: 'The family lived with that uncertainty for years. The outcome matters, but so does what the process cost them.' },
  ],
};

test('the prompt names the exact cast, skill brief, language, and 2–5 sentence contract', () => {
  const system = cohostedSkillSystem({
    capability: { kind: 'case-discussion', desc: 'Find one historical murder case and discuss the investigation.' },
    host, guests, grounded: true,
  });
  for (const p of cast) {
    assert.match(system, new RegExp(p.id));
    assert.match(system, new RegExp(p.name));
  }
  assert.match(system, /Find one historical murder case/);
  assert.match(system, /2–5 short sentences|2-5 short sentences/);
  assert.match(system, /English/);
  assert.match(system, /source data|tool/i);
  assert.match(system, /do not write speaker labels/i);
});

test('the schema accepts exactly one ordered contribution per real persona', () => {
  const schema = cohostedSkillSchema(cast);
  assert.deepEqual(schema.parse(full), full);
  assert.equal(schema.safeParse({ ...full, lines: full.lines.slice(0, 2) }).success, false, 'missing speaker');
  assert.equal(schema.safeParse({ ...full, lines: [full.lines[0], full.lines[0], full.lines[2]] }).success, false, 'duplicate speaker');
  assert.equal(schema.safeParse({ ...full, lines: [full.lines[1], full.lines[0], full.lines[2]] }).success, false, 'wrong order');
  assert.equal(schema.safeParse({ ...full, lines: [...full.lines.slice(0, 2), { speaker: 'p_fake', text: 'Invented.' }] }).success, false, 'unknown speaker');
  assert.equal(schema.safeParse({ ...full, lines: [{ ...full.lines[0], text: '' }, ...full.lines.slice(1)] }).success, false, 'empty contribution');
  assert.equal(schema.safeParse({ reason: 'No source.', air: false, lines: [] }).success, true, 'stand-down is representable');
});

test('a successful run maps immutable speaker ids back to the full persona objects', async () => {
  const result = await runCohostedCapability({
    capability: { kind: 'case-discussion', desc: 'Discuss one case.' },
    host, guests, context: {}, situation: 'The current moment.', segmentState: {}, forced: true,
    runAgent: async () => ({ object: full, steps: 0, toolCalls: [] }),
  });
  assert.equal(result.aired, true);
  assert.deepEqual(result.lines?.map((line: any) => line.persona), cast);
  assert.deepEqual(result.lines?.map((line: any) => line.text), full.lines.map(line => line.text));
});

test('a grounded skill must observe usable data before it may return dialogue', async () => {
  const capability = {
    kind: 'case-discussion', desc: 'Discuss one case.', toolName: 'skill_case_discussion',
    toolDesc: 'Search for one historical case.', toolInputs: { query: 'case to find' },
    toolFn: async () => ({ available: true, title: 'The case' }), config: {},
  };
  const result = await runCohostedCapability({
    capability, host, guests, context: {}, situation: 'The current moment.', segmentState: {}, forced: true,
    runAgent: async (args: any) => {
      await args.tools.skill_case_discussion.execute({ query: 'historical murder case' });
      return { object: full, steps: 1, toolCalls: [] };
    },
  });
  assert.equal(result.aired, true);
});

test('unavailable or failed grounded data stands down before any dialogue can air', async () => {
  for (const returned of [{ available: false }, { error: 'search offline' }]) {
    const capability = {
      kind: 'case-discussion', desc: 'Discuss one case.', toolName: 'skill_case_discussion',
      toolDesc: 'Search for one historical case.', toolFn: async () => returned, config: {},
    };
    const result = await runCohostedCapability({
      capability, host, guests, context: {}, situation: 'The current moment.', segmentState: {}, forced: true,
      runAgent: async (args: any) => {
        await args.tools.skill_case_discussion.execute({});
        return { object: full, steps: 1, toolCalls: [] };
      },
    });
    assert.equal(result.aired, false);
    assert.equal(result.lines, null);
    assert.ok(result.reason);
  }
});

test('the agent leg pins maxSteps at 2, never djAgent’s default of 8', async () => {
  // directorAgent's own cap documents the failure this reinstates: a taller
  // budget grows an "I already declined" trail on providers that don't comply
  // on the first forced attempt, and burned the FULL agentTimeoutMs before
  // recovery got a turn (#555).
  let seen: any = null;
  await runCohostedCapability({
    capability: { kind: 'case-discussion', desc: 'Discuss one case.' },
    host, guests, context: {}, situation: 'The current moment.', segmentState: {}, forced: true,
    runAgent: async (args: any) => { seen = args; return { object: full, steps: 1, toolCalls: [] }; },
  });
  assert.equal(seen.maxSteps, 2);
});

test('pool mode fetches in code and makes ONE structured call — never a tool loop', async () => {
  // llm.pickerAgent off means the operator's model isn't trusted with tool
  // loops. Running one anyway left a grounded co-hosted skill unable to ever
  // clear its grounding check (the tool is reachable only by a model tool
  // call), so it stood down every tick after a full wasted agent run.
  const settings = await import('../src/settings.js');
  await settings.load();
  await settings.update({ llm: { pickerAgent: false } });
  try {
    let toolCalls = 0;
    const capability = {
      kind: 'case-discussion', desc: 'Discuss one case.', toolName: 'skill_case_discussion',
      toolDesc: 'Search for one historical case.', config: {},
      toolFn: async () => { toolCalls += 1; return { available: true, headline: 'The Bakersfield file' }; },
    };
    let objectArgs: any = null;
    const result = await runCohostedCapability({
      capability, host, guests, context: {}, situation: 'The current moment.', segmentState: {}, forced: true,
      runAgent: async () => { throw new Error('pool mode must not run the skill tool loop'); },
      runObject: async (args: any) => { objectArgs = args; return full; },
    });
    assert.equal(result.aired, true);
    assert.equal(toolCalls, 1, 'the tool is called in code, exactly once');
    assert.equal(objectArgs.tools, undefined, 'the single structured call is offered no tools');
    assert.match(String(objectArgs.prompt), /Bakersfield/, 'the fetched source data is inlined into the prompt');
    assert.ok(objectArgs.signal, 'the unbounded djObject call carries a deadline signal');
  } finally {
    await settings.update({ llm: { pickerAgent: true } });
  }
});

test('pool mode stands a grounded discussion down BEFORE any model call', async () => {
  const settings = await import('../src/settings.js');
  await settings.update({ llm: { pickerAgent: false } });
  try {
    for (const returned of [{ available: false }, { error: 'search offline' }]) {
      const capability = {
        kind: 'case-discussion', desc: 'Discuss one case.', toolName: 'skill_case_discussion',
        toolDesc: 'Search for one historical case.', config: {},
        toolFn: async () => returned,
      };
      const result = await runCohostedCapability({
        capability, host, guests, context: {}, situation: 'The current moment.', segmentState: {}, forced: true,
        runAgent: async () => { throw new Error('no tool loop in pool mode'); },
        runObject: async () => { throw new Error('a model must not be asked to write from unusable data'); },
      });
      assert.equal(result.aired, false);
      assert.equal(result.lines, null);
      assert.ok(result.reason);
    }
  } finally {
    await settings.update({ llm: { pickerAgent: true } });
  }
});

test('a forced prompt-only discussion cannot decline or omit dialogue', async () => {
  await assert.rejects(
    runCohostedCapability({
      capability: { kind: 'case-discussion', desc: 'Discuss one case.' },
      host, guests, context: {}, situation: 'The current moment.', segmentState: {}, forced: true,
      runAgent: async () => ({ object: { reason: 'No.', air: false, lines: [] }, steps: 0, toolCalls: [] }),
    }),
    /produced no co-hosted discussion|declined/i,
  );
});


test('a solo show stands a forced co-hosted skill down — reported, not thrown', async () => {
  // The #1412 shape: a forced skill with nothing to say answers
  // `{aired: false, reason}` and POST /dj/skill returns 200 with the reason.
  // A solo hour is a normal, transient state, so it belongs in that shape
  // rather than in the 500 + red-booth-log path reserved for a misconfigured
  // skill (a missing API key, which cap.ready() still throws for).
  const { writeSkillFile } = await import('../src/skills/scaffold.js');
  const { loadSkills } = await import('../src/skills/loader.js');
  const { runCapability } = await import('../src/skills/_agent.js');
  const { queue } = await import('../src/broadcast/queue.js');
  await writeSkillFile({ kind: 'solo-refusal', brief: 'Discuss one case.', cohosts: true });
  await loadSkills();

  queue.djLog = [];
  const run = await runCapability('solo-refusal', {});
  assert.equal(run.aired, false, 'no model or TTS work happened');
  assert.equal(run.text, null);
  assert.match(String(run.reason), /requires a co-hosted show/);
  assert.ok(
    queue.djLog.some((e: any) => e.kind === 'scheduler' && /stood down — requires a co-hosted show/.test(e.message)),
    'the stand-down is in the booth log, not as an error',
  );
  assert.ok(
    !queue.djLog.some((e: any) => e.kind === 'error'),
    'a solo hour is not an error condition',
  );
});

test('the programme producer is only offered a co-hosted kind when the episode has guests', async () => {
  // The producer plans an hour around the kinds it is shown. Offering a
  // co-hosted skill to a solo episode plans a feature the beat can only fall
  // back out of, and the fallback is straight talk with no data behind it.
  const settings = await import('../src/settings.js');
  const { writeSkillFile } = await import('../src/skills/scaffold.js');
  const { loadSkills } = await import('../src/skills/loader.js');
  const { featureKindMenu } = await import('../src/broadcast/programme.js');
  await writeSkillFile({ kind: 'menu-cohosted', brief: 'Discuss one case.', cohosts: true });
  await writeSkillFile({ kind: 'menu-solo', brief: 'Talk about one thing.' });
  await loadSkills();
  await settings.update({ skills: { enabled: { 'menu-cohosted': true, 'menu-solo': true } } });

  const kinds = (hasCohosts: boolean) => featureKindMenu(null, hasCohosts).map(c => c.kind);
  assert.ok(kinds(true).includes('menu-cohosted'), 'a guest episode may plan the co-hosted feature');
  assert.ok(!kinds(false).includes('menu-cohosted'), 'a solo episode is never offered it');
  assert.ok(kinds(false).includes('menu-solo'), 'ordinary skills stay on the solo menu');
});
