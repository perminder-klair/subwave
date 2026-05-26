'use client';

import type { ChangeEvent, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { m } from 'motion/react';
import { notify, errorMessage } from '../../lib/notify';
import { fmtSize } from '../../lib/format';
import { useAdminAuth } from '../../lib/adminAuth';
import { CLOUD_VOICES, CLOUD_MODELS } from '../../lib/cloudVoices';
import { V3AlertDialog } from '../ui/alert-dialog';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { Label } from '../ui/label';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectGroup,
} from '../ui/select';
import { Card, Btn, Pill, Eyebrow, Seg, Metric } from './ui';
import { cn } from '../../lib/cn';

const SECTIONS = [
  { id: 'tts',      label: 'TTS voice', hint: 'default engine' },
  { id: 'llm',      label: 'LLM provider', hint: 'model routing' },
  { id: 'search',   label: 'Web search', hint: 'live-facts backend' },
  { id: 'station',  label: 'Station', hint: 'name · location' },
  { id: 'jingles',  label: 'Jingles', hint: 'stingers' },
  { id: 'sfx',      label: 'Sound FX', hint: 'agent stingers' },
  { id: 'scrobble', label: 'Scrobbling', hint: 'last.fm · listenbrainz' },
  { id: 'danger',   label: 'Danger zone', hint: 'broadcast control' },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

// Cloud LLM providers read their key from this controller env var.
const LLM_ENV_VARS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  gateway: 'AI_GATEWAY_API_KEY',
};

const LLM_PROVIDER_LABELS: Record<string, string> = {
  ollama: 'Ollama — local homelab',
  'openai-compatible': 'OpenAI-compatible — self-hosted (llama.cpp, vLLM, LM Studio)',
  anthropic: 'Anthropic — Claude',
  openai: 'OpenAI — GPT',
  google: 'Google — Gemini',
  deepseek: 'DeepSeek',
  openrouter: 'OpenRouter — multi-vendor aggregator',
  gateway: 'Vercel AI Gateway — multi-vendor aggregator',
};

const llmProviderLabel = (id: string | undefined): string =>
  (id && LLM_PROVIDER_LABELS[id]) || id || '—';

const SEARCH_PROVIDER_LABELS: Record<string, string> = {
  duckduckgo: 'DuckDuckGo — free, no key',
  tavily: 'Tavily — paid web search',
};

const searchProviderLabel = (id: string | undefined): string =>
  (id && SEARCH_PROVIDER_LABELS[id]) || id || '—';

interface WeatherCfg {
  lat: string;
  lng: string;
  locationName: string;
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
}

interface LlmForm {
  provider: string;
  model: string;
  ollamaUrl: string;
  baseUrl: string;
  reasoning: boolean;
  pickerAgent: boolean;
  pauseWhenEmpty: boolean;
}

interface SearchForm {
  provider: string;
  apiKey: string;
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
}

interface ScrobbleForm {
  lastfm: ScrobbleLastfmForm;
  listenbrainz: ScrobbleListenbrainzForm;
}

interface ArchiveForm {
  enabled: boolean;
  bitrate: string;
}

// Keep in sync with ARCHIVE_BITRATES in controller/src/settings.ts — radio.liq
// has a literal `%mp3(bitrate=…)` branch per value, so this set is fixed.
const ARCHIVE_BITRATES = [64, 96, 128, 160, 192, 320] as const;

interface FormState {
  jingleRatio: string;
  crossfadeDuration: string;
  archive: ArchiveForm;
  station: string;
  weather: WeatherCfg;
  tts: TtsForm;
  llm: LlmForm;
  search: SearchForm;
  scrobble: ScrobbleForm;
}

interface JingleEntry {
  filename: string;
  text?: string;
  size?: number;
  createdAt?: string;
  builtin?: boolean;
}

interface SfxEntry {
  name: string;
  description?: string;
  size?: number;
  durationSec?: number;
  builtin?: boolean;
}

interface SfxData {
  sfx?: SfxEntry[];
  generatorReady?: boolean;
}

