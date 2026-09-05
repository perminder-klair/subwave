'use client';

import type { ChangeEvent } from 'react';
import { useRef, useState } from 'react';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { cn } from '../../../lib/cn';
import { Card, Btn } from '../ui';
import {
  SectionHeader, SaveBar, KeyTestResult,
  type SectionProps,
} from './shared';

interface BrainSectionProps extends SectionProps {
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  refresh: () => void;
}

// One-field setup for the hosted "DJ Brain" — a single OpenAI-compatible proxy
// that fronts BOTH the chat LLM and the cloud TTS voice. The operator pastes one
// base URL + one access token here and Save wires both settings blocks at once:
// settings.llm as provider 'openai-compatible', and settings.tts.cloud as an
// enabled 'openai-compatible' voice with sendSpeed on (the DJ Brain voice
// honours the native `speed` field, so we skip the local atempo stretch). A
// convenience wrapper over the LLM provider + TTS voice sections — either can
// still be tuned individually there.
export function BrainSection({ data, form, saveSettings, adminFetch, refresh, busy }: BrainSectionProps) {
  // Prefill from whatever the two blocks already hold, but only when they're
  // actually pointed at an openai-compatible endpoint — otherwise the fields
  // would show an unrelated OpenAI / ElevenLabs model id.
  const llmCompat = form.llm.provider === 'openai-compatible';
  const ttsCompat = form.tts.cloud.provider === 'openai-compatible';
  // The LLM form keeps one base URL per provider (providerBaseUrls), so the
  // compat entry is the one this section shares with the voice.
  const llmCompatBaseUrl = form.llm.providerBaseUrls?.['openai-compatible'] ?? '';
  const [baseUrl, setBaseUrl] = useState(
    llmCompat ? llmCompatBaseUrl : (ttsCompat ? form.tts.cloud.baseUrl : ''),
  );
  const [token, setToken] = useState('');
  const [chatModel, setChatModel] = useState(llmCompat ? form.llm.model : '');
  const [voiceModel, setVoiceModel] = useState(ttsCompat ? form.tts.cloud.model : '');
  const [voiceName, setVoiceName] = useState(ttsCompat ? form.tts.cloud.voice : '');

  const [test, setTest] = useState<{ ok: boolean; message: string; latencyMs: number } | null>(null);
  const [testing, setTesting] = useState(false);

  // This section's fields are plain local state, not FormState, so the panel's
  // form-vs-baseline diff can never see an edit here. SettingsPanel only mounts
  // the save slot while SOMETHING is dirty, so without reporting it ourselves
  // SaveBar portals into nothing and the section renders no Save button at all
  // — the same reason LlmSection/TtsSection/LibrarySection pass `dirty` for
  // their own local key inputs. Compare against the values we mounted with
  // rather than against `form`, so a save (which refreshes `form`) settles
  // back to clean instead of latching dirty forever.
  const initial = useRef({ baseUrl, chatModel, voiceModel, voiceName });
  const dirty =
    !!token.trim() ||
    baseUrl !== initial.current.baseUrl ||
    chatModel !== initial.current.chatModel ||
    voiceModel !== initial.current.voiceModel ||
    voiceName !== initial.current.voiceName;

  // Redaction sentinel from getRedacted(): 'set' means a token is already on
  // file for that block. Both blocks share the same DJ Brain token in practice.
  const values = (data.values ?? {}) as Record<string, unknown>;
  const llmKeys = ((values.llm as { keys?: Record<string, unknown> } | undefined)?.keys) || {};
  const llmKeyOnFile = llmKeys['openai-compatible'] === 'set';
  const ttsCloud = (values.tts as { cloud?: { apiKey?: unknown } } | undefined)?.cloud;
  const ttsKeyOnFile = ttsCloud?.apiKey === 'set';
  const keysOnFile = llmKeyOnFile && ttsKeyOnFile;
  // Three states, not two. A section that says a flat red "token not set" while
  // the brain half is genuinely configured reads as broken — which is exactly
  // what an operator sees straight after the onboarding wizard, since that
  // wires settings.llm and leaves the voice for this section. Name the half
  // that is missing, and keep red for "neither".
  const keyState: 'both' | 'partial' | 'none' =
    keysOnFile ? 'both' : (llmKeyOnFile || ttsKeyOnFile) ? 'partial' : 'none';
  const missingHalf = llmKeyOnFile ? 'voice (Cloud TTS)' : 'brain (LLM)';
  const KEY_TONE = {
    both: { border: 'border-[var(--accent)]', dot: 'bg-[var(--accent)]', text: 'text-[color:var(--accent)]' },
    partial: { border: 'border-[var(--warn,var(--accent))]', dot: 'bg-[var(--warn,var(--accent))]', text: 'text-[color:var(--warn,var(--accent))]' },
    none: { border: 'border-[var(--danger)]', dot: 'bg-[var(--danger)]', text: 'text-[var(--danger)]' },
  }[keyState];
  const keyTitle = {
    both: 'DJ Brain token on file',
    partial: `DJ Brain token on file for the ${llmKeyOnFile ? 'brain' : 'voice'} only`,
    none: 'DJ Brain token not set',
  }[keyState];
  const keyBlurb = {
    both: 'Both the brain and the voice have a token saved. Leave the field blank to keep it.',
    partial: `The ${llmKeyOnFile ? 'brain (LLM)' : 'voice (Cloud TTS)'} has a token saved; the ${missingHalf} does not. Paste it above and Save to wire both.`,
    none: 'No token saved yet for the brain or the voice. Paste it above and Save.',
  }[keyState];

  // Reuse the LLM openai-compatible probe (POST /settings/llm/probe-compat) to
  // verify the base URL + token + chat model before saving.
  const testConnection = async () => {
    if (!baseUrl.trim()) { setTest({ ok: false, message: 'Enter a Base URL first', latencyMs: 0 }); return; }
    if (!chatModel.trim()) { setTest({ ok: false, message: 'Enter a Chat model first', latencyMs: 0 }); return; }
    setTesting(true);
    setTest(null);
    try {
      const r = await adminFetch('/settings/llm/probe-compat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: token.trim(), baseUrl: baseUrl.trim(), model: chatModel.trim() }),
      });
      setTest(await r.json() as { ok: boolean; message: string; latencyMs: number });
    } catch (e) {
      setTest({ ok: false, message: e instanceof Error ? e.message : String(e), latencyMs: 0 });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    const url = baseUrl.trim();
    // The hosted DJ Brain exposes `dj-brain` / `dj-brain-voice` — fall back to
    // those when the operator leaves a model blank so a bare one-field setup
    // still saves (the compat blocks reject an empty model id).
    const chat = chatModel.trim() || 'dj-brain';
    const voiceM = voiceModel.trim() || 'dj-brain-voice';
    const voiceV = voiceName.trim();
    const typedToken = token.trim();
    await saveSettings({
      llm: {
        provider: 'openai-compatible',
        baseUrl: url,
        model: chat,
        // Only send the key when one was typed — an absent apiKey leaves the
        // stored token untouched (settings.update routes it via applyInlineKey,
        // and the redaction sentinel is a no-op there too).
        ...(typedToken ? { apiKey: typedToken } : {}),
      },
      tts: {
        cloud: {
          enabled: true,
          provider: 'openai-compatible',
          baseUrl: url,
          model: voiceM,
          voice: voiceV,
          // DJ Brain voice honours native `speed`, so skip the local atempo
          // stretch (issue #942 escape hatch).
          sendSpeed: true,
          ...(typedToken ? { apiKey: typedToken } : {}),
        },
      },
    });
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
        title="One URL and one token wire the DJ's brain and its voice."
        sub="The hosted DJ Brain fronts the chat LLM and the cloud TTS voice behind a single OpenAI-compatible proxy. Paste its base URL and access token once — Save configures both the LLM provider and Cloud TTS in one go. You can still fine-tune each under LLM provider and TTS voice."
      />

      <Card title="DJ Brain endpoint" sub="shared by the brain (LLM) + voice (TTS)">
        <div className="grid gap-[18px]">
          <div className="field">
            <Label>Base URL</Label>
            <Input
              value={baseUrl}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setBaseUrl(e.target.value)}
              placeholder="https://my.getsubwave.com/v1"
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
              The access token for your DJ Brain. Saved to <code>settings.json</code>
              {' '}for both the LLM and the voice. Leave blank to keep the token
              already on file.
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
              The model id that renders the DJ&apos;s speech. Defaults to{' '}
              <code>dj-brain-voice</code> if left blank.
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
        note="Wires both settings.llm and settings.tts.cloud. Applies to the next LLM call and the next spoken line, no restart."
        busy={busy}
        onSave={save}
        saveLabel="Save DJ Brain"
        dirty={dirty}
      />
    </>
  );
}
