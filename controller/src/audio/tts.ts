// TTS dispatcher — picks an engine per voice-kind, with a settings-driven
// override and an automatic fallback if the chosen engine fails.
//
// All callers (queue.js, jingles.js, scheduler.js) now go through here
// instead of importing piper.js or kokoro.js directly.

import * as piper from './piper.js';
import * as kokoro from './kokoro.js';
import { applyEdgeFades } from './wav-edges.js';
import * as chatterbox from './chatterbox.js';
import * as pocketTts from './pocketTts.js';
import { heavyEnabledEngines } from './ttsHeavyClient.js';
import * as remoteTts from './remoteTts.js';
import { normalizeForSpeech } from './speech-text.js';
import { scrubCjkForSpeech } from './spoken-script-policy.js';
import {
  configuredSlot, fallbackTextFor, orderedFallbacks, sameTtsTarget,
  type RescueSlot, type TtsTarget,
} from './tts-fallback.js';
import { localizedPreviewText } from './preview-text.js';
import * as cloud from '../llm/speech.js';
import { stripThinking } from '../llm/sdk.js';
import * as settings from '../settings.js';
import { recordTts } from '../stats.js';
import { energyForDaypart } from '../context.js';

export const ENGINES = ['piper', 'kokoro', 'chatterbox', 'pocket-tts', 'cloud', 'remote'];

// `kind` is passed by the caller and used to look up an engine override in
// settings; unknown kinds fall back to default. The live set of kinds comes
// from the skills capability table (`skills/_agent.ts` CAPABILITIES) plus the
// scheduled ones below — there is deliberately no second hardcoded list here
// to drift out of step with it.
//
// Every spoken segment — track intros, links, idents, weather, news, digs,
// facts — is voiced by the persona on air: engine and voice come from the
// effective persona's `tts` config. Only jingle rendering (a pre-recorded,
// persona-agnostic stinger) falls back to the global defaultEngine.
const GLOBAL_VOICE_KINDS = new Set(['jingle', 'default']);

// Which persona voices a segment: an explicit override (the persona-handoff
// mic-pass — broadcast/dj-agent.runPersonaHandoff — voices the OUTGOING persona
// even though the clock has already moved on to the incoming one), else the
// clock-driven effective persona. `null`/absent → today's behaviour exactly.
function personaFor(persona?: any): any {
  return persona ?? settings.getEffectivePersona();
}

// The persona's TTS config for a persona-voiced kind, else null. `persona`
// overrides the effective persona (persona handoff); absent → effective persona.
function djPersonaTts(kind: string, persona?: any): any {
  if (GLOBAL_VOICE_KINDS.has(kind)) return null;
  return personaFor(persona)?.tts || null;
}

// The engine the persona (or the global default) actually asked for, BEFORE
// resolveEngine()'s availability/key reroute. Recorded alongside the engine
// that truly spoke so a *resolve-time* fallback — e.g. a persona on pocket-tts
// when the tts-heavy sidecar is down, silently routed to piper — shows up in
// Stats as `fellBack`, instead of looking like a healthy piper call the
// operator never configured (issue #691). Mirrors describeRouting()'s
// `requested`.
function requestedEngine(kind: string, personaTts: any): string {
  if (personaTts && ENGINES.includes(personaTts.engine)) return personaTts.engine;
  return settings.get().tts?.defaultEngine || 'piper';
}

// Can this engine plausibly speak right now? The pre-flight availability/key
// gates, in one predicate so resolveEngine() (which picks the primary) and
// fallbackChain() (which picks the runtime rescue) can never disagree about
// what "installed" means.
//
// - `cloud` without a configured key would just throw and fall back — skip the
//   wasted API attempt. `cloudProvider` scopes the key check: a persona on
//   ElevenLabs needs that provider's key, not the global Cloud provider's.
// - `chatterbox` / `pocket-tts` are opt-in (--build-arg WITH_CHATTERBOX=1 /
//   WITH_POCKETTTS=1); without the venv there's no Python to spawn.
// - `kokoro` ships in the default image, but its model/voices files are pulled
//   at build time and can be missing if that download failed.
// - `remote` needs a configured URL AND a reachable sidecar (/health probe).
// - `piper` is local, keyless and always present — the universal floor.
function engineUsable(engine: string, cloudProvider?: string | null): boolean {
  if (!ENGINES.includes(engine)) return false;
  if (engine === 'cloud') return cloud.isConfigured(cloudProvider ?? null);
  if (engine === 'chatterbox') return chatterbox.isAvailable();
  if (engine === 'pocket-tts') return pocketTts.isAvailable();
  if (engine === 'kokoro') return kokoro.isAvailable();
  if (engine === 'remote') return remoteTts.isAvailable();
  return true;
}