interface SettingsData {
  values?: {
    jingleRatio?: number;
    crossfadeDuration?: number;
    archive?: { enabled?: boolean; bitrate?: number };
    station?: string;
    weather?: { lat?: number; lng?: number; locationName?: string };
    tts?: {
      defaultEngine?: string;
      kokoro?: { voice?: string };
      chatterbox?: { referenceVoice?: string };
      pocketTts?: { voice?: string };
      cloud?: Partial<CloudTtsCfg>;
    };
    llm?: Partial<LlmForm>;
    search?: Partial<SearchForm>;
    sfx?: { enabled?: boolean };
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
    chatterboxVoiceDir?: string;
    pocketTtsVoices?: Array<{ id: string; label: string }>;
    cloudProviders?: string[];
  };
  llm?: {
    providers?: string[];
    active?: string;
  };
  search?: {
    providers?: string[];
  };
  defaults?: {
    search?: Partial<SearchForm>;
  };
  jingles?: JingleEntry[];
  env?: Record<string, unknown>;
  streamOnAir?: boolean;
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
  const [activeSection, setActiveSection] = useState<SectionId>('tts');
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

  useEffect(() => {
    if (!data?.values || form) return;
    const v = data.values;
    setForm({
      jingleRatio: String(v.jingleRatio ?? ''),
      crossfadeDuration: String(v.crossfadeDuration ?? ''),
      archive: {
        enabled: v.archive?.enabled ?? true,
        bitrate: String(v.archive?.bitrate ?? 128),
      },
      station: v.station ?? '',
      weather: {
        lat: String(v.weather?.lat ?? ''),
        lng: String(v.weather?.lng ?? ''),
        locationName: v.weather?.locationName ?? '',
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
      },
      llm: {
        provider: v.llm?.provider ?? 'ollama',
        model: v.llm?.model ?? '',
        ollamaUrl: v.llm?.ollamaUrl ?? '',
        baseUrl: v.llm?.baseUrl ?? '',
        reasoning: !!v.llm?.reasoning,
        pickerAgent: !!v.llm?.pickerAgent,
        pauseWhenEmpty: !!v.llm?.pauseWhenEmpty,
      },
      search: {
        provider: v.search?.provider ?? 'duckduckgo',
        // GET /settings returns the apiKey redacted to 'set' | '' — that
        // round-trips through POST harmlessly (settings.update ignores 'set').
        apiKey: v.search?.apiKey ?? '',
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
      notify.ok(j.requiresRestart ? 'saved — restart the mixer to apply' : 'saved');
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
      notify.ok('mixer restarting — give it a few seconds');
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
      notify.ok('stream stopped — station is off air');
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
      notify.ok('stream started — station is on air');
      await refresh();
    } catch (e) {
      notify.err(errorMessage(e));
    } finally { setBusy(false); }
  };

  const createJingle = async () => {
    if (!jingleText.trim() || busy) return;
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
    } catch (e) { notify.err(`Jingle creation failed: ${errorMessage(e)}`); }
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

  const createSfx = async () => {
    if (!sfxForm.name.trim() || !sfxForm.prompt.trim() || busy) return;
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
    } catch (e) { notify.err(`Sound effect creation failed: ${errorMessage(e)}`); }
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

  return (
    <div className="stack-mobile grid grid-cols-[240px_1fr] items-start gap-6">
      {/* Section rail */}
      <aside className="sticky top-6 grid gap-1">
        <span className="caption pb-2">settings</span>
        {SECTIONS.map(s => {
          const isActive = activeSection === s.id;
          return (
            <button
              key={s.id}
              onClick={() => setActiveSection(s.id)}
              className={cn(
                'grid cursor-pointer gap-1 border border-ink px-3 py-2.5 text-left font-[inherit]',
                isActive ? 'bg-ink text-bg' : 'bg-transparent text-ink',
              )}
            >
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
                saveSettings={saveSettings}
              />
            )}
            {activeSection === 'llm' && data.llm && (
              <LlmSection
                data={data} form={form} setForm={updateForm} busy={busy}
                saveSettings={saveSettings}
              />
            )}
            {activeSection === 'search' && (
              <SearchSection
                data={data} form={form} setForm={updateForm} busy={busy}
                saveSettings={saveSettings}
              />
            )}
            {activeSection === 'station' && (
              <StationSection
                data={data} form={form} setForm={updateForm} busy={busy}
                saveSettings={saveSettings}
              />
            )}
            {activeSection === 'jingles' && (
              <JinglesSection
                data={data} form={form} setForm={updateForm} busy={busy}
                jingleText={jingleText} setJingleText={setJingleText}
                createJingle={createJingle} saveSettings={saveSettings}
                onDelete={setConfirmDelete} adminFetch={adminFetch}
              />
            )}
            {activeSection === 'scrobble' && (
              <ScrobbleSection
                data={data} form={form} setForm={updateForm} busy={busy}
                saveSettings={saveSettings} adminFetch={adminFetch}
              />
            )}
          </>
          );
        })()}
        {activeSection === 'sfx' && (
          <SfxSection
            sfxData={sfxData} sfxForm={sfxForm} setSfxForm={setSfxForm}
            busy={busy} createSfx={createSfx} onDelete={setConfirmDeleteSfx}
            data={data} saveSettings={saveSettings} adminFetch={adminFetch}
          />
        )}
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
                    Saving flags a pending restart — apply it with the Mixer card below.
                  </div>
                </div>
              </Card>
            )}

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
                      CPU cost in the broadcast container — turn it off if you don't replay
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
                          {ARCHIVE_BITRATES.map(br => (
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
        description="Take the station off air? The Icecast mount disconnects — every current listener is dropped and new listeners get nothing until you start the stream again."
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
}

function SectionHeader({ eyebrow, title, sub, metrics }: SectionHeaderProps) {
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
    ? 'border-[var(--accent)] text-vermilion'
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
          present ? 'bg-vermilion' : 'bg-[var(--danger)]',
        )}
      />
      <div className="grid gap-0.5">
        <span className={cn('text-[11px] font-bold tracking-[0.12em] uppercase', toneClass)}>
          {present ? 'API key found in environment' : 'API key missing'}
        </span>
        <span className="text-[11px] leading-[1.5] text-muted">
          {present ? (
            <>The controller has <code>{envVar}</code> set — this provider is ready to use.</>
          ) : (
            <>
              Set <code>{envVar}</code> in <code>.env</code> and restart the controller.
              API keys are configured through the environment, not the admin UI.
            </>
          )}
        </span>
      </div>
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

function TtsSection({ data, form, setForm, busy, saveSettings }: SectionProps) {
  const engines = data.tts?.engines || ['piper'];
  const available = data.tts?.available || {};
  const ENGINE_LABELS: Record<string, string> = { piper: 'Piper', kokoro: 'Kokoro', chatterbox: 'Chatterbox', 'pocket-tts': 'PocketTTS', cloud: 'Cloud' };
  const engineOptions = engines.map(e => ({ id: e, label: ENGINE_LABELS[e] || e }));

  const save = () => saveSettings({
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
    },
  });

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

  const savedTts: any = data.values?.tts || {};
  const savedEngine: string = savedTts.defaultEngine || 'piper';
  const savedKokoroVoice: string = savedTts.kokoro?.voice || '';
  const savedChatterboxVoice: string = savedTts.chatterbox?.referenceVoice || '';
  const savedPocketTtsVoice: string = savedTts.pocketTts?.voice || '';
  const savedCloud: any = savedTts.cloud || {};
  const savedEngineLabel = ENGINE_LABELS[savedEngine] || savedEngine;
  const formEngineLabel = ENGINE_LABELS[form.tts.defaultEngine] || form.tts.defaultEngine;

  const ttsDirty =
    form.tts.defaultEngine !== savedEngine
    || (form.tts.kokoro?.voice || '') !== savedKokoroVoice
    || (form.tts.chatterbox?.referenceVoice || '') !== savedChatterboxVoice
    || (form.tts.pocketTts?.voice || '') !== savedPocketTtsVoice
    || form.tts.cloud.provider !== (savedCloud.provider || '')
    || (form.tts.cloud.model || '').trim() !== (savedCloud.model || '').trim()
    || (form.tts.cloud.voice || '').trim() !== (savedCloud.voice || '').trim()
    || (form.tts.cloud.baseUrl || '').trim() !== (savedCloud.baseUrl || '').trim();

  let activeDetail: ReactNode = null;
  if (savedEngine === 'piper') {
    activeDetail = <>Bundled — no key, no config. Always the safe fallback.</>;
  } else if (savedEngine === 'kokoro') {
    activeDetail = <>Voice <code>{savedKokoroVoice || '—'}</code>. Falls back to Piper if the model isn’t loaded.</>;
  } else if (savedEngine === 'chatterbox') {
    activeDetail = <>
      Reference <code>{savedChatterboxVoice || 'built-in'}</code> — voice cloning + paralinguistic tags. Falls back to Piper if the worker isn’t installed.
    </>;
  } else if (savedEngine === 'pocket-tts') {
    activeDetail = <>
      Voice <code>{savedPocketTtsVoice || 'alba'}</code> — CPU-only, ~6× real-time, multilingual built-in voices. Falls back to Piper if the worker isn’t installed.
    </>;
  } else if (savedEngine === 'cloud') {
    activeDetail = <>
      {savedCloud.provider || '—'} · model <code>{savedCloud.model || '—'}</code>
      {savedCloud.voice ? <> · voice <code>{savedCloud.voice}</code></> : null}
    </>;
  }
  const savedEngineMissing = available[savedEngine] === false;

  return (
    <>
      <SectionHeader
        eyebrow="tts voice"
        title="Pick a voice engine, then configure it."
        sub={<>
          Every spoken segment is voiced by the <strong>persona on air</strong> — set each
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
                {activeDetail} — {ttsDirty ? 'Your edits below aren’t live until you Save.' : 'This is the saved, running config.'}
                {savedEngineMissing && (
                  <span className="text-[var(--danger)]"> This engine isn’t installed in this build — segments fall back to Piper.</span>
                )}
              </span>
            </div>
          </div>

          <div className="field">
            <div className="flex items-center gap-2">
              <Label>Engine</Label>
              {ttsDirty && <Pill tone="accent" dot>unsaved</Pill>}
            </div>
            <Seg
              accent
              value={form.tts.defaultEngine}
              options={engineOptions}
              onChange={selectEngine}
            />
            <div className="field-hint">
              {ttsDirty
                ? <>Engine changed — hit “Save TTS settings” below to make <strong>{formEngineLabel}</strong> the new default.</>
                : <>The station default — renders jingles and is the fallback when a persona’s own engine fails. Per-segment voice still comes from the persona on air.</>}
            </div>
          </div>

        {form.tts.defaultEngine === 'piper' && (
          <div className="field mt-4">
            <div className="field-hint">
              Piper is bundled with the controller — fast, lightweight, and always
              available. Nothing to configure.
            </div>
          </div>
        )}

        {form.tts.defaultEngine === 'kokoro' && (
          <div className="field mt-4">
            <Label>Kokoro voice</Label>
            {available.kokoro === false && (
              <div className="field-hint text-[var(--danger)]">
                Kokoro is not installed in this build — it will fall back to Piper.
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
        )}

        {form.tts.defaultEngine === 'chatterbox' && (
          <div className="field mt-4">
            <Label>Chatterbox reference voice</Label>
            {available.chatterbox === false ? (
              <div className="field-hint text-[var(--danger)]">
                Chatterbox isn’t currently available — it lives in the optional{' '}
                <code>tts-heavy</code> sidecar. Start it with{' '}
                <code>docker compose --profile tts-heavy up -d</code>, or set{' '}
                <code>COMPOSE_PROFILES=tts-heavy</code> in your <code>.env</code> so it
                comes up automatically with the rest of the stack. (Legacy path: rebuild
                the controller image with <code>--build-arg WITH_CHATTERBOX=1</code>.)
                Until then this engine falls back to Piper.
              </div>
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
                  <code>state/chatterbox-voices/</code>
                  {' '}on the host and they’ll appear here on next reload. Personas can
                  override this on the Personas page.
                </div>
              </>
            ) : (
              <div className="field-hint">
                No reference voices found in{' '}
                <code>state/chatterbox-voices/</code>.
                The engine will use its built-in default voice. Drop a 5-second WAV into
                that directory to enable cloning.
              </div>
            )}
          </div>
        )}

        {form.tts.defaultEngine === 'pocket-tts' && (
          <div className="field mt-4">
            <Label>PocketTTS voice</Label>
            {available['pocket-tts'] === false ? (
              <div className="field-hint text-[var(--danger)]">
                PocketTTS isn’t currently available — it lives in the same optional{' '}
                <code>tts-heavy</code> sidecar as Chatterbox. Start it with{' '}
                <code>docker compose --profile tts-heavy up -d</code>, or set{' '}
                <code>COMPOSE_PROFILES=tts-heavy</code> in your <code>.env</code> so it
                comes up automatically with the rest of the stack. (Legacy path: rebuild
                the controller image with <code>--build-arg WITH_POCKETTTS=1</code>.)
                Until then this engine falls back to Piper.
              </div>
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
                      {data.tts?.pocketTtsVoices?.map(v => (
                        <SelectItem key={v.id} value={v.id}>{v.label} — {v.id}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <div className="field-hint">
                  100M-param CPU-only model from kyutai-labs. Voices speak English, French,
                  German, Italian, Spanish and Portuguese. Personas can override this on
                  the Personas page.
                </div>
              </>
            ) : (
              <div className="field-hint">This build reports no PocketTTS voices.</div>
            )}
          </div>
        )}

        {form.tts.defaultEngine === 'cloud' && (() => {
          const isCompat = form.tts.cloud.provider === 'openai-compatible';
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
                  controller container — use the host’s LAN or Tailscale IP, not
                  <code>127.0.0.1</code>.
                </div>
              </div>
            )}
            <div className="mt-3.5 grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-[18px]">
              <div className="field">
                <Label>Model</Label>
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
                />
                <div className="field-hint">
                  {isCompat
                    ? <>Model id exactly as the server reports it at <code>/v1/models</code> — required.</>
                    : <>e.g. “gpt-4o-mini-tts” (OpenAI) or “eleven_flash_v2_5” (ElevenLabs).</>}
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
                        Server-specific — Chatterbox cloning ref name, Qwen3
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
                        if (val !== '__custom__') {
                          setForm(f => ({ ...f, tts: { ...f.tts, cloud: { ...f.tts.cloud, voice: val } } }));
                        }
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
            {!isCompat && (
              <KeyStatus
                envVar={form.tts.cloud.provider === 'elevenlabs' ? 'ELEVENLABS_API_KEY' : 'OPENAI_API_KEY'}
                present={!!data.env?.[form.tts.cloud.provider === 'elevenlabs' ? 'ELEVENLABS_API_KEY' : 'OPENAI_API_KEY']}
              />
            )}
            {isCompat && (
              <div className="field-hint mt-3.5">
                Most self-hosted servers accept any non-empty API key — no env
                var required.
              </div>
            )}
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

function LlmSection({ data, form, setForm, busy, saveSettings }: SectionProps) {
  const save = () => saveSettings({
    llm: {
      provider: form.llm.provider,
      model: form.llm.model,
      ollamaUrl: form.llm.ollamaUrl,
      baseUrl: form.llm.baseUrl,
      reasoning: form.llm.reasoning,
      pickerAgent: form.llm.pickerAgent,
      pauseWhenEmpty: form.llm.pauseWhenEmpty,
    },
  });

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
        sub="Ollama runs on the homelab box and needs no key; the cloud providers are opt-in. Switching here reroutes every LLM call — no redeploy."
        metrics={[{ n: String((data.llm?.providers || []).length), l: 'providers' }]}
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
                  ? <>Model <code>{activeModel}</code> — every LLM call goes here. {llmDirty ? 'Your edits below aren’t live until you Save.' : 'This is the saved, running config.'}</>
                  : <>No model is set for this provider yet.</>}
              </span>
            </div>
          </div>

          <div className="field">
            <div className="flex items-center gap-2">
              <Label>Provider</Label>
              {llmDirty && <Pill tone="accent" dot>unsaved</Pill>}
            </div>
            <Select
              value={form.llm.provider}
              onValueChange={v => setForm(f => ({ ...f, llm: { ...f.llm, provider: v } }))}
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
              {llmDirty
                ? 'Provider changed — hit “Save LLM provider” below to route every call here.'
                : 'The provider every LLM call routes through. Switching reroutes instantly on save — no redeploy.'}
            </div>
          </div>

          <div className="field">
            <Label>Model</Label>
            <Input
              value={form.llm.model}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setForm(f => ({ ...f, llm: { ...f.llm, model: e.target.value } }))
              }
              placeholder={
                form.llm.provider === 'ollama'
                  ? 'nemotron-3-super:cloud'
                  : form.llm.provider === 'deepseek'
                    ? 'deepseek-v4-flash'
                    : form.llm.provider === 'openai-compatible'
                      ? 'Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf'
                      : 'model id'
              }
              className="max-w-[360px]"
            />
            <div className="field-hint">
              {form.llm.provider === 'ollama'
                ? 'Ollama model tag, e.g. “nemotron-3-super:cloud”. Leave blank for the default.'
                : form.llm.provider === 'gateway'
                  ? 'Gateway model id, e.g. “anthropic/claude-sonnet-4-5”.'
                  : form.llm.provider === 'openrouter'
                    ? 'OpenRouter model id, e.g. “google/gemini-2.5-flash”.'
                    : form.llm.provider === 'google'
                      ? 'Gemini model id, e.g. “gemini-2.5-flash”.'
                      : form.llm.provider === 'deepseek'
                        ? 'DeepSeek model id. Leave blank for the “deepseek-v4-flash” default.'
                        : form.llm.provider === 'openai-compatible'
                          ? 'Model id exactly as the server reports it at /v1/models — required.'
                          : 'Model id for the chosen provider — required.'}
            </div>
          </div>

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
                controller container — use the host’s LAN or Tailscale IP, not
                <code>127.0.0.1</code>.
              </div>
            </div>
          )}

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

          {LLM_ENV_VARS[form.llm.provider] && (
            <KeyStatus
              envVar={LLM_ENV_VARS[form.llm.provider]!}
              present={!!data.env?.[LLM_ENV_VARS[form.llm.provider]!]}
            />
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
              thinking knob — Ollama, openai-compatible (Qwen3), Gemini 2.5/3.x,
              OpenAI o-series and gpt-5, and Claude (adaptive thinking). DJ
              scripts and structured picks are short, and an uncapped thought
              chain just balloons latency and cost. Leave off unless you&apos;re
              running a model that genuinely needs it.
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
      </Card>

      <Card title="Next-track picker" sub="how the DJ chooses">
        <div className="grid grid-cols-[1fr_auto] items-center gap-4">
          <div>
            <div className="text-[13px] font-bold">Agentic picker</div>
            <div className="mt-0.5 max-w-[480px] text-[11px] leading-[1.5] text-muted">
              When on, the next-track picker is a tool-using agent that explores the library
              itself. Needs a model that handles multi-step tool calls well — leave off for
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
      </Card>

      <Card title="Idle behaviour" sub="when no one's listening">
        <div className="grid grid-cols-[1fr_auto] items-center gap-4">
          <div>
            <div className="text-[13px] font-bold">Pause DJ when empty</div>
            <div className="mt-0.5 max-w-[480px] text-[11px] leading-[1.5] text-muted">
              When on, the DJ stops making LLM calls — track picks, links, station
              IDs, hourly checks, segments and listener requests — whenever Icecast
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

      <SaveBar
        note={`Active model: ${data.llm?.active}. Applies to the next LLM call — no restart needed.`}
        busy={busy}
        onSave={save}
        saveLabel="Save LLM provider"
      />
    </>
  );
}

/* ── Web search ──────────────────────────────────────────────────────── */

function SearchSection({ data, form, setForm, busy, saveSettings }: SectionProps) {
  const save = () => saveSettings({
    search: {
      provider: form.search.provider,
      // Don't echo back 'set' — that's the redaction sentinel from getRedacted().
      // The controller's update() ignores it, but skipping it keeps the patch tidy.
      ...(form.search.apiKey && form.search.apiKey !== 'set'
        ? { apiKey: form.search.apiKey }
        : {}),
    },
  });

  const savedSearch = data.values?.search || {};
  const providers = data.search?.providers || ['duckduckgo', 'tavily'];
  const provider = form.search.provider;
  const searchDirty = provider !== savedSearch.provider
    || (provider === 'tavily'
        && form.search.apiKey
        && form.search.apiKey !== 'set'
        && form.search.apiKey !== (savedSearch.apiKey || ''));
  const tavilyKeySet = form.search.apiKey === 'set' || !!data.env?.SEARCH_API_KEY;

  return (
    <>
      <SectionHeader
        eyebrow="web search"
        title="Where the DJ gets live facts about the artist on air."
        sub={<>
          The segment director can air a single line of recent artist context between
          tracks — when the active backend returns something worth saying. DuckDuckGo
          is free and keyless; Tavily is paid but returns full web results. Switching
          here reroutes the next call — no restart.
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
                ? 'DuckDuckGo Instant Answer — free, no key. Useful for definitions and well-known entities; silent otherwise. The segment director treats silence as a valid outcome.'
                : 'Tavily — paid web search with full results and an answer summary. Needs an API key.'}
            </div>
          </div>

          {provider === 'tavily' && (
            <>
              <div className="field">
                <Label>Tavily API key</Label>
                <Input
                  type="password"
                  value={form.search.apiKey === 'set' ? '' : form.search.apiKey}
                  placeholder={form.search.apiKey === 'set' ? '•••••• (key on file)' : 'tvly-…'}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    setForm(f => ({ ...f, search: { ...f.search, apiKey: e.target.value } }))
                  }
                  className="max-w-[360px]"
                />
                <div className="field-hint">
                  Stored alongside the other admin settings. Falls back to
                  <code> SEARCH_API_KEY</code> in <code>.env</code> when blank — set
                  one or the other, not both.
                </div>
              </div>
              <KeyStatus envVar="SEARCH_API_KEY" present={tavilyKeySet} />
            </>
          )}
        </div>
      </Card>

      <SaveBar
        note="Applies to the next web-search call — no restart needed."
        busy={busy}
        onSave={save}
        saveLabel="Save web search"
      />
    </>
  );
}

/* ── Station ─────────────────────────────────────────────────────────── */

function StationSection({ data, form, setForm, busy, saveSettings }: SectionProps) {
  const save = () => saveSettings({
    station: form.station,
    weather: {
      lat: parseFloat(form.weather.lat),
      lng: parseFloat(form.weather.lng),
      locationName: form.weather.locationName,
    },
  });

  return (
    <>
      <SectionHeader
        eyebrow="station"
        title="How the DJ identifies this radio on air."
        sub="The station name is substituted into the DJ prompt as {station}. The location sets where the DJ thinks it broadcasts from and drives the Open-Meteo weather it reads on air. Both apply live — no mixer restart."
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
          <div className="flex flex-wrap gap-2">
            <Input
              placeholder="name"
              value={form.weather.locationName}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setForm(f => ({ ...f, weather: { ...f.weather, locationName: e.target.value } }))
              }
              className="w-[200px]"
            />
            <Input
              className="mono-num w-[132px]"
              type="number"
              step="any"
              placeholder="lat"
              value={form.weather.lat}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setForm(f => ({ ...f, weather: { ...f.weather, lat: e.target.value } }))
              }
            />
            <Input
              className="mono-num w-[132px]"
              type="number"
              step="any"
              placeholder="lng"
              value={form.weather.lng}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setForm(f => ({ ...f, weather: { ...f.weather, lng: e.target.value } }))
              }
            />
          </div>
          <div className="field-hint">
            Where the station broadcasts from — sets the DJ’s {'{location}'} and the Open-Meteo
            weather it reads on air (current: {data.values?.weather?.locationName} @ {data.values?.weather?.lat}, {data.values?.weather?.lng}). Applies live.
          </div>
        </div>
      </Card>

      <SaveBar
        note="Station name and location apply live."
        busy={busy}
        onSave={save}
        saveLabel="Save station settings"
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
  createJingle: () => void;
  onDelete: (filename: string | null) => void;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
}

function JinglesSection({
  data, form, setForm, busy, jingleText, setJingleText,
  createJingle, saveSettings, onDelete, adminFetch,
}: JinglesSectionProps) {
  const ratioDirty = form.jingleRatio !== String(data.values?.jingleRatio);
  const jingles = data.jingles || [];

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

      <Card title="Create jingle" sub="rendered via Piper TTS">
        <div className="field">
          <Label>Jingle text</Label>
          <Textarea
            rows={2}
            value={jingleText}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setJingleText(e.target.value)}
            placeholder='e.g. "You are listening to SUB slash WAVE. Requests open all night."'
          />
          <div className="flex flex-wrap items-center gap-2.5">
            <Btn tone="accent" onClick={createJingle} disabled={busy || !jingleText.trim()}>
              {busy ? 'Generating…' : 'Create jingle'}
            </Btn>
            <span className="text-[11px] text-muted">
              {jingleText.length}/500 chars · Piper TTS
            </span>
          </div>
        </div>
      </Card>

      <Card title="Jingles" sub={`${jingles.length} file${jingles.length === 1 ? '' : 's'}`}>
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
    </>
  );
}

/* ── Sound effects ───────────────────────────────────────────────────── */

interface SfxSectionProps {
  sfxData: SfxData | null;
  sfxForm: SfxForm;
  setSfxForm: (updater: (f: SfxForm) => SfxForm) => void;
  busy: boolean;
  createSfx: () => void;
  onDelete: (name: string | null) => void;
  data: SettingsData | null;
  saveSettings: SaveSettings;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
}

function SfxSection({ sfxData, sfxForm, setSfxForm, busy, createSfx, onDelete, data, saveSettings, adminFetch }: SfxSectionProps) {
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
        sub="The segment-director agent can garnish a spoken break with one of these effects, mixed beneath the voice. Built-in effects ship with the station; new ones are generated by ElevenLabs from a text prompt."
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

      <Card title="Create sound effect" sub="rendered via ElevenLabs">
        <div className="field">
          <Label>Name</Label>
          <Input
            value={sfxForm.name}
            maxLength={60}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setSfxForm(f => ({ ...f, name: e.target.value }))}
            placeholder="e.g. record-scratch"
            className="max-w-[280px]"
          />
          <div className="field-hint">A short slug the agent references — letters, numbers and dashes.</div>
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
          <div className="field-hint">{sfxForm.prompt.length}/500 chars — describe the sound for ElevenLabs.</div>
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
        <div className="mt-3.5 flex items-center gap-2.5">
          <Btn
            tone="accent"
            onClick={createSfx}
            disabled={busy || !ready || !sfxForm.name.trim() || !sfxForm.prompt.trim()}
          >
            {busy ? 'Generating…' : 'Create sound effect'}
          </Btn>
        </div>
      </Card>

      <Card title="Effect library" sub={`${list.length} effect${list.length === 1 ? '' : 's'}`}>
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
    </>
  );
}

