'use client';

import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { m } from 'motion/react';
import { notify, errorMessage } from '../../../lib/notify';
import { adminResponse } from '../../../lib/admin-query';
import { cn } from '../../../lib/cn';
import type { StationLocale } from '../../../lib/format';
import type { EngineAvailability } from '../tts/engineMeta';
import { Play } from 'lucide-react';
import { Btn, Eyebrow, Metric } from '../ui';
import { useSectionChrome, useReportDirty } from './section-chrome';
import { Button } from '../../ui/button';
import { FieldError } from '../../ui/field';
import type { TransitionEffect, JingleRotateOwner } from '../../../lib/schemas.generated';
export type { TransitionEffect } from '../../../lib/schemas.generated';

export const KEY_HINTS: Record<string, string> = {
  ANTHROPIC_API_KEY: 'sk-ant-...',
  OPENAI_API_KEY: 'sk-...',
  GOOGLE_GENERATIVE_AI_API_KEY: 'AIza...',
  DEEPSEEK_API_KEY: 'sk-...',
  OPENROUTER_API_KEY: 'sk-or-v1-...',
  AI_GATEWAY_API_KEY: 'gateway API key',
  ELEVENLABS_API_KEY: 'el_...',
  // Fish keys have no documented prefix — point at where to mint one instead.
  FISH_API_KEY: 'key from fish.audio/app/api-keys',
  EMBEDDING_API_KEY: 'optional — defaults to chat key',
};

export interface WeatherCfg {
  lat: string;
  lng: string;
  locationName: string;
  /** Broad place the DJ names on air, e.g. "the Peak District". Empty = fall back to locationName. */
  onAirLocation: string;
  units: 'metric' | 'imperial';
}

export interface CloudTtsCfg {
  enabled: boolean;
  provider: string;
  model: string;
  voice: string;
  baseUrl: string;
  // ElevenLabs voice_settings (#696). Saved regardless of provider; surfaced only when provider === 'elevenlabs'.
  voiceStability: number;
  voiceStyle: number;
  voiceSimilarityBoost: number;
  voiceUseSpeakerBoost: boolean;
  // Fish Audio S2.1 controls. Persisted across provider switches; sent only when provider === 'fish-audio'.
  temperature: number;
  topP: number;
  latency: 'low' | 'normal' | 'balanced';
  // Extra request-body fields for openai-compatible servers (#1317). Text on both
  // sides; the controller coerces each value to its JSON type at send time.
  compatParams: { key: string; value: string }[];
}

// Single client-side copy. Must mirror DEFAULTS.tts.cloud in controller/src/settings.ts.
export const ELEVENLABS_VS_DEFAULTS = {
  voiceStability: 0.5,
  voiceStyle: 0,
  voiceSimilarityBoost: 0.75,
  voiceUseSpeakerBoost: true,
} as const;

export const FISH_TTS_DEFAULTS = {
  temperature: 0.7,
  topP: 0.7,
  latency: 'normal' as const,
};

export interface TtsFallbackForm {
  enabled: boolean;
  engine: string;
  voice: string;
  cloudProvider: string;
}

export interface TtsForm {
  // false = music only: no script is generated. Jingles (jingleRatio) and manual segment triggers are unaffected.
  enabled: boolean;
  defaultEngine: string;
  // Operator rescue voice: this engine AND voice speaks for a persona whose own
  // engine fails, ahead of the defaultEngine -> piper -> kokoro floor.
  fallback: TtsFallbackForm;
  kokoro: { voice: string };
  chatterbox: { referenceVoice: string };
  pocketTts: { voice: string };
  cloud: CloudTtsCfg;
  remote: { url: string };
  // Keyed by engine id (hyphen in `pocket-tts`). Always all 6 engines; 0 = unity.
  gainDb: Record<string, number>;
  // Always all 6 engines; 1.0 = unity. Inert for chatterbox/pocket-tts/remote.
  speed: Record<string, number>;
  // find→replace pairs applied to every spoken line before any engine reads it.
  corrections: { from: string; to: string }[];
}

