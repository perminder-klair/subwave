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


test('runCapability refuses a co-hosted skill before model or TTS work on a solo show', async () => {
  const { writeSkillFile } = await import('../src/skills/scaffold.js');
  const { loadSkills } = await import('../src/skills/loader.js');
  const { runCapability } = await import('../src/skills/_agent.js');
  await writeSkillFile({ kind: 'solo-refusal', brief: 'Discuss one case.', cohosts: true });
  await loadSkills();
  await assert.rejects(
    runCapability('solo-refusal', {}),
    /requires a co-hosted show/,
  );
});
