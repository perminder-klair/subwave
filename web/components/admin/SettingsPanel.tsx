'use client';

import type { ChangeEvent } from 'react';
import { useEffect, useState } from 'react';
import { notify, errorMessage } from '../../lib/notify';
import { normalizeStationLocale } from '../../lib/format';
import { useAdminAuth } from '../../lib/adminAuth';
import { V3AlertDialog } from '../ui/alert-dialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '../ui/select';
import { Card, Btn, Pill, Seg } from './ui';
import { cn } from '../../lib/cn';
import ArchivesPanel from './ArchivesPanel';
import BackupPanel from './BackupPanel';
import FestivalsSection from './FestivalsSection';
import {
  Radio, Palette, Cpu, Mic, Library, Search, Music, AudioLines,
  Activity, Archive, Save, AlertTriangle, CalendarDays, Heart,
} from 'lucide-react';
import {
  SectionHeader, ELEVENLABS_VS_DEFAULTS,
  type FormState, type FormUpdater, type SettingsData, type SaveSettings,
  type SfxData, type SfxForm, type JingleImportFailure, type JingleImportResult,
  type LoudnessSource, type LlmForm, type LlmFallbackForm,
} from './settings/shared';
import { TtsSection } from './settings/TtsSection';
import { LlmSection } from './settings/LlmSection';
import { SearchSection } from './settings/SearchSection';
import { LibrarySection } from './settings/LibrarySection';
import { StationSection } from './settings/StationSection';
import { ThemeSection } from './settings/ThemeSection';
import { JinglesSection } from './settings/JinglesSection';
import { SfxSection } from './settings/SfxSection';
import { ScrobbleSection } from './settings/ScrobbleSection';
import { LikesSection } from './settings/LikesSection';

