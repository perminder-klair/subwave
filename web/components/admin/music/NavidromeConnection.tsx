'use client';

// The direct Navidrome connection on Admin → Music source: URL, user and
// password (state/setup-config.json, through /settings/navidrome, not
// settings.json). The Source tab owns the action bar, so this exposes its
// draft as a hook and its fields as a component.
//
// Env-managed values (NAVIDROME_* in the root .env) win on boot: the fields are
// locked and one banner says so, rather than the same hint under each field.

import type { ChangeEvent } from 'react';
import { useState } from 'react';
import { adminResponse, type AdminFetch } from '../../../lib/admin-query';
import { errorMessage } from '../../../lib/notify';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Btn } from '../ui';
import type { SettingsData } from '../settings/shared';
import { TestResultLine } from './TestResultLine';

export type NavidromeTest = { ok: boolean; serverVersion?: string; serverType?: string; error?: string };

export function useNavidromeDraft(nv: SettingsData['navidrome'], adminFetch: AdminFetch) {
  // Seeded once; a later refetch must not clobber typing.
  const [url, setUrl] = useState(() => nv?.url ?? '');
  const [user, setUser] = useState(() => nv?.user ?? '');
  const [pass, setPass] = useState('');
  const env = { url: !!nv?.env?.url, user: !!nv?.env?.user, pass: !!nv?.env?.pass };
  const allEnv = env.url && env.user && env.pass;
  const passSet = !!nv?.passSet;
  // A typed password is always a change: the GET returns only `passSet`.
  const dirty = url !== (nv?.url ?? '') || user !== (nv?.user ?? '') || pass !== '';

  // Env-managed fields are left out of every body (the server refuses them,
  // and Test falls back to the live value, which IS the env value). A blank
  // password means "keep the one on file".
  const body = () => {
    const b: Record<string, string> = {};
    if (!env.url) b.url = url.trim();
    if (!env.user) b.user = user.trim();
    if (!env.pass && pass) b.pass = pass;
    return b;
  };

  /** What is still needed before this connection can be used, or null. */
  const missing = (): string | null => {
    if (!env.url && !url.trim()) return 'Server URL is required';
    if (!env.user && !user.trim()) return 'Username is required';
    if (!env.pass && !pass && !passSet) return 'Password is required';
    return null;
  };

  const test = async (): Promise<NavidromeTest> => {
    try {
      const r = await adminResponse(adminFetch, '/settings/navidrome/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body()),
      });
      return (await r.json()) as NavidromeTest;
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  };

  /** Save the connection. `live: false` means kept on file while the station plays through the router. */
  const persist = async (): Promise<{ ok: boolean; error?: string; live?: boolean }> => {
    try {
      const r = await adminResponse(adminFetch, '/settings/navidrome', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body()),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; live?: boolean };
      if (!r.ok || j.ok === false) return { ok: false, error: j.error || `Save failed (${r.status})` };
      setPass('');
      return { ok: true, live: j.live };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  };

  return { url, setUrl, user, setUser, pass, setPass, env, allEnv, passSet, dirty, missing, test, persist };
}

export type NavidromeDraft = ReturnType<typeof useNavidromeDraft>;

export function NavidromeFields({ draft }: { draft: NavidromeDraft }) {
  const { env } = draft;
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<NavidromeTest | null>(null);
  const locked = [env.url && 'NAVIDROME_URL', env.user && 'NAVIDROME_USER', env.pass && 'NAVIDROME_PASS'].filter(Boolean) as string[];
  return (
    <div className="grid gap-[18px]">
      {locked.length > 0 && (
        <div className="border border-ink bg-[var(--ink-softer)] px-3 py-2.5 text-[12px] leading-[1.55]">
          {draft.allEnv ? 'This connection is' : 'Part of this connection is'} set in the root <code>.env</code> (
          {locked.map((v, i) => <span key={v}>{i > 0 && ', '}<code>{v}</code></span>)}), which wins on every boot. Edit
          the file and restart the controller to change {locked.length === 1 ? 'it' : 'them'}, or remove{' '}
          {locked.length === 1 ? 'it' : 'them'} there to manage the connection here.
        </div>
      )}
      <div className="field">
        <Label htmlFor="nv-url">Server URL</Label>
        <Input
          id="nv-url"
          value={draft.url}
          disabled={env.url}
          onChange={(ev: ChangeEvent<HTMLInputElement>) => { draft.setUrl(ev.target.value); setResult(null); }}
          placeholder="https://music.example.com"
          className="max-w-[420px]"
        />
        {!env.url && (
          <div className="field-hint">
            Must be reachable from the controller container. For a Navidrome on the same host use{' '}
            <code>host.docker.internal</code> or the LAN IP, not <code>127.0.0.1</code>.
          </div>
        )}
      </div>
      <div className="grid gap-[18px] sm:grid-cols-2">
        <div className="field">
          <Label htmlFor="nv-user">Username</Label>
          <Input
            id="nv-user"
            value={draft.user}
            disabled={env.user}
            onChange={(ev: ChangeEvent<HTMLInputElement>) => { draft.setUser(ev.target.value); setResult(null); }}
            placeholder="radio"
          />
          {!env.user && (
            <div className="field-hint">A dedicated user that sees only the libraries you want on air keeps audiobooks off the stream.</div>
          )}
        </div>
        <div className="field">
          <Label htmlFor="nv-pass">Password</Label>
          <Input
            id="nv-pass"
            type="password"
            autoComplete="off"
            value={draft.pass}
            disabled={env.pass}
            onChange={(ev: ChangeEvent<HTMLInputElement>) => { draft.setPass(ev.target.value); setResult(null); }}
            placeholder={draft.passSet ? '•••••• (on file)' : 'password'}
          />
          {!env.pass && <div className="field-hint">Write-only. Leave blank to keep the one on file.</div>}
        </div>
      </div>
      <div className="field">
        <div>
          <Btn
            sm
            onClick={async () => { setTesting(true); setResult(null); setResult(await draft.test()); setTesting(false); }}
            disabled={testing}
          >
            {testing ? 'Testing…' : 'Test connection'}
          </Btn>
        </div>
        {result && (
          <TestResultLine
            ok={result.ok}
            text={result.ok ? `Connected — ${result.serverType || 'subsonic'} ${result.serverVersion || ''}`.trimEnd() : result.error || 'not answering'}
          />
        )}
      </div>
    </div>
  );
}
