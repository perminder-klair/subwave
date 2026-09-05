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
// engine whose id-space it plausibly belongs to:
//
//   inherit → piper / kokoro / chatterbox / pocket-tts   keep the persona voice
//   inherit → cloud                                       station cloud voice
//   inherit → remote                                      the server's default
//
// Keeping it for the local engines is what makes the seed roster byte-identical
// on a fresh install: three personas with distinct piper voices still sound
// like three people. Dropping it for cloud/remote is what stops a Piper voice
// id ("bm_george") arriving at OpenAI or the DJ Brain as a voice NAME, where it
// is either a 400 or a silent substitution — the failure this module was
// written for.
//
// Pure over its two inputs so the whole policy is unit-pinned
// (scripts/persona-engine.test.ts) rather than inferred from the call site.

import {
  PERSONA_TTS_INHERIT,
  TTS_LOCAL_ENGINES,
  type TtsVoiceSlot,
} from '../schemas/persona.js';

// personasPinningOtherEngine lives in schemas/persona.ts, not here: the admin
// DJ Brain section needs it in the BROWSER, and only src/schemas/** is mirrored
// into web/lib/schemas.generated.ts. Re-exported so controller call sites still
// find it beside the resolver it belongs with.
export { personasPinningOtherEngine } from '../schemas/persona.js';

/** The slice of `settings.tts` the resolution depends on. */
export interface StationVoiceDefaults {
  /** settings.tts.defaultEngine — the engine an inherit slot resolves to. */
  defaultEngine?: unknown;
  /** settings.tts.cloud — provider + voice used when that engine is 'cloud'. */
  cloud?: { provider?: unknown; voice?: unknown } | null;
}

const LOCAL: readonly string[] = TTS_LOCAL_ENGINES;

/**
 * Resolve a persona voice slot against the station defaults.
 *
 * Returns the slot unchanged unless its engine is the inherit sentinel. Null in
 * (the global-voice kinds, which deliberately carry no persona) is null out, so
 * callers can hand this whatever djPersonaTts() gave them.
 */
export function resolvePersonaVoiceSlot<T extends Partial<TtsVoiceSlot> | null | undefined>(
  slot: T,
  station: StationVoiceDefaults | null | undefined,
): T extends null | undefined ? T : TtsVoiceSlot;
export function resolvePersonaVoiceSlot(
  slot: Partial<TtsVoiceSlot> | null | undefined,
  station: StationVoiceDefaults | null | undefined,
): TtsVoiceSlot | null | undefined {
  if (!slot) return slot as null | undefined;
  if (slot.engine !== PERSONA_TTS_INHERIT) return slot as TtsVoiceSlot;

  // The station default is the whole point of the sentinel; 'piper' is the same
  // floor settings.load() coerces an unreadable defaultEngine to, so a broken
  // settings file resolves to the universal engine rather than to nothing.
  const engine =
    typeof station?.defaultEngine === 'string' && station.defaultEngine
      ? station.defaultEngine
      : 'piper';

  // gainDb and speed are per-persona dials, not per-engine ones — they survive
  // the resolution untouched whatever speaks.
  const gainDb = typeof slot.gainDb === 'number' ? slot.gainDb : 0;
  const speed = typeof slot.speed === 'number' ? slot.speed : 1;

  if (engine === 'cloud') {
    const cloud = station?.cloud || {};
    return {
      engine,
      // The station's provider AND the station's voice: an inherit slot has
      // never named a cloud provider, and its voice belongs to another
      // id-space. Both come from the block the operator configured together.
      cloudProvider: typeof cloud.provider === 'string' && cloud.provider ? cloud.provider : 'openai',
      voice: typeof cloud.voice === 'string' ? cloud.voice : '',
      gainDb,
      speed,
    };
  }

  return {
    engine,
    // Carried through so a later reroute onto `cloud` (the rescue chain's
    // configured rung) still has a provider to check keys against; it is read
    // only while the engine IS cloud, which this branch is not.
    cloudProvider:
      typeof slot.cloudProvider === 'string' && slot.cloudProvider ? slot.cloudProvider : 'openai',
    // Local engines share the seed roster's id-space, so the persona voice
    // stands; `remote` ids are server-specific, so it does not.
    voice: LOCAL.includes(engine) && typeof slot.voice === 'string' ? slot.voice : '',
    gainDb,
    speed,
  };
}
