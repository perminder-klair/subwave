'use client';

import { useState } from 'react';
import { V3Alert } from '../../ui/alert';
import { Pill } from '../ui';
import { ScrollArea } from '../../ui/scroll-area';
import { cn } from '../../../lib/cn';
import type { DebugTts, TtsCall } from './types';
import { oneLine } from './format';
import { CallSection, FilterChip } from './bits';

export function TtsRouting({ tts }: { tts: DebugTts }) {
  const s = tts.spoken || {};
  const fellBack = !!s.fellBack;
  const voiceLabel = s.voice
    ? (s.provider ? `${s.provider} / ${s.voice}` : s.voice)
    : null;
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="caption">persona</span>
        <span className="text-[13px] font-bold">{tts.effectivePersona?.name || '—'}</span>
        <span className="caption ml-2">engine</span>
        <Pill
          tone={fellBack ? undefined : 'accent'}
          className={fellBack ? 'border-[var(--danger)] text-[var(--danger)]' : undefined}
        >
          {s.engine || '—'}
        </Pill>
        {voiceLabel && <Pill>{voiceLabel}</Pill>}
        {fellBack && (
          <span className="caption text-[var(--danger)]">
            requested {s.requested} · fell back
          </span>
        )}
        <span className="caption ml-auto">
          jingle · {tts.jingle?.engine || '—'}
        </span>
      </div>
      {fellBack && (
        <V3Alert tone="error" title={`Cloud voice unavailable, speaking via ${s.engine}`}>
          This persona is set to <strong>{s.requested}</strong> TTS, but it isn’t usable
          (switched off, or the provider’s API key is missing). Spoken segments are coming
          out of <strong>{s.engine}</strong> instead. Fix it in Settings → TTS voice.
        </V3Alert>
      )}
      <TtsCallList calls={tts.recentCalls || []} />
    </div>
  );
}

// The raw speak() ring. Danger tone means the call failed outright; "↳ from <engine>"
// means the segment aired, just not through the engine the persona asked for.
function TtsCallList({ calls }: { calls: TtsCall[] }) {
  const [filter, setFilter] = useState('all');
  const kinds = Array.from(new Set(calls.map(c => c.kind).filter(Boolean) as string[]));
  const shown = filter === 'all' ? calls : calls.filter(c => c.kind === filter);
  return (
    <div className="grid gap-1.5">
      <div className="flex flex-wrap items-center gap-1">
        <span className="caption mr-1">recent calls</span>
        <FilterChip active={filter === 'all'} onClick={() => setFilter('all')}>
          all {calls.length}
        </FilterChip>
        {kinds.map(k => (
          <FilterChip key={k} active={filter === k} onClick={() => setFilter(k)}>
            {k} {calls.filter(c => c.kind === k).length}
          </FilterChip>
        ))}
      </div>
      <ScrollArea className="max-h-[420px]">
        <div className="grid gap-1.5">
        {shown.length === 0 && (
          <span className="field-hint text-muted">
            {calls.length === 0 ? 'No spoken segments yet' : 'No calls match this filter'}
          </span>
        )}
        {shown.map((c, i) => (
          <details key={i} className="border border-separator-strong">
            <summary className="grid cursor-pointer grid-cols-[auto_auto_minmax(0,1fr)_auto_auto] items-center gap-2 px-2.5 py-2 sm:gap-2.5">
              <span className={cn('font-bold', c.ok ? 'text-vermilion' : 'text-[var(--danger)]')}>
                {c.ok ? '✓' : '✗'}
              </span>
              <span className="grid min-w-0 leading-tight">
                <span className="truncate text-[12px] font-bold">{c.kind}</span>
                <span className={cn('truncate text-[10px]', c.fellBack ? 'text-[var(--danger)]' : 'text-muted')}>
                  {c.engine}
                </span>
              </span>
              <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                {c.fellBack && (
                  <span className="caption flex-none text-[var(--danger)]">↳ from {c.requested}</span>
                )}
                <span className="min-w-0 overflow-hidden text-[11px] text-ellipsis whitespace-nowrap text-muted">
                  {oneLine(c.text)}
                </span>
              </span>
              <span className="mono-num text-[11px] text-muted">{c.ms}ms</span>
              <span className="mono-num text-[10px] text-muted">
                {c.t ? new Date(c.t).toLocaleTimeString('en-GB', { hour12: false }) : '—'}
              </span>
            </summary>
            <div className="grid gap-1 px-2.5 pt-1 pb-2.5">
              <div className="caption text-[9px]">
                {c.persona ? `${c.persona} · ` : ''}{c.chars ?? 0} chars
                {c.fellBack ? ` · requested ${c.requested}, spoke via ${c.engine}` : ''}
              </div>
              {c.error && (
                <CallSection label="error" tone="err" preview={oneLine(c.error)}>
                  {c.error}
                </CallSection>
              )}
              {c.text && (
                <CallSection label="spoken text" preview={oneLine(c.text)}>
                  {c.text}
                </CallSection>
              )}
            </div>
          </details>
        ))}
        </div>
      </ScrollArea>
    </div>
  );
}

// Session roles are station-specific (dj / track / segment / listener…); only
// user/assistant map straight through, the rest render as "system".
export function mapChatRole(role?: string): 'user' | 'assistant' | 'system' {
  return role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : 'system';
}


