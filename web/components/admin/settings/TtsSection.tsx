'use client';

import type { ChangeEvent, ReactNode } from 'react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { notify, errorMessage } from '../../../lib/notify';
import { adminResponse } from '../../../lib/admin-query';
import { useModelDiscovery } from '@/hooks/useModelDiscovery';
import { useVoiceDiscovery } from '@/hooks/useVoiceDiscovery';
import { CLOUD_VOICES, CLOUD_MODELS } from '../../../lib/cloudVoices';
import {
  buildCloudVoiceGroups, isKnownCloudVoice, providerSupportsDiscovery, CUSTOM_VOICE_ID,
} from '../../../lib/cloudVoiceGroups';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectGroup, SelectLabel,
} from '../../ui/select';
import { Card, Btn, Pill, Seg } from '../ui';
import { EngineSelector } from '../tts/EngineSelector';
import { CloudProviderSelector } from '../tts/CloudProviderSelector';
import { cloudProviderLabel, resolveKeyPresence } from '../tts/cloudProviderMeta';
import { EngineVoiceFields, ENGINE_UNAVAILABLE } from '../tts/EngineVoiceFields';
import { VoicePreviewButton } from '../tts/VoicePreviewButton';
import { defaultEngineVoice } from '../tts/defaultVoice';
import { ENGINE_META } from '../tts/engineMeta';
import { VoicePicker } from '../tts/VoicePicker';
import { ModelCombobox } from '../llm/ModelCombobox';
import { cn } from '../../../lib/cn';
import {
  SectionHeader, SaveBar, KeyStatus, KeyTestResult, KEY_HINTS, ELEVENLABS_VS_DEFAULTS,
  FISH_TTS_DEFAULTS,
  type SectionProps, type FormState, type FormUpdater, type CloudTtsCfg,
  type TtsFallbackForm,
} from './shared';

// Kokoro phonemizer language labels, keyed by the controller's lang codes —
// keep in sync with KOKORO_LANGS in settings.ts.
const KOKORO_LANG_LABELS: Record<string, string> = {
  'en-gb': 'English (UK)',
  'en-us': 'English (US)',
  cmn: 'Chinese (Mandarin)',
  'fr-fr': 'French',
  hi: 'Hindi',
  it: 'Italian',
  ja: 'Japanese',
  'pt-br': 'Portuguese (Brazilian)',
  es: 'Spanish',
};

// Sentinel for the empty-string "use the built-in voice" choice — Radix Select
// rejects an empty-string SelectItem value.
const CB_DEFAULT_VOICE = '__cb_default__';

function envKeyForCloudProvider(provider: string): 'OPENAI_API_KEY' | 'ELEVENLABS_API_KEY' | 'FISH_API_KEY' {
  if (provider === 'elevenlabs') return 'ELEVENLABS_API_KEY';
  if (provider === 'fish-audio') return 'FISH_API_KEY';
  return 'OPENAI_API_KEY';
}

// Small labelled rule that splits the Cloud panel into its three steps. Same
// type treatment as the other in-card headings (HeavyEngineSetupGuide's).
function GroupHead({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex-none text-[10px] font-bold tracking-[0.16em] text-ink uppercase">
        {children}
      </span>
      <span className="h-px min-w-0 flex-1 bg-[var(--separator-strong)]" />
    </div>
  );
}

// Engine ids match the server contract exactly — note the hyphen in `pocket-tts`.
// Range mirrors the server clamp (TTS_GAIN_CLAMP_DB=12).
const TTS_GAIN_ENGINES = ['piper', 'kokoro', 'chatterbox', 'pocket-tts', 'cloud', 'remote'] as const;
const TTS_GAIN_MIN = -12;
const TTS_GAIN_MAX = 12;
const TTS_GAIN_STEP = 0.5;

// Signed one-decimal dB with a real minus sign; unity prints as a bare "0 dB".
function formatGainDb(v: number): string {
  if (!v) return '0 dB';
  const sign = v > 0 ? '+' : '−';
  return `${sign}${Math.abs(v).toFixed(1)} dB`;
}


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

// Range mirrors the server clamp (clampTtsSpeed: 0.5–2.0×). Only Piper/Kokoro/
// cloud honour speed — chatterbox/pocket-tts/remote ignore it.
const TTS_SPEED_MIN = 0.5;
const TTS_SPEED_MAX = 2;
const TTS_SPEED_STEP = 0.05;
const TTS_SPEED_UNSUPPORTED = new Set(['chatterbox', 'pocket-tts', 'remote']);

function formatSpeed(v: number): string {
  return `${v.toFixed(2)}×`;
}

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
          : <>Not supported by this engine: only Piper, Kokoro and cloud honour speed.</>}
      </div>
    </div>
  );
}

// ElevenLabs voice_settings. Ranges match their native 0..1 (stability, style,
// similarity_boost) plus the boolean use_speaker_boost. Rendered only for the
// `elevenlabs` provider — every other provider ignores these fields.
const ELEVENLABS_SLIDER_STEP = 0.01;

