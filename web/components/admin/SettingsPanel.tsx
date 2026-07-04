'use client';

import type { ChangeEvent, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useDynamicStyle } from '../../hooks/useDynamicStyle';
import { m } from 'motion/react';
import { notify, errorMessage } from '../../lib/notify';
import { fmtClockMinute, fmtSize, normalizeStationLocale, type StationLocale } from '../../lib/format';
import { useAdminAuth } from '../../lib/adminAuth';
import { useModelDiscovery } from '@/hooks/useModelDiscovery';
import { applyTheme, cacheTheme } from '../../lib/theme';
import { CLOUD_VOICES, CLOUD_MODELS } from '../../lib/cloudVoices';
import { V3AlertDialog } from '../ui/alert-dialog';
import { Modal } from '../ui/modal';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { Label } from '../ui/label';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectGroup, SelectLabel,
} from '../ui/select';
import { Card, Btn, Pill, Eyebrow, Seg, Metric } from './ui';
import { EngineSelector } from './tts/EngineSelector';
import { VoicePreviewButton } from './tts/VoicePreviewButton';
import { ProviderSelector } from './llm/ProviderSelector';
import { EmbeddingProviderSelector } from './embedding/EmbeddingProviderSelector';
import { ModelCombobox } from './llm/ModelCombobox';
import { LLM_ENV_VARS, llmProviderLabel } from './llm/providerMeta';
import { AiFill } from './AiFill';
import { LocationPicker, type GeocodeResult } from '../LocationPicker';
import { cn } from '../../lib/cn';
import ArchivesPanel from './ArchivesPanel';
import WebhooksPanel from './WebhooksPanel';
import BackupPanel from './BackupPanel';
import {
  Radio, Palette, Cpu, Mic, Library, Search, Music, AudioLines,
  Activity, Archive, Webhook, Save, AlertTriangle,
} from 'lucide-react';

