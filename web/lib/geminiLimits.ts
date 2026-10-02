// Ceiling on `settings.tts.gemini.pronunciation` — the station's free-text
// pronunciation note, appended to the composed delivery prompt on every Gemini
// render.
//
// Deliberately NOT in `lib/schemas.generated.ts`. The mirror is a flat
// concatenation of `controller/src/schemas/*.ts`, and a file under
// `src/schemas/` may import only `zod`, so a constant that is a bound on the
// engine's prompt rather than a validated vocabulary has no zod schema to live
// in. It also has to agree with the engine's own VOICE_STYLE_MAX budget, which
// lives in `controller/src/audio/gemini.ts` — that file cannot be imported from
// the web package at all.
//
// So it is stated twice, once per package, and pinned by a controller test that
// reads this file. A drift between the two would make the admin Textarea stop
// accepting input at a different length from the save path rejecting it, which
// is exactly the kind of disagreement a mirrored constant exists to prevent.
export const GEMINI_PRONUNCIATION_MAX = 300;