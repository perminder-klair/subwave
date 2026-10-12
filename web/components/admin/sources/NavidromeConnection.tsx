'use client';

// The station's own Navidrome connection (#692): what the Navidrome source
// plays behind the router — the default — what direct mode uses, and what the
// failover falls back to when the router is down. One connection for all
// three, stored in state/setup-config.json (the wizard's overlay, not
// settings.json), so this card saves through its own /settings/navidrome
// endpoints and applies at once: behind the router the controller rebuilds the
// Navidrome source from it. Moved here from Settings → Music source.

import type { ChangeEvent } from 'react';
import { useState } from 'react';
import { notify, errorMessage } from '../../../lib/notify';
import { adminResponse } from '../../../lib/admin-query';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Btn } from '../ui';
import { cn } from '../../../lib/cn';
import type { StationNavidromeView } from './queries';

type TestResult = { ok: boolean; serverVersion?: string; serverType?: string; error?: string };

interface NavidromeConnectionProps {
  navidrome: StationNavidromeView;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  onSaved: () => void;
}

export function NavidromeConnection({ navidrome: nv, adminFetch, onSaved }: NavidromeConnectionProps) {
  // Seed once from the GET payload; later refreshes must not clobber typing.
  const [url, setUrl] = useState(() => nv.url ?? '');
  const [user, setUser] = useState(() => nv.user ?? '');
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);

  // A typed password is always a change: the GET only ever returns `passSet`.
  const dirty = url !== (nv.url ?? '') || user !== (nv.user ?? '') || pass !== '';
  const env = nv.env;
  const allEnv = env.url && env.user && env.pass;

  // Env-managed fields are omitted from every body: the server refuses them
  // (env always wins on boot), and Test falls back to the stored value, which
  // IS the env value. A blank password means "keep the one on file".
  const body = () => {
    const b: Record<string, string> = {};
    if (!env.url) b.url = url.trim();
    if (!env.user) b.user = user.trim();
    if (!env.pass && pass) b.pass = pass;
    return b;
  };

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      const r = await adminResponse(adminFetch, '/settings/navidrome/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body()),
      });
      setResult((await r.json()) as TestResult);
    } catch (err) {
      setResult({ ok: false, error: errorMessage(err) });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    if (!env.url && !url.trim()) return notify.err('Server URL is required');
    if (!env.user && !user.trim()) return notify.err('Username is required');
    if (!env.pass && !pass && !nv.passSet) return notify.err('Password is required');
    setBusy(true);
    try {
      const r = await adminResponse(adminFetch, '/settings/navidrome', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body()),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; live?: boolean };
      if (!r.ok || j.ok === false) {
        notify.err(j.error || `Save failed (${r.status})`);
        return;
      }
      notify.ok(j.live === false
        ? 'Navidrome connection saved — kept on file; the station plays other sources right now'
        : 'Navidrome connection saved — applied now; the auto playlist is rebuilding');
      setPass('');
      setResult(null);
      onSaved();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const envHint = (envVar: string) => (
    <div className="field-hint">
      Set via <code>{envVar}</code> in the root <code>.env</code> — env always wins on boot; remove it there to manage it here.
    </div>
  );

  return (
    <div className="grid gap-[18px]">
      <div className="field">
        <Label htmlFor="nv-url">Server URL</Label>
        <Input
          id="nv-url"
          value={url}
          disabled={env.url}
          onChange={(ev: ChangeEvent<HTMLInputElement>) => setUrl(ev.target.value)}
          placeholder="https://music.example.com"
          className="max-w-[420px]"
        />
        {env.url ? envHint('NAVIDROME_URL') : (
          <div className="field-hint">
            Must be reachable from the router and controller containers. For a Navidrome on the same host use{' '}
            <code>host.docker.internal</code> or the LAN IP, not <code>127.0.0.1</code>.
          </div>
        )}
      </div>

      <div className="field">
        <Label htmlFor="nv-user">Username</Label>
        <Input
          id="nv-user"
          value={user}
          disabled={env.user}
          onChange={(ev: ChangeEvent<HTMLInputElement>) => setUser(ev.target.value)}
          placeholder="radio"
          className="max-w-[280px]"
        />
        {env.user && envHint('NAVIDROME_USER')}
      </div>

      <div className="field">
        <Label htmlFor="nv-pass">Password</Label>
        <Input
          id="nv-pass"
          type="password"
          autoComplete="off"
          value={pass}
          disabled={env.pass}
          onChange={(ev: ChangeEvent<HTMLInputElement>) => setPass(ev.target.value)}
          placeholder={nv.passSet ? '•••••• (on file)' : 'password'}
          className="max-w-[280px]"
        />
        {env.pass ? envHint('NAVIDROME_PASS') : (
          <div className="field-hint">
            Write-only — the saved password never leaves the server. Leave blank to keep the one on file.
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Btn sm onClick={test} disabled={testing || busy}>{testing ? 'Testing…' : 'Test connection'}</Btn>
        {!allEnv && (
          <Btn sm tone="accent" onClick={save} disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save connection'}</Btn>
        )}
        {allEnv && (
          <span className="text-[12px] text-muted">
            All three values come from <code>NAVIDROME_*</code> in the root <code>.env</code> — edit it and restart to change them.
          </span>
        )}
      </div>
      {result && (
        <div
          role="status"
          className={cn(
            'max-w-[560px] rounded border bg-[var(--ink-softer)] px-3 py-2 text-[11px] leading-[1.6] whitespace-pre-wrap',
            result.ok ? 'border-[var(--accent)] text-[color:var(--accent)]' : 'border-[var(--danger)] text-[var(--danger)]',
          )}
        >
          {result.ok ? `✓ Connected — ${result.serverType || 'subsonic'} ${result.serverVersion || ''}`.trimEnd() : `✗ ${result.error}`}
        </div>
      )}
    </div>
  );
}
