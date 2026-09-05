'use client';
// Engine picker + engine-specific voice selector + sample button, for any
// `{engine, voice, cloudProvider}` voice slot: a persona (`personas[].tts`) and
// the station-wide TTS fallback (`settings.tts.fallback`, which the controller
// hands to speakWith() as a synthetic persona).
import type { ChangeEvent, ReactNode } from 'react';
import Link from 'next/link';
import type { VoiceOption } from '../personas/types';
import type { AdminAuth } from '../../../lib/adminAuth';
import { CLOUD_VOICES } from '../../../lib/cloudVoices';
import {
  buildCloudVoiceGroups, isKnownCloudVoice, providerSupportsDiscovery, CUSTOM_VOICE_ID,
} from '../../../lib/cloudVoiceGroups';
import { useVoiceDiscovery } from '../../../hooks/useVoiceDiscovery';
import {
  CB_DEFAULT_VOICE, KOKORO_RE, CHATTERBOX_VOICE_RE, POCKET_TTS_VOICE_RE,
} from '../personas/constants';
import { EngineSelector } from './EngineSelector';
import { CloudProviderSelector } from './CloudProviderSelector';
import { resolveKeyPresence } from './cloudProviderMeta';
import { VoicePreviewButton } from './VoicePreviewButton';
import { VoicePicker, type VoicePickerGroup } from './VoicePicker';
import { ENGINES, PERSONA_ENGINES, type EngineAvailability } from './engineMeta';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectGroup,
} from '../../ui/select';
import { cn } from '../../../lib/cn';

const ENGINE_IDS = ENGINES.map(e => e.id);
// Personas may also follow the station default; the fallback slot may not.
const PERSONA_ENGINE_IDS = PERSONA_ENGINES.map(e => e.id);

// Matches the controller's shared voice-slot shape (settings/validate.ts
// validateTtsBlock).
export interface VoiceSlot {
  engine: string;
  voice: string;
  cloudProvider: string;
}

// Shared first half of the red notice; each call site appends its own
// consequence. JSX, so it can't live in the React-free engineMeta.ts.
export const ENGINE_UNAVAILABLE: Record<string, ReactNode> = {
  chatterbox: (
    <>
      Chatterbox isn’t currently available. It lives in the optional{' '}
      <code>tts-heavy</code> sidecar. Start it with{' '}
      <code>docker compose --profile tts-heavy up -d</code> (or set{' '}
      <code>COMPOSE_PROFILES=tts-heavy</code> in <code>.env</code>).
    </>
  ),
  'pocket-tts': (
    <>
      PocketTTS isn’t currently available. It lives in the same optional{' '}
      <code>tts-heavy</code> sidecar as Chatterbox. Start it with{' '}
      <code>docker compose --profile tts-heavy up -d</code> (or set{' '}
      <code>COMPOSE_PROFILES=tts-heavy</code> in <code>.env</code>).
    </>
  ),
  remote: (
    <>
      The remote endpoint isn’t reachable. Configure its URL in
      Settings &rarr; Voice.
    </>
  ),
};

// The slice of GET /settings this component reads. Structural on purpose — the
// Personas and Settings pages model the rest of that payload differently.
export interface EngineVoiceData {
  // Which provider keys the controller can see; feeds the Cloud provider badge.
  env?: Record<string, unknown>;
  tts?: {
    kokoroVoices?: string[];
    kokoroVoiceLanguages?: Record<string, string>;
    piperVoices?: string[];
    chatterboxVoices?: string[];
    pocketTtsVoices?: VoiceOption[];
    pocketTtsCustomVoices?: string[];
    available?: EngineAvailability;
    cloudProviders?: string[];
  };
}

interface EngineVoiceFieldsProps {
  value: VoiceSlot;
  onChange: (patch: Partial<VoiceSlot>) => void;
  data: EngineVoiceData | null;
  adminFetch: AdminAuth['adminFetch'];
  // Omitted where the slot has no rate of its own (the fallback slot), which
  // previews at the engine's pace.
  previewSpeed?: number;
  previewLanguage?: string;
  // Body of the red notice when `engine` can't speak; wording is caller-supplied.
  unavailableNote: (engine: string) => ReactNode;
  // Cloud-specific "this won't play" notice (missing key, disabled engine).
  cloudIssue?: ReactNode;
  engineHint?: ReactNode;
  previewHint?: ReactNode;
  // Personas only: offer "Station default" (the 'inherit' engine). The station
  // rescue slot must not — 'inherit' there would name the rung below it in the
  // chain. When set, the caller also supplies the note shown while it is picked,
  // since only it knows which engine the station is on.
  allowInherit?: boolean;
  inheritNote?: ReactNode;
}