// The persona's own cloud provider, but only when the persona is actually ON
// the cloud engine — otherwise the global Cloud provider applies.
function personaCloudProvider(personaTts: any): string | null {
  return (personaTts && personaTts.engine === 'cloud') ? (personaTts.cloudProvider ?? null) : null;
}

// The operator's configured rescue slot (settings.tts.fallback), or null when
// the block is absent or switched off. One reader for both trigger paths — the
// pre-flight reroute below and the mid-render chain — so they can never disagree
// about what the fallback is.
function fallbackSlot(): RescueSlot | null {
  return configuredSlot(settings.get().tts?.fallback, ENGINES);
}

// A slot for an engine chosen by the system rather than the operator: no voice
// override, so the engine speaks with its own global/baked-in default. See
// RescueSlot for why that null matters.
function plainSlot(engine: string): RescueSlot {
  return { engine, personaTts: null };
}

// What a render is actually aimed at: the engine, plus — for `cloud` alone —
// the provider inside it. The station default is deliberately NOT substituted
// here; that is sameTtsTarget's job, so "which provider does an unspecified
// cloud slot mean" has exactly one answer, shared with the pure chain builder
// (whose hardcoded rungs carry no override at all).
function ttsTarget(engine: string, personaTts: any): TtsTarget {
  return {
    engine,
    cloudProvider: engine === 'cloud' ? personaCloudProvider(personaTts) : null,
  };
}

// The station's Cloud provider — what an unspecified cloud target resolves to.
function defaultCloudProvider(): string | null {
  return settings.get().tts?.cloud?.provider ?? null;
}

// True when a segment did NOT go out on the target the persona asked for —
// a different engine, or (for cloud) a different provider inside the same
// engine. The engine-only comparison this replaces reported a fish-audio →
// ElevenLabs reroute as no fallback at all, hiding from the Stats page and
// /debug exactly the misconfiguration those surfaces exist to show (#1345).
function rerouted(
  requestedEngineId: string, requestedPersonaTts: any,
  actualEngine: string, actualPersonaTts: any,
): boolean {
  return !sameTtsTarget(
    ttsTarget(requestedEngineId, requestedPersonaTts),
    ttsTarget(actualEngine, actualPersonaTts),
    defaultCloudProvider(),
  );
}

// Which engine — and which VOICE — actually speaks a segment of `kind`.
// Returns a slot rather than an engine string because a reroute can now carry
// the operator's chosen fallback voice, which an engine id alone can't express.
// An ordinary (non-rerouted) resolve returns a null override, leaving the
// persona's own voice to be applied by the caller exactly as before.
function resolveEngine(kind: string, personaTts: any): RescueSlot {
  const tts = settings.get().tts || {};
  let chosen;
  if (personaTts && ENGINES.includes(personaTts.engine)) {
    chosen = personaTts.engine;          // persona owns the spoken engine
  } else {
    chosen = tts.defaultEngine || 'piper';   // jingle / fallback
  }
  if (!ENGINES.includes(chosen)) return plainSlot('piper');
  // Known-unavailable engine → route to the operator's configured fallback
  // (engine + voice) if they set one and it can speak, else to their saved
  // default engine, else Piper as the universal local floor — instead of
  // attempting a call that can only throw. Note this does NOT verify the
  // default is itself usable (except on the same-engine cloud hop below); if it
  // isn't, the runtime chain in speak() picks up the pieces.
  if (!engineUsable(chosen, personaCloudProvider(personaTts))) {
    // Probed with the fallback's OWN cloud provider, matching the credentials
    // the call would actually use — the same probe/call agreement rule the
    // mid-render chain follows.
    const configured = fallbackSlot();
    if (
      configured
      && rerouted(configured.engine, configured.personaTts, chosen, personaTts)
      && engineUsable(configured.engine, configured.personaTts?.cloudProvider ?? null)
    ) {
      return configured;
    }
    if (tts.defaultEngine && tts.defaultEngine !== chosen) return plainSlot(tts.defaultEngine);
    // Same engine id as the unusable primary — which only a DIFFERENT cloud
    // provider can survive (sameTtsTarget treats every other engine as its own
    // whole identity). A persona on a keyless Fish/openai-compatible target
    // should reach the station's own healthy Cloud provider rather than skip
    // past it to Piper, which is the pre-flight half of #1345; without it this
    // path and the mid-render chain below would disagree about the very hop
    // the chain now allows.
    //
    // Unlike the branch above this one is PROBED. That branch's leniency is
    // load-bearing history ("does NOT verify the default is itself usable"),
    // but this hop is new, and a station whose global Cloud provider is also
    // dead would otherwise buy a guaranteed-throwing API call on the way to
    // the same Piper it lands on today.
    if (
      tts.defaultEngine
      && rerouted(tts.defaultEngine, null, chosen, personaTts)
      && engineUsable(tts.defaultEngine, null)
    ) {
      return plainSlot(tts.defaultEngine);
    }
    return plainSlot('piper');
  }
  return plainSlot(chosen);
}

