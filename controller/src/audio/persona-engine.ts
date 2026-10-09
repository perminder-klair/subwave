// Resolve inherit to a concrete engine. Inherited voice ids carry only to
// piper/kokoro, which share an id-space (#454); other engines use station defaults.
// The implementation in schemas/persona.ts is mirrored to the admin editor.
// See scripts/persona-engine.test.ts.
export {
  personasPinningOtherEngine,
  resolvePersonaVoiceSlot,
  type StationVoiceDefaults,
} from '../schemas/persona.js';