/** One row of the custom-header editor (#1618). A LIST so a half-typed row
 *  survives; collapsed to the stored map at save time. `value` may be the
 *  literal 'set' -- what GET /settings returns for a header already on file. */
export interface LlmHeaderRow {
  name: string;
  value: string;
}

/** Wire map -> editor rows, in the stored order. */
export function headerRows(raw: Record<string, string> | undefined): LlmHeaderRow[] {
  if (!raw || typeof raw !== 'object') return [];
  return Object.keys(raw).map((name) => ({ name, value: raw[name] ?? '' }));
}

/** Editor rows -> the map the controller stores. A row with no name is dropped;
 *  a LATER row wins a name collision. */
export function headerMap(rows: LlmHeaderRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const name = (r.name || '').trim();
    if (!name) continue;
    out[name] = (r.value || '').trim();
  }
  return out;
}

export interface LlmFallbackForm {
  enabled: boolean;
  provider: string;
  model: string;
  ollamaUrl: string;
  numCtx: number;
  repeatPenalty: number;
  providerBaseUrls: Record<string, string>;
  headers: LlmHeaderRow[];
  reasoning: boolean;
  discoverySteps: number;
}

export interface LlmForm {
  provider: string;
  model: string;
  ollamaUrl: string;
  numCtx: number;
  repeatPenalty: number;
  providerBaseUrls: Record<string, string>;
  headers: LlmHeaderRow[];
  reasoning: boolean;
  toolChoice: string;
  pickerAgent: boolean;
  noRepeatWindow: string;
  artistVarietyWindow: string;
  requestWebResolve: boolean;
  agentTimeoutMs: number;
  pauseWhenEmpty: boolean;
  dailyTokenCap: number;
  budgetSoftPct: number;
  exemptRequests: boolean;
  maxOutputTokens: number;
  // 0 = auto (follow the provider capability table); 1-5 overrides it.
  discoverySteps: number;
  fallback: LlmFallbackForm;
}

export interface SearchForm {
  provider: string;
  apiKey: string;
  baseUrl: string;
  /** Optional comma-separated SearXNG engine pin (#1353); '' = instance default. */
  searxngEngines: string;
}

export interface EmbeddingEnrichmentForm {
  lastfmTags: boolean;
  lyrics: boolean;
}

export interface EmbeddingForm {
  enabled: boolean;
  provider: string;          // empty → follow llm.provider
  model: string;             // empty → sensible default per provider
  providerBaseUrls: Record<string, string>; // per-provider embedding server URLs; empty → inherit llm
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

/** Navidrome play reporting (#1298). Scrobbles through the station's existing Navidrome connection. */
export interface ScrobbleNavidromeForm {
  enabled: boolean;
}

export interface ScrobbleForm {
  lastfm: ScrobbleLastfmForm;
  listenbrainz: ScrobbleListenbrainzForm;
  navidrome: ScrobbleNavidromeForm;
}

// Track-selection windows read by BOTH pick paths. Separate from `llm` because
// the stateless pool picker enforces the album cooldown too.
export interface PickerForm {
  // Hours, as typed. 0/'' = off.
  albumHours: string;
  // Seconds, as typed. 0/'' = off. A show's own minTrackLengthSeconds overrides this; requests are exempt.
  minTrackLengthSeconds: string;
}

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
  bufferSeconds: string;
  oggIcyMetadata: boolean;
  idleWhenEmpty: boolean;
  idleAfterMinutes: string;
  maxListeners: string;
  countryHeader: string;
  geoipDbPath: string;
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
  stemCacheGb: string;  // settings.audio.stemCacheGb — byte budget the LRU sweep enforces
  /** settings.transitions.effects — which gestures the DJ may reach for. Always
   *  fully populated in the form; an absent stored field loads as `true`. */
  effects: Record<TransitionEffect, boolean>;
}