// Ordered runtime rescues after `primary` threw mid-render (cloud API 500,
// worker crash, network timeout — failures the pre-flight gate can't predict).
//
// Order: the operator's CONFIGURED fallback (their explicit second choice, and
// the only rung carrying a VOICE as well as an engine), then their default
// engine — skipping straight to Piper dropped a Kokoro-default station to the
// flattest voice in the box the moment a persona's provider hiccuped — then
// Piper as the universal local floor, then Kokoro for when Piper was primary.
//
// The hardcoded rungs are checked with the GLOBAL cloud provider (null), so a
// `cloud` rescue uses the station default's credentials rather than the ones
// that just failed; the configured rung uses its own. speak()'s chain loop hands
// speakWith() the slot's own `personaTts`, which agrees: null for every
// hardcoded rung, the operator's choice for the configured one.
//
// At most four attempts; the ordering is pure and pinned by
// scripts/tts-fallback.test.ts.
function fallbackChain(primary: TtsTarget): RescueSlot[] {
  return orderedFallbacks(
    primary,
    fallbackSlot(),
    settings.get().tts?.defaultEngine,
    (engine, cloudProvider) => engineUsable(engine, cloudProvider ?? null),
    defaultCloudProvider(),
  );
}

// Effective voice level trim (dB) for a spoken segment of `kind`: the resolved
// engine's per-engine gain (settings.tts.gainDb) plus the on-air persona's own
// trim (persona.tts.gainDb), clamped to ±TTS_GAIN_CLAMP_DB. Applied downstream
// by broadcast/queue.ts as a Liquidsoap `liq_amplify` annotation on the handoff
// file — the same mechanism music loudness uses. 0 = unity (no annotation
// written), i.e. today's behaviour. Uses the *resolved* engine (post
// availability/key fallback), so the gain matches the engine that will actually
// speak; the rare runtime-throw fallback inside speak() is an error path.
export function voiceGainDb(kind: string, persona?: any): number {
  const personaTts = djPersonaTts(kind, persona);
  const { engine } = resolveEngine(kind, personaTts);
  const tts: any = settings.get().tts || {};
  const engineGain = settings.clampTtsGain(tts.gainDb?.[engine]);
  const personaGain = personaTts ? settings.clampTtsGain(personaTts.gainDb) : 0;
  return settings.clampTtsGain(engineGain + personaGain);
}

// Effective speech-rate multiplier for a segment of `kind` (1.0 = engine default
// pace). Three factors multiply, clamped to [0.5, 2.0]: engine base x persona x
// daypart energy. The engine base applies UNIVERSALLY, jingles included,
// mirroring the env-base PIPER_SPEED/KOKORO_SPEED/CLOUD_TTS_SPEED behaviour;
// persona x daypart apply only to live persona-voiced kinds, since a jingle cut
// at 2am must not carry 2am pacing into a noon playout. `liveOverride` replaces
// the persona/daypart term but still composes with the engine base. Reads the
// RESOLVED engine (post availability/key fallback) so the rate matches whichever
// engine actually speaks, like voiceGainDb().
//
// Exported for the intro-budget word ceiling (#962): a persona at 0.8x fits
// fewer words in the same runway, so dj-agent.ts feeds this into
// dj.enforceIntroBudget().
export function speechPaceScale(kind: string, persona?: any, liveOverride?: number | null): number {
  const personaTts = djPersonaTts(kind, persona);
  const { engine: primary } = resolveEngine(kind, personaTts);
  const ttsCfg: any = settings.get().tts || {};
  const engineSpeed = settings.clampTtsSpeed(ttsCfg.speed?.[primary]);
  const live = liveOverride != null
    ? liveOverride
    : GLOBAL_VOICE_KINDS.has(kind)
      ? 1
      : (personaTts ? settings.clampTtsSpeed(personaTts.speed) : 1) * energyForDaypart().speed;
  // Bounds-clamp the product but do NOT snap to the 0.05 grid — the daypart
  // energy is a non-grid value, so at default knobs (all 1.0) the on-air scale
  // stays exactly today's daypart figure. Snapping happens only on the stored
  // per-engine / per-persona knobs (clampTtsSpeed above).
  return Math.min(settings.TTS_SPEED_MAX, Math.max(settings.TTS_SPEED_MIN, engineSpeed * live));
}

