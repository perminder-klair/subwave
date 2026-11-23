// One ownership seam for the stateless listener-request paths. Both the normal
// cascade and "more like this" spend model time before queueing; capture the
// writer before that work and validate the result after echo-guard regeneration.

import * as dj from '../llm/dj.js';
import { guardIntro } from '../util/request-guard.js';
import { autoVoiceAllowed } from './voice-policy.js';
import { requestsAllowed } from './dj-budget.js';
import * as session from './session.js';
import type { Persona } from './queue/types.js';
import type { HostSpeechStamp } from './session.js';
import { dedicationSpeech } from '../alexa/dedications.js';
import type { RequestDedication } from './request-ledger.js';

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
): Promise<QueuedRequestIntro> {
  const owner = session.captureAutomaticHostSpeech(session.onAirPersona());
  const dedication = args.dedication as RequestDedication | null | undefined;
  const { dedication: _dedication, ...promptArgs } = args;
  // Past the hard token cap with requests not exempt, the request still
  // queues and acks; it just airs without a written intro.
  try {
    const script = autoVoiceAllowed() && requestsAllowed()
      ? await generate({ ...promptArgs, requestText, persona: owner.persona })
      : null;
    // The retry must see no listener-derived text at all, or it can echo again:
    // the request text is withheld, and so is the missed artist's NAME (the miss
    // itself stays flagged, so the retry is still honest about the stand-in).
    const { missedArtist: _missedArtist, ...withoutListenerText } = promptArgs;
    const guarded = await guardIntro(script, requestText, () =>
      generate({ ...withoutListenerText, persona: owner.persona }));
    const current = session.finalizeAutomaticHostSpeech(guarded.script, owner);
    const introScript = dedication?.target
      ? [dedicationSpeech(dedication.target, dedication.locale), current.text].filter(Boolean).join(' ')
      : current.text;
    return {
      introScript: introScript || null,
      introPersona: current.persona,
      introHostSpeech: current.hostSpeech,
      guard: guarded.guard,
    };
  } catch (err) {
    console.error(`[request] optional intro failed: ${err instanceof Error ? err.message : String(err)}`);
    // A dedication is user-visible request metadata, not optional LLM copy.
    // Keep the deterministic announcement when intro generation is unavailable.
    return {
      introScript: dedication?.target
        ? dedicationSpeech(dedication.target, dedication.locale)
        : null,
      introPersona: null,
      introHostSpeech: null,
      guard: null,
      failure: 'intro-failed',
    };
  }
}
