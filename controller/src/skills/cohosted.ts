// Return persona lines; queue.announceExchange owns TTS and playback.
// settings.llm.segmentRuntime selects model tool calls or code-side data gathering.
// Direct mode fetches and checks grounding before its single structured model call.

import { djAgent, djObject } from '../llm/sdk.js';
import { buildSegmentTools, fetchSegmentData, dataBlock } from '../llm/segment-tools.js';
import * as settings from '../settings.js';
import { cohostedSkillSchema, cohostedSkillSystem, soloSkillSchema, lookAheadSkillSchema, MAX_DISCUSSION_TURNS } from '../llm/internal/prompts/cohosted-skill.js';
import { beginSkillNotebook, cancelNotebookRun, stageNotebook, notebookPrompt } from './notebook.js';
import { notebookMemoryUpdateForTurns } from './notebook-schema.js';
import { discussionTurnPlan } from './discussion-structure.js';
import { findSkillPersona } from './special-guest.js';
import { renderLookAheadTeases } from './look-ahead.js';
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
  lines: Array<{ persona: Persona; text: string; meta?: Record<string, unknown> }> | null;
  memoryUpdate?: unknown;
  reason: string | null;
}

type CohostedObject = { memoryUpdate?: unknown; firstSummary?: string; secondSummary?: string; text?: unknown; reason?: unknown; air?: unknown; lines?: Array<{ speaker?: unknown; text?: unknown }> } | undefined;

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

// Notebook leases include generation and the subsequent wait for confirmed air.
export async function runCohostedCapability(args: Parameters<typeof generateCohostedCapability>[0]): Promise<CohostedResult> {
  if (!args.capability.notebook) return generateCohostedCapability(args);
  let lease;
  try { lease = beginSkillNotebook(args.capability.skill); }
  catch (error) { return { aired: false, lines: null, reason: `show skill notebook unavailable: ${(error as Error).message}` }; }
  try {
    const result = await generateCohostedCapability({ ...args,
      capability: { ...args.capability, notebookSnapshot: lease.snapshot },
      guests: args.capability.cohosts ? args.guests : [],
      situation: args.situation + notebookPrompt(lease.snapshot),
    });
    if (!result.aired || !result.lines) { cancelNotebookRun(lease); return result; }
    const metadata = stageNotebook(lease, result.memoryUpdate, result.lines);
    return { ...result, lines: result.lines.map((line, index) => ({ ...line, meta: { ...line.meta, ...metadata[index] } })) };
  } catch (error) { cancelNotebookRun(lease); throw error; }
}