async function speakWith(engine: string, text: string, opts: any, personaTts: any) {
  if (engine === 'kokoro') {
    const voice = (personaTts && personaTts.engine === 'kokoro' && personaTts.voice)
      ? personaTts.voice
      : settings.get().tts?.kokoro?.voice;
    // Station-level language override — explicitly chosen phonemizer lang
    // (e.g. use a Japanese voice code for the accent but British phonemes for
    // English text). Absent → falls through to KOKORO_LANG env → auto-detect.
    const lang = opts.lang || settings.get().tts?.kokoro?.lang || undefined;
    return kokoro.speak(text, { ...opts, voice, lang });
  }
  if (engine === 'chatterbox') {
    // For chatterbox, persona's `voice` is a reference-WAV filename (resolved
    // by chatterbox.ts against config.chatterbox.voiceDir). Empty/missing →
    // built-in default voice.
    const voice = (personaTts && personaTts.engine === 'chatterbox' && personaTts.voice)
      ? personaTts.voice
      : settings.get().tts?.chatterbox?.referenceVoice;
    return chatterbox.speak(text, { ...opts, voice });
  }
  if (engine === 'pocket-tts') {
    // PocketTTS voice is a built-in id (alba, anna, …). Persona override wins;
    // otherwise the global pocketTts voice. The worker falls back to the
    // configured default if the id isn't recognised, so a stale persona
    // value never causes a silent segment.
    const voice = (personaTts && personaTts.engine === 'pocket-tts' && personaTts.voice)
      ? personaTts.voice
      : settings.get().tts?.pocketTts?.voice;
    return pocketTts.speak(text, { ...opts, voice });
  }
  if (engine === 'cloud') {
    // Persona picks provider + voice; the shared tts.cloud holds key + model.
    // `opts.cloudVoiceSettings` (preview-only, from synthesizeSample) rides the
    // same override so "Play sample" auditions UNSAVED ElevenLabs voice_settings
    // sliders — cloud-speech spreads the override over the saved tts.cloud, so
    // the live path (which never sets it) keeps reading saved values.
    const personaOverride = (personaTts && personaTts.engine === 'cloud')
      ? { provider: personaTts.cloudProvider, voice: personaTts.voice }
      : null;
    const cloudModelOverride = typeof opts.cloudModel === 'string' ? { model: opts.cloudModel } : null;
    const cloudOverride = (personaOverride || cloudModelOverride || opts.cloudVoiceSettings || opts.fishSettings)
      ? { ...(personaOverride || {}), ...(cloudModelOverride || {}), ...(opts.cloudVoiceSettings || {}), ...(opts.fishSettings || {}) }
      : null;
    return cloud.speak(text, { ...opts, cloudOverride });
  }
  if (engine === 'remote') {
    // Remote engine — persona's `voice` is forwarded as-is to the endpoint,
    // which interprets it (built-in id, reference-wav filename, or VoiceDesign
    // prompt). No global fallback voice — the endpoint owns its defaults.
    const voice = (personaTts && personaTts.engine === 'remote' && personaTts.voice)
      ? personaTts.voice
      : undefined;
    return remoteTts.speak(text, { ...opts, voice });
  }
  // For piper, persona's `voice` is an .onnx filename (resolved by piper.ts
  // against config.voices.dir). Empty/missing → the baked-in default voice.
  const voice = (personaTts && personaTts.engine === 'piper' && personaTts.voice)
    ? personaTts.voice
    : undefined;
  return piper.speak(text, { ...opts, voice });
}

// Display-text → spoken-text normalization (station branding, weather units,
// markdown emphasis, display symbols — issue #963) lives in the pure
// speech-text.ts module so it's unit-testable without this file's heavy deps.
// Applied at the two synthesis entry points below: speak() and synthesizeSample().

// Admin voice-preview ("Play sample"). Renders a one-off sample WAV with an
// EXPLICIT engine + voice, deliberately bypassing both the on-air persona
// resolution and the silent fallback chain in speak() — the operator wants to
// hear exactly the engine they picked, or get a real error if it's unavailable
// (sidecar down, no cloud key). A synthetic persona-shaped object routes the
// voice/provider through speakWith() the same way a live persona would. `speed`
// is the final rate multiplier to audition, clamped to the playout [0.5,2.0]
// band; gain (dB) is a playout-time mix trim and is intentionally NOT baked in.
// Returns the path to the generated WAV — the caller serves and unlinks it.
const PREVIEW_TEXT_MAX = 200;
const DEFAULT_PREVIEW_TEXT = "You're listening to SUB/WAVE. This is a voice preview.";

