'use client';

import type { ChangeEvent, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { notify, errorMessage } from '../../../lib/notify';
import { useModelDiscovery } from '@/hooks/useModelDiscovery';
import { CLOUD_VOICES, CLOUD_MODELS } from '../../../lib/cloudVoices';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectGroup, SelectLabel,
} from '../../ui/select';
import { Card, Btn, Pill, Seg } from '../ui';
import { ScrollArea } from '../../ui/scroll-area';
import { Trash2 } from 'lucide-react';
import { EngineSelector } from '../tts/EngineSelector';
import { VoicePreviewButton } from '../tts/VoicePreviewButton';
import { ModelCombobox } from '../llm/ModelCombobox';
import { cn } from '../../../lib/cn';
import {
  SectionHeader, SaveBar, KeyStatus, KeyTestResult, KEY_HINTS, ELEVENLABS_VS_DEFAULTS,
  type SectionProps, type FormState, type FormUpdater, type CloudTtsCfg,
} from './shared';

// Labels for Kokoro phonemizer language override options. Keyed by the lang
// codes exposed by the controller (synced with KOKORO_LANGS in settings.ts).
const KOKORO_LANG_LABELS: Record<string, string> = {
  'en-gb': 'English (UK)',
  'en-us': 'English (US)',
  cmn: 'Chinese (Mandarin)',
  fr: 'French',
  hi: 'Hindi',
  it: 'Italian',
  ja: 'Japanese',
  'pt-br': 'Portuguese (Brazilian)',
  es: 'Spanish',
};

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

// ElevenLabs voice_settings — the four expressive knobs their API takes on
// every request. Ranges match ElevenLabs' native 0..1 (stability, style,
// similarity_boost) plus the boolean use_speaker_boost. Rendered only when the
// cloud provider is `elevenlabs` — other providers ignore the fields, so
// showing them there would be misleading. Design matches TtsGainField /
// TtsSpeedField exactly (same field class, same 360px cap, same label +
// tabular readout row) so the block blends into the surrounding form.
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
        <>Lower is more expressive but can wander; higher is steadier but flatter. ElevenLabs default is <code>50%</code>. Note: the <code>eleven_v3</code> model only accepts 0%, 50% or 100% — other values are rounded to the nearest.</>,
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

