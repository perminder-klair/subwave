'use client';

import type { ChangeEvent } from 'react';
import { useState } from 'react';
import { notify, errorMessage } from '../../../lib/notify';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Btn, Card } from '../ui';
import { cn } from '../../../lib/cn';
import { SectionHeader, SaveBar, type SettingsData } from './shared';

// Music source — view, test, and change the Navidrome connection from the
// admin panel instead of re-running the onboarding wizard. Unlike the other
// sections this one does NOT ride the shared FormState / saveSettings pair:
// Navidrome creds live in state/setup-config.json (the wizard's overlay), not
// settings.json, so the section keeps local state and talks to its own
// /settings/navidrome endpoints.
interface NavidromeSectionProps {
  data: SettingsData;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  refresh: () => void;
}

type TestResult = { ok: boolean; serverVersion?: string; serverType?: string; error?: string };

export function NavidromeSection({ data, adminFetch, refresh }: NavidromeSectionProps) {
  const nv = data.navidrome;
  // Seed once from the GET payload; later refreshes must not clobber typing.
  const [url, setUrl] = useState(() => nv?.url ?? '');
  const [user, setUser] = useState(() => nv?.user ?? '');
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);

  const env = { url: !!nv?.env?.url, user: !!nv?.env?.user, pass: !!nv?.env?.pass };
  const allEnv = env.url && env.user && env.pass;
  const passSet = !!nv?.passSet;

  // Env-managed fields are omitted from every request body — the server
  // rejects them anyway (env always wins on boot), and for test it falls back
  // to the live value, which IS the env value. Blank pass is omitted too:
  // server-side blank-pass semantics are "keep the one on file".
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
      const r = await adminFetch('/settings/navidrome/test', {
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
    if (!env.pass && !pass && !passSet) return notify.err('Password is required');
    setBusy(true);
    try {
      const r = await adminFetch('/settings/navidrome', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body()),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!r.ok || j.ok === false) {
        notify.err(j.error || `Save failed (${r.status})`);
        return;
      }
      notify.ok('Navidrome connection saved — auto playlist rebuilding');
      setPass('');
      setResult(null);
      refresh();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const envHint = (envVar: string) => (
    <div className="field-hint">
      Set via <code>{envVar}</code> in the root <code>.env</code> — env always
      wins on boot; remove it there to manage it here.
    </div>
  );

  return (
    <>
      <SectionHeader
        eyebrow="music source"
        title="The Navidrome server the DJ pulls from."
        sub={<>
          Every track pick, cover, and library lookup goes through this
          Subsonic connection. Changes apply immediately — no restart — and the
          auto playlist is rebuilt against the new server. The same values are
          managed by the onboarding wizard and <code>subwave setup</code>.
        </>}
      />

      <Card title="Navidrome server" sub="url · credentials">
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
                Must be reachable from the controller container. For a Navidrome
                on the same host use <code>host.docker.internal</code> or the LAN
                IP, not <code>127.0.0.1</code>.
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
              placeholder={passSet ? '•••••• (on file)' : 'password'}
              className="max-w-[280px]"
            />
            {env.pass ? envHint('NAVIDROME_PASS') : (
              <div className="field-hint">
                Write-only — the saved password never leaves the server. Leave
                blank to keep the one on file. Auth uses the Subsonic salt+token
                scheme, never the plaintext password.
              </div>
            )}
          </div>

          <div className="field">
            <Btn sm tone="accent" onClick={test} disabled={testing || busy}>
              {testing ? 'Testing…' : 'Test connection'}
            </Btn>
            {result && (
              <div
                role="status"
                className={cn(
                  'mt-2 max-w-[560px] rounded border bg-[var(--ink-softer)] px-3 py-2 text-[11px] leading-[1.6] whitespace-pre-wrap',
                  result.ok
                    ? 'border-[var(--accent)] text-[color:var(--accent)]'
                    : 'border-[var(--danger)] text-[var(--danger)]',
                )}
              >
                {result.ok
                  ? `✓ Connected — ${result.serverType || 'subsonic'} ${result.serverVersion || ''}`.trimEnd()
                  : `✗ ${result.error}`}
              </div>
            )}
          </div>
        </div>
      </Card>

      {allEnv ? (
        <div className="flex flex-wrap items-center gap-3 border border-ink bg-[var(--ink-softer)] p-3 text-[12px] leading-[1.5] text-muted">
          All three values are managed by <code>NAVIDROME_*</code> vars in the
          root <code>.env</code>, so there is nothing to save here — edit the
          file and restart the controller to change them.
        </div>
      ) : (
        <SaveBar
          note="Applies immediately — the auto playlist is rebuilt with the new connection; no restart needed. Saving with an unreachable server is allowed (it may not be up yet); use Test to check."
          busy={busy}
          onSave={save}
          saveLabel="Save music source"
        />
      )}
    </>
  );
}
