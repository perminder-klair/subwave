'use client';

import type { ChangeEvent, ReactNode } from 'react';
import Link from 'next/link';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { cn } from '../../../lib/cn';
import { Btn } from '../ui';
import { PERSONA_TTS_INHERIT, personasPinningOtherEngine } from '../../../lib/schemas.generated';
import {
  DJ_BRAIN_BASE_URL, DJ_BRAIN_CHAT_MODEL, DJ_BRAIN_SIGNUP_URL,
  isBrainRoute, isBrainVoice, type DjBrainCheckResult,
} from '../../../lib/djBrain';
import { KeyTestResult, type SettingsData, type SaveSettings } from './shared';
import { settingsHref } from './settings-link';

// The hosted DJ Brain is a preset over the openai-compatible LLM provider and
// the openai-compatible cloud voice (lib/djBrain.ts), not a provider of its
// own. It used to have a Settings tab beside the two it writes to; now each of
// those pages shows its own half: the key and plan on LLM provider
// (DjBrainFields), the studio voice on TTS voice (DjBrainVoiceNote). Both read
// what is routed, never a key being on file, so neither can say the brain is
// wired after the provider moved on.

/** The saved LLM route and cloud voice, read the way both pages need them. */
export function savedBrainState(values: SettingsData['values']) {
  const v = (values ?? {}) as {
    llm?: { provider?: string; model?: string; baseUrl?: string; providerBaseUrls?: Record<string, string> };
    tts?: { defaultEngine?: string; cloud?: { enabled?: boolean; provider?: string; baseUrl?: string; compatApiKey?: string } };
  };
  const cloud = v.tts?.cloud ?? {};
  // Stored providerBaseUrls win; the legacy single baseUrl belongs to the
  // provider it was saved with (form-state.ts seeds the form the same way).
  const urls = v.llm?.providerBaseUrls;
  const brainUrl = (urls && typeof urls === 'object'
    ? urls['openai-compatible']
    : v.llm?.provider === 'openai-compatible' ? v.llm?.baseUrl : '') ?? '';
  const routed = isBrainRoute({ provider: v.llm?.provider, baseUrl: brainUrl, model: v.llm?.model });
  return {
    routed,
    brainUrl,
    // A brain-only key switches the cloud voice off but leaves it pointing at
    // the brain, so the address alone would still read as wired.
    voiceWired: routed && cloud.enabled !== false && isBrainVoice(cloud, brainUrl),
    // The cloud voice still runs on a brain even when the LLM moved off it
    // (the operator picked their own provider and left the voice alone).
    voiceOnBrain: cloud.enabled !== false
      && (isBrainVoice(cloud, brainUrl) || isBrainVoice(cloud, DJ_BRAIN_BASE_URL)),
    cloud,
    stationEngine: String(v.tts?.defaultEngine ?? 'piper'),
  };
}

/**
 * The saved cloud voice points at `brainUrl` and holds a key in the compat
 * slot, the one an openai-compatible voice reads (redaction sentinel 'set').
 * A key for any other voice server is not the brain's, so it never counts.
 */
export function brainVoiceKeyOnFile(values: SettingsData['values'], brainUrl: string): boolean {
  const { cloud } = savedBrainState(values);
  return isBrainVoice(cloud, brainUrl) && cloud.compatApiKey === 'set';
}

const TONES = {
  on: { border: 'border-[var(--accent)]', dot: 'bg-[var(--accent)]', text: 'text-[color:var(--accent)]' },
  off: { border: 'border-ink', dot: 'bg-[var(--muted)]', text: 'text-ink' },
};

function StatusBox({ tone, title, children }: { tone: keyof typeof TONES; title: string; children: ReactNode }) {
  const t = TONES[tone];
  return (
    <div className={cn('field flex items-start gap-2.5 border bg-[var(--ink-softer)] p-3', t.border)}>
      <span className={cn('mt-1 size-1.5 flex-none rounded-full', t.dot)} />
      <div className="grid gap-0.5">
        <span className={cn('text-[11px] font-bold tracking-[0.12em] uppercase', t.text)}>{title}</span>
        <span className="text-[14px] leading-[1.5] text-muted">{children}</span>
      </div>
    </div>
  );
}

