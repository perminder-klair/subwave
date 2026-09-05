// Dedicated co-hosted skill generation. This module owns the dynamic cast
// schema and the selected skill's data-gathering run, but returns only
// air-ready persona lines; queue.announceExchange remains the sole TTS/playback
// boundary.
//
// TWO RUN SHAPES, chosen exactly the way every other segment path chooses one
// (`settings.llm.pickerAgent`, the same branch as runSimpleDirector and
// runCapability in _agent.ts):
//
//   agent mode — the skill's own tool loop, the model calls the tool itself and
//     `onResult` records what it actually got back;
//   pool mode  — the tool is called in CODE, an unusable result stands the
//     discussion down before any model call, and one structured djObject call
//     writes the discussion with the data inlined.
//
// Running the tool loop in pool mode was the bug: pool mode exists precisely
// for operators whose model is not trusted with tool loops, so a grounded
// co-hosted skill could never satisfy its grounding check there (the tool is
// only reachable by a model tool call), standing down every tick after burning
// a full agent run against the deadline.

import { djAgent, djObject } from '../llm/sdk.js';
import { buildSegmentTools, fetchSegmentData, dataBlock } from '../llm/segment-tools.js';
import * as settings from '../settings.js';
import { cohostedSkillSchema, cohostedSkillSystem } from '../llm/internal/prompts/cohosted-skill.js';
import { requiresGrounding, standDownReason } from './abstain-policy.js';

interface Persona {
  id: string;
  name?: string;
  soul?: string;
  language?: string;
  tts?: unknown;
  [key: string]: unknown;
}

interface CohostedResult {
  aired: boolean;
  lines: Array<{ persona: Persona; text: string }> | null;
  reason: string | null;
}

type CohostedObject = { reason?: unknown; air?: unknown; lines?: Array<{ speaker?: unknown; text?: unknown }> } | undefined;

type AgentRunner = (args: Record<string, unknown>) => Promise<{ object?: unknown; steps?: number; toolCalls?: unknown[] }>;
type ObjectRunner = (args: Record<string, unknown>) => Promise<unknown>;

function agentDeadlineMs(): number {
  return settings.get().llm?.agentTimeoutMs ?? 45000;
}

// Wall-clock guard for the pool path's single structured call, the same reason
// deadlinedSegmentObject exists in _agent.ts: djObject carries no deadline of
// its own and a grammar-constrained model can ramble inside an unbounded string
// field all the way to the output-token cap. The agent path gets the same
// ceiling through djAgent's own `timeoutMs`.
async function deadlinedObject(runObject: ObjectRunner, args: Record<string, unknown>): Promise<unknown> {
  const ms = agentDeadlineMs();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`co-hosted segment call exceeded ${ms}ms deadline`)), ms);
  try {
    return await runObject({ ...args, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function runCohostedCapability({
  capability, host, guests, context, situation, segmentState, forced = false,
  runAgent = djAgent as unknown as AgentRunner,
  runObject = djObject as unknown as ObjectRunner,
}: {
  capability: any;
  host: Persona;
  guests: Persona[];
  context: any;
  situation: string;
  segmentState: any;
  forced?: boolean;
  runAgent?: AgentRunner;
  runObject?: ObjectRunner;
}): Promise<CohostedResult> {
  const cast = [host, ...guests];
  const grounded = requiresGrounding(capability);
  const system = cohostedSkillSystem({ capability, host, guests, grounded });
  const schema = cohostedSkillSchema(cast);
  const ask = 'Write the complete co-hosted discussion now.';

  let out: CohostedObject;

  if (!settings.get().llm?.pickerAgent) {
    // Pool mode: fetch in code, decide in code, one structured call. A skill
    // that writes from the moment survives a failed fetch (it writes from its
    // brief, as it always could); a GROUNDED one doesn't get that degradation
    // — the discussion was supposed to be ABOUT what the fetch didn't return,
    // so there is no model call at all. Same rule, same wording, as the solo
    // pool path in runCapability.
    const data = await fetchSegmentData(capability, context, segmentState);
    const blocked = standDownReason(capability, data);
    if (blocked) return { aired: false, lines: null, reason: blocked };
    out = await deadlinedObject(runObject, {
      system,
      prompt: `${situation}${data && !data.error ? dataBlock(data) : ''}\n\n${ask}`,
      schema,
      temperature: 0.9,
      kind: 'generateCohostedSkill',
    }) as CohostedObject;
  } else {
    // Agent mode: the model calls the skill's tool itself, so the grounding
    // check runs on what the tool reported back rather than on what the prompt
    // asked for. A single usable result clears the run; the reason kept is the
    // most recent failure, for the log.
    let usableSeen = false;
    let blocked: string | null = null;
    const tools = buildSegmentTools(context, segmentState, [capability], {
      onResult: (_kind, data) => {
        const why = standDownReason(capability, data);
        if (why) blocked = why;
        else usableSeen = true;
      },
    });

    const { object } = await runAgent({
      system,
      messages: [{ role: 'user', content: `${situation}\n\n${ask}` }],
      tools,
      schema,
      // Discovery (step 0) + exactly one committed done-tool attempt (step 1),
      // pinned for the same reason as directorAgent's cap in _agent.ts: djAgent's
      // default of 8 grows an "I already declined" trail on providers that don't
      // comply on the first forced attempt, and was the direct cause of a run
      // burning the FULL agentTimeoutMs before recovery got a turn (#555).
      maxSteps: 2,
      temperature: 0.9,
      kind: 'generateCohostedSkill',
      timeoutMs: agentDeadlineMs(),
    });
    out = object as CohostedObject;

    if (!usableSeen && grounded) {
      return {
        aired: false,
        lines: null,
        reason: blocked || 'the skill obtained no usable source data for the discussion',
      };
    }
  }

  if (out?.air === false) {
    const reason = String(out.reason || '').trim() || 'nothing usable to discuss';
    if (forced && !grounded) throw new Error(`skill "${capability.skill || capability.kind}" declined the forced co-hosted discussion`);
    return { aired: false, lines: null, reason };
  }

  const byId = new Map(cast.map((persona) => [persona.id, persona]));
  const lines = (out?.lines || []).map((line) => ({
    persona: byId.get(String(line.speaker || '')),
    text: String(line.text || '').trim(),
  }));
  if (lines.length !== cast.length || lines.some((line) => !line.persona || !line.text)) {
    throw new Error(`skill "${capability.skill || capability.kind}" produced no co-hosted discussion`);
  }
  return {
    aired: true,
    lines: lines as Array<{ persona: Persona; text: string }>,
    reason: String(out?.reason || '').trim() || null,
  };
}
