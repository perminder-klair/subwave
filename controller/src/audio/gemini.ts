// Native Gemini TTS engine: Google's TTS API directly, no sidecar.
//
// Model order mirrors the sidecar (cheapest first): gemini-3.8-flash-lite-tts,
// then gemini-3.8-flash-tts, via the Interactions API with delivery in
// speech_metadata.style. The transcript is NEVER prefixed with [...] blocks —
// 3.8 treats input as verbatim and lite vocalizes them (rambling/static tail).
//
// Key: GOOGLE_GENERATIVE_AI_API_KEY (state/secrets.env → process.env) — a real
// Google AI key. A gateway/compatibility-server bearer for the LLM leg is not a
// substitute: Google rejects one with API_KEY_INVALID, so every render fails
// over.
//
// Cue translation (splitCues) replaces the old sidecar's split_cues; the
// direct-Google engine has no Python peer to stay in sync with, so
// scripts/gemini-tts.test.ts is the only thing pinning these vectors.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { hasFfmpeg, transcodeAudio } from './audio-import.js';
import { soulBrief } from '../llm/internal/core/pure.js';
import { GEMINI_TTS_VOICES } from '../schemas/persona.js';
import * as settings from '../settings.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
// The engine's own fallback chain. An operator-chosen model (settings.tts.gemini.model)
// is tried FIRST and the rest of this list still stands behind it, so pinning a
// model can never leave the station with no way to speak if that model 404s or
// is retired — which is exactly what happens when a preview model is withdrawn.
const MODELS = ['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts'];

/** The chain to walk for one render: the operator's pick first, then the rest. */
function modelChain(chosen?: string): string[] {
  const pick = (chosen || '').trim();
  if (!pick || pick === MODELS[0]) return MODELS;
  return [pick, ...MODELS.filter((m) => m !== pick)];
}
const VOICE_STYLE_MAX = 300;

// Ceiling on the free-text station pronunciation note
// (settings.tts.gemini.pronunciation). It is appended to the composed style on
// EVERY render, so it shares a budget with the persona's voiceStyle and soul
// excerpt — generous enough for a real place-name list, small enough that it
// cannot crowd the character out of the prompt.
export const GEMINI_PRONUNCIATION_MAX = 300;

// Multi-speaker single-request cap for prebuilt voices (Google docs).
const MULTI_VOICE_CAP = 2;

export function apiKey(): string {
  return process.env.GOOGLE_GENERATIVE_AI_API_KEY || '';
}

export function isAvailable(): boolean {
  return !!apiKey();
}

// The docs' recommended vocal-burst vocabulary, keyed by every spelling the DJ
// actually writes. The station's own system prompt suggests `[laughs]`,
// `[sighs]`, `[whispers]` (llm/internal/prompts/system.ts) — so the THIRD-PERSON
// `-s` forms are not optional polish here, they are the prompt's literal
// examples. `VOCAL_BURST_FORMS` below strips the inflection rather than
// doubling this table, because a missing `-s` used to mean the bracket SURVIVED
// into the transcript and Gemini 3.8 — which treats `text` as a verbatim
// transcript — read the word "laughs" out loud on air.
const VOCAL_BURSTS: Record<string, string> = {
  laugh: 'laugh', laughing: 'laugh', laughter: 'laughter',
  chuckle: 'chuckle', giggle: 'giggle', snicker: 'snicker',
  sigh: 'sigh', cough: 'cough', breath: 'breath', gasp: 'gasp',
  groan: 'groan', moan: 'moan', pant: 'panting', yawn: 'yawn',
  sneeze: 'sneeze', snort: 'snort', sob: 'sob', cry: 'cry',
  shout: 'shout', scream: 'scream', whisper: 'whispering',
  'short pause': 'short pause', 'long pause': 'long pause',
  uhm: 'breath',
};

// Delivery modifiers become part of `speech_metadata.style`, never inline tags:
// they sustain across the whole turn, which is what the style field is for.
const DELIVERY_STYLES: Record<string, string> = {
  sarcasm: 'sarcastic', sarcastic: 'sarcastic',
  shouting: 'loud', whispering: 'whispered', whisper: 'whispered',
  robotic: 'flat and mechanical', 'extremely fast': 'speaking rapidly',
  excited: 'excited, upbeat',
};