function formatPct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function ElevenLabsVoiceSettingsField({
  form,
  setForm,
}: {
  form: FormState;
  setForm: FormUpdater;
}) {
  const c = form.tts.cloud;
  const setCloud = (patch: Partial<CloudTtsCfg>) =>
    setForm(f => ({ ...f, tts: { ...f.tts, cloud: { ...f.tts.cloud, ...patch } } }));
  const slider = (
    label: string,
    hint: ReactNode,
    key: 'voiceStability' | 'voiceStyle' | 'voiceSimilarityBoost',
  ) => (
    <div className="field mt-4">
      <div className="flex items-center justify-between gap-3">
        <Label>{label}</Label>
        <span className="font-mono text-[12px] text-ink tabular-nums">{formatPct(c[key])}</span>
      </div>
      <input
        type="range"
        min={0}
        max={1}
        step={ELEVENLABS_SLIDER_STEP}
        value={c[key]}
        onChange={(e: ChangeEvent<HTMLInputElement>) => setCloud({ [key]: Number(e.target.value) } as Partial<CloudTtsCfg>)}
        aria-label={label}
        className="mt-1.5 w-full max-w-[360px] accent-[var(--accent)]"
      />
      <div className="field-hint">{hint}</div>
    </div>
  );
  return (
    <>
      {slider(
        'Stability',
        <>Lower is more expressive but can wander; higher is steadier but flatter. ElevenLabs default is <code>50%</code>. Note: the <code>eleven_v3</code> model only accepts 0%, 50% or 100%; other values round to the nearest.</>,
        'voiceStability',
      )}
      {slider(
        'Style exaggeration',
        <>How much the reference voice’s style is amplified. Higher costs more latency and can hurt stability. ElevenLabs default is <code>0%</code>.</>,
        'voiceStyle',
      )}
      {slider(
        'Similarity boost',
        <>How tightly the output tracks the reference voice. ElevenLabs default is <code>75%</code>.</>,
        'voiceSimilarityBoost',
      )}
      <div className="field mt-4">
        <label className="flex cursor-pointer items-center gap-2 text-[12px] leading-[1.5] text-ink">
          <input
            type="checkbox"
            checked={c.voiceUseSpeakerBoost}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setCloud({ voiceUseSpeakerBoost: e.target.checked })}
            className="accent-[var(--accent)]"
          />
          <span>Speaker boost</span>
        </label>
        <div className="field-hint">
          Sharpens similarity to the reference voice at a small latency cost. On by default.
        </div>
      </div>
    </>
  );
}

function FishAudioSettingsField({
  form,
  setForm,
}: {
  form: FormState;
  setForm: FormUpdater;
}) {
  const c = form.tts.cloud;
  const setCloud = (patch: Partial<CloudTtsCfg>) =>
    setForm(f => ({ ...f, tts: { ...f.tts, cloud: { ...f.tts.cloud, ...patch } } }));
  const slider = (label: string, hint: ReactNode, key: 'temperature' | 'topP') => (
    <div className="field mt-4">
      <div className="flex items-center justify-between gap-3">
        <Label>{label}</Label>
        <span className="font-mono text-[12px] text-ink tabular-nums">{c[key].toFixed(2)}</span>
      </div>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={c[key]}
        onChange={(e: ChangeEvent<HTMLInputElement>) => setCloud({ [key]: Number(e.target.value) } as Partial<CloudTtsCfg>)}
        aria-label={label}
        className="mt-1.5 w-full max-w-[360px] accent-[var(--accent)]"
      />
      <div className="field-hint">{hint}</div>
    </div>
  );
  return (
    <>
      {slider(
        'Temperature',
        <>Controls variation and expressiveness. Lower is more repeatable; higher is more adventurous. Fish default is <code>0.70</code>.</>,
        'temperature',
      )}
      {slider(
        'Top P',
        <>Limits token sampling breadth. Lower values are more focused. Fish default is <code>0.70</code>.</>,
        'topP',
      )}
      <div className="field mt-4">
        <Label>Latency mode</Label>
        <Seg
          value={c.latency}
          options={[
            { id: 'low', label: 'Low' },
            { id: 'normal', label: 'Normal' },
            { id: 'balanced', label: 'Balanced' },
          ]}
          onChange={value => setCloud({ latency: value as CloudTtsCfg['latency'] })}
        />
        <div className="field-hint">
          <code>normal</code> is the quality-first default. Use <code>low</code> for faster responses or <code>balanced</code> as the middle ground.
        </div>
      </div>
      <div className="field-hint mt-4 max-w-[620px]">
        Fish S2.1 understands sparse performance cues such as <code>[laughing]</code> or <code>[whispers]</code> when they appear in spoken text. Keep them intentional; SUB/WAVE’s existing prompt and cue pipeline is unchanged.
      </div>
    </>
  );
}

// Quick-add names for the servers operators actually run. These are hints, not
// a schema — a compatibility server accepts whatever its own implementation
// defines, which is exactly why the field is free-form (issue #1317).
const COMPAT_PARAM_SUGGESTIONS: { key: string; value: string; note: string }[] = [
  { key: 'temperature', value: '0.8', note: 'Chatterbox · variation' },
  { key: 'seed', value: '0', note: 'Chatterbox · repeatability' },
  { key: 'exaggeration', value: '0.5', note: 'Chatterbox · intensity' },
  { key: 'cfg_weight', value: '0.5', note: 'Chatterbox · pacing' },
];

const COMPAT_PARAM_MAX = 20;