interface DjBrainFieldsProps {
  data: SettingsData;
  baseUrl: string;
  model: string;
  onBaseUrl: (v: string) => void;
  onModel: (v: string) => void;
  token: string;
  onToken: (v: string) => void;
  /** The LLM key slot the brain shares (openai-compatible) already holds a key. */
  keyOnFile: boolean;
  check: DjBrainCheckResult | null;
  testing: boolean;
  onTest: () => void;
  /** The last check found a studio voice this Save can't wire (no key for its slot). */
  voiceNeedsKey: boolean;
}

/** LLM provider → Provider card, with DJ Brain as the source. */
export function DjBrainFields({
  data, baseUrl, model, onBaseUrl, onModel, token, onToken, keyOnFile, check, testing, onTest, voiceNeedsKey,
}: DjBrainFieldsProps) {
  const saved = savedBrainState(data.values);
  return (
    <>
      <div className="field">
        <Label>DJ Brain key</Label>
        <div className="flex flex-wrap items-stretch gap-2 sm:flex-nowrap">
          <Input
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e: ChangeEvent<HTMLInputElement>) => onToken(e.target.value)}
            placeholder={keyOnFile ? '•••••• (on file)' : 'Paste your key'}
            className="max-w-[360px]"
          />
          <Btn onClick={onTest} disabled={testing || !baseUrl.trim()}>
            {testing ? 'Testing…' : 'Test key'}
          </Btn>
        </div>
        <div className="field-hint">
          One key runs the model that writes scripts and picks tracks, and on Brain
          Studio the studio voice too. Save asks the brain which plan the key is on
          and wires the voice when the plan has one. Saved to <code>settings.json</code>;
          leave blank to keep the key on file. No key yet?{' '}
          <a href={DJ_BRAIN_SIGNUP_URL} target="_blank" rel="noreferrer" className="underline">
            Get one at my.getsubwave.com/brain
          </a>.
        </div>
      </div>
      {check && <KeyTestResult result={check} />}

      {voiceNeedsKey && (
        <StatusBox tone="off" title="Studio voice not wired yet">
          This key&apos;s plan includes the studio voice, but the voice keeps its own
          copy of the key and none is on file. Paste the key again and Save to wire it.
        </StatusBox>
      )}

      {saved.routed ? (
        <StatusBox tone="on" title={saved.voiceWired ? 'DJ Brain is on: brain and studio voice' : 'DJ Brain is on: brain'}>
          {saved.voiceWired ? (
            <>Every LLM call goes to the brain, and the studio voice is set up under{' '}
              <Link href={settingsHref('tts')} className="underline">TTS voice</Link>.</>
          ) : (
            <>Every LLM call goes to the brain. The station speaks with its own voice,
              set under <Link href={settingsHref('tts')} className="underline">TTS voice</Link>.</>
          )}
        </StatusBox>
      ) : (
        <StatusBox tone="off" title="DJ Brain is not on yet">
          {keyOnFile
            ? 'Save to route every LLM call to the brain with the key on file, or paste a new one.'
            : 'Paste your key and Save to route every LLM call to the brain.'}
        </StatusBox>
      )}

      <details className="group">
        <summary className="caption cursor-pointer select-none">Endpoint</summary>
        <div className="mt-3 grid gap-[18px]">
          <div className="field">
            <Label>Base URL</Label>
            <Input
              value={baseUrl}
              onChange={(e: ChangeEvent<HTMLInputElement>) => onBaseUrl(e.target.value)}
              placeholder={DJ_BRAIN_BASE_URL}
              className="max-w-[360px]"
            />
            <div className="field-hint">
              The brain&apos;s address, including the <code>/v1</code> suffix. Change it
              only for a brain you run somewhere else.
            </div>
          </div>
          <div className="field">
            <Label>Model</Label>
            <Input
              value={model}
              onChange={(e: ChangeEvent<HTMLInputElement>) => onModel(e.target.value)}
              placeholder={DJ_BRAIN_CHAT_MODEL}
              className="max-w-[360px]"
            />
            <div className="field-hint">
              The model id the brain serves. Leave it as <code>{DJ_BRAIN_CHAT_MODEL}</code>{' '}
              unless you were given another.
            </div>
          </div>
        </div>
      </details>
    </>
  );
}

