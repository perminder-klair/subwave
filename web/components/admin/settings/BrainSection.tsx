'use client';

import type { ChangeEvent } from 'react';
import { useRef, useState } from 'react';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { cn } from '../../../lib/cn';
import { adminResponse } from '../../../lib/admin-query';
import { Card, Btn } from '../ui';
import { PERSONA_TTS_INHERIT, personasPinningOtherEngine } from '../../../lib/schemas.generated';
import {
  DJ_BRAIN_BASE_URL, DJ_BRAIN_CHAT_MODEL, DJ_BRAIN_VOICE_MODEL, DJ_BRAIN_SIGNUP_URL,
  brainMayTakeEngine, djBrainSettingsPatch, sameBaseUrl, type DjBrainCheckResult,
} from '../../../lib/djBrain';
import {
  SectionHeader, SaveBar, KeyTestResult,
  type SectionProps,
} from './shared';

interface BrainSectionProps extends SectionProps {
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  refresh: () => void;
}

// One-key setup for the hosted "DJ Brain": one OpenAI-compatible base URL +
// token, wired into settings.llm (provider 'openai-compatible') and, when the
// key's plan includes the studio voice, settings.tts.cloud, in one Save. The
// brain says which plan it is (POST /settings/dj-brain/check); the patch is
// lib/djBrain.ts, shared with the onboarding wizard. A convenience wrapper over
// the LLM provider and TTS voice sections.
export function BrainSection({ data, form, saveSettings, adminFetch, refresh, busy }: BrainSectionProps) {
  // Prefill only when both blocks already point at an openai-compatible
  // endpoint, else the fields show an unrelated model id.
  const llmCompat = form.llm.provider === 'openai-compatible';
  const ttsCompat = form.tts.cloud.provider === 'openai-compatible';
  // One base URL per provider; the compat entry is the one shared with the voice.
  const llmCompatBaseUrl = form.llm.providerBaseUrls?.['openai-compatible'] ?? '';
  const [baseUrl, setBaseUrl] = useState(
    (llmCompat ? llmCompatBaseUrl : (ttsCompat ? form.tts.cloud.baseUrl : '')) || DJ_BRAIN_BASE_URL,
  );
  const [token, setToken] = useState('');
  const [chatModel, setChatModel] = useState(llmCompat ? form.llm.model : '');
  const [voiceModel, setVoiceModel] = useState(ttsCompat ? form.tts.cloud.model : '');
  const [voiceName, setVoiceName] = useState(ttsCompat ? form.tts.cloud.voice : '');

  const [test, setTest] = useState<DjBrainCheckResult | null>(null);
  const [testing, setTesting] = useState(false);

  // These fields are local state, not FormState, so the panel's form-vs-baseline
  // diff cannot see them; report `dirty` ourselves or SaveBar renders no button.
  // Compare against the mounted values so a save settles back to clean.
  const initial = useRef({ baseUrl, chatModel, voiceModel, voiceName });
  const dirty =
    !!token.trim() ||
    baseUrl !== initial.current.baseUrl ||
    chatModel !== initial.current.chatModel ||
    voiceModel !== initial.current.voiceModel ||
    voiceName !== initial.current.voiceName;

  // A persona that PINS an engine beats the station default, so list the ones
  // that will not follow. The helper mirrors controller/src/schemas/persona.ts
  // so browser and server answer "would this persona follow?" alike.
  const personas = (((data.values ?? {}) as { personas?: unknown }).personas) as
    | Array<{
        id?: unknown;
        name?: unknown;
        tts?: { engine?: unknown; cloudProvider?: unknown } | null;
      }>
    | undefined;
  // 'openai-compatible', not just 'cloud': the four cloud providers share a
  // dispatcher but are independent targets, so cloud/openai cannot reach this
  // voice either.
  const pinned = personasPinningOtherEngine(personas, 'cloud', 'openai-compatible');

  // The station's current TTS engine, and whether Save may take it. Only 'piper'
  // (the shipped default nobody chose) is taken automatically; any other engine
  // is an operator decision, left alone with a button to change it deliberately.
  const stationEngine = String(
    (((data.values ?? {}) as { tts?: { defaultEngine?: unknown } }).tts ?? {})
      .defaultEngine ?? 'piper',
  );
  const engineIsDeliberate = !brainMayTakeEngine(stationEngine);

  // Point the station's default engine at the cloud voice, on its own.
  const useCloudEngine = async () => {
    await saveSettings({ tts: { defaultEngine: 'cloud' } });
    refresh();
  };

  // update() replaces the whole personas array, so untouched rows ride along.
  const useStationDefault = async () => {
    if (!Array.isArray(personas)) return;
    const ids = new Set(pinned.map((p) => p.id));
    await saveSettings({
      personas: personas.map((p) =>
        ids.has(String(p.id ?? ''))
          ? { ...p, tts: { ...(p.tts || {}), engine: PERSONA_TTS_INHERIT } }
          : p,
      ),
    });
    refresh();
  };

  // Redaction sentinel from getRedacted(): 'set' = a token is already on file.
  const values = (data.values ?? {}) as Record<string, unknown>;
  const llmKeys = ((values.llm as { keys?: Record<string, unknown> } | undefined)?.keys) || {};
  const llmKeyOnFile = llmKeys['openai-compatible'] === 'set';
  const ttsCloud = (values.tts as { cloud?: { apiKey?: unknown } } | undefined)?.cloud;
  const ttsKeyOnFile = ttsCloud?.apiKey === 'set';
  const keysOnFile = llmKeyOnFile;
  // The brain half is the one every plan needs; the voice half is wired only
  // on a plan with the studio voice, so brain-only is a complete setup.
  const keyState: 'both' | 'brain' | 'none' =
    llmKeyOnFile && ttsKeyOnFile ? 'both' : llmKeyOnFile ? 'brain' : 'none';
  const KEY_TONE = {
    both: { border: 'border-[var(--accent)]', dot: 'bg-[var(--accent)]', text: 'text-[color:var(--accent)]' },
    brain: { border: 'border-[var(--warn,var(--accent))]', dot: 'bg-[var(--warn,var(--accent))]', text: 'text-[color:var(--warn,var(--accent))]' },
    none: { border: 'border-[var(--danger)]', dot: 'bg-[var(--danger)]', text: 'text-[var(--danger)]' },
  }[keyState];
  const keyTitle = {
    both: 'DJ Brain key on file: brain and studio voice',
    brain: 'DJ Brain key on file: brain',
    none: 'DJ Brain key not set',
  }[keyState];
  const keyBlurb = {
    both: 'The brain and the studio voice are wired. Leave the field blank to keep the key.',
    brain: 'The brain is wired and the station speaks with its own voice. On Brain Studio, Save again and the studio voice is wired too.',
    none: 'No key saved yet. Paste it above and Save.',
  }[keyState];

  // Ask the brain what this key includes (POST /settings/dj-brain/check).
  const checkKey = async (): Promise<DjBrainCheckResult> => {
    if (!baseUrl.trim()) return { ok: false, voice: false, message: 'Enter a Base URL first', latencyMs: 0 };
    try {
      const r = await adminResponse(adminFetch, '/settings/dj-brain/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: token.trim(), baseUrl: baseUrl.trim() }),
      });
      return await r.json() as DjBrainCheckResult;
    } catch (e) {
      return { ok: false, voice: false, message: e instanceof Error ? e.message : String(e), latencyMs: 0 };
    }
  };

  const testConnection = async () => {
    setTesting(true);
    setTest(null);
    setTest(await checkKey());
    setTesting(false);
  };

  const save = async () => {
    // The plan decides whether the voice is wired, so a save the brain can't
    // vouch for stops here rather than guessing.
    const check = await checkKey();
    setTest(check);
    if (!check.ok) return;
    const url = baseUrl.trim();
    const chat = chatModel.trim() || DJ_BRAIN_CHAT_MODEL;
    const voiceM = voiceModel.trim() || DJ_BRAIN_VOICE_MODEL;
    const voiceV = voiceName.trim();
    await saveSettings(djBrainSettingsPatch({
      baseUrl: url,
      token,
      chatModel: chat,
      voiceModel: voiceM,
      voiceName: voiceV,
      voice: check.voice,
      stationEngine,
      // The cloud voice is this brain's when it points at the URL being saved
      // (the hosted brain, or one an operator runs elsewhere).
      voiceWiredToBrain: ttsCompat && sameBaseUrl(form.tts.cloud.baseUrl || '', url),
    }));
    initial.current = { baseUrl: url, chatModel: chat, voiceModel: voiceM, voiceName: voiceV };
    setBaseUrl(url);
    setChatModel(chat);
    setVoiceModel(voiceM);
    setVoiceName(voiceV);
    setToken('');
    refresh();
  };

  return (
    <>
      <SectionHeader
        eyebrow="dj brain"
        title="One key wires the DJ's brain, and its voice on Brain Studio."
        sub="SUB/WAVE DJ Brain runs the language model for your station, and on Brain Studio the studio voice too. Paste your key and Save: the station asks the brain which plan the key is on and wires the LLM provider, plus Cloud TTS when the plan has a voice. You can still fine-tune each under LLM provider and TTS voice."
      />
      <p className="mb-4 text-[12px] text-muted">
        No key yet? <a href={DJ_BRAIN_SIGNUP_URL} target="_blank" rel="noreferrer" className="underline">Get one at my.getsubwave.com/brain</a>.
      </p>

      <Card title="DJ Brain endpoint" sub="shared by the brain (LLM) + voice (TTS)">
        <div className="grid gap-[18px]">
          <div className="field">
            <Label>Base URL</Label>
            <Input
              value={baseUrl}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setBaseUrl(e.target.value)}
              placeholder={DJ_BRAIN_BASE_URL}
              className="max-w-[360px]"
            />
            <div className="field-hint">
              Your DJ Brain proxy, including the <code>/v1</code> suffix. Used as
              the base URL for both the LLM and the cloud voice.
            </div>
          </div>

          <div className="field">
            <Label>Access token</Label>
            <div className="flex items-stretch gap-2">
              <Input
                type="password"
                value={token}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setToken(e.target.value)}
                placeholder={keysOnFile ? '•••••• (on file)' : 'Access token'}
                className="max-w-[360px]"
              />
              <Btn onClick={testConnection} disabled={testing || !baseUrl.trim()}>
                {testing ? 'Testing…' : 'Test connection'}
              </Btn>
            </div>
            <div className="field-hint">
              The key from my.getsubwave.com/brain. Saved to <code>settings.json</code>
              {' '}for the LLM, and for the voice on Brain Studio. Leave blank to
              keep the key already on file.
            </div>
          </div>
          {test && <KeyTestResult result={test} />}

          <div className="field">
            <Label>Chat model</Label>
            <Input
              value={chatModel}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setChatModel(e.target.value)}
              placeholder="dj-brain"
              className="max-w-[360px]"
            />
            <div className="field-hint">
              The model id the brain writes scripts and picks tracks with.
              Defaults to <code>dj-brain</code> if left blank.
            </div>
          </div>

          <div className="field">
            <Label>Voice model</Label>
            <Input
              value={voiceModel}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setVoiceModel(e.target.value)}
              placeholder="dj-brain-voice"
              className="max-w-[360px]"
            />
            <div className="field-hint">
              The model id that renders the DJ&apos;s speech, used only on Brain
              Studio. Defaults to <code>dj-brain-voice</code> if left blank.
            </div>
          </div>

          <div className="field">
            <Label>Voice name <span className="font-normal text-muted normal-case">(optional)</span></Label>
            <Input
              value={voiceName}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setVoiceName(e.target.value)}
              placeholder="voice id (optional)"
              className="max-w-[360px]"
            />
            <div className="field-hint">
              A specific voice on the DJ Brain, if it exposes more than one. Leave
              blank to let the server pick its default.
            </div>
          </div>

          {engineIsDeliberate && (
            <div className="field grid gap-2 border border-ink bg-[var(--ink-softer)] p-3">
              <span className="caption">station voice left as {stationEngine}</span>
              <span className="text-[11px] leading-[1.5] text-muted">
                Saving here configures the DJ Brain voice but does not switch the
                station onto it, because <strong>Settings → TTS voice</strong> is
                set to <strong>{stationEngine}</strong> and that was a deliberate
                choice. Personas following the station default will keep using
                {' '}{stationEngine} until you switch it.
              </span>
              <div>
                <Btn onClick={useCloudEngine} disabled={busy}>
                  {busy ? 'Saving…' : 'Switch station voice to the DJ Brain'}
                </Btn>
              </div>
            </div>
          )}

          {pinned.length > 0 && (
            <div className="field grid gap-2 border border-[var(--danger)] bg-[var(--ink-softer)] p-3">
              <span className="text-[11px] font-bold tracking-[0.12em] text-[var(--danger)] uppercase">
                {pinned.length === 1 ? '1 persona will not use this voice' : `${pinned.length} personas will not use this voice`}
              </span>
              <span className="text-[11px] leading-[1.5] text-muted">
                A persona that pins its own engine beats the station default, so
                saving here would configure the cloud voice and never reach it:{' '}
                {pinned.map((p, i) => (
                  <span key={p.id || p.name}>
                    {i > 0 ? ', ' : ''}
                    <strong>{p.name}</strong> ({p.engine})
                  </span>
                ))}
                . Point them at the station default and they follow whatever
                Settings → TTS voice is set to — here, the DJ Brain voice.
              </span>
              <div>
                <Btn onClick={useStationDefault} disabled={busy}>
                  {busy ? 'Saving…' : 'Set them to station default'}
                </Btn>
              </div>
            </div>
          )}

          <div
            className={cn(
              'field flex items-start gap-2.5 border bg-[var(--ink-softer)] p-3',
              KEY_TONE.border,
            )}
          >
            <span className={cn('mt-1 size-1.5 flex-none rounded-full', KEY_TONE.dot)} />
            <div className="grid gap-0.5">
              <span className={cn('text-[11px] font-bold tracking-[0.12em] uppercase', KEY_TONE.text)}>
                {keyTitle}
              </span>
              <span className="text-[11px] leading-[1.5] text-muted">{keyBlurb}</span>
            </div>
          </div>
        </div>
      </Card>

      <SaveBar
        note="Wires settings.llm, and settings.tts.cloud on Brain Studio. Applies to the next LLM call and the next spoken line, no restart."
        busy={busy}
        onSave={save}
        saveLabel="Save DJ Brain"
        dirty={dirty}
      />
    </>
  );
}