function CompatParamsField({ form, setForm }: { form: FormState; setForm: FormUpdater }) {
  const rows = form.tts.cloud.compatParams;
  const setRows = (next: CloudTtsCfg['compatParams']) =>
    setForm(f => ({ ...f, tts: { ...f.tts, cloud: { ...f.tts.cloud, compatParams: next } } }));
  const used = new Set(rows.map(r => r.key.trim()));
  return (
    <div className="field mt-4">
      <Label>Extra generation parameters</Label>
      <div className="field-hint mb-2 max-w-[620px]">
        Sent as extra fields in every <code>/audio/speech</code> request, for
        knobs your server supports but the OpenAI API doesn’t define —
        Chatterbox’s <code>temperature</code> and <code>seed</code>, for
        instance. Values are read as JSON when they look like it
        (<code>0.8</code>, <code>42</code>, <code>true</code>) and sent as text
        otherwise. <code>model</code>, <code>voice</code>, <code>input</code>{' '}
        and <code>speed</code> are set by SUB/WAVE and can’t be overridden here.
      </div>
      <div className="flex flex-col gap-2">
        {rows.map((row, idx) => (
          <div
            key={idx}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:grid-cols-[220px_220px_auto] sm:justify-start"
          >
            <Input
              aria-label="Parameter name"
              value={row.key}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setRows(rows.map((r, i) => i === idx ? { ...r, key: e.target.value } : r))}
              placeholder="name (e.g. temperature)"
              maxLength={60}
              className="min-w-0"
            />
            <Input
              aria-label="Parameter value"
              value={row.value}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setRows(rows.map((r, i) => i === idx ? { ...r, value: e.target.value } : r))}
              placeholder="value (e.g. 0.8)"
              maxLength={400}
              className="col-start-1 row-start-2 min-w-0 sm:col-start-2 sm:row-start-1"
            />
            <Btn
              sm
              title="Remove parameter"
              className="col-start-2 row-start-1 size-9 shrink-0 sm:col-start-3 sm:size-auto"
              onClick={() => setRows(rows.filter((_, i) => i !== idx))}
            >
              <Trash2 size={12} />
            </Btn>
          </div>
        ))}
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Btn
          className="min-h-9 sm:min-h-0"
          disabled={rows.length >= COMPAT_PARAM_MAX}
          onClick={() => setRows([...rows, { key: '', value: '' }])}
        >
          Add parameter
        </Btn>
        {COMPAT_PARAM_SUGGESTIONS.filter(s => !used.has(s.key)).map(s => (
          <Btn
            key={s.key}
            sm
            title={s.note}
            className="min-h-9 sm:min-h-0"
            disabled={rows.length >= COMPAT_PARAM_MAX}
            onClick={() => setRows([...rows, { key: s.key, value: s.value }])}
          >
            + {s.key}
          </Btn>
        ))}
      </div>
    </div>
  );
}

// Chatterbox and PocketTTS both live in the optional `tts-heavy` sidecar, so the
// setup path is identical; only the engine label and the legacy build-arg differ.
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

      <p className="mt-2 text-[14px] leading-[1.55] text-muted">
        {engine} is a heavy PyTorch engine, so the controller image doesn’t carry it.
        It ships in the optional <code>tts-heavy</code> sidecar. Until that’s running,
        every segment routed here <strong>falls back to Piper</strong>. The DJ never
        goes silent, it just won’t use this voice.
      </p>

      <div className="mt-3 text-[10px] font-bold tracking-[0.16em] text-ink uppercase">
        Turn it on
      </div>
      <ol className="mt-1.5 grid list-decimal gap-2 pl-[18px] text-[14px] leading-[1.55] text-muted marker:font-bold marker:text-[var(--danger)]">
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

      <p className="mt-2.5 text-[14px] leading-[1.5] text-muted">
        Legacy single-image path: rebuild the controller with{' '}
        <code>--build-arg {buildArg}</code> (only if you built a custom image on the
        pre-sidecar pattern).
      </p>
    </div>
  );
}

interface TtsSectionProps extends SectionProps {
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  refresh: () => Promise<void>;
}

