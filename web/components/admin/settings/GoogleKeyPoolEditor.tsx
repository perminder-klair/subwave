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
import { notify } from '@/lib/notify';
import { refetchReconciled } from './googlePoolUi';

export interface GooglePoolKey {
  /** Stable opaque identity. Every mutation addresses this, never `index`. */
  id: string;
  /** Display position only — sending it back is how a stale click deletes the
   *  wrong credential. */
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
  /** Bumped by every server-side mutation. A row rendered against an older
   *  revision may no longer describe the pool, so its controls stay disabled. */
  revision: number;
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
  /** Runs after a mutation to reconcile the rows. Its RESULT is inspected, so it
   *  must return the refetch outcome — a `void` signature would erase the very
   *  signal `refetchReconciled` exists to read. */
  onChanged?: () => unknown;
}) {
  const [adding, setAdding] = useState('');
  const [addingName, setAddingName] = useState('');
  // Per-row draft for the rename box, keyed by the key's OPAQUE ID. Keying by
  // index is what made a draft follow a position rather than a credential, so a
  // reorder moved the typed name onto a different key. The draft is what is
  // being typed; `k.name` is what is on file, and dropping the draft is what
  // makes a failed or sanitised save snap back to the truth.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);

  const keys = pool?.keys ?? [];

  // Rows always render straight from `pool`, so they cannot drift from the
  // server on their own. The one window where they CAN is between our POST
  // returning and the refetch landing — a mutation there would be addressed
  // against a list that no longer exists. `busy` is held across both by
  // postAndRefresh, which closes that window.
  //
  // `desynced` is the case that leaves it open: if the refetch FAILS, the write
  // landed but the screen does not show it, and every control would then be
  // acting on a list the operator can no longer see. Rather than let that stand,
  // the rows stay locked until a refresh succeeds.
  const [desynced, setDesynced] = useState(false);
  const locked = busy || desynced;

  // A mutation and the refetch that reconciles it are ONE operation. Releasing
  // `busy` when the POST returned left the pre-write rows interactive against
  // the post-write order. If the refetch itself fails, `desynced` holds the rows
  // locked rather than letting the operator act on a list the screen no longer
  // matches.
  const postAndRefresh = useCallback(async (path: string, body: unknown) => {
    setBusy(true);
    let ok = false;
    try {
      const r = await adminResponse(adminFetch, path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({})) as { error?: string; ok?: boolean; message?: string };
      ok = r.ok && j.ok !== false;
      if (!ok) {
        notify.err(j.message || j.error || `Request failed (${r.status})`);
        // A 409 means the pool moved under us; the refetch is what resolves it,
        // and until it does the rows on screen are not the pool.
        if (r.status === 409) setDesynced(true);
      }
    } catch (e) {
      notify.err(e instanceof Error ? e.message : 'Request failed');
    }
    try {
      // The refetch's OUTCOME, not merely that it did not throw. React Query's
      // `refetch` resolves with `{ isError: true }` on failure, so a failed
      // refresh used to take the success path: `desynced` cleared, every row
      // control re-enabled against a list the screen no longer matched.
      const result = await onChanged?.();
      setDesynced(!refetchReconciled(result));
    } catch {
      setDesynced(true);
    } finally {
      setBusy(false);
    }
    return ok;
  }, [adminFetch, onChanged]);

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

  const removeKey = useCallback(async (id: string) => {
    const ok = await postAndRefresh('/settings/google-key-pool/remove', { id });
    if (ok) notify.ok('Key removed from the pool');
  }, [postAndRefresh]);

  const moveKey = useCallback(async (k: GooglePoolKey, to: number) => {
    if (to === k.index) return;
    await postAndRefresh('/settings/google-key-pool/move', { id: k.id, to });
  }, [postAndRefresh]);

  const renameKey = useCallback(async (k: GooglePoolKey, name: string) => {
    // Drop the draft FIRST so the input falls back to the server's value: on a
    // failure that means it snaps back to what is actually stored, and on a
    // sanitised name it shows what was kept rather than the raw text.
    setDrafts(d => { const { [k.id]: _drop, ...rest } = d; return rest; });
    const ok = await postAndRefresh('/settings/google-key-pool/rename', { id: k.id, name });
    if (ok) notify.ok('Key renamed');
  }, [postAndRefresh]);

  const testKey = useCallback(async (k: GooglePoolKey) => {
    setTestingId(k.id);
    try {
      const ok = await postAndRefresh('/settings/google-key-pool/test', { id: k.id });
      if (ok) notify.ok(`Key ${k.fingerprint} responded`);
    } finally {
      setTestingId(null);
    }
  }, [postAndRefresh]);

  return (
    /* This replaces the single field rather than sitting beneath it, so it
       carries no separator of its own — the field label above already says
       which credential is being edited, and a rule here would read as a second
       section boundary inside the same one. */
    <div>
      <p className="text-[12px] text-muted">
        Runs several Gemini keys as one, so a daily free-tier quota running out
        doesn&rsquo;t take the DJ offline. The first key is used until it fails.
      </p>

      {keys.length === 0 ? (
        <p className="mt-1 text-[12px] text-muted">
          No keys yet. Add one below, or switch back to a single key.
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
              <li key={k.id} className="flex flex-wrap items-center gap-2 text-[12px]">
                {/* Fully controlled: no `defaultValue`, which React warns about
                    alongside `value` and which cannot be corrected once the
                    server has answered with a different name than the operator
                    typed. The draft is the text being typed; `k.name` is what is
                    on file, and dropping the draft snaps back to it. */}
                <input
                  value={drafts[k.id] ?? k.name}
                  placeholder="e.g. Free 1"
                  aria-label={`Name for key ${k.fingerprint}`}
                  maxLength={60}
                  disabled={locked}
                  onChange={e => setDrafts(d => ({ ...d, [k.id]: e.target.value }))}
                  onKeyDown={e => {
                    if (e.key !== 'Enter') return;
                    e.preventDefault();
                    const next = (drafts[k.id] ?? k.name).trim();
                    if (next !== k.name) void renameKey(k, next);
                  }}
                  onBlur={e => {
                    const next = e.target.value.trim();
                    // Guarded, like every other entry point: a blur fires on
                    // focus loss, which is exactly what clicking another row
                    // causes — so an unguarded rename could fire while a
                    // different mutation was still settling.
                    if (!locked && next !== k.name) void renameKey(k, next);
                  }}
                  className="min-w-[140px] border border-input bg-field px-2 py-1 text-[12px] text-foreground placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                />
                <code className="min-w-[80px] text-muted">{k.fingerprint}</code>
                <span className="min-w-[150px] text-muted">
                  {k.current ? 'in use' : 'standby'}
                  {k.held ? ` · ${holdLabel(k)}` : ''}
                </span>
                <span className="ml-auto flex gap-1">
                  <Btn
                    onClick={() => moveKey(k, k.index - 1)}
                    disabled={locked || k.index === 0}
                    title="Move up"
                    aria-label={`Move key ${k.fingerprint} up`}
                    className="px-2 py-1 text-[10px]"
                  >
                    ↑
                  </Btn>
                  <Btn
                    onClick={() => moveKey(k, k.index + 1)}
                    disabled={locked || k.index === keys.length - 1}
                    title="Move down"
                    aria-label={`Move key ${k.fingerprint} down`}
                    className="px-2 py-1 text-[10px]"
                  >
                    ↓
                  </Btn>
                  <Btn
                    onClick={() => testKey(k)}
                    disabled={locked || testingId === k.id}
                    className="px-2 py-1 text-[10px]"
                  >
                    {testingId === k.id ? 'Testing…' : 'Test'}
                  </Btn>
                  <Btn
                    onClick={() => removeKey(k.id)}
                    disabled={locked}
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
          disabled={locked}
          onChange={e => setAdding(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void addKey(); } }}
          className="max-w-[360px]"
        />
        <Input
          value={addingName}
          placeholder="Name (optional)"
          aria-label="Name for the new key"
          maxLength={60}
          disabled={locked}
          onChange={e => setAddingName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void addKey(); } }}
          className="max-w-[200px]"
        />
        <Btn onClick={addKey} disabled={locked || !adding.trim()}>Add key</Btn>
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
          {/*
            Terms note. Shown only while the pool is actually in use — two or
            more keys, or a second one being typed — because a station with a
            single key has done nothing that needs checking, and a compliance
            warning nobody has earned is just noise that trains people to ignore
            the one time it matters.

            It states BOTH things, deliberately. The free-tier case is the one
            worth naming (rotating free keys around one key's quota is the
            pattern most likely to warrant a look), and the limitation is stated
            just as plainly: the station is handed strings and cannot know which
            are free-tier and which are paid. So the note points at something to
            check without claiming to know what the operator supplied, and
            without implying a paid-key pool is exempt — both readings would be
            false. The call is the operator's.
          */}
          <p className="mt-2 border-l-2 border-[var(--accent)] pl-2 text-[12px] text-muted">
            <strong className="text-ink">You&rsquo;re using this to supply
            several API keys &mdash; free tier or paid.</strong> If some of them
            are free-tier keys, you may want to read the{' '}
            <a
              href="https://developers.google.com/terms"
              target="_blank"
              rel="noreferrer noopener"
              className="underline"
            >
              Google APIs Terms of Service
            </a>{' '}
            first: rotating several free-tier keys to work around one
            key&rsquo;s quota is the arrangement most likely to be worth a look,
            and those terms can change without notice.
            <br />
            <br />
            The station can&rsquo;t tell which kind of key you&rsquo;ve given
            it &mdash; it sees strings, not billing tiers &mdash; so it is
            flagging the possibility rather than judging your setup, and it
            cannot tell you that your arrangement is fine either. Whichever mix
            you&rsquo;ve used, whether it complies is your call to make and
            verify.
          </p>
        </>
      )}
    </div>
  );
}
