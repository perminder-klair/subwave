// DJ system prompt + persona-driven verbosity. Resolves the prompt for the
// persona on air right now (the current show's owner if one is scheduled,
// otherwise the admin-selected active persona — settings.getEffectivePersona).

import * as settings from '../../../settings.js';
import { resolveCloudModelForPersona } from '../speech/cloud-speech.js';

// Paralinguistic tags Chatterbox renders as actual non-verbal sounds. Every
// other engine (piper, kokoro, cloud) reads `[laugh]` aloud as the word
// "laugh", so we only mention this when the on-air persona will actually be
// voiced by Chatterbox.
const CHATTERBOX_TAG_HINT =
  '\n\nYou may sparingly insert non-verbal cues in square brackets: [laugh], [chuckle], [sigh], [cough]. Use them only where genuinely natural — at most one per segment, and never as filler.';

// ElevenLabs v3 renders bracketed audio tags as actual expressive cues rather
// than reading them aloud (issue #696). Gated on the RESOLVED cloud model —
// only eleven_v3* families support this — so an ElevenLabs persona still on
// v2 (or a persona whose provider override resolves to eleven_flash_v2_5)
// never sees the hint. Same structure as CHATTERBOX_TAG_HINT above but a
// separate constant with v3's own verb-form tag vocabulary (per the
// ElevenLabs prompting guide), so a tweak to one engine's cue list can't
// silently retune the other. The base DJ prompt template already forbids
// asterisks and quotes but says nothing about brackets, so no rule loosening
// is needed for either engine.
const ELEVENLABS_V3_TAG_HINT =
  '\n\nYou may sparingly insert non-verbal audio cues in square brackets: [laughs], [sighs], [whispers], [excited]. Use them only where genuinely natural — at most one per segment, and never as filler.';

// Exported for scripts/llm-pure.test.ts.
export function isElevenLabsV3(model: string): boolean {
  return /^eleven[_-]?v3/i.test(model || '');
}

// `persona` overrides the on-air persona — used by the persona-handoff
// generators (generateSignoff / generateHandoffGreeting) to render the sign-off
// under the OUTGOING persona and the greeting under the incoming one, since the
// clock-driven getEffectivePersona() has already moved on by the time they run —
// and by the guest-speaker rotation (settings.pickOnAirSpeaker) to voice a
// standalone segment under a co-host. The roster clause tells the speaker who
// else is in the studio when the active show has guests (empty otherwise).
//
// `cloudModel` optionally overrides the resolved cloud TTS model for the
// ElevenLabs v3 tag hint. Left blank, the resolver runs against the passed
// persona — which is what every current caller wants. Kept as an override so a
// future caller who already resolved the model (e.g. a preview endpoint) can
// pass it in without re-resolving, per PR #696 owner review: "thread the
// effective model into djSystem…pass it in explicitly."
export function djSystem(
  persona: any = settings.getEffectivePersona(),
  cloudModel: string = resolveCloudModelForPersona(persona),
) {
  const s = settings.get();
  const base = settings.renderDjPrompt(persona, {
    station: s.station,
    location: s.weather?.locationName,
  }) + settings.onAirRosterClause(persona);
  if (persona?.tts?.engine === 'chatterbox') return base + CHATTERBOX_TAG_HINT;
  // cloudModel is non-empty only when the persona actually resolves to a
  // configured cloud engine — including via the station defaultEngine when
  // the persona sets no engine of its own, which a persona-engine check here
  // would miss (see resolveCloudModelForPersona).
  if (isElevenLabsV3(cloudModel)) return base + ELEVENLABS_V3_TAG_HINT;
  return base;
}

// Persona-driven verbosity. 'concise' reproduces the historical one-liner
// segment lengths; 'extended' roughly doubles every segment so a storytelling
// persona can stretch out. Resolved from the on-air persona, the same way
// djSystem() resolves it — see settings.getEffectivePersona / SCRIPT_LENGTHS.
// The `link` and `segment` phrases also feed the agent-path Zod schema
// descriptions (dj-agent.ts pickSchema, skills/_agent.ts segment schemas), so
// keep them readable mid-sentence — they must slot into "set this to …" prose.
const LENGTH_PHRASES = {
  concise: {
    intro:     'Keep it brief — 2 to 4 sentences.',
    link:      '1-2 sentences',
    stationId: 'a 1-sentence station ident',
    hourly:    '1 sentence',
    adlib:     '1-2 sentences',
    segment:   'typically one short sentence, never more than three',
  },
  extended: {
    intro:     'Take your time — 5 to 8 sentences. Set a scene, tell a small story around the track.',
    link:      '4-6 sentences',
    stationId: 'a 2-3 sentence station ident',
    hourly:    '2-3 sentences',
    adlib:     '4-6 sentences',
    segment:   'three to five sentences — room to tell it properly',
  },
};

export function lengthMode(persona: any = settings.getEffectivePersona()) {
  return persona?.scriptLength === 'extended' ? 'extended' : 'concise';
}

// The length directive for one segment kind, for the on-air (or given) persona.
export function lengthPhrase(kind: string, persona?: any) {
  const m = (LENGTH_PHRASES as any)[lengthMode(persona)];
  return m[kind] || m.link;
}