interface DjBrainVoiceNoteProps {
  data: SettingsData;
  busy: boolean;
  saveSettings: SaveSettings;
  refresh: () => void | Promise<void>;
}

/**
 * TTS voice → Voice engine card. Renders nothing unless the LLM runs on the DJ
 * Brain. Says whether the studio voice is what the station speaks with, and
 * carries the two things that can stop it: a deliberate station engine (left
 * alone, with a button to switch) and personas that pin their own.
 */
export function DjBrainVoiceNote({ data, busy, saveSettings, refresh }: DjBrainVoiceNoteProps) {
  const saved = savedBrainState(data.values);
  if (!saved.routed) {
    // The LLM moved to another provider but the voice was left on the brain:
    // it still speaks with the key saved for it, so say so rather than hide.
    if (!saved.voiceOnBrain) return null;
    return (
      <div className="field-hint">
        The cloud voice still runs on the DJ Brain studio voice, with the key saved
        for it, although your LLM now uses{' '}
        <Link href={settingsHref('llm')} className="underline">your own provider</Link>.
        Pick another engine below to stop using it.
      </div>
    );
  }

  if (!saved.voiceWired) {
    return (
      <div className="field-hint">
        Your LLM runs on DJ Brain. On Brain Studio the same key covers a studio voice:
        paste the key under{' '}
        <Link href={settingsHref('llm')} className="underline">LLM provider</Link> and
        Save, and it is wired here.
      </div>
    );
  }

  const personas = ((data.values ?? {}) as { personas?: unknown }).personas as
    | Array<{ id?: unknown; name?: unknown; tts?: { engine?: unknown; cloudProvider?: unknown } | null }>
    | undefined;
  // 'openai-compatible', not just 'cloud': the cloud providers share a
  // dispatcher but are independent targets, so cloud/openai cannot reach this
  // voice either.
  const pinned = personasPinningOtherEngine(personas, 'cloud', 'openai-compatible');
  const onAir = saved.stationEngine === 'cloud';

  const useCloudEngine = async () => {
    await saveSettings({ tts: { defaultEngine: 'cloud' } });
    await refresh();
  };

  // update() replaces the whole personas array, so untouched rows ride along.
  const useStationDefault = async () => {
    if (!Array.isArray(personas)) return;
    const ids = new Set(pinned.map(p => p.id));
    await saveSettings({
      personas: personas.map(p =>
        ids.has(String(p.id ?? ''))
          ? { ...p, tts: { ...(p.tts || {}), engine: PERSONA_TTS_INHERIT } }
          : p,
      ),
    });
    await refresh();
  };

  return (
    <>
      {onAir ? (
        <StatusBox tone="on" title="Station voice: the DJ Brain studio voice">
          It runs on your DJ Brain key, kept under{' '}
          <Link href={settingsHref('llm')} className="underline">LLM provider</Link>.
          It appears below as Cloud, OpenAI-compatible, where you can pick a voice.
        </StatusBox>
      ) : (
        <div className="field grid gap-2 border border-ink bg-[var(--ink-softer)] p-3">
          <span className="caption">DJ Brain studio voice is set up, station voice left as {saved.stationEngine}</span>
          <span className="text-[14px] leading-[1.5] text-muted">
            Your DJ Brain plan includes the studio voice, but the station default is{' '}
            <strong>{saved.stationEngine}</strong> and that was a deliberate choice, so
            it was left alone. Personas following the station default keep using{' '}
            {saved.stationEngine} until you switch.
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
            {pinned.length === 1 ? '1 persona will not use the studio voice' : `${pinned.length} personas will not use the studio voice`}
          </span>
          <span className="text-[14px] leading-[1.5] text-muted">
            A persona that pins its own engine beats the station default:{' '}
            {pinned.map((p, i) => (
              <span key={p.id || p.name}>
                {i > 0 ? ', ' : ''}
                <strong>{p.name}</strong> ({p.engine})
              </span>
            ))}
            . Point them at the station default and they follow whatever engine is
            chosen here.
          </span>
          <div>
            <Btn onClick={useStationDefault} disabled={busy}>
              {busy ? 'Saving…' : 'Set them to station default'}
            </Btn>
          </div>
        </div>
      )}
    </>
  );
}