export async function synthesizeSample(
  { engine, voice = '', cloudProvider = 'openai', cloudModel, speed, lang, language, text, corrections, voiceSettings, fishSettings: requestedFishSettings, signal }: {
    engine: string;
    voice?: string;
    cloudProvider?: string;
    // Unsaved model id so preview validates the exact provider/model choice.
    cloudModel?: string;
    speed?: number;
    lang?: string;
    // Persona's free-text on-air language ("Turkish", "Türkçe"). When set and
    // no explicit `text` is given, the sample sentence is looked up in that
    // language (preview-text.ts) so the audition matches what the persona
    // sounds like on air; unrecognized/empty falls back to the English line.
    language?: string;
    text?: string;
    // Unsaved corrections override (admin "Test corrections" button, Speech
    // tab) — when present, used INSTEAD of settings.tts.corrections for this
    // one synth call. Sanitized by settings.normalizeTtsCorrections (the same
    // helper the persisted operator settings run through) so the preview can
    // never drift from what actually saves and airs; malformed input degrades
    // to no corrections rather than throwing.
    corrections?: unknown;
    // Unsaved provider controls to audition — same field names as
    // settings.tts.cloud so they merge straight into cloudOverride in
    // speakWith(). Sanitized here, like `speed`.
    voiceSettings?: {
      voiceStability?: number;
      voiceStyle?: number;
      voiceSimilarityBoost?: number;
      voiceUseSpeakerBoost?: boolean;
    };
    fishSettings?: {
      temperature?: number;
      topP?: number;
      latency?: 'low' | 'normal' | 'balanced';
    };
    signal?: AbortSignal;
  },
): Promise<string> {
  if (!ENGINES.includes(engine)) throw new Error(`Unknown engine: ${engine}`);
  const raw = (typeof text === 'string' && text.trim())
    ? text.trim()
    : (localizedPreviewText(language) ?? DEFAULT_PREVIEW_TEXT);
  const activeCorrections = corrections !== undefined
    ? settings.normalizeTtsCorrections(corrections)
    : settings.get().tts?.corrections;
  const sample = normalizeForSpeech(raw.slice(0, PREVIEW_TEXT_MAX), activeCorrections);
  const scale = settings.clampTtsSpeed(speed);
  let previewCloudModel: string | undefined;
  if (engine === 'cloud' && cloudModel !== undefined) {
    const v = String(cloudModel).trim();
    if (v.length < 1 || v.length > 100 || /[\r\n]/.test(v)) {
      throw new Error('Cloud preview model must be 1-100 characters with no line breaks');
    }
    previewCloudModel = v;
  }
  // Clamp the audition voice_settings to ElevenLabs' [0,1] the same way
  // settings.update() does for the saved values, so a hand-crafted preview
  // request can't 400 the provider call.
  const clamp01 = (n: unknown) =>
    typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : undefined;
  let cloudVoiceSettings: Record<string, number | boolean> | undefined;
  if (engine === 'cloud' && voiceSettings) {
    cloudVoiceSettings = {};
    for (const key of ['voiceStability', 'voiceStyle', 'voiceSimilarityBoost'] as const) {
      const v = clamp01(voiceSettings[key]);
      if (v !== undefined) cloudVoiceSettings[key] = v;
    }
    if (typeof voiceSettings.voiceUseSpeakerBoost === 'boolean') {
      cloudVoiceSettings.voiceUseSpeakerBoost = voiceSettings.voiceUseSpeakerBoost;
    }
    if (Object.keys(cloudVoiceSettings).length === 0) cloudVoiceSettings = undefined;
  }
  // Synthetic persona so speakWith() picks up the requested voice/provider
  // exactly (its per-engine branches key off personaTts.engine === <engine>).
  const personaTts = { engine, voice, cloudProvider };
  // No outPath → each engine self-generates a WAV path under config.piper.outDir
  // (reaped by cleanupOldVoices) and returns it.
  let fishSettings: Record<string, number | string> | undefined;
  if (engine === 'cloud' && requestedFishSettings) {
    fishSettings = {
      temperature: clamp01(requestedFishSettings.temperature) ?? settings.get().tts?.cloud?.temperature ?? 0.7,
      topP: clamp01(requestedFishSettings.topP) ?? settings.get().tts?.cloud?.topP ?? 0.7,
      latency: ['low', 'normal', 'balanced'].includes(requestedFishSettings.latency || '')
        ? requestedFishSettings.latency as string
        : settings.get().tts?.cloud?.latency || 'normal',
    };
  }
  return speakWith(engine, sample, { speedScale: scale, language: '', soul: '', lang, cloudModel: previewCloudModel, cloudVoiceSettings, fishSettings, signal }, personaTts);
}