// A free-text cue the model invented — the system prompt offers
// `[soft and warm]` / `[laughing nervously]` (system.ts). Per the prompting
// guide these are sustained delivery instructions, so they belong in
// `speech_metadata.style`; leaving them in the transcript makes Gemini recite
// them. Gated to LOWERCASE-ONLY bodies so the one bracket shape that must
// survive — a capitalised title like `[Track 2]` or `[Blue Monday]` — still
// does. Digits are excluded for the same reason, and a body that is ONLY
// punctuation (`[?]`, `[...]`) is left verbatim rather than turned into an empty
// style entry.
const FREEFORM_STYLE_RE = /^[a-z][a-z ,.'-]{0,39}$/;

const CUE_RE = /\[([^\]\r\n]{1,40})\]/g;

function vocalBurstFor(key: string): string | undefined {
  if (VOCAL_BURSTS[key]) return VOCAL_BURSTS[key];
  // `[laughs]`, `[groans]`, `[chuckles]` — the prompt's own examples.
  if (key.length > 3 && key.endsWith('s') && VOCAL_BURSTS[key.slice(0, -1)]) {
    return VOCAL_BURSTS[key.slice(0, -1)];
  }
  return undefined;
}

// Key lookup strips surrounding punctuation and whitespace so `[sigh.]`,
// `[sigh!]` and `[ Sigh ]` all resolve — the DJ writes punctuation inside the
// bracket naturally, and an unrecognised `[sigh.]` would otherwise fall through
// to the free-text rule and become a spoken "sigh." instead of an actual sigh.
function cueKey(body: string): string {
  // SENTENCE punctuation only. `?!` and friends are left attached: `?` on its own
  // is not a cue, and stripping it would turn `[??]` into a match on nothing
  // while `[really?]` is a perfectly good free-text cue to preserve.
  return String(body).trim().toLowerCase().replace(/^[.\s]+|[.\s]+$/g, '')
    .replace(/[.!]+$/, '');
}

/** Pull [...] cues out: vocal bursts become <...> tags, delivery modifiers
 *  and free-text cues join the style string, and unknown PROPER-NOUN brackets
 *  (track titles) survive verbatim. */
export function splitCues(text: string): { text: string; styles: string[] } {
  const styles: string[] = [];
  const clean = String(text ?? '').replace(CUE_RE, (m, body: string) => {
    const key = cueKey(body);
    const burst = vocalBurstFor(key);
    if (burst) return `<${burst}>`;
    const delivery = DELIVERY_STYLES[key];
    if (delivery) {
      styles.push(delivery);
      return '';
    }
    if (FREEFORM_STYLE_RE.test(String(body).trim())) {
      styles.push(String(body).trim());
      return '';
    }
    return m;
  });
  return { text: clean.replace(/\s+/g, ' ').trim(), styles };
}

// NOTE: the Interactions API accepts no safety params (both snake_case and
// camelCase 400), so generation_config carries speech only. Default filters
// govern; a blocked render fails over through the normal fallback chain.



// Persona character → `speech_metadata.style`, the same composition OpenAI gets
// through `instructions` (deliveryHint in llm/internal/speech/cloud-speech.ts).
// Before this, Gemini received the persona's `voiceStyle` and nothing else, so a
// persona's whole `soul` — the backstory, the job, the running jokes — never
// reached the model. A station running Gemini therefore had to hardcode a
// short style per persona to get any characterisation at all.
//
// Deliberately NOT identical to OpenAI's version, for two documented reasons:
//
// 1. LENGTH. OpenAI accepts a 4096-char `instructions` string. Gemini's
//    prompting guide is the opposite advice: "Long-form 'Audio Profile'
//    paragraphs and multi-bullet 'Director's Notes' ... are the most common
//    cause of voice drift", and it steers operators toward a designed voice
//    plus a short per-turn tweak. So the budget is spent the other way round —
//    the operator's explicit `voiceStyle` is allocated FIRST and the soul
//    excerpt fills whatever is left. Ordering it OpenAI's way (character, then
//    style) would let the soul excerpt eat the entire budget and silently drop
//    the one field the operator deliberately wrote.
// 2. LANGUAGE. OpenAI has no language parameter, so the language directive has
//    to be spelled out inside `instructions`. Gemini detects the input language
//    automatically, so repeating it would fight the detector rather than help
//    it — it is deliberately absent here.
// The station's own pronunciation note, read at call time rather than threaded
// through every caller. It is station-wide and constant for the life of the
// process — the single strongest argument for not making it a parameter, since a
// threaded copy is a value every future caller has to remember to pass.
function stationPronunciation(): string {
  const v = (settings.get().tts as any)?.gemini?.pronunciation;
  return typeof v === 'string' ? v : '';
}

