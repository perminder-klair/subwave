'use client';

import { useEffect, useState } from 'react';
import { useAdminAuth } from '../../../lib/adminAuth';
import { useAdminMutation } from '../../../lib/admin-query';
import { Checkbox } from '../../ui/checkbox';
import { Label } from '../../ui/label';
import { Card } from '../ui';
import { ScrollArea } from '../../ui/scroll-area';
import { cn } from '../../../lib/cn';
import { Tool, ToolHeader, ToolContent, ToolInput, ToolOutput } from '../../ai-elements/tool';
import { Conversation, ConversationContent } from '../../ai-elements/conversation';
import { Message, MessageContent, MessageResponse } from '../../ai-elements/message';
import type { DebugLlm } from './types';
import { oneLine } from './format';
import { CallSection, FilterChip, JsonBlock, JsonOrText } from './bits';
import { mapChatRole } from './TtsPanels';
import { debugKeys } from './queries';

function MessageList({ messages }: { messages: Array<{ role?: string; content?: unknown }> }) {
  return (
    // Short exchanges size to content; agent runs (~40 turns) get a bounded,
    // bottom-pinned scroll (same as SessionChat).
    <Conversation className={cn('w-full', messages.length > 4 ? 'h-80' : 'h-auto')}>
      <ConversationContent className="gap-2 p-0">
        {messages.map((m, i) => (
          <Message key={i} from={mapChatRole(m.role)} className="max-w-full gap-0.5">
            <span
              className={cn(
                'text-[9px] tracking-[0.12em] uppercase',
                m.role === 'assistant' ? 'text-vermilion' : 'text-muted',
              )}
            >
              {m.role || 'system'}
            </span>
            <MessageContent className="rounded-none text-[11px] group-[.is-user]:rounded-none group-[.is-user]:bg-[var(--overlay)] group-[.is-user]:px-2.5 group-[.is-user]:py-1.5 group-[.is-user]:text-ink">
              {typeof m.content === 'string' ? (
                <div className="break-words whitespace-pre-wrap">{m.content}</div>
              ) : (
                <JsonBlock value={m.content} />
              )}
            </MessageContent>
          </Message>
        ))}
      </ConversationContent>
    </Conversation>
  );
}

// The ring has no per-tool status flag, so an `error` key on the result is the only
// failure signal; everything else completed.
function toolErrorText(result: unknown): string | undefined {
  if (result && typeof result === 'object' && !Array.isArray(result) && 'error' in result) {
    const e = (result as { error?: unknown }).error;
    if (e != null && e !== false && e !== '') {
      return typeof e === 'string' ? e : JSON.stringify(e);
    }
  }
  return undefined;
}

function ToolList({ calls }: { calls: Array<{ name?: string; args?: unknown; result?: unknown }> }) {
  return (
    <div className="grid gap-1">
      {calls.map((t, i) => {
        const err = toolErrorText(t.result);
        return (
          <Tool
            key={i}
            className="mb-0 w-full rounded-none border-separator-strong bg-[var(--card-bg)]"
          >
            <ToolHeader
              // ToolUIPart types are `tool-${name}`.
              type={`tool-${t.name || 'unknown'}` as `tool-${string}`}
              state={err ? 'output-error' : 'output-available'}
              className="px-2.5 py-1.5"
            />
            <ToolContent className="space-y-2 p-2.5">
              <ToolInput input={t.args ?? {}} />
              <ToolOutput output={err ? undefined : t.result} errorText={err} />
            </ToolContent>
          </Tool>
        );
      })}
    </div>
  );
}