export interface PrivacyForm {
  privatePlayer: boolean;
  listenerAuth: boolean;
  /** Round-trips the 'set' redaction sentinel when saved and untouched.
   *  One shared secret behind both locks above. */
  password: string;
  /** Disclosure, not a lock: publish every persona's soul on the roster-wide
   *  public reads (/schedule, /personas). Takes no part in the password rule. */
  publishPersonaSouls: boolean;
}

/** Every field applies live and the controller clamps on save. Numbers are held
 *  as strings and parsed on save. */
export interface RequestsForm {
  enabled: boolean;
  maxPending: string;
  cooldownSec: string;
  perIpHourlyCap: string;
  globalHourlyCap: string;
  repeatCooldownMin: string;
  onePendingPerIp: boolean;
}

export interface SilenceTrimForm {
  enabled: boolean;
  minGapMs: string;
}

// settings.ducking — the two smooth_add depths radio.liq reads at mixer startup.
// Strings: a blank input must reach saveBlock as a field error, not 0 (a full mute).
export interface DuckingForm {
  voice: string;
  intro: string;
}

export interface FormState {
  crossfadeDuration: string;
  ducking: DuckingForm;
  maxTrackSeconds: string;
  /** Station default for the show-boundary fade (#1574). A show's own
   *  tri-state overrides it; this level is only ever on or off. */
  fadeAtShowEnd: boolean;
  silenceTrim: SilenceTrimForm;
  transitions: TransitionsForm;
  archive: ArchiveForm;
  stream: StreamForm;
  loudness: LoudnessForm;
  station: string;
  stationDescription: string;
  timezone: string;
  locale: StationLocale;
  kokoroLang: string;
  /** Talk placement switch: every scheduled segment waits for the next track boundary. */
  djTalkOnlyBetweenTracks: boolean;
  /** settings.handover.offsetMinutes. The values are a fixed set (multiples of the
   *  talk table's sampling stride), so it renders as a segmented control. */
  handoverOffsetMinutes: string;
  weather: WeatherCfg;
  tts: TtsForm;
  llm: LlmForm;
  picker: PickerForm;
  search: SearchForm;
  embedding: EmbeddingForm;
  scrobble: ScrobbleForm;
  privacy: PrivacyForm;
  likes: LikesForm;
  requests: RequestsForm;
}

export interface JingleEntry {
  filename: string;
  text?: string;
  size?: number;
  createdAt?: string;
  builtin?: boolean;
  source?: string;
}