/* ── Scrobbling ──────────────────────────────────────────────────────── */

interface ScrobbleSectionProps extends SectionProps {
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
}

function ScrobbleSection({ data, form, setForm, busy, saveSettings, adminFetch }: ScrobbleSectionProps) {
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

  return (
    <>
      <SectionHeader
        eyebrow="scrobbling"
        title="Station-wide scrobbling to Last.fm and ListenBrainz."
        sub={<>
          Each backend is independent — pick one or both. Tracks scrobble only when at
          least one listener is tuned in to the stream. Paste credentials below; nothing
          here leaves the controller. See the <code>npm run lastfm-session</code> helper
          if you don&apos;t already have a Last.fm session key.
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
              Generated by authorizing your account. Run
              <code> cd controller &amp;&amp; npm run lastfm-session</code> for a guided
              flow, or fetch one yourself via <code>auth.getSession</code>. Doesn&apos;t
              expire. Falls back to <code>LASTFM_SESSION_KEY</code>.
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
              Cosmetic — used to label the &quot;scrobbling as&quot; status line above.
            </div>
          </div>
        </div>

        <SaveBar
          note="Applies on the next track transition — no restart needed."
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
              ListenBrainz is the open-source alternative to Last.fm — same listener gate,
              same eligibility rules.
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
          note="Applies on the next track transition — no restart needed."
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