export function LlmCalls({ llm }: { llm: DebugLlm | undefined }) {
  const { adminFetch } = useAdminAuth();
  const calls = llm?.recentCalls || [];
  const [filter, setFilter] = useState('all');
  const kinds = Array.from(new Set(calls.map(c => c.kind).filter(Boolean) as string[]));
  const shown = filter === 'all' ? calls : calls.filter(c => c.kind === filter);

  const dbg = llm?.debug;
  const viaEnv = !!dbg?.viaEnv;
  // Optimistic local view; the 2s /debug poll reconciles it.
  const [override, setOverride] = useState<boolean | null>(null);
  const enabled = override ?? !!dbg?.enabled;
  useEffect(() => { setOverride(null); }, [dbg?.enabled]);
  const toggleRawMutation = useAdminMutation<void, boolean>({
    adminFetch,
    toastOnError: false,
    request: async (next, fetcher) => {
      // Preserve the old posture: only a network failure rolls the optimistic
      // switch back; an HTTP answer is reconciled by the next /debug result.
      await fetcher('/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ llm: { debugRawRequests: next } }),
      });
    },
    onDone: (_data, _next, client) =>
      client.invalidateQueries({ queryKey: debugKeys.status() }),
  });

  const toggleRaw = async (next: boolean) => {
    if (viaEnv) return; // LLM_DEBUG_RAW forces it on — can't change from here
    setOverride(next);
    try {
      await toggleRawMutation.mutateAsync(next);
    } catch {
      setOverride(null);
    }
  };

  return (
    <Card
      title="LLM recent calls"
      sub={`${calls.length} calls · ${llm?.provider || '—'} / ${llm?.activeModel || '—'}`}
      right={
        <div className="flex flex-wrap justify-end gap-1">
          <FilterChip active={filter === 'all'} onClick={() => setFilter('all')}>
            all {calls.length}
          </FilterChip>
          {kinds.map(k => (
            <FilterChip key={k} active={filter === k} onClick={() => setFilter(k)}>
              {k} {calls.filter(c => c.kind === k).length}
            </FilterChip>
          ))}
        </div>
      }
    >
      <div className="mb-2 grid gap-1 border border-separator-strong p-2.5">
        <Label className="flex min-h-9 cursor-pointer flex-wrap items-center gap-2 text-[11px] tracking-[0.12em] text-muted uppercase sm:min-h-0">
          <Checkbox
            checked={enabled}
            disabled={viaEnv}
            onCheckedChange={v => toggleRaw(v === true)}
          />
          Raw request capture {enabled ? 'on' : 'off'}
          {viaEnv && <span className="normal-case">· forced on by LLM_DEBUG_RAW</span>}
        </Label>
        <span className="field-hint">
          last {dbg?.max ?? 10} raw request bodies (newest first) →{' '}
          <code className="break-all">{dbg?.file || `${'…'}/logs/llm-debug.log`}</code>
        </span>
      </div>
      <ScrollArea className="max-h-[600px]">
        <div className="grid gap-1.5">
          {shown.length === 0 && (
            <span className="field-hint text-muted">
              {calls.length === 0 ? 'No calls yet' : 'No calls match this filter'}
            </span>
          )}
          {shown.map((c, i) => (
            <details
              key={i}
              className={cn(
                'border border-separator-strong',
                i === 0 && filter === 'all' ? 'bg-[var(--ink-softer)]' : 'bg-transparent',
              )}
            >
              {/* minmax(0,1fr), not 1fr: an unbroken kind like `djAgentSegment` takes
                  its min-content width and shoves the ms/clock cells off the card. */}
              <summary className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto_auto_auto] items-center gap-2 px-2.5 py-2 sm:gap-2.5">
                <span className={cn('font-bold', c.ok ? 'text-vermilion' : 'text-[var(--danger)]')}>
                  {c.ok ? '✓' : '✗'}
                </span>
                <span className="truncate text-[12px] font-bold">{c.kind}</span>
                <span className="caption text-[10px] whitespace-nowrap">
                  {c.toolCalls?.length ? `🔧 ${c.toolCalls.length}` : ''}
                  {c.steps != null ? `${c.toolCalls?.length ? ' · ' : ''}${c.steps} steps` : ''}
                </span>
                <span className="mono-num text-[11px] text-muted">{c.ms}ms</span>
                <span className="mono-num text-[10px] text-muted">
                  {c.t ? new Date(c.t).toLocaleTimeString('en-GB', { hour12: false }) : '—'}
                </span>
              </summary>
              <div className="grid gap-1 px-2.5 pt-1 pb-2.5">
                <div className="caption text-[9px]">
                  {c.model || '—'}{c.via ? ` · ${c.via}` : ''}
                </div>
                {c.error && (
                  <CallSection label="error" tone="err" preview={oneLine(c.error)}>
                    {c.error}
                  </CallSection>
                )}
                {c.responseText && (
                  <CallSection label="model said instead" tone="err" preview={oneLine(c.responseText)}>
                    {/* Model free text may contain markdown — the one MessageResponse call. */}
                    <MessageResponse className="whitespace-normal">
                      {c.responseText}
                    </MessageResponse>
                  </CallSection>
                )}
                {c.user && (
                  <CallSection label="user" preview={oneLine(c.user)}>
                    <JsonOrText text={c.user} />
                  </CallSection>
                )}
                {(c.system || c.systemPreview) && (
                  <CallSection label="system" preview={oneLine(c.system || c.systemPreview)}>
                    {c.system || `${c.systemPreview}…`}
                  </CallSection>
                )}
                {Array.isArray(c.messages) && c.messages.length > 0 && (
                  <CallSection
                    label="messages"
                    count={c.messages.length}
                    preview={oneLine(c.messages[c.messages.length - 1]?.content)}
                  >
                    <MessageList messages={c.messages} />
                  </CallSection>
                )}
                {Array.isArray(c.toolCalls) && c.toolCalls.length > 0 && (
                  <CallSection
                    label="tools"
                    count={c.toolCalls.length}
                    preview={c.toolCalls.map(t => t.name).join(' → ')}
                  >
                    <ToolList calls={c.toolCalls} />
                  </CallSection>
                )}
                {c.response && (
                  <CallSection label="response" preview={oneLine(c.response)}>
                    <JsonOrText text={c.response} />
                  </CallSection>
                )}
              </div>
            </details>
          ))}
        </div>
      </ScrollArea>
    </Card>
  );
}