export interface SettingsData {
  values?: {
    jingleRatio?: number;
    /** Who counts the tracks between jingles (#1619). Absent on an older
     *  controller, which is the same thing as 'mixer'. The union comes from the
     *  mirrored schema rather than being respelled here, so a value added to it
     *  reaches this form. */
    jingleRotate?: JingleRotateOwner;
    crossfadeDuration?: number;
    ducking?: { voice?: number; intro?: number };
    maxTrackSeconds?: number;
    minTrackSeconds?: number;
    archive?: { enabled?: boolean; bitrate?: number; retentionDays?: number };
    /** Scheduled backups (#1570). Edited from the Backup panel; posts `{ backups }`
     *  through the same POST /settings chokepoint. */
    backups?: { cadence?: string; keep?: number };
    transitions?: {
      pairDrain?: boolean;
      stemBlends?: boolean;
      effects?: Partial<Record<TransitionEffect, boolean>>;
    };
    audio?: { embeddings?: boolean; vocalActivity?: boolean; stemCache?: boolean; stemCacheGb?: number };
    stream?: {
      opusEnabled?: boolean;
      opusBitrate?: number;
      flacEnabled?: boolean;
      aacEnabled?: boolean;
      aacBitrate?: number;
      bitrate?: number;
      bufferSeconds?: number;
      oggIcyMetadata?: boolean;
      idleWhenEmpty?: boolean;
      idleAfterMinutes?: number;
      maxListeners?: number;
      countryHeader?: string;
      geoipDbPath?: string;
    };
    loudness?: { targetLufs?: number; maxBoostDb?: number; source?: LoudnessSource };
    silenceTrim?: { enabled?: boolean; minGapMs?: number };
    /** Absent on an older settings.json — false, like the controller's coercion. */
    fadeAtShowEnd?: boolean;
    /** Shortest playable track a boundary cut can arm on (seconds), served by
     *  the controller so the hint cannot drift from the drain's own floors. */
    boundaryFadeMinTrackSeconds?: number;
    station?: string;
    stationDescription?: string;
    timezone?: string;
    locale?: StationLocale;
    /** Absent on an older settings.json — read as false. */
    djTalkOnlyBetweenTracks?: boolean;
    /** Absent on an older settings.json — the 5-minute default. */
    handover?: { offsetMinutes?: number };
    theme?: { active?: string };
    weather?: {
      lat?: number;
      lng?: number;
      locationName?: string;
      onAirLocation?: string;
      units?: 'metric' | 'imperial';
    };
    tts?: {
      enabled?: boolean;
      defaultEngine?: string;
      fallback?: Partial<TtsFallbackForm>;
      kokoro?: { voice?: string; lang?: string };
      chatterbox?: { referenceVoice?: string };
      pocketTts?: { voice?: string };
      // Also carries the redacted key sentinels ('set' when a key is on file, '' otherwise).
      cloud?: Partial<CloudTtsCfg> & { apiKey?: string; compatApiKey?: string };
      remote?: { url?: string };
      gainDb?: Record<string, number>;
      speed?: Record<string, number>;
      corrections?: { from?: string; to?: string }[];
    };
    // Wire shape diverges from the form: the controller stores and returns `headers`
    // as a MAP (values redacted to 'set'); the editor holds an ordered row list.
    llm?: Omit<Partial<LlmForm>, 'headers' | 'fallback'> & {
      headers?: Record<string, string>;
      fallback?: Omit<Partial<LlmFallbackForm>, 'headers'> & {
        headers?: Record<string, string>;
      };
    };
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
    beds?: { enabled?: boolean; requestIntros?: boolean; thresholdSec?: number; crossSec?: number; tailSec?: number };
    ui?: { boothBuddy?: boolean; skin?: string; tuneInOverlay?: boolean };
    privacy?: {
      privatePlayer?: boolean;
      listenerAuth?: boolean;
      password?: string;
      publishPersonaSouls?: boolean;
    };
    requests?: {
      enabled?: boolean;
      maxPending?: number;
      globalHourlyCap?: number;
      repeatCooldownMin?: number;
      cooldownSec?: number;
      perIpHourlyCap?: number;
      onePendingPerIp?: boolean;
    };
    scrobble?: {
      lastfm?: Partial<ScrobbleLastfmForm>;
      listenbrainz?: Partial<ScrobbleListenbrainzForm>;
      navidrome?: Partial<ScrobbleNavidromeForm>;
    };
    picker?: {
      albumHours?: number;
      minTrackLengthSeconds?: number;
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
    available?: EngineAvailability;
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
    // The model the text index was built with ("provider:model") + its dim; null
    // when never embedded. Drives the chat-provider-switch warning in LlmSection.
    embeddingMeta?: { model: string; dim: number } | null;
  };
  tagger?: { running?: boolean };
  env?: Record<string, unknown>;
  // passSet only — the password value never reaches the browser. Env flags are
  // per-field: url can be env-managed while user/pass come from the wizard.
  navidrome?: {
    url?: string;
    user?: string;
    passSet?: boolean;
    env?: { url?: boolean; user?: boolean; pass?: boolean };
  };
  streamOnAir?: boolean;
  // What timezone '' (Auto) resolves to — the controller's own zone.
  serverTimezone?: string;
}

export type Patch = Record<string, unknown>;
export type SaveSettings = (patch: Patch) => Promise<boolean>;

export type FormUpdater = (updater: (f: FormState) => FormState) => void;

// Server-side validation errors from the last `/settings` save, keyed by the
// controller's dotted path ('beds.crossSec'). No client-side pre-flight: the
// key-to-schema registry is not a schema module, so it isn't in the mirror.
export type SettingsFieldErrors = Record<string, string>;

export interface SectionProps {
  data: SettingsData;
  form: FormState;
  setForm: FormUpdater;
  busy: boolean;
  saveSettings: SaveSettings;
  fieldErrors: SettingsFieldErrors;
}

// One settings input's server error, or nothing. `path` is the controller's
// dotted key, named at the call site.
export function SettingsFieldError({
  path,
  errors,
  id,
}: {
  path: string;
  errors: SettingsFieldErrors;
  id?: string;
}) {
  const message = errors[path];
  if (!message) return null;
  return <FieldError id={id} errors={[{ message }]} />;
}

// ARIA for one settings input, same id conventions as lib/form.ts's `fieldAria`.
// These sections can't use that: each control owns its own one-key save, so
// there is no single submit to bind a form to.
export function settingsFieldAria(baseId: string, message?: string) {
  const invalid = !!message;
  return {
    invalid,
    message,
    labelProps: { htmlFor: baseId },
    controlProps: {
      id: baseId,
      // Absent rather than aria-invalid="false".
      'aria-invalid': invalid || undefined,
      // Only reference the id when it is really in the DOM.
      'aria-describedby': invalid ? `${baseId}-error` : undefined,
    },
    errorProps: { id: `${baseId}-error` },
  } as const;
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
  actions?: ReactNode;
}

export function SectionHeader({ eyebrow, title, sub, metrics, manualHref, manualLabel, actions }: SectionHeaderProps) {
  const hasMetrics = !!(metrics && metrics.length > 0);
  const hasBar = hasMetrics || !!manualHref || !!actions;
  return (
    <section className="card">
      <div className={cn('p-4', hasBar && 'border-b border-ink')}>
        <Eyebrow className="text-vermilion">{eyebrow}</Eyebrow>
        <div className="mt-1.5 text-[22px] font-extrabold tracking-[-0.02em]">
          {title}
        </div>
        <div className="mt-1.5 max-w-[600px] text-[14px] leading-[1.55] text-muted">
          {sub}
        </div>
        {manualHref && !hasBar && (
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
      {hasBar && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 bg-[var(--ink-softer)] p-3.5">
          {metrics?.map((met, i) => <Metric key={i} n={met.n} l={met.l} accent={met.accent} />)}
          {(manualHref || actions) && (
            <div className="ml-auto flex items-center gap-3">
              {manualHref && (
                <a
                  href={manualHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[12px] font-bold text-vermilion underline decoration-[1.5px] underline-offset-2"
                >
                  {manualLabel || 'Read this in the manual'} ↗
                </a>
              )}
              {actions}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

interface SaveBarProps {
  note: ReactNode;
  busy: boolean;
  onSave: () => void;
  saveLabel: ReactNode;
  /** Server errors from the last save, keyed by dotted path. */
  errors?: SettingsFieldErrors;
  /** The top-level settings keys this bar's save owns, e.g. ['search']. */
  ownedKeys?: readonly string[];
  /** Whether this save has anything to commit -- ONLY for a section whose
   *  editable state does not live in FormState (see `SectionSpec.formKeys`). */
  dirty?: boolean;
}

/** Filter a fieldErrors map down to the paths a given save owns. */
export function ownedFieldErrors(
  errors: SettingsFieldErrors | undefined,
  ownedKeys: readonly string[] | undefined,
): Array<[string, string]> {
  if (!errors || !ownedKeys?.length) return [];
  return Object.entries(errors).filter(([path]) =>
    ownedKeys.some((key) => path === key || path.startsWith(`${key}.`)),
  );
}

/**
 * Success/failure goes through the global toaster; a VALIDATION failure also
 * lands here, beside the button that caused it, since one click can fail
 * several fields. Authored at the end of the section it saves but rendered in
 * SettingsPanel's one sticky bar via a portal, so each save keeps its own
 * closure, note and error scoping. No portal target means nothing is unsaved.
 */
export function SaveBar({ note, busy, onSave, saveLabel, errors, ownedKeys, dirty }: SaveBarProps) {
  const { saveSlot } = useSectionChrome();
  // Only a section whose state does not ride FormState passes `dirty`.
  useReportDirty(dirty);
  const owned = ownedFieldErrors(errors, ownedKeys);
  if (!saveSlot) return null;
  return createPortal(
    <div className="flex flex-wrap items-center gap-3 border-t border-[var(--separator-soft)] pt-2.5 first:border-0 first:pt-0">
      {owned.length > 0 && (
        // Full width so it sits on its own row above the note/button cluster.
        <div className="order-first w-full">
          {owned.map(([path, message]) => (
            <FieldError key={path} errors={[{ message }]} />
          ))}
        </div>
      )}
      {/* min-w-0 + break-words: notes carry unbroken values (a long model id)
          that would otherwise push the bar past a phone viewport. */}
      <span className="min-w-0 flex-1 text-[12px] leading-[1.5] break-words text-muted">{note}</span>
      {/* Full-width action row on a phone; `sm:` restores the inline cluster. */}
      <span className="ml-auto flex w-full gap-2 sm:w-auto">
        <m.span whileTap={{ scale: 0.97 }} className="inline-flex flex-1 sm:flex-none">
          <Btn tone="accent" onClick={onSave} disabled={busy} className="w-full sm:w-auto">{saveLabel}</Btn>
        </m.span>
      </span>
    </div>,
    saveSlot,
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
        <span className="text-[14px] leading-[1.5] text-muted">
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
        // break-words: provider errors carry raw URLs / long ids.
        'mt-2 max-w-[560px] rounded border bg-[var(--ink-softer)] px-3 py-2 text-[11px] leading-[1.6] break-words',
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

// Module-level "now previewing" handle so a second press anywhere on the admin
// page stops the first clip.
let currentPreview: { audio: HTMLAudioElement; url: string; stop: () => void } | null = null;

interface PreviewButtonProps {
  path: string;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  label?: string;
}

// The audio behind /api/jingles/.../audio and /api/sfx/.../audio is admin-gated
// (HTTP Basic), so a plain <audio src> can't send the header: adminFetch + Blob URL.
export function PreviewButton({ path, adminFetch, label = 'Play' }: PreviewButtonProps) {
  const [state, setState] = useState<'idle' | 'loading' | 'playing'>('idle');

  useEffect(() => {
    return () => {
      // Unmounting mid-preview must not leak the audio element or the object URL.
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
      // admin-query-imperative: protected-audio-preview
      const r = await adminResponse(adminFetch, path);
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

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={onClick}
      aria-label={state === 'playing' ? 'Stop preview' : label}
      title={state === 'playing' ? 'Stop preview' : 'Preview audio'}
    >
      {state === 'playing' ? (
        <span className="flex h-3.5 items-center gap-[2px]" aria-hidden>
          <span className="h-3 w-[2px] origin-bottom animate-[skin-eq_.7s_ease-in-out_infinite] bg-[var(--accent)]" />
          <span className="h-3 w-[2px] origin-bottom animate-[skin-eq_.7s_ease-in-out_.15s_infinite] bg-[var(--accent)]" />
          <span className="h-3 w-[2px] origin-bottom animate-[skin-eq_.7s_ease-in-out_.3s_infinite] bg-[var(--accent)]" />
        </span>
      ) : state === 'loading' ? (
        <span className="font-mono text-[13px] leading-none" aria-hidden>…</span>
      ) : (
        <Play className="fill-current" aria-hidden />
      )}
    </Button>
  );
}
