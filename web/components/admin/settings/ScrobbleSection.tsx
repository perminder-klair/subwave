'use client';

import type { ChangeEvent } from 'react';
import Link from 'next/link';
import { useState } from 'react';
import { notify, errorMessage } from '../../../lib/notify';
import { adminResponse } from '../../../lib/admin-query';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Card, Btn, Pill, Seg } from '../ui';
import {
  NowBanner,
  SaveBar,
  type FormState, type SettingsData, type SectionProps, type ScrobbleLastfmForm, type ScrobbleListenbrainzForm,
} from './shared';

interface ScrobbleCardsProps extends SectionProps {
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  refresh: () => void;
}

// Which backends would actually submit, from the form plus any env-supplied
// credential. Shared by the cards and the Listeners header metrics.
export function scrobbleReadiness(form: FormState, data: SettingsData) {
  const lf = form.scrobble.lastfm;
  const lb = form.scrobble.listenbrainz;
  const env = (data.env || {}) as Record<string, unknown>;
  const lfApiKeySet = lf.apiKey === 'set' || !!env.LASTFM_API_KEY;
  const lfApiSecretSet = lf.apiSecret === 'set' || !!env.LASTFM_API_SECRET;
  const lfSessionSet = lf.sessionKey === 'set' || !!env.LASTFM_SESSION_KEY;
  const lbTokenSet = lb.userToken === 'set' || !!env.LISTENBRAINZ_USER_TOKEN;
  return {
    lfApiKeySet, lfApiSecretSet,
    lfReady: lf.enabled && lfApiKeySet && lfApiSecretSet && lfSessionSet,
    lbReady: lb.enabled && lbTokenSet,
    // Navidrome has no credentials of its own — the station's existing
    // connection is the credential, so "enabled" is the whole readiness test.
    ndReady: !!form.scrobble.navidrome.enabled,
  };
}

