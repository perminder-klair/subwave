// One ownership seam for the stateless listener-request paths. Both the normal
// cascade and "more like this" spend model time before queueing; capture the
// writer before that work and validate the result after echo-guard regeneration.

import * as dj from '../llm/dj.js';
import { withDeadline } from '../llm/sdk.js';
import { guardIntro } from '../util/request-guard.js';
import { autoVoiceAllowed } from './voice-policy.js';
import { requestsAllowed } from './dj-budget.js';
import * as session from './session.js';
import type { Persona } from './queue/types.js';
import type { HostSpeechStamp } from './session.js';

export interface QueuedRequestIntro {
  introScript: string | null;
  introPersona: Persona | null;
  introHostSpeech: HostSpeechStamp | null;
  guard: string | null;
  failure?: string | null;
}

export async function generateQueuedRequestIntro(
  args: Record<string, unknown>,
  requestText: string,
  generate: (args: Record<string, unknown>) => Promise<string> = dj.generateIntro,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<QueuedRequestIntro> {
  const owner = session.captureAutomaticHostSpeech(session.onAirPersona());
  const deadlineAt = options.timeoutMs == null ? null : Date.now() + Math.max(0, options.timeoutMs);
  const runGenerate = async (input: Record<string, unknown>): Promise<string> => {
    const withSignal = options.signal ? { ...input, signal: options.signal } : input;
    if (deadlineAt == null) return generate(withSignal);
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new Error('request intro deadline');
    return withDeadline(remaining, 'request intro', deadlineSignal => {
      const signal = options.signal && deadlineSignal
        ? AbortSignal.any([options.signal, deadlineSignal])
        : options.signal || deadlineSignal;
      return generate(signal ? { ...input, signal } : input);
    });
  };
  // Past the hard token cap with requests not exempt, the request still
  // queues and acks; it just airs without a written intro.
  try {
    const script = autoVoiceAllowed() && requestsAllowed()
      ? await runGenerate({ ...args, requestText, persona: owner.persona })
      : null;
    // The retry must see no listener-derived text at all, or it can echo again:
    // the request text is withheld, and so is the missed artist's NAME (the miss
    // itself stays flagged, so the retry is still honest about the stand-in).
    const { missedArtist: _missedArtist, ...withoutListenerText } = args;
    const guarded = await guardIntro(script, requestText, () =>
      runGenerate({ ...withoutListenerText, persona: owner.persona }));
    const current = session.finalizeAutomaticHostSpeech(guarded.script, owner);
    return {
      introScript: current.text,
      introPersona: current.persona,
      introHostSpeech: current.hostSpeech,
      guard: guarded.guard,
    };
  } catch (err) {
    console.error(`[request] optional intro failed: ${err instanceof Error ? err.message : String(err)}`);
    return { introScript: null, introPersona: null, introHostSpeech: null, guard: null, failure: 'intro-failed' };
  }
}