export function EngineVoiceFields({
  value, onChange, data, adminFetch,
  previewSpeed, previewLanguage,
  unavailableNote, cloudIssue, engineHint, previewHint,
  allowInherit = false, inheritNote,
}: EngineVoiceFieldsProps) {
  const kokoroVoices: string[] = data?.tts?.kokoroVoices || [];
  const kokoroLanguages = data?.tts?.kokoroVoiceLanguages || {};
  const pocketTtsVoices = data?.tts?.pocketTtsVoices || [];
  // Mirrors the controller's TTS_CLOUD_PROVIDERS, so a payload that predates the
  // field still offers every provider the server accepts.
  const cloudProviders = data?.tts?.cloudProviders
    || ['openai', 'elevenlabs', 'fish-audio', 'openai-compatible'];

  // Every slot uses the station-wide server, so sending no base URL is right —
  // the server falls back to the saved one. ElevenLabs and Fish are gated on a
  // key being set, so we don't fire a request we know will fail.
  const cloudProvider = value.cloudProvider;
  const elevenLabsReady = data?.tts?.available?.cloudByProvider?.elevenlabs !== false;
  const fishReady = data?.tts?.available?.cloudByProvider?.['fish-audio'] !== false;
  const voiceDiscovery = useVoiceDiscovery({
    provider: cloudProvider,
    enabled: value.engine === 'cloud'
      && providerSupportsDiscovery(cloudProvider)
      && (cloudProvider !== 'elevenlabs' || elevenLabsReady)
      && (cloudProvider !== 'fish-audio' || fishReady),
    adminFetch,
  });
  const discoveredVoices = voiceDiscovery.voices;

  // `voice` is one field shared across engines but each validates it
  // differently, so normalize on engine change — a leftover value (a Kokoro id
  // like "bm_george" under pocket-tts) fails the new engine's check on save.
  const selectEngine = (v: string) => {
    const patch: Partial<VoiceSlot> = { engine: v };
    const cur = value.voice.trim();
    if (v === 'inherit') {
      // No engine is known yet, so there is no rule to normalise against — and
      // the stored id is still wanted if the station is on a local engine.
      // resolvePersonaVoiceSlot drops it at speak time when it isn't.
      onChange(patch);
      return;
    }
    if (v === 'cloud') {
      // A discovered voice counts as valid too, or toggling the engine away and
      // back destroys a voice the operator picked from the server's own list.
      if (!isKnownCloudVoice(cloudProvider, discoveredVoices, cur)) {
        const provVoices = CLOUD_VOICES[cloudProvider as keyof typeof CLOUD_VOICES] || [];
        patch.voice = provVoices[0]?.id || cur;
      }
    } else if (v === 'kokoro') {
      if (!KOKORO_RE.test(cur)) patch.voice = 'bf_isabella';
    } else if (v === 'chatterbox') {
      // Empty = built-in voice; a real value must be a .wav filename.
      if (cur && !CHATTERBOX_VOICE_RE.test(cur)) patch.voice = '';
    } else if (v === 'pocket-tts') {
      if (!POCKET_TTS_VOICE_RE.test(cur)) patch.voice = 'alba';
    }
    // Remote engine voices are free text — the sidecar decides. No default.
    onChange(patch);
  };

  // Resolve Cloud against this slot's saved provider even before the Cloud card
  // is selected. openai-compatible has no key-based availability entry and is
  // trusted; unknown providers keep the global status.
  const globalAvail = data?.tts?.available as EngineAvailability | undefined;
  let selectorAvailable = globalAvail;
  if (globalAvail) {
    const cloudByProv = globalAvail.cloudByProvider;
    if (cloudByProv && cloudProvider in cloudByProv) {
      selectorAvailable = { ...globalAvail, cloud: cloudByProv[cloudProvider] };
    } else if (cloudProvider === 'openai-compatible') {
      selectorAvailable = { ...globalAvail, cloud: true };
    }
  }

  // The caller's cloud alert names the provider and says what speaks instead,
  // so it stands in for both generic "not configured" hints below it.
  const cloudAlerted = value.engine === 'cloud' && !!cloudIssue;

  const notice = (engine: string) => (
    <div className="mb-2.5 border border-[var(--danger)] px-3 py-2.5 text-[11px] leading-[1.6] text-[var(--danger)]">
      {unavailableNote(engine)}
    </div>
  );

  return (
    <>
      <div className="field mb-4">
        <Label>Engine</Label>
        <EngineSelector
          value={value.engine}
          engineIds={allowInherit ? PERSONA_ENGINE_IDS : ENGINE_IDS}
          available={selectorAvailable}
          showStatusHint={!cloudAlerted}
          onChange={selectEngine}
        />
        {engineHint && <div className="field-hint max-w-[70ch]">{engineHint}</div>}
      </div>

      {value.engine === 'inherit' && inheritNote && (
        <div className="field-hint mb-4 max-w-[70ch]">{inheritNote}</div>
      )}

      {value.engine === 'piper' && (() => {
        const piperVoices: string[] = data?.tts?.piperVoices || [];
        const selected = value.voice || CB_DEFAULT_VOICE;
        // The default entry auditions with voice '' (the engine's built-in);
        // the sentinel only exists because an empty select value is invalid.
        const groups: VoicePickerGroup[] = [{
          voices: [
            { id: CB_DEFAULT_VOICE, label: 'Built-in default voice', previewVoice: '' },
            ...piperVoices.map(v => ({ id: v, label: v })),
            ...(value.voice && !piperVoices.includes(value.voice)
              ? [{ id: value.voice, label: value.voice, hint: 'missing' }]
              : []),
          ],
        }];
        return (
          <div className="field max-w-[360px]">
            <Label>Voice</Label>
            <VoicePicker
              value={selected}
              onChange={val => onChange({ voice: val === CB_DEFAULT_VOICE ? '' : val })}
              groups={groups}
              title="Piper voice"
              placeholder="Built-in default voice"
              preview={{ engine: 'piper', speed: previewSpeed, language: previewLanguage, adminFetch }}
            />
            <div className="field-hint">
              Piper is fast, local, and keyless. Drop a voice’s <code>.onnx</code> and its{' '}
              <code>.onnx.json</code> manifest into <code>state/voices/</code> on the host (the
              same files Home Assistant uses) and they’ll show up here. Leave on the built-in
              default if you don’t have any.
            </div>
          </div>
        );
      })()}

      {value.engine === 'kokoro' && (() => {
        const voice = value.voice || 'bf_isabella';
        const langPrefix = voice.charAt(0);
        const filtered = kokoroVoices.filter(v => v.startsWith(langPrefix));
        const fmt = (code: string) => {
          const [lg, name = ''] = code.split('_');
          const g = (lg?.[1] ?? '').toUpperCase();
          const n = name.charAt(0).toUpperCase() + name.slice(1);
          return `${n} (${g})`;
        };
        return (
          <div className="field max-w-[320px]">
            <Label>Kokoro voice</Label>
            <div className="field mt-3">
              <Label>Language</Label>
              <Select
                value={langPrefix}
                onValueChange={lang => {
                  const first = kokoroVoices.find(v => v.startsWith(lang));
                  if (first) onChange({ voice: first });
                }}
              >
                <SelectTrigger aria-label="Language"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {Object.entries(kokoroLanguages).map(([k, v]) => (
                      <SelectItem key={k} value={k}>{v}</SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className="field mt-3">
              <Label>Voice</Label>
              <VoicePicker
                value={voice}
                onChange={val => onChange({ voice: val })}
                groups={[{
                  voices: [
                    ...(!filtered.includes(voice) ? [{ id: voice, label: fmt(voice) }] : []),
                    ...filtered.map(v => ({ id: v, label: fmt(v) })),
                  ],
                }]}
                title="Kokoro voice"
                preview={{ engine: 'kokoro', speed: previewSpeed, language: previewLanguage, adminFetch }}
              />
            </div>
            <div className="field-hint">The kokoro-onnx voice id.</div>
          </div>
        );
      })()}

      {value.engine === 'chatterbox' && (() => {
        const cbVoices: string[] = data?.tts?.chatterboxVoices || [];
        // Shared voice folder (issue #213).
        const cbDir = 'state/voices/';
        const cbAvailable = data?.tts?.available?.chatterbox !== false;
        return (
          <div className="field max-w-[360px]">
            {!cbAvailable && notice('chatterbox')}
            <Label>Reference voice</Label>
            <VoicePicker
              value={value.voice || CB_DEFAULT_VOICE}
              onChange={val => onChange({ voice: val === CB_DEFAULT_VOICE ? '' : val })}
              groups={[{
                voices: [
                  { id: CB_DEFAULT_VOICE, label: 'Built-in default voice', previewVoice: '' },
                  ...cbVoices.map(v => ({ id: v, label: v })),
                  ...(value.voice && !cbVoices.includes(value.voice)
                    ? [{ id: value.voice, label: value.voice, hint: 'missing' }]
                    : []),
                ],
              }]}
              title="Chatterbox reference voice"
              placeholder="Built-in default voice"
              preview={{ engine: 'chatterbox', speed: previewSpeed, language: previewLanguage, adminFetch }}
            />
            <div className="field-hint">
              ~5s of clean speech is enough to clone a voice.{' '}
              <Link href="/admin/imaging?tab=voices" className="underline">Import one on the Voices page</Link>
              {' '}— or drop WAVs into <code>{cbDir}</code> on the host — and it’ll show up
              here. Chatterbox also voices paralinguistic tags ([laugh], [sigh], …) the
              DJ may insert.
            </div>
          </div>
        );
      })()}

      {value.engine === 'pocket-tts' && (() => {
        const ptAvailable = data?.tts?.available?.['pocket-tts'] !== false;
        const customVoices: string[] = data?.tts?.pocketTtsCustomVoices || [];
        const selected = value.voice || 'alba';
        const isBuiltin = pocketTtsVoices.some(v => v.id === selected);
        const isCustom = customVoices.includes(selected);
        // null/undefined = not yet known (sidecar still booting). Only false
        // means the engine confirmed it can't clone (issue #238).
        const ptCloning = data?.tts?.available?.pocketTtsCloning;
        const usingClone = isCustom || /\.wav$/i.test(selected);
        return (
          <div className="field max-w-[360px]">
            {!ptAvailable && notice('pocket-tts')}
            {ptAvailable && ptCloning === false && usingClone && (
              <div className="mb-2.5 border border-[var(--danger)] px-3 py-2.5 text-[11px] leading-[1.6] text-[var(--danger)]">
                Voice <strong>cloning is unavailable</strong> in this build, so this
                cloned voice won’t play; PocketTTS reverts to a built-in voice. The
                cloning model (<code>kyutai/pocket-tts</code>) is gated on Hugging Face:
                accept its terms, then set <code>HF_TOKEN</code> in your <code>.env</code>{' '}
                and restart <code>tts-heavy</code>. Built-in voices below work without a token.
              </div>
            )}
            <Label>PocketTTS voice</Label>
            <VoicePicker
              value={selected}
              onChange={val => onChange({ voice: val })}
              groups={[
                { label: 'Built-in', voices: pocketTtsVoices.map(v => ({ id: v.id, label: v.label })) },
                ...(customVoices.length > 0
                  ? [{
                    label: `Custom (cloned)${ptCloning === false ? ', cloning unavailable' : ''}`,
                    voices: customVoices.map(v => ({ id: v, label: v })),
                  }]
                  : []),
                // Voice not currently present: keep it visible so a save
                // round-trips without rewriting, but flag it.
                ...(!isBuiltin && !isCustom && value.voice
                  ? [{
                    label: 'Unknown',
                    voices: [{ id: value.voice, label: value.voice, hint: 'missing' }],
                  }]
                  : []),
              ]}
              title="PocketTTS voice"
              preview={{ engine: 'pocket-tts', speed: previewSpeed, language: previewLanguage, adminFetch }}
            />
            <div className="field-hint">
              CPU-only, ~6× real-time. Built-in voices cover English, French, German,
              Italian, Spanish and Portuguese. To clone one,{' '}
              <Link href="/admin/imaging?tab=voices" className="underline">import a ~5s clip on the Voices page</Link>
              {' '}and it’ll appear under <em>Custom</em> (cloning needs <code>HF_TOKEN</code>;
              see above).
            </div>
          </div>
        );
      })()}

      {value.engine === 'remote' && (() => {
        const remoteAvail = data?.tts?.available?.remote;
        return (
          <div className="field max-w-[360px]">
            {remoteAvail === false && notice('remote')}
            <Label>Remote voice</Label>
            <Input
              aria-label="Remote voice"
              value={value.voice}
              maxLength={100}
              placeholder="Server-specific (id, filename, or VoiceDesign prompt)"
              onChange={(e: ChangeEvent<HTMLInputElement>) => onChange({ voice: e.target.value })}
            />
            <div className="field-hint">
              Free text forwarded to your self-hosted TTS endpoint: a voice
              id, a reference-wav filename, or a VoiceDesign prompt, whatever
              your sidecar accepts. Configure the endpoint URL in Settings
              &rarr; Voice.
            </div>
          </div>
        );
      })()}

      {value.engine === 'cloud' && (() => {
        const isCompat = cloudProvider === 'openai-compatible';
        const voice = value.voice.trim();
        const isPreset = isKnownCloudVoice(cloudProvider, discoveredVoices, voice);
        // A compat server that advertised nothing leaves no list to show, so
        // fall back to a plain text box.
        const hasList = discoveredVoices.length > 0 || !isCompat;
        const voiceGroups = buildCloudVoiceGroups(cloudProvider, discoveredVoices);
        return (
          <>
            {cloudIssue && (
              <div role="alert" className="mb-3.5 border border-[var(--danger)] px-3 py-2.5 text-[11px] leading-[1.6] text-[var(--danger)]">
                {cloudIssue}
              </div>
            )}
            {/* Provider and voice each get their own row: the provider grid is
                four cards wide, and a voice id picked before the provider is
                settled is a voice id that gets thrown away. */}
            <div className="grid gap-4">
              <div className="field">
                <Label>Cloud provider</Label>
                <CloudProviderSelector
                  value={value.cloudProvider}
                  providerIds={cloudProviders}
                  availability={{
                    cloudByProvider: resolveKeyPresence(
                      cloudProviders, data?.tts?.available?.cloudByProvider, data?.env,
                    ),
                  }}
                  onChange={v => {
                    // Switching provider invalidates the old voice id.
                    // openai-compatible has no curated voices, so blank lets
                    // the operator pick from the new server's discovered list.
                    const next = CLOUD_VOICES[v as keyof typeof CLOUD_VOICES]?.[0]?.id || '';
                    onChange({ cloudProvider: v, voice: next });
                  }}
                  enableHint={!cloudAlerted}
                  hint={isCompat
                    ? <>The base URL and model come from the station’s Cloud settings. Only the voice is set here.</>
                    : <>The API key and model come from the station’s Cloud settings. Only the voice is set here.</>}
                />
              </div>
              <div className="field max-w-[420px]">
                <Label>Cloud voice</Label>
                {!hasList ? (
                  <>
                    <Input
                      aria-label="Cloud voice"
                      value={value.voice}
                      maxLength={100}
                      placeholder="Server-specific (cloning ref or speaker id)"
                      onChange={(e: ChangeEvent<HTMLInputElement>) => onChange({ voice: e.target.value })}
                    />
                    <div className="field-hint">
                      {voiceDiscovery.loading
                        ? 'Checking the server for a voice list…'
                        : <>Server-specific: Chatterbox cloning ref name, Qwen3
                            speaker id, etc. Leave blank to let the server pick.</>}
                    </div>
                  </>
                ) : (
                  <>
                    <VoicePicker
                      value={isPreset ? voice : CUSTOM_VOICE_ID}
                      onChange={val => {
                        // Clearing the preset flips isPreset false, which is
                        // what reveals the free-text input below.
                        onChange({ voice: val === CUSTOM_VOICE_ID ? '' : val });
                      }}
                      groups={voiceGroups}
                      title="Cloud voice"
                      preview={{
                        engine: 'cloud',
                        cloudProvider,
                        speed: previewSpeed,
                        adminFetch,
                      }}
                    />
                    {!isPreset && (
                      <Input
                        // A blank compat voice is legitimate — the server picks
                        // its own default — so don't flag it red.
                        className={cn('mt-2', voice || isCompat ? 'border-ink' : 'border-[var(--danger)]')}
                        aria-label="Custom cloud voice id"
                        value={value.voice}
                        maxLength={100}
                        placeholder={isCompat ? 'Blank = server default' : 'Enter a custom voice id'}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange({ voice: e.target.value })}
                      />
                    )}
                    <div className="field-hint">
                      {discoveredVoices.length > 0
                        ? <>{discoveredVoices.length} voice{discoveredVoices.length === 1 ? '' : 's'} found
                            on your {isCompat ? 'server' : 'account'}. Choose <em>Custom voice id…</em> to
                            enter one that isn&apos;t listed.</>
                        : <>Pick a default voice, or choose <em>Custom voice id…</em> to enter your own
                            (e.g. an OpenAI voice name, ElevenLabs voice id, or Fish Audio reference id).</>}
                    </div>
                  </>
                )}
              </div>
            </div>
          </>
        );
      })()}

      <div className="mt-4">
        <VoicePreviewButton
          engine={value.engine}
          voice={value.voice}
          cloudProvider={value.cloudProvider}
          speed={previewSpeed}
          language={previewLanguage}
          adminFetch={adminFetch}
        />
        {previewHint && <div className="field-hint mt-1.5">{previewHint}</div>}
      </div>
    </>
  );
}