// The three scrobbling backends, as cards of the Listeners tab
// (ListenersSection). Each keeps its own save, since each is independent.
export function ScrobbleCards({ data, form, setForm, busy, saveSettings, adminFetch, refresh }: ScrobbleCardsProps) {
  const lf = form.scrobble.lastfm;
  const lb = form.scrobble.listenbrainz;
  const nd = form.scrobble.navidrome;
  const savedLf = data.values?.scrobble?.lastfm || {};
  const savedLb = data.values?.scrobble?.listenbrainz || {};
  const savedNd = data.values?.scrobble?.navidrome || {};

  // 'set' means "stored": leave the input empty. The controller ignores 'set' on
  // POST, so a round-trip won't blank the secret.
  const inputValue = (v: string) => (v === 'set' ? '' : v);
  const placeholder = (v: string, fallback: string) =>
    v === 'set' ? '•••••• (on file)' : fallback;
  const { lfApiKeySet, lfApiSecretSet, lfReady, lbReady, ndReady } = scrobbleReadiness(form, data);
  // The tagger's own switch (Library tagger → Advanced → Enrichment) can veto the
  // key. Saved value only: undefined is Auto, which follows the key.
  const lfTagsOff = lfApiKeySet && data.values?.embedding?.enrichment?.lastfmTags === false;
  // Tags need only the key, so a key-only setup is working, not "not connected".
  const lfSubtitle = lfReady
    ? `scrobbling as ${savedLf.username || '(unknown)'}`
    : lf.enabled
      ? 'enabled, but missing credentials'
      : lfTagsOff
        ? 'key set, but Last.fm tags is off'
        : lfApiKeySet
          ? 'key set, tags only, not scrobbling'
          : 'not set up';

  // Needs the API key + secret saved first (the backend reads them from settings/env).
  const canConnect = lfApiKeySet && lfApiSecretSet;
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const saveLastfm = () => {
    const patch: Partial<ScrobbleLastfmForm> = {
      enabled: lf.enabled,
      username: lf.username,
    };
    if (lf.apiKey && lf.apiKey !== 'set') patch.apiKey = lf.apiKey;
    if (lf.apiSecret && lf.apiSecret !== 'set') patch.apiSecret = lf.apiSecret;
    if (lf.sessionKey && lf.sessionKey !== 'set') patch.sessionKey = lf.sessionKey;
    saveSettings({ scrobble: { lastfm: patch } });
  };
  const saveListenbrainz = () => {
    const patch: Partial<ScrobbleListenbrainzForm> = {
      enabled: lb.enabled,
      username: lb.username,
      baseUrl: lb.baseUrl,
    };
    if (lb.userToken && lb.userToken !== 'set') patch.userToken = lb.userToken;
    saveSettings({ scrobble: { listenbrainz: patch } });
  };
  const saveNavidrome = () => {
    saveSettings({ scrobble: { navidrome: { enabled: nd.enabled } } });
  };

  const sendTest = async (provider: 'lastfm' | 'listenbrainz' | 'navidrome') => {
    try {
      const r = await adminResponse(adminFetch, '/scrobble/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        ok?: boolean; message?: string; error?: string;
      };
      const msg = j.message || j.error || (r.ok ? 'sent' : `failed (${r.status})`);
      if (r.ok && j.ok) notify.ok(msg);
      else notify.err(msg);
    } catch (e) {
      notify.err(errorMessage(e));
    }
  };

  const connectLastfm = async () => {
    setConnecting(true);
    try {
      const r = await adminResponse(adminFetch, '/scrobble/lastfm/connect', { method: 'POST' });
      const j = (await r.json().catch(() => ({}))) as {
        ok?: boolean; token?: string; authUrl?: string; message?: string;
      };
      if (!r.ok || !j.ok || !j.authUrl || !j.token) {
        notify.err(j.message || `couldn't start (${r.status})`);
        return;
      }
      window.open(j.authUrl, '_blank', 'noopener,noreferrer');
      setAuthToken(j.token);
      notify.ok('Authorize in the Last.fm tab, then click “I authorized — finish”.');
    } catch (e) {
      notify.err(errorMessage(e));
    } finally {
      setConnecting(false);
    }
  };

  // The controller saves the session key and switches scrobbling on, so a refresh
  // reflects "connected".
  const finishLastfm = async () => {
    if (!authToken) return;
    setConnecting(true);
    try {
      const r = await adminResponse(adminFetch, '/scrobble/lastfm/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: authToken }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        ok?: boolean; username?: string; message?: string;
      };
      if (!r.ok || !j.ok) {
        notify.err(j.message || `couldn't finish (${r.status})`);
        return;
      }
      setAuthToken(null);
      notify.ok(`Connected to Last.fm${j.username ? ` as ${j.username}` : ''}.`);
      refresh();
    } catch (e) {
      notify.err(errorMessage(e));
    } finally {
      setConnecting(false);
    }
  };

  return (
    <>
      <Card title="Last.fm" sub={lfSubtitle}>
        <div className="grid gap-[18px]">
          <NowBanner label={<>Last.fm tags · {lfTagsOff ? 'off' : lfApiKeySet ? 'key set' : 'no key'}</>}>
            Paste your <strong className="text-ink">API key</strong> below and click save to
            only enable tagging. The tagger folds Last.fm&apos;s crowd tags into your library
            as it tags your tracks. Everything below the{' '}
            <strong className="text-ink">Scrobbling</strong> line is only needed if you also
            wish to have <strong className="text-ink">SUB/WAVE</strong> scrobble your plays.
            <span className="mt-1.5 block">
              Then open Settings →{' '}
              <strong className="text-ink">
                <Link href="/admin/settings?section=library" className="underline">
                  Library tagger
                </Link>
              </strong>{' '}
              → Advanced → Enrichment and make sure{' '}
              <strong className="text-ink">Last.fm tags</strong> is set to{' '}
              <strong className="text-ink">Auto</strong>, or{' '}
              <strong className="text-ink">On</strong> for tagging to occur.
            </span>
          </NowBanner>

          {lfTagsOff && (
            <div
              role="alert"
              className="border border-l-[3px] border-[var(--danger)] bg-[color-mix(in_oklab,var(--danger)_7%,transparent)] p-3.5"
            >
              <div className="flex items-center gap-2">
                <span className="text-[13px] leading-none text-[var(--danger)]">⚠</span>
                <span className="text-[11px] font-bold tracking-[0.14em] text-[var(--danger)] uppercase">
                  Last.fm tags is off
                </span>
              </div>
              <p className="mt-2 text-[14px] leading-[1.55] text-muted">
                The key is saved, but enrichment is told to skip Last.fm, so{' '}
                <strong>no Last.fm tags will be fetched</strong>. Set Settings →{' '}
                <strong>
                  <Link href="/admin/settings?section=library" className="underline">
                    Library tagger
                  </Link>
                </strong>{' '}
                → Advanced → Enrichment →{' '}
                <strong>Last.fm tags</strong> to <strong>Auto</strong> or{' '}
                <strong>On</strong> to start using it.
              </p>
            </div>
          )}

          <div className="field">
            <Label>API key</Label>
            <Input
              type="password"
              autoComplete="off"
              value={inputValue(lf.apiKey)}
              placeholder={placeholder(lf.apiKey, 'your last.fm API key')}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setForm(f => ({
                  ...f,
                  scrobble: { ...f.scrobble, lastfm: { ...f.scrobble.lastfm, apiKey: e.target.value } },
                }))
              }
              className="max-w-[360px]"
            />
            <div className="field-hint">
              Get one at{' '}
              <a
                href="https://www.last.fm/api/account/create"
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                last.fm/api/account/create
              </a>
              . Falls back to <code>LASTFM_API_KEY</code> in <code>.env</code> when blank.
            </div>
          </div>

          {/* The key is the only required field; everything below this line is
              scrobbling-only, so the divider sits directly under it. */}
          <div className="border-t border-[var(--separator-strong)] pt-4">
            <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
              <span className="text-[11px] font-bold tracking-[0.25em] text-[var(--accent)] uppercase">
                Scrobbling
              </span>
              <span className="text-[11px] text-muted">sends plays to Last.fm</span>
            </div>
            <div className="field !mb-0">
              <div className="flex items-center gap-2">
                <Label>Enabled</Label>
                {lf.enabled !== !!savedLf.enabled && <Pill tone="accent" dot>unsaved</Pill>}
              </div>
              <Seg
                value={lf.enabled ? 'on' : 'off'}
                onChange={v =>
                  setForm(f => ({
                    ...f,
                    scrobble: { ...f.scrobble, lastfm: { ...f.scrobble.lastfm, enabled: v === 'on' } },
                  }))
                }
                options={[{ id: 'off', label: 'Off' }, { id: 'on', label: 'On' }]}
              />
              <div className="field-hint">
                When on, every track that plays with at least one listener tuned in is
                scrobbled to your Last.fm profile. This switch only sends plays: the API
                key alone feeds Last.fm tags in Library tagger → Advanced → Enrichment,
                whether this is on or off.
              </div>
            </div>
          </div>

          <div className="field">
            <Label>API secret</Label>
            <Input
              type="password"
              autoComplete="off"
              value={inputValue(lf.apiSecret)}
              placeholder={placeholder(lf.apiSecret, 'your last.fm API secret')}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setForm(f => ({
                  ...f,
                  scrobble: { ...f.scrobble, lastfm: { ...f.scrobble.lastfm, apiSecret: e.target.value } },
                }))
              }
              className="max-w-[360px]"
            />
            <div className="field-hint">
              Paired with the API key. Only needed for scrobbling. Falls back to{' '}
              <code>LASTFM_API_SECRET</code>.
            </div>
          </div>

          <div className="field">
            <Label>Authorize</Label>
            {!authToken ? (
              <Btn
                sm
                tone="accent"
                onClick={connectLastfm}
                disabled={busy || connecting || !canConnect}
              >
                {connecting ? 'Opening Last.fm…' : 'Connect to Last.fm'}
              </Btn>
            ) : (
              <div className="flex items-center gap-2">
                <Btn sm tone="accent" onClick={finishLastfm} disabled={busy || connecting}>
                  {connecting ? 'Finishing…' : 'I authorized — finish'}
                </Btn>
                <Btn sm onClick={() => setAuthToken(null)} disabled={connecting}>
                  Cancel
                </Btn>
              </div>
            )}
            <div className="field-hint">
              {!canConnect
                ? 'Enter your API key + secret above and Save first, then connect.'
                : !authToken
                  ? 'Opens Last.fm to grant access, then fills in your session key and switches scrobbling on, no terminal needed. Last.fm tags don’t need this — only the API key.'
                  : 'A Last.fm tab opened. Click “Yes, allow access” there, then finish here.'}
            </div>
          </div>

          <div className="field">
            <Label>Session key</Label>
            <Input
              type="password"
              autoComplete="off"
              value={inputValue(lf.sessionKey)}
              placeholder={placeholder(lf.sessionKey, 'long-lived session key')}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setForm(f => ({
                  ...f,
                  scrobble: { ...f.scrobble, lastfm: { ...f.scrobble.lastfm, sessionKey: e.target.value } },
                }))
              }
              className="max-w-[360px]"
            />
            <div className="field-hint">
              Easiest: hit <strong>Connect to Last.fm</strong> above and it fills this
              in for you. Advanced: paste one from
              <code> npm run lastfm-session</code>. Doesn&apos;t expire. Falls back to
              <code> LASTFM_SESSION_KEY</code>.
            </div>
          </div>

          <div className="field">
            <Label>Username (display)</Label>
            <Input
              value={lf.username}
              placeholder="your last.fm username"
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setForm(f => ({
                  ...f,
                  scrobble: { ...f.scrobble, lastfm: { ...f.scrobble.lastfm, username: e.target.value } },
                }))
              }
              className="max-w-[360px]"
            />
            <div className="field-hint">
              Cosmetic, used to label the &quot;scrobbling as&quot; status line above.
            </div>
          </div>

          {/* Tests use saved credentials. */}
          <div className="field">
            <div className="flex flex-wrap items-center gap-3">
              <Btn sm onClick={() => sendTest('lastfm')} disabled={busy || !lfReady}>
                Test
              </Btn>
              <span className="text-[12px] leading-[1.5] text-muted">
                Sends a now-playing update for the on-air track with the saved
                credentials. Needs something playing.
              </span>
            </div>
          </div>
        </div>

        <SaveBar
          note="Applies on the next track transition, no restart needed."
          busy={busy}
          onSave={saveLastfm}
          saveLabel="Save Last.fm"
        />
      </Card>

      <Card
        title="ListenBrainz"
        sub={lbReady ? `submitting as ${savedLb.username || '(unknown)'}` : 'not connected'}
      >
        <div className="grid gap-[18px]">
          <div className="field">
            <div className="flex items-center gap-2">
              <Label>Enabled</Label>
              {lb.enabled !== !!savedLb.enabled && <Pill tone="accent" dot>unsaved</Pill>}
            </div>
            <Seg
              value={lb.enabled ? 'on' : 'off'}
              onChange={v =>
                setForm(f => ({
                  ...f,
                  scrobble: {
                    ...f.scrobble,
                    listenbrainz: { ...f.scrobble.listenbrainz, enabled: v === 'on' },
                  },
                }))
              }
              options={[{ id: 'off', label: 'Off' }, { id: 'on', label: 'On' }]}
            />
            <div className="field-hint">
              ListenBrainz is the open-source alternative to Last.fm, with the same listener gate
              and eligibility rules.
            </div>
          </div>

          <div className="field">
            <Label>API base URL</Label>
            <Input
              type="url"
              value={lb.baseUrl}
              placeholder="https://api.listenbrainz.org/1"
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setForm(f => ({
                  ...f,
                  scrobble: {
                    ...f.scrobble,
                    listenbrainz: { ...f.scrobble.listenbrainz, baseUrl: e.target.value },
                  },
                }))
              }
              className="max-w-[360px]"
            />
            <div className="field-hint">
              Leave blank for listenbrainz.org. For self-hosted LB-compatible scrobblers, use the
              API root (e.g. <code>http://koito:4110/apis/listenbrainz/1</code>). Overrides via{' '}
              <code>LISTENBRAINZ_API_URL</code> env when set.
            </div>
          </div>

          <div className="field">
            <Label>User token</Label>
            <Input
              type="password"
              autoComplete="off"
              value={inputValue(lb.userToken)}
              placeholder={placeholder(lb.userToken, 'your listenbrainz user token')}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setForm(f => ({
                  ...f,
                  scrobble: {
                    ...f.scrobble,
                    listenbrainz: { ...f.scrobble.listenbrainz, userToken: e.target.value },
                  },
                }))
              }
              className="max-w-[360px]"
            />
            <div className="field-hint">
              Copy from <code>listenbrainz.org/profile</code>. Falls back to
              <code> LISTENBRAINZ_USER_TOKEN</code>.
            </div>
          </div>

          <div className="field">
            <Label>Username (display)</Label>
            <Input
              value={lb.username}
              placeholder="your listenbrainz username"
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setForm(f => ({
                  ...f,
                  scrobble: {
                    ...f.scrobble,
                    listenbrainz: { ...f.scrobble.listenbrainz, username: e.target.value },
                  },
                }))
              }
              className="max-w-[360px]"
            />
            <div className="field-hint">Cosmetic only.</div>
          </div>

          {/* Tests use saved credentials. */}
          <div className="field">
            <div className="flex flex-wrap items-center gap-3">
              <Btn sm onClick={() => sendTest('listenbrainz')} disabled={busy || !lbReady}>
                Test
              </Btn>
              <span className="text-[12px] leading-[1.5] text-muted">
                Sends a now-playing update for the on-air track with the saved
                credentials. Needs something playing.
              </span>
            </div>
          </div>
        </div>

        <SaveBar
          note="Applies on the next track transition, no restart needed."
          busy={busy}
          onSave={saveListenbrainz}
          saveLabel="Save ListenBrainz"
        />
      </Card>

      <Card
        title="Navidrome"
        sub={ndReady ? 'logging plays back to your library' : 'not logging plays'}
      >
        <div className="grid gap-[18px]">
          <div className="field">
            <div className="flex items-center gap-2">
              <Label>Enabled</Label>
              {nd.enabled !== !!savedNd.enabled && <Pill tone="accent" dot>unsaved</Pill>}
            </div>
            <Seg
              value={nd.enabled ? 'on' : 'off'}
              onChange={v =>
                setForm(f => ({
                  ...f,
                  scrobble: {
                    ...f.scrobble,
                    navidrome: { ...f.scrobble.navidrome, enabled: v === 'on' },
                  },
                }))
              }
              options={[{ id: 'off', label: 'Off' }, { id: 'on', label: 'On' }]}
            />
            <div className="field-hint">
              Reports plays back to the Navidrome you already stream from, so
              <strong> play count</strong> and <strong>last played</strong> move as the
              station airs tracks. That is what <code>.nsp</code> smart playlists filter
              on, so a rule like &ldquo;not played in the last 7 days&rdquo; finally keeps
              the Auto-DJ off the same handful of songs. Off by default; nothing else to
              configure, it reuses your existing Navidrome connection.
            </div>
          </div>

          <div className="field">
            <Label>Listener gate</Label>
            <div className="field-hint">
              Unlike Last.fm and ListenBrainz, this one is <strong>not</strong> gated on
              listeners. A track the station played to an empty room still has to stop
              the picker reaching for it again an hour later, and this is your own
              library rather than a public profile.
            </div>
          </div>

          {/* Tests use the saved setting. */}
          <div className="field">
            <div className="flex flex-wrap items-center gap-3">
              <Btn sm onClick={() => sendTest('navidrome')} disabled={busy || !ndReady}>
                Test
              </Btn>
              <span className="text-[12px] leading-[1.5] text-muted">
                Sends a now-playing ping for the on-air track. Needs something playing
                that came from the library (an untracked auto-playlist file has no id to
                report).
              </span>
            </div>
          </div>
        </div>

        <SaveBar
          note="Applies on the next track transition, no restart needed."
          busy={busy}
          onSave={saveNavidrome}
          saveLabel="Save Navidrome"
        />
      </Card>
    </>
  );
}
