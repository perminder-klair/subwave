// DJ Doc's review pass: hand the assembled report to the model and get back an
// overall verdict plus prioritised advice. Everything the model sees is
// rendered here, so what it is asked to judge is readable in one place.
//
// Part of the doctor/ split - see ../doctor.ts for the section runner.

import { z } from 'zod';
import * as settings from '../settings.js';
import { primaryLeg, probeLegReachable, providerName, activeModelLabel } from '../llm/provider.js';
import { djObject } from '../llm/sdk.js';
import { budgetStatus } from '../broadcast/dj-budget.js';
import * as analyzer from '../music/analyzer.js';
import { DJ_DOC_KNOWLEDGE } from '../doctor-knowledge.js';
import type { DoctorReport, DoctorReview, FixId, StationSettings } from './types.js';
import { fmtTokens, isSchemaErrorMessage } from './util.js';
import { rememberReview } from './cache.js';

// ---------------------------------------------------------------------------
// reviewReport — hand the report to the LLM for a plain-English read.
// ---------------------------------------------------------------------------

const REVIEW_SCHEMA = z.object({
  overall: z
    .enum(['healthy', 'attention', 'critical'])
    .describe('one-word verdict for the whole station right now'),
  summary: z
    .string()
    .describe('2-4 sentences, plain English: how the station is doing and the single most important thing the operator should know'),
  priorities: z
    .array(
      z.object({
        title: z.string().describe('short imperative title of the thing to address'),
        severity: z.enum(['low', 'med', 'high']),
        why: z.string().describe('one sentence: why it matters for listeners or reliability'),
        suggestedFix: z.string().describe('the concrete next step the operator should take'),
        fixId: z
          .enum(['refresh-playlist', 'restart-mixer', 'generate-jingles', 'tag-library', 'subsonic-reset'])
          .nullable()
          .optional()
          .describe(
            'When this priority is resolved by one of the one-click fixes listed in the prompt, you MUST set this to that exact fix id (so the operator gets a button). Leave it out only when no listed fix applies.',
          ),
      }),
    )
    .describe('0-5 items, highest severity first; empty array when everything is healthy'),
});

const REVIEW_SYSTEM = [
  'You are DJ Doc — SUB/WAVE\'s resident station doctor. Picture a legendary West-Coast',
  'hip-hop producer-engineer who has mixed a thousand records: a sharp ear, zero patience for a',
  'muddy signal, and total confidence. You talk like a producer in the booth — a little swagger,',
  'the odd studio metaphor ("the low end\'s clean", "that channel\'s clipping", "tighten the mix")',
  '— but every call you make is technically correct. You review an automated health report for a',
  'personal internet radio station (Navidrome library, an LLM DJ, Liquidsoap mixer, Icecast stream,',
  'local/cloud TTS).',
  'A knowledge base about how SUB/WAVE works is provided below — USE IT. Ground every recommendation',
  'in it, and tailor model / picker / chain-of-thought / agent-deadline / budget / stream-encoder /',
  'TTS-engine advice to the HOST RESOURCES and CURRENT SETTINGS shown in the report (e.g. don\'t tell',
  'a small-CPU box to run Chatterbox, four stream encoders, or the agentic picker on a 9B model). The',
  '"Tuning" section and the settings snapshot spell out the current knob values — use them to spot',
  'settings that fight each other or the hardware, and say plainly which knob to change and to what.',
  'Interpret the findings for a non-expert operator: what is fine, what needs attention, what to do',
  'first. Be concrete and brief — keep the swagger to a light seasoning, no fluff, don\'t restate',
  'every finding. Prioritise anything that takes the station off air or starves the DJ (stream',
  'offline, Navidrome unreachable, LLM unreachable) above cosmetic warnings. Where it fits, nudge',
  'the operator toward good hygiene like taking a backup. If everything is healthy, say so plainly',
  'and return an empty priorities array.',
].join(' ');

export async function reviewReport(report: DoctorReport): Promise<DoctorReview> {
  // Gate on reachability so we never hang the panel on a dead LLM host.
  try {
    const leg = primaryLeg();
    const reachable = await probeLegReachable(leg);
    if (!reachable) {
      return { available: false, reason: `LLM host unreachable (${providerName()} · ${activeModelLabel()})` };
    }
  } catch (err) {
    return { available: false, reason: err?.message || 'LLM not configured' };
  }

  try {
    const review = await djObject({
      system: REVIEW_SYSTEM,
      prompt: [
        DJ_DOC_KNOWLEDGE,
        '\n---\n',
        renderSettingsSnapshot(),
        '',
        'Here is the latest station health report.',
        '',
        renderReportText(report),
        '',
        renderAvailableFixes(report),
        '',
        'Review it for the operator. Lean on the knowledge base above. Cross-reference the "Tuning"',
        'section and the current settings snapshot against the host resources, and tailor any model /',
        'picker / chain-of-thought / agent-deadline / budget / encoder / TTS recommendations to what',
        'this specific box can actually handle.',
      ].join('\n'),
      schema: REVIEW_SCHEMA,
      temperature: 0.5,
      kind: 'doctor:review',
    });
    const result: DoctorReview = { available: true, ...review };
    rememberReview(result);
    return result;
  } catch (err) {
    // A schema/shape mismatch here is itself a diagnosis: the review model can't
    // do structured output. Say so plainly instead of dumping the Zod error, and
    // point at the deterministic finding that survives a broken model.
    const reason = isSchemaErrorMessage(err)
      ? 'The review model returned output that doesn’t match the required shape — a sign the selected model is weak at structured output. See the LLM → “structured output” finding above; switching to a general instruction-tuned model fixes it.'
      : err?.message || 'review failed';
    return { available: false, reason };
  }
}