const SECTIONS = [
  { id: 'station',  label: 'Station', hint: 'name · location · locale', icon: Radio },
  { id: 'theme',    label: 'Theme', hint: 'station-wide palette', icon: Palette },
  { id: 'llm',      label: 'LLM provider', hint: 'model routing', icon: Cpu },
  { id: 'tts',      label: 'TTS voice', hint: 'default engine', icon: Mic },
  { id: 'library',  label: 'Library tagger', hint: 'embedding · propagation', icon: Library },
  { id: 'search',   label: 'Web search', hint: 'live-facts backend', icon: Search },
  { id: 'jingles',  label: 'Jingles', hint: 'stingers', icon: Music },
  { id: 'sfx',      label: 'Sound FX', hint: 'agent stingers', icon: AudioLines },
  { id: 'scrobble', label: 'Scrobbling', hint: 'last.fm · listenbrainz', icon: Activity },
  { id: 'archives', label: 'Archives', hint: 'hourly recordings', icon: Archive },
  { id: 'webhooks', label: 'Webhooks', hint: 'outbound events', icon: Webhook },
  { id: 'backup',   label: 'Backup', hint: 'export · restore', icon: Save },
  { id: 'danger',   label: 'Danger zone', hint: 'broadcast control', icon: AlertTriangle },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

// LLM provider descriptors, the cloud-key env-var map and the badge logic live
// in ./llm/providerMeta (imported above) — shared with the ProviderSelector card
// grid and, later, the onboarding wizard. Don't redefine them here.

const KEY_HINTS: Record<string, string> = {
  ANTHROPIC_API_KEY: 'sk-ant-...',
  OPENAI_API_KEY: 'sk-...',
  GOOGLE_GENERATIVE_AI_API_KEY: 'AIza...',
  DEEPSEEK_API_KEY: 'sk-...',
  OPENROUTER_API_KEY: 'sk-or-v1-...',
  AI_GATEWAY_API_KEY: 'gateway API key',
  ELEVENLABS_API_KEY: 'el_...',
  EMBEDDING_API_KEY: 'optional — defaults to chat key',
};

// Suggested embedding model ids per provider — clickable chips under the Model
// field so operators don't have to guess a valid name. The #1 trip-up is typing
// an HF/locca repo id like "nomic-ai/nomic-embed-text-v1.5-GGUF" as an Ollama
// tag, which 404s; Ollama wants the short tag (nomic-embed-text). dim is shown
// so you can match the vector length of an already-tagged library.
const EMBED_MODEL_SUGGESTIONS: Record<string, { id: string; dim: number }[]> = {
  ollama: [
    { id: 'nomic-embed-text', dim: 768 },
    { id: 'mxbai-embed-large', dim: 1024 },
    { id: 'bge-m3', dim: 1024 },
    { id: 'all-minilm', dim: 384 },
  ],
  openai: [
    { id: 'text-embedding-3-small', dim: 1536 },
    { id: 'text-embedding-3-large', dim: 3072 },
  ],
  google: [{ id: 'text-embedding-004', dim: 768 }],
  openrouter: [
    { id: 'openai/text-embedding-3-small', dim: 1536 },
    { id: 'openai/text-embedding-3-large', dim: 3072 },
  ],
  requesty: [
    { id: 'openai/text-embedding-3-small', dim: 1536 },
    { id: 'openai/text-embedding-3-large', dim: 3072 },
  ],
};

const SEARCH_PROVIDER_LABELS: Record<string, string> = {
  duckduckgo: 'DuckDuckGo (free, no key)',
  tavily: 'Tavily (paid web search)',
  searxng: 'SearXNG (self-hosted)',
};

const searchProviderLabel = (id: string | undefined): string =>
  (id && SEARCH_PROVIDER_LABELS[id]) || id || '—';

interface WeatherCfg {
  lat: string;
  lng: string;
  locationName: string;
  units: 'metric' | 'imperial';
}

interface CloudTtsCfg {
  enabled: boolean;
  provider: string;
  model: string;
  voice: string;
  baseUrl: string;
}

interface TtsForm {
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
}

interface LlmFallbackForm {
  enabled: boolean;
  provider: string;
  model: string;
  ollamaUrl: string;
  numCtx: number;
  baseUrl: string;
  reasoning: boolean;
}

interface LlmForm {
  provider: string;
  model: string;
  ollamaUrl: string;
  numCtx: number;
  baseUrl: string;
  reasoning: boolean;
  toolChoice: string;
  pickerAgent: boolean;
  noRepeatWindow: number;
  requestWebResolve: boolean;
  agentTimeoutMs: number;
  pauseWhenEmpty: boolean;
  dailyTokenCap: number;
  budgetSoftPct: number;
  exemptRequests: boolean;
  maxOutputTokens: number;
  fallback: LlmFallbackForm;
}

interface SearchForm {
  provider: string;
  apiKey: string;
  baseUrl: string;
}

interface EmbeddingEnrichmentForm {
  lastfmTags: boolean;
  lyrics: boolean;
}

interface EmbeddingForm {
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
  enrichment: EmbeddingEnrichmentForm;
}

interface ScrobbleLastfmForm {
  enabled: boolean;
  apiKey: string;
  apiSecret: string;
  sessionKey: string;
  username: string;
}

interface ScrobbleListenbrainzForm {
  enabled: boolean;
  userToken: string;
  username: string;
  baseUrl: string;
}

interface ScrobbleForm {
  lastfm: ScrobbleLastfmForm;
  listenbrainz: ScrobbleListenbrainzForm;
}

interface ArchiveForm {
  enabled: boolean;
  bitrate: string;
}

interface StreamForm {
  opusEnabled: boolean;
  opusBitrate: string;
  flacEnabled: boolean;
  aacEnabled: boolean;
  aacBitrate: string;
  bitrate: string;
}

interface LoudnessForm {
  targetLufs: string;
  maxBoostDb: string;
}

// Keep in sync with MP3_BITRATES in controller/src/settings.ts — radio.liq
// has a literal `%mp3(bitrate=…)` branch per value, so this set is fixed.
const MP3_BITRATES = [64, 96, 128, 160, 192, 320] as const;
// Keep in sync with OPUS_BITRATES / AAC_BITRATES in controller/src/settings.ts.
const OPUS_BITRATES = [96, 128, 192, 256, 320] as const;
const AAC_BITRATES = [128, 192, 256] as const;

interface FormState {
  jingleRatio: string;
  crossfadeDuration: string;
  maxTrackSeconds: string;
  archive: ArchiveForm;
  stream: StreamForm;
  loudness: LoudnessForm;
  station: string;
  timezone: string;
  locale: StationLocale;
  weather: WeatherCfg;
  tts: TtsForm;
  llm: LlmForm;
  search: SearchForm;
  embedding: EmbeddingForm;
  scrobble: ScrobbleForm;
}

interface JingleEntry {
  filename: string;
  text?: string;
  size?: number;
  createdAt?: string;
  builtin?: boolean;
  source?: string;
}

interface SfxEntry {
  name: string;
  description?: string;
  size?: number;
  durationSec?: number;
  builtin?: boolean;
  source?: string;
}

interface SfxData {
  sfx?: SfxEntry[];
  generatorReady?: boolean;
}

interface SettingsData {
  values?: {
    jingleRatio?: number;
    crossfadeDuration?: number;
    maxTrackSeconds?: number;
    minTrackSeconds?: number;
    archive?: { enabled?: boolean; bitrate?: number };
    stream?: {
      opusEnabled?: boolean;
      opusBitrate?: number;
      flacEnabled?: boolean;
      aacEnabled?: boolean;
      aacBitrate?: number;
      bitrate?: number;
    };
    loudness?: { targetLufs?: number; maxBoostDb?: number };
    station?: string;
    timezone?: string;
    locale?: StationLocale;
    theme?: { active?: string };
    weather?: { lat?: number; lng?: number; locationName?: string; units?: 'metric' | 'imperial' };
    tts?: {
      defaultEngine?: string;
      kokoro?: { voice?: string };
      chatterbox?: { referenceVoice?: string };
      pocketTts?: { voice?: string };
      cloud?: Partial<CloudTtsCfg>;
      remote?: { url?: string };
      gainDb?: Record<string, number>;
      speed?: Record<string, number>;
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
      enrichment?: Partial<EmbeddingEnrichmentForm>;
    };
    sfx?: { enabled?: boolean };
    ui?: { boothBuddy?: boolean };
    scrobble?: {
      lastfm?: Partial<ScrobbleLastfmForm>;
      listenbrainz?: Partial<ScrobbleListenbrainzForm>;
    };
  };
  tts?: {
    engines?: string[];
    available?: Record<string, boolean>;
    kokoroVoices?: Array<{ id: string; label: string }>;
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

interface SfxForm {
  name: string;
  description: string;
  prompt: string;
  durationSec: string;
}

type Patch = Record<string, unknown>;
type SaveSettings = (patch: Patch) => Promise<void>;

export default function SettingsPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [data, setData] = useState<SettingsData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [jingleText, setJingleText] = useState('');
  const [form, setForm] = useState<FormState | null>(null);
  const [pendingRestart, setPendingRestart] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<SectionId>('station');
  const [sfxData, setSfxData] = useState<SfxData | null>(null);
  const [sfxForm, setSfxForm] = useState<SfxForm>({ name: '', description: '', prompt: '', durationSec: '' });
  const [confirmDeleteSfx, setConfirmDeleteSfx] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const r = await adminFetch('/settings');
      if (!r.ok) return;
      const j = (await r.json()) as SettingsData;
      setData(j); setErr(null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  const refreshSfx = async () => {
    try {
      const r = await adminFetch('/sfx');
      if (!r.ok) return;
      setSfxData((await r.json()) as SfxData);
    } catch { /* non-fatal */ }
  };

  // Deep-link: /admin/settings?section=webhooks opens that rail directly. The
  // old standalone /admin/{archives,webhooks,backup} routes redirect here, so
  // existing bookmarks keep working after the move into Settings.
  useEffect(() => {
    const s = new URLSearchParams(window.location.search).get('section');
    if (s && SECTIONS.some(x => x.id === s)) setActiveSection(s as SectionId);
  }, []);

  useEffect(() => {
    if (!data?.values || form) return;
    const v = data.values;
    setForm({
      jingleRatio: String(v.jingleRatio ?? ''),
      crossfadeDuration: String(v.crossfadeDuration ?? ''),
      maxTrackSeconds: String(v.maxTrackSeconds ?? 0),
      archive: {
        enabled: v.archive?.enabled ?? true,
        bitrate: String(v.archive?.bitrate ?? 128),
      },
      stream: {
        opusEnabled: v.stream?.opusEnabled ?? true,
        opusBitrate: String(v.stream?.opusBitrate ?? 96),
        flacEnabled: v.stream?.flacEnabled ?? false,
        aacEnabled: v.stream?.aacEnabled ?? false,
        aacBitrate: String(v.stream?.aacBitrate ?? 192),
        bitrate: String(v.stream?.bitrate ?? 192),
      },
      loudness: {
        targetLufs: String(v.loudness?.targetLufs ?? -14),
        maxBoostDb: String(v.loudness?.maxBoostDb ?? 6),
      },
      station: v.station ?? '',
      timezone: v.timezone ?? '',
      locale: normalizeStationLocale(v.locale),
      weather: {
        lat: String(v.weather?.lat ?? ''),
        lng: String(v.weather?.lng ?? ''),
        locationName: v.weather?.locationName ?? '',
        units: v.weather?.units === 'imperial' ? 'imperial' : 'metric',
      },
      tts: {
        defaultEngine: v.tts?.defaultEngine ?? 'piper',
        kokoro: { voice: v.tts?.kokoro?.voice ?? 'bf_isabella' },
        chatterbox: { referenceVoice: v.tts?.chatterbox?.referenceVoice ?? '' },
        pocketTts: { voice: v.tts?.pocketTts?.voice ?? 'alba' },
        cloud: {
          enabled: v.tts?.cloud?.enabled ?? false,
          provider: v.tts?.cloud?.provider ?? 'openai',
          model: v.tts?.cloud?.model ?? '',
          voice: v.tts?.cloud?.voice ?? '',
          baseUrl: v.tts?.cloud?.baseUrl ?? '',
        },
        remote: { url: v.tts?.remote?.url ?? '' },
        // Per-engine voice level (dB). Zero default for all 6 engine ids, then
        // overlay any saved values. Keyed by engine id — `pocket-tts` (hyphen).
        gainDb: {
          piper: 0,
          kokoro: 0,
          chatterbox: 0,
          'pocket-tts': 0,
          cloud: 0,
          remote: 0,
          ...(v.tts?.gainDb || {}),
        },
        // Per-engine speech speed (×). Unity default for all 6, then overlay
        // any saved values. Keyed by engine id — `pocket-tts` (hyphen).
        speed: {
          piper: 1,
          kokoro: 1,
          chatterbox: 1,
          'pocket-tts': 1,
          cloud: 1,
          remote: 1,
          ...(v.tts?.speed || {}),
        },
      },
      llm: {
        provider: v.llm?.provider ?? 'ollama',
        model: v.llm?.model ?? '',
        ollamaUrl: v.llm?.ollamaUrl ?? '',
        numCtx: typeof v.llm?.numCtx === 'number' ? v.llm.numCtx : 16384,
        baseUrl: v.llm?.baseUrl ?? '',
        reasoning: !!v.llm?.reasoning,
        toolChoice: v.llm?.toolChoice === 'auto' ? 'auto' : 'required',
        pickerAgent: !!v.llm?.pickerAgent,
        noRepeatWindow: typeof v.llm?.noRepeatWindow === 'number' ? v.llm.noRepeatWindow : 100,
        requestWebResolve: !!v.llm?.requestWebResolve,
        agentTimeoutMs: typeof v.llm?.agentTimeoutMs === 'number' ? v.llm.agentTimeoutMs : 45000,
        pauseWhenEmpty: !!v.llm?.pauseWhenEmpty,
        dailyTokenCap: typeof v.llm?.dailyTokenCap === 'number' ? v.llm.dailyTokenCap : 0,
        budgetSoftPct: typeof v.llm?.budgetSoftPct === 'number' ? v.llm.budgetSoftPct : 80,
        exemptRequests: v.llm?.exemptRequests !== false,
        maxOutputTokens: typeof v.llm?.maxOutputTokens === 'number' ? v.llm.maxOutputTokens : 0,
        fallback: {
          enabled: !!v.llm?.fallback?.enabled,
          provider: v.llm?.fallback?.provider ?? 'ollama',
          model: v.llm?.fallback?.model ?? '',
          ollamaUrl: v.llm?.fallback?.ollamaUrl ?? '',
          numCtx: typeof v.llm?.fallback?.numCtx === 'number' ? v.llm.fallback.numCtx : 16384,
          baseUrl: v.llm?.fallback?.baseUrl ?? '',
          reasoning: !!v.llm?.fallback?.reasoning,
        },
      },
      search: {
        provider: v.search?.provider ?? 'duckduckgo',
        // GET /settings returns the apiKey redacted to 'set' | '' — that
        // round-trips through POST harmlessly (settings.update ignores 'set').
        apiKey: v.search?.apiKey ?? '',
        baseUrl: v.search?.baseUrl ?? '',
      },
      embedding: {
        enabled: v.embedding?.enabled ?? true,
        provider: v.embedding?.provider ?? '',
        model: v.embedding?.model ?? '',
        baseUrl: v.embedding?.baseUrl ?? '',
        ollamaUrl: v.embedding?.ollamaUrl ?? '',
        seedCount: String(v.embedding?.seedCount ?? 0),
        knnNeighbours: String(v.embedding?.knnNeighbours ?? 10),
        moodVoteThreshold: String(v.embedding?.moodVoteThreshold ?? 0.4),
        confidenceThreshold: String(v.embedding?.confidenceThreshold ?? 0.35),
        maxActiveLearningRounds: String(v.embedding?.maxActiveLearningRounds ?? 3),
        audioFusionWeight: String(v.embedding?.audioFusionWeight ?? 0.5),
        enrichment: {
          lastfmTags: v.embedding?.enrichment?.lastfmTags ?? false,
          lyrics: v.embedding?.enrichment?.lyrics ?? true,
        },
      },
      scrobble: {
        lastfm: {
          enabled: !!v.scrobble?.lastfm?.enabled,
          // 'set' sentinel from getRedacted() — round-trips harmlessly.
          apiKey: v.scrobble?.lastfm?.apiKey ?? '',
          apiSecret: v.scrobble?.lastfm?.apiSecret ?? '',
          sessionKey: v.scrobble?.lastfm?.sessionKey ?? '',
          username: v.scrobble?.lastfm?.username ?? '',
        },
        listenbrainz: {
          enabled: !!v.scrobble?.listenbrainz?.enabled,
          userToken: v.scrobble?.listenbrainz?.userToken ?? '',
          username: v.scrobble?.listenbrainz?.username ?? '',
          baseUrl: v.scrobble?.listenbrainz?.baseUrl ?? '',
        },
      },
    });
  }, [data, form]);

  useEffect(() => {
    if (!hydrated || needsAuth) return;
    refresh();
    refreshSfx();
    const id = setInterval(() => { refresh(); refreshSfx(); }, 3000);
    return () => clearInterval(id);
  }, [hydrated, needsAuth]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveSettings: SaveSettings = async (patch) => {
    setBusy(true);
    try {
      const r = await adminFetch('/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string; requiresRestart?: boolean };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      if (j.requiresRestart) setPendingRestart(true);
      notify.ok(j.requiresRestart ? 'saved, restart the mixer to apply' : 'saved');
      await refresh();
    } catch (e) {
      notify.err(errorMessage(e));
    } finally { setBusy(false); }
  };

  const restartMixer = async () => {
    setBusy(true);
    try {
      const r = await adminFetch('/restart-mixer', { method: 'POST' });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      setPendingRestart(false);
      notify.ok('mixer restarting, give it a few seconds');
    } catch (e) {
      notify.err(errorMessage(e));
    } finally { setBusy(false); }
  };

  const stopStream = async () => {
    setBusy(true);
    try {
      const r = await adminFetch('/stream-stop', { method: 'POST' });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      notify.ok('stream stopped, station is off air');
      await refresh();
    } catch (e) {
      notify.err(errorMessage(e));
    } finally { setBusy(false); }
  };

  const startStream = async () => {
    setBusy(true);
    try {
      const r = await adminFetch('/stream-start', { method: 'POST' });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      notify.ok('stream started, station is on air');
      await refresh();
    } catch (e) {
      notify.err(errorMessage(e));
    } finally { setBusy(false); }
  };

  const createJingle = async (): Promise<boolean> => {
    if (!jingleText.trim() || busy) return false;
    setBusy(true);
    try {
      const r = await adminFetch('/jingles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: jingleText.trim() }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      setJingleText('');
      await refresh();
      return true;
    } catch (e) { notify.err(`Jingle creation failed: ${errorMessage(e)}`); return false; }
    finally { setBusy(false); }
  };

  const deleteJingle = async (filename: string) => {
    setBusy(true);
    try {
      const r = await adminFetch(`/jingles/${encodeURIComponent(filename)}`, { method: 'DELETE' });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      await refresh();
    } catch (e) { notify.err(`Delete failed: ${errorMessage(e)}`); }
    finally { setBusy(false); }
  };

  // Multipart upload — adminFetch leaves Content-Type unset so the browser
  // sets the multipart boundary itself. The controller transcodes + levels.
  const uploadJingle = async (file: File, label: string): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (label.trim()) fd.append('label', label.trim());
      const r = await adminFetch('/jingles/upload', { method: 'POST', body: fd });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      await refresh();
      notify.ok('jingle imported');
      return true;
    } catch (e) { notify.err(`Jingle import failed: ${errorMessage(e)}`); return false; }
    finally { setBusy(false); }
  };

  const createSfx = async (): Promise<boolean> => {
    if (!sfxForm.name.trim() || !sfxForm.prompt.trim() || busy) return false;
    setBusy(true);
    try {
      const r = await adminFetch('/sfx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: sfxForm.name.trim(),
          description: sfxForm.description.trim(),
          prompt: sfxForm.prompt.trim(),
          durationSec: sfxForm.durationSec ? parseFloat(sfxForm.durationSec) : undefined,
        }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      setSfxForm({ name: '', description: '', prompt: '', durationSec: '' });
      await refreshSfx();
      return true;
    } catch (e) { notify.err(`Sound effect creation failed: ${errorMessage(e)}`); return false; }
    finally { setBusy(false); }
  };

  const deleteSfx = async (name: string) => {
    setBusy(true);
    try {
      const r = await adminFetch(`/sfx/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      await refreshSfx();
    } catch (e) { notify.err(`Delete failed: ${errorMessage(e)}`); }
    finally { setBusy(false); }
  };

  // Upload a ready-made effect — no ElevenLabs key required (unlike createSfx).
  const uploadSfx = async (file: File, name: string, description: string): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('name', name.trim());
      if (description.trim()) fd.append('description', description.trim());
      const r = await adminFetch('/sfx/upload', { method: 'POST', body: fd });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      await refreshSfx();
      notify.ok('sound effect imported');
      return true;
    } catch (e) { notify.err(`Sound effect import failed: ${errorMessage(e)}`); return false; }
    finally { setBusy(false); }
  };

  return (
    <div className="stack-mobile grid grid-cols-[240px_1fr] items-start gap-6">
      {/* Section rail */}
      <aside className="grid gap-1 sm:sticky sm:top-6">
        <span className="caption pb-2">settings</span>
        {SECTIONS.map(s => {
          const isActive = activeSection === s.id;
          const Icon = s.icon;
          return (
            <button
              key={s.id}
              onClick={() => setActiveSection(s.id)}
              className={cn(
                'flex cursor-pointer items-center gap-2.5 border border-ink px-3 py-2.5 text-left font-[inherit] transition-colors',
                isActive ? 'bg-ink text-bg' : 'bg-[var(--ink-soft)] text-ink hover:bg-ink/10',
              )}
            >
              <Icon className="size-4 shrink-0 opacity-80" strokeWidth={2} aria-hidden />
              <span className="grid min-w-0 gap-1">
                <span className="text-[11px] font-bold tracking-[0.2em] uppercase">
                  {s.label}
                </span>
                <span className="text-[9px] tracking-[0.18em] uppercase opacity-70">
                  {s.id === 'jingles' && data
                    ? `${data.jingles?.length ?? 0} file${(data.jingles?.length ?? 0) === 1 ? '' : 's'}`
                    : s.id === 'sfx' && sfxData
                      ? `${sfxData.sfx?.length ?? 0} effect${(sfxData.sfx?.length ?? 0) === 1 ? '' : 's'}`
                      : s.hint}
                </span>
              </span>
            </button>
          );
        })}
      </aside>

      {/* Active section */}
      <div className="grid gap-4">
        {err && (
          <div className="card border-[var(--danger)]">
            <div className="card-body text-[12px] text-[var(--danger)]">
              <strong className="tracking-[0.12em] uppercase">controller error</strong>
              <div className="mt-1">{err}</div>
            </div>
          </div>
        )}
        {!data && !err && (
          <div className="text-[13px] text-muted italic">loading…</div>
        )}

        {data && form && (() => {
          const updateForm: FormUpdater = (updater) =>
            setForm(prev => (prev ? updater(prev) : prev));
          return (
          <>
            {activeSection === 'tts' && data.tts && (
              <TtsSection
                data={data} form={form} setForm={updateForm} busy={busy}
                saveSettings={saveSettings} adminFetch={adminFetch} refresh={refresh}
              />
            )}
            {activeSection === 'llm' && data.llm && (
              <LlmSection
                data={data} form={form} setForm={updateForm} busy={busy}
                saveSettings={saveSettings} adminFetch={adminFetch} refresh={refresh}
              />
            )}
            {activeSection === 'search' && (
              <SearchSection
                data={data} form={form} setForm={updateForm} busy={busy}
                saveSettings={saveSettings} adminFetch={adminFetch}
              />
            )}
            {activeSection === 'library' && (
              <LibrarySection
                data={data} form={form} setForm={updateForm} busy={busy}
                saveSettings={saveSettings} adminFetch={adminFetch} refresh={refresh}
              />
            )}
            {activeSection === 'station' && (
              <StationSection
                data={data} form={form} setForm={updateForm} busy={busy}
                saveSettings={saveSettings}
              />
            )}
            {activeSection === 'theme' && (
              <ThemeSection
                data={data} busy={busy} saveSettings={saveSettings}
                adminFetch={adminFetch}
              />
            )}
            {activeSection === 'jingles' && (
              <JinglesSection
                data={data} form={form} setForm={updateForm} busy={busy}
                jingleText={jingleText} setJingleText={setJingleText}
                createJingle={createJingle} uploadJingle={uploadJingle}
                saveSettings={saveSettings}
                onDelete={setConfirmDelete} adminFetch={adminFetch}
              />
            )}
            {activeSection === 'scrobble' && (
              <ScrobbleSection
                data={data} form={form} setForm={updateForm} busy={busy}
                saveSettings={saveSettings} adminFetch={adminFetch} refresh={refresh}
              />
            )}
          </>
          );
        })()}
        {activeSection === 'sfx' && (
          <SfxSection
            sfxData={sfxData} sfxForm={sfxForm} setSfxForm={setSfxForm}
            busy={busy} createSfx={createSfx} uploadSfx={uploadSfx}
            onDelete={setConfirmDeleteSfx}
            data={data} saveSettings={saveSettings} adminFetch={adminFetch}
          />
        )}
        {/* Self-contained panels — each re-calls useAdminAuth and owns its
            own data fetch, so they render outside the data && form guard. */}
        {activeSection === 'archives' && (
          <>
            <ArchivesPanel />
            {form && (
              <Card title="Hourly archive" sub="state/archive/%Y-%m-%d/%H-00.mp3">
                <div className="grid gap-3">
                  <div className="field">
                    <div className="flex items-center gap-2">
                      <Label>Record the broadcast to disk</Label>
                      <Pill tone="ink">restart required</Pill>
                    </div>
                    <div className="flex items-center gap-2">
                      <Seg
                        options={[
                          { id: 'on', label: 'On' },
                          { id: 'off', label: 'Off' },
                        ]}
                        value={form.archive.enabled ? 'on' : 'off'}
                        onChange={id =>
                          setForm(f =>
                            f ? { ...f, archive: { ...f.archive, enabled: id === 'on' } } : f,
                          )
                        }
                      />
                      <Btn
                        sm
                        onClick={() =>
                          saveSettings({ archive: { enabled: form.archive.enabled } })
                        }
                        disabled={busy}
                      >
                        Save
                      </Btn>
                    </div>
                    <div className="field-hint">
                      The archive runs a second MP3 encoder 24/7 and is the biggest constant
                      CPU cost in the broadcast container. Turn it off if you don't replay
                      the hourly tapes (issue #137).
                    </div>
                  </div>

                  <div className="field">
                    <div className="flex items-center gap-2">
                      <Label>Archive bitrate</Label>
                      <Pill tone="ink">restart required</Pill>
                    </div>
                    <div className="flex items-center gap-2">
                      <Select
                        value={form.archive.bitrate}
                        onValueChange={v =>
                          setForm(f => (f ? { ...f, archive: { ...f.archive, bitrate: v } } : f))
                        }
                      >
                        <SelectTrigger className="w-32" disabled={!form.archive.enabled}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {MP3_BITRATES.map(br => (
                            <SelectItem key={br} value={String(br)}>
                              {br} kbps
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Btn
                        sm
                        onClick={() =>
                          saveSettings({
                            archive: { bitrate: parseInt(form.archive.bitrate, 10) },
                          })
                        }
                        disabled={busy || !form.archive.enabled}
                      >
                        Save bitrate
                      </Btn>
                    </div>
                    <div className="field-hint">
                      Lower bitrate = smaller archives, less encoder CPU
                      (current: {data?.values?.archive?.bitrate ?? '—'} kbps). 128 kbps is the
                      original default.
                    </div>
                  </div>
                </div>
              </Card>
            )}
          </>
        )}
        {activeSection === 'webhooks' && <WebhooksPanel />}
        {activeSection === 'backup' && <BackupPanel />}
        {activeSection === 'danger' && (
          <>
            <SectionHeader
              eyebrow="danger zone"
              title="Crossfade, stream control, and mixer restart."
              sub="Crossfade is grouped here because it needs a mixer restart to apply. Stream stop and mixer restart both affect every current listener."
              metrics={[
                {
                  n: data?.streamOnAir == null ? '—' : data.streamOnAir ? 'on air' : 'off air',
                  l: 'broadcast',
                  accent: data?.streamOnAir === true,
                },
                { n: `${data?.values?.crossfadeDuration ?? '—'}s`, l: 'crossfade' },
              ]}
            />

            <Card title="Broadcast" sub={data?.streamOnAir === false ? 'currently off air' : 'currently on air'}>
              <div className="grid gap-2">
                {data?.streamOnAir === false ? (
                  <Btn sm tone="accent" onClick={startStream} disabled={busy || !data}>
                    Start stream
                  </Btn>
                ) : (
                  <Btn sm tone="danger" onClick={() => setConfirmStop(true)} disabled={busy || !data || data?.streamOnAir == null}>
                    Stop stream
                  </Btn>
                )}
                <div className="field-hint">
                  Takes the station off air by disconnecting the Icecast mount. A mixer restart brings it back on air.
                </div>
              </div>
            </Card>

            {form && (
              <Card title="Crossfade" sub="track transition overlap">
                <div className="field">
                  <div className="flex items-center gap-2">
                    <Label>Crossfade duration</Label>
                    <Pill tone="ink">restart required</Pill>
                  </div>
                  <div className="flex items-center gap-2">
                    <Input
                      className="mono-num w-28"
                      type="number"
                      step={0.5}
                      max={30}
                      value={form.crossfadeDuration}
                      onChange={(e: ChangeEvent<HTMLInputElement>) =>
                        setForm(f => (f ? { ...f, crossfadeDuration: e.target.value } : f))
                      }
                    />
                    <span className="text-[12px] text-muted">sec</span>
                    <Btn
                      sm
                      onClick={() =>
                        saveSettings({ crossfadeDuration: parseFloat(form.crossfadeDuration) })
                      }
                      disabled={busy}
                    >
                      Save crossfade
                    </Btn>
                  </div>
                  <div className="field-hint">
                    Seconds of overlap between tracks (current: {data?.values?.crossfadeDuration}s).
                    Saving flags a pending restart. Apply it with the Mixer card below.
                  </div>
                </div>
              </Card>
            )}

            {form && (
              <Card title="Max track length" sub="cut over-length tracks on air">
                <div className="field">
                  <Label>Maximum track length</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      className="mono-num w-28"
                      type="number"
                      step={1}
                      min={0}
                      max={36000}
                      value={form.maxTrackSeconds}
                      onChange={(e: ChangeEvent<HTMLInputElement>) =>
                        setForm(f => (f ? { ...f, maxTrackSeconds: e.target.value } : f))
                      }
                    />
                    <span className="text-[12px] text-muted">
                      sec · 0 = no limit · min {data?.values?.minTrackSeconds ?? 30}s
                    </span>
                    <Btn
                      sm
                      onClick={() =>
                        saveSettings({ maxTrackSeconds: parseInt(form.maxTrackSeconds, 10) || 0 })
                      }
                      disabled={busy}
                    >
                      Save limit
                    </Btn>
                  </div>
                  <div className="field-hint">
                    The DJ won&rsquo;t auto-pick tracks longer than this — handy for hour-long
                    album mixes or DJ sets that keep landing in rotation. Listener requests still
                    play any length, and a show can override this with its own limit (0 there means
                    unlimited). Applies on the next pick; no restart needed.
                  </div>
                </div>
              </Card>
            )}

            {form && (
              <Card title="Loudness levelling" sub="per-track volume normalisation">
                <div className="grid gap-3">
                  <div className="field">
                    <Label>Target loudness</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        className="mono-num w-28"
                        type="number"
                        step={1}
                        min={-23}
                        max={-9}
                        value={form.loudness.targetLufs}
                        onChange={(e: ChangeEvent<HTMLInputElement>) =>
                          setForm(f =>
                            f ? { ...f, loudness: { ...f.loudness, targetLufs: e.target.value } } : f,
                          )
                        }
                      />
                      <span className="text-[12px] text-muted">LUFS · −23 to −9</span>
                    </div>
                    <div className="field-hint">
                      Every analysed track is pulled toward this level. −14 is the streaming
                      standard (Spotify, YouTube). A quieter target like −16 narrows the gap in
                      mixed libraries: loud modern masters come down more, and quiet dynamic ones
                      (classical, jazz) need less lift to catch up.
                    </div>
                  </div>
                  <div className="field">
                    <Label>Max boost</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        className="mono-num w-28"
                        type="number"
                        step={1}
                        min={0}
                        max={12}
                        value={form.loudness.maxBoostDb}
                        onChange={(e: ChangeEvent<HTMLInputElement>) =>
                          setForm(f =>
                            f ? { ...f, loudness: { ...f.loudness, maxBoostDb: e.target.value } } : f,
                          )
                        }
                      />
                      <span className="text-[12px] text-muted">dB · 0 to 12</span>
                      <Btn
                        sm
                        onClick={() =>
                          saveSettings({
                            loudness: {
                              targetLufs: parseFloat(form.loudness.targetLufs),
                              maxBoostDb: parseFloat(form.loudness.maxBoostDb),
                            },
                          })
                        }
                        disabled={busy}
                      >
                        Save loudness
                      </Btn>
                    </div>
                    <div className="field-hint">
                      Cap on how far a quiet track is turned up (0 = level down only). Boost is
                      also limited by each track&rsquo;s own measured peak headroom, so raising
                      this won&rsquo;t distort dynamic material — very quiet, dynamic masters
                      simply can&rsquo;t reach the target cleanly. Loud tracks are turned down as
                      far as needed. Applies from the next queued track; no restart, tracks need
                      acoustic analysis (Library → Analyze).
                    </div>
                  </div>
                </div>
              </Card>
            )}

            {form && (
              <Card title="Opus stream" sub="/stream.opus (Ogg-Opus)">
                <div className="grid gap-3">
                  <div className="field">
                    <div className="flex items-center gap-2">
                      <Label>Serve the secondary Opus mount</Label>
                      <Pill tone="ink">restart required</Pill>
                    </div>
                    <div className="flex items-center gap-2">
                      <Seg
                        options={[
                          { id: 'on', label: 'On' },
                          { id: 'off', label: 'Off' },
                        ]}
                        value={form.stream.opusEnabled ? 'on' : 'off'}
                        onChange={id =>
                          setForm(f =>
                            f ? { ...f, stream: { ...f.stream, opusEnabled: id === 'on' } } : f,
                          )
                        }
                      />
                      <Btn
                        sm
                        onClick={() =>
                          saveSettings({ stream: { opusEnabled: form.stream.opusEnabled } })
                        }
                        disabled={busy}
                      >
                        Save
                      </Btn>
                    </div>
                    <div className="field-hint">
                      Off by default. Only Chrome/Edge listeners ever pick Opus (Safari, iOS and
                      Firefox stay on the universal MP3 mount); for them it&apos;s equal-or-better
                      quality at ~half the bandwidth, but it adds a continuous second encoder + a
                      44.1→48 kHz resample. Turn it on if you have Chrome/Edge listeners and want
                      the bandwidth saving. The mandatory <code>/stream.mp3</code> mount serves
                      everyone either way.
                    </div>
                  </div>
                  <div className="field">
                    <div className="flex items-center gap-2">
                      <Label>Bitrate</Label>
                      <Pill tone="ink">restart required</Pill>
                    </div>
                    <div className="flex items-center gap-2">
                      <Select
                        value={form.stream.opusBitrate}
                        onValueChange={v =>
                          setForm(f => (f ? { ...f, stream: { ...f.stream, opusBitrate: v } } : f))
                        }
                      >
                        <SelectTrigger className="w-32">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {OPUS_BITRATES.map(br => (
                            <SelectItem key={br} value={String(br)}>
                              {br} kbps
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Btn
                        sm
                        onClick={() =>
                          saveSettings({
                            stream: { opusBitrate: parseInt(form.stream.opusBitrate, 10) },
                          })
                        }
                        disabled={busy}
                      >
                        Save bitrate
                      </Btn>
                    </div>
                    <div className="field-hint">
                      96 kbps is transparent for most music; 256/320 suits hifi listeners
                      (current: {data?.values?.stream?.opusBitrate ?? '—'} kbps). Raising it
                      increases bandwidth for <em>every</em> Chrome/Edge listener, since the web
                      player auto-selects this mount.
                    </div>
                  </div>
                </div>
              </Card>
            )}

            {form && (
              <Card title="FLAC stream" sub="/stream.flac (Ogg FLAC, lossless)">
                <div className="field">
                  <div className="flex items-center gap-2">
                    <Label>Serve the lossless FLAC mount</Label>
                    <Pill tone="ink">restart required</Pill>
                  </div>
                  <div className="flex items-center gap-2">
                    <Seg
                      options={[
                        { id: 'on', label: 'On' },
                        { id: 'off', label: 'Off' },
                      ]}
                      value={form.stream.flacEnabled ? 'on' : 'off'}
                      onChange={id =>
                        setForm(f =>
                          f ? { ...f, stream: { ...f.stream, flacEnabled: id === 'on' } } : f,
                        )
                      }
                    />
                    <Btn
                      sm
                      onClick={() =>
                        saveSettings({ stream: { flacEnabled: form.stream.flacEnabled } })
                      }
                      disabled={busy}
                    >
                      Save
                    </Btn>
                  </div>
                  {form.stream.flacEnabled && (
                    <div className="field-hint">
                      Point a player at{' '}
                      <code>
                        {typeof window !== 'undefined' ? window.location.origin : ''}
                        /stream.flac
                      </code>
                    </div>
                  )}
                  <div className="field-hint">
                    Off by default. A continuous third encoder that losslessly captures the
                    broadcast bus at ~800–900 kbps (≈4× the MP3 mount). It&apos;s a true lossless
                    tier <strong>only when your source files are themselves lossless</strong>{' '}
                    (FLAC/ALAC/WAV); for a lossy-source library (e.g. AAC/MP3) it faithfully
                    carries lossy audio and adds no fidelity over MP3/Opus. Meant for external
                    players (VLC, foobar2000, a network streamer) — the web and mobile players
                    stay on MP3/Opus and won&apos;t auto-select it. The mandatory{' '}
                    <code>/stream.mp3</code> mount always serves everyone.
                  </div>
                </div>
              </Card>
            )}

            {form && (
              <Card title="AAC stream" sub="/stream.aac (AAC-LC, ADTS)">
                <div className="grid gap-3">
                  <div className="field">
                    <div className="flex items-center gap-2">
                      <Label>Serve the AAC mount</Label>
                      <Pill tone="ink">restart required</Pill>
                    </div>
                    <div className="flex items-center gap-2">
                      <Seg
                        options={[
                          { id: 'on', label: 'On' },
                          { id: 'off', label: 'Off' },
                        ]}
                        value={form.stream.aacEnabled ? 'on' : 'off'}
                        onChange={id =>
                          setForm(f =>
                            f ? { ...f, stream: { ...f.stream, aacEnabled: id === 'on' } } : f,
                          )
                        }
                      />
                      <Btn
                        sm
                        onClick={() =>
                          saveSettings({ stream: { aacEnabled: form.stream.aacEnabled } })
                        }
                        disabled={busy}
                      >
                        Save
                      </Btn>
                    </div>
                    {form.stream.aacEnabled && (
                      <div className="field-hint">
                        Point a player at{' '}
                        <code>
                          {typeof window !== 'undefined' ? window.location.origin : ''}
                          /stream.aac
                        </code>
                      </div>
                    )}
                    <div className="field-hint">
                      Off by default. A continuous AAC-LC encoder whose purpose is reach —
                      players and hardware that decode AAC but not Opus. Aimed at external
                      players; the web and mobile players stay on MP3/Opus and won&apos;t
                      auto-select it. The mandatory <code>/stream.mp3</code> mount serves
                      everyone either way.
                    </div>
                  </div>
                  <div className="field">
                    <div className="flex items-center gap-2">
                      <Label>Bitrate</Label>
                      <Pill tone="ink">restart required</Pill>
                    </div>
                    <div className="flex items-center gap-2">
                      <Select
                        value={form.stream.aacBitrate}
                        onValueChange={v =>
                          setForm(f => (f ? { ...f, stream: { ...f.stream, aacBitrate: v } } : f))
                        }
                      >
                        <SelectTrigger className="w-32">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {AAC_BITRATES.map(br => (
                            <SelectItem key={br} value={String(br)}>
                              {br} kbps
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Btn
                        sm
                        onClick={() =>
                          saveSettings({
                            stream: { aacBitrate: parseInt(form.stream.aacBitrate, 10) },
                          })
                        }
                        disabled={busy}
                      >
                        Save bitrate
                      </Btn>
                    </div>
                    <div className="field-hint">
                      AAC-LC is transparent around 256 kbps (current:{' '}
                      {data?.values?.stream?.aacBitrate ?? '—'} kbps).
                    </div>
                  </div>
                </div>
              </Card>
            )}

            {form && (
              <Card title="Stream MP3 bitrate" sub="/stream.mp3">
                <div className="field">
                  <div className="flex items-center gap-2">
                    <Label>Bitrate</Label>
                    <Pill tone="ink">restart required</Pill>
                  </div>
                  <div className="flex items-center gap-2">
                    <Select
                      value={form.stream.bitrate}
                      onValueChange={v =>
                        setForm(f => (f ? { ...f, stream: { ...f.stream, bitrate: v } } : f))
                      }
                    >
                      <SelectTrigger className="w-32">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {MP3_BITRATES.map(br => (
                          <SelectItem key={br} value={String(br)}>
                            {br} kbps
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Btn
                      sm
                      onClick={() =>
                        saveSettings({
                          stream: { bitrate: parseInt(form.stream.bitrate, 10) },
                        })
                      }
                      disabled={busy}
                    >
                      Save bitrate
                    </Btn>
                  </div>
                  <div className="field-hint">
                    Higher bitrate = better quality, more listener bandwidth
                    (current: {data?.values?.stream?.bitrate ?? '—'} kbps). 192 kbps is the
                    original default.
                  </div>
                </div>
              </Card>
            )}

            <Card title="Mixer" sub="apply pending Liquidsoap-level settings">
              <div className="grid gap-2">
                <Btn sm tone="danger" onClick={() => setConfirmRestart(true)} disabled={busy || !data}>
                  Restart mixer
                </Btn>
                <div className="field-hint">
                  Drops the broadcast for ~3–5s. Use after crossfade or jingle frequency changes.
                  {pendingRestart && (
                    <strong className="mt-1 block text-vermilion">
                      Pending settings need a restart to apply.
                    </strong>
                  )}
                </div>
              </div>
            </Card>
          </>
        )}
      </div>

      <V3AlertDialog
        open={confirmRestart}
        onOpenChange={setConfirmRestart}
        title="Restart mixer"
        description="Restart the mixer to apply pending settings? The broadcast will drop for roughly 3–5 seconds."
        confirmLabel="restart mixer"
        danger
        onConfirm={restartMixer}
      />
      <V3AlertDialog
        open={confirmStop}
        onOpenChange={setConfirmStop}
        title="Stop stream"
        description="Take the station off air? The Icecast mount disconnects. Every current listener is dropped and new listeners get nothing until you start the stream again."
        confirmLabel="stop stream"
        danger
        onConfirm={stopStream}
      />
      <V3AlertDialog
        open={confirmDelete != null}
        onOpenChange={(o) => { if (!o) setConfirmDelete(null); }}
        title="Delete jingle"
        description={confirmDelete ? `Delete the jingle "${confirmDelete}"? This removes the rendered audio file permanently.` : ''}
        confirmLabel="delete"
        danger
        onConfirm={() => { if (confirmDelete) deleteJingle(confirmDelete); setConfirmDelete(null); }}
      />
      <V3AlertDialog
        open={confirmDeleteSfx != null}
        onOpenChange={(o) => { if (!o) setConfirmDeleteSfx(null); }}
        title="Delete sound effect"
        description={confirmDeleteSfx ? `Delete the sound effect "${confirmDeleteSfx}"? This removes the rendered audio file permanently.` : ''}
        confirmLabel="delete"
        danger
        onConfirm={() => { if (confirmDeleteSfx) deleteSfx(confirmDeleteSfx); setConfirmDeleteSfx(null); }}
      />
    </div>
  );
}

/* ── Shared bits ─────────────────────────────────────────────────────── */

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

function SectionHeader({ eyebrow, title, sub, metrics, manualHref, manualLabel }: SectionHeaderProps) {
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
function SaveBar({ note, busy, onSave, saveLabel, extra }: SaveBarProps) {
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

function KeyStatus({ envVar, present }: KeyStatusProps) {
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

function KeyTestResult({ result }: KeyTestResultProps) {
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

/* ── TTS ─────────────────────────────────────────────────────────────── */

type FormUpdater = (updater: (f: FormState) => FormState) => void;

interface SectionProps {
  data: SettingsData;
  form: FormState;
  setForm: FormUpdater;
  busy: boolean;
  saveSettings: SaveSettings;
}

// Sentinel for the empty-string "use the built-in voice" choice — Radix Select
// rejects an empty-string SelectItem value.
const CB_DEFAULT_VOICE = '__cb_default__';

// Voice-level (dB) trim. Engine ids match the server contract exactly — note the
// hyphen in `pocket-tts`. Range mirrors the server clamp (TTS_GAIN_CLAMP_DB=12).
const TTS_GAIN_ENGINES = ['piper', 'kokoro', 'chatterbox', 'pocket-tts', 'cloud', 'remote'] as const;
const TTS_GAIN_MIN = -12;
const TTS_GAIN_MAX = 12;
const TTS_GAIN_STEP = 0.5;

// Pretty-print a gain: "0 dB" clean-neutral, otherwise a signed one-decimal value
// with a real minus sign (e.g. "+3.0 dB", "−2.5 dB").
function formatGainDb(v: number): string {
  if (!v) return '0 dB';
  const sign = v > 0 ? '+' : '−';
  return `${sign}${Math.abs(v).toFixed(1)} dB`;
}


// Compact per-engine voice-level control: a labelled range slider + live readout,
// writing into form.tts.gainDb[engineId]. Dropped into each engine's config panel.
function TtsGainField({
  engineId,
  form,
  setForm,
}: {
  engineId: string;
  form: FormState;
  setForm: FormUpdater;
}) {
  const value = form.tts.gainDb?.[engineId] ?? 0;
  return (
    <div className="field mt-4">
      <div className="flex items-center justify-between gap-3">
        <Label>Voice level (dB)</Label>
        <span className="font-mono text-[12px] text-ink tabular-nums">{formatGainDb(value)}</span>
      </div>
      <input
        type="range"
        min={TTS_GAIN_MIN}
        max={TTS_GAIN_MAX}
        step={TTS_GAIN_STEP}
        value={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          const next = Number(e.target.value);
          setForm(f => ({
            ...f,
            tts: { ...f.tts, gainDb: { ...f.tts.gainDb, [engineId]: next } },
          }));
        }}
        aria-label="Voice level in decibels"
        className="mt-1.5 w-full max-w-[360px] accent-[var(--accent)]"
      />
      <div className="field-hint">
        Trim this engine’s loudness to match your other voices. <code>0 dB</code> = no change.
      </div>
    </div>
  );
}

// Speech-rate trim. Range mirrors the server clamp (clampTtsSpeed: 0.5–2.0×).
// Only Piper/Kokoro/cloud honour speed — chatterbox/pocket-tts/remote ignore it.
const TTS_SPEED_MIN = 0.5;
const TTS_SPEED_MAX = 2;
const TTS_SPEED_STEP = 0.05;
const TTS_SPEED_UNSUPPORTED = new Set(['chatterbox', 'pocket-tts', 'remote']);

function formatSpeed(v: number): string {
  return `${v.toFixed(2)}×`;
}

// Compact per-engine speech-speed control: a labelled range slider + live readout,
// writing into form.tts.speed[engineId]. Disabled (with a hint) for the engines
// whose workers ignore speed, so operators see why it has no effect there.
function TtsSpeedField({
  engineId,
  form,
  setForm,
}: {
  engineId: string;
  form: FormState;
  setForm: FormUpdater;
}) {
  const value = form.tts.speed?.[engineId] ?? 1;
  const supported = !TTS_SPEED_UNSUPPORTED.has(engineId);
  return (
    <div className="field mt-4">
      <div className="flex items-center justify-between gap-3">
        <Label>Speech speed</Label>
        <span className="font-mono text-[12px] text-ink tabular-nums">{formatSpeed(value)}</span>
      </div>
      <input
        type="range"
        min={TTS_SPEED_MIN}
        max={TTS_SPEED_MAX}
        step={TTS_SPEED_STEP}
        value={value}
        disabled={!supported}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          const next = Number(e.target.value);
          setForm(f => ({
            ...f,
            tts: { ...f.tts, speed: { ...f.tts.speed, [engineId]: next } },
          }));
        }}
        aria-label="Speech speed multiplier"
        className={cn('mt-1.5 w-full max-w-[360px] accent-[var(--accent)]', !supported && 'opacity-40')}
      />
      <div className="field-hint">
        {supported
          ? <>Slow down or speed up this engine. <code>1.00×</code> = no change.</>
          : <>Not supported by this engine — only Piper, Kokoro and cloud honour speed.</>}
      </div>
    </div>
  );
}

// Prominent, self-contained "engine not installed" callout with a step-by-step
// setup guide. Chatterbox and PocketTTS both live in the optional `tts-heavy`
// sidecar, so the recommended path is identical; only the engine label and the
// legacy build-arg differ.
function HeavyEngineSetupGuide({ engine, buildArg }: { engine: 'Chatterbox' | 'PocketTTS'; buildArg: string }) {
  return (
    <div
      role="alert"
      className="border border-l-[3px] border-[var(--danger)] bg-[color-mix(in_oklab,var(--danger)_7%,transparent)] p-3.5"
    >
      <div className="flex items-center gap-2">
        <span className="text-[13px] leading-none text-[var(--danger)]">⚠</span>
        <span className="text-[11px] font-bold tracking-[0.14em] text-[var(--danger)] uppercase">
          {engine} isn’t installed in this build
        </span>
      </div>

      <p className="mt-2 text-[11px] leading-[1.55] text-muted">
        {engine} is a heavy PyTorch engine, so the controller image doesn’t carry it.
        It ships in the optional <code>tts-heavy</code> sidecar. Until that’s running,
        every segment routed here <strong>falls back to Piper</strong>. The DJ never
        goes silent, it just won’t use this voice.
      </p>

      <div className="mt-3 text-[10px] font-bold tracking-[0.16em] text-ink uppercase">
        Turn it on
      </div>
      <ol className="mt-1.5 grid list-decimal gap-2 pl-[18px] text-[11px] leading-[1.55] text-muted marker:font-bold marker:text-[var(--danger)]">
        <li>
          Bring the sidecar up alongside the stack:
          <code className="mt-1 block w-fit max-w-full overflow-x-auto bg-[var(--ink-soft)] px-2 py-1">
            docker compose --profile tts-heavy up -d
          </code>
        </li>
        <li>
          To start it automatically every time, add this to your root <code>.env</code>
          instead:
          <code className="mt-1 block w-fit max-w-full overflow-x-auto bg-[var(--ink-soft)] px-2 py-1">
            COMPOSE_PROFILES=tts-heavy
          </code>
        </li>
        <li>
          Give it ~30 s to pull the model and pass its health check, then reload this
          page. The warning clears once the controller can reach the sidecar.
        </li>
      </ol>

      <p className="mt-2.5 text-[10px] leading-[1.5] text-muted">
        Legacy single-image path: rebuild the controller with{' '}
        <code>--build-arg {buildArg}</code> (only if you built a custom image on the
        pre-sidecar pattern).
      </p>
    </div>
  );
}

interface TtsSectionProps extends SectionProps {
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  refresh: () => void;
}

function TtsSection({ data, form, setForm, busy, saveSettings, adminFetch, refresh }: TtsSectionProps) {
  const [cloudKeyInput, setCloudKeyInput] = useState('');
  const [cloudKeyTest, setCloudKeyTest] = useState<{ ok: boolean; message: string; latencyMs: number } | null>(null);
  const [cloudKeyTesting, setCloudKeyTesting] = useState(false);

  useEffect(() => { setCloudKeyInput(''); }, [form.tts.cloud.provider]);
  useEffect(() => { setCloudKeyTest(null); }, [form.tts.cloud.provider]);

  const isCloudEngine = form.tts.defaultEngine === 'cloud';
  const isCompat = form.tts.cloud.provider === 'openai-compatible';
  const ttsKeyVar = form.tts.cloud.provider === 'elevenlabs' ? 'ELEVENLABS_API_KEY' : 'OPENAI_API_KEY';
  const ttsKeySet = !!data.env?.[ttsKeyVar];

  const ttsDiscoveryEnabled = isCloudEngine && (
    (isCompat && !!form.tts.cloud.baseUrl.trim())
    || (!isCompat && ttsKeySet)
  );

  const ttsDiscovery = useModelDiscovery({
    provider: isCompat ? 'openai-compatible' : form.tts.cloud.provider,
    baseUrl: form.tts.cloud.baseUrl,
    enabled: ttsDiscoveryEnabled,
    adminFetch,
  });

  const saveKey = async (envVar: string, value: string): Promise<boolean> => {
    if (!value.trim()) return true;
    try {
      const r = await adminFetch('/settings/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [envVar]: value.trim() }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({})) as { error?: string };
        notify.err(j.error || `Key save failed (${r.status})`);
        return false;
      }
      return true;
    } catch (e) {
      notify.err(errorMessage(e));
      return false;
    }
  };
  const testCloudKey = async () => {
    const cloudKeyVar = form.tts.cloud.provider === 'elevenlabs' ? 'ELEVENLABS_API_KEY' : 'OPENAI_API_KEY';
    const hasTyped = !!cloudKeyInput.trim();
    if (!hasTyped && !data.env?.[cloudKeyVar]) return;
    setCloudKeyTesting(true);
    setCloudKeyTest(null);
    try {
      const r = await adminFetch('/settings/secrets/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: cloudKeyVar, value: cloudKeyInput.trim() }),
      });
      const j = await r.json() as { ok: boolean; message: string; latencyMs: number };
      setCloudKeyTest(j);
      if (j.ok && hasTyped) {
        const saved = await saveKey(cloudKeyVar, cloudKeyInput);
        if (saved) { notify.ok('Key verified and saved'); setCloudKeyInput(''); refresh(); }
      } else if (j.ok) {
        notify.ok('Key verified (on file)');
      }
    } catch (e) {
      setCloudKeyTest({ ok: false, message: errorMessage(e), latencyMs: 0 });
    } finally {
      setCloudKeyTesting(false);
    }
  };
  const engines = data.tts?.engines || ['piper'];
  const available = data.tts?.available || {};
  const ENGINE_LABELS: Record<string, string> = { piper: 'Piper', kokoro: 'Kokoro', chatterbox: 'Chatterbox', 'pocket-tts': 'PocketTTS', cloud: 'Cloud', remote: 'Remote' };

  const save = async () => {
    await saveSettings({
      tts: {
        defaultEngine: form.tts.defaultEngine,
        kokoro: { voice: form.tts.kokoro?.voice },
        chatterbox: { referenceVoice: form.tts.chatterbox?.referenceVoice ?? '' },
        pocketTts: { voice: form.tts.pocketTts?.voice ?? 'alba' },
        cloud: {
          enabled: true,
          provider: form.tts.cloud.provider,
          model: form.tts.cloud.model,
          voice: form.tts.cloud.voice,
          baseUrl: form.tts.cloud.baseUrl,
        },
        remote: { url: form.tts.remote.url },
        // Per-engine voice-level trim. Always sent (server clamps + drops unknown
        // keys); keyed by engine id, `pocket-tts` with the hyphen.
        gainDb: form.tts.gainDb,
        // Per-engine speech speed (×). Same contract as gainDb; inert for the
        // engines whose workers ignore speed (chatterbox/pocket-tts).
        speed: form.tts.speed,
      },
    });
    // Save cloud API key if typed -- goes to secrets.env, not settings.json
    const isCompat = form.tts.cloud.provider === 'openai-compatible';
    if (!isCompat && cloudKeyInput.trim()) {
      const cloudKeyVar = form.tts.cloud.provider === 'elevenlabs' ? 'ELEVENLABS_API_KEY' : 'OPENAI_API_KEY';
      const ok = await saveKey(cloudKeyVar, cloudKeyInput);
      if (ok) { notify.ok('API key saved'); setCloudKeyInput(''); refresh(); }
    }
  };

  const selectCloudProvider = (f: FormState, provider: string): FormState => {
    const provVoices = CLOUD_VOICES[provider as keyof typeof CLOUD_VOICES] || [];
    const voice = provVoices.some(pv => pv.id === f.tts.cloud.voice.trim())
      ? f.tts.cloud.voice
      : (provVoices[0]?.id || f.tts.cloud.voice);
    const provModels = CLOUD_MODELS[provider as keyof typeof CLOUD_MODELS] || [];
    const model = provModels.includes(f.tts.cloud.model.trim() as never)
      ? f.tts.cloud.model
      : (provModels[0] || f.tts.cloud.model);
    return { ...f, tts: { ...f.tts, cloud: { ...f.tts.cloud, enabled: true, provider, voice, model } } };
  };

  const selectEngine = (engine: string) => setForm(f => {
    const base = engine === 'cloud'
      ? selectCloudProvider(f, f.tts.cloud.provider || 'openai')
      : f;
    return { ...base, tts: { ...base.tts, defaultEngine: engine } };
  });

  type SavedCloud = { provider?: string; voice?: string; model?: string; baseUrl?: string };
  const savedTts: {
    defaultEngine?: string;
    kokoro?: { voice?: string };
    chatterbox?: { referenceVoice?: string };
    pocketTts?: { voice?: string };
    cloud?: SavedCloud;
    remote?: { url?: string };
    gainDb?: Record<string, number>;
    speed?: Record<string, number>;
  } = data.values?.tts || {};
  const savedEngine: string = savedTts.defaultEngine || 'piper';
  const savedKokoroVoice: string = savedTts.kokoro?.voice || '';
  const savedChatterboxVoice: string = savedTts.chatterbox?.referenceVoice || '';
  const savedPocketTtsVoice: string = savedTts.pocketTts?.voice || '';
  const savedCloud: SavedCloud = savedTts.cloud || {};
  const savedRemoteUrl: string = savedTts.remote?.url || '';
  const savedEngineLabel = ENGINE_LABELS[savedEngine] || savedEngine;
  const formEngineLabel = ENGINE_LABELS[form.tts.defaultEngine] || form.tts.defaultEngine;

  const savedGainDb: Record<string, number> = savedTts.gainDb || {};
  // Any engine whose form gain differs from its saved value (absent → 0 unity).
  const gainDirty = TTS_GAIN_ENGINES.some(
    e => (form.tts.gainDb?.[e] ?? 0) !== (savedGainDb[e] ?? 0),
  );

  const savedSpeed: Record<string, number> = savedTts.speed || {};
  // Any engine whose form speed differs from its saved value (absent → 1.0 unity).
  const speedDirty = TTS_GAIN_ENGINES.some(
    e => (form.tts.speed?.[e] ?? 1) !== (savedSpeed[e] ?? 1),
  );

  const ttsDirty =
    form.tts.defaultEngine !== savedEngine
    || (form.tts.kokoro?.voice || '') !== savedKokoroVoice
    || (form.tts.chatterbox?.referenceVoice || '') !== savedChatterboxVoice
    || (form.tts.pocketTts?.voice || '') !== savedPocketTtsVoice
    || form.tts.cloud.provider !== (savedCloud.provider || '')
    || (form.tts.cloud.model || '').trim() !== (savedCloud.model || '').trim()
    || (form.tts.cloud.voice || '').trim() !== (savedCloud.voice || '').trim()
    || (form.tts.cloud.baseUrl || '').trim() !== (savedCloud.baseUrl || '').trim()
    || (form.tts.remote.url || '').trim() !== savedRemoteUrl
    || gainDirty
    || speedDirty;

  let activeDetail: ReactNode = null;
  if (savedEngine === 'piper') {
    activeDetail = <>Bundled, no key, no config. Always the safe fallback.</>;
  } else if (savedEngine === 'kokoro') {
    activeDetail = <>Voice <code>{savedKokoroVoice || '—'}</code>. Falls back to Piper if the model isn’t loaded.</>;
  } else if (savedEngine === 'chatterbox') {
    activeDetail = <>
      Reference <code>{savedChatterboxVoice || 'built-in'}</code>, with voice cloning + paralinguistic tags. Falls back to Piper if the worker isn’t installed.
    </>;
  } else if (savedEngine === 'pocket-tts') {
    activeDetail = <>
      Voice <code>{savedPocketTtsVoice || 'alba'}</code>. CPU-only, ~6× real-time, multilingual built-in voices. Falls back to Piper if the worker isn’t installed.
    </>;
  } else if (savedEngine === 'cloud') {
    activeDetail = <>
      {savedCloud.provider || '—'} · model <code>{savedCloud.model || '—'}</code>
      {savedCloud.voice ? <> · voice <code>{savedCloud.voice}</code></> : null}.
    </>;
  } else if (savedEngine === 'remote') {
    activeDetail = <>
      Endpoint <code>{savedRemoteUrl || 'not configured'}</code>. Falls back to Piper if the URL isn’t set or the sidecar is down.
    </>;
  }
  const savedEngineMissing = available[savedEngine] === false;

  return (
    <>
      <SectionHeader
        eyebrow="tts voice"
        title="Pick a voice engine, then configure it."
        sub={<>
          Every spoken segment is voiced by the <strong>persona on air</strong>. Set each
          persona’s engine and voice on the Personas page. Here you pick the station’s
          default engine (used for jingles and as the fallback) and configure whichever
          one you choose.
          {available.kokoro === false && (
            <span className="text-[var(--danger)]"> Kokoro is unavailable in this build.</span>
          )}
        </>}
        metrics={[
          { n: String(engines.length), l: 'engines', accent: true },
        ]}
      />

      <Card title="Voice engine" sub="active default">
        <div className="grid gap-[18px]">
          <div className="flex items-start gap-2.5 border border-[var(--accent)] bg-[var(--ink-softer)] p-3">
            <span className="mt-1 size-1.5 flex-none rounded-full bg-vermilion" />
            <div className="grid min-w-0 gap-0.5">
              <span className="text-[11px] font-bold tracking-[0.12em] text-vermilion uppercase">
                Default engine now · {savedEngineLabel}
              </span>
              <span className="text-[11px] leading-[1.5] text-muted">
                {activeDetail} {ttsDirty ? 'Your edits below aren’t live until you Save.' : 'This is the saved, running config.'}
                {savedEngineMissing && (
                  <span className="text-[var(--danger)]"> This engine isn’t installed in this build, so segments fall back to Piper. See the setup steps below.</span>
                )}
              </span>
            </div>
          </div>

          <div className="field">
            <div className="flex items-center gap-2">
              <Label>Engine</Label>
              {ttsDirty && <Pill tone="accent" dot>unsaved</Pill>}
            </div>
            <EngineSelector
              value={form.tts.defaultEngine}
              engineIds={engines}
              available={available}
              onChange={selectEngine}
            />
            <div className="field-hint">
              {ttsDirty
                ? <>Engine changed. Hit "Save TTS settings" below to make <strong>{formEngineLabel}</strong> the new default.</>
                : <>The station default. Renders jingles and is the fallback when a persona’s own engine fails. Per-segment voice still comes from the persona on air.</>}
            </div>
          </div>

        {form.tts.defaultEngine === 'piper' && (
          <>
            <div className="field mt-4">
              <div className="field-hint">
                Piper is bundled with the controller: fast, lightweight, and always
                available. Nothing else to configure.
              </div>
            </div>
            <TtsGainField engineId="piper" form={form} setForm={setForm} />
            <TtsSpeedField engineId="piper" form={form} setForm={setForm} />
          </>
        )}

        {form.tts.defaultEngine === 'kokoro' && (
          <>
            <div className="field mt-4">
              <Label>Kokoro voice</Label>
              {available.kokoro === false && (
                <div className="field-hint text-[var(--danger)]">
                  Kokoro is not installed in this build, so it will fall back to Piper.
                </div>
              )}
              {(data.tts?.kokoroVoices?.length || 0) > 0 ? (
                <>
                  <Select
                    value={form.tts.kokoro?.voice ?? 'bf_isabella'}
                    onValueChange={val => setForm(f => ({
                      ...f, tts: { ...f.tts, kokoro: { ...f.tts.kokoro, voice: val } },
                    }))}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {data.tts?.kokoroVoices?.map(v => (
                          <SelectItem key={v.id} value={v.id}>{v.label} — {v.id}</SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <div className="field-hint">British English only. Applies to every kind routed through Kokoro.</div>
                </>
              ) : (
                <div className="field-hint">This build reports no Kokoro voices.</div>
              )}
            </div>
            <TtsGainField engineId="kokoro" form={form} setForm={setForm} />
            <TtsSpeedField engineId="kokoro" form={form} setForm={setForm} />
          </>
        )}

        {form.tts.defaultEngine === 'chatterbox' && (
          <>
            <div className="field mt-4">
              <Label>Chatterbox reference voice</Label>
              {available.chatterbox === false ? (
                <HeavyEngineSetupGuide engine="Chatterbox" buildArg="WITH_CHATTERBOX=1" />
              ) : (data.tts?.chatterboxVoices?.length || 0) > 0 ? (
                <>
                  <Select
                    value={form.tts.chatterbox?.referenceVoice || CB_DEFAULT_VOICE}
                    onValueChange={val => setForm(f => ({
                      ...f,
                      tts: { ...f.tts, chatterbox: { ...f.tts.chatterbox, referenceVoice: val === CB_DEFAULT_VOICE ? '' : val } },
                    }))}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value={CB_DEFAULT_VOICE}>Built-in default voice</SelectItem>
                        {data.tts?.chatterboxVoices?.map(v => (
                          <SelectItem key={v} value={v}>{v}</SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <div className="field-hint">
                    ~5 seconds of clean speech is enough to clone a voice. Drop WAVs into{' '}
                    <code>state/voices/</code>
                    {' '}on the host (the legacy <code>state/chatterbox-voices/</code> is
                    still read) and they’ll appear here on next reload. Personas can
                    override this on the Personas page.
                  </div>
                </>
              ) : (
                <div className="field-hint">
                  No reference voices found in{' '}
                  <code>state/voices/</code>{' '}
                  (legacy <code>state/chatterbox-voices/</code> also empty). The engine will
                  use its built-in default voice. Drop a 5-second WAV into that directory
                  to enable cloning.
                </div>
              )}
            </div>
            <TtsGainField engineId="chatterbox" form={form} setForm={setForm} />
            <TtsSpeedField engineId="chatterbox" form={form} setForm={setForm} />
          </>
        )}

        {form.tts.defaultEngine === 'pocket-tts' && (
          <>
            <div className="field mt-4">
              <Label>PocketTTS voice</Label>
              {available['pocket-tts'] === false ? (
                <HeavyEngineSetupGuide engine="PocketTTS" buildArg="WITH_POCKETTTS=1" />
              ) : (data.tts?.pocketTtsVoices?.length || 0) > 0 ? (
                <>
                  <Select
                    value={form.tts.pocketTts?.voice ?? 'alba'}
                    onValueChange={val => setForm(f => ({
                      ...f, tts: { ...f.tts, pocketTts: { ...f.tts.pocketTts, voice: val } },
                    }))}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectLabel>Built-in</SelectLabel>
                        {data.tts?.pocketTtsVoices?.map(v => (
                          <SelectItem key={v.id} value={v.id}>{v.label} — {v.id}</SelectItem>
                        ))}
                      </SelectGroup>
                      {(data.tts?.pocketTtsCustomVoices?.length || 0) > 0 && (
                        <SelectGroup>
                          <SelectLabel>Custom (cloned)</SelectLabel>
                          {data.tts?.pocketTtsCustomVoices?.map(v => (
                            <SelectItem key={v} value={v}>{v}</SelectItem>
                          ))}
                        </SelectGroup>
                      )}
                    </SelectContent>
                  </Select>
                  <div className="field-hint">
                    100M-param CPU-only model from kyutai-labs. Built-in voices speak
                    English, French, German, Italian, Spanish and Portuguese. Drop a
                    ~5-second WAV into <code>state/voices/</code> to clone a voice and it
                    will appear under <em>Custom</em> on next reload. Personas can override
                    this on the Personas page.
                  </div>
                </>
              ) : (
                <div className="field-hint">This build reports no PocketTTS voices.</div>
              )}
            </div>
            <TtsGainField engineId="pocket-tts" form={form} setForm={setForm} />
            <TtsSpeedField engineId="pocket-tts" form={form} setForm={setForm} />
          </>
        )}

        {form.tts.defaultEngine === 'cloud' && (() => {
          return (
          <div className="mt-4">
            <div className="field">
              <Label>Provider</Label>
              <Seg
                accent
                value={form.tts.cloud.provider}
                options={(data.tts?.cloudProviders || ['openai', 'elevenlabs', 'openai-compatible']).map(p => ({ id: p, label: p }))}
                onChange={v => setForm(f => selectCloudProvider(f, v))}
              />
            </div>
            {isCompat && (
              <div className="field mt-3.5">
                <Label>Server base URL</Label>
                <Input
                  value={form.tts.cloud.baseUrl}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    setForm(f => ({ ...f, tts: { ...f.tts, cloud: { ...f.tts.cloud, baseUrl: e.target.value } } }))
                  }
                  placeholder="http://192.168.1.101:5000/v1"
                  className="max-w-[360px]"
                />
                <div className="field-hint">
                  Any OpenAI-compatible TTS server (Chatterbox, Qwen3 TTS,
                  VibeVoice, …) that exposes <code>/v1/audio/speech</code>,
                  including the <code>/v1</code> suffix. Must be reachable from the
                  controller container. Use the host’s LAN or Tailscale IP, not
                  <code>127.0.0.1</code>.
                </div>
              </div>
            )}
            <div className="mt-3.5 grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-[18px]">
              <div className="field">
                <Label>Model</Label>
                <div className="flex items-stretch gap-2">
                  {ttsDiscovery.models.length > 0 ? (
                    <ModelCombobox
                      models={ttsDiscovery.models}
                      value={form.tts.cloud.model}
                      onChange={v => setForm(f => ({ ...f, tts: { ...f.tts, cloud: { ...f.tts.cloud, model: v } } }))}
                      placeholder="Select a model"
                    />
                  ) : (
                    <Input
                      value={form.tts.cloud.model}
                      onChange={(e: ChangeEvent<HTMLInputElement>) =>
                        setForm(f => ({ ...f, tts: { ...f.tts, cloud: { ...f.tts.cloud, model: e.target.value } } }))
                      }
                      placeholder={
                        isCompat
                          ? 'chatterbox'
                          : (CLOUD_MODELS[form.tts.cloud.provider as keyof typeof CLOUD_MODELS]?.[0] || 'gpt-4o-mini-tts')
                      }
                      className="max-w-[360px]"
                    />
                  )}
                  {ttsDiscovery.loading
                    ? <span className="animate-pulse text-[11px] whitespace-nowrap text-muted">discovering…</span>
                    : ttsDiscoveryEnabled && (
                      <Btn onClick={ttsDiscovery.refresh} title="Refresh model list">↻</Btn>
                    )
                  }
                </div>
                <div className="field-hint">
                  {ttsDiscovery.models.length > 0
                    ? `${ttsDiscovery.models.length} model${ttsDiscovery.models.length !== 1 ? 's' : ''} discovered. Pick one from the list.`
                    : !ttsDiscoveryEnabled
                      ? (isCompat
                          ? 'Set a base URL above to discover available models.'
                          : 'Set an API key above to discover and select a model.')
                      : ttsDiscovery.error
                        ? `Discovery failed: ${ttsDiscovery.error}. Type a model ID manually.`
                        : ttsDiscovery.loading
                          ? 'Discovering models…'
                          : (isCompat
                              ? 'Model id exactly as the server reports it at /v1/models, required.'
                              : 'e.g. "gpt-4o-mini-tts" (OpenAI) or "eleven_flash_v2_5" (ElevenLabs).')}
                </div>
              </div>
              {(() => {
                const provVoices = CLOUD_VOICES[form.tts.cloud.provider as keyof typeof CLOUD_VOICES] || [];
                const voice = form.tts.cloud.voice.trim();
                const isPreset = provVoices.some(v => v.id === voice);
                if (isCompat) {
                  return (
                    <div className="field">
                      <Label>Default voice</Label>
                      <Input
                        value={form.tts.cloud.voice}
                        maxLength={100}
                        placeholder="Server-specific (cloning ref or speaker id)"
                        onChange={(e: ChangeEvent<HTMLInputElement>) =>
                          setForm(f => ({ ...f, tts: { ...f.tts, cloud: { ...f.tts.cloud, voice: e.target.value } } }))
                        }
                      />
                      <div className="field-hint">
                        Server-specific: Chatterbox cloning ref name, Qwen3
                        speaker id, etc. Leave blank to let the server pick its
                        own default.
                      </div>
                    </div>
                  );
                }
                return (
                  <div className="field">
                    <Label>Default voice</Label>
                    <Select
                      value={isPreset ? voice : '__custom__'}
                      onValueChange={val => {
                        // "Custom voice id…" clears the preset so isPreset flips
                        // false and the free-text input below appears for entry.
                        setForm(f => ({ ...f, tts: { ...f.tts, cloud: { ...f.tts.cloud, voice: val === '__custom__' ? '' : val } } }));
                      }}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {provVoices.map(v => (
                            <SelectItem key={v.id} value={v.id}>{v.label}</SelectItem>
                          ))}
                          <SelectItem value="__custom__">Custom voice id…</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    {!isPreset && (
                      <Input
                        className={cn('mt-2', voice ? 'border-ink' : 'border-[var(--danger)]')}
                        value={form.tts.cloud.voice}
                        maxLength={100}
                        placeholder="Enter a custom voice id"
                        onChange={(e: ChangeEvent<HTMLInputElement>) =>
                          setForm(f => ({ ...f, tts: { ...f.tts, cloud: { ...f.tts.cloud, voice: e.target.value } } }))
                        }
                      />
                    )}
                    <div className="field-hint">
                      Used when a Cloud persona hasn’t set its own voice. Pick a default, or choose
                      <em> Custom voice id…</em> for any other OpenAI voice name / ElevenLabs voice id.
                    </div>
                  </div>
                );
              })()}
            </div>
            {!isCompat && (() => {
              const cloudKeyVar = form.tts.cloud.provider === 'elevenlabs' ? 'ELEVENLABS_API_KEY' : 'OPENAI_API_KEY';
              return (
                <>
                  <div className="field">
                    <Label>{form.tts.cloud.provider === 'elevenlabs' ? 'ElevenLabs' : 'OpenAI'} API key</Label>
                    <div className="flex items-stretch gap-2">
                      <Input
                        type="password"
                        value={cloudKeyInput}
                        placeholder={data.env?.[cloudKeyVar] ? '•••••• (on file)' : (KEY_HINTS[cloudKeyVar] ?? '')}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => setCloudKeyInput(e.target.value)}
                        className="max-w-[360px]"
                      />
                      <Btn
                        onClick={testCloudKey}
                        disabled={cloudKeyTesting || (!cloudKeyInput.trim() && !data.env?.[cloudKeyVar])}
                      >
                        {cloudKeyTesting ? 'Testing…' : 'Test key'}
                      </Btn>
                    </div>
                    <div className="field-hint">
                      Stored in <code>state/secrets.env</code>, takes effect immediately. Leave blank to keep the existing key.
                    </div>
                    {cloudKeyVar === 'OPENAI_API_KEY' && (
                      <div className="field-hint">
                        This key is shared across LLM and Cloud TTS.
                      </div>
                    )}
                  </div>
                  {cloudKeyTest && <KeyTestResult result={cloudKeyTest} />}
                </>
              );
            })()}
            {isCompat && (
              <div className="field-hint mt-3.5">
                Most self-hosted servers accept any non-empty API key, so no env
                var is required.
              </div>
            )}
            <TtsGainField engineId="cloud" form={form} setForm={setForm} />
            <TtsSpeedField engineId="cloud" form={form} setForm={setForm} />
            {!isCompat && (() => {
              const kv = form.tts.cloud.provider === 'elevenlabs' ? 'ELEVENLABS_API_KEY' : 'OPENAI_API_KEY';
              return <KeyStatus envVar={kv} present={!!data.env?.[kv]} />;
            })()}
          </div>
          );
        })()}

        {form.tts.defaultEngine === 'remote' && (() => {
          const remoteAvail = available.remote;
          return (
          <div className="mt-4">
            {remoteAvail === false && (
              <div className="mb-3.5 border border-[var(--danger)] px-3 py-2.5 text-[11px] leading-[1.6] text-[var(--danger)]">
                The remote endpoint isn&apos;t currently reachable. Check the URL
                below and make sure the sidecar is running. The engine falls
                back to <strong>Piper</strong> until it&apos;s up.
              </div>
            )}
            <div className="field">
              <Label>Server URL</Label>
              <Input
                value={form.tts.remote.url}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setForm(f => ({ ...f, tts: { ...f.tts, remote: { ...f.tts.remote, url: e.target.value } } }))
                }
                placeholder="http://192.168.1.101:5001"
                className="max-w-[360px]"
              />
              <div className="field-hint">
                Any self-hosted TTS server that renders audio over HTTP — POST{' '}
                <code>/speak</code> returns the audio in the response body, gated
                on a <code>/health</code> probe (Qwen3-TTS clone, F5-TTS,
                CosyVoice, your own server…). The audio comes back over the wire,
                so no shared volume is needed. Must be reachable from the
                controller container — use the host&apos;s LAN or Tailscale IP,
                not <code>127.0.0.1</code>.
              </div>
            </div>
            <TtsGainField engineId="remote" form={form} setForm={setForm} />
            <TtsSpeedField engineId="remote" form={form} setForm={setForm} />
          </div>
          );
        })()}

          {/* Audition the selected engine + its configured voice + speed. */}
          {(() => {
            const e = form.tts.defaultEngine;
            const previewVoice =
              e === 'kokoro' ? (form.tts.kokoro?.voice || '')
              : e === 'chatterbox' ? (form.tts.chatterbox?.referenceVoice || '')
              : e === 'pocket-tts' ? (form.tts.pocketTts?.voice || '')
              : e === 'cloud' ? (form.tts.cloud.voice || '')
              : e === 'remote' ? ''
              : '';
            return (
              <div className="field">
                <VoicePreviewButton
                  engine={e}
                  voice={previewVoice}
                  cloudProvider={form.tts.cloud.provider}
                  speed={form.tts.speed?.[e] ?? 1}
                  adminFetch={adminFetch}
                />
                <div className="field-hint">
                  Plays a short sample in the selected engine &amp; voice. Reflects voice
                  and speed; the dB trim is applied later, on air.
                </div>
              </div>
            );
          })()}
        </div>
      </Card>

      <SaveBar
        note={ttsDirty
          ? `Saving will switch the default engine to ${formEngineLabel}. Applies to jingle rendering and the engine fallback · no mixer restart.`
          : `Default engine: ${savedEngineLabel}. Applies to jingle rendering and the engine fallback · no mixer restart.`}
        busy={busy}
        onSave={save}
        saveLabel="Save TTS settings"
      />
    </>
  );
}

/* ── LLM ─────────────────────────────────────────────────────────────── */

interface LlmSectionProps extends SectionProps {
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  refresh: () => void;
}
function LlmSection({ data, form, setForm, busy, saveSettings, adminFetch, refresh }: LlmSectionProps) {
  const [primaryKeyInput, setPrimaryKeyInput] = useState('');
  const [fallbackKeyInput, setFallbackKeyInput] = useState('');
  const [primaryKeyTest, setPrimaryKeyTest] = useState<{ ok: boolean; message: string; latencyMs: number } | null>(null);
  const [primaryKeyTesting, setPrimaryKeyTesting] = useState(false);
  const [fallbackKeyTest, setFallbackKeyTest] = useState<{ ok: boolean; message: string; latencyMs: number } | null>(null);
  const [fallbackKeyTesting, setFallbackKeyTesting] = useState(false);

  useEffect(() => { setPrimaryKeyInput(''); }, [form.llm.provider]);
  useEffect(() => { setFallbackKeyInput(''); }, [form.llm.fallback.provider]);
  useEffect(() => { setPrimaryKeyTest(null); }, [form.llm.provider]);
  useEffect(() => { setFallbackKeyTest(null); }, [form.llm.fallback.provider]);

  const [compatKeyInput, setCompatKeyInput] = useState('');
  const [compatFallbackKeyInput, setCompatFallbackKeyInput] = useState('');
  const [compatKeyTest, setCompatKeyTest] = useState<{ ok: boolean; message: string; latencyMs: number } | null>(null);
  const [compatFallbackKeyTest, setCompatFallbackKeyTest] = useState<{ ok: boolean; message: string; latencyMs: number } | null>(null);
  const [compatKeyTesting, setCompatKeyTesting] = useState(false);
  const [compatFallbackKeyTesting, setCompatFallbackKeyTesting] = useState(false);
  useEffect(() => { setCompatKeyInput(''); setCompatKeyTest(null); }, [form.llm.provider]);
  useEffect(() => { setCompatFallbackKeyInput(''); setCompatFallbackKeyTest(null); }, [form.llm.fallback.provider]);

  // Embeddings inherit settings.llm by default (embedding.provider === ''), so
  // switching the CHAT provider silently changes the EMBEDDING model too — which
  // invalidates an already-embedded library and breaks vector search until a
  // re-embed (#dimension-mismatch). When the library is embedded and embeddings
  // are inheriting, pin them to the index's actual model on a provider switch and
  // surface a notice so the operator understands what happened (and can opt to
  // re-embed on the new provider instead).
  const [embedPinNotice, setEmbedPinNotice] = useState<{ model: string; dim: number; newProvider: string } | null>(null);
  const changeLlmProvider = (v: string) => {
    if (v === form.llm.provider) return;
    const inheriting = (form.embedding.provider ?? '') === '';
    const meta = data.libraryStats?.embeddingMeta;
    const pin = inheriting && !!meta?.model;
    setForm(f => {
      if (!f) return f;
      const next = { ...f, llm: { ...f.llm, provider: v } };
      if (pin && meta) {
        // Stored as "provider:model" (e.g. "ollama:nomic-embed-text"); split on
        // the FIRST colon so ollama tags with their own colon (bge-m3:latest)
        // keep the tag intact in the model field.
        const i = meta.model.indexOf(':');
        const pinProvider = i > 0 ? meta.model.slice(0, i) : '';
        const pinModel = i > 0 ? meta.model.slice(i + 1) : meta.model;
        if (pinProvider) next.embedding = { ...f.embedding, provider: pinProvider, model: pinModel };
      }
      return next;
    });
    if (pin && meta) setEmbedPinNotice({ model: meta.model, dim: meta.dim, newProvider: v });
  };

  const primaryKeyVar = LLM_ENV_VARS[form.llm.provider];
  const primaryKeySet = !!(primaryKeyVar && data.env?.[primaryKeyVar]);

  const primaryDiscoveryEnabled =
    form.llm.provider === 'ollama'
    || form.llm.provider === 'locca'
    || (form.llm.provider === 'openai-compatible' && !!form.llm.baseUrl.trim())
    || (form.llm.provider === 'openrouter')
    || (!!primaryKeyVar && primaryKeySet);

  const primaryDiscovery = useModelDiscovery({
    provider: form.llm.provider,
    baseUrl: form.llm.baseUrl,
    ollamaUrl: form.llm.ollamaUrl,
    enabled: primaryDiscoveryEnabled,
    adminFetch,
  });

  const fallbackKeyVar = LLM_ENV_VARS[form.llm.fallback.provider];
  const fallbackKeySet = !!(fallbackKeyVar && data.env?.[fallbackKeyVar]);

  const fallbackDiscoveryEnabled =
    form.llm.fallback.enabled && (
      form.llm.fallback.provider === 'ollama'
      || form.llm.fallback.provider === 'locca'
      || (form.llm.fallback.provider === 'openai-compatible' && !!form.llm.fallback.baseUrl.trim())
      || (form.llm.fallback.provider === 'openrouter')
      || (!!fallbackKeyVar && fallbackKeySet)
    );

  const fallbackDiscovery = useModelDiscovery({
    provider: form.llm.fallback.provider,
    baseUrl: form.llm.fallback.baseUrl,
    ollamaUrl: form.llm.fallback.ollamaUrl,
    enabled: fallbackDiscoveryEnabled,
    adminFetch,
  });

  const saveKey = async (envVar: string, value: string): Promise<boolean> => {
    if (!value.trim()) return true;
    try {
      const r = await adminFetch('/settings/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [envVar]: value.trim() }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({})) as { error?: string };
        notify.err(j.error || `Key save failed (${r.status})`);
        return false;
      }
      return true;
    } catch (e) {
      notify.err(errorMessage(e));
      return false;
    }
  };

  const testKey = async (
    envVar: string,
    value: string,
    setTesting: (v: boolean) => void,
    setResult: (r: { ok: boolean; message: string; latencyMs: number } | null) => void,
    clearInput?: () => void,
  ) => {
    const hasTyped = !!value.trim();
    if (!hasTyped && !data.env?.[envVar]) return;
    setTesting(true);
    setResult(null);
    try {
      const r = await adminFetch('/settings/secrets/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: envVar, value: value.trim() }),
      });
      const j = await r.json() as { ok: boolean; message: string; latencyMs: number };
      setResult(j);
      if (j.ok && hasTyped) {
        const saved = await saveKey(envVar, value);
        if (saved) { notify.ok('Key verified and saved'); clearInput?.(); refresh(); }
      } else if (j.ok) {
        notify.ok('Key verified (on file)');
      }
    } catch (e) {
      setResult({ ok: false, message: errorMessage(e), latencyMs: 0 });
    } finally {
      setTesting(false);
    }
  };

  const testCompatKey = async (
    apiKey: string,
    baseUrl: string,
    model: string,
    setTesting: (v: boolean) => void,
    setResult: (r: { ok: boolean; message: string; latencyMs: number } | null) => void,
  ) => {
    if (!baseUrl.trim()) { setResult({ ok: false, message: 'Set a Base URL first', latencyMs: 0 }); return; }
    if (!model.trim()) { setResult({ ok: false, message: 'Set a Model first', latencyMs: 0 }); return; }
    setTesting(true);
    setResult(null);
    try {
      const r = await adminFetch('/settings/llm/probe-compat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKey.trim(), baseUrl: baseUrl.trim(), model: model.trim() }),
      });
      const j = await r.json() as { ok: boolean; message: string; latencyMs: number };
      setResult(j);
    } catch (e) {
      setResult({ ok: false, message: errorMessage(e), latencyMs: 0 });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    await saveSettings({
      llm: {
        provider: form.llm.provider,
        model: form.llm.model,
        ollamaUrl: form.llm.ollamaUrl,
        numCtx: form.llm.numCtx,
        baseUrl: form.llm.baseUrl,
        reasoning: form.llm.reasoning,
        toolChoice: form.llm.toolChoice,
        pickerAgent: form.llm.pickerAgent,
        noRepeatWindow: form.llm.noRepeatWindow,
        requestWebResolve: form.llm.requestWebResolve,
        agentTimeoutMs: form.llm.agentTimeoutMs,
        pauseWhenEmpty: form.llm.pauseWhenEmpty,
        dailyTokenCap: form.llm.dailyTokenCap,
        budgetSoftPct: form.llm.budgetSoftPct,
        exemptRequests: form.llm.exemptRequests,
        maxOutputTokens: form.llm.maxOutputTokens,
        ...(form.llm.provider === 'openai-compatible' && compatKeyInput.trim()
          ? { apiKey: compatKeyInput.trim() }
          : {}),
        fallback: {
          enabled: form.llm.fallback.enabled,
          provider: form.llm.fallback.provider,
          model: form.llm.fallback.model,
          ollamaUrl: form.llm.fallback.ollamaUrl,
          numCtx: form.llm.fallback.numCtx,
          baseUrl: form.llm.fallback.baseUrl,
          reasoning: form.llm.fallback.reasoning,
          ...(form.llm.fallback.provider === 'openai-compatible' && compatFallbackKeyInput.trim()
            ? { apiKey: compatFallbackKeyInput.trim() }
            : {}),
        },
      },
    });
    // Save API keys if typed — these go to secrets.env, not settings.json
    const primaryKeyVar = LLM_ENV_VARS[form.llm.provider];
    if (primaryKeyVar && primaryKeyInput.trim()) {
      const ok = await saveKey(primaryKeyVar, primaryKeyInput);
      if (ok) { notify.ok('API key saved'); setPrimaryKeyInput(''); refresh(); }
    }
    const fallbackKeyVar = LLM_ENV_VARS[form.llm.fallback.provider];
    if (fallbackKeyVar && fallbackKeyInput.trim()) {
      const ok = await saveKey(fallbackKeyVar, fallbackKeyInput);
      if (ok) { notify.ok('API key saved'); setFallbackKeyInput(''); refresh(); }
    }
    if (form.llm.provider === 'openai-compatible' && compatKeyInput.trim()) {
      setCompatKeyInput('');
    }
    if (form.llm.fallback.provider === 'openai-compatible' && compatFallbackKeyInput.trim()) {
      setCompatFallbackKeyInput('');
    }
  };

  const savedLlm = data.values?.llm || {};
  const activeLabel = data.llm?.active || '';
  const activeColon = activeLabel.indexOf(':');
  const activeProvider = activeColon > -1 ? activeLabel.slice(0, activeColon) : (savedLlm.provider || '');
  const activeModel = activeColon > -1 ? activeLabel.slice(activeColon + 1) : '';
  const llmDirty = form.llm.provider !== savedLlm.provider
    || (form.llm.model || '').trim() !== (savedLlm.model || '').trim();

  return (
    <>
      <SectionHeader
        eyebrow="llm provider"
        title="The model that writes scripts and picks tracks."
        sub="Ollama runs on the homelab box and needs no key; the cloud providers are opt-in. Switching here reroutes every LLM call, no redeploy."
        metrics={[{ n: String((data.llm?.providers || []).length), l: 'providers' }]}
        manualHref="/manual/llm"
      />

      <Card title="Provider" sub="active routing">
        <div className="grid gap-[18px]">
          <div className="flex items-start gap-2.5 border border-[var(--accent)] bg-[var(--ink-softer)] p-3">
            <span className="mt-1 size-1.5 flex-none rounded-full bg-vermilion" />
            <div className="grid min-w-0 gap-0.5">
              <span className="text-[11px] font-bold tracking-[0.12em] text-vermilion uppercase">
                Routing now · {llmProviderLabel(activeProvider)}
              </span>
              <span className="text-[11px] leading-[1.5] text-muted">
                {activeModel
                  ? <>Model <code>{activeModel}</code>, every LLM call goes here. {llmDirty ? 'Your edits below aren’t live until you Save.' : 'This is the saved, running config.'}</>
                  : <>No model is set for this provider yet.</>}
              </span>
            </div>
          </div>

          <div className="field">
            <div className="flex items-center gap-2">
              <Label>Provider</Label>
              {llmDirty && <Pill tone="accent" dot>unsaved</Pill>}
            </div>
            <ProviderSelector
              value={form.llm.provider}
              providerIds={data.llm?.providers || ['ollama']}
              env={data.env}
              onChange={changeLlmProvider}
            />
            <div className="field-hint">
              {llmDirty
                ? 'Provider changed. Hit "Save LLM provider" below to route every call here.'
                : 'The provider every LLM call routes through. Switching reroutes instantly on save, no redeploy.'}
            </div>
          </div>

          {form.llm.provider === 'ollama' && (
            <div className="field">
              <Label>Ollama server URL</Label>
              <Input
                value={form.llm.ollamaUrl}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setForm(f => ({ ...f, llm: { ...f.llm, ollamaUrl: e.target.value } }))
                }
                placeholder="http://localhost:11434"
                className="max-w-[360px]"
              />
              <div className="field-hint">
                Where the Ollama server runs. Leave blank for the default
                (<code>http://localhost:11434</code>).
              </div>
            </div>
          )}

          {form.llm.provider === 'ollama' && (
            <div className="field">
              <Label>Context window (num_ctx)</Label>
              <Input
                type="number"
                min={0}
                step={1024}
                value={form.llm.numCtx}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setForm(f => ({ ...f, llm: { ...f.llm, numCtx: Number(e.target.value) } }))
                }
                placeholder="16384"
                className="max-w-[200px]"
              />
              <div className="field-hint">
                Tokens of context for <strong>local</strong> Ollama models.
                Ollama&apos;s own default is 4096, which is too small for the DJ
                agent: the prompt gets truncated and the model fails to pick a
                track (the &ldquo;agent did not call the done tool&rdquo; error).
                16384 is a safe default for a 7&ndash;9B model on a 12GB GPU;
                raise it for reasoning models, lower it on tight VRAM. Set 0 to
                use Ollama&apos;s default. Ignored for <code>:cloud</code> models.
              </div>
            </div>
          )}

          {form.llm.provider === 'openai-compatible' && (
            <div className="field">
              <Label>Server base URL</Label>
              <Input
                value={form.llm.baseUrl}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setForm(f => ({ ...f, llm: { ...f.llm, baseUrl: e.target.value } }))
                }
                placeholder="http://192.168.1.101:8080/v1"
                className="max-w-[360px]"
              />
              <div className="field-hint">
                Any OpenAI-compatible server (llama.cpp, vLLM, LM Studio…),
                including the <code>/v1</code> suffix. Must be reachable from the
                controller container. Use the host’s LAN or Tailscale IP, not
                <code>127.0.0.1</code>.
              </div>
            </div>
          )}

          {form.llm.provider === 'openai-compatible' && (
            <>
              <div className="field">
                <Label>Bearer token</Label>
                <div className="flex items-stretch gap-2">
                  <Input
                    type="password"
                    value={compatKeyInput}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setCompatKeyInput(e.target.value)}
                    placeholder={(data.values?.llm as { keys?: Record<string, unknown> })?.keys?.['openai-compatible'] === 'set' ? '•••••• (on file)' : 'Bearer token (optional)'}
                    className="max-w-[360px]"
                  />
                  <Btn
                    onClick={() =>
                      testCompatKey(
                        compatKeyInput || '',
                        form.llm.baseUrl,
                        form.llm.model,
                        setCompatKeyTesting,
                        setCompatKeyTest,
                      )
                    }
                    disabled={compatKeyTesting || !form.llm.baseUrl.trim()}
                  >
                    {compatKeyTesting ? 'Testing…' : 'Test connection'}
                  </Btn>
                </div>
                <div className="field-hint">
                  Optional — only needed when the server requires bearer authentication.
                  Saved to <code>settings.json</code>, takes effect on next save.
                </div>
              </div>
              {compatKeyTest && <KeyTestResult result={compatKeyTest} />}
            </>
          )}

          {form.llm.provider === 'locca' && (
            <div className="field">
              <Label>locca server base URL</Label>
              <Input
                value={form.llm.baseUrl}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setForm(f => ({ ...f, llm: { ...f.llm, baseUrl: e.target.value } }))
                }
                placeholder="http://host.docker.internal:8080/v1"
                className="max-w-[360px]"
              />
              <div className="field-hint">
                Leave blank to use the locca server on the host
                (<code>http://host.docker.internal:8080/v1</code>). Override only
                for a non-default port or a remote host. Bring a model up with{' '}
                <code>locca serve &lt;model&gt; --yes</code>; the model id below is
                what locca reports at <code>/v1/models</code>.{' '}
                <a
                  href="https://github.com/perminder-klair/locca"
                  target="_blank"
                  rel="noreferrer"
                  className="font-bold text-vermilion underline decoration-[1.5px] underline-offset-2"
                >
                  locca on GitHub ↗
                </a>
              </div>
            </div>
          )}

          {LLM_ENV_VARS[form.llm.provider] && (() => {
            const keyVar = LLM_ENV_VARS[form.llm.provider]!;
            return (
              <>
                <div className="field">
                  <Label>{llmProviderLabel(form.llm.provider)} API key</Label>
                  <div className="flex items-stretch gap-2">
                    <Input
                      type="password"
                      value={primaryKeyInput}
                      placeholder={data.env?.[keyVar] ? '•••••• (on file)' : (KEY_HINTS[keyVar] ?? '')}
                      onChange={(e: ChangeEvent<HTMLInputElement>) => setPrimaryKeyInput(e.target.value)}
                      className="max-w-[360px]"
                    />
                    <Btn
                      onClick={() => testKey(keyVar, primaryKeyInput, setPrimaryKeyTesting, setPrimaryKeyTest, () => setPrimaryKeyInput(''))}
                      disabled={primaryKeyTesting || (!primaryKeyInput.trim() && !data.env?.[keyVar])}
                    >
                      {primaryKeyTesting ? 'Testing…' : 'Test key'}
                    </Btn>
                  </div>
                  <div className="field-hint">
                    Stored in <code>state/secrets.env</code>, takes effect immediately. Leave blank to keep the existing key.
                  </div>
                  {keyVar === 'OPENAI_API_KEY' && (
                    <div className="field-hint">
                      This key is shared across LLM and Cloud TTS.
                    </div>
                  )}
                </div>
                {primaryKeyTest && <KeyTestResult result={primaryKeyTest} />}
              </>
            );
          })()}

          <div className="field">
            <Label>Model</Label>
            <div className="flex items-stretch gap-2">
              {primaryDiscovery.models.length > 0 ? (
                <ModelCombobox
                  models={primaryDiscovery.models}
                  value={form.llm.model}
                  onChange={v => setForm(f => ({ ...f, llm: { ...f.llm, model: v } }))}
                  placeholder="Select a model"
                />
              ) : (
                <Input
                  value={form.llm.model}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    setForm(f => ({ ...f, llm: { ...f.llm, model: e.target.value } }))
                  }
                  disabled={!primaryDiscoveryEnabled && form.llm.provider !== 'ollama'}
                  placeholder={
                    !primaryDiscoveryEnabled
                      ? (form.llm.provider === 'openai-compatible' ? 'Set a base URL first' : 'Set an API key above to discover and select a model')
                      : form.llm.provider === 'ollama'
                        ? 'nemotron-3-super:cloud'
                        : form.llm.provider === 'deepseek'
                          ? 'deepseek-v4-flash'
                          : form.llm.provider === 'openai-compatible' || form.llm.provider === 'locca'
                            ? 'Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf'
                            : 'model id'
                  }
                  className="max-w-[360px]"
                />
              )}
              {primaryDiscovery.loading
                ? <span className="animate-pulse text-[11px] whitespace-nowrap text-muted">discovering…</span>
                : primaryDiscoveryEnabled && (
                  <Btn onClick={primaryDiscovery.refresh} title="Refresh model list">↻</Btn>
                )
              }
            </div>
            <div className="field-hint">
              {primaryDiscovery.models.length > 0
                ? `${primaryDiscovery.models.length} model${primaryDiscovery.models.length !== 1 ? 's' : ''} discovered. Pick one from the list.`
                : !primaryDiscoveryEnabled
                  ? (form.llm.provider === 'openai-compatible'
                      ? 'Set a base URL above to discover available models.'
                      : 'Set an API key above to discover and select a model.')
                  : primaryDiscovery.error
                    ? `Discovery failed: ${primaryDiscovery.error}. Type a model ID manually.`
                    : primaryDiscovery.loading
                      ? 'Discovering models…'
                      : 'No models discovered. Type a model ID manually.'}
            </div>
          </div>

          {primaryKeyVar && (
            <KeyStatus envVar={primaryKeyVar} present={!!data.env?.[primaryKeyVar]} />
          )}

          {form.llm.provider === 'openai-compatible' && (
            <div className="field">
              <Label>Forced tool calls</Label>
              <Seg
                accent
                value={form.llm.toolChoice === 'auto' ? 'auto' : 'required'}
                options={[
                  { id: 'required', label: 'Required' },
                  { id: 'auto', label: 'Auto' },
                ]}
                onChange={v => setForm(f => ({ ...f, llm: { ...f.llm, toolChoice: v } }))}
              />
              <div className="field-hint">
                How the picker forces the model to return a structured pick.
                <code>Required</code> (default) sends{' '}
                <code>tool_choice:&quot;required&quot;</code> — the reliable path for
                local models. Switch to <code>Auto</code> only if your server
                <strong> crashes</strong> on a tool call: some newer vLLM images
                (notably Intel/XPU builds) mishandle the guided-decoding backend
                that <code>required</code> engages, while <code>auto</code> never
                does. On <code>Auto</code> a capable model still calls the tool;
                misses fall back to the stateless picker.
              </div>
            </div>
          )}
        </div>
      </Card>

      <Card title="Fallback" sub="backup when the primary is offline">
        <div className="grid gap-[18px]">
          <div className="grid grid-cols-[1fr_auto] items-center gap-4">
            <div>
              <div className="text-[13px] font-bold">Use a backup LLM</div>
              <div className="mt-0.5 max-w-[480px] text-[11px] leading-[1.5] text-muted">
                When the primary host can&apos;t be reached (connection refused,
                DNS failure, timeout, e.g. a GPU box that&apos;s powered off), the
                call is retried once against this backup, then routes straight back
                to the primary on the next call. A primary that&apos;s up but busy
                (rate-limited or erroring) is <em>not</em> failed over. Heavy work
                like library tagging stays on the primary, so a smaller backup
                model is fine here.
              </div>
            </div>
            <Seg
              accent
              value={form.llm.fallback.enabled ? 'on' : 'off'}
              options={[
                { id: 'off', label: 'Off' },
                { id: 'on', label: 'On' },
              ]}
              onChange={v =>
                setForm(f => ({ ...f, llm: { ...f.llm, fallback: { ...f.llm.fallback, enabled: v === 'on' } } }))
              }
            />
          </div>

          {form.llm.fallback.enabled && (
            <>
              <div className="field">
                <Label>Backup provider</Label>
                <Select
                  value={form.llm.fallback.provider}
                  onValueChange={v =>
                    setForm(f => ({ ...f, llm: { ...f.llm, fallback: { ...f.llm.fallback, provider: v } } }))
                  }
                >
                  <SelectTrigger className="max-w-[360px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {(data.llm?.providers || ['ollama']).map(p => (
                        <SelectItem key={p} value={p}>{llmProviderLabel(p)}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <div className="field-hint">
                  The provider to fall back to. Can differ from the primary, e.g.
                  primary on a self-hosted box, backup on always-on Ollama.
                </div>
              </div>

              {form.llm.fallback.provider === 'ollama' && (
                <div className="field">
                  <Label>Backup Ollama server URL</Label>
                  <Input
                    value={form.llm.fallback.ollamaUrl}
                    onChange={(e: ChangeEvent<HTMLInputElement>) =>
                      setForm(f => ({ ...f, llm: { ...f.llm, fallback: { ...f.llm.fallback, ollamaUrl: e.target.value } } }))
                    }
                    placeholder="http://localhost:11434"
                    className="max-w-[360px]"
                  />
                  <div className="field-hint">
                    Where the backup Ollama server runs. Leave blank for the
                    default (<code>http://localhost:11434</code>).
                  </div>
                </div>
              )}

              {form.llm.fallback.provider === 'ollama' && (
                <div className="field">
                  <Label>Backup context window (num_ctx)</Label>
                  <Input
                    type="number"
                    min={0}
                    step={1024}
                    value={form.llm.fallback.numCtx}
                    onChange={(e: ChangeEvent<HTMLInputElement>) =>
                      setForm(f => ({ ...f, llm: { ...f.llm, fallback: { ...f.llm.fallback, numCtx: Number(e.target.value) } } }))
                    }
                    placeholder="16384"
                    className="max-w-[200px]"
                  />
                  <div className="field-hint">
                    Tokens of context for a <strong>local</strong> backup Ollama
                    model. Set 0 for Ollama&apos;s default. Ignored for
                    <code>:cloud</code> models.
                  </div>
                </div>
              )}

              {form.llm.fallback.provider === 'openai-compatible' && (
                <div className="field">
                  <Label>Backup server base URL</Label>
                  <Input
                    value={form.llm.fallback.baseUrl}
                    onChange={(e: ChangeEvent<HTMLInputElement>) =>
                      setForm(f => ({ ...f, llm: { ...f.llm, fallback: { ...f.llm.fallback, baseUrl: e.target.value } } }))
                    }
                    placeholder="http://192.168.1.101:8080/v1"
                    className="max-w-[360px]"
                  />
                  <div className="field-hint">
                    OpenAI-compatible server URL including the <code>/v1</code>
                    suffix, required for this provider.
                  </div>
                </div>
              )}

              {form.llm.fallback.provider === 'openai-compatible' && (
                <>
                  <div className="field">
                    <Label>Bearer token</Label>
                    <div className="flex items-stretch gap-2">
                      <Input
                        type="password"
                        value={compatFallbackKeyInput}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => setCompatFallbackKeyInput(e.target.value)}
                        placeholder={(data.values?.llm as { keys?: Record<string, unknown> })?.keys?.['openai-compatible'] === 'set' ? '•••••• (on file)' : 'Bearer token (optional)'}
                        className="max-w-[360px]"
                      />
                      <Btn
                        onClick={() =>
                          testCompatKey(
                            compatFallbackKeyInput || '',
                            form.llm.fallback.baseUrl,
                            form.llm.fallback.model,
                            setCompatFallbackKeyTesting,
                            setCompatFallbackKeyTest,
                          )
                        }
                        disabled={compatFallbackKeyTesting || !form.llm.fallback.baseUrl.trim()}
                      >
                        {compatFallbackKeyTesting ? 'Testing…' : 'Test connection'}
                      </Btn>
                    </div>
                    <div className="field-hint">
                      Optional — only needed when the backup server requires bearer
                      authentication. Saved to <code>settings.json</code>, takes effect on
                      next save.
                    </div>
                  </div>
                  {compatFallbackKeyTest && <KeyTestResult result={compatFallbackKeyTest} />}
                </>
              )}

              {LLM_ENV_VARS[form.llm.fallback.provider] && (() => {
                const keyVar = LLM_ENV_VARS[form.llm.fallback.provider]!;
                return (
                  <>
                    <div className="field">
                      <Label>{llmProviderLabel(form.llm.fallback.provider)} API key</Label>
                      <div className="flex items-stretch gap-2">
                        <Input
                          type="password"
                          value={fallbackKeyInput}
                          placeholder={data.env?.[keyVar] ? '•••••• (on file)' : (KEY_HINTS[keyVar] ?? '')}
                          onChange={(e: ChangeEvent<HTMLInputElement>) => setFallbackKeyInput(e.target.value)}
                          className="max-w-[360px]"
                        />
                        <Btn
                          onClick={() => testKey(keyVar, fallbackKeyInput, setFallbackKeyTesting, setFallbackKeyTest, () => setFallbackKeyInput(''))}
                          disabled={fallbackKeyTesting || (!fallbackKeyInput.trim() && !data.env?.[keyVar])}
                        >
                          {fallbackKeyTesting ? 'Testing…' : 'Test key'}
                        </Btn>
                      </div>
                      <div className="field-hint">
                        Stored in <code>state/secrets.env</code>, takes effect immediately. Leave blank to keep the existing key.
                      </div>
                    </div>
                    {fallbackKeyTest && <KeyTestResult result={fallbackKeyTest} />}
                  </>
                );
              })()}

              <div className="field">
                <Label>Backup model</Label>
                <div className="flex items-stretch gap-2">
                  {fallbackDiscovery.models.length > 0 ? (
                    <ModelCombobox
                      models={fallbackDiscovery.models}
                      value={form.llm.fallback.model}
                      onChange={v => setForm(f => ({ ...f, llm: { ...f.llm, fallback: { ...f.llm.fallback, model: v } } }))}
                      placeholder="Select a model"
                    />
                  ) : (
                    <Input
                      value={form.llm.fallback.model}
                      onChange={(e: ChangeEvent<HTMLInputElement>) =>
                        setForm(f => ({ ...f, llm: { ...f.llm, fallback: { ...f.llm.fallback, model: e.target.value } } }))
                      }
                      disabled={!fallbackDiscoveryEnabled && form.llm.fallback.provider !== 'ollama'}
                      placeholder={
                        !fallbackDiscoveryEnabled
                          ? (form.llm.fallback.provider === 'openai-compatible' ? 'Set a base URL first' : 'Set an API key above to discover and select a model')
                          : form.llm.fallback.provider === 'ollama'
                            ? 'llama3.2:3b'
                            : form.llm.fallback.provider === 'deepseek'
                              ? 'deepseek-chat'
                              : form.llm.fallback.provider === 'openai-compatible' || form.llm.fallback.provider === 'locca'
                                ? 'Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf'
                                : 'model id'
                      }
                      className="max-w-[360px]"
                    />
                  )}
                  {fallbackDiscovery.loading
                    ? <span className="animate-pulse text-[11px] whitespace-nowrap text-muted">discovering…</span>
                    : fallbackDiscoveryEnabled && (
                      <Btn onClick={fallbackDiscovery.refresh} title="Refresh model list">↻</Btn>
                    )
                  }
                </div>
                <div className="field-hint">
                  {fallbackDiscovery.models.length > 0
                    ? `${fallbackDiscovery.models.length} model${fallbackDiscovery.models.length !== 1 ? 's' : ''} discovered. Pick one from the list.`
                    : !fallbackDiscoveryEnabled
                      ? (form.llm.fallback.provider === 'openai-compatible'
                          ? 'Set a base URL above to discover available models.'
                          : 'Set an API key above to discover and select a model.')
                      : fallbackDiscovery.error
                        ? `Discovery failed: ${fallbackDiscovery.error}. Type a model ID manually.`
                        : fallbackDiscovery.loading
                          ? 'Discovering models…'
                          : 'No models discovered. Type a model ID manually.'}
                </div>
              </div>

              {fallbackKeyVar && (
                <KeyStatus envVar={fallbackKeyVar} present={!!data.env?.[fallbackKeyVar]} />
              )}

              <div className="grid grid-cols-[1fr_auto] items-center gap-4">
                <div>
                  <div className="text-[13px] font-bold">Backup chain-of-thought</div>
                  <div className="mt-0.5 max-w-[480px] text-[11px] leading-[1.5] text-muted">
                    Whether the backup model may emit a reasoning step. Off by
                    default, like the primary.
                  </div>
                </div>
                <Seg
                  accent
                  value={form.llm.fallback.reasoning ? 'on' : 'off'}
                  options={[
                    { id: 'off', label: 'Off' },
                    { id: 'on', label: 'On' },
                  ]}
                  onChange={v =>
                    setForm(f => ({ ...f, llm: { ...f.llm, fallback: { ...f.llm.fallback, reasoning: v === 'on' } } }))
                  }
                />
              </div>
            </>
          )}
        </div>
      </Card>

      <Card title="Reasoning" sub="thinking models">
        <div className="grid grid-cols-[1fr_auto] items-center gap-4">
          <div>
            <div className="text-[13px] font-bold">Chain-of-thought</div>
            <div className="mt-0.5 max-w-[480px] text-[11px] leading-[1.5] text-muted">
              When off, the picker tells the model to skip or minimize its
              internal thinking step. Wired across providers that expose a
              thinking knob: Ollama, openai-compatible (Qwen3), Gemini 2.5/3.x,
              OpenAI o-series and gpt-5, Claude (adaptive thinking) and DeepSeek
              V4. DJ scripts and structured picks are short, and an uncapped
              thought chain just balloons latency and cost. Leave off unless
              you&apos;re running a model that genuinely needs it. Note: on
              Claude and DeepSeek the picker always suppresses thinking for its
              structured/tool calls, since those APIs reject forced tool calls while
              thinking, so there this toggle affects only the free-text DJ
              lines.
            </div>
          </div>
          <Seg
            accent
            value={form.llm.reasoning ? 'on' : 'off'}
            options={[
              { id: 'off', label: 'Off' },
              { id: 'on', label: 'On' },
            ]}
            onChange={v => setForm(f => ({ ...f, llm: { ...f.llm, reasoning: v === 'on' } }))}
          />
        </div>

        <div className="field mt-4">
          <Label>Max response size (tokens)</Label>
          <Input
            type="number"
            min={0}
            max={8000}
            step={500}
            value={form.llm.maxOutputTokens}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setForm(f => ({ ...f, llm: { ...f.llm, maxOutputTokens: Math.min(8000, Math.max(0, Number(e.target.value))) } }))
            }
            placeholder="0"
            className="max-w-[200px]"
          />
          <div className="field-hint">
            Caps the tokens the model may generate per response &mdash; the size
            of each reply, not a daily total. <strong>0 = use the built-in
            defaults</strong> (the default). Set a value (500&ndash;8000) to
            shrink it: useful on a local model with a small context window, where
            an oversized response allowance crowds out the system prompt and tool
            list and risks truncation &mdash; especially with reasoning off, where
            replies are short anyway. Values between 1 and 499 round up to 500.
          </div>
        </div>
      </Card>

      <Card title="Next-track picker" sub="how the DJ chooses">
        <div className="grid grid-cols-[1fr_auto] items-center gap-4">
          <div>
            <div className="text-[13px] font-bold">Agentic picker</div>
            <div className="mt-0.5 max-w-[480px] text-[11px] leading-[1.5] text-muted">
              When on, the next-track picker is a tool-using agent that explores the library
              itself. Needs a model that handles multi-step tool calls well. Leave off for
              small local models.
            </div>
          </div>
          <Seg
            accent
            value={form.llm.pickerAgent ? 'agent' : 'pool'}
            options={[
              { id: 'pool', label: 'Candidate pool' },
              { id: 'agent', label: 'Agent' },
            ]}
            onChange={v => setForm(f => ({ ...f, llm: { ...f.llm, pickerAgent: v === 'agent' } }))}
          />
        </div>

        {form.llm.pickerAgent && (
          <div className="field mt-4">
            <Label>Agent deadline (seconds)</Label>
            <Input
              type="number"
              min={5}
              max={180}
              step={5}
              value={Math.round(form.llm.agentTimeoutMs / 1000)}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setForm(f => ({ ...f, llm: { ...f.llm, agentTimeoutMs: Number(e.target.value) * 1000 } }))
              }
              placeholder="45"
              className="max-w-[200px]"
            />
            <div className="field-hint">
              How long an agent pick or listener request may run before falling
              back to the stateless picker. Slow reasoning models often need
              20&ndash;40s per pick; lower it for snappier fallbacks on a fast
              model. 5&ndash;180s.
            </div>
          </div>
        )}

        {form.llm.pickerAgent && (
          <div className="mt-4 grid grid-cols-[1fr_auto] items-center gap-4">
            <div>
              <div className="text-[13px] font-bold">Resolve described requests via web</div>
              <div className="mt-0.5 max-w-[480px] text-[11px] leading-[1.5] text-muted">
                When on, a listener who <em>describes</em> a track instead of naming it
                (&ldquo;the song from the new Dune movie&rdquo;) gets it looked up on the
                web, then matched against your library. Needs a web-search provider
                configured under Web search; otherwise it has no effect.
              </div>
            </div>
            <Seg
              accent
              value={form.llm.requestWebResolve ? 'on' : 'off'}
              options={[
                { id: 'off', label: 'Off' },
                { id: 'on', label: 'On' },
              ]}
              onChange={v => setForm(f => ({ ...f, llm: { ...f.llm, requestWebResolve: v === 'on' } }))}
            />
          </div>
        )}

        <div className="field mt-4">
          <Label>No-repeat window (tracks)</Label>
          <Input
            type="number"
            min={0}
            max={290}
            step={10}
            value={form.llm.noRepeatWindow}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setForm(f => ({ ...f, llm: { ...f.llm, noRepeatWindow: Math.max(0, Number(e.target.value)) } }))
            }
            placeholder="100"
            className="max-w-[200px]"
          />
          <div className="field-hint">
            The last N <strong>distinct</strong> tracks can never be re-picked &mdash; a hard
            guard on both the agent and candidate-pool pickers, on top of the time-based
            window. Auto-scales down on a small library so it never blocks everything.
            {' '}<strong>0 = off</strong>. Listener requests stay exempt. 0&ndash;290.
          </div>
        </div>
      </Card>

      <Card title="Idle behaviour" sub="when no one's listening">
        <div className="grid grid-cols-[1fr_auto] items-center gap-4">
          <div>
            <div className="text-[13px] font-bold">Pause DJ when empty</div>
            <div className="mt-0.5 max-w-[480px] text-[11px] leading-[1.5] text-muted">
              When on, the DJ stops making LLM calls (track picks, links, station
              IDs, hourly checks, segments and listener requests) whenever Icecast
              reports zero listeners. The stream keeps playing from the auto
              playlist, and the DJ resumes the moment someone tunes back in.
            </div>
          </div>
          <Seg
            accent
            value={form.llm.pauseWhenEmpty ? 'on' : 'off'}
            options={[
              { id: 'off', label: 'Off' },
              { id: 'on', label: 'On' },
            ]}
            onChange={v => setForm(f => ({ ...f, llm: { ...f.llm, pauseWhenEmpty: v === 'on' } }))}
          />
        </div>
      </Card>

      <Card title="Daily token budget" sub="cap LLM spend per day">
        <div className="field">
          <Label>Daily token cap</Label>
          <Input
            type="number"
            min={0}
            step={10000}
            value={form.llm.dailyTokenCap}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setForm(f => ({ ...f, llm: { ...f.llm, dailyTokenCap: Math.max(0, Number(e.target.value)) } }))
            }
            placeholder="0"
            className="max-w-[200px]"
          />
          <div className="field-hint">
            Hard ceiling on tokens the DJ may spend per day (UTC), counted from
            the same usage stats as the token ticker. <strong>0 = unlimited</strong>
            {' '}(the default &mdash; leave it off for a free local model). When set,
            the DJ drops to the cheap picker and mutes optional segments as it
            nears the cap, then stops calling the model entirely and coasts on the
            auto playlist once it&rsquo;s hit &mdash; music never stops.
          </div>
        </div>

        {form.llm.dailyTokenCap > 0 && (
          <div className="field mt-4">
            <Label>Soft threshold (%)</Label>
            <Input
              type="number"
              min={0}
              max={100}
              step={5}
              value={form.llm.budgetSoftPct}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setForm(f => ({ ...f, llm: { ...f.llm, budgetSoftPct: Math.min(100, Math.max(0, Number(e.target.value))) } }))
              }
              placeholder="80"
              className="max-w-[200px]"
            />
            <div className="field-hint">
              At this percent of the cap the DJ enters the cheap tier: stateless
              pool picks, no links or station IDs, no weather/news/etc. 0 or 100
              disables the soft tier (straight to the hard cap).
            </div>
          </div>
        )}

        {form.llm.dailyTokenCap > 0 && (
          <div className="mt-4 grid grid-cols-[1fr_auto] items-center gap-4">
            <div>
              <div className="text-[13px] font-bold">Always answer requests</div>
              <div className="mt-0.5 max-w-[480px] text-[11px] leading-[1.5] text-muted">
                When on, listener requests are still answered by the AI DJ even
                over the cap &mdash; a human asked, so honour it. When off,
                requests over the cap fall back to plain library matching like
                everything else.
              </div>
            </div>
            <Seg
              accent
              value={form.llm.exemptRequests ? 'on' : 'off'}
              options={[
                { id: 'off', label: 'Off' },
                { id: 'on', label: 'On' },
              ]}
              onChange={v => setForm(f => ({ ...f, llm: { ...f.llm, exemptRequests: v === 'on' } }))}
            />
          </div>
        )}
      </Card>

      <SaveBar
        note={`Active model: ${data.llm?.active}. Applies to the next LLM call, no restart needed.`}
        busy={busy}
        onSave={save}
        saveLabel="Save LLM provider"
      />

      {/* Chat-provider switch would otherwise drag the inherited embedding model
          with it and invalidate the already-embedded library. We pinned
          embeddings to the index's model; this notice explains it and lets the
          operator instead opt to re-embed on the new provider. The SAFE outcome
          (keep the pin) is the default — only the explicit confirm switches. */}
      <V3AlertDialog
        open={embedPinNotice != null}
        onOpenChange={(o) => { if (!o) setEmbedPinNotice(null); }}
        title="Embeddings kept on your library's model"
        description={embedPinNotice ? (
          <>
            Your library is embedded with <code>{embedPinNotice.model}</code> ({embedPinNotice.dim}-d
            vectors). Embeddings were following the chat provider, so switching to{' '}
            <strong>{llmProviderLabel(embedPinNotice.newProvider)}</strong> would have changed the
            embedding model too — and a different model produces incompatible vectors, breaking
            library / vibe search until you re-embed every track.
            {' '}To keep search working, embeddings are now <strong>pinned</strong> to{' '}
            <code>{embedPinNotice.model}</code> (Library tagger → Embedding). Switch embeddings to
            the new provider instead? You’ll need to re-embed the whole library afterwards.
          </>
        ) : ''}
        confirmLabel="switch embeddings too"
        cancelLabel="keep pinned"
        danger
        onConfirm={() => {
          setForm(f => (f ? { ...f, embedding: { ...f.embedding, provider: '', model: '' } } : f));
          setEmbedPinNotice(null);
        }}
      />
    </>
  );
}

/* ── Web search ──────────────────────────────────────────────────────── */

interface SearchSectionProps extends SectionProps {
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
}
function SearchSection({ data, form, setForm, busy, saveSettings, adminFetch }: SearchSectionProps) {
  const [tavilyKeyTest, setTavilyKeyTest] = useState<{ ok: boolean; message: string; latencyMs: number } | null>(null);
  const [tavilyKeyTesting, setTavilyKeyTesting] = useState(false);
  const [testingSearxng, setTestingSearxng] = useState(false);
  const [searxngTestResult, setSearxngTestResult] = useState<{ ok: boolean; results?: number; error?: string } | null>(null);

  const handleTestSearxng = async () => {
    setTestingSearxng(true);
    setSearxngTestResult(null);
    try {
      const res = await adminFetch('/settings/search/test-searxng', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: form.search.baseUrl }),
      });
      const j = await res.json();
      setSearxngTestResult(j);
    } catch (err: unknown) {
      setSearxngTestResult({ ok: false, error: err instanceof Error ? err.message : 'request failed' });
    } finally {
      setTestingSearxng(false);
    }
  };

  const save = () => saveSettings({
    search: {
      provider: form.search.provider,
      // Don't echo back 'set' — that's the redaction sentinel from getRedacted().
      // The controller's update() ignores it, but skipping it keeps the patch tidy.
      ...(form.search.apiKey && form.search.apiKey !== 'set'
        ? { apiKey: form.search.apiKey }
        : {}),
      ...(form.search.provider === 'searxng'
        ? { baseUrl: form.search.baseUrl ?? '' }
        : {}),
    },
  });

  const savedSearch = data.values?.search || {};
  const providers = data.search?.providers || ['duckduckgo', 'tavily', 'searxng'];
  const provider = form.search.provider;
  const searchDirty = provider !== savedSearch.provider
    || (provider === 'tavily'
        && form.search.apiKey
        && form.search.apiKey !== 'set'
        && form.search.apiKey !== (savedSearch.apiKey || ''))
    || (provider === 'searxng'
        && (form.search.baseUrl ?? '') !== (savedSearch.baseUrl || ''));
  const tavilyKeySet = form.search.apiKey === 'set' || !!data.env?.SEARCH_API_KEY;

  const testTavilyKey = async () => {
    const value = form.search.apiKey === 'set' ? '' : form.search.apiKey;
    if (!value.trim()) return;
    setTavilyKeyTesting(true);
    setTavilyKeyTest(null);
    try {
      const r = await adminFetch('/settings/secrets/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'SEARCH_API_KEY', value: value.trim() }),
      });
      const j = await r.json() as { ok: boolean; message: string; latencyMs: number };
      setTavilyKeyTest(j);
    } catch (e) {
      setTavilyKeyTest({ ok: false, message: errorMessage(e), latencyMs: 0 });
    } finally {
      setTavilyKeyTesting(false);
    }
  };

  return (
    <>
      <SectionHeader
        eyebrow="web search"
        title="Where the DJ gets live facts about the artist on air."
        sub={<>
          The segment director can air a single line of recent artist context between
          tracks, when the active backend returns something worth saying. DuckDuckGo
          is free and keyless; Tavily is paid but returns full web results. Switching
          here reroutes the next call, no restart.
        </>}
        metrics={[{ n: String(providers.length), l: 'providers' }]}
      />

      <Card title="Provider" sub="active backend">
        <div className="grid gap-[18px]">
          <div className="flex items-start gap-2.5 border border-[var(--accent)] bg-[var(--ink-softer)] p-3">
            <span className="mt-1 size-1.5 flex-none rounded-full bg-vermilion" />
            <div className="grid min-w-0 gap-0.5">
              <span className="text-[11px] font-bold tracking-[0.12em] text-vermilion uppercase">
                Routing now · {searchProviderLabel(savedSearch.provider || 'duckduckgo')}
              </span>
              <span className="text-[11px] leading-[1.5] text-muted">
                {searchDirty
                  ? <>Your edits below aren&apos;t live until you Save.</>
                  : <>This is the saved, running config.</>}
              </span>
            </div>
          </div>

          <div className="field">
            <div className="flex items-center gap-2">
              <Label>Provider</Label>
              {searchDirty && <Pill tone="accent" dot>unsaved</Pill>}
            </div>
            <Select
              value={provider}
              onValueChange={v => setForm(f => ({ ...f, search: { ...f.search, provider: v } }))}
            >
              <SelectTrigger className="max-w-[360px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {providers.map(p => (
                    <SelectItem key={p} value={p}>{searchProviderLabel(p)}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <div className="field-hint">
              {provider === 'duckduckgo'
                ? 'DuckDuckGo Instant Answer, free and keyless. Useful for definitions and well-known entities; silent otherwise. The segment director treats silence as a valid outcome.'
                : provider === 'tavily'
                ? 'Tavily, paid web search with full results and an answer summary. Needs an API key.'
                : 'SearXNG, self-hosted meta-search aggregating Google, Brave, DDG and more. No API key needed — just a running SearXNG instance.'}
            </div>
          </div>

          {provider === 'tavily' && (
            <>
              <div className="field">
                <Label>Tavily API key</Label>
                <div className="flex items-stretch gap-2">
                  <Input
                    type="password"
                    value={form.search.apiKey === 'set' ? '' : form.search.apiKey}
                    placeholder={form.search.apiKey === 'set' ? '•••••• (key on file)' : 'tvly-…'}
                    onChange={(e: ChangeEvent<HTMLInputElement>) =>
                      setForm(f => ({ ...f, search: { ...f.search, apiKey: e.target.value } }))
                    }
                    className="max-w-[360px]"
                  />
                  <Btn
                    onClick={testTavilyKey}
                    disabled={
                      tavilyKeyTesting ||
                      !form.search.apiKey.trim() ||
                      form.search.apiKey === 'set'
                    }
                  >
                    {tavilyKeyTesting ? 'Testing…' : 'Test key'}
                  </Btn>
                </div>
                <div className="field-hint">
                  Stored alongside the other admin settings. Falls back to
                  <code> SEARCH_API_KEY</code> in <code>.env</code> when blank. Set
                  one or the other, not both.
                </div>
              </div>
              <KeyStatus envVar="SEARCH_API_KEY" present={tavilyKeySet} />
              {tavilyKeyTest && <KeyTestResult result={tavilyKeyTest} />}
            </>
          )}

          {provider === 'searxng' && (
            <>
              <div className="field">
                <Label>SearXNG URL</Label>
                <div className="flex items-stretch gap-2">
                  <Input
                    type="url"
                    placeholder="http://192.168.0.112:8888"
                    value={form.search.baseUrl ?? ''}
                    onChange={(e: ChangeEvent<HTMLInputElement>) =>
                      setForm(f => ({ ...f, search: { ...f.search, baseUrl: e.target.value } }))
                    }
                    className="max-w-[360px]"
                  />
                  <Btn onClick={handleTestSearxng} disabled={!form.search?.baseUrl || testingSearxng}>
                    {testingSearxng ? 'Testing…' : 'Test'}
                  </Btn>
                </div>
                {searxngTestResult && (
                  <p className={`text-sm ${searxngTestResult.ok ? 'text-green-600' : 'text-destructive'}`}>
                    {searxngTestResult.ok
                      ? `Connected · ${searxngTestResult.results} results`
                      : `Failed: ${searxngTestResult.error}`}
                  </p>
                )}
                <div className="field-hint">
                  Self-hosted SearXNG instance. No API key required. Ensure JSON format is
                  enabled in your SearXNG <code>settings.yml</code>.
                </div>
              </div>
            </>
          )}
        </div>
      </Card>

      <SaveBar
        note="Applies to the next web-search call, no restart needed."
        busy={busy}
        onSave={save}
        saveLabel="Save web search"
      />
    </>
  );
}

/* ── Library tagger ──────────────────────────────────────────────────── */

interface LibrarySectionProps extends SectionProps {
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  refresh: () => void;
}

function LibrarySection({ data, form, setForm, busy, saveSettings, adminFetch, refresh }: LibrarySectionProps) {
  const e = form.embedding;
  const [embeddingKeyInput, setEmbeddingKeyInput] = useState('');

  useEffect(() => { setEmbeddingKeyInput(''); }, [form.embedding.provider]);

  const saveKey = async (envVar: string, value: string): Promise<boolean> => {
    if (!value.trim()) return true;
    try {
      const r = await adminFetch('/settings/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [envVar]: value.trim() }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({})) as { error?: string };
        notify.err(j.error || `Key save failed (${r.status})`);
        return false;
      }
      return true;
    } catch (e) {
      notify.err(errorMessage(e));
      return false;
    }
  };

  const save = async () => {
    await saveSettings({
      embedding: {
        enabled: e.enabled,
        provider: e.provider,
        model: e.model,
        baseUrl: e.baseUrl,
        ollamaUrl: e.ollamaUrl,
        seedCount: parseInt(e.seedCount, 10) || 0,
        knnNeighbours: parseInt(e.knnNeighbours, 10) || 10,
        moodVoteThreshold: parseFloat(e.moodVoteThreshold) || 0.4,
        confidenceThreshold: parseFloat(e.confidenceThreshold) || 0.35,
        maxActiveLearningRounds: parseInt(e.maxActiveLearningRounds, 10) || 0,
        // NaN-safe rather than `|| 0.5` — 0 is a deliberate value (fusion off)
        // and must not be coerced back to the default.
        audioFusionWeight: Number.isFinite(parseFloat(e.audioFusionWeight))
          ? parseFloat(e.audioFusionWeight)
          : 0.5,
        enrichment: {
          lastfmTags: e.enrichment.lastfmTags,
          lyrics: e.enrichment.lyrics,
        },
      },
    });
    // Save embedding API key override if typed (cloud embedding providers only —
    // embedKeyVar is set only for providers that use a conventional key).
    if (embedKeyVar && embeddingKeyInput.trim()) {
      const ok = await saveKey('EMBEDDING_API_KEY', embeddingKeyInput);
      if (ok) { notify.ok('API key saved'); setEmbeddingKeyInput(''); refresh(); }
    }
  };

  const savedEmbedding = data.values?.embedding || {};
  const llmProvider = data.values?.llm?.provider || 'ollama';
  const effectiveProvider = e.provider || llmProvider;
  const embedSuggestions = EMBED_MODEL_SUGGESTIONS[effectiveProvider] ?? [];

  // Provider list is the embedding-capable subset (/settings.embedding.providers),
  // NOT the full LLM list — chat-only providers (deepseek, gateway) have no
  // embeddings endpoint and can't be picked here (#493). OpenRouter shipped an
  // embeddings endpoint so it's back in (#522). Anthropic was dropped — it has no
  // embedding API and only worked by routing to OpenAI, which was confusing.
  const embedProviders = data.embedding?.providers ||
    ['ollama', 'openai-compatible', 'locca', 'openrouter', 'openai', 'google', 'requesty'];
  // Keep a stale explicit choice (a chat-only provider saved before this list
  // shrank) visible so the Select isn't blank and the warning below makes sense.
  const providers = e.provider && !embedProviders.includes(e.provider)
    ? [e.provider, ...embedProviders]
    : embedProviders;
  // The effective provider can't embed when "Follow LLM provider" resolves to a
  // chat-only LLM, or a stale config still names one. Drives the warning below.
  const canEmbed = embedProviders.includes(effectiveProvider);

  // --- Guided setup: probe the endpoint up front, detect a locca embed server,
  // and kick the tagger from here, instead of failing mid-run (#405 follow-up).
  const [probe, setProbe] = useState<
    { ok: boolean; dim: number | null; code: string; message: string } | null
  >(null);
  const [probing, setProbing] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // Local servers (llama.cpp/locca) need a dedicated embedding endpoint; cloud
  // and Ollama providers serve embeddings on the same endpoint as chat.
  const needsServerUrl = effectiveProvider === 'locca' || effectiveProvider === 'openai-compatible';

  const embedKeyVar = LLM_ENV_VARS[effectiveProvider];
  const embedKeySet = !!(embedKeyVar && data.env?.[embedKeyVar]);
  // Embeddings reuse the DJ provider's own key automatically, so the key is
  // "present" if that provider's env var is set OR the optional EMBEDDING_API_KEY
  // override is. The warning must key off this — not EMBEDDING_API_KEY alone, or
  // it cries "missing" for a provider whose key is already set for the DJ.
  const embedKeyPresent = embedKeySet || !!data.env?.['EMBEDDING_API_KEY'];

  const embedDiscoveryEnabled =
    effectiveProvider === 'ollama'
    || effectiveProvider === 'locca'
    || (effectiveProvider === 'openai-compatible' && !!(e.baseUrl || form.llm.baseUrl).trim())
    || (effectiveProvider === 'openrouter')
    || (!!embedKeyVar && embedKeySet);

  const embedDiscovery = useModelDiscovery({
    provider: effectiveProvider,
    baseUrl: e.baseUrl || form.llm.baseUrl,
    ollamaUrl: e.ollamaUrl || form.llm.ollamaUrl,
    scope: 'embedding',
    enabled: embedDiscoveryEnabled,
    adminFetch,
  });

  const probeQuery = () => {
    const p = new URLSearchParams();
    if (e.provider) p.set('provider', e.provider);
    if (e.model) p.set('model', e.model);
    if (e.baseUrl) p.set('baseUrl', e.baseUrl);
    if (e.ollamaUrl) p.set('ollamaUrl', e.ollamaUrl);
    return p.toString();
  };

  const runProbe = async () => {
    setProbing(true);
    setProbe(null);
    try {
      const r = await adminFetch(`/settings/embedding/probe?${probeQuery()}`);
      setProbe(await r.json());
    } catch (err) {
      setProbe({ ok: false, dim: null, code: 'unknown', message: errorMessage(err) });
    } finally {
      setProbing(false);
    }
  };

  // Find a locca embedding server on its default port (8090), pre-fill the form,
  // and confirm it actually embeds.
  const detect = async () => {
    setDetecting(true);
    setProbe(null);
    const url = 'http://host.docker.internal:8090/v1';
    try {
      let model = 'nomic-embed-text';
      try {
        const d = await (
          await adminFetch(`/settings/llm/discover?baseUrl=${encodeURIComponent(url)}`)
        ).json();
        if (d.reachable && Array.isArray(d.models) && d.models.length) model = d.models[0];
      } catch {
        /* discovery is best-effort — fall through and probe with the default model */
      }
      const p = new URLSearchParams({ provider: 'locca', baseUrl: url, model });
      const j = await (await adminFetch(`/settings/embedding/probe?${p.toString()}`)).json();
      setProbe(j);
      if (j.ok) {
        setForm(f => ({ ...f, embedding: { ...f.embedding, provider: 'locca', baseUrl: url, model } }));
      }
    } catch (err) {
      setProbe({ ok: false, dim: null, code: 'unknown', message: errorMessage(err) });
    } finally {
      setDetecting(false);
    }
  };

  // What the tagger will actually embed with right now — resolved from the LIVE
  // form (not saved state). "Follow LLM" resolves the provider; a blank Model
  // field resolves to that provider's default. This is the line that stops
  // operators reverse-engineering "what am I actually using?" — e.g. a DeepSeek
  // DJ routed through OpenRouter embeds via openai/text-embedding-3-small, which
  // isn't obvious from any field (Discord report).
  const embeddedMeta = data.libraryStats?.embeddingMeta || null;
  const suggestedDefault = EMBED_MODEL_SUGGESTIONS[effectiveProvider]?.[0];
  // Defaults for the providers not carried in EMBED_MODEL_SUGGESTIONS (they have
  // no combobox suggestions but still resolve to a sensible model server-side).
  const OTHER_EMBED_DEFAULTS: Record<string, string> = {
    'openai-compatible': 'text-embedding-3-small',
    locca: 'nomic-embed-text',
    anthropic: 'text-embedding-3-small',
  };
  const effectiveModel =
    e.model?.trim() || suggestedDefault?.id || OTHER_EMBED_DEFAULTS[effectiveProvider] || '';
  // Prefer a real measurement (a green probe, or the dim the library was actually
  // embedded at) over the name→dim guess.
  const effectiveDim =
    probe?.dim ??
    embeddedMeta?.dim ??
    EMBED_MODEL_SUGGESTIONS[effectiveProvider]?.find(m => m.id === effectiveModel)?.dim ??
    suggestedDefault?.dim ??
    null;

  return (
    <>
      <SectionHeader
        eyebrow="library tagger"
        title="Embedding-propagated mood tagging."
        sub={<>
          The tagger embeds every track once, LLM-tags a small representative
          seed set, then KNN-propagates moods + energy to the rest. Cuts LLM
          call count ~10× vs. brute-force per-track tagging. Tune below;
          changes apply the next time the bulk tagger runs.
        </>}
        metrics={[
          {
            n: String(data.libraryStats?.total ?? '—'),
            l: 'tagged',
          },
        ]}
        manualHref="/manual/llm"
        manualLabel="How embeddings work"
      />

      <Card title="Tagger" sub="enabled?">
        <div className="grid grid-cols-[1fr_auto] items-center gap-4">
          <div>
            <div className="text-[13px] font-bold">Embedding-propagated tagging</div>
            <div className="mt-0.5 max-w-[480px] text-[11px] leading-[1.5] text-muted">
              When off, the bulk tagger refuses to start. Single-track retags
              from the Library admin page still work (they bypass the
              embedding pipeline).
            </div>
          </div>
          <Seg
            accent
            value={e.enabled ? 'on' : 'off'}
            options={[
              { id: 'off', label: 'Off' },
              { id: 'on', label: 'On' },
            ]}
            onChange={v =>
              setForm(f => ({ ...f, embedding: { ...f.embedding, enabled: v === 'on' } }))
            }
          />
        </div>
      </Card>

      <Card title="Embedding server" sub="where embeddings come from">
        <div className="grid gap-[18px]">
          {/* Affirmative "you're set up" line for new users — the effective
              provider/model/dim resolve to a working default even when both
              fields are blank, so surface that instead of leaving the tab
              looking unconfigured. Hidden when the effective provider can't
              embed (the warning below the Provider field covers that case). */}
          {canEmbed && effectiveModel && (
            <div className="flex items-start gap-x-2 border border-[color-mix(in_oklab,var(--accent)_30%,transparent)] bg-[var(--accent-soft)] p-3 text-[11px] leading-[1.5] text-ink">
              <span className="flex-none text-[12px] leading-[1.5] text-[var(--accent)]">✓</span>
              <span className="min-w-0">
                Ready to tag with defaults — <code>{llmProviderLabel(effectiveProvider)}</code>
                {!e.provider && <span className="text-muted"> (your DJ&rsquo;s provider)</span>}
                {' · '}<code>{effectiveModel}</code>
                {effectiveDim != null && <span className="text-muted"> · {effectiveDim}-d</span>}.
                <span className="text-muted"> Change the provider or model below to override.</span>
              </span>
            </div>
          )}
          <div className="field">
            <Label>Provider</Label>
            <EmbeddingProviderSelector
              // A blank stored provider resolves to the DJ's provider, so the
              // grid always shows an explicit selection (no "Follow LLM" card).
              value={effectiveProvider}
              providerIds={providers}
              env={data.env}
              onChange={v =>
                setForm(f => ({ ...f, embedding: { ...f.embedding, provider: v } }))
              }
              className="max-w-[560px]"
            />
            <div className="field-hint">
              Where the text embeddings come from. Defaults to your DJ&rsquo;s
              provider, so Ollama-local users get <code>nomic-embed-text</code> free.
              Anthropic has no first-party embedding API; if your LLM is Anthropic,
              pick OpenAI here (needs <code>OPENAI_API_KEY</code>).
            </div>
            {/* The resolved provider/model/dim is stated in the "Ready to tag
                with defaults" banner above, so no "Embedding now:" line here —
                only the specific warning that the library is already embedded
                with a different model (a full re-embed on change). */}
            {embeddedMeta && embeddedMeta.model !== effectiveModel && (
              <div className="field-hint">
                Your library is currently embedded with{' '}
                <code>{embeddedMeta.model}</code> ({embeddedMeta.dim}-d) — changing
                the model means a full re-embed.
              </div>
            )}

            {!canEmbed && (
              <div
                role="alert"
                className="mt-2 max-w-[480px] border border-l-[3px] border-[var(--danger)] bg-[color-mix(in_oklab,var(--danger)_7%,transparent)] p-3"
              >
                <div className="flex items-center gap-2">
                  <span className="text-[13px] leading-none text-[var(--danger)]">⚠</span>
                  <span className="text-[11px] font-bold tracking-[0.14em] text-[var(--danger)] uppercase">
                    {llmProviderLabel(effectiveProvider)} can’t make embeddings
                  </span>
                </div>
                <p className="mt-2 text-[11px] leading-[1.55] text-muted">
                  {e.provider ? (
                    <><code>{llmProviderLabel(effectiveProvider)}</code> is a chat-only provider, with no embeddings endpoint, so the tagger can’t use it.</>
                  ) : (
                    <>Your DJ provider <code>{llmProviderLabel(llmProvider)}</code> is chat-only and has no embeddings endpoint.</>
                  )}{' '}
                  Pick a real embedding provider above. <strong>Ollama</strong> is local
                  and free (<code>nomic-embed-text</code>, auto-pulled on first run), or
                  use OpenAI / Google / locca. Your DJ stays on{' '}
                  <code>{llmProviderLabel(llmProvider)}</code>.
                </p>
              </div>
            )}
          </div>

          <div className="field">
            <Label>Model</Label>
            <div className="flex items-stretch gap-2">
              {embedDiscovery.models.length > 0 ? (
                <ModelCombobox
                  models={embedDiscovery.models}
                  value={e.model}
                  onChange={v => setForm(f => ({ ...f, embedding: { ...f.embedding, model: v } }))}
                  // Blank field still means "follow the provider default"; show
                  // that default (e.g. nomic-embed-text) rather than an empty
                  // "Select a model" that reads as unconfigured.
                  placeholder={effectiveModel ? `${effectiveModel} · default` : 'Select a model'}
                />
              ) : (
                <Input
                  value={e.model}
                  onChange={(ev: ChangeEvent<HTMLInputElement>) =>
                    setForm(f => ({ ...f, embedding: { ...f.embedding, model: ev.target.value } }))
                  }
                  placeholder={effectiveModel ? `${effectiveModel} · default` : 'model id'}
                  className="max-w-[360px]"
                />
              )}
              {embedDiscovery.loading
                ? <span className="animate-pulse text-[11px] whitespace-nowrap text-muted">discovering…</span>
                : embedDiscoveryEnabled && (
                  <Btn onClick={embedDiscovery.refresh} title="Refresh model list">↻</Btn>
                )
              }
            </div>
            <div className="field-hint">
              {embedDiscovery.models.length > 0
                ? `${embedDiscovery.models.length} model${embedDiscovery.models.length !== 1 ? 's' : ''} discovered. Keep the default${effectiveModel ? ` (${effectiveModel})` : ''} or pick another.`
                : !embedDiscoveryEnabled
                  ? (effectiveProvider === 'openai-compatible'
                      ? 'Set a base URL above to discover available models.'
                      : 'Set an API key above to discover and select a model.')
                  : embedDiscovery.error
                    ? `Discovery failed: ${embedDiscovery.error}. Type a model ID manually.`
                    : embedDiscovery.loading
                      ? 'Discovering models…'
                      : 'No models discovered. Type a model ID manually.'}
            </div>
            <div className="field-hint">
              Leave blank for the sensible default per provider. If you change
              this on a tagged library, the next run will reject the new dim.
              Hit <strong>Re-seed</strong> on the Library tab (or run{' '}
              <code>--reseed</code>) to drop and rebuild the vectors.
            </div>
            {embedSuggestions.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-muted">Suggested:</span>
                {embedSuggestions.map(s => (
                  <Btn
                    key={s.id}
                    sm
                    onClick={() =>
                      setForm(f => ({ ...f, embedding: { ...f.embedding, model: s.id } }))
                    }
                    title={`Use ${s.id} (${s.dim}-dim)`}
                  >
                    {s.id}
                    <span className="ml-1 text-muted">{s.dim}d</span>
                  </Btn>
                ))}
              </div>
            )}
          </div>

          {(effectiveProvider === 'openai-compatible' || effectiveProvider === 'locca') && (
            <div className="field">
              <Label>Embedding server base URL</Label>
              <Input
                value={e.baseUrl}
                onChange={(ev: ChangeEvent<HTMLInputElement>) =>
                  setForm(f => ({ ...f, embedding: { ...f.embedding, baseUrl: ev.target.value } }))
                }
                placeholder="http://host.docker.internal:8090/v1"
                className="max-w-[360px]"
              />
              <div className="field-hint">
                Embeddings need a <strong>dedicated</strong> server: one
                llama.cpp / locca process can&apos;t serve both chat and
                embeddings.{' '}
                {effectiveProvider === 'locca' ? (
                  <>
                    Leave blank to use the locca embed server on its default port
                    (<code>http://host.docker.internal:8090/v1</code>). Start it
                    with <code>locca embed nomic</code>. Override only for a
                    non-default port or remote host.
                  </>
                ) : (
                  <>
                    Leave blank only if this server itself does embeddings;
                    otherwise run a separate embedding server (
                    <code>llama-server -m nomic-embed-text-v1.5.Q8_0.gguf --embeddings --pooling mean --port 8090</code>)
                    and point this at it, including the <code>/v1</code> suffix.
                  </>
                )}
                {' '}Must be reachable from the controller container. Use the host
                LAN/Tailscale IP or <code>host.docker.internal</code>, not{' '}
                <code>127.0.0.1</code>.
              </div>
            </div>
          )}

          {effectiveProvider === 'ollama' && (
            <div className="field">
              <Label>Embedding server URL</Label>
              <Input
                value={e.ollamaUrl}
                onChange={(ev: ChangeEvent<HTMLInputElement>) =>
                  setForm(f => ({ ...f, embedding: { ...f.embedding, ollamaUrl: ev.target.value } }))
                }
                placeholder="http://host.docker.internal:11434"
                className="max-w-[360px]"
              />
              <div className="field-hint">
                Leave blank to use the same Ollama server as chat (it serves
                embeddings too). Set this only to run embeddings against a
                different Ollama host.
              </div>
            </div>
          )}

          {/* Embedding key — cloud embedding providers only (embedKeyVar is
              undefined for ollama / openai-compatible / locca, which need no
              conventional key). Embeddings reuse the DJ provider's own key, so
              the status keys off that (embedKeyPresent), not EMBEDDING_API_KEY
              alone; the override is only for running embeddings on a different
              provider than the DJ. */}
          {embedKeyVar && (
            <>
              <div className="field">
                <Label>Embedding API key override</Label>
                <Input
                  type="password"
                  value={embeddingKeyInput}
                  placeholder={embedKeyPresent ? '•••••• (reusing your DJ key)' : `${embedKeyVar} — or set it in .env`}
                  onChange={(ev: ChangeEvent<HTMLInputElement>) => setEmbeddingKeyInput(ev.target.value)}
                  className="max-w-[360px]"
                />
                <div className="field-hint">
                  Optional. Embeddings reuse your DJ&rsquo;s <code>{embedKeyVar}</code> automatically —
                  only set this to run embeddings on a different provider than your DJ.
                  Stored in <code>state/secrets.env</code>.
                </div>
              </div>
              <KeyStatus envVar={embedKeyVar} present={embedKeyPresent} />
            </>
          )}

          {/* Detect a locca embed server + test the endpoint BEFORE a long run. */}
          <div className="field">
            <div className="flex flex-wrap items-center gap-2">
              {needsServerUrl && (
                <Btn sm onClick={detect} disabled={detecting || probing}>
                  {detecting
                    ? 'Detecting…'
                    : effectiveProvider === 'locca'
                      ? 'Detect locca server'
                      : 'Detect server'}
                </Btn>
              )}
              <Btn sm tone="accent" onClick={runProbe} disabled={probing || detecting}>
                {probing ? 'Testing…' : 'Test embeddings'}
              </Btn>
            </div>
            {probe && (
              <div
                className={cn(
                  'mt-2 max-w-[560px] rounded border bg-[var(--ink-softer)] px-3 py-2 text-[11px] leading-[1.6] whitespace-pre-wrap',
                  probe.ok
                    ? 'border-[var(--accent)] text-[color:var(--accent)]'
                    : 'border-[var(--danger)] text-[var(--danger)]',
                )}
              >
                {probe.ok
                  ? `✓ Producing embeddings${probe.dim ? ` (${probe.dim}-dim vectors)` : ''}, you're ready to tag.`
                  : `✗ ${probe.message}`}
              </div>
            )}
          </div>
        </div>
      </Card>

      {/* The bulk tagger is launched from the Library page's "Start tagging"
          flow (with its per-run step + batch controls), so there's no run
          button here — this tab is just the embedding config + advanced knobs. */}

      {/* Advanced knobs — collapsed by default so newcomers see only the basics. */}
      <button
        type="button"
        onClick={() => setAdvancedOpen(o => !o)}
        className="mb-1 w-fit text-[11px] font-bold tracking-[0.14em] text-muted uppercase hover:text-ink"
      >
        {advancedOpen ? '▾' : '▸'} Advanced: seed count, propagation, enrichment
      </button>
      {advancedOpen && (
        <>
      <Card title="Seed phase" sub="how many tracks to LLM-tag">
        <div className="grid gap-[18px]">
          <div className="field">
            <Label>Seed count</Label>
            <Input
              type="number"
              min={0}
              max={50000}
              value={e.seedCount}
              onChange={(ev: ChangeEvent<HTMLInputElement>) =>
                setForm(f => ({
                  ...f,
                  embedding: { ...f.embedding, seedCount: ev.target.value },
                }))
              }
              className="max-w-[180px]"
            />
            <div className="field-hint">
              How many tracks the LLM tags by hand before propagation kicks in.
              <code> 0</code> = auto: <code>~4% of the library</code> (floored at
              200, capped at 2500). For a 5k library that&apos;s 200; for 50k,
              2000. A denser seed set is often net-cheaper — more anchors means a
              smaller (expensive) active-learning residual. CLI{' '}
              <code>--seeds N</code> overrides this.
            </div>
          </div>
        </div>
      </Card>

      <Card title="Propagation" sub="KNN voting">
        <div className="grid gap-[18px]">
          <div className="field">
            <Label>KNN neighbours</Label>
            <Input
              type="number"
              min={1}
              max={50}
              value={e.knnNeighbours}
              onChange={(ev: ChangeEvent<HTMLInputElement>) =>
                setForm(f => ({
                  ...f,
                  embedding: { ...f.embedding, knnNeighbours: ev.target.value },
                }))
              }
              className="max-w-[180px]"
            />
            <div className="field-hint">
              How many nearest tagged neighbours vote on an untagged track&apos;s
              moods + energy. Default <code>10</code> — a broader, steadier vote
              than the old 5. Very high values dilute the vote on a sparsely-tagged
              library (coverage below counts against confidence).
            </div>
          </div>

          <div className="field">
            <Label>Mood vote threshold</Label>
            <Input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={e.moodVoteThreshold}
              onChange={(ev: ChangeEvent<HTMLInputElement>) =>
                setForm(f => ({
                  ...f,
                  embedding: { ...f.embedding, moodVoteThreshold: ev.target.value },
                }))
              }
              className="max-w-[180px]"
            />
            <div className="field-hint">
              Fraction of the total voting <em>weight</em> a mood must carry to
              propagate (neighbours vote weighted by similarity, so close matches
              count for more). Default <code>0.4</code>. Higher = stricter, fewer
              propagated tags; lower = looser, more drift.
            </div>
          </div>

          <div className="field">
            <Label>Confidence threshold</Label>
            <Input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={e.confidenceThreshold}
              onChange={(ev: ChangeEvent<HTMLInputElement>) =>
                setForm(f => ({
                  ...f,
                  embedding: { ...f.embedding, confidenceThreshold: ev.target.value },
                }))
              }
              className="max-w-[180px]"
            />
            <div className="field-hint">
              Minimum confidence for a propagated tag to be accepted; below it the
              track is queued for (pricier) LLM tagging. Confidence is{' '}
              <code>topSim × coverage</code> — the nearest tagged neighbour&apos;s
              similarity times the fraction of neighbours that were tagged. Being a
              product of two sub-1 numbers it compounds fast, so the default is{' '}
              <code>0.35</code>, not 0.6 (0.6 rejected even strong matches and sent
              most tracks to the LLM).
            </div>
          </div>

          <div className="field">
            <Label>Audio fusion weight</Label>
            <Input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={e.audioFusionWeight}
              onChange={(ev: ChangeEvent<HTMLInputElement>) =>
                setForm(f => ({
                  ...f,
                  embedding: { ...f.embedding, audioFusionWeight: ev.target.value },
                }))
              }
              className="max-w-[180px]"
            />
            <div className="field-hint">
              Lets tracks with a &ldquo;sounds-like&rdquo; (CLAP) vector pull
              audio-similar neighbours into the mood vote, scaled by this weight —
              sound is the stronger mood signal for instrumentals and tracks with
              thin metadata. <code>0</code> = text-only vote; <code>1</code> =
              trust audio similarity as much as text. Default <code>0.5</code>.
              Only applies where the acoustic analysis has produced audio vectors.
            </div>
          </div>

          <div className="field">
            <Label>Active-learning rounds</Label>
            <Input
              type="number"
              min={0}
              max={10}
              value={e.maxActiveLearningRounds}
              onChange={(ev: ChangeEvent<HTMLInputElement>) =>
                setForm(f => ({
                  ...f,
                  embedding: { ...f.embedding, maxActiveLearningRounds: ev.target.value },
                }))
              }
              className="max-w-[180px]"
            />
            <div className="field-hint">
              Max rounds of (LLM-tag the uncertain residual → re-propagate)
              after the first propagation pass. <code>0</code> skips active
              learning entirely. CLI <code>--max-rounds N</code> overrides
              this.
            </div>
          </div>
        </div>
      </Card>

      <Card title="Enrichment" sub="signals folded into the embedding text">
        <div className="grid gap-4">
          <div className="grid grid-cols-[1fr_auto] items-center gap-4">
            <div>
              <div className="text-[13px] font-bold">Last.fm tags</div>
              <div className="mt-0.5 max-w-[480px] text-[11px] leading-[1.5] text-muted">
                With a Last.fm API key configured (Scrobbling), crowd tags come
                straight from the Last.fm API and work on vanilla Navidrome.
                Without a key it falls back to Navidrome&apos;s{' '}
                <code>getArtistInfo2</code>, which only surfaces tags on a custom
                Navidrome — so leave off unless you have a key or that setup.
              </div>
            </div>
            <Seg
              accent
              value={e.enrichment.lastfmTags ? 'on' : 'off'}
              options={[
                { id: 'off', label: 'Off' },
                { id: 'on', label: 'On' },
              ]}
              onChange={v =>
                setForm(f => ({
                  ...f,
                  embedding: {
                    ...f.embedding,
                    enrichment: { ...f.embedding.enrichment, lastfmTags: v === 'on' },
                  },
                }))
              }
            />
          </div>

          <div className="grid grid-cols-[1fr_auto] items-center gap-4">
            <div>
              <div className="text-[13px] font-bold">Lyrics</div>
              <div className="mt-0.5 max-w-[480px] text-[11px] leading-[1.5] text-muted">
                Fetch a short lyric excerpt per track and fold it into the
                embedding text. Improves propagation quality on
                lyrically-driven tracks (folk, hip-hop, singer-songwriter);
                negligible effect on instrumentals.
              </div>
            </div>
            <Seg
              accent
              value={e.enrichment.lyrics ? 'on' : 'off'}
              options={[
                { id: 'off', label: 'Off' },
                { id: 'on', label: 'On' },
              ]}
              onChange={v =>
                setForm(f => ({
                  ...f,
                  embedding: {
                    ...f.embedding,
                    enrichment: { ...f.embedding.enrichment, lyrics: v === 'on' },
                  },
                }))
              }
            />
          </div>
        </div>
      </Card>
        </>
      )}

      <SaveBar
        note={`Saved values apply the next time the bulk tagger runs. Current run (if any) keeps its own snapshot.${
          savedEmbedding.provider || savedEmbedding.model
            ? ''
            : ' Provider/model defaults follow the LLM section.'
        }`}
        busy={busy}
        onSave={save}
        saveLabel="Save library tagger"
      />
    </>
  );
}

/* ── Station ─────────────────────────────────────────────────────────── */

// IANA zones grouped by region prefix for the timezone select. Built once —
// Intl.supportedValuesOf exists in every runtime this UI supports, but the
// guard keeps an exotic browser from crashing the whole settings page.
const TZ_GROUPS: Array<{ region: string; zones: string[] }> = (() => {
  let zones: string[] = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { /* select offers Auto only */ }
  const byRegion = new Map<string, string[]>();
  for (const z of zones) {
    const region = z.includes('/') ? z.slice(0, z.indexOf('/')) : 'Other';
    if (!byRegion.has(region)) byRegion.set(region, []);
    byRegion.get(region)!.push(z);
  }
  return [...byRegion.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([region, zs]) => ({ region, zones: zs }));
})();

// Wall-clock preview for a zone, or '' when the zone can't be formatted.
function clockPreview(timeZone: string, locale: StationLocale) {
  return fmtClockMinute(new Date(), timeZone || undefined, locale);
}

function StationSection({ data, form, setForm, busy, saveSettings }: SectionProps) {
  const save = () => saveSettings({
    station: form.station,
    timezone: form.timezone,
    locale: form.locale,
    weather: {
      lat: parseFloat(form.weather.lat),
      lng: parseFloat(form.weather.lng),
      locationName: form.weather.locationName,
      units: form.weather.units,
    },
  });

  // Re-render every 30s so the station-clock preview keeps walking — it's
  // the operator's sanity check that the selected zone matches their watch.
  const [, setClockTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setClockTick(t => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const serverTz = data.serverTimezone || 'server timezone';
  // '' = Auto → preview the server's zone, which is what the station runs on.
  const previewTz = form.timezone || data.serverTimezone || '';
  const preview = clockPreview(previewTz, form.locale);
  const localeLabel = form.locale === 'en-US' ? 'English (US)' : 'English (UK)';

  // A picked city carries its IANA zone. We *suggest* it rather than overwrite —
  // the operator may have deliberately set a different station clock. Cleared
  // once applied or dismissed.
  const [tzSuggestion, setTzSuggestion] = useState<string | null>(null);
  const handleGeocodePick = (r: GeocodeResult) => {
    const effective = form.timezone || data.serverTimezone || '';
    setTzSuggestion(r.timezone && r.timezone !== effective ? r.timezone : null);
  };
  // A picked zone may not be one of TZ_GROUPS' items; Radix Select needs a
  // matching <SelectItem> to render it, so the card adds a fallback item.
  const tzInGroups = !form.timezone || TZ_GROUPS.some(g => g.zones.includes(form.timezone));

  return (
    <>
      <SectionHeader
        eyebrow="station"
        title="How the DJ identifies this radio on air."
        sub="The station name is substituted into the DJ prompt as {station}. The location sets where the DJ thinks it broadcasts from and drives the Open-Meteo weather it reads on air. The timezone sets the clock the DJ lives on; locale controls how station times are displayed. All apply live, no mixer restart."
        metrics={[
          { n: data.values?.station || 'SUB/WAVE', l: 'station', accent: true },
        ]}
      />

      <Card title="Station name" sub="What the DJ calls this radio on air">
        <div className="field">
          <Label>Station name</Label>
          <Input
            placeholder="SUB/WAVE"
            value={form.station}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setForm(f => ({ ...f, station: e.target.value }))
            }
            className="w-[260px]"
            maxLength={80}
          />
          <div className="field-hint">
            Substituted into the DJ prompt’s {'{station}'} placeholder (current: {data.values?.station || 'SUB/WAVE'}). Applies live.
          </div>
        </div>
      </Card>

      <Card title="Station location" sub="DJ context + Open-Meteo weather">
        <div className="field">
          <Label>Location</Label>
          <LocationPicker
            variant="admin"
            value={{
              locationName: form.weather.locationName,
              lat: form.weather.lat,
              lng: form.weather.lng,
            }}
            onChange={next =>
              setForm(f => ({ ...f, weather: { ...f.weather, ...next } }))
            }
            onPick={handleGeocodePick}
          />
          {tzSuggestion ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px]">
              <span className="text-muted-foreground">
                Set station timezone to <span className="text-foreground">{tzSuggestion}</span>?
              </span>
              <Btn
                onClick={() => {
                  setForm(f => ({ ...f, timezone: tzSuggestion }));
                  setTzSuggestion(null);
                }}
              >
                Apply
              </Btn>
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setTzSuggestion(null)}
              >
                Dismiss
              </button>
            </div>
          ) : null}
          <div className="field-hint">
            Where the station broadcasts from. Sets the DJ’s {'{location}'} and the Open-Meteo
            weather it reads on air (current: {data.values?.weather?.locationName} @ {data.values?.weather?.lat}, {data.values?.weather?.lng}). Applies live.
          </div>
        </div>

        <div className="field">
          <Label>Weather units</Label>
          <Select
            value={form.weather.units}
            onValueChange={val =>
              setForm(f => ({
                ...f,
                weather: { ...f.weather, units: val === 'imperial' ? 'imperial' : 'metric' },
              }))
            }
          >
            <SelectTrigger className="w-[240px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="metric">Metric (°C)</SelectItem>
                <SelectItem value="imperial">Imperial (°F)</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <div className="field-hint">
            What the DJ announces on air (current: {data.values?.weather?.units === 'imperial' ? 'Imperial / °F' : 'Metric / °C'}). Applies live.
          </div>
        </div>
      </Card>

      <Card title="Timezone" sub="The station clock the DJ lives on">
        <div className="field">
          <Label>Station timezone</Label>
          <Select
            // Radix forbids empty-string item values, so Auto rides a sentinel.
            value={form.timezone || 'auto'}
            onValueChange={val =>
              setForm(f => ({ ...f, timezone: val === 'auto' ? '' : val }))
            }
          >
            <SelectTrigger className="w-[300px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="auto">Auto, server timezone ({serverTz})</SelectItem>
              </SelectGroup>
              {/* Fallback for a zone picked via the location search that isn't in
                  the enumerated groups — Radix needs an item to show it. */}
              {!tzInGroups ? (
                <SelectGroup>
                  <SelectItem value={form.timezone}>{form.timezone}</SelectItem>
                </SelectGroup>
              ) : null}
              {TZ_GROUPS.map(g => (
                <SelectGroup key={g.region}>
                  <SelectLabel>{g.region}</SelectLabel>
                  {g.zones.map(z => (
                    <SelectItem key={z} value={z}>{z}</SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
          {preview && (
            <div className="field-hint">
              Station clock: <span className="mono-num">{preview}</span> in {localeLabel}. If that doesn’t match your watch, pick your zone above.
            </div>
          )}
          <div className="field-hint">
            Drives everything the DJ derives from the clock: time-of-day moods, schedule slots,
            hourly time checks, festival dates. Applies live. Hourly archive filenames still follow
            the server’s TZ.
          </div>
        </div>
      </Card>

      <Card title="Localization" sub="Language variant and clock display">
        <div className="field">
          <Label>Station locale</Label>
          <Select
            value={form.locale}
            onValueChange={val =>
              setForm(f => ({ ...f, locale: normalizeStationLocale(val) }))
            }
          >
            <SelectTrigger className="w-[260px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="en-GB">English (UK), 24-hour</SelectItem>
                <SelectItem value="en-US">English (US), AM/PM</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <div className="field-hint">
            Sets station-facing display language and clock style. US English uses AM/PM for visible clock times. Applies live.
          </div>
        </div>
      </Card>

      <Card title="Booth Buddy" sub="the DJ-line mascot on the player">
        <div className="field">
          <Label>Show the Booth Sprite</Label>
          <div className="flex items-center gap-2">
            <Seg
              options={[
                { id: 'on', label: 'On' },
                { id: 'off', label: 'Off' },
              ]}
              value={data?.values?.ui?.boothBuddy === true ? 'on' : 'off'}
              onChange={id => { if (!busy) saveSettings({ ui: { boothBuddy: id === 'on' } }); }}
            />
          </div>
          <div className="field-hint">
            A small animated mascot that leads the DJ line on the listener player,
            reacting to what the DJ is doing — on-air, picking, or idle — and tap it
            for a reaction. When off, the line falls back to the classic ♪/◇ marker.
            Applies live, no restart.
          </div>
        </div>
      </Card>

      <SaveBar
        note="Station name, location, timezone, and locale apply live."
        busy={busy}
        onSave={save}
        saveLabel="Save station settings"
      />
    </>
  );
}

/* ── Theme ───────────────────────────────────────────────────────────── */

interface ThemeSectionProps {
  data: SettingsData;
  busy: boolean;
  saveSettings: SaveSettings;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
}

interface ThemeDef {
  id: string;
  name: string;
  description?: string;
  mode: 'light' | 'dark';
  tokens: Record<string, string>;
  // Set by the controller's /themes responses. Built-ins ship in the image and
  // can't be removed; only user themes (state/themes/*.json) show a Remove button.
  builtin?: boolean;
}

// Swatch columns shown per theme card — chosen to read the palette at a
// glance: paper, ink, accent, and the muted overlay (which doubles as the
// hover wash, so it telegraphs interactive state).
const SWATCH_KEYS = ['--bg', '--ink', '--accent', '--overlay'] as const;

// Each swatch is its own ref because useDynamicStyle wants a single element
// per call. The arbitrary token values can't go through Tailwind utilities
// (issue #50 bans the inline `style` prop), so we route them through the
// DOM-API hook instead.
function Swatch({ color }: { color?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useDynamicStyle(ref, { background: color || 'transparent' });
  return <span ref={ref} className="h-7 w-7" aria-hidden="true" />;
}

// The 7 themable tokens (mirrors controller THEME_TOKEN_KEYS) with human
// labels for the create form. Generated drafts and manual edits both fill these.
const THEME_TOKENS: { key: string; label: string }[] = [
  { key: '--bg', label: 'background' },
  { key: '--ink', label: 'text' },
  { key: '--muted', label: 'muted text' },
  { key: '--accent', label: 'accent' },
  { key: '--overlay', label: 'overlay' },
  { key: '--soft-border', label: 'border' },
  { key: '--field', label: 'field' },
];

// Create a custom theme from a description (AI-drafted) or by hand, then save it
// as state/themes/<id>.json via POST /themes. Tokens are editable before save so
// the operator reviews the palette first.
function ThemeCreator({
  adminFetch,
  onSaved,
}: {
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  onSaved: (themes: ThemeDef[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [mode, setMode] = useState<'light' | 'dark'>('dark');
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const applyDraft = (t: {
    name?: string;
    description?: string;
    mode?: 'light' | 'dark';
    tokens?: Record<string, string>;
  }) => {
    if (t.name && !name.trim()) setName(t.name);
    if (t.description) setDescription(t.description);
    if (t.mode) setMode(t.mode);
    if (t.tokens) setTokens(prev => ({ ...prev, ...t.tokens }));
  };

  const reset = () => {
    setName(''); setDescription(''); setTokens({}); setErr(null); setOpen(false);
  };

  const save = async () => {
    if (!name.trim() || saving) return;
    setSaving(true); setErr(null);
    try {
      const r = await adminFetch('/themes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), description: description.trim(), mode, tokens }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string; themes?: ThemeDef[] };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      onSaved(j.themes ?? []);
      notify.ok(`saved "${name.trim()}"`);
      reset();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <Btn sm tone="accent" onClick={() => setOpen(true)}>Create theme with AI</Btn>
    );
  }

  return (
    <div className="grid w-full basis-full gap-3 border border-ink p-3">
      <AiFill<{ name?: string; description?: string; mode?: 'light' | 'dark'; tokens?: Record<string, string> }>
        endpoint="/generate/theme"
        resultKey="theme"
        adminFetch={adminFetch}
        placeholder="e.g. a warm sepia newspaper, easy on the eyes"
        extra={{ mode }}
        onApply={applyDraft}
      />
      <div className="grid grid-cols-[1fr_auto] items-end gap-3">
        <div className="field">
          <Label>theme name</Label>
          <Input value={name} maxLength={60} onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)} placeholder="e.g. Sepia Press" />
        </div>
        <Seg
          value={mode}
          onChange={(v) => setMode(v as 'light' | 'dark')}
          options={[{ id: 'dark', label: 'Dark' }, { id: 'light', label: 'Light' }]}
        />
      </div>
      <div className="grid gap-1.5">
        {THEME_TOKENS.map(({ key, label }) => (
          <div key={key} className="grid grid-cols-[auto_5.5rem_1fr] items-center gap-2">
            <span className="inline-flex shrink-0 border border-ink"><Swatch color={tokens[key]} /></span>
            <span className="text-[11px] tracking-[0.12em] text-muted uppercase">{label}</span>
            <Input
              value={tokens[key] || ''}
              maxLength={100}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setTokens(prev => ({ ...prev, [key]: e.target.value }))}
              placeholder="#000000 or rgba(…)"
              className="font-mono text-[12px]"
            />
          </div>
        ))}
      </div>
      {err && <span className="text-[12px] text-[var(--danger)]">{err}</span>}
      <div className="flex gap-2">
        <Btn sm tone="accent" onClick={save} disabled={saving || !name.trim()}>
          {saving ? 'Saving…' : 'Save theme'}
        </Btn>
        <Btn sm onClick={reset} disabled={saving}>Cancel</Btn>
      </div>
    </div>
  );
}

function ThemeSection({ data, busy, saveSettings, adminFetch }: ThemeSectionProps) {
  const [themes, setThemes] = useState<ThemeDef[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<ThemeDef | null>(null);

  const activeId = data.values?.theme?.active;
  const PUBLIC_API = (process.env.NEXT_PUBLIC_API_URL as string | undefined) || '/api';

  // Theme list is public — fetch through the unauthenticated /themes endpoint
  // so a signed-out admin still sees swatches while signing in.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${PUBLIC_API}/themes`);
        if (!r.ok || cancelled) return;
        const j = (await r.json()) as { themes: ThemeDef[] };
        setThemes(j.themes);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [PUBLIC_API]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const r = await adminFetch('/themes/refresh', { method: 'POST' });
      const j = (await r.json().catch(() => ({}))) as { error?: string; themes?: ThemeDef[] };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      const next = j.themes ?? [];
      setThemes(next);
      notify.ok(`reloaded, ${next.length} theme${next.length === 1 ? '' : 's'}`);
    } catch (e) {
      notify.err(`Refresh failed: ${errorMessage(e)}`);
    } finally {
      setRefreshing(false);
    }
  };

  const choose = async (theme: ThemeDef) => {
    if (theme.id === activeId || busy) return;
    // Save through the existing settings flow. ThemeBootstrap's 30 s poll
    // would pick this up eventually, but the admin viewing this page wants
    // the swatch swap to feel instant — apply locally on click.
    applyTheme(theme);
    cacheTheme(theme);
    await saveSettings({ theme: { active: theme.id } });
  };

  // Delete a user theme's state/themes/<id>.json. If it was the active theme,
  // fall back to the first remaining one (built-ins lead the list) through the
  // normal selection flow so nothing points at a now-missing id.
  const remove = async (theme: ThemeDef) => {
    try {
      const r = await adminFetch(`/themes/${encodeURIComponent(theme.id)}`, { method: 'DELETE' });
      const j = (await r.json().catch(() => ({}))) as { error?: string; themes?: ThemeDef[] };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      const next = j.themes ?? [];
      setThemes(next);
      notify.ok(`removed "${theme.name}"`);
      if (theme.id === activeId && next[0]) await choose(next[0]);
    } catch (e) {
      notify.err(`Remove failed: ${errorMessage(e)}`);
    }
  };

  return (
    <>
      <SectionHeader
        eyebrow="theme"
        title="Station-wide visual theme."
        sub={<>Every listener and the admin UI render with this palette. Built-ins ship with the controller; drop custom JSONs in <code>state/themes/</code> and hit <em>Refresh</em>.</>}
        metrics={[
          {
            n: themes ? String(themes.length) : '—',
            l: 'themes',
            accent: true,
          },
        ]}
        manualHref="/manual/themes"
      />

      <Card title="Create theme" sub="state/themes/*.json">
        <div className="grid gap-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <Btn sm onClick={refresh} disabled={refreshing || busy}>
              {refreshing ? 'Refreshing…' : 'Refresh themes'}
            </Btn>
            <ThemeCreator adminFetch={adminFetch} onSaved={setThemes} />
          </div>
          <div className="field-hint">
            Describe a look above and we&apos;ll draft the palette, or drop a JSON
            theme file in <code>state/themes/</code> and click <em>Refresh</em>,
            no controller restart needed. The folder includes a
            <code>README.md</code> with the format and the allowed token keys.
          </div>
        </div>
      </Card>

      <Card title="Picker" sub="active station theme">
        {error && (
          <div className="field-hint text-[var(--danger)]">
            Couldn’t load themes: {error}
          </div>
        )}
        {!themes && !error && (
          <div className="text-[13px] text-muted italic">loading…</div>
        )}
        {themes && (
          <div className="grid gap-2">
            {themes.map(t => {
              const isActive = t.id === activeId;
              return (
                <div key={t.id} className="flex items-stretch gap-2">
                  <button
                    type="button"
                    onClick={() => choose(t)}
                    disabled={busy}
                    className={cn(
                      'flex min-w-0 flex-1 items-center gap-3 border p-3 text-left disabled:cursor-not-allowed disabled:opacity-60',
                      isActive
                        ? 'border-vermilion bg-[var(--ink-softer)]'
                        : 'border-ink bg-bg hover:bg-[var(--overlay)]',
                    )}
                  >
                    <span className="inline-flex shrink-0 border border-ink" aria-hidden="true">
                      {SWATCH_KEYS.map(k => (
                        <Swatch key={k} color={t.tokens[k]} />
                      ))}
                    </span>
                    <div className="grid min-w-0 flex-1 gap-0.5">
                      <span className="text-[12px] font-bold tracking-[0.12em] uppercase">
                        {t.name}
                      </span>
                      <span className="text-[11px] leading-[1.4] text-muted">
                        {t.description || (t.mode === 'dark' ? 'Dark palette' : 'Light palette')}
                      </span>
                    </div>
                    {isActive && <Pill tone="accent" dot>active</Pill>}
                  </button>
                  {!t.builtin && (
                    <Btn
                      sm
                      tone="danger"
                      onClick={() => setConfirmRemove(t)}
                      disabled={busy}
                      title="Remove this custom theme"
                    >
                      Remove
                    </Btn>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <V3AlertDialog
        open={confirmRemove != null}
        onOpenChange={(o) => { if (!o) setConfirmRemove(null); }}
        title="Remove theme"
        description={
          confirmRemove
            ? `Remove the custom theme "${confirmRemove.name}"? This deletes state/themes/${confirmRemove.id}.json permanently.`
            : ''
        }
        confirmLabel="remove"
        danger
        onConfirm={() => { if (confirmRemove) remove(confirmRemove); setConfirmRemove(null); }}
      />
    </>
  );
}

/* ── Preview button ──────────────────────────────────────────────────── */

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
function PreviewButton({ path, adminFetch, label = 'Play' }: PreviewButtonProps) {
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

/* ── Jingles ─────────────────────────────────────────────────────────── */

interface JinglesSectionProps extends SectionProps {
  jingleText: string;
  setJingleText: (s: string) => void;
  createJingle: () => Promise<boolean>;
  uploadJingle: (file: File, label: string) => Promise<boolean>;
  onDelete: (filename: string | null) => void;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
}

function JinglesSection({
  data, form, setForm, busy, jingleText, setJingleText,
  createJingle, uploadJingle, saveSettings, onDelete, adminFetch,
}: JinglesSectionProps) {
  const ratioDirty = form.jingleRatio !== String(data.values?.jingleRatio);
  const jingles = data.jingles || [];
  const [modal, setModal] = useState<null | 'create' | 'import'>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importLabel, setImportLabel] = useState('');
  const importRef = useRef<HTMLInputElement>(null);
  const doImport = async () => {
    if (!importFile) return;
    const ok = await uploadJingle(importFile, importLabel);
    if (ok) {
      setImportFile(null);
      setImportLabel('');
      if (importRef.current) importRef.current.value = '';
      setModal(null);
    }
  };
  const doCreate = async () => {
    if (await createJingle()) setModal(null);
  };

  return (
    <>
      <SectionHeader
        eyebrow="jingles"
        title="Pre-recorded TTS station stingers."
        sub="A default station ident is generated on first boot; you can add your own here. The built-in ident can’t be deleted."
        metrics={[
          { n: String(jingles.length), l: 'files' },
          { n: String(data.values?.jingleRatio), l: 'ratio', accent: true },
        ]}
      />

      <Card title="Frequency" sub="needs mixer restart">
        <div className="field">
          <div className="flex items-center gap-2">
            <Label>Jingle ratio</Label>
            <Pill tone="ink">restart required</Pill>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <Input
              className="mono-num w-24"
              type="number"
              min={1}
              max={1000}
              value={form.jingleRatio}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setForm(f => ({ ...f, jingleRatio: e.target.value }))
              }
            />
            <span className="text-[12px] text-muted">music tracks per jingle</span>
            <Btn
              tone="solid"
              onClick={() => saveSettings({ jingleRatio: parseInt(form.jingleRatio, 10) })}
              disabled={busy || !ratioDirty}
            >
              Save · needs restart
            </Btn>
          </div>
          <div className="field-hint">
            1 jingle every N music tracks (current: {data.values?.jingleRatio}). Restart the mixer from the danger zone to apply.
          </div>
        </div>
      </Card>

      <Card
        title="Jingles"
        sub={`${jingles.length} file${jingles.length === 1 ? '' : 's'}`}
        right={
          <>
            <Btn sm tone="accent" onClick={() => setModal('create')} disabled={busy}>
              + Create
            </Btn>
            <Btn sm tone="solid" onClick={() => setModal('import')} disabled={busy}>
              Import
            </Btn>
          </>
        }
      >
        {jingles.length === 0 && (
          <div className="py-2 text-[12px] text-muted italic">
            none yet
          </div>
        )}
        {jingles.map(j => (
          <div
            key={j.filename}
            className="flex items-start gap-3 border-b border-dashed border-separator-strong py-3"
          >
            <div className="min-w-0 flex-1">
              <div className="text-[13px] break-words text-ink">{j.text}</div>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <span className="caption">{j.filename}</span>
                <span className="caption">{fmtSize(j.size)}</span>
                {j.createdAt && (
                  <span className="caption">{new Date(j.createdAt).toLocaleString('en-GB')}</span>
                )}
                {j.builtin && <Pill tone="accent">builtin</Pill>}
                {j.source === 'upload' && <Pill tone="ink">uploaded</Pill>}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <PreviewButton
                path={`/jingles/${encodeURIComponent(j.filename)}/audio`}
                adminFetch={adminFetch}
              />
              <Btn
                sm
                tone="danger"
                onClick={() => onDelete(j.filename)}
                disabled={busy || j.builtin}
                title={j.builtin ? "Can't delete the built-in ident" : 'Delete this jingle'}
              >
                Delete
              </Btn>
            </div>
          </div>
        ))}
      </Card>

      <Modal
        open={modal === 'create'}
        onOpenChange={(o) => { if (!o) setModal(null); }}
        title="Create jingle"
        sub="rendered via Piper TTS"
        footer={
          <>
            <Btn onClick={() => setModal(null)}>Cancel</Btn>
            <Btn tone="accent" onClick={doCreate} disabled={busy || !jingleText.trim()}>
              {busy ? 'Generating…' : 'Create jingle'}
            </Btn>
          </>
        }
      >
        <div className="field">
          <Label>Jingle text</Label>
          <Textarea
            rows={3}
            value={jingleText}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setJingleText(e.target.value)}
            placeholder='e.g. "You are listening to SUB slash WAVE. Requests open all night."'
          />
          <div className="field-hint">{jingleText.length}/500 chars · Piper TTS</div>
        </div>
      </Modal>

      <Modal
        open={modal === 'import'}
        onOpenChange={(o) => { if (!o) setModal(null); }}
        title="Import jingle"
        sub="bring your own mp3 / wav"
        footer={
          <>
            <Btn onClick={() => setModal(null)}>Cancel</Btn>
            <Btn tone="accent" onClick={doImport} disabled={busy || !importFile}>
              {busy ? 'Importing…' : 'Import jingle'}
            </Btn>
          </>
        }
      >
        <div className="field">
          <Label>Audio file</Label>
          <input
            ref={importRef}
            type="file"
            accept="audio/*,.mp3,.wav,.ogg,.flac,.m4a,.aac,.opus"
            onChange={(e: ChangeEvent<HTMLInputElement>) => setImportFile(e.target.files?.[0] ?? null)}
            className="hidden"
          />
          <div className="flex flex-wrap items-center gap-2.5">
            <Btn tone="solid" onClick={() => importRef.current?.click()} disabled={busy}>
              {importFile ? 'Change file…' : 'Choose audio file…'}
            </Btn>
            {importFile && (
              <span className="text-[12px] text-ink">{importFile.name}</span>
            )}
          </div>
          <div className="field-hint">
            mp3, wav, ogg, flac, m4a, aac or opus · up to 25 MB · converted and level-matched on import
          </div>
        </div>
        <div className="field mt-3.5">
          <Label>Label (optional)</Label>
          <Input
            value={importLabel}
            maxLength={200}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setImportLabel(e.target.value)}
            placeholder="shown in the list, defaults to the file name"
          />
        </div>
      </Modal>
    </>
  );
}

/* ── Sound effects ───────────────────────────────────────────────────── */

interface SfxSectionProps {
  sfxData: SfxData | null;
  sfxForm: SfxForm;
  setSfxForm: (updater: (f: SfxForm) => SfxForm) => void;
  busy: boolean;
  createSfx: () => Promise<boolean>;
  uploadSfx: (file: File, name: string, description: string) => Promise<boolean>;
  onDelete: (name: string | null) => void;
  data: SettingsData | null;
  saveSettings: SaveSettings;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
}

function SfxSection({ sfxData, sfxForm, setSfxForm, busy, createSfx, uploadSfx, onDelete, data, saveSettings, adminFetch }: SfxSectionProps) {
  // Hooks must run before the early "loading…" return — keep them at the top.
  const [modal, setModal] = useState<null | 'create' | 'import'>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importName, setImportName] = useState('');
  const [importDesc, setImportDesc] = useState('');
  const importRef = useRef<HTMLInputElement>(null);
  const doImport = async () => {
    if (!importFile || !importName.trim()) return;
    const ok = await uploadSfx(importFile, importName, importDesc);
    if (ok) {
      setImportFile(null);
      setImportName('');
      setImportDesc('');
      if (importRef.current) importRef.current.value = '';
      setModal(null);
    }
  };
  const doCreate = async () => {
    if (await createSfx()) setModal(null);
  };

  if (!sfxData) {
    return <div className="text-[13px] text-muted italic">loading…</div>;
  }
  const list = sfxData.sfx || [];
  const ready = !!sfxData.generatorReady;
  const enabled = data?.values?.sfx?.enabled !== false;

  return (
    <>
      <SectionHeader
        eyebrow="sound effects"
        title="Stingers the DJ agent plays under its voice."
        sub="The segment-director agent can garnish a spoken break with one of these effects, mixed beneath the voice. Built-in effects ship with the station; add your own by generating one from a text prompt (ElevenLabs) or importing an audio file."
        metrics={[{ n: String(list.length), l: 'effects', accent: true }]}
      />

      <Card title="Sound effects" sub="whether the DJ agent uses stingers at all">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[13px] font-bold">Enable sound effects</div>
            <div className="mt-0.5 max-w-[480px] text-[11px] leading-[1.5] text-muted">
              When off, the segment-director agent is never shown the effect catalogue and stops
              playing stingers under its voice. The library below is kept either way.
            </div>
          </div>
          <Seg
            accent
            value={enabled ? 'on' : 'off'}
            options={[
              { id: 'off', label: 'Off' },
              { id: 'on', label: 'On' },
            ]}
            onChange={v => { if (!busy) saveSettings({ sfx: { enabled: v === 'on' } }); }}
          />
        </div>
      </Card>

      {!ready && (
        <div className="card">
          <div className="card-body text-[12px] leading-[1.5] text-muted">
            <strong className="tracking-[0.12em] text-ink uppercase">
              ElevenLabs key not set
            </strong>
            <div className="mt-1">
              The built-in effects work without a key. An ElevenLabs API key is only needed to
              generate <em>new</em> effects below. Set <code>ELEVENLABS_API_KEY</code> in{' '}
              <code>.env</code> (or set the cloud TTS provider to ElevenLabs with a key
              entered), then restart the controller.
            </div>
          </div>
        </div>
      )}

      <Card
        title="Effect library"
        sub={`${list.length} effect${list.length === 1 ? '' : 's'}`}
        right={
          <>
            <Btn sm tone="accent" onClick={() => setModal('create')} disabled={busy}>
              + Create
            </Btn>
            <Btn sm tone="solid" onClick={() => setModal('import')} disabled={busy}>
              Import
            </Btn>
          </>
        }
      >
        {list.length === 0 && (
          <div className="py-2 text-[12px] text-muted italic">
            none yet
          </div>
        )}
        {list.map(s => (
          <div
            key={s.name}
            className="flex items-start gap-3 border-b border-dashed border-separator-strong py-3"
          >
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-bold text-ink">{s.name}</div>
              {s.description && (
                <div className="mt-0.5 text-[12px] break-words text-muted">
                  {s.description}
                </div>
              )}
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <span className="caption">{fmtSize(s.size)}</span>
                {s.durationSec && <span className="caption">{s.durationSec}s</span>}
                {s.builtin && <Pill tone="accent">builtin</Pill>}
                {s.source === 'upload' && <Pill tone="ink">uploaded</Pill>}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <PreviewButton
                path={`/sfx/${encodeURIComponent(s.name)}/audio`}
                adminFetch={adminFetch}
              />
              <Btn
                sm
                tone="danger"
                onClick={() => onDelete(s.name)}
                disabled={busy || s.builtin}
                title={s.builtin ? "Can't delete a built-in effect" : 'Delete this effect'}
              >
                Delete
              </Btn>
            </div>
          </div>
        ))}
      </Card>

      <Modal
        open={modal === 'create'}
        onOpenChange={(o) => { if (!o) setModal(null); }}
        title="Create sound effect"
        sub="rendered via ElevenLabs"
        footer={
          <>
            <Btn onClick={() => setModal(null)}>Cancel</Btn>
            <Btn
              tone="accent"
              onClick={doCreate}
              disabled={busy || !ready || !sfxForm.name.trim() || !sfxForm.prompt.trim()}
            >
              {busy ? 'Generating…' : 'Create sound effect'}
            </Btn>
          </>
        }
      >
        {!ready && (
          <div className="field-hint mb-3.5">
            An ElevenLabs API key is required to generate effects. Set <code>ELEVENLABS_API_KEY</code>{' '}
            and restart the controller, or use Import instead.
          </div>
        )}
        <div className="field">
          <Label>Name</Label>
          <Input
            value={sfxForm.name}
            maxLength={60}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setSfxForm(f => ({ ...f, name: e.target.value }))}
            placeholder="e.g. record-scratch"
            className="max-w-[280px]"
          />
          <div className="field-hint">A short slug the agent references: letters, numbers and dashes.</div>
        </div>
        <div className="field mt-3.5">
          <Label>Description</Label>
          <Input
            value={sfxForm.description}
            maxLength={200}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setSfxForm(f => ({ ...f, description: e.target.value }))}
            placeholder="when the agent should reach for this effect"
          />
          <div className="field-hint">The agent reads this to decide when the effect fits a line.</div>
        </div>
        <div className="field mt-3.5">
          <Label>Generation prompt</Label>
          <Textarea
            rows={2}
            value={sfxForm.prompt}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setSfxForm(f => ({ ...f, prompt: e.target.value }))}
            placeholder='e.g. "abrupt vinyl record scratch, short and sharp"'
          />
          <div className="field-hint">{sfxForm.prompt.length}/500 chars. Describe the sound for ElevenLabs.</div>
        </div>
        <div className="field mt-3.5">
          <Label>Duration (optional)</Label>
          <div className="flex items-center gap-2">
            <Input
              className="mono-num w-28"
              type="number"
              step={0.5}
              min={0.5}
              max={22}
              value={sfxForm.durationSec}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setSfxForm(f => ({ ...f, durationSec: e.target.value }))}
              placeholder="auto"
            />
            <span className="text-[12px] text-muted">sec · 0.5–22, blank lets the model decide</span>
          </div>
        </div>
      </Modal>

      <Modal
        open={modal === 'import'}
        onOpenChange={(o) => { if (!o) setModal(null); }}
        title="Import sound effect"
        sub="bring your own mp3 / wav, no ElevenLabs key needed"
        footer={
          <>
            <Btn onClick={() => setModal(null)}>Cancel</Btn>
            <Btn
              tone="accent"
              onClick={doImport}
              disabled={busy || !importFile || !importName.trim()}
            >
              {busy ? 'Importing…' : 'Import sound effect'}
            </Btn>
          </>
        }
      >
        <div className="field">
          <Label>Name</Label>
          <Input
            value={importName}
            maxLength={60}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setImportName(e.target.value)}
            placeholder="e.g. my-stinger"
            className="max-w-[280px]"
          />
          <div className="field-hint">A short slug the agent references: letters, numbers and dashes.</div>
        </div>
        <div className="field mt-3.5">
          <Label>Description</Label>
          <Input
            value={importDesc}
            maxLength={200}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setImportDesc(e.target.value)}
            placeholder="when the agent should reach for this effect"
          />
          <div className="field-hint">The agent reads this to decide when the effect fits a line.</div>
        </div>
        <div className="field mt-3.5">
          <Label>Audio file</Label>
          <input
            ref={importRef}
            type="file"
            accept="audio/*,.mp3,.wav,.ogg,.flac,.m4a,.aac,.opus"
            onChange={(e: ChangeEvent<HTMLInputElement>) => setImportFile(e.target.files?.[0] ?? null)}
            className="hidden"
          />
          <div className="flex flex-wrap items-center gap-2.5">
            <Btn tone="solid" onClick={() => importRef.current?.click()} disabled={busy}>
              {importFile ? 'Change file…' : 'Choose audio file…'}
            </Btn>
            {importFile && <span className="text-[12px] text-ink">{importFile.name}</span>}
          </div>
          <div className="field-hint">mp3, wav, ogg, flac, m4a, aac or opus · up to 25 MB · converted to MP3 on import</div>
        </div>
      </Modal>
    </>
  );
}

/* ── Scrobbling ──────────────────────────────────────────────────────── */

interface ScrobbleSectionProps extends SectionProps {
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  refresh: () => void;
}

function ScrobbleSection({ data, form, setForm, busy, saveSettings, adminFetch, refresh }: ScrobbleSectionProps) {
  const lf = form.scrobble.lastfm;
  const lb = form.scrobble.listenbrainz;
  const savedLf = data.values?.scrobble?.lastfm || {};
  const savedLb = data.values?.scrobble?.listenbrainz || {};

  // Treat 'set' as "stored — leave the input empty unless the operator types
  // something new". The controller ignores 'set' on POST so a round-trip
  // won't blank the secret.
  const inputValue = (v: string) => (v === 'set' ? '' : v);
  const placeholder = (v: string, fallback: string) =>
    v === 'set' ? '•••••• (on file)' : fallback;
  const env = (data.env || {}) as Record<string, unknown>;
  const lfApiKeySet = lf.apiKey === 'set' || !!env.LASTFM_API_KEY;
  const lfApiSecretSet = lf.apiSecret === 'set' || !!env.LASTFM_API_SECRET;
  const lfSessionSet = lf.sessionKey === 'set' || !!env.LASTFM_SESSION_KEY;
  const lbTokenSet = lb.userToken === 'set' || !!env.LISTENBRAINZ_USER_TOKEN;
  const lfReady = lf.enabled && lfApiKeySet && lfApiSecretSet && lfSessionSet;
  const lbReady = lb.enabled && lbTokenSet;

  // "Connect to Last.fm" flow — replaces the CLI session-key dance. Needs the
  // API key + secret saved first (the backend reads them from settings/env).
  const canConnect = lfApiKeySet && lfApiSecretSet;
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const saveLastfm = () => {
    const patch: Partial<ScrobbleLastfmForm> = {
      enabled: lf.enabled,
      username: lf.username,
    };
    if (lf.apiKey && lf.apiKey !== 'set') patch.apiKey = lf.apiKey;
    if (lf.apiSecret && lf.apiSecret !== 'set') patch.apiSecret = lf.apiSecret;
    if (lf.sessionKey && lf.sessionKey !== 'set') patch.sessionKey = lf.sessionKey;
    saveSettings({ scrobble: { lastfm: patch } });
  };
  const saveListenbrainz = () => {
    const patch: Partial<ScrobbleListenbrainzForm> = {
      enabled: lb.enabled,
      username: lb.username,
      baseUrl: lb.baseUrl,
    };
    if (lb.userToken && lb.userToken !== 'set') patch.userToken = lb.userToken;
    saveSettings({ scrobble: { listenbrainz: patch } });
  };

  const sendTest = async (provider: 'lastfm' | 'listenbrainz') => {
    try {
      const r = await adminFetch('/scrobble/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        ok?: boolean; message?: string; error?: string;
      };
      const msg = j.message || j.error || (r.ok ? 'sent' : `failed (${r.status})`);
      if (r.ok && j.ok) notify.ok(msg);
      else notify.err(msg);
    } catch (e) {
      notify.err(errorMessage(e));
    }
  };

  // Step 1: ask the controller for an auth token + URL, open it for the user.
  const connectLastfm = async () => {
    setConnecting(true);
    try {
      const r = await adminFetch('/scrobble/lastfm/connect', { method: 'POST' });
      const j = (await r.json().catch(() => ({}))) as {
        ok?: boolean; token?: string; authUrl?: string; message?: string;
      };
      if (!r.ok || !j.ok || !j.authUrl || !j.token) {
        notify.err(j.message || `couldn't start (${r.status})`);
        return;
      }
      window.open(j.authUrl, '_blank', 'noopener,noreferrer');
      setAuthToken(j.token);
      notify.ok('Authorize in the Last.fm tab, then click “I authorized — finish”.');
    } catch (e) {
      notify.err(errorMessage(e));
    } finally {
      setConnecting(false);
    }
  };

  // Step 2: trade the authorized token for a session key; the controller saves
  // it and switches scrobbling on, so a refresh reflects "connected".
  const finishLastfm = async () => {
    if (!authToken) return;
    setConnecting(true);
    try {
      const r = await adminFetch('/scrobble/lastfm/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: authToken }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        ok?: boolean; username?: string; message?: string;
      };
      if (!r.ok || !j.ok) {
        notify.err(j.message || `couldn't finish (${r.status})`);
        return;
      }
      setAuthToken(null);
      notify.ok(`Connected to Last.fm${j.username ? ` as ${j.username}` : ''}.`);
      refresh();
    } catch (e) {
      notify.err(errorMessage(e));
    } finally {
      setConnecting(false);
    }
  };

  return (
    <>
      <SectionHeader
        eyebrow="scrobbling"
        title="Station-wide scrobbling to Last.fm and ListenBrainz."
        sub={<>
          Each backend is independent, pick one or both. Tracks scrobble only when at
          least one listener is tuned in to the stream. For Last.fm, enter your API key
          and secret, then hit <strong>Connect to Last.fm</strong> to authorize, no
          session-key wrangling. Nothing here leaves the controller.
        </>}
        metrics={[
          { n: lfReady ? 'on' : 'off', l: 'last.fm', accent: lfReady },
          { n: lbReady ? 'on' : 'off', l: 'listenbrainz', accent: lbReady },
        ]}
      />

      <Card
        title="Last.fm"
        sub={lfReady ? `scrobbling as ${savedLf.username || '(unknown)'}` : 'not connected'}
      >
        <div className="grid gap-[18px]">
          <div className="field">
            <div className="flex items-center gap-2">
              <Label>Enabled</Label>
              {lf.enabled !== !!savedLf.enabled && <Pill tone="accent" dot>unsaved</Pill>}
            </div>
            <Seg
              value={lf.enabled ? 'on' : 'off'}
              onChange={v =>
                setForm(f => ({
                  ...f,
                  scrobble: { ...f.scrobble, lastfm: { ...f.scrobble.lastfm, enabled: v === 'on' } },
                }))
              }
              options={[{ id: 'off', label: 'Off' }, { id: 'on', label: 'On' }]}
            />
            <div className="field-hint">
              When on, every track that plays with at least one listener tuned in is
              scrobbled to your Last.fm profile.
            </div>
          </div>

          <div className="field">
            <Label>API key</Label>
            <Input
              type="password"
              value={inputValue(lf.apiKey)}
              placeholder={placeholder(lf.apiKey, 'your last.fm API key')}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setForm(f => ({
                  ...f,
                  scrobble: { ...f.scrobble, lastfm: { ...f.scrobble.lastfm, apiKey: e.target.value } },
                }))
              }
              className="max-w-[360px]"
            />
            <div className="field-hint">
              Get one at <code>last.fm/api/account/create</code>. Falls back to
              <code> LASTFM_API_KEY</code> in <code>.env</code> when blank.
            </div>
          </div>

          <div className="field">
            <Label>API secret</Label>
            <Input
              type="password"
              value={inputValue(lf.apiSecret)}
              placeholder={placeholder(lf.apiSecret, 'your last.fm API secret')}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setForm(f => ({
                  ...f,
                  scrobble: { ...f.scrobble, lastfm: { ...f.scrobble.lastfm, apiSecret: e.target.value } },
                }))
              }
              className="max-w-[360px]"
            />
            <div className="field-hint">
              Paired with the API key. Falls back to <code>LASTFM_API_SECRET</code>.
            </div>
          </div>

          <div className="field">
            <Label>Authorize</Label>
            {!authToken ? (
              <Btn
                sm
                tone="accent"
                onClick={connectLastfm}
                disabled={busy || connecting || !canConnect}
              >
                {connecting ? 'Opening Last.fm…' : 'Connect to Last.fm'}
              </Btn>
            ) : (
              <div className="flex items-center gap-2">
                <Btn sm tone="accent" onClick={finishLastfm} disabled={busy || connecting}>
                  {connecting ? 'Finishing…' : 'I authorized — finish'}
                </Btn>
                <Btn sm onClick={() => setAuthToken(null)} disabled={connecting}>
                  Cancel
                </Btn>
              </div>
            )}
            <div className="field-hint">
              {!canConnect
                ? 'Enter your API key + secret above and Save first, then connect.'
                : !authToken
                  ? 'Opens Last.fm to grant access, then fills in your session key and switches scrobbling on — no terminal needed.'
                  : 'A Last.fm tab opened. Click “Yes, allow access” there, then finish here.'}
            </div>
          </div>

          <div className="field">
            <Label>Session key</Label>
            <Input
              type="password"
              value={inputValue(lf.sessionKey)}
              placeholder={placeholder(lf.sessionKey, 'long-lived session key')}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setForm(f => ({
                  ...f,
                  scrobble: { ...f.scrobble, lastfm: { ...f.scrobble.lastfm, sessionKey: e.target.value } },
                }))
              }
              className="max-w-[360px]"
            />
            <div className="field-hint">
              Easiest: hit <strong>Connect to Last.fm</strong> above and it fills this
              in for you. Advanced: paste one from
              <code> npm run lastfm-session</code>. Doesn&apos;t expire. Falls back to
              <code> LASTFM_SESSION_KEY</code>.
            </div>
          </div>

          <div className="field">
            <Label>Username (display)</Label>
            <Input
              value={lf.username}
              placeholder="your last.fm username"
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setForm(f => ({
                  ...f,
                  scrobble: { ...f.scrobble, lastfm: { ...f.scrobble.lastfm, username: e.target.value } },
                }))
              }
              className="max-w-[360px]"
            />
            <div className="field-hint">
              Cosmetic, used to label the &quot;scrobbling as&quot; status line above.
            </div>
          </div>
        </div>

        <SaveBar
          note="Applies on the next track transition, no restart needed."
          busy={busy}
          onSave={saveLastfm}
          saveLabel="Save Last.fm"
          extra={
            <Btn sm onClick={() => sendTest('lastfm')} disabled={busy || !lfReady}>
              Test
            </Btn>
          }
        />
      </Card>

      <Card
        title="ListenBrainz"
        sub={lbReady ? `submitting as ${savedLb.username || '(unknown)'}` : 'not connected'}
      >
        <div className="grid gap-[18px]">
          <div className="field">
            <div className="flex items-center gap-2">
              <Label>Enabled</Label>
              {lb.enabled !== !!savedLb.enabled && <Pill tone="accent" dot>unsaved</Pill>}
            </div>
            <Seg
              value={lb.enabled ? 'on' : 'off'}
              onChange={v =>
                setForm(f => ({
                  ...f,
                  scrobble: {
                    ...f.scrobble,
                    listenbrainz: { ...f.scrobble.listenbrainz, enabled: v === 'on' },
                  },
                }))
              }
              options={[{ id: 'off', label: 'Off' }, { id: 'on', label: 'On' }]}
            />
            <div className="field-hint">
              ListenBrainz is the open-source alternative to Last.fm, with the same listener gate
              and eligibility rules.
            </div>
          </div>

          <div className="field">
            <Label>API base URL</Label>
            <Input
              type="url"
              value={lb.baseUrl}
              placeholder="https://api.listenbrainz.org/1"
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setForm(f => ({
                  ...f,
                  scrobble: {
                    ...f.scrobble,
                    listenbrainz: { ...f.scrobble.listenbrainz, baseUrl: e.target.value },
                  },
                }))
              }
              className="max-w-[360px]"
            />
            <div className="field-hint">
              Leave blank for listenbrainz.org. For self-hosted LB-compatible scrobblers, use the
              API root (e.g. <code>http://koito:4110/apis/listenbrainz/1</code>). Overrides via{' '}
              <code>LISTENBRAINZ_API_URL</code> env when set.
            </div>
          </div>

          <div className="field">
            <Label>User token</Label>
            <Input
              type="password"
              value={inputValue(lb.userToken)}
              placeholder={placeholder(lb.userToken, 'your listenbrainz user token')}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setForm(f => ({
                  ...f,
                  scrobble: {
                    ...f.scrobble,
                    listenbrainz: { ...f.scrobble.listenbrainz, userToken: e.target.value },
                  },
                }))
              }
              className="max-w-[360px]"
            />
            <div className="field-hint">
              Copy from <code>listenbrainz.org/profile</code>. Falls back to
              <code> LISTENBRAINZ_USER_TOKEN</code>.
            </div>
          </div>

          <div className="field">
            <Label>Username (display)</Label>
            <Input
              value={lb.username}
              placeholder="your listenbrainz username"
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setForm(f => ({
                  ...f,
                  scrobble: {
                    ...f.scrobble,
                    listenbrainz: { ...f.scrobble.listenbrainz, username: e.target.value },
                  },
                }))
              }
              className="max-w-[360px]"
            />
            <div className="field-hint">Cosmetic only.</div>
          </div>
        </div>

        <SaveBar
          note="Applies on the next track transition, no restart needed."
          busy={busy}
          onSave={saveListenbrainz}
          saveLabel="Save ListenBrainz"
          extra={
            <Btn sm onClick={() => sendTest('listenbrainz')} disabled={busy || !lbReady}>
              Test
            </Btn>
          }
        />
      </Card>
    </>
  );
}