async function generateCohostedCapability({
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
  const onAirHostId = host.id;
  // Resolve once before generation, with explicit tool casts taking precedence.
  const promptGuests: string[] = capability.cohosts ? capability.specialGuestNames || [] : [];
  const selectCast = capability.toolCast || promptGuests.length > 0;
  let source: any;
  if (selectCast || capability.notebook) {
    source = await fetchSegmentData(capability, context, segmentState, { speakerPersonaId: host.id });
    const blocked = standDownReason(capability, source);
    if (blocked) return { aired: false, lines: null, reason: blocked };
    if (selectCast) {
      if (capability.toolCast || (source && Object.hasOwn(source, 'speakerIds'))) {
        const ids = source?.speakerIds;
        if (!Array.isArray(ids) || !ids.length || ids.length > 4
          || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) {
          return { aired: false, lines: null, reason: 'invalid tool speaker IDs' };
        }
        const roster = settings.get().personas || [];
        const resolved = ids.map(id => id === host.id ? host : roster.find(persona => persona.id === id));
        if (resolved.some(persona => !persona)) return { aired: false, lines: null, reason: 'a requested skill speaker no longer exists' };
        [host, ...guests] = resolved as Persona[];
      } else {
        if (promptGuests.length !== 1 || !promptGuests[0]) {
          return { aired: false, lines: null, reason: 'use exactly one Special guest: Name line in the skill prompt' };
        }
        const identity = findSkillPersona(promptGuests[0]);
        if (!identity) return { aired: false, lines: null, reason: `special guest “${promptGuests[0]}” is missing or ambiguous; use their exact persona name or ID` };
        if (identity.id === host.id) return { aired: false, lines: null, reason: 'the special guest is already the current host' };
        const guest = settings.get().personas.find(persona => persona.id === identity.id);
        if (!guest) return { aired: false, lines: null, reason: 'the special guest no longer exists' };
        if (!guests.some(persona => persona.id === guest.id)) guests = [...guests, guest];
        if (guests.length > 3) return { aired: false, lines: null, reason: 'special-guest discussions support at most four participants including the host' };
        source = { ...source, onAirHost: { id: host.id, name: host.name }, specialGuest: identity };
      }
    }
  }
  const cast = [host, ...guests];
  const turnCount = selectCast ? source?.turnCount ?? null : null;
  if (turnCount !== null && (!Number.isInteger(turnCount) || turnCount < 1 || turnCount > MAX_DISCUSSION_TURNS)) {
    return { aired: false, lines: null, reason: 'invalid discussion turn count' };
  }
  const grounded = requiresGrounding(capability);
  const solo = (selectCast || capability.notebook) && cast.length === 1;
  const lookAhead = solo && source?.speechFormat === 'look-ahead';
  const structure = solo ? { turns: null, reason: null }
    : discussionTurnPlan(capability.desc || '', cast, onAirHostId, source?.specialGuest?.id || null);
  if (structure.reason || (structure.turns && structure.turns.length > MAX_DISCUSSION_TURNS)) {
    return { aired: false, lines: null, reason: structure.reason || `discussion plans support at most ${MAX_DISCUSSION_TURNS} turns` };
  }
  const turnPlan = structure.turns;
  const system = cohostedSkillSystem({ capability: selectCast || capability.notebook ? { ...capability, toolCast: true } : capability, host, guests, grounded, lookAhead, turnCount, turnPlan });
  const baseSchema = lookAhead ? lookAheadSkillSchema : solo ? soloSkillSchema : cohostedSkillSchema(cast, turnPlan);
  const schema = capability.notebook ? baseSchema.safeExtend({
    memoryUpdate: notebookMemoryUpdateForTurns(solo ? 1 : turnPlan?.length ?? MAX_DISCUSSION_TURNS).nullable(),
  }).superRefine((value, ctx) => {
    const output = value as CohostedObject;
    const update = value.memoryUpdate;
    if (!value.air) {
      if (update !== null) ctx.addIssue({ code: 'custom', path: ['memoryUpdate'], message: 'a silent segment must have no memory update' });
      return;
    }
    if (!update) {
      ctx.addIssue({ code: 'custom', path: ['memoryUpdate'], message: 'spoken notebook segments require a memory update' });
      return;
    }
    const turns = solo ? 1 : output?.lines?.length ?? 0;
    if (update.topic && update.topic.turn > turns) {
      ctx.addIssue({ code: 'custom', path: ['memoryUpdate', 'topic', 'turn'], message: 'topic references a missing generated turn' });
    }
    update.contributions.forEach((item, index) => {
      if (item.turn > turns) ctx.addIssue({ code: 'custom', path: ['memoryUpdate', 'contributions', index, 'turn'], message: 'contribution references a missing generated turn' });
    });
  }) : baseSchema;
  const ask = lookAhead ? 'Write only the two summary fields for the supplied shows; leave secondSummary empty when only one show is supplied.' : solo ? 'Write the single spoken segment now.' : 'Write the complete co-hosted discussion now.';

  let out: CohostedObject;

  if (selectCast || capability.notebook || settings.get().llm?.segmentRuntime === 'direct') {
    // Pool mode: fetch in code, decide in code, one structured call. A skill
    // that writes from the moment survives a failed fetch (it writes from its
    // brief, as it always could); a GROUNDED one doesn't get that degradation
    // — the discussion was supposed to be ABOUT what the fetch didn't return,
    // so there is no model call at all. Same rule, same wording, as the solo
    // pool path in runCapability.
    const data = selectCast || capability.notebook ? source : await fetchSegmentData(capability, context, segmentState);
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

  // Validate the complete speech/update contract before staging memory, including
  // callers supplying a custom generation runner. Flexible discussions use their actual length.
  if (capability.notebook) out = schema.parse(out) as CohostedObject;

  if (out?.air === false) {
    const reason = String(out.reason || '').trim() || 'nothing usable to discuss';
    if (forced && !grounded) throw new Error(`skill "${capability.skill || capability.kind}" declined the forced co-hosted discussion`);
    return { aired: false, lines: null, reason };
  }

  if (solo) {
    const text = lookAhead
      ? renderLookAheadTeases(source, String(out?.firstSummary || ''), String(out?.secondSummary || ''))
      : String(out?.text || '').trim();
    if (!text) throw new Error(`skill "${capability.skill || capability.kind}" produced no spoken segment`);
    return { aired: true, lines: [{ persona: host, text }], memoryUpdate: out?.memoryUpdate, reason: String(out?.reason || '').trim() || null };
  }

  const byId = new Map(cast.map((persona) => [persona.id, persona]));
  const discussion = cohostedSkillSchema(cast, turnPlan).parse(out);
  const lines = discussion.lines.map((line) => ({
    persona: byId.get(String(line.speaker || '')),
    text: String(line.text || '').trim(),
  }));
  if (lines.some(line => !line.persona || !line.text)) {
    throw new Error(`skill "${capability.skill || capability.kind}" produced no co-hosted discussion`);
  }
  return {
    aired: true,
    memoryUpdate: out?.memoryUpdate,
    lines: lines as Array<{ persona: Persona; text: string }>,
    reason: String(out?.reason || '').trim() || null,
  };
}