// Public entry point. Tries the configured engine; on failure, falls back to
// a local engine so the DJ never goes silent because a model (or the network)
// failed. Piper is the universal fallback — local, keyless, fast.
//
// Every call is timed and recorded into the TTS ring buffer (stats.js) so the
// admin Stats page can show per-engine usage, latency, and the fallback rate.
export async function speak(
  text: string,
  { kind = 'default', outPath, speedScale, persona }: { kind?: string; outPath?: string; speedScale?: number; persona?: any } = {},
) {
  // Resolve the persona language before normalising the text: the same value
  // owns both the cloud pronunciation hint and the final unsupported-script
  // safety boundary. An unset persona language is the default English station.
  const language = GLOBAL_VOICE_KINDS.has(kind)
    ? ''
    : String(personaFor(persona)?.language || '').trim();
  // Belt-and-suspenders scrub of any leaked reasoning at the single point every
  // booth-bound string converges (follow-up to #949). The free-text generators
  // already stripThinking their output, but a reasoning model that leaks a
  // <think>/harmony token INTO a structured say/intro field (djObject/djAgent
  // native path) reaches TTS unscrubbed otherwise. No-op on clean text — those
  // literals never appear in a real script — so every non-LLM caller (jingles,
  // idents, request intros) is unaffected. Operator speech corrections
  // (settings.tts.corrections) ride along — read live, so a saved rule
  // applies to the very next spoken line, no restart.
  const normalizedText = normalizeForSpeech(stripThinking(text), settings.get().tts?.corrections);
  const speakText = GLOBAL_VOICE_KINDS.has(kind)
    ? normalizedText
    : scrubCjkForSpeech(normalizedText, language);
  // `persona` overrides the clock-driven effective persona so the persona-handoff
  // mic-pass can voice the outgoing DJ (engine, voice, language, soul, speed)
  // after the hour has flipped. Absent → getEffectivePersona(), i.e. today.
  const personaTts = djPersonaTts(kind, persona);
  // The engine that persona actually asked for, before resolveEngine()'s reroute
  // (#691) — resolves off the override-aware personaTts, so a handoff clip logs
  // the OUTGOING persona's requested engine.
  const requested = requestedEngine(kind, personaTts);
  const primarySlot = resolveEngine(kind, personaTts);
  const primary = primarySlot.engine;
  // Whose voice the primary render speaks with. An ordinary resolve leaves the
  // persona's own override in place; a pre-flight reroute onto the operator's
  // configured fallback carries THAT slot's voice instead, which is the whole
  // point of configuring one — otherwise the rescue engine would speak with its
  // global default and the operator's choice would apply only to mid-render
  // failures.
  const primaryPersonaTts = primarySlot.personaTts ?? personaTts;
  // Did the pre-flight gate move the segment off what the persona asked for?
  // Provider-aware, so a cloud→cloud reroute counts (see rerouted()).
  const primaryFellBack = rerouted(requested, personaTts, primary, primaryPersonaTts);
  // Engine-native bracket cues must reach the expressive primary untouched,
  // but a local/remote rescue would speak them literally. Resolve the exact
  // provider+model family used by djSystem() and sanitize only that rescue.
  const speakingPersona = GLOBAL_VOICE_KINDS.has(kind) ? null : personaFor(persona);
  const cloudCueFamily = requested === 'cloud' && speakingPersona
    ? cloud.requestedCloudExpressionCueFamilyForPersona(speakingPersona)
    : '';
  const rescueText = fallbackTextFor(requested, cloudCueFamily, speakText);
  const primaryText = primaryFellBack ? rescueText : speakText;
  // Persona on-air language (e.g. "French") rides along to the cloud engine as a
  // pronunciation hint so a non-English script isn't read with English phonetics
  // (issue #558). DJ-voiced kinds only — never jingles — and '' (ignored) for
  // the default English persona. Local engines ignore the field; only
  // cloud-speech.ts reads it (the voice model carries the language for piper /
  // kokoro / pocket-tts).
  // The persona's soul (e.g. "thoughtful and a little wistful") rides the same
  // path so the voice delivery carries the same character as the writing (issue
  // #579). DJ-voiced kinds only, like `language`; only the OpenAI gpt-4o*-tts
  // path in cloud-speech.ts reads it (its free-text `instructions` field), every
  // other engine ignores it.
  const soul = GLOBAL_VOICE_KINDS.has(kind)
    ? ''
    : String(personaFor(persona)?.soul || '').trim();
  // Delivery pace — engine base × persona × daypart (or the explicit
  // `speedScale` override), clamped to [0.5, 2.0]. All the semantics live in
  // speechPaceScale() above (shared with the intro-budget word ceiling); the
  // rare runtime-throw fallback below reuses this scale. All factors default
  // to 1.0, so a stock station is byte-for-byte unchanged.
  const scale = speechPaceScale(kind, persona, speedScale);
  const started = Date.now();
  const chars = (speakText || '').length;
  // Shared fields for every recordTts() outcome below. `text` is capped so the
  // ring buffer stays small (the admin debug panel polls the whole ring every
  // ~2s); `persona` names who voiced the segment (null for the global
  // jingle/default kinds), resolved through the same override path as the
  // engine so a handoff clip attributes to the outgoing DJ.
  const callBase = {
    kind, requested, chars,
    text: (speakText || '').slice(0, 240),
    persona: GLOBAL_VOICE_KINDS.has(kind) ? null : (personaFor(persona)?.name || null),
  };
  try {
    const result = await speakWith(primary, primaryText, { outPath, speedScale: scale, language, soul }, primaryPersonaTts);
    // Bake 40ms edge fades into the rendered clip so hard file boundaries
    // never reach the broadcast compressor as a click. Render time is the only
    // place the tail can be faded — see audio/wav-edges.ts. Best-effort:
    // non-WAV output (cloud mp3) is left as-is.
    if (typeof result === 'string') await applyEdgeFades(result);
    recordTts({
      ...callBase, engine: primary, fellBack: primaryFellBack,
      ok: true, ms: Date.now() - started, t: new Date().toISOString(),
    });
    return result;
  } catch (err) {
    // The primary passed the pre-flight gate but threw mid-render. Walk the
    // rescue chain — configured default engine, then Piper, then Kokoro — so
    // the DJ never goes silent because one provider hiccuped.
    const chain = fallbackChain(ttsTarget(primary, primaryPersonaTts));
    if (!chain.length) {
      recordTts({
        ...callBase, engine: primary, fellBack: primaryFellBack,
        ok: false, ms: Date.now() - started, error: err.message,
        t: new Date().toISOString(),
      });
      throw err;
    }
    let lastErr = err;
    let lastEngine = primary;
    for (const slot of chain) {
      const fallback = slot.engine;
      console.error(`[tts] ${lastEngine} failed for kind=${kind}: ${lastErr.message} — falling back to ${fallback}`);
      try {
        // The on-air persona's OWN tts is never forwarded to a rescue.
        // speakWith()'s per-engine branches read an override only when its
        // engine matches the one being spoken, and the chain excludes the
        // primary, so it is inert for every rescue EXCEPT one corner: a cloud
        // persona pre-flight-rerouted for an unconfigured provider, rescued onto
        // `cloud`. Forwarding there would re-apply the persona's dead
        // provider/voice instead of the credentials the chain probe just
        // validated.
        //
        // What DOES ride is the slot's own override — null for the hardcoded
        // rungs, the operator's engine+voice for their configured one, which is
        // the one case where an override is an explicit instruction rather than
        // a leftover. Probe and call agree either way; the persona's
        // `language`/`soul` hints still ride via opts.
        const result = await speakWith(fallback, rescueText, { outPath, speedScale: scale, language, soul }, slot.personaTts);
        if (typeof result === 'string') await applyEdgeFades(result);
        recordTts({
          ...callBase, engine: fallback, fellBack: true,
          ok: true, ms: Date.now() - started, t: new Date().toISOString(),
        });
        return result;
      } catch (err2) {
        lastErr = err2;
        lastEngine = fallback;
      }
    }
    // Every rescue failed too — record against the last engine attempted.
    recordTts({
      ...callBase, engine: lastEngine, fellBack: true,
      ok: false, ms: Date.now() - started, error: lastErr.message,
      t: new Date().toISOString(),
    });
    throw lastErr;
  }
}