export function TtsSection({ data, form, setForm, busy, saveSettings, adminFetch, refresh }: TtsSectionProps) {
  const [cloudKeyInput, setCloudKeyInput] = useState('');
  const [cloudKeyTest, setCloudKeyTest] = useState<{ ok: boolean; message: string; latencyMs: number } | null>(null);
  const [cloudKeyTesting, setCloudKeyTesting] = useState(false);
  // Compat servers don't use the OPENAI/ELEVENLABS env keys — their optional bearer
  // is settings.tts.cloud.compatApiKey, so it rides the settings payload.
  const [compatKeyInput, setCompatKeyInput] = useState('');

  useEffect(() => { setCloudKeyInput(''); setCompatKeyInput(''); }, [form.tts.cloud.provider]);
  useEffect(() => { setCloudKeyTest(null); }, [form.tts.cloud.provider]);

  // The fallback's provider can differ from the default engine's, so key presence
  // is checked per-provider, never off the global `available.cloud` flag.
  // `openai-compatible` has no key-based entry and is trusted, as in engineUsable().
  const fallbackCloudUnconfigured = form.tts.fallback.engine === 'cloud'
    && form.tts.fallback.cloudProvider !== 'openai-compatible'
    && data.tts?.available?.cloudByProvider?.[form.tts.fallback.cloudProvider] === false;

  const isCloudEngine = form.tts.defaultEngine === 'cloud';
  const isCompat = form.tts.cloud.provider === 'openai-compatible';
  const isFish = form.tts.cloud.provider === 'fish-audio';
  const ttsKeyVar = envKeyForCloudProvider(form.tts.cloud.provider);
  const ttsKeySet = !!data.env?.[ttsKeyVar];

  const cloudDiscoveryReady = isCloudEngine && (
    (isCompat && !!form.tts.cloud.baseUrl.trim())
    || (!isCompat && ttsKeySet)
  );
  // Fish has no account model-list endpoint; its two S2.1 suggestions are local
  // UI data and the field still accepts custom ids.
  const ttsDiscoveryEnabled = cloudDiscoveryReady && !isFish;

  const ttsDiscovery = useModelDiscovery({
    provider: isCompat ? 'openai-compatible' : form.tts.cloud.provider,
    baseUrl: form.tts.cloud.baseUrl,
    enabled: ttsDiscoveryEnabled,
    adminFetch,
  });

  // Voice list from the provider itself (compat /audio/voices, or the operator's
  // ElevenLabs account). Same readiness gate as model discovery: a URL for
  // compat, a saved key otherwise.
  const voiceDiscovery = useVoiceDiscovery({
    provider: form.tts.cloud.provider,
    baseUrl: form.tts.cloud.baseUrl,
    enabled: cloudDiscoveryReady && providerSupportsDiscovery(form.tts.cloud.provider),
    adminFetch,
  });
  const discoveredVoices = voiceDiscovery.voices;

  const saveKey = async (envVar: string, value: string): Promise<boolean> => {
    if (!value.trim()) return true;
    try {
      const r = await adminResponse(adminFetch, '/settings/secrets', {
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
    const cloudKeyVar = envKeyForCloudProvider(form.tts.cloud.provider);
    const hasTyped = !!cloudKeyInput.trim();
    if (!hasTyped && !data.env?.[cloudKeyVar]) return;
    setCloudKeyTesting(true);
    setCloudKeyTest(null);
    try {
      const r = await adminResponse(adminFetch, '/settings/secrets/test', {
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
  const providerCloudReady = isCompat
    ? !!(form.tts.cloud.baseUrl.trim() && form.tts.cloud.model.trim())
    : available.cloudByProvider?.[form.tts.cloud.provider];
  const selectorAvailable = providerCloudReady === undefined
    ? available
    : { ...available, cloud: providerCloudReady };
  // engineMeta.ts is the one label table (it already backs EngineSelector).
  const engineLabelOf = (id: string) => ENGINE_META[id]?.label || id;

  // Send (and dirty-check) what the controller will actually store: trimmed,
  // with untouched blank rows dropped. Otherwise an operator who presses "Add
  // parameter" and saves leaves the form permanently dirty against a saved list
  // that never contained the empty row.
  const effectiveCompatParams = form.tts.cloud.compatParams
    .map(p => ({ key: p.key.trim(), value: p.value.trim() }))
    .filter(p => p.key || p.value);

  const save = async () => {
    // Managed-provider keys must land first: Fish voice discovery reads the saved
    // process secret, so an empty undiscovered Fish voice would fail the settings
    // write before the key became usable.
    let managedKeySaved = false;
    if (!isCompat && cloudKeyInput.trim()) {
      const cloudKeyVar = envKeyForCloudProvider(form.tts.cloud.provider);
      managedKeySaved = await saveKey(cloudKeyVar, cloudKeyInput);
      if (!managedKeySaved) return;
      setCloudKeyInput('');
      if (isFish && !form.tts.cloud.voice.trim()) {
        await refresh();
        notify.info('Fish Audio key saved — TTS settings are not saved yet. Pick an account or custom voice, then press Save again.');
        return;
      }
    }

    const savedCloudProvider = String(data.values?.tts?.cloud?.provider || '');
    const clearInlineCloudKey = isFish
      || (!!savedCloudProvider && savedCloudProvider !== form.tts.cloud.provider);
    // Redacted sentinel: 'set' means an inline key is on file in settings.json.
    const hadStoredInlineKey = data.values?.tts?.cloud?.apiKey === 'set';
    const settingsSaved = await saveSettings({
      tts: {
        enabled: form.tts.enabled,
        defaultEngine: form.tts.defaultEngine,
        fallback: form.tts.fallback,
        kokoro: { voice: form.tts.kokoro?.voice, lang: form.kokoroLang },
        chatterbox: { referenceVoice: form.tts.chatterbox?.referenceVoice ?? '' },
        pocketTts: { voice: form.tts.pocketTts?.voice ?? 'alba' },
        cloud: {
          enabled: true,
          provider: form.tts.cloud.provider,
          model: form.tts.cloud.model,
          voice: form.tts.cloud.voice,
          baseUrl: form.tts.cloud.baseUrl,
          voiceStability: form.tts.cloud.voiceStability,
          voiceStyle: form.tts.cloud.voiceStyle,
          voiceSimilarityBoost: form.tts.cloud.voiceSimilarityBoost,
          voiceUseSpeakerBoost: form.tts.cloud.voiceUseSpeakerBoost,
          temperature: form.tts.cloud.temperature,
          topP: form.tts.cloud.topP,
          latency: form.tts.cloud.latency,
          compatParams: effectiveCompatParams,
          // Compat servers use their own scoped slot; the legacy shared slot is
          // cleared on Fish or any provider transition (managed credentials live
          // in secrets.env).
          ...(isCompat && compatKeyInput.trim()
            ? { compatApiKey: compatKeyInput.trim() }
            : clearInlineCloudKey
              ? { apiKey: '' }
              : {}),
        },
        remote: { url: form.tts.remote.url },
        // Always sent — the server clamps and drops unknown keys. Keyed by engine
        // id, `pocket-tts` with the hyphen.
        gainDb: form.tts.gainDb,
        // Same contract as gainDb; inert for the engines that ignore speed.
        speed: form.tts.speed,
      },
    });
    if (!settingsSaved && managedKeySaved) {
      await refresh();
      notify.info('API key saved; TTS settings were not changed.');
    }
    // Clearing the legacy inline key is deliberate (keys are provider-scoped now)
    // but must never be silent — the operator may have relied on it.
    if (settingsSaved && clearInlineCloudKey && hadStoredInlineKey) {
      notify.info(`The API key stored in settings for ${cloudProviderLabel(savedCloudProvider)} was cleared — keys are provider-scoped. Re-enter it in Settings (or set its env key) if you switch back.`);
    }
  };

  const selectCloudProvider = (f: FormState, provider: string): FormState => {
    const provVoices = CLOUD_VOICES[provider as keyof typeof CLOUD_VOICES] || [];
    // Switching provider invalidates the old provider-specific ids; re-entering
    // the already-selected engine preserves manual/custom values.
    const sameProvider = provider === f.tts.cloud.provider;
    const voice = sameProvider
      ? f.tts.cloud.voice
      : (provVoices[0]?.id || '');
    const provModels = CLOUD_MODELS[provider as keyof typeof CLOUD_MODELS] || [];
    const model = sameProvider && f.tts.cloud.model.trim()
      ? f.tts.cloud.model
      : (provModels[0] || '');
    return { ...f, tts: { ...f.tts, cloud: { ...f.tts.cloud, enabled: true, provider, voice, model } } };
  };

  const selectEngine = (engine: string) => setForm(f => {
    const base = engine === 'cloud'
      ? selectCloudProvider(f, f.tts.cloud.provider || 'openai')
      : f;
    return { ...base, tts: { ...base.tts, defaultEngine: engine } };
  });

  type SavedCloud = {
    provider?: string;
    voice?: string;
    model?: string;
    baseUrl?: string;
    apiKey?: string; // redacted by GET /settings: 'set' when on file, '' otherwise
    voiceStability?: number;
    voiceStyle?: number;
    voiceSimilarityBoost?: number;
    voiceUseSpeakerBoost?: boolean;
    temperature?: number;
    topP?: number;
    latency?: 'low' | 'normal' | 'balanced';
    compatParams?: { key?: string; value?: string }[];
  };
  const savedTts: {
    enabled?: boolean;
    defaultEngine?: string;
    kokoro?: { voice?: string; lang?: string };
    chatterbox?: { referenceVoice?: string };
    pocketTts?: { voice?: string };
    cloud?: SavedCloud;
    remote?: { url?: string };
    gainDb?: Record<string, number>;
    speed?: Record<string, number>;
  } = data.values?.tts || {};
  const savedEngine: string = savedTts.defaultEngine || 'piper';
  const savedKokoroVoice: string = savedTts.kokoro?.voice || '';
  const savedKokoroLang: string = savedTts.kokoro?.lang || '';
  const savedChatterboxVoice: string = savedTts.chatterbox?.referenceVoice || '';
  const savedPocketTtsVoice: string = savedTts.pocketTts?.voice || '';
  const savedCloud: SavedCloud = savedTts.cloud || {};
  const savedRemoteUrl: string = savedTts.remote?.url || '';
  const savedEngineLabel = engineLabelOf(savedEngine);
  const formEngineLabel = engineLabelOf(form.tts.defaultEngine);

  const compatParamsDirty = JSON.stringify(effectiveCompatParams)
    !== JSON.stringify((savedCloud.compatParams || []).map(p => ({ key: String(p?.key ?? ''), value: String(p?.value ?? '') })));

  const savedGainDb: Record<string, number> = savedTts.gainDb || {};
  // Absent reads as 0 unity.
  const gainDirty = TTS_GAIN_ENGINES.some(
    e => (form.tts.gainDb?.[e] ?? 0) !== (savedGainDb[e] ?? 0),
  );

  const savedSpeed: Record<string, number> = savedTts.speed || {};
  // Absent reads as 1.0 unity.
  const speedDirty = TTS_GAIN_ENGINES.some(
    e => (form.tts.speed?.[e] ?? 1) !== (savedSpeed[e] ?? 1),
  );

  const ttsDirty =
    // Absent reads as ON, matching the controller's coercion — so an untouched
    // pre-upgrade settings.json never shows up as dirty.
    form.tts.enabled !== (savedTts.enabled !== false)
    || form.tts.defaultEngine !== savedEngine
    || (form.tts.kokoro?.voice || '') !== savedKokoroVoice
    || (form.kokoroLang || '') !== savedKokoroLang
    || (form.tts.chatterbox?.referenceVoice || '') !== savedChatterboxVoice
    || (form.tts.pocketTts?.voice || '') !== savedPocketTtsVoice
    || form.tts.cloud.provider !== (savedCloud.provider || '')
    || (form.tts.cloud.model || '').trim() !== (savedCloud.model || '').trim()
    || (form.tts.cloud.voice || '').trim() !== (savedCloud.voice || '').trim()
    || (form.tts.cloud.baseUrl || '').trim() !== (savedCloud.baseUrl || '').trim()
    || form.tts.cloud.voiceStability !== (savedCloud.voiceStability ?? ELEVENLABS_VS_DEFAULTS.voiceStability)
    || form.tts.cloud.voiceStyle !== (savedCloud.voiceStyle ?? ELEVENLABS_VS_DEFAULTS.voiceStyle)
    || form.tts.cloud.voiceSimilarityBoost !== (savedCloud.voiceSimilarityBoost ?? ELEVENLABS_VS_DEFAULTS.voiceSimilarityBoost)
    || form.tts.cloud.voiceUseSpeakerBoost !== (savedCloud.voiceUseSpeakerBoost ?? ELEVENLABS_VS_DEFAULTS.voiceUseSpeakerBoost)
    || compatParamsDirty
    || form.tts.cloud.temperature !== (savedCloud.temperature ?? FISH_TTS_DEFAULTS.temperature)
    || form.tts.cloud.topP !== (savedCloud.topP ?? FISH_TTS_DEFAULTS.topP)
    || form.tts.cloud.latency !== (savedCloud.latency ?? FISH_TTS_DEFAULTS.latency)
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

      <Card title="Station voice" sub={form.tts.enabled ? 'on air' : 'music only'}>
        <div className="field">
          <Label>DJ speech</Label>
          <Seg
            accent
            value={form.tts.enabled ? 'on' : 'off'}
            options={[
              { id: 'on', label: 'On', title: 'The DJ speaks as configured' },
              { id: 'off', label: 'Music only', title: 'The DJ never speaks' },
            ]}
            onChange={v => setForm(f => ({ ...f, tts: { ...f.tts, enabled: v === 'on' } }))}
          />
          <p className="mt-2 text-[13px] leading-[1.55] text-muted">
            {form.tts.enabled ? (
              <>
                Turning this off makes the station <strong>music only</strong>: no links,
                idents, hourly checks, segments, banter, mic-passes, programme beats or
                spoken request intros — and no LLM tokens spent writing them. Music keeps
                playing, listener requests are still queued, and manual triggers on the DJ
                page still fire.
              </>
            ) : (
              <>
                The DJ is <strong>silent</strong>. Tracks are still picked and listener
                requests still queue — they just play without a spoken intro. Manual
                triggers on the DJ page still fire.{' '}
                <strong>Jingles are separate</strong>: pre-rendered stingers keep playing on
                Liquidsoap’s own rotate. Silence those with Jingle ratio <code>0</code> under
                Station (needs a mixer restart).
              </>
            )}
          </p>
        </div>
      </Card>

      <Card title="Voice engine" sub="active default">
        <div className="grid gap-[18px]">
          <div className="flex items-start gap-2.5 border border-[var(--accent)] bg-[var(--ink-softer)] p-3">
            <span className="mt-1 size-1.5 flex-none rounded-full bg-vermilion" />
            <div className="grid min-w-0 gap-0.5">
              <span className="text-[11px] font-bold tracking-[0.12em] text-vermilion uppercase">
                Default engine now · {savedEngineLabel}
              </span>
              <span className="text-[14px] leading-[1.5] text-muted">
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
              available={selectorAvailable}
              // This IS Settings → Voice, so the default "go to Settings →
              // Voice" wording would send the operator in a circle.
              statusOpts={{ cloudKeyAction: 'pick a provider below and add its key' }}
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

        {form.tts.defaultEngine === 'kokoro' && (() => {
          const voices = data.tts?.kokoroVoices || [];
          const languages = data.tts?.kokoroVoiceLanguages || {};
          const voice = form.tts.kokoro?.voice ?? 'bf_isabella';
          const langPrefix = voice.charAt(0);
          const filtered = voices.filter(v => v.startsWith(langPrefix));
          const fmt = (code: string) => {
            const [lg, name = ''] = code.split('_');
            const g = (lg?.[1] ?? '').toUpperCase();
            const n = name.charAt(0).toUpperCase() + name.slice(1);
            return `${n} (${g})`;
          };
          const setVoice = (val: string) => setForm(f => ({
            ...f, tts: { ...f.tts, kokoro: { ...f.tts.kokoro, voice: val } },
          }));
          return (
            <>
              <div className="field mt-4">
                <Label>Kokoro voice</Label>
                {available.kokoro === false && (
                  <div className="field-hint text-[var(--danger)]">
                    Kokoro is not installed in this build, so it will fall back to Piper.
                  </div>
                )}
                {voices.length > 0 ? (
                  <>
                    <div className="field mt-3">
                      <Label>Language</Label>
                      <Select
                        value={langPrefix}
                        onValueChange={lang => {
                          const first = voices.find(v => v.startsWith(lang));
                          if (first) setVoice(first);
                        }}
                      >
                        <SelectTrigger aria-label="Language"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {Object.entries(languages).map(([k, v]) => (
                              <SelectItem key={k} value={k}>{v}</SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="field mt-3">
                      <Label>Voice</Label>
                      <Select value={voice} onValueChange={setVoice}>
                        <SelectTrigger aria-label="Voice"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {!filtered.includes(voice) && (
                              <SelectItem value={voice}>{fmt(voice)}</SelectItem>
                            )}
                            {filtered.map(v => (
                              <SelectItem key={v} value={v}>{fmt(v)}</SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </div>
                  </>
                ) : (
                  <div className="field-hint">This build reports no Kokoro voices.</div>
                )}
              </div>
              <div className="field mt-3">
                <Label>Language override</Label>
                <Select
                  value={form.kokoroLang || '__auto__'}
                  onValueChange={val =>
                    setForm(f => ({ ...f, kokoroLang: val === '__auto__' ? '' : val }))
                  }
                >
                  <SelectTrigger className="w-[260px] max-w-full" aria-label="Language override"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="__auto__">Natural, voice default</SelectItem>
                      {(data.tts?.kokoroLangs || []).map(v => (
                        <SelectItem key={v} value={v}>{KOKORO_LANG_LABELS[v] || v}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <div className="field-hint">
                  Force the Kokoro TTS engine to assume a specific language. Leave on <em>Natural</em> to auto-detect from each selected voice.
                </div>
              </div>
              <TtsGainField engineId="kokoro" form={form} setForm={setForm} />
              <TtsSpeedField engineId="kokoro" form={form} setForm={setForm} />
            </>
          );
        })()}

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
                    <SelectTrigger aria-label="Chatterbox reference voice"><SelectValue /></SelectTrigger>
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
                    ~5 seconds of clean speech is enough to clone a voice.{' '}
                    <Link href="/admin/imaging?tab=voices" className="underline">Import one on the Voices page</Link>
                    {' '}— or drop WAVs into <code>state/voices/</code> on the host (the legacy{' '}
                    <code>state/chatterbox-voices/</code> is still read). Personas can
                    override this on the Personas page.
                  </div>
                </>
              ) : (
                <div className="field-hint">
                  No reference voices yet, so the engine uses its built-in default voice.{' '}
                  <Link href="/admin/imaging?tab=voices" className="underline">Import a 5-second clip on the Voices page</Link>
                  {' '}to enable cloning.
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
                    <SelectTrigger aria-label="PocketTTS voice"><SelectValue /></SelectTrigger>
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
                    English, French, German, Italian, Spanish and Portuguese. To clone a
                    voice,{' '}
                    <Link href="/admin/imaging?tab=voices" className="underline">import a ~5-second clip on the Voices page</Link>
                    {' '}and it will appear under <em>Custom</em>. Personas can override this
                    on the Personas page.
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
          const providerIds = data.tts?.cloudProviders
            || ['openai', 'elevenlabs', 'fish-audio', 'openai-compatible'];
          return (
          // Three ordered steps — provider, then credentials, then what to
          // render with. Model and voice discovery both depend on the
          // credentials, so those have to come first; they used to sit below,
          // under hints telling the operator to look "above" for them.
          <div className="mt-4 grid gap-[26px]">
            <div className="field">
              <Label>Provider</Label>
              <CloudProviderSelector
                value={form.tts.cloud.provider}
                providerIds={providerIds}
                availability={{
                  cloudByProvider: resolveKeyPresence(providerIds, available.cloudByProvider, data.env),
                  compatBaseUrlSet: !!form.tts.cloud.baseUrl.trim(),
                }}
                onChange={v => setForm(f => selectCloudProvider(f, v))}
                // Connection is the very next block, and it carries its own
                // KeyStatus — a "next step" note here would just bounce the eye.
                enableHint={false}
                gridClassName="md:grid-cols-4"
                hint={<>
                  Which service renders Cloud speech. Each provider keeps its own
                  key, model and voice, so switching here doesn’t carry the last
                  one’s settings across.
                </>}
              />
            </div>

            <div className="grid gap-3.5">
              <GroupHead>Connection</GroupHead>
              {isCompat && (
                <div className="field">
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
              {!isCompat && (() => {
                const cloudKeyVar = envKeyForCloudProvider(form.tts.cloud.provider);
                return (
                  <>
                    <div className="field">
                      <Label>{cloudProviderLabel(form.tts.cloud.provider)} API key</Label>
                      <div className="flex flex-wrap items-stretch gap-2 sm:flex-nowrap">
                        <Input
                          type="password"
                          autoComplete="off"
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
                    <KeyStatus envVar={cloudKeyVar} present={!!data.env?.[cloudKeyVar]} />
                  </>
                );
              })()}
              {isCompat && (
                <div className="field">
                  <Label>API key</Label>
                  <Input
                    type="password"
                    autoComplete="off"
                    value={compatKeyInput}
                    placeholder={savedCloud.apiKey === 'set' ? '•••••• (on file)' : 'Optional'}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setCompatKeyInput(e.target.value)}
                    className="max-w-[360px]"
                  />
                  <div className="field-hint">
                    Optional, only if your server requires one (e.g. SUB/WAVE DJ
                    Brain); most self-hosted servers accept any non-empty key.
                    Blank keeps the existing key. Saved with these settings, takes
                    effect immediately.
                  </div>
                </div>
              )}
            </div>

            <div className="grid gap-3.5">
              <GroupHead>Model &amp; voice</GroupHead>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-[18px]">
                <div className="field">
                  <Label>Model</Label>
                  <div className="flex flex-wrap items-stretch gap-2 sm:flex-nowrap">
                    {isFish ? (
                      <>
                        <Input
                          list="fish-audio-models"
                          value={form.tts.cloud.model}
                          maxLength={100}
                          onChange={(e: ChangeEvent<HTMLInputElement>) =>
                            setForm(f => ({ ...f, tts: { ...f.tts, cloud: { ...f.tts.cloud, model: e.target.value } } }))
                          }
                          placeholder="s2.1-pro"
                          className="max-w-[360px]"
                        />
                        <datalist id="fish-audio-models">
                          {CLOUD_MODELS['fish-audio'].map(model => <option key={model} value={model} />)}
                        </datalist>
                      </>
                    ) : ttsDiscovery.models.length > 0 ? (
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
                    {isFish
                      ? <>Use <code>s2.1-pro</code> for the full model or <code>s2.1-pro-free</code> for the free tier. You can also type a custom Fish model id.</>
                      : ttsDiscovery.models.length > 0
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
                  const provider = form.tts.cloud.provider;
                  const voice = form.tts.cloud.voice.trim();
                  const isPreset = isKnownCloudVoice(provider, discoveredVoices, voice);
                  const setVoice = (v: string) =>
                    setForm(f => ({ ...f, tts: { ...f.tts, cloud: { ...f.tts.cloud, voice: v } } }));
                  // A compat server that advertised no voices leaves nothing to pick
                  // from — keep the plain text box it had before discovery.
                  const hasList = discoveredVoices.length > 0 || !isCompat;
                  if (!hasList) {
                    return (
                      <div className="field">
                        <Label>Default voice</Label>
                        <Input
                          value={form.tts.cloud.voice}
                          maxLength={100}
                          placeholder="Server-specific (cloning ref or speaker id)"
                          onChange={(e: ChangeEvent<HTMLInputElement>) => setVoice(e.target.value)}
                        />
                        <div className="field-hint">
                          {voiceDiscovery.loading
                            ? 'Checking the server for a voice list…'
                            : <>Server-specific: Chatterbox cloning ref name, Qwen3
                                speaker id, etc. Leave blank to let the server pick its
                                own default.</>}
                        </div>
                      </div>
                    );
                  }
                  return (
                    <div className="field">
                      <Label>Default voice</Label>
                      <div className="flex items-stretch gap-2">
                        <VoicePicker
                          value={isPreset ? voice : CUSTOM_VOICE_ID}
                          onChange={val => {
                            // Clearing the preset flips isPreset false, revealing the
                            // free-text input below.
                            setVoice(val === CUSTOM_VOICE_ID ? '' : val);
                          }}
                          groups={buildCloudVoiceGroups(provider, discoveredVoices)}
                          title="Default cloud voice"
                          preview={{
                            engine: 'cloud',
                            cloudProvider: provider,
                            cloudModel: form.tts.cloud.model,
                            fishSettings: provider === 'fish-audio'
                              ? {
                                temperature: form.tts.cloud.temperature,
                                topP: form.tts.cloud.topP,
                                latency: form.tts.cloud.latency,
                              }
                              : undefined,
                            adminFetch,
                          }}
                        />
                        <Btn onClick={voiceDiscovery.refresh} title="Refresh voice list">↻</Btn>
                      </div>
                      {!isPreset && (
                        <Input
                          // A blank compat voice is legitimate — the server picks
                          // its own default — so don't flag it red.
                          className={cn('mt-2', voice || isCompat ? 'border-ink' : 'border-[var(--danger)]')}
                          value={form.tts.cloud.voice}
                          maxLength={100}
                          placeholder={isCompat ? 'Blank = server default' : 'Enter a custom voice id'}
                          onChange={(e: ChangeEvent<HTMLInputElement>) => setVoice(e.target.value)}
                        />
                      )}
                      <div className="field-hint">
                        Used when a Cloud persona hasn’t set its own voice.{' '}
                        {discoveredVoices.length > 0
                          ? <>{discoveredVoices.length} voice{discoveredVoices.length === 1 ? '' : 's'} found
                              on your {isCompat ? 'server' : 'account'}. Or choose <em>Custom voice id…</em> to
                              enter one that isn’t listed.</>
                          : <>Pick a default, or choose <em>Custom voice id…</em> for any other OpenAI voice
                              name, ElevenLabs voice id, or Fish Audio reference id.</>}
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>

            <div className="grid">
              <GroupHead>Voice tuning</GroupHead>
              <TtsGainField engineId="cloud" form={form} setForm={setForm} />
              <TtsSpeedField engineId="cloud" form={form} setForm={setForm} />
              {form.tts.cloud.provider === 'elevenlabs' && (
                <ElevenLabsVoiceSettingsField form={form} setForm={setForm} />
              )}
              {isFish && <FishAudioSettingsField form={form} setForm={setForm} />}
              {isCompat && <CompatParamsField form={form} setForm={setForm} />}
            </div>
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
                Any self-hosted TTS server that renders audio over HTTP: POST{' '}
                <code>/speak</code> returns the audio in the response body, gated
                on a <code>/health</code> probe (Qwen3-TTS clone, F5-TTS,
                CosyVoice, your own server…). The audio comes back over the wire,
                so no shared volume is needed. Must be reachable from the
                controller container. Use the host&apos;s LAN or Tailscale IP,
                not <code>127.0.0.1</code>.
              </div>
            </div>
            <TtsGainField engineId="remote" form={form} setForm={setForm} />
            <TtsSpeedField engineId="remote" form={form} setForm={setForm} />
          </div>
          );
        })()}

          {(() => {
            const e = form.tts.defaultEngine;
            const previewVoice = defaultEngineVoice(e, form.tts);
            return (
              <div className="field">
                <VoicePreviewButton
                  engine={e}
                  voice={previewVoice}
                  cloudProvider={form.tts.cloud.provider}
                  cloudModel={e === 'cloud' ? form.tts.cloud.model : undefined}
                  speed={form.tts.speed?.[e] ?? 1}
                  lang={form.kokoroLang || undefined}
                  // Unsaved ElevenLabs sliders ride along so "Play sample"
                  // auditions the current knob positions, not the last save.
                  voiceSettings={e === 'cloud' && form.tts.cloud.provider === 'elevenlabs'
                    ? {
                      voiceStability: form.tts.cloud.voiceStability,
                      voiceStyle: form.tts.cloud.voiceStyle,
                      voiceSimilarityBoost: form.tts.cloud.voiceSimilarityBoost,
                      voiceUseSpeakerBoost: form.tts.cloud.voiceUseSpeakerBoost,
                    }
                    : undefined}
                  fishSettings={e === 'cloud' && isFish
                    ? {
                      temperature: form.tts.cloud.temperature,
                      topP: form.tts.cloud.topP,
                      latency: form.tts.cloud.latency,
                    }
                    : undefined}
                  adminFetch={adminFetch}
                />
                <div className="field-hint">
                  Plays a short sample in the selected engine &amp; voice. Reflects voice
                  and speed; the dB trim is applied later, on air.
                  {e === 'kokoro' || e === 'pocket-tts' ? "Sample text is English; non-English language settings may sound strange" : ""}
                </div>
              </div>
            );
          })()}
        </div>
      </Card>

      {/* The operator's explicit rescue, ahead of the hardcoded
          default-engine → Piper → Kokoro floor. */}
      <Card
        title="Fallback voice"
        sub="what speaks when a persona's engine fails"
      >
        <div className="field">
          <Label>Fallback</Label>
          <Seg
            value={form.tts.fallback.enabled ? 'on' : 'off'}
            options={[{ id: 'off', label: 'Off' }, { id: 'on', label: 'On' }]}
            onChange={v => setForm(f => ({
              ...f,
              tts: { ...f.tts, fallback: { ...f.tts.fallback, enabled: v === 'on' } },
            }))}
          />
          <div className="field-hint max-w-[70ch]">
            When a persona’s engine can’t speak — a sidecar that’s down, a cloud
            provider with no key, or a call that fails mid-render — the station
            rescues the segment so the DJ never goes silent. Off, it rescues onto
            the default engine above and whatever voice that engine happens to
            carry. On, it uses the engine <em>and voice</em> you pick here first,
            and only falls through to Piper if that can’t speak either.
          </div>
        </div>

        {form.tts.fallback.enabled && (
          <div className="mt-4 max-w-[560px]">
            <EngineVoiceFields
              value={form.tts.fallback}
              onChange={(patch: Partial<TtsFallbackForm>) => setForm(f => ({
                ...f,
                tts: { ...f.tts, fallback: { ...f.tts.fallback, ...patch } },
              }))}
              data={data}
              adminFetch={adminFetch}
              engineHint={<>
                Pick something that’s reliably up — a local engine is the safest
                rescue, since the usual reason to need one is a sidecar or cloud
                provider being unreachable.
              </>}
              unavailableNote={(engine: string) => (
                <>{ENGINE_UNAVAILABLE[engine]} A fallback that can’t speak is
                  skipped, so the station would drop to <strong>Piper</strong> instead.</>
              )}
              cloudIssue={fallbackCloudUnconfigured && (
                <>
                  <strong>This fallback voice won’t play.</strong> No API key is
                  configured for that cloud provider — add one above. Until then
                  the fallback is skipped, and the station drops to{' '}
                  <strong>Piper</strong> instead.
                </>
              )}
              previewHint={<>
                Plays a short sample in the fallback voice. Worth auditioning —
                you’ll normally only hear it when something has already gone
                wrong.
              </>}
            />
          </div>
        )}
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
