// Resolving a persona's voice slot against the station's TTS settings.
//
// A slot may name a concrete engine or the 'inherit' sentinel ("use the station
// default"). The sentinel is resolved ONCE here, at the seam where the slot is
// read; everything downstream compares against a concrete engine id.
//
// The voice rule is the subtle half: a voice id on an inherit slot was chosen
// without knowing which engine would speak it, so it carries only to piper and
// kokoro, which share one id-space (#454). Every other engine takes the
// station's voice or its own default, since an empty voice already means "use
// your own default" to all of them. Carrying it would send a Piper voice id to
// OpenAI as a voice NAME, or to chatterbox as a reference WAV that does not
// exist, failing every line.
//
// The implementation lives in schemas/persona.ts because only src/schemas/** is
// mirrored to web/lib/schemas.generated.ts, and the admin persona editor must
// answer "which engine will this persona actually use" identically to the
// server. This module stays the controller's import seam.
// Pinned by scripts/persona-engine.test.ts.
export {
  personasPinningOtherEngine,
  resolvePersonaVoiceSlot,
  type StationVoiceDefaults,
} from '../schemas/persona.js';