export function geminiStyle(
  { soul, voiceStyle, pronunciation }: { soul?: unknown; voiceStyle?: unknown; pronunciation?: unknown },
  cueStyles: string[] = [],
): string {
  const operator = typeof voiceStyle === 'string' ? voiceStyle.trim().replace(/\s+/g, ' ') : '';
  // Budget priority: the operator's voiceStyle is allocated first, the station's
  // pronunciation note second, and the persona's soul excerpt takes whatever is
  // left. The soul yields because it is the only one of the three that is
  // abridged rather than dropped — a truncated character paragraph still reads as
  // character, whereas a dropped pronunciation note is a place name said wrong in
  // EVERY segment. Order in the final string puts the soul before the note, so
  // the note reads as the closing correction rather than as persona voice.
  const station = typeof pronunciation === 'string' ? pronunciation.trim().replace(/\s+/g, ' ') : '';
  const budget = Math.max(0, VOICE_STYLE_MAX - operator.length - station.length);
  const character = budget > 0 ? soulBrief(soul, budget) : '';
  return [operator, character, station, cueStyles.join(', ')].filter(Boolean).join('. ');
}

import { fetchWithTimeout } from '../util/fetch-timeout.js';

// 3 minutes: TTS renders are slow and retried per model; the caller's abort
// (preview cancel, shutdown) still wins via signal composition.
const REQUEST_TIMEOUT_MS = 180_000;

async function postInteraction(body: unknown, signal?: AbortSignal, modelPref?: string): Promise<Buffer> {
  const key = apiKey();
  if (!key) throw new Error('GOOGLE_GENERATIVE_AI_API_KEY not set');
  let lastErr: unknown = null;
  for (const model of modelChain(modelPref)) {
    signal?.throwIfAborted();
    let res: Response;
    let json: any;
    let errorText = '';
    try {
      res = await fetchWithTimeout(`${API_BASE}/interactions`, {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, ...(body as Record<string, unknown>) }),
        signal,
        timeoutMs: REQUEST_TIMEOUT_MS,
        bodyDeadline: true,
      });
      if (res.ok) json = await res.json();
      else errorText = await res.text();
      signal?.throwIfAborted();
    } catch (err) {
      // A provider timeout or malformed body can recover on another model.
      // Caller cancellation is terminal, including during body consumption.
      signal?.throwIfAborted();
      lastErr = err;
      continue;
    }
    if (res.status === 429) {
      lastErr = new Error(`Gemini TTS ${model} rate-limited (429)`);
      continue; // fail over immediately; the controller fallback chain covers
    }
    if (res.status >= 500) {
      lastErr = new Error(`Gemini TTS ${model} HTTP ${res.status}: ${errorText.slice(0, 200)}`);
      continue; // transient server error — try the next model before giving up
    }
    if (!res.ok) {
      throw new Error(`Gemini TTS ${model} HTTP ${res.status}: ${errorText.slice(0, 200)}`);
    }
    const steps = Array.isArray(json?.steps) ? json.steps : [];
    const data: string | undefined = json?.output_audio?.data
      ?? steps.filter((s: any) => s?.type === 'model_output')
        .flatMap((s: any) => Array.isArray(s?.content) ? s.content : [])
        .filter((c: any) => c?.type === 'audio')
        .at(-1)?.data;
    if (typeof data !== 'string' || !data) {
      lastErr = new Error(`Gemini TTS ${model} returned no audio`);
      continue;
    }
    // Unary audio is WAV (RIFF) already — write bytes directly, never re-wrap.
    return Buffer.from(data, 'base64');
  }
  throw lastErr instanceof Error ? lastErr : new Error('Gemini TTS failed on all models');
}