const SECTIONS = [
  { id: 'station',  label: 'Station', hint: 'name · location · locale', icon: Radio },
  { id: 'theme',    label: 'Skin & Themes', hint: 'player skin · palette', icon: Palette },
  { id: 'festivals', label: 'Festivals', hint: 'calendar · mood', icon: CalendarDays },
  { id: 'llm',      label: 'LLM provider', hint: 'model routing', icon: Cpu },
  { id: 'tts',      label: 'TTS voice', hint: 'default engine', icon: Mic },
  { id: 'library',  label: 'Library tagger', hint: 'embedding · propagation', icon: Library },
  { id: 'search',   label: 'Web search', hint: 'live-facts backend', icon: Search },
  { id: 'jingles',  label: 'Jingles', hint: 'stingers', icon: Music },
  { id: 'sfx',      label: 'Sound FX', hint: 'agent stingers', icon: AudioLines },
  { id: 'scrobble', label: 'Scrobbling', hint: 'last.fm · listenbrainz', icon: Activity },
  { id: 'likes',    label: 'Likes', hint: 'heart button · navidrome stars', icon: Heart },
  { id: 'archives', label: 'Archives', hint: 'hourly recordings', icon: Archive },
  { id: 'backup',   label: 'Backup', hint: 'export · restore', icon: Save },
  { id: 'danger',   label: 'Danger zone', hint: 'broadcast control', icon: AlertTriangle },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

// Keep in sync with MP3_BITRATES in controller/src/settings.ts — radio.liq
// has a literal `%mp3(bitrate=…)` branch per value, so this set is fixed.
const MP3_BITRATES = [64, 96, 128, 160, 192, 320] as const;
// Keep in sync with OPUS_BITRATES / AAC_BITRATES in controller/src/settings.ts.
const OPUS_BITRATES = [96, 128, 192, 256, 320] as const;
const AAC_BITRATES = [128, 192, 256] as const;

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

  // Deep-link: /admin/settings?section=archives opens that rail directly. The
  // old standalone /admin/{archives,backup} routes redirect here, so existing
  // bookmarks keep working after the move into Settings. (Webhooks moved on to
  // its own tab under /admin/connect?tab=webhooks.)
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
        enabled: v.archive?.enabled ?? false,
        bitrate: String(v.archive?.bitrate ?? 128),
        retentionDays: String(v.archive?.retentionDays ?? 0),
      },
      stream: {
        opusEnabled: v.stream?.opusEnabled ?? true,
        opusBitrate: String(v.stream?.opusBitrate ?? 96),
        flacEnabled: v.stream?.flacEnabled ?? false,
        aacEnabled: v.stream?.aacEnabled ?? false,
        aacBitrate: String(v.stream?.aacBitrate ?? 192),
        bitrate: String(v.stream?.bitrate ?? 192),
        oggIcyMetadata: v.stream?.oggIcyMetadata ?? true,
        idleWhenEmpty: v.stream?.idleWhenEmpty ?? false,
        idleAfterMinutes: String(v.stream?.idleAfterMinutes ?? 10),
      },
      loudness: {
        targetLufs: String(v.loudness?.targetLufs ?? -14),
        maxBoostDb: String(v.loudness?.maxBoostDb ?? 6),
        source: v.loudness?.source ?? 'replaygain-then-measured',
      },
      station: v.station ?? '',
      stationDescription: v.stationDescription ?? '',
      timezone: v.timezone ?? '',
      locale: normalizeStationLocale(v.locale),
      kokoroLang: v.tts?.kokoro?.lang ?? '',
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
          voiceStability: typeof v.tts?.cloud?.voiceStability === 'number' ? v.tts.cloud.voiceStability : ELEVENLABS_VS_DEFAULTS.voiceStability,
          voiceStyle: typeof v.tts?.cloud?.voiceStyle === 'number' ? v.tts.cloud.voiceStyle : ELEVENLABS_VS_DEFAULTS.voiceStyle,
          voiceSimilarityBoost: typeof v.tts?.cloud?.voiceSimilarityBoost === 'number' ? v.tts.cloud.voiceSimilarityBoost : ELEVENLABS_VS_DEFAULTS.voiceSimilarityBoost,
          voiceUseSpeakerBoost: typeof v.tts?.cloud?.voiceUseSpeakerBoost === 'boolean' ? v.tts.cloud.voiceUseSpeakerBoost : ELEVENLABS_VS_DEFAULTS.voiceUseSpeakerBoost,
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
        // Operator speech corrections — hydrate to clean {from, to} rows.
        corrections: (v.tts?.corrections || []).map(c => ({ from: c.from ?? '', to: c.to ?? '' })),
      },
      llm: {
        provider: v.llm?.provider ?? 'ollama',
        model: v.llm?.model ?? '',
        ollamaUrl: v.llm?.ollamaUrl ?? '',
        numCtx: typeof v.llm?.numCtx === 'number' ? v.llm.numCtx : 16384,
        repeatPenalty: typeof v.llm?.repeatPenalty === 'number' ? v.llm.repeatPenalty : 1.15,
        // Per-provider base URLs. Migrate from legacy single baseUrl on first load:
        // if the server has already stored providerBaseUrls use that; otherwise seed
        // the current provider's slot from the old baseUrl field so no URL is lost.
        providerBaseUrls: (() => {
          const llmAny = v.llm as (Partial<LlmForm> & { baseUrl?: string; providerBaseUrls?: Record<string, string> }) | undefined;
          const stored = llmAny?.providerBaseUrls;
          if (stored && typeof stored === 'object') return { ...stored };
          const legacy = llmAny?.baseUrl ?? '';
          const prov = llmAny?.provider ?? 'ollama';
          return legacy ? { [prov]: legacy } : {};
        })(),
        reasoning: !!v.llm?.reasoning,
        toolChoice: v.llm?.toolChoice === 'auto' ? 'auto' : 'required',
        pickerAgent: !!v.llm?.pickerAgent,
        noRepeatWindow: String(typeof v.llm?.noRepeatWindow === 'number' ? v.llm.noRepeatWindow : 100),
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
          repeatPenalty: typeof v.llm?.fallback?.repeatPenalty === 'number' ? v.llm.fallback.repeatPenalty : 1.15,
          providerBaseUrls: (() => {
            const fbAny = v.llm?.fallback as (LlmFallbackForm & { baseUrl?: string; providerBaseUrls?: Record<string, string> }) | undefined;
            const stored = fbAny?.providerBaseUrls;
            if (stored && typeof stored === 'object') return { ...stored };
            const legacy = fbAny?.baseUrl ?? '';
            const prov = fbAny?.provider ?? 'ollama';
            return legacy ? { [prov]: legacy } : {};
          })(),
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
        providerBaseUrls: (() => {
          const stored = (v.embedding as { providerBaseUrls?: Record<string, string> })?.providerBaseUrls;
          if (stored && typeof stored === 'object') return { ...stored };
          // Legacy migration keys by the EFFECTIVE provider (own, else the chat
          // provider — the embedding leg inherits it when its own is empty), the
          // same key LibrarySection reads and writes.
          const legacy = v.embedding?.baseUrl ?? '';
          const prov = v.embedding?.provider || v.llm?.provider || '';
          return legacy && prov ? { [prov]: legacy } : {};
        })(),
        ollamaUrl: v.embedding?.ollamaUrl ?? '',
        seedCount: String(v.embedding?.seedCount ?? 0),
        knnNeighbours: String(v.embedding?.knnNeighbours ?? 10),
        moodVoteThreshold: String(v.embedding?.moodVoteThreshold ?? 0.4),
        confidenceThreshold: String(v.embedding?.confidenceThreshold ?? 0.35),
        maxActiveLearningRounds: String(v.embedding?.maxActiveLearningRounds ?? 3),
        audioFusionWeight: String(v.embedding?.audioFusionWeight ?? 0.5),
        batchSize: String(v.embedding?.batchSize ?? 25),
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
      likes: {
        enabled: v.likes?.enabled ?? true,
        starInNavidrome: v.likes?.starInNavidrome ?? true,
        influenceDj: !!v.likes?.influenceDj,
        maxTracks: String(v.likes?.maxTracks ?? 10),
        windowDays: String(v.likes?.windowDays ?? 30),
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
  // Files upload one request at a time (not one multipart batch) so a big
  // import doesn't hold 40+ files in memory at once server-side and a single
  // bad file doesn't sink the rest. `label` only applies when importing a
  // single file — each file in a batch defaults to its own filename. An
  // abort via `signal` cancels the in-flight request too; the file it
  // interrupted counts as skipped, not failed.
  const uploadJingle = async (
    files: File[],
    label: string,
    opts: { onProgress?: (done: number, total: number) => void; signal?: AbortSignal } = {},
  ): Promise<JingleImportResult | null> => {
    if (busy || !files.length) return null;
    const { onProgress, signal } = opts;
    setBusy(true);
    const total = files.length;
    let ok = 0;
    let aborted = false;
    const failures: JingleImportFailure[] = [];
    try {
      for (const [i, file] of files.entries()) {
        if (signal?.aborted) { aborted = true; break; }
        try {
          const fd = new FormData();
          fd.append('file', file);
          if (total === 1 && label.trim()) fd.append('label', label.trim());
          const r = await adminFetch('/jingles/upload', { method: 'POST', body: fd, signal });
          const j = (await r.json().catch(() => ({}))) as { error?: string };
          if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
          ok++;
        } catch (e) {
          if (signal?.aborted) { aborted = true; break; }
          failures.push({ name: file.name, reason: errorMessage(e) });
        }
        onProgress?.(i + 1, total);
      }
      if (ok) await refresh();
      if (aborted) {
        notify.info(`Import stopped — ${ok}/${total} imported`);
      } else if (total === 1) {
        if (ok) notify.ok('jingle imported');
        else notify.err(`Jingle import failed: ${failures[0]?.reason}`);
      } else if (failures.length === 0) {
        notify.ok(`${ok} jingles imported`);
      } else {
        notify.err(`${ok}/${total} jingles imported · ${failures.length} failed`);
      }
      return { ok, total, failures, aborted };
    } finally { setBusy(false); }
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
        {pendingRestart && (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-x-3 gap-y-2 border border-vermilion bg-vermilion/10 px-4 py-3 text-[12px] text-ink"
          >
            <AlertTriangle className="size-4 shrink-0 text-vermilion" strokeWidth={2} aria-hidden />
            <span className="min-w-0 flex-1">
              <strong className="tracking-[0.08em] uppercase">Saved — not yet on air.</strong>{' '}
              The live stream is still running the previous mixer settings (bitrate, format,
              crossfade, jingle frequency). Restart the mixer to apply what you saved.
            </span>
            <Btn
              sm
              tone="danger"
              className="ml-auto"
              onClick={() => setConfirmRestart(true)}
              disabled={busy || !data}
            >
              Restart mixer to apply
            </Btn>
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
            {activeSection === 'likes' && (
              <LikesSection
                data={data} form={form} setForm={updateForm} busy={busy}
                saveSettings={saveSettings}
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

                  <div className="field">
                    <Label>Keep recordings for</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        className="mono-num w-28"
                        type="number"
                        min={0}
                        max={3650}
                        step={1}
                        value={form.archive.retentionDays}
                        onChange={(e: ChangeEvent<HTMLInputElement>) =>
                          setForm(f =>
                            f
                              ? { ...f, archive: { ...f.archive, retentionDays: e.target.value } }
                              : f,
                          )
                        }
                      />
                      <span className="text-[12px] text-muted">days</span>
                      <Btn
                        sm
                        onClick={() =>
                          saveSettings({
                            archive: { retentionDays: parseInt(form.archive.retentionDays, 10) },
                          })
                        }
                        disabled={busy}
                      >
                        Save retention
                      </Btn>
                    </div>
                    <div className="field-hint">
                      0 = keep forever (the default). With a window set, the hourly cleanup
                      deletes whole days of recordings once they age past it — at 128 kbps the
                      archive grows ~1.4 GB per day, so an unbounded archive eventually fills
                      the disk. Applies live, no restart.
                    </div>
                  </div>
                </div>
              </Card>
            )}
          </>
        )}
        {activeSection === 'festivals' && <FestivalsSection />}
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
              <Card title="Idle pause" sub="silence the programme when nobody is listening">
                <div className="field">
                  <Label>Pause when the room is empty</Label>
                  <div className="flex items-center gap-2">
                    <Seg
                      options={[
                        { id: 'on', label: 'On' },
                        { id: 'off', label: 'Off' },
                      ]}
                      value={form.stream.idleWhenEmpty ? 'on' : 'off'}
                      onChange={id =>
                        setForm(f =>
                          f ? { ...f, stream: { ...f.stream, idleWhenEmpty: id === 'on' } } : f,
                        )
                      }
                    />
                    <span className="text-[12px] text-muted">after</span>
                    <Input
                      className="mono-num w-24"
                      type="number"
                      step={1}
                      min={1}
                      max={1440}
                      value={form.stream.idleAfterMinutes}
                      onChange={(e: ChangeEvent<HTMLInputElement>) =>
                        setForm(f =>
                          f
                            ? { ...f, stream: { ...f.stream, idleAfterMinutes: e.target.value } }
                            : f,
                        )
                      }
                    />
                    <span className="text-[12px] text-muted">min</span>
                    <Btn
                      sm
                      onClick={() =>
                        saveSettings({
                          stream: {
                            idleWhenEmpty: form.stream.idleWhenEmpty,
                            idleAfterMinutes: parseInt(form.stream.idleAfterMinutes, 10),
                          },
                        })
                      }
                      disabled={busy}
                    >
                      Save
                    </Btn>
                  </div>
                  <div className="field-hint">
                    After this long with zero listeners the programme pauses mid-track and the DJ
                    goes quiet — no track pulls from Navidrome, no LLM or TTS work. The stream
                    mounts stay up, so any player (VLC, Sonos, the web player) connects normally;
                    playback resumes where it left off within a few seconds of the first listener
                    tuning in. Applies live — no mixer restart.
                  </div>
                </div>
              </Card>
            )}

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
                    <Label>Loudness source</Label>
                    <Select
                      value={form.loudness.source}
                      onValueChange={v =>
                        setForm(f =>
                          f
                            ? {
                                ...f,
                                loudness: { ...f.loudness, source: v as LoudnessSource },
                              }
                            : f,
                        )
                      }
                    >
                      <SelectTrigger className="w-64">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="replaygain-then-measured">
                          ReplayGain tags, then measured
                        </SelectItem>
                        <SelectItem value="replaygain">ReplayGain tags only</SelectItem>
                        <SelectItem value="measured">Measured (acoustic analysis)</SelectItem>
                      </SelectContent>
                    </Select>
                    <div className="field-hint">
                      Where each track&rsquo;s loudness figure comes from. ReplayGain tags (read
                      via Navidrome) are a whole-file stereo measurement — the most accurate when
                      your library carries them. Measured values come from this station&rsquo;s
                      acoustic analysis, which scans only the opening of each track. The default
                      prefers the tag and falls back to the measurement for untagged files.
                    </div>
                  </div>
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
                              source: form.loudness.source,
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
              <Card title="Ogg metadata" sub="ICY titles on /stream.opus + /stream.flac">
                <div className="field">
                  <div className="flex items-center gap-2">
                    <Label>Push ICY track titles on the Ogg mounts</Label>
                    <Pill tone="ink">restart required</Pill>
                  </div>
                  <div className="flex items-center gap-2">
                    <Seg
                      options={[
                        { id: 'on', label: 'On' },
                        { id: 'off', label: 'Off' },
                      ]}
                      value={form.stream.oggIcyMetadata ? 'on' : 'off'}
                      onChange={id =>
                        setForm(f =>
                          f ? { ...f, stream: { ...f.stream, oggIcyMetadata: id === 'on' } } : f,
                        )
                      }
                    />
                    <Btn
                      sm
                      onClick={() =>
                        saveSettings({ stream: { oggIcyMetadata: form.stream.oggIcyMetadata } })
                      }
                      disabled={busy}
                    >
                      Save
                    </Btn>
                  </div>
                  <div className="field-hint">
                    On by default. Sends each track&apos;s title out-of-band (ICY) on the Opus and
                    FLAC mounts, which most internet-radio players and Cast receivers need — they
                    read the in-band Ogg tags only once, at connect, and otherwise stay stuck on
                    the first title. Turn it <strong>off</strong> if your listeners use
                    foobar2000: it reads the in-band tags correctly, and the extra ICY channel
                    breaks its FLAC metadata display. The MP3 and AAC mounts always use ICY and
                    are unaffected either way.
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
