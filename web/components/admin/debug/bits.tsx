'use client';

import type { ReactNode } from 'react';
import { useState } from 'react';
import { cn } from '../../../lib/cn';
import { CodeBlock, CodeBlockCopyButton } from '../../ai-elements/code-block';
import { prettyMaybeJson } from './format';

export function HealthCell({ label, status, v, sub }: { label: string; status: 'ok' | 'idle' | 'off' | 'down'; v: ReactNode; sub: ReactNode }) {
  const tone =
    status === 'ok' ? 'bg-vermilion'
      : status === 'idle' || status === 'off' ? 'bg-muted'
        : 'bg-[var(--danger)]';
  return (
    // min-w-0 lets the 1fr column shrink below min-content, so an unbroken token
    // (openrouter:openai/gpt-5-mini) wraps instead of spilling into the next cell.
    <div className="grid min-w-0 gap-0.5 border-l border-separator-strong px-3.5 py-3">
      <div className="flex items-center gap-1.5">
        <span className={cn('size-1.5 rounded-full', tone)} />
        <span className="caption">{label}</span>
      </div>
      <div className="min-w-0 text-[13px] leading-snug font-bold break-words">{v}</div>
      <div className="caption text-[9px]">{sub}</div>
    </div>
  );
}

export function KvTable({ obj }: { obj: Record<string, unknown> | null | undefined }) {
  if (!obj || (typeof obj === 'object' && Object.keys(obj).length === 0)) {
    return <span className="field-hint italic">—</span>;
  }
  return (
    <dl className="kv">
      {Object.entries(obj).map(([k, val]) => (
        <KvRow key={k} k={k} val={val} />
      ))}
    </dl>
  );
}

// true for anything JSON.stringify would inline (no nested object/array), so
// a flat array of these reads better comma-joined than as a bracketed,
// quoted JSON dump.
function isFlat(v: unknown): boolean {
  return v === null || (typeof v !== 'object' && typeof v !== 'function');
}

function KvRow({ k, val }: { k: string; val: unknown }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>
        {val === null || val === undefined ? (
          <span className="text-muted italic">null</span>
        ) : Array.isArray(val) && val.every(isFlat) ? (
          val.length ? (
            <span className="break-words">{val.join(', ')}</span>
          ) : (
            <span className="text-muted italic">none</span>
          )
        ) : typeof val === 'object' ? (
          <pre className="m-0 font-[inherit] text-[11px] break-words whitespace-pre-wrap">
            {JSON.stringify(val, null, 2)}
          </pre>
        ) : (
          String(val)
        )}
      </dd>
    </>
  );
}

export function JsonBlock({ value }: { value: unknown }) {
  const code = typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2);
  return (
    <CodeBlock
      code={code}
      language="json"
      className="rounded-none border-separator-strong [&_code]:text-[11px] [&_pre]:p-2.5 [&_pre]:text-[11px]"
    >
      <CodeBlockCopyButton className="absolute top-1 right-1 z-10 size-6" />
    </CodeBlock>
  );
}

export function JsonOrText({ text }: { text: string }) {
  const pretty = prettyMaybeJson(text);
  return pretty !== text ? <JsonBlock value={pretty} /> : <>{text}</>;
}

interface CallSectionProps {
  label: string;
  count?: number;
  preview?: ReactNode;
  tone?: 'err';
  children?: ReactNode;
}

export function CallSection({ label, count, preview, tone, children }: CallSectionProps) {
  // Children of a closed <details> still MOUNT, and eager mounting would tokenize a
  // shiki CodeBlock for every one of the ring's 120 collapsed rows.
  const [open, setOpen] = useState(false);
  return (
    <details
      className="border border-separator-strong bg-bg"
      onToggle={e => setOpen(e.currentTarget.open)}
    >
      <summary className="flex cursor-pointer items-baseline gap-2 px-2 py-1">
        <span className={cn('caption flex-none', tone === 'err' && 'text-[var(--danger)]')}>
          {label}{count != null ? ` · ${count}` : ''}
        </span>
        {preview && (
          <span className="min-w-0 overflow-hidden text-[11px] text-ellipsis whitespace-nowrap text-muted">
            {preview}
          </span>
        )}
      </summary>
      <div
        className={cn(
          'px-2.5 pt-1.5 pb-2.5 text-[11px] break-words whitespace-pre-wrap',
          tone === 'err' ? 'text-[var(--danger)]' : 'text-ink',
        )}
      >
        {open ? children : null}
      </div>
    </details>
  );
}


interface FilterChipProps {
  active: boolean;
  onClick: () => void;
  children?: ReactNode;
}

export function FilterChip({ active, onClick, children }: FilterChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        // 36px tap target on a phone; dense inline-block chip from sm: up.
        'inline-flex min-h-9 cursor-pointer items-center border border-separator-strong px-2 py-0.5 text-[10px] tracking-[0.08em] uppercase sm:inline-block sm:min-h-0',
        active ? 'bg-vermilion text-bg' : 'bg-transparent text-muted',
      )}
    >
      {children}
    </button>
  );
}