// Re-exported so callers don't have to know which engine wrote the file.
// Piper is the original owner of the voice output dir; cleanup is engine-agnostic
// because every engine writes WAVs into the same directory.
export { cleanupOldVoices } from './piper.js';

export function availableEngines() {
  return {
    piper: true,
    kokoro: kokoro.isAvailable(),
    chatterbox: chatterbox.isAvailable(),
    'pocket-tts': pocketTts.isAvailable(),
    // The tts-heavy sidecar's configured engines (TTS_HEAVY_ENGINES): a
    // string[] when reachable and reporting it, null otherwise. Lets the admin
    // badge separate "engine off" (sidecar up, engine disabled) from "sidecar
    // off" (whole sidecar down). See engineMeta.engineStatus.
    heavyEnabled: heavyEnabledEngines(),
    // Whether PocketTTS can clone voices (gated weights present). null = not
    // yet known. The admin UI uses this to warn that a cloned .wav voice will
    // silently revert to a built-in when cloning is unavailable (issue #238).
    pocketTtsCloning: pocketTts.cloningAvailable(),
    cloud: cloud.isConfigured(),
    remote: remoteTts.isAvailable(),
    // Per-provider — a persona's cloud voice is only usable if *its* provider
    // is configured, which can differ from the global Cloud-engine provider.
    cloudByProvider: {
      openai: cloud.isConfigured('openai'),
      elevenlabs: cloud.isConfigured('elevenlabs'),
      'fish-audio': cloud.isConfigured('fish-audio'),
    },
  };
}