// A failed LLM call whose error is a schema/shape mismatch (Zod) rather than a
// host being unreachable — the fingerprint of a model that can't reliably produce
// structured output. Matched on message text so it works across providers.

function renderSettingsSnapshot(): string {
  let s: StationSettings | null = null;
  try { s = settings.get(); } catch { return ''; }
  const llm: NonNullable<StationSettings['llm']> = s?.llm || {};
  const st: NonNullable<StationSettings['stream']> = s?.stream || {};
  const mounts = ['mp3'];
  if (st.opusEnabled) mounts.push('opus');
  if (st.flacEnabled) mounts.push('flac');
  if (st.aacEnabled) mounts.push('aac');

  let budget = 'unlimited';
  try {
    const b = budgetStatus();
    budget = b.enabled
      ? `${fmtTokens(b.usedToday)}/${fmtTokens(b.cap)} today (soft ${b.softPct}%, mode ${b.mode})`
      : 'unlimited';
  } catch { /* budget best-effort */ }

  let analyzerLabel = 'unknown';
  try {
    analyzerLabel = analyzer.backendLabel();
    // Append the definitive CLAP capability so the AI review reasons from fact,
    // not from "local probably means lean" (issue #966's false warning).
    const clap = analyzer.audioEmbeddingAvailable();
    analyzerLabel += clap === null ? ' (CLAP unknown)' : clap ? ' (heavy: CLAP yes)' : ' (lean: no CLAP)';
  } catch { /* best-effort */ }

  return [
    '## Current settings (tune these against the findings + host resources)',
    `- LLM: ${providerName()} · ${activeModelLabel()} · pickerAgent ${llm.pickerAgent === false ? 'OFF' : 'ON'} · reasoning ${llm.reasoning ? 'ON' : 'OFF'} · agentDeadline ${Math.round(Number(llm.agentTimeoutMs || 0) / 1000)}s · numCtx ${llm.numCtx ?? 'n/a'} · toolChoice ${llm.toolChoice || 'required'} · maxOutputTokens ${llm.maxOutputTokens || 'default'}`,
    `- Budget: ${budget} · exemptRequests ${llm.exemptRequests === false ? 'OFF' : 'ON'} · pauseWhenEmpty ${llm.pauseWhenEmpty ? 'ON' : 'OFF'}`,
    `- Picking: noRepeatWindow ${llm.noRepeatWindow ?? 'n/a'} · requestWebResolve ${llm.requestWebResolve ? 'ON' : 'OFF'}`,
    `- Broadcast: crossfade ${s?.crossfadeDuration ?? '?'}s · jingle 1/${s?.jingleRatio ?? '?'} (${s?.jingleRotate === 'controller' ? 'controller' : 'mixer'}) · maxTrack ${s?.maxTrackSeconds ? s.maxTrackSeconds + 's' : 'unlimited'} · loudness ${s?.loudness?.targetLufs ?? '?'} LUFS · mounts ${mounts.join('+')} · archive ${s?.archive?.enabled ? 'ON' : 'OFF'}`,
    `- Voice: default TTS ${s?.tts?.defaultEngine || 'piper'}`,
    `- Analysis: audio.embeddings ${s?.audio?.embeddings ? 'ON' : 'OFF'} · vocalActivity ${s?.audio?.vocalActivity ? 'ON' : 'OFF'} · analyzer ${analyzerLabel}`,
    `- Search: ${s?.search?.provider || 'duckduckgo'}`,
  ].join('\n');
}

// Tell the reviewer which one-click fixes are actually applicable right now —
// the set of fix ids the findings surfaced this run — so it only attaches a
// `fixId` to a priority when the corresponding button really exists.
function renderAvailableFixes(report: DoctorReport): string {
  const seen = new Map<FixId, string>();
  for (const sec of report.sections) {
    for (const f of sec.findings) {
      if (f.fix && !seen.has(f.fix.id)) seen.set(f.fix.id, f.fix.label);
    }
  }
  if (!seen.size) {
    return 'One-click fixes available this run: none. Do NOT set fixId on any priority.';
  }
  const lines = [...seen.entries()].map(([id, label]) => `- ${id} — ${label}`);
  return [
    'One-click fixes available this run — for ANY priority that one of these resolves, you MUST set that',
    'priority\'s `fixId` to the exact id shown here (the operator then gets a working button, not just',
    'prose telling them to run it):',
    ...lines,
  ].join('\n');
}

// Compact, prompt-friendly rendering of the report — labels/status/detail/hint
// only, no big blobs.
function renderReportText(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`Summary: ${report.counts.ok} ok, ${report.counts.warn} warn, ${report.counts.fail} fail, ${report.counts.skip} skip.`);
  for (const sec of report.sections) {
    lines.push(`\n## ${sec.name}`);
    for (const f of sec.findings) {
      let line = `- [${f.status.toUpperCase()}] ${f.label}`;
      if (f.detail) line += `: ${f.detail}`;
      if (f.hint) line += ` — hint: ${f.hint}`;
      lines.push(line);
    }
  }
  return lines.join('\n');
}


