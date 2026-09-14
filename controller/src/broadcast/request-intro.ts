// One ownership seam for the stateless listener-request paths. Both the normal
// cascade and "more like this" spend model time before queueing; capture the
// writer before that work and validate the result after echo-guard regeneration.

import * as dj from '../llm/dj.js';
import { guardIntro } from '../util/request-guard.js';
import { autoVoiceAllowed } from './voice-policy.js';
import * as session from './session.js';
import type { Persona } from './queue/types.js';
import type { HostSpeechStamp } from './session.js';

export interface QueuedRequestIntro {
  introScript: string | null;
  introPersona: Persona | null;
  introHostSpeech: HostSpeechStamp | null;
  guard: string | null;
}

export async function generateQueuedRequestIntro(
  args: Record<string, unknown>,
  requestText: string,
  generate: (args: Record<string, unknown>) => Promise<string> = dj.generateIntro,
): Promise<QueuedRequestIntro> {
  const owner = session.captureAutomaticHostSpeech(session.onAirPersona());
  const script = autoVoiceAllowed()
    ? await generate({ ...args, requestText, persona: owner.persona })
    : null;
  const guarded = await guardIntro(script, requestText, () =>
    generate({ ...args, persona: owner.persona }));
  const current = session.finalizeAutomaticHostSpeech(guarded.script, owner);
  return {
    introScript: current.text,
    introPersona: current.persona,
    introHostSpeech: current.hostSpeech,
    guard: guarded.guard,
  };
}
