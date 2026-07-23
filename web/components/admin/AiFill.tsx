'use client';

// Shared "describe it → draft it" block for the create/edit forms. The operator
// types what they want, hits Generate, and the parent merges the returned draft
// into its form fields for review (nothing is saved here). Backed by the
// admin-gated /generate/* endpoints, which ride the station's configured LLM.
import { useId, useState } from 'react';
import { Textarea } from '../ui/textarea';
import { Btn } from './ui';
import { errorMessage } from '../../lib/notify';

interface AiFillProps<T> {
  // e.g. '/generate/persona' — the admin-gated generator endpoint.
  endpoint: string;
  // The key the entity is returned under (e.g. 'persona' for { ok, persona }).
  resultKey: string;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  onApply: (value: T) => void;
  placeholder?: string;
  // Extra body fields sent alongside { description } (e.g. theme { mode }).
  extra?: Record<string, unknown>;
  disabled?: boolean;
}

export function AiFill<T = unknown>({
  endpoint,
  resultKey,
  adminFetch,
  onApply,
  placeholder,
  extra,
  disabled,
}: AiFillProps<T>) {
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const hintId = useId();

  const generate = async () => {
    const description = desc.trim();
    if (!description || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await adminFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description, ...(extra || {}) }),
      });
      const j = (await r.json().catch(() => ({}))) as Record<string, unknown> & { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      const value = j[resultKey] as T | undefined;
      if (!value) throw new Error('no draft returned');
      onApply(value);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 border border-soft-border bg-overlay/40 p-3">
      <span id={hintId} className="field-hint">
        Describe what you want. We&apos;ll draft the fields, then you can edit before saving.
      </span>
      <Textarea
        rows={2}
        aria-label="Describe what you want generated"
        aria-describedby={hintId}
        value={desc}
        onChange={(e) => setDesc(e.target.value)}
        maxLength={400}
        placeholder={placeholder || 'e.g. a late-night jazz host with a dry wit'}
        disabled={busy || disabled}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') generate();
        }}
      />
      <div className="flex items-center gap-3">
        <Btn tone="accent" sm onClick={generate} disabled={busy || disabled || !desc.trim()}>
          {busy ? 'Generating…' : 'Generate'}
        </Btn>
        {err && <span role="alert" className="text-[12px] text-destructive">{err}</span>}
      </div>
    </div>
  );
}
