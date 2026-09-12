// Dedicated co-hosted skill generation. This module owns the dynamic cast
// schema and the selected skill's data-gathering run, but returns only
// air-ready persona lines; queue.announceExchange remains the sole TTS/playback
// boundary.
//
// The skill's provider is called in code. An unusable result stands a grounded
// discussion down before any model call; one structured djObject call then
// writes the discussion with the approved data inlined.

import { djObject } from '../llm/sdk.js';
import { fetchSegmentData, dataBlock } from '../llm/segment-tools.js';
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

type ObjectRunner = (args: Record<string, unknown>) => Promise<unknown>;

function agentDeadlineMs(): number {
  return settings.get().llm?.agentTimeoutMs ?? 45000;
}

// Wall-clock guard for the single structured call, the same reason
// deadlinedSegmentObject exists in _agent.ts: djObject carries no deadline of
// its own and a grammar-constrained model can ramble inside an unbounded string
// field all the way to the output-token cap.
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
  runObject = djObject as unknown as ObjectRunner,
}: {
  capability: any;
  host: Persona;
  guests: Persona[];
  context: any;
  situation: string;
  segmentState: any;
  forced?: boolean;
  runObject?: ObjectRunner;
}): Promise<CohostedResult> {
  const cast = [host, ...guests];
  const grounded = requiresGrounding(capability);
  const system = cohostedSkillSystem({ capability, host, guests, grounded });
  const schema = cohostedSkillSchema(cast);
  const ask = 'Write the complete co-hosted discussion now.';

  const data = await fetchSegmentData(capability, context, segmentState);
  const blocked = standDownReason(capability, data);
  if (blocked) return { aired: false, lines: null, reason: blocked };
  const out = await deadlinedObject(runObject, {
    system,
    prompt: `${situation}${data && !data.error ? dataBlock(data) : ''}\n\n${ask}`,
    schema,
    temperature: 0.9,
    kind: 'generateCohostedSkill',
  }) as CohostedObject;

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
