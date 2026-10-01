'use client';

// Google key POOL editor — the companion to the single "Google (Gemini) API
// key" field, which stays exactly as it is for the one-key case.
//
// Why this exists: a free-tier station exhausts a key's daily quota long before
// it notices, so the operator keeps a handful of keys and wants the station to
// fail forward through them. The rotation itself is server-side (see
// `util/google-key-pool.ts`); this only adds, removes and displays.
//
// What crosses the wire is deliberately thin: a fingerprint, a hold timer and a
// reason. No key value is ever rendered here, and none comes back from the
// server — `poolStatus()` masks before it serialises, so there is nothing to
// leak even by accident.

import { useCallback, useState } from 'react';
import type { AdminAuth } from '@/lib/adminAuth';
import { adminResponse } from '@/lib/admin-query';
import { Btn } from '../ui';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { notify } from '@/lib/notify';

export interface GooglePoolKey {
  index: number;
  fingerprint: string;
  name: string;
  held: boolean;
  holdRemainingMs: number;
  reason: 'daily' | 'burst' | 'auth' | 'unknown' | null;
  strikes: number;
  current: boolean;
}

export interface GooglePoolState {
  count: number;
  keys: GooglePoolKey[];
}

function holdLabel(k: GooglePoolKey): string {
  if (!k.held) return '';
  const mins = Math.max(1, Math.round(k.holdRemainingMs / 60000));
  const why = k.reason === 'daily' ? 'daily quota'
    : k.reason === 'burst' ? 'rate limit'
    : k.reason === 'auth' ? 'key rejected'
    : 'no hint from Google';
  // More than one consecutive failure means this key is not clearing on its own,
  // and the hold has grown to match — worth saying, because it is the signal
  // that a key should be replaced rather than waited out.
  const repeat = k.strikes > 1 ? ` · failing ${k.strikes}× in a row` : '';
  return `held ~${mins}m · ${why}${repeat}`;
}

