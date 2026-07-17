'use client';

import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { m } from 'motion/react';
import { notify, errorMessage } from '../../../lib/notify';
import { cn } from '../../../lib/cn';
import type { StationLocale } from '../../../lib/format';
import { Btn, Eyebrow, Metric } from '../ui';

export const KEY_HINTS: Record<string, string> = {
  ANTHROPIC_API_KEY: 'sk-ant-...',
  OPENAI_API_KEY: 'sk-...',
  GOOGLE_GENERATIVE_AI_API_KEY: 'AIza...',
  DEEPSEEK_API_KEY: 'sk-...',
  OPENROUTER_API_KEY: 'sk-or-v1-...',
  AI_GATEWAY_API_KEY: 'gateway API key',
  ELEVENLABS_API_KEY: 'el_...',
  EMBEDDING_API_KEY: 'optional — defaults to chat key',
};

export interface WeatherCfg {
  lat: string;
  lng: string;
  locationName: string;
  units: 'metric' | 'imperial';
}

export interface CloudTtsCfg {
  enabled: boolean;
  provider: string;
  model: string;
  voice: string;
  baseUrl: string;
  // ElevenLabs voice_settings (issue #696). All four are read + saved
  // regardless of provider so switching provider later preserves the
  // operator's tuning, but the UI + the outbound request only surface them
  // when provider === 'elevenlabs'.
  voiceStability: number;
  voiceStyle: number;
  voiceSimilarityBoost: number;
  voiceUseSpeakerBoost: boolean;
}

// ElevenLabs voice_settings defaults — the single client-side copy, read by
// both form hydration and the dirty-check. Must mirror DEFAULTS.tts.cloud in
// controller/src/settings.ts (which itself mirrors ElevenLabs' own baseline).
export const ELEVENLABS_VS_DEFAULTS = {
  voiceStability: 0.5,
  voiceStyle: 0,
  voiceSimilarityBoost: 0.75,
  voiceUseSpeakerBoost: true,
} as const;

export interface TtsForm {
  defaultEngine: string;
  kokoro: { voice: string };
  chatterbox: { referenceVoice: string };
  pocketTts: { voice: string };
  cloud: CloudTtsCfg;
  remote: { url: string };
  // Per-engine voice-level trim in dB, keyed by engine id (note the hyphen in
  // `pocket-tts`). Always carries all 6 known engines, 0 = unity = no change.
  gainDb: Record<string, number>;
  // Per-engine speech-rate multiplier, keyed by engine id. Always carries all 6
  // known engines, 1.0 = unity = no change. Inert for chatterbox/pocket-tts/remote.
  speed: Record<string, number>;
  // Operator speech corrections — find→replace pairs applied to every spoken
  // line before any TTS engine reads it (the editable sibling of the built-in
  // SUB/WAVE → "Subwave" rule).
  corrections: { from: string; to: string }[];
}

export interface LlmFallbackForm {
  enabled: boolean;
  provider: string;
  model: string;
  ollamaUrl: string;
  numCtx: number;
  repeatPenalty: number;
  baseUrl: string;
  reasoning: boolean;
}

export interface LlmForm {
  provider: string;
  model: string;
  ollamaUrl: string;
  numCtx: number;
  repeatPenalty: number;
  baseUrl: string;
  reasoning: boolean;
  toolChoice: string;
  pickerAgent: boolean;
  noRepeatWindow: string;
  requestWebResolve: boolean;
  agentTimeoutMs: number;
  pauseWhenEmpty: boolean;
  dailyTokenCap: number;
  budgetSoftPct: number;
  exemptRequests: boolean;
  maxOutputTokens: number;
  fallback: LlmFallbackForm;
}

export interface SearchForm {
  provider: string;
  apiKey: string;
  baseUrl: string;
}

export interface EmbeddingEnrichmentForm {
  lastfmTags: boolean;
  lyrics: boolean;
}

export interface EmbeddingForm {
  enabled: boolean;
  provider: string;          // empty → follow llm.provider
  model: string;             // empty → sensible default per provider
  baseUrl: string;           // dedicated embedding server URL (openai-compatible / locca); empty → inherit llm
  ollamaUrl: string;         // dedicated embedding server URL (ollama); empty → inherit llm
  seedCount: string;         // '0' = auto
  knnNeighbours: string;
  moodVoteThreshold: string;
  confidenceThreshold: string;
  maxActiveLearningRounds: string;
  audioFusionWeight: string; // '0' = text-only vote (fusion off)
  batchSize: string;         // '5', '10', or '25'
  enrichment: EmbeddingEnrichmentForm;
}