// True when a PocketTTS `voice` value is a cloned reference (a .wav filename)
// rather than a built-in voice id. Mirrors resolveVoice()'s split in
// audio/pocketTts.ts — anything ending in .wav (or an absolute path) is a clone.
function isPocketClone(voice?: string | null): boolean {
  const v = (voice || '').trim();
  return !!v && (/\.wav$/i.test(v) || v.startsWith('/'));
}

// Snapshot of how a spoken segment would currently route: which engine the
// effective persona's voice resolves to, and whether that's a fallback from
// the engine the persona actually asked for. Surfaced in /debug so the
// operator can see *who speaks* without waiting for a segment to air.
export function describeRouting() {
  const persona = settings.getEffectivePersona();
  const personaTts = persona?.tts || null;
  const tts = settings.get().tts || {};
  const requested = personaTts?.engine || tts.defaultEngine || 'piper';
  const slot = resolveEngine('dj-speak', personaTts);   // any persona-voiced kind
  const engine = slot.engine;
  let voice: string | null = null;
  let provider: string | null = null;
  if (slot.personaTts) {
    // Pre-flight reroute onto the operator's configured fallback — the slot
    // carries the exact voice/provider that will speak, so report it directly
    // rather than re-deriving from the persona (whose engine no longer applies)
    // or the global per-engine defaults (which this slot overrides).
    voice = slot.personaTts.voice || null;
    provider = engine === 'cloud' ? (slot.personaTts.cloudProvider || null) : null;
  } else if (engine === 'cloud') {
    voice = personaTts?.engine === 'cloud' ? personaTts.voice : tts.cloud?.voice;
    provider = (personaTts?.engine === 'cloud' ? personaTts.cloudProvider : tts.cloud?.provider) as any;
  } else if (engine === 'kokoro') {
    voice = (personaTts?.engine === 'kokoro' && personaTts.voice)
      ? personaTts.voice
      : tts.kokoro?.voice;
  } else if (engine === 'chatterbox') {
    // For chatterbox, `voice` is the reference-WAV filename; empty → built-in.
    voice = (personaTts?.engine === 'chatterbox' && personaTts.voice)
      ? personaTts.voice
      : (tts.chatterbox?.referenceVoice || null);
  } else if (engine === 'pocket-tts') {
    voice = (personaTts?.engine === 'pocket-tts' && personaTts.voice)
      ? personaTts.voice
      : (tts.pocketTts?.voice || null);
  } else if (engine === 'piper') {
    // For piper, `voice` is the .onnx filename; empty → baked-in default.
    voice = (personaTts?.engine === 'piper' && personaTts.voice)
      ? personaTts.voice
      : null;
  } else if (engine === 'remote') {
    voice = (personaTts?.engine === 'remote' && personaTts.voice)
      ? personaTts.voice
      : null;
  }
  // If the on-air persona asks PocketTTS for a cloned voice but the engine
  // can't clone (gated weights absent), the .wav silently reverts to a built-in
  // — the root cause of issue #238. Surface it so /debug shows *why* the voice
  // isn't what the operator picked, instead of a healthy-looking no-op.
  let warning: string | null = null;
  if (engine === 'pocket-tts' && isPocketClone(voice) && pocketTts.cloningAvailable() === false) {
    warning = 'PocketTTS voice cloning is unavailable in this build (gated weights '
      + 'not loaded) — this cloned voice reverts to a built-in. Set HF_TOKEN to enable cloning.';
  }
  // The operator's configured rescue, surfaced so /debug answers "what speaks
  // if this persona's engine dies" without waiting for a segment to fail.
  // `usable` is the live availability probe against the fallback's own cloud
  // provider — a configured-but-unusable fallback is exactly the misconfiguration
  // worth seeing here, since the chain silently skips it.
  const configured = fallbackSlot();
  const fallbackCfg = tts.fallback || {};
  return {
    effectivePersona: persona ? { id: persona.id, name: persona.name } : null,
    available: availableEngines(),
    spoken: {
      requested,
      engine,
      voice: voice || null,
      provider: provider || null,
      // Provider-aware like speak()'s: a persona rerouted from a dead Fish
      // target onto the operator's ElevenLabs rescue is still on `cloud`, and
      // reporting that as no fallback is what /debug is here to prevent.
      fellBack: rerouted(requested, personaTts, engine, slot.personaTts ?? personaTts),
      warning,
    },
    fallback: {
      enabled: !!fallbackCfg.enabled,
      engine: configured?.engine || fallbackCfg.engine || null,
      voice: configured?.personaTts?.voice || null,
      provider: configured?.engine === 'cloud'
        ? (configured.personaTts?.cloudProvider || null)
        : null,
      usable: configured
        ? engineUsable(configured.engine, configured.personaTts?.cloudProvider ?? null)
        : false,
    },
    jingle: { engine: resolveEngine('jingle', null).engine },
  };
}
