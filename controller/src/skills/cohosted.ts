// Dedicated co-hosted skill generation. This module owns the dynamic cast
// schema and the selected skill's tool loop, but returns only air-ready persona
// lines; queue.announceExchange remains the sole TTS/playback boundary.

import { djAgent } from '../llm/sdk.js';
import { buildSegmentTools } from '../llm/segment-tools.js';
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

type AgentRunner = (args: Record<string, unknown>) => Promise<{ object?: unknown; steps?: number; toolCalls?: unknown[] }>;

export async function runCohostedCapability({
  capability, host, guests, context, situation, segmentState, forced = false,
  runAgent = djAgent as unknown as AgentRunner,
}: {
  capability: any;
  host: Persona;
  guests: Persona[];
  context: any;
  situation: string;
  segmentState: any;
  forced?: boolean;
  runAgent?: AgentRunner;
}): Promise<CohostedResult> {
  const cast = [host, ...guests];
  const grounded = requiresGrounding(capability);
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
    system: cohostedSkillSystem({ capability, host, guests, grounded }),
    messages: [{ role: 'user', content: `${situation}\n\nWrite the complete co-hosted discussion now.` }],
    tools,
    schema: cohostedSkillSchema(cast),
    maxSteps: 8,
    temperature: 0.9,
    kind: 'generateCohostedSkill',
    timeoutMs: settings.get().llm?.agentTimeoutMs ?? 45000,
  });
  const out = object as { reason?: unknown; air?: unknown; lines?: Array<{ speaker?: unknown; text?: unknown }> } | undefined;

  if (grounded && !usableSeen) {
    return {
      aired: false,
      lines: null,
      reason: blocked || 'the skill obtained no usable source data for the discussion',
    };
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