async function outFile(customPath?: string): Promise<string> {
  const outPath = customPath || join(config.piper.outDir, `${crypto.randomBytes(6).toString('hex')}.wav`);
  await mkdir(dirname(outPath), { recursive: true });
  return outPath;
}

/** Apply the composed speech rate locally with ffmpeg, mirroring remoteTts:
 *  the Interactions API has no rate param. Invalid rates degrade to unity;
 *  without ffmpeg the original audio is kept. */
async function applyRate(audio: Buffer, outPath: string, speedScale: unknown): Promise<void> {
  const rate = Number.isFinite(speedScale) && (speedScale as number) > 0 ? (speedScale as number) : 1;
  if (rate === 1) {
    await writeFile(outPath, audio);
    return;
  }
  try {
    if (!await hasFfmpeg()) throw new Error('ffmpeg is not available');
    await transcodeAudio(audio, { outPath, format: 'wav', atempo: rate });
  } catch (err) {
    console.warn(
      `[gemini] could not apply speech rate ${rate}; using original 1x audio: ${err instanceof Error ? err.message : String(err)}`,
    );
    await writeFile(outPath, audio);
  }
}

export async function speak(
  text: string,
  { voice, style, soul, outPath: customPath, signal, speedScale, model }: { voice?: string; style?: string; soul?: string; model?: string; outPath?: string; signal?: AbortSignal; speedScale?: number } = {},
): Promise<string> {
  if (!text || !text.trim()) throw new Error('Empty TTS text');
  const { text: clean, styles } = splitCues(text);
  const body = {
    input: [{
      type: 'user_input',
      content: [{
        type: 'text',
        text: clean,
        annotations: [{
          type: 'speech_metadata',
          style: geminiStyle({ soul, voiceStyle: style, pronunciation: stationPronunciation() }, styles),
        }],
      }],
    }],
    response_format: { type: 'audio' },
    generation_config: {
      // No safety key: the Interactions API 400s unknown generation_config
      // params, and defaults govern. A blocked render fails over normally.
      speech_config: [{ voice: usableVoice(voice) || 'Puck' }],
    },
  };
  const audio = await postInteraction(body, signal, model);
  const outPath = await outFile(customPath);
  await applyRate(audio, outPath, speedScale);
  return outPath;
}

// Which voice names are worth putting on the wire. Prebuilt names are matched
// case-INSENSITIVELY — verified against the engine, which accepts 'Charon',
// 'charon' and 'CHARON' alike, so the old sidecar's title-case normalisation was
// fixing nothing.
//
// Custom Voice Design / Voice Replication ids (`voice_...`, `voicekey_...`) are
// NOT in the prebuilt list and must pass through untouched — they are opaque,
// per-project handles this code cannot validate.
//
// Anything else is rejected by Google with "No matching speaker voice found for
// name", which is a 400 that throws the whole segment into the fallback chain:
// one persona carrying a stale value (an old alias, a typo, a voice that has
// been retired) would silently cost every segment that persona voices. Returning
// null here lets the caller fall back to the station's own voice instead — the
// same degradation the retired sidecar did, minus its hardcoded alias table that
// only ever named one operator's personas.
export function usableVoice(name: unknown): string | undefined {
  const raw = String(name ?? '').trim();
  if (!raw) return undefined;
  if (/^(voice|voicekey)_/i.test(raw)) return raw;
  const hit = (GEMINI_TTS_VOICES as readonly string[])
    .find((v) => v.toLowerCase() === raw.toLowerCase());
  return hit;
}

// ── Multi-line ────────────────────────────────────────────────────────────────
interface MultiLine {
  text: string;
  voice?: string;
  style?: string;
  /** The speaker's own persona character, composed into that turn's style. */
  soul?: string;
}

