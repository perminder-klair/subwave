'use client';
// Text-to-speech engine, the engine-specific voice selector, and the per-persona
// voice-level trim. Two columns from lg up (engine + selector on the left, the
// level meter on the right) so the card fills the editor width instead of
// stacking in a narrow left strip.
import type { ChangeEvent } from 'react';
import type { Persona, PersonaTts, SettingsResponse } from './types';
import { CLOUD_VOICES } from '../../../lib/cloudVoices';
import { ENGINES, CB_DEFAULT_VOICE, KOKORO_RE, CHATTERBOX_VOICE_RE, POCKET_TTS_VOICE_RE } from './constants';
import { Card, Seg } from '../ui';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectGroup, SelectLabel,
} from '../../ui/select';
import { VoiceMeter } from './VoiceMeter';
import { cn } from '../../../lib/cn';

interface PersonaVoiceCardProps {
  persona: Persona;
  data: SettingsResponse | null;
  defaultEngine: string;
  cloudIssueText: string | null;
  updateTts: (patch: Partial<PersonaTts>) => void;
}

export function PersonaVoiceCard({ persona, data, defaultEngine, cloudIssueText, updateTts }: PersonaVoiceCardProps) {
  const kokoroVoices = data?.tts?.kokoroVoices || [];
  const pocketTtsVoices = data?.tts?.pocketTtsVoices || [];
  const cloudProviders = data?.tts?.cloudProviders || ['openai', 'elevenlabs'];

  const gain = persona.tts.gainDb ?? 0;
  const gainLabel = !gain
    ? '0 dB'
    : `${gain > 0 ? '+' : '−'}${Math.abs(gain).toFixed(1)} dB`;

  const speed = persona.tts.speed ?? 1;
  // Only Piper/Kokoro/cloud honour speed; chatterbox/pocket-tts workers ignore
  // it, so the control is shown but disabled with a hint for those engines.
  const speedSupported = persona.tts.engine !== 'chatterbox' && persona.tts.engine !== 'pocket-tts';

  return (
    <Card title="Voice" sub="text-to-speech engine">
      <div className="lg:grid lg:grid-cols-2 lg:items-start lg:gap-x-8">
        {/* LEFT — engine + the engine-specific voice selector */}
        <div className="min-w-0">
          <div className="field mb-3.5">
            <Label>Engine</Label>
            <Seg
              value={persona.tts.engine}
              options={ENGINES}
              onChange={v => {
                // The `voice` field is shared across engines but each engine
                // validates it differently — a leftover value from the old
                // engine (e.g. a Kokoro id like "bm_george") fails the new
                // engine's check on save. Normalize voice to something the
                // target engine accepts whenever the engine changes.
                const patch: Partial<PersonaTts> = { engine: v };
                const cur = persona.tts.voice.trim();
                if (v === 'cloud') {
                  const provVoices = CLOUD_VOICES[persona.tts.cloudProvider as keyof typeof CLOUD_VOICES] || [];
                  if (!provVoices.some(pv => pv.id === cur)) {
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
                updateTts(patch);
              }}
            />
            <div className="field-hint max-w-[70ch]">
              Piper is local &amp; fast. Kokoro is more natural but slower. Chatterbox
              clones a voice from a reference clip (local, opt-in). Cloud routes through
              OpenAI / ElevenLabs.
            </div>
          </div>

          {persona.tts.engine === 'piper' && (() => {
            const piperVoices: string[] = data?.tts?.piperVoices || [];
            const value = persona.tts.voice || CB_DEFAULT_VOICE;
            return (
              <div className="field max-w-[360px]">
                <Label>Voice</Label>
                <Select
                  value={value}
                  onValueChange={val => updateTts({ voice: val === CB_DEFAULT_VOICE ? '' : val })}
                >
                  <SelectTrigger><SelectValue placeholder="Built-in default voice" /></SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value={CB_DEFAULT_VOICE}>Built-in default voice</SelectItem>
                      {piperVoices.map(v => <SelectItem key={v} value={v}>{v}</SelectItem>)}
                      {persona.tts.voice && !piperVoices.includes(persona.tts.voice) && (
                        <SelectItem value={persona.tts.voice}>{persona.tts.voice} (missing)</SelectItem>
                      )}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <div className="field-hint">
                  Piper is fast, local, and keyless. Drop a voice’s <code>.onnx</code> and its{' '}
                  <code>.onnx.json</code> manifest into <code>state/voices/</code> on the host (the
                  same files Home Assistant uses) and they’ll show up here. Leave on the built-in
                  default if you don’t have any.
                </div>
              </div>
            );
          })()}

          {persona.tts.engine === 'kokoro' && (
            <div className="field max-w-[320px]">
              <Label>Kokoro voice</Label>
              <Select
                value={persona.tts.voice}
                onValueChange={val => updateTts({ voice: val })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {!kokoroVoices.some(v => v.id === persona.tts.voice) && (
                      <SelectItem value={persona.tts.voice}>{persona.tts.voice}</SelectItem>
                    )}
                    {kokoroVoices.map(v => <SelectItem key={v.id} value={v.id}>{v.label}</SelectItem>)}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <div className="field-hint">The kokoro-onnx voice id for this persona.</div>
            </div>
          )}

          {persona.tts.engine === 'chatterbox' && (() => {
            const cbVoices: string[] = data?.tts?.chatterboxVoices || [];
            // Shared voice folder (issue #213). Default to state/voices/ when
            // the controller advertises the new field.
            const cbDir = 'state/voices/';
            const cbAvailable = data?.tts?.available?.chatterbox !== false;
            return (
              <div className="field max-w-[360px]">
                {!cbAvailable && (
                  <div className="mb-2.5 border border-[var(--danger)] px-3 py-2.5 text-[11px] leading-[1.6] text-[var(--danger)]">
                    Chatterbox isn’t currently available. It lives in the optional{' '}
                    <code>tts-heavy</code> sidecar. Start it with{' '}
                    <code>docker compose --profile tts-heavy up -d</code> (or set{' '}
                    <code>COMPOSE_PROFILES=tts-heavy</code> in <code>.env</code>).
                    This persona falls back to <strong>{defaultEngine}</strong> until
                    it’s up.
                  </div>
                )}
                <Label>Reference voice</Label>
                <Select
                  value={persona.tts.voice || CB_DEFAULT_VOICE}
                  onValueChange={val => updateTts({ voice: val === CB_DEFAULT_VOICE ? '' : val })}
                >
                  <SelectTrigger><SelectValue placeholder="Built-in default voice" /></SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value={CB_DEFAULT_VOICE}>Built-in default voice</SelectItem>
                      {cbVoices.map(v => <SelectItem key={v} value={v}>{v}</SelectItem>)}
                      {persona.tts.voice && !cbVoices.includes(persona.tts.voice) && (
                        <SelectItem value={persona.tts.voice}>{persona.tts.voice} (missing)</SelectItem>
                      )}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <div className="field-hint">
                  ~5s of clean speech is enough to clone a voice. Drop WAVs into{' '}
                  <code>{cbDir}</code> on the host and they’ll show up here.
                  Chatterbox also voices paralinguistic tags ([laugh], [sigh], …) the
                  DJ may insert.
                </div>
              </div>
            );
          })()}

          {persona.tts.engine === 'pocket-tts' && (() => {
            const ptAvailable = data?.tts?.available?.['pocket-tts'] !== false;
            const customVoices: string[] = data?.tts?.pocketTtsCustomVoices || [];
            const value = persona.tts.voice || 'alba';
            const isBuiltin = pocketTtsVoices.some(v => v.id === value);
            const isCustom = customVoices.includes(value);
            // null/undefined = not yet known (sidecar still booting). Only
            // false means the engine confirmed it can't clone (issue #238).
            const ptCloning = data?.tts?.available?.pocketTtsCloning;
            const usingClone = isCustom || /\.wav$/i.test(value);
            return (
              <div className="field max-w-[360px]">
                {!ptAvailable && (
                  <div className="mb-2.5 border border-[var(--danger)] px-3 py-2.5 text-[11px] leading-[1.6] text-[var(--danger)]">
                    PocketTTS isn’t currently available. It lives in the same optional{' '}
                    <code>tts-heavy</code> sidecar as Chatterbox. Start it with{' '}
                    <code>docker compose --profile tts-heavy up -d</code> (or set{' '}
                    <code>COMPOSE_PROFILES=tts-heavy</code> in <code>.env</code>).
                    This persona falls back to <strong>{defaultEngine}</strong> until
                    it’s up.
                  </div>
                )}
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
                <Select
                  value={value}
                  onValueChange={val => updateTts({ voice: val })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectLabel>Built-in</SelectLabel>
                      {pocketTtsVoices.map(v => (
                        <SelectItem key={v.id} value={v.id}>{v.label}</SelectItem>
                      ))}
                    </SelectGroup>
                    {customVoices.length > 0 && (
                      <SelectGroup>
                        <SelectLabel>
                          Custom (cloned){ptCloning === false ? ', cloning unavailable' : ''}
                        </SelectLabel>
                        {customVoices.map(v => (
                          <SelectItem key={v} value={v}>{v}</SelectItem>
                        ))}
                      </SelectGroup>
                    )}
                    {!isBuiltin && !isCustom && persona.tts.voice && (
                      // Persona references a voice that isn't currently present —
                      // keep the value visible so a save round-trips without
                      // rewriting, but flag it so the operator notices.
                      <SelectGroup>
                        <SelectLabel>Unknown</SelectLabel>
                        <SelectItem value={persona.tts.voice}>{persona.tts.voice} (missing)</SelectItem>
                      </SelectGroup>
                    )}
                  </SelectContent>
                </Select>
                <div className="field-hint">
                  CPU-only, ~6× real-time. Built-in voices cover English, French, German,
                  Italian, Spanish and Portuguese. Drop a ~5s WAV into{' '}
                  <code>state/voices/</code> to clone a voice; it’ll appear under
                  <em> Custom</em> on next reload (cloning needs <code>HF_TOKEN</code>; see above).
                </div>
              </div>
            );
          })()}

          {persona.tts.engine === 'cloud' && (() => {
            const isCompat = persona.tts.cloudProvider === 'openai-compatible';
            const provVoices = CLOUD_VOICES[persona.tts.cloudProvider as keyof typeof CLOUD_VOICES] || [];
            const voice = persona.tts.voice.trim();
            const isPreset = provVoices.some(v => v.id === voice);
            return (
              <>
                {cloudIssueText && (
                  <div className="mb-3.5 border border-[var(--danger)] px-3 py-2.5 text-[11px] leading-[1.6] text-[var(--danger)]">
                    <strong>This cloud voice won’t play.</strong> {cloudIssueText}{' '}
                    Until that’s fixed, this persona falls back to <strong>{defaultEngine}</strong>.
                  </div>
                )}
                <div className="stack-mobile grid grid-cols-[1fr_1fr] gap-4">
                  <div className="field">
                    <Label>Cloud provider</Label>
                    <Seg
                      value={persona.tts.cloudProvider}
                      options={cloudProviders.map(id => ({ id, label: id }))}
                      onChange={v => {
                        // Switching provider invalidates the old voice id.
                        // openai-compatible has no curated voices — leave the
                        // field blank so the operator types their own (server
                        // picks its default when blank).
                        const next = v === 'openai-compatible'
                          ? ''
                          : (CLOUD_VOICES[v as keyof typeof CLOUD_VOICES]?.[0]?.id || persona.tts.voice);
                        updateTts({ cloudProvider: v, voice: next });
                      }}
                    />
                    <div className="field-hint">
                      {isCompat
                        ? 'Uses the shared base URL + model from Settings.'
                        : 'Uses the shared API key + model from Settings.'}
                    </div>
                  </div>
                  <div className="field">
                    <Label>Cloud voice</Label>
                    {isCompat ? (
                      <>
                        <Input
                          value={persona.tts.voice}
                          maxLength={100}
                          placeholder="Server-specific (cloning ref or speaker id)"
                          onChange={(e: ChangeEvent<HTMLInputElement>) => updateTts({ voice: e.target.value })}
                        />
                        <div className="field-hint">
                          Server-specific: Chatterbox cloning ref name, Qwen3
                          speaker id, etc. Leave blank to let the server pick.
                        </div>
                      </>
                    ) : (
                      <>
                        <Select
                          value={isPreset ? voice : '__custom__'}
                          onValueChange={val => {
                            // "Custom voice id…" clears the preset so isPreset flips
                            // false and the free-text input below appears for entry.
                            updateTts({ voice: val === '__custom__' ? '' : val });
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
                            value={persona.tts.voice}
                            maxLength={100}
                            placeholder="Enter a custom voice id"
                            onChange={(e: ChangeEvent<HTMLInputElement>) => updateTts({ voice: e.target.value })}
                          />
                        )}
                        <div className="field-hint">
                          Pick a default voice, or choose <em>Custom voice id…</em> to enter your own
                          (e.g. an OpenAI voice name or an ElevenLabs voice id).
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </>
            );
          })()}
        </div>

        {/* RIGHT — voice level */}
        <div className="field mt-3.5 max-w-[360px] lg:mt-0 lg:max-w-[460px]">
          <div className="flex items-baseline justify-between gap-3">
            <Label>Voice level (dB)</Label>
            <span className="font-mono text-[15px] font-extrabold text-[var(--accent)] tabular-nums">{gainLabel}</span>
          </div>
          <VoiceMeter
            value={gain}
            onChange={v => updateTts({ gainDb: v })}
          />
          <div className="mt-1.5 flex justify-between text-[8px] font-bold tracking-[0.1em] text-muted tabular-nums">
            <span>−12 dB</span>
            <span className="-translate-x-1/2">0</span>
            <span>+12 dB</span>
          </div>
          <div className="field-hint">
            Trim this persona’s loudness on top of the engine level. <code>0 dB</code> = no change.
            Drag the meter or use the arrow keys.
          </div>

          {/* Speech speed — per-persona rate multiplier (0.5–2.0×). */}
          <div className="field mt-4">
            <div className="flex items-baseline justify-between gap-3">
              <Label>Speech speed</Label>
              <span className="font-mono text-[15px] font-extrabold text-[var(--accent)] tabular-nums">{speed.toFixed(2)}×</span>
            </div>
            <input
              type="range"
              min={0.5}
              max={2}
              step={0.05}
              value={speed}
              disabled={!speedSupported}
              onChange={(e: ChangeEvent<HTMLInputElement>) => updateTts({ speed: Number(e.target.value) })}
              aria-label="Speech speed multiplier"
              className={cn(
                'mt-1.5 w-full accent-[var(--accent)]',
                !speedSupported && 'opacity-40',
              )}
            />
            <div className="mt-1.5 flex justify-between text-[8px] font-bold tracking-[0.1em] text-muted tabular-nums">
              <span>0.5× slower</span>
              <span className="-translate-x-1/2">1.0×</span>
              <span>2.0× faster</span>
            </div>
            <div className="field-hint">
              {speedSupported
                ? <>Slow down or speed up this persona on top of the engine pace. <code>1.00×</code> = no change.</>
                : <>Not supported by this engine — only Piper, Kokoro and cloud honour speed.</>}
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}