export interface ScrobbleLastfmForm {
  enabled: boolean;
  apiKey: string;
  apiSecret: string;
  sessionKey: string;
  username: string;
}

export interface ScrobbleListenbrainzForm {
  enabled: boolean;
  userToken: string;
  username: string;
  baseUrl: string;
}

export interface ScrobbleForm {
  lastfm: ScrobbleLastfmForm;
  listenbrainz: ScrobbleListenbrainzForm;
}

/** Listener likes (#991) — heart button + Navidrome star + DJ influence. */
export interface LikesForm {
  enabled: boolean;
  starInNavidrome: boolean;
  influenceDj: boolean;
  maxTracks: string;
  windowDays: string;
}

export interface ArchiveForm {
  enabled: boolean;
  bitrate: string;
  retentionDays: string;
}

export interface StreamForm {
  opusEnabled: boolean;
  opusBitrate: string;
  flacEnabled: boolean;
  aacEnabled: boolean;
  aacBitrate: string;
  bitrate: string;
  idleWhenEmpty: boolean;
  idleAfterMinutes: string;
}

export type LoudnessSource = 'replaygain-then-measured' | 'replaygain' | 'measured';

export interface LoudnessForm {
  targetLufs: string;
  maxBoostDb: string;
  source: LoudnessSource;
}

export interface TransitionsForm {
  pairDrain: boolean;   // hold picks until the successor is known (#749 fix)
  stemBlends: boolean;  // pre-rendered stem-blend seams (needs pairDrain + stem cache)
  stemCache: boolean;   // settings.audio.stemCache — persist Demucs stems during analysis
}

export interface FormState {
  jingleRatio: string;
  crossfadeDuration: string;
  maxTrackSeconds: string;
  transitions: TransitionsForm;
  archive: ArchiveForm;
  stream: StreamForm;
  loudness: LoudnessForm;
  station: string;
  timezone: string;
  locale: StationLocale;
  kokoroLang: string;
  weather: WeatherCfg;
  tts: TtsForm;
  llm: LlmForm;
  search: SearchForm;
  embedding: EmbeddingForm;
  scrobble: ScrobbleForm;
  likes: LikesForm;
}

export interface JingleEntry {
  filename: string;
  text?: string;
  size?: number;
  createdAt?: string;
  builtin?: boolean;
  source?: string;
}

export interface SfxEntry {
  name: string;
  description?: string;
  size?: number;
  durationSec?: number;
  builtin?: boolean;
  source?: string;
}

export interface SfxData {
  sfx?: SfxEntry[];
  generatorReady?: boolean;
}

