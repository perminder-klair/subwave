// Resolving a persona's voice slot against the station's TTS settings.
//
// A persona slot may name a concrete engine ('piper', 'cloud', …) or the
// sentinel 'inherit' — "use whatever the station is set to". Everything
// downstream of djPersonaTts() in audio/tts.ts (requestedEngine, resolveEngine,
// ttsTarget, personaCloudProvider, and every per-engine branch in speakWith)
// asks `personaTts.engine === '<engine>'`, so the sentinel is resolved ONCE
// here, at the seam where the slot is read, rather than taught to a dozen
// comparisons. A slot that names a real engine is returned untouched.
//
// Why the sentinel exists: without it, `tts.defaultEngine` was dead for any
// station that had personas. Every seeded persona pinned 'piper', a pinned
// engine beats the station default, and the persona schema requires a concrete
// engine — so an operator who switched the station to the cloud voice (or
// wired the hosted DJ Brain, which configures tts.cloud in one click) still
// heard Piper, silently, with nothing in the logs.
//
// The voice rule is the subtle half. A voice id on an inherit slot was chosen
// WITHOUT knowing which engine would speak it, so it may only carry to an
// engine that reads the field the same way:
//
//   inherit → piper / kokoro          keep the persona voice
//   inherit → chatterbox              the built-in voice (a .wav reference id)
//   inherit → pocket-tts              the configured default (a built-in id)
//   inherit → cloud                   the station cloud provider + voice
//   inherit → remote                  the server's own default
//
// Keeping it for piper/kokoro is what makes the seed roster byte-identical on a
// fresh install: three personas with distinct voices still sound like three
// people, and the strict schema already treats those two as one id-space (#454).
// Dropping it everywhere else is what stops a Piper voice id ("bm_george")
// arriving at OpenAI or the DJ Brain as a voice NAME — a 400 or a silent
// substitution — or at chatterbox as a reference WAV filename that does not
// exist, which fails the synth on every line and quietly pins the roster to the
// rescue chain. Both are the failure this module was written for.
//
// An empty voice is what every one of those engines already reads as "use your
// own default", so dropping it degrades to the engine's normal behaviour rather
// than to nothing.
//
// Pure over its two inputs so the whole policy is unit-pinned
// (scripts/persona-engine.test.ts) rather than inferred from the call site.

// The policy itself lives in schemas/persona.ts, not here, for one reason: the
// admin persona editor and the DJ Brain section must answer "which engine will
// this persona ACTUALLY use, and does its voice survive?" identically to the
// server, and only src/schemas/** is mirrored into web/lib/schemas.generated.ts.
// A second copy written for the browser is a copy that drifts — and the drift
// is invisible, because the UI would keep claiming the persona is on an engine
// it is not. The rules stay pure and zod-free, so they mirror cleanly.
//
// This module remains the controller's import seam so call sites read the
// resolver beside the dispatcher it feeds, and so this rationale sits where
// someone changing the resolution will look for it.
export {
  personasPinningOtherEngine,
  resolvePersonaVoiceSlot,
  type StationVoiceDefaults,
} from '../schemas/persona.js';

