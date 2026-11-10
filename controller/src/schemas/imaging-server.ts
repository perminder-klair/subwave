// Server-only imaging rules. The voice slot validator lives in schemas/persona.ts,
// and schemas/imaging.ts may import only zod so it can be copied into the
// browser bundle.
import { jingleCreateSchema } from './imaging.js';
import { ttsVoiceSlotSchema } from './persona.js';

// POST /jingles. `tts` is a persona-shaped voice slot; absent or 'inherit'
// means the station default voice. Only engine, voice and cloudProvider are
// used: a jingle has no persona pace or trim, so speed and gainDb are ignored.
export const jingleCreateBodySchema = jingleCreateSchema.extend({
  tts: ttsVoiceSlotSchema('tts', { allowInherit: true }).optional(),
});