export interface SettingsData {
  values?: {
    jingleRatio?: number;
    crossfadeDuration?: number;
    maxTrackSeconds?: number;
    minTrackSeconds?: number;
    archive?: { enabled?: boolean; bitrate?: number; retentionDays?: number };
    transitions?: { pairDrain?: boolean; stemBlends?: boolean };
    audio?: { embeddings?: boolean; vocalActivity?: boolean; stemCache?: boolean; stemCacheGb?: number };
    stream?: {
      opusEnabled?: boolean;
      opusBitrate?: number;
      flacEnabled?: boolean;
      aacEnabled?: boolean;
      aacBitrate?: number;
      bitrate?: number;
      idleWhenEmpty?: boolean;
      idleAfterMinutes?: number;
    };
    loudness?: { targetLufs?: number; maxBoostDb?: number; source?: LoudnessSource };
    station?: string;
    timezone?: string;
    locale?: StationLocale;
    theme?: { active?: string };
    weather?: { lat?: number; lng?: number; locationName?: string; units?: 'metric' | 'imperial' };
    tts?: {
      defaultEngine?: string;
      kokoro?: { voice?: string; lang?: string };
      chatterbox?: { referenceVoice?: string };
      pocketTts?: { voice?: string };
      cloud?: Partial<CloudTtsCfg>;
      remote?: { url?: string };
      gainDb?: Record<string, number>;
      speed?: Record<string, number>;
      corrections?: { from?: string; to?: string }[];
    };
    llm?: Partial<LlmForm>;
    search?: Partial<SearchForm>;
    embedding?: {
      enabled?: boolean;
      provider?: string;
      model?: string;
      baseUrl?: string;
      ollamaUrl?: string;
      seedCount?: number;
      knnNeighbours?: number;
      moodVoteThreshold?: number;
      confidenceThreshold?: number;
      maxActiveLearningRounds?: number;
      audioFusionWeight?: number;
      batchSize?: number;
      enrichment?: Partial<EmbeddingEnrichmentForm>;
    };
    sfx?: { enabled?: boolean };
    ui?: { boothBuddy?: boolean; skin?: string; tuneInOverlay?: boolean };
    scrobble?: {
      lastfm?: Partial<ScrobbleLastfmForm>;
      listenbrainz?: Partial<ScrobbleListenbrainzForm>;
    };
    likes?: {
      enabled?: boolean;
      starInNavidrome?: boolean;
      influenceDj?: boolean;
      maxTracks?: number;
      windowDays?: number;
    };
  };
  tts?: {
    engines?: string[];
    available?: Record<string, boolean>;
    kokoroVoices?: string[];
    kokoroVoiceLanguages?: Record<string, string>;
    kokoroLangs?: string[];
    chatterboxVoices?: string[];
    // `voiceDir` is the new shared name (issue #213). `chatterboxVoiceDir` is
    // kept as an alias so the UI keeps working against older controllers.
    voiceDir?: string;
    chatterboxVoiceDir?: string;
    pocketTtsVoices?: Array<{ id: string; label: string }>;
    pocketTtsCustomVoices?: string[];
    cloudProviders?: string[];
  };
  llm?: {
    providers?: string[];
    active?: string;
  };
  embedding?: {
    providers?: string[];
  };
  search?: {
    providers?: string[];
  };
  defaults?: {
    search?: Partial<SearchForm>;
    locale?: StationLocale;
  };
  jingles?: JingleEntry[];
  libraryStats?: {
    total?: number;
    withEmbedding?: number;
    // Provenance of the text-embedding index: the model it was built with
    // ("provider:model") and its vector dim. Null when the library was never
    // embedded. Drives the chat-provider-switch warning in LlmSection.
    embeddingMeta?: { model: string; dim: number } | null;
  };
  tagger?: { running?: boolean };
  env?: Record<string, unknown>;
  streamOnAir?: boolean;
  // What timezone '' (Auto) resolves to — the controller's own zone.
  serverTimezone?: string;
}

export interface SfxForm {
  name: string;
  description: string;
  prompt: string;
  durationSec: string;
}

export type Patch = Record<string, unknown>;
export type SaveSettings = (patch: Patch) => Promise<void>;

export type JingleImportFailure = { name: string; reason: string };
export type JingleImportResult = { ok: number; total: number; failures: JingleImportFailure[]; aborted: boolean };

export type FormUpdater = (updater: (f: FormState) => FormState) => void;

export interface SectionProps {
  data: SettingsData;
  form: FormState;
  setForm: FormUpdater;
  busy: boolean;
  saveSettings: SaveSettings;
}

interface MetricSpec {
  n: ReactNode;
  l: ReactNode;
  accent?: boolean;
}

interface SectionHeaderProps {
  eyebrow: ReactNode;
  title: ReactNode;
  sub: ReactNode;
  metrics?: MetricSpec[];
  manualHref?: string;
  manualLabel?: ReactNode;
}

export function SectionHeader({ eyebrow, title, sub, metrics, manualHref, manualLabel }: SectionHeaderProps) {
  return (
    <div className="flex flex-wrap items-start gap-4 border border-ink p-4">
      <div className="min-w-[240px] flex-1">
        <Eyebrow className="text-vermilion">{eyebrow}</Eyebrow>
        <div className="mt-1.5 text-[22px] font-extrabold tracking-[-0.02em]">
          {title}
        </div>
        <div className="mt-1.5 max-w-[540px] text-[12px] leading-[1.5] text-muted">
          {sub}
        </div>
        {manualHref && (
          <a
            href={manualHref}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block text-[12px] font-bold text-vermilion underline decoration-[1.5px] underline-offset-2"
          >
            {manualLabel || 'Read this in the manual'} ↗
          </a>
        )}
      </div>
      {metrics && metrics.length > 0 && (
        <div className="grid grid-flow-col gap-[18px] pt-1">
          {metrics.map((m, i) => <Metric key={i} n={m.n} l={m.l} accent={m.accent} />)}
        </div>
      )}
    </div>
  );
}

interface SaveBarProps {
  note: ReactNode;
  busy: boolean;
  onSave: () => void;
  saveLabel: ReactNode;
  extra?: ReactNode;
}

