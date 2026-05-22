'use client';

import type { ChangeEvent, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
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
  { id: 'tts',     label: 'TTS voice', hint: 'default engine' },
  { id: 'llm',     label: 'LLM provider', hint: 'model routing' },
  { id: 'search',  label: 'Web search', hint: 'live-facts backend' },
  { id: 'mixer',   label: 'Mixer', hint: 'crossfade · weather' },
  { id: 'jingles', label: 'Jingles', hint: 'stingers' },
  { id: 'sfx',     label: 'Sound FX', hint: 'agent stingers' },
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

interface FormState {
  jingleRatio: string;
  crossfadeDuration: string;
  weather: WeatherCfg;
  tts: TtsForm;
  llm: LlmForm;
  search: SearchForm;
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
    weather?: { lat?: number; lng?: number; locationName?: string };
    tts?: {
      defaultEngine?: string;
      kokoro?: { voice?: string };
      chatterbox?: { referenceVoice?: string };
      cloud?: Partial<CloudTtsCfg>;
    };
    llm?: Partial<LlmForm>;
    search?: Partial<SearchForm>;
    sfx?: { enabled?: boolean };
  };
  tts?: {
    engines?: string[];
    available?: Record<string, boolean>;
    kokoroVoices?: Array<{ id: string; label: string }>;
    chatterboxVoices?: string[];
    chatterboxVoiceDir?: string;
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

interface SaveMessage {
  tone: 'ok' | 'err';
  text: string;
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
  const [saveMsg, setSaveMsg] = useState<SaveMessage | null>(null);
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
      weather: {
        lat: String(v.weather?.lat ?? ''),
        lng: String(v.weather?.lng ?? ''),
        locationName: v.weather?.locationName ?? '',
      },
      tts: {
        defaultEngine: v.tts?.defaultEngine ?? 'piper',
        kokoro: { voice: v.tts?.kokoro?.voice ?? 'bf_isabella' },
        chatterbox: { referenceVoice: v.tts?.chatterbox?.referenceVoice ?? '' },
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
    setBusy(true); setSaveMsg(null);
    try {
      const r = await adminFetch('/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string; requiresRestart?: boolean };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      if (j.requiresRestart) setPendingRestart(true);
      setSaveMsg({ tone: 'ok', text: j.requiresRestart ? 'saved — restart the mixer to apply' : 'saved' });
      await refresh();
    } catch (e) {
      setSaveMsg({ tone: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(false); }
  };

  const restartMixer = async () => {
    setBusy(true);
    try {
      const r = await adminFetch('/restart-mixer', { method: 'POST' });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      setPendingRestart(false);
      setSaveMsg({ tone: 'ok', text: 'mixer restarting — give it a few seconds' });
    } catch (e) {
      setSaveMsg({ tone: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(false); }
  };

  const stopStream = async () => {
    setBusy(true);
    try {
      const r = await adminFetch('/stream-stop', { method: 'POST' });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      setSaveMsg({ tone: 'ok', text: 'stream stopped — station is off air' });
      await refresh();
    } catch (e) {
      setSaveMsg({ tone: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(false); }
  };

  const startStream = async () => {
    setBusy(true);
    try {
      const r = await adminFetch('/stream-start', { method: 'POST' });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      setSaveMsg({ tone: 'ok', text: 'stream started — station is on air' });
      await refresh();
    } catch (e) {
      setSaveMsg({ tone: 'err', text: e instanceof Error ? e.message : String(e) });
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
    } catch (e) { toast.error(`Jingle creation failed: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setBusy(false); }
  };

  const deleteJingle = async (filename: string) => {
    setBusy(true);
    try {
      const r = await adminFetch(`/jingles/${encodeURIComponent(filename)}`, { method: 'DELETE' });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      await refresh();
    } catch (e) { toast.error(`Delete failed: ${e instanceof Error ? e.message : String(e)}`); }
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
    } catch (e) { toast.error(`Sound effect creation failed: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setBusy(false); }
  };

  const deleteSfx = async (name: string) => {
    setBusy(true);
    try {
      const r = await adminFetch(`/sfx/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      await refreshSfx();
    } catch (e) { toast.error(`Delete failed: ${e instanceof Error ? e.message : String(e)}`); }
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

        <div className="mt-4 grid gap-2 border border-dashed border-separator-strong p-3">
          <span className="caption">danger zone</span>

          <div className="flex items-center gap-1.5 text-[10px] tracking-[0.1em] uppercase">
            <span className="text-muted">broadcast</span>
            <strong
              className={cn(
                data?.streamOnAir === false
                  ? 'text-[var(--danger)]'
                  : data?.streamOnAir
                    ? 'text-vermilion'
                    : 'text-muted',
              )}
            >
              {data?.streamOnAir == null ? '—' : data.streamOnAir ? 'on air' : 'off air'}
            </strong>
          </div>
          {data?.streamOnAir === false ? (
            <Btn sm tone="accent" onClick={startStream} disabled={busy || !data}>
              Start stream
            </Btn>
          ) : (
            <Btn sm tone="danger" onClick={() => setConfirmStop(true)} disabled={busy || !data || data?.streamOnAir == null}>
              Stop stream
            </Btn>
          )}
          <div className="text-[10px] leading-[1.4] text-muted">
            Takes the station off air by disconnecting the Icecast mount. A mixer restart brings it back on air.
          </div>

          <Btn sm tone="danger" onClick={() => setConfirmRestart(true)} disabled={busy || !data}>
            Restart mixer
          </Btn>
          <div className="text-[10px] leading-[1.4] text-muted">
            Drops the broadcast for ~3–5s. Use after crossfade or jingle frequency changes.
            {pendingRestart && (
              <strong className="mt-1 block text-vermilion">
                Pending settings need a restart to apply.
              </strong>
            )}
          </div>
        </div>
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
                saveMsg={saveMsg} saveSettings={saveSettings}
              />
            )}
            {activeSection === 'llm' && data.llm && (
              <LlmSection
                data={data} form={form} setForm={updateForm} busy={busy}
                saveMsg={saveMsg} saveSettings={saveSettings}
              />
            )}
            {activeSection === 'search' && (
              <SearchSection
                data={data} form={form} setForm={updateForm} busy={busy}
                saveMsg={saveMsg} saveSettings={saveSettings}
              />
            )}
            {activeSection === 'mixer' && (
              <MixerSection
                data={data} form={form} setForm={updateForm} busy={busy}
                saveMsg={saveMsg} saveSettings={saveSettings}
              />
            )}
            {activeSection === 'jingles' && (
              <JinglesSection
                data={data} form={form} setForm={updateForm} busy={busy}
                saveMsg={saveMsg}
                jingleText={jingleText} setJingleText={setJingleText}
                createJingle={createJingle} saveSettings={saveSettings}
                onDelete={setConfirmDelete}
              />
            )}
          </>
          );
        })()}
        {activeSection === 'sfx' && (
          <SfxSection
            sfxData={sfxData} sfxForm={sfxForm} setSfxForm={setSfxForm}
            busy={busy} createSfx={createSfx} onDelete={setConfirmDeleteSfx}
            data={data} saveSettings={saveSettings}
          />
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
  saveMsg: SaveMessage | null;
  onSave: () => void;
  saveLabel: ReactNode;
  extra?: ReactNode;
}

function SaveBar({ note, busy, saveMsg, onSave, saveLabel, extra }: SaveBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-3 border border-ink bg-[var(--ink-softer)] p-3">
      <span className="size-1.5 rounded-full bg-vermilion" />
      <span className="text-[11px] text-muted">{note}</span>
      {saveMsg && (
        <span
          className={cn(
            'text-[11px]',
            saveMsg.tone === 'err' ? 'text-[var(--danger)]' : 'text-vermilion',
          )}
        >
          {saveMsg.text}
        </span>
      )}
      <span className="ml-auto flex gap-2">
        {extra}
        <Btn tone="accent" onClick={onSave} disabled={busy}>{saveLabel}</Btn>
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
              Set <code>{envVar}</code> in <code>controller/.env</code> and restart the controller.
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
  saveMsg: SaveMessage | null;
  saveSettings: SaveSettings;
}

// Sentinel for the empty-string "use the built-in voice" choice — Radix Select
// rejects an empty-string SelectItem value.
const CB_DEFAULT_VOICE = '__cb_default__';

function TtsSection({ data, form, setForm, busy, saveMsg, saveSettings }: SectionProps) {
  const engines = data.tts?.engines || ['piper'];
  const available = data.tts?.available || {};
  const ENGINE_LABELS: Record<string, string> = { piper: 'Piper', kokoro: 'Kokoro', chatterbox: 'Chatterbox', cloud: 'Cloud' };
  const engineOptions = engines.map(e => ({ id: e, label: ENGINE_LABELS[e] || e }));

  const save = () => saveSettings({
    tts: {
      defaultEngine: form.tts.defaultEngine,
      kokoro: { voice: form.tts.kokoro?.voice },
      chatterbox: { referenceVoice: form.tts.chatterbox?.referenceVoice ?? '' },
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
  const savedCloud: any = savedTts.cloud || {};
  const savedEngineLabel = ENGINE_LABELS[savedEngine] || savedEngine;
  const formEngineLabel = ENGINE_LABELS[form.tts.defaultEngine] || form.tts.defaultEngine;

  const ttsDirty =
    form.tts.defaultEngine !== savedEngine
    || (form.tts.kokoro?.voice || '') !== savedKokoroVoice
    || (form.tts.chatterbox?.referenceVoice || '') !== savedChatterboxVoice
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
                Chatterbox isn’t bundled in this controller image. Rebuild it with{' '}
                <code>--build-arg WITH_CHATTERBOX=1</code> to include the runtime and
                model, then recreate the controller. Until then this engine falls back to Piper.
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
                  <code>{data.tts?.chatterboxVoiceDir || 'state/chatterbox-voices'}</code>
                  {' '}on the host and they’ll appear here on next reload. Personas can
                  override this on the Personas page.
                </div>
              </>
            ) : (
              <div className="field-hint">
                No reference voices found in{' '}
                <code>{data.tts?.chatterboxVoiceDir || 'state/chatterbox-voices'}</code>.
                The engine will use its built-in default voice. Drop a 5-second WAV into
                that directory to enable cloning.
              </div>
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
        saveMsg={saveMsg}
        onSave={save}
        saveLabel="Save TTS settings"
      />
    </>
  );
}

/* ── LLM ─────────────────────────────────────────────────────────────── */

function LlmSection({ data, form, setForm, busy, saveMsg, saveSettings }: SectionProps) {
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
        saveMsg={saveMsg}
        onSave={save}
        saveLabel="Save LLM provider"
      />
    </>
  );
}

/* ── Web search ──────────────────────────────────────────────────────── */

function SearchSection({ data, form, setForm, busy, saveMsg, saveSettings }: SectionProps) {
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
                  <code> SEARCH_API_KEY</code> in <code>controller/.env</code> when blank — set
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
        saveMsg={saveMsg}
        onSave={save}
        saveLabel="Save web search"
      />
    </>
  );
}

/* ── Mixer ───────────────────────────────────────────────────────────── */

function MixerSection({ data, form, setForm, busy, saveMsg, saveSettings }: SectionProps) {
  const save = () => saveSettings({
    crossfadeDuration: parseFloat(form.crossfadeDuration),
    weather: {
      lat: parseFloat(form.weather.lat),
      lng: parseFloat(form.weather.lng),
      locationName: form.weather.locationName,
    },
  });

  return (
    <>
      <SectionHeader
        eyebrow="mixer"
        title="Crossfade and where the station broadcasts from."
        sub="Crossfade overlap shapes every track transition. The station location sets where the DJ thinks it broadcasts from and drives the Open-Meteo weather it reads on air."
        metrics={[
          { n: `${data.values?.crossfadeDuration}s`, l: 'crossfade', accent: true },
        ]}
      />

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
                setForm(f => ({ ...f, crossfadeDuration: e.target.value }))
              }
            />
            <span className="text-[12px] text-muted">sec</span>
          </div>
          <div className="field-hint">
            Seconds of overlap between tracks (current: {data.values?.crossfadeDuration}s).
            Requires a mixer restart to apply.
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
        note="Station location applies live · Crossfade requires a mixer restart (danger zone)."
        busy={busy}
        saveMsg={saveMsg}
        onSave={save}
        saveLabel="Save mixer settings"
      />
    </>
  );
}

/* ── Jingles ─────────────────────────────────────────────────────────── */

interface JinglesSectionProps extends SectionProps {
  jingleText: string;
  setJingleText: (s: string) => void;
  createJingle: () => void;
  onDelete: (filename: string | null) => void;
}

function JinglesSection({
  data, form, setForm, busy, jingleText, setJingleText,
  createJingle, saveSettings, onDelete,
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
}

function SfxSection({ sfxData, sfxForm, setSfxForm, busy, createSfx, onDelete, data, saveSettings }: SfxSectionProps) {
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
              <code>controller/.env</code> (or set the cloud TTS provider to ElevenLabs with a key
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
        ))}
      </Card>
    </>
  );
}