export function TtsSection({ data, form, setForm, busy, saveSettings, adminFetch, refresh }: TtsSectionProps) {
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
        },
        remote: { url: form.tts.remote.url },
        // Per-engine voice-level trim. Always sent (server clamps + drops unknown
        // keys); keyed by engine id, `pocket-tts` with the hyphen.
        gainDb: form.tts.gainDb,
        // Per-engine speech speed (×). Same contract as gainDb; inert for the
        // engines whose workers ignore speed (chatterbox/pocket-tts).
        speed: form.tts.speed,
        // Whole-list replace. Rows with an empty "text on air" are drafts the
        // operator never filled in — dropped, not an error.
        corrections: form.tts.corrections
          .map(c => ({ from: c.from.trim(), to: c.to.trim() }))
          .filter(c => c.from),
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

  type SavedCloud = {
    provider?: string;
    voice?: string;
    model?: string;
    baseUrl?: string;
    voiceStability?: number;
    voiceStyle?: number;
    voiceSimilarityBoost?: number;
    voiceUseSpeakerBoost?: boolean;
  };
  const savedTts: {
    defaultEngine?: string;
    kokoro?: { voice?: string; lang?: string };
    chatterbox?: { referenceVoice?: string };
    pocketTts?: { voice?: string };
    cloud?: SavedCloud;
    remote?: { url?: string };
    gainDb?: Record<string, number>;
    speed?: Record<string, number>;
    corrections?: { from?: string; to?: string }[];
  } = data.values?.tts || {};
  const savedEngine: string = savedTts.defaultEngine || 'piper';
  const savedKokoroVoice: string = savedTts.kokoro?.voice || '';
  const savedKokoroLang: string = savedTts.kokoro?.lang || '';
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

  // Compare what save() would actually send (trimmed, draft rows dropped)
  // against the saved list, so an untouched empty draft row isn't "unsaved".
  const effectiveCorrections = (form.tts.corrections || [])
    .map(c => ({ from: (c.from || '').trim(), to: (c.to || '').trim() }))
    .filter(c => c.from);
  const savedCorrections = (savedTts.corrections || [])
    .map(c => ({ from: c.from ?? '', to: c.to ?? '' }));
  const correctionsDirty =
    JSON.stringify(effectiveCorrections) !== JSON.stringify(savedCorrections);

  const ttsDirty =
    form.tts.defaultEngine !== savedEngine
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
    || (form.tts.remote.url || '').trim() !== savedRemoteUrl
    || gainDirty
    || speedDirty
    || correctionsDirty;

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
                        <SelectTrigger><SelectValue /></SelectTrigger>
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
                        <SelectTrigger><SelectValue /></SelectTrigger>
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
                  <SelectTrigger className="w-[260px]"><SelectValue /></SelectTrigger>
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
            {form.tts.cloud.provider === 'elevenlabs' && (
              <ElevenLabsVoiceSettingsField form={form} setForm={setForm} />
            )}
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

      <Card title="Speech corrections" sub="pronunciation fixes">
        <div className="field">
          <div className="field-hint">
            Find→replace rules applied to every spoken line before the voice engine
            reads it — for names and terms the engines mispronounce (<em>GHz</em> →
            <em> gigahertz</em>, <em>Hozier</em> → <em>Ho-zeer</em>). Case-insensitive,
            matches whole words and phrases; leave the spoken form empty to drop the
            phrase entirely. Saved rules apply from the next spoken line — no restart.
          </div>
          {/* Capped so a long rule list scrolls instead of stretching the card;
              the pr-2 keeps rows clear of the scrollbar. */}
          <ScrollArea className="max-h-[280px]">
            <div className="flex flex-col gap-2 pr-2">
              {form.tts.corrections.map((c, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <Input
                    value={c.from}
                    onChange={(e: ChangeEvent<HTMLInputElement>) =>
                      setForm(f => ({
                        ...f,
                        tts: {
                          ...f.tts,
                          corrections: f.tts.corrections.map((row, i) =>
                            i === idx ? { ...row, from: e.target.value } : row),
                        },
                      }))
                    }
                    placeholder="text on air (e.g. GHz)"
                    maxLength={80}
                    className="max-w-[220px] min-w-0 flex-1"
                  />
                  <span className="shrink-0 text-[11px] text-muted">reads as</span>
                  <Input
                    value={c.to}
                    onChange={(e: ChangeEvent<HTMLInputElement>) =>
                      setForm(f => ({
                        ...f,
                        tts: {
                          ...f.tts,
                          corrections: f.tts.corrections.map((row, i) =>
                            i === idx ? { ...row, to: e.target.value } : row),
                        },
                      }))
                    }
                    placeholder="spoken form (e.g. gigahertz)"
                    maxLength={160}
                    className="max-w-[260px] min-w-0 flex-1"
                  />
                  <Btn
                    sm
                    title="Remove correction"
                    className="shrink-0"
                    onClick={() =>
                      setForm(f => ({
                        ...f,
                        tts: { ...f.tts, corrections: f.tts.corrections.filter((_, i) => i !== idx) },
                      }))
                    }
                  >
                    <Trash2 size={12} />
                  </Btn>
                </div>
              ))}
            </div>
          </ScrollArea>
          <div>
            <Btn
              // 100 mirrors the server-side TTS_CORRECTIONS_LIMIT.
              disabled={form.tts.corrections.length >= 100}
              onClick={() =>
                setForm(f => ({
                  ...f,
                  tts: { ...f.tts, corrections: [...f.tts.corrections, { from: '', to: '' }] },
                }))
              }
            >
              Add correction
            </Btn>
          </div>
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