/** One conversational call for the whole exchange. Throws when more than
 *  MULTI_VOICE_CAP distinct voices are present — the caller falls back to
 *  per-line renders, same as the remote fast-path rule. */
export async function speakMulti(
  lines: MultiLine[],
  { outPath: customPath, signal, model, soul }: { outPath?: string; signal?: AbortSignal; model?: string; soul?: unknown } = {},
): Promise<string> {
  if (!lines || lines.length === 0) throw new Error('Empty TTS lines');
  const seen = new Map<string, string>();
  const turns: { text: string; style: string; alias: string }[] = [];
  for (const line of lines) {
    const { text: clean, styles } = splitCues(line.text);
    const voice = usableVoice(line.voice) || 'Puck';
    const alias = voice.toLowerCase();
    if (!seen.has(alias)) {
      if (seen.size >= MULTI_VOICE_CAP) {
        throw new Error(`speakMulti supports ${MULTI_VOICE_CAP} voices per call`);
      }
      seen.set(alias, voice);
    }
    // Each turn gets ITS OWN persona's soul + voiceStyle, and the station-level
    // `soul` is only the fallback for a line that carries neither — a caller's
    // broadcast-wide default must not be pasted over a guest's own character.
    turns.push({
      text: clean,
      style: geminiStyle(
        { soul: line.soul ?? soul, voiceStyle: line.style, pronunciation: stationPronunciation() },
        styles,
      ),
      alias,
    });
  }

  // The request shape depends on how many DISTINCT voices the lines resolve to,
  // and this is not cosmetic — each shape 400s on the other. Measured against
  // the engine:
  //   • 2 voices → `speakers` + `mode: conversational`, and every turn must
  //     carry a `speaker` naming one of them.
  //   • 1 voice  → that object form 400s with "the number of
  //     speaker_voice_configs must equal 2", because `conversational` means two.
  //     The single-speaker ARRAY form takes any number of turns on one voice and
  //     still honours each turn's own `style`.
  // Two personas on the SAME voice is the common case, not an edge one: it is
  // exactly what a station default voice produces for every persona that leaves
  // its own voice blank, so it has to render rather than throw.
  const oneVoice = seen.size === 1;
  const speakers = [...seen.entries()].map(([, voice]) => ({ speaker: voice, voice }));
  const speakerOf = (alias: string) => speakers.find((s) => s.speaker.toLowerCase() === alias)?.speaker;
  // A speaker name that Google would reject (`speaker` and `voice` are both the
  // name) has to go before it is put in EITHER slot, so an unusable value
  // collapses the same way it does on the single-speaker path.
  const body = {
    input: [{
      type: 'user_input',
      content: turns.map((t) => ({
        type: 'text',
        text: t.text,
        annotations: [{
          type: 'speech_metadata',
          // Required on every turn of a multi-speaker request; on a
          // single-speaker one the voice comes from speech_config instead.
          ...(oneVoice ? {} : { speaker: speakerOf(t.alias) }),
          style: t.style,
        }],
      })),
    }],
    response_format: { type: 'audio' },
    generation_config: oneVoice
      ? { speech_config: [{ voice: speakers[0].voice }] }
      : { speech_config: { mode: 'conversational', speakers } },
  };
  const audio = await postInteraction(body, signal, model);
  const outPath = await outFile(customPath);
  await writeFile(outPath, audio);
  return outPath;
}

/** Prebuilt voice ids for the picker. Empty on any failure — the UI falls
 *  back to free text like cloud-compat. */
export async function listVoices(): Promise<string[]> {
  try {
    const key = apiKey();
    if (!key) return [];
    const res = await fetch(`${API_BASE}/voices?pageSize=100&type=prebuilt`, {
      headers: { 'x-goog-api-key': key },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as any;
    const voices = Array.isArray(json?.voices) ? json.voices : [];
    return voices
      .map((v: any) => String(v?.name || v?.id || '').replace(/^voices\//, '').trim())
      .filter((v: string) => v && v.length <= 100)
      .slice(0, 200);
  } catch {
    return [];
  }
}