export function GoogleKeyPoolEditor({
  pool,
  adminFetch,
  onChanged,
}: {
  pool?: GooglePoolState;
  adminFetch: AdminAuth['adminFetch'];
  onChanged?: () => void;
}) {
  const [adding, setAdding] = useState('');
  const [addingName, setAddingName] = useState('');
  // Per-row draft for the rename box. An uncontrolled input keeps whatever the
  // operator typed even when the save failed or the server sanitised the value,
  // so it would show a label that is not the one on file. Keying drafts by
  // FINGERPRINT (not index) is what makes them follow a key through a reorder,
  // and remounts the box when the server sends a different stored value.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  // The full pool is only ever known to the server, so a removal has to be sent
  // as a replacement of the whole list — which needs the values we deliberately
  // never receive. Removal therefore goes through a server-side endpoint that
  // edits the stored list in place, addressed by fingerprint.
  const [testingIndex, setTestingIndex] = useState<number | null>(null);

  const keys = pool?.keys ?? [];

  const post = useCallback(async (path: string, body: unknown) => {
    setBusy(true);
    try {
      const r = await adminResponse(adminFetch, path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({})) as { error?: string; ok?: boolean; message?: string };
      if (!r.ok || j.ok === false) {
        notify.err(j.message || j.error || `Request failed (${r.status})`);
        return false;
      }
      return true;
    } catch (e) {
      notify.err(e instanceof Error ? e.message : 'Request failed');
      return false;
    } finally {
      setBusy(false);
    }
  }, [adminFetch]);

  // Every pool call addresses a key by INDEX, so the controls must stay disabled
  // until the refetch that reorders them has landed. Clearing `busy` the moment
  // the POST returned left the OLD rows actionable against the NEW server order,
  // where a Remove or Rename one row too far down deletes a different
  // credential than the one the operator clicked.
  const postAndRefresh = useCallback(async (path: string, body: unknown) => {
    const ok = await post(path, body);
    try {
      await onChanged?.();
    } finally {
      setBusy(false);
    }
    return ok;
  }, [post, onChanged]);

  const addKey = useCallback(async () => {
    const key = adding.trim();
    if (!key) return;
    // Its own endpoint, NOT /settings/secrets: that writer REPLACES the value,
    // and the client cannot build the new list because it is never sent the key
    // values. Posting the new key there replaced the whole pool every time.
    const ok = await postAndRefresh('/settings/google-key-pool/add', { key, name: addingName });
    if (ok) {
      setAdding('');
      setAddingName('');
    }
  }, [adding, addingName, postAndRefresh]);

  const removeKey = useCallback(async (index: number) => {
    const ok = await postAndRefresh('/settings/google-key-pool/remove', { index });
    if (ok) notify.ok('Key removed from the pool');
  }, [postAndRefresh]);

  const moveKey = useCallback(async (from: number, to: number) => {
    if (from === to) return;
    await postAndRefresh('/settings/google-key-pool/move', { from, to });
  }, [postAndRefresh]);

  const renameKey = useCallback(async (index: number, fingerprint: string, name: string) => {
    // Drop the draft FIRST so the input falls back to the server's value: on a
    // failure that means it snaps back to what is actually stored, and on a
    // sanitised name it shows what was kept rather than the raw text.
    setDrafts(d => { const { [fingerprint]: _drop, ...rest } = d; return rest; });
    const ok = await postAndRefresh('/settings/google-key-pool/rename', { index, name });
    if (ok) notify.ok('Key renamed');
  }, [postAndRefresh]);

  const testKey = useCallback(async (index: number) => {
    setTestingIndex(index);
    try {
      const ok = await postAndRefresh('/settings/google-key-pool/test', { index });
      if (ok) notify.ok(`Key ${index + 1} responded`);
    } finally {
      setTestingIndex(null);
    }
  }, [postAndRefresh]);

  return (
    <div className="mt-3 border-t border-[var(--hairline)] pt-3">
      <Label>Gemini key pool</Label>
      <p className="mt-1 text-[12px] text-muted">
        Runs several Gemini keys as one, so a daily free-tier quota running out
        doesn&rsquo;t take the DJ offline.
      </p>

      {keys.length === 0 ? (
        <p className="mt-1 text-[12px] text-muted">
          No pool configured. The single key above is used on its own.
        </p>
      ) : (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] font-bold tracking-[0.16em] text-muted uppercase">
            {/* Column headings, so the row below isn't four unlabelled things.
                Widths match the row exactly — they drift apart the moment a
                label is longer than the column. */}
            <span className="min-w-[140px]">Name</span>
            <span className="min-w-[80px]">Key reference</span>
            <span className="min-w-[150px]">Status</span>
            <span className="ml-auto">Actions</span>
          </div>
          <ul className="mt-1 flex flex-col gap-2">
            {keys.map(k => (
              <li key={`${k.index}-${k.fingerprint}`} className="flex flex-wrap items-center gap-2 text-[12px]">
                <input
                  key={`${k.fingerprint}-${k.name}`}
                  defaultValue={k.name}
                  value={drafts[k.fingerprint] ?? k.name}
                  placeholder="e.g. Free 1"
                  aria-label={`Name for key ${k.index + 1}`}
                  maxLength={60}
                  // Keyed by fingerprint AND stored name, so a refetch carrying
                  // a different value remounts the box. The draft holds whatever
                  // is being typed without firing a request per keystroke.
                  onChange={e => setDrafts(d => ({ ...d, [k.fingerprint]: e.target.value }))}
                  onBlur={e => {
                    const next = e.target.value.trim();
                    if (next !== k.name) void renameKey(k.index, k.fingerprint, next);
                  }}
                  className="min-w-[140px] border border-input bg-field px-2 py-1 text-[12px] text-foreground placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
                />
                <code className="min-w-[80px] text-muted">{k.fingerprint}</code>
                <span className="min-w-[150px] text-muted">
                  {k.current ? 'in use' : 'standby'}
                  {k.held ? ` · ${holdLabel(k)}` : ''}
                </span>
                <span className="ml-auto flex gap-1">
                  <Btn
                    onClick={() => moveKey(k.index, k.index - 1)}
                    disabled={busy || k.index === 0}
                    title="Move up"
                    aria-label={`Move key ${k.index + 1} up`}
                    className="px-2 py-1 text-[10px]"
                  >
                    ↑
                  </Btn>
                  <Btn
                    onClick={() => moveKey(k.index, k.index + 1)}
                    disabled={busy || k.index === keys.length - 1}
                    title="Move down"
                    aria-label={`Move key ${k.index + 1} down`}
                    className="px-2 py-1 text-[10px]"
                  >
                    ↓
                  </Btn>
                  <Btn
                    onClick={() => testKey(k.index)}
                    disabled={busy || testingIndex === k.index}
                    className="px-2 py-1 text-[10px]"
                  >
                    {testingIndex === k.index ? 'Testing…' : 'Test'}
                  </Btn>
                  <Btn
                    onClick={() => removeKey(k.index)}
                    disabled={busy}
                    title={keys.length === 1 ? 'Remove the last key and clear the pool' : undefined}
                    className="px-2 py-1 text-[10px]"
                  >
                    Remove
                  </Btn>
                </span>
              </li>
            ))}
          </ul>
          {keys.length === 1 && (
            <p className="mt-1 text-[12px] text-muted">
              One key — add another to survive a daily quota.
            </p>
          )}
        </>
      )}

      <div className="mt-3 flex flex-wrap items-stretch gap-2 sm:flex-nowrap">
        <Input
          type="password"
          autoComplete="off"
          value={adding}
          placeholder="Paste another Gemini key…"
          onChange={e => setAdding(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void addKey(); } }}
          className="max-w-[360px]"
        />
        <Input
          value={addingName}
          placeholder="Name (optional)"
          aria-label="Name for the new key"
          maxLength={60}
          onChange={e => setAddingName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void addKey(); } }}
          className="max-w-[200px]"
        />
        <Btn onClick={addKey} disabled={busy || !adding.trim()}>Add key</Btn>
      </div>
      <p className="mt-1 text-[12px] text-muted">
        Adding a key keeps the ones already here, and appends it to the end —
        move it with ↑ ↓ if it belongs earlier.
      </p>
      <p className="mt-1 text-[12px] text-muted">
        Keys are tried in the order you add them — use ↑ ↓ to change that order.
        When one hits a quota limit it is set aside for as long as Google asks
        and the next one is used; if every key is spent, the station falls back
        to its configured backup model.
      </p>
      {/*
        The multi-key guidance and the terms note appear only once this is
        actually MULTIPLE keys, or the operator is typing a key that would make
        it so. Both halves matter: the pool list counts the key that is ALREADY
        on file, so entering the very first key into an empty pool is not yet a
        second key and must not raise a compliance warning.
      */}
      {(keys.length > 1 || (keys.length > 0 && adding.trim().length > 0)) && (
        <>
          <p className="mt-2 text-[12px] text-muted">
            <strong className="text-ink">Put your free-tier keys first and your
            paid key last.</strong> That is the point of the pool: the free keys
            carry the station&rsquo;s normal traffic, and the paid key only covers
            what they can&rsquo;t once their daily quotas run out. Reorder with
            ↑ ↓ if you got the order wrong.
          </p>
          <p className="mt-2 border-l-2 border-[var(--accent)] pl-2 text-[12px] text-muted">
            <strong className="text-ink">Check Google&rsquo;s terms before
            using more than one key.</strong> Rotating several free-tier keys to
            work around a single key&rsquo;s quota may conflict with the{' '}
            <a
              href="https://developers.google.com/terms"
              target="_blank"
              rel="noreferrer noopener"
              className="underline"
            >
              Google APIs Terms of Service
            </a>{' '}
            or the Gemini free-tier terms, which can change without notice. Read
            them and decide for yourself whether your use is permitted &mdash;
            Subwave can&rsquo;t make that call for you.
          </p>
        </>
      )}
    </div>
  );
}