// Save bar — no inline status; success/failure goes through the global
// toaster (lib/notify) so it stays consistent with every other admin action.
export function SaveBar({ note, busy, onSave, saveLabel, extra }: SaveBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-3 border border-ink bg-[var(--ink-softer)] p-3">
      <span className="size-1.5 rounded-full bg-vermilion" />
      <span className="text-[11px] text-muted">{note}</span>
      <span className="ml-auto flex gap-2">
        {extra}
        {/* whileTap fires before the network call — operator feels the
            commit even though the actual save toast lands a few hundred
            ms later. */}
        <m.span whileTap={{ scale: 0.97 }} className="inline-flex">
          <Btn tone="accent" onClick={onSave} disabled={busy}>{saveLabel}</Btn>
        </m.span>
      </span>
    </div>
  );
}

interface KeyStatusProps {
  envVar: string;
  present: boolean;
}

export function KeyStatus({ envVar, present }: KeyStatusProps) {
  const toneClass = present
    ? 'border-[var(--accent)] text-[color:var(--accent)]'
    : 'border-[var(--danger)] text-[var(--danger)]';
  return (
    <div
      className={cn(
        'field mt-3.5 flex items-start gap-2.5 border bg-[var(--ink-softer)] p-3',
        toneClass,
      )}
    >
      <span
        className={cn(
          'mt-1 size-1.5 flex-none rounded-full',
          present ? 'bg-[var(--accent)]' : 'bg-[var(--danger)]',
        )}
      />
      <div className="grid gap-0.5">
        <span className={cn('text-[11px] font-bold tracking-[0.12em] uppercase', toneClass)}>
          {present ? 'API key found in environment' : 'API key missing'}
        </span>
        <span className="text-[11px] leading-[1.5] text-muted">
          {present ? (
            <>The controller has <code>{envVar}</code> set, so this provider is ready to use.</>
          ) : (
            <>
              <code>{envVar}</code> is not set. Paste the key in the field above and save,
              or set it in <code>.env</code> and restart.
            </>
          )}
        </span>
      </div>
    </div>
  );
}

interface KeyTestResultProps {
  result: { ok: boolean; message: string; latencyMs: number };
}

export function KeyTestResult({ result }: KeyTestResultProps) {
  return (
    <div
      className={cn(
        'mt-2 max-w-[560px] rounded border bg-[var(--ink-softer)] px-3 py-2 text-[11px] leading-[1.6]',
        result.ok
          ? 'border-[var(--accent)] text-[color:var(--accent)]'
          : 'border-[var(--danger)] text-[var(--danger)]',
      )}
    >
      {result.ok
        ? `${result.message}${result.latencyMs > 0 ? ` · ${result.latencyMs}ms` : ''}`
        : result.message}
    </div>
  );
}

// Module-level "now previewing" handle so a second press anywhere on the
// admin page stops the first clip — no overlapping audio.
let currentPreview: { audio: HTMLAudioElement; url: string; stop: () => void } | null = null;

interface PreviewButtonProps {
  path: string;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  label?: string;
}

// Audio files behind /api/jingles/.../audio and /api/sfx/.../audio are
// admin-gated (HTTP Basic). A plain <audio src> can't send the header, so
// we fetch the bytes via adminFetch, hand them to <Audio> as a Blob URL,
// and revoke the URL when playback ends.
export function PreviewButton({ path, adminFetch, label = 'Play' }: PreviewButtonProps) {
  const [state, setState] = useState<'idle' | 'loading' | 'playing'>('idle');

  useEffect(() => {
    return () => {
      // Unmounting (e.g. row deleted while previewing) — make sure we
      // don't leak the audio element or the object URL.
      if (currentPreview && currentPreview.audio.dataset.owner === path) {
        currentPreview.stop();
      }
    };
  }, [path]);

  const onClick = async () => {
    if (state === 'playing') {
      currentPreview?.stop();
      return;
    }
    if (state === 'loading') return;
    setState('loading');
    try {
      const r = await adminFetch(path);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.dataset.owner = path;
      const stop = () => {
        audio.pause();
        URL.revokeObjectURL(url);
        if (currentPreview?.audio === audio) currentPreview = null;
        setState('idle');
      };
      audio.addEventListener('ended', stop);
      audio.addEventListener('error', stop);
      currentPreview?.stop();
      currentPreview = { audio, url, stop };
      await audio.play();
      setState('playing');
    } catch (err) {
      notify.err(`Preview failed: ${errorMessage(err)}`);
      setState('idle');
    }
  };

  const text = state === 'playing' ? 'Stop' : state === 'loading' ? '…' : label;

  return (
    <Btn sm onClick={onClick} title="Preview audio">
      {text}
    </Btn>
  );
}
