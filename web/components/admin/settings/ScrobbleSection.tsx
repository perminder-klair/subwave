'use client';

import type { ChangeEvent } from 'react';
import { useState } from 'react';
import { notify, errorMessage } from '../../../lib/notify';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Card, Btn, Pill, Seg } from '../ui';
import {
  SectionHeader, SaveBar,
  type SectionProps, type ScrobbleLastfmForm, type ScrobbleListenbrainzForm,
} from './shared';

interface ScrobbleSectionProps extends SectionProps {
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  refresh: () => void;
}

export function ScrobbleSection({ data, form, setForm, busy, saveSettings, adminFetch, refresh }: ScrobbleSectionProps) {
  const lf = form.scrobble.lastfm;
  const lb = form.scrobble.listenbrainz;
  const savedLf = data.values?.scrobble?.lastfm || {};
  const savedLb = data.values?.scrobble?.listenbrainz || {};

  // Treat 'set' as "stored — leave the input empty unless the operator types
  // something new". The controller ignores 'set' on POST so a round-trip
  // won't blank the secret.
  const inputValue = (v: string) => (v === 'set' ? '' : v);
  const placeholder = (v: string, fallback: string) =>
    v === 'set' ? '•••••• (on file)' : fallback;
  const env = (data.env || {}) as Record<string, unknown>;
  const lfApiKeySet = lf.apiKey === 'set' || !!env.LASTFM_API_KEY;
  const lfApiSecretSet = lf.apiSecret === 'set' || !!env.LASTFM_API_SECRET;
  const lfSessionSet = lf.sessionKey === 'set' || !!env.LASTFM_SESSION_KEY;
  const lbTokenSet = lb.userToken === 'set' || !!env.LISTENBRAINZ_USER_TOKEN;
  const lfReady = lf.enabled && lfApiKeySet && lfApiSecretSet && lfSessionSet;
  const lbReady = lb.enabled && lbTokenSet;

  // "Connect to Last.fm" flow — replaces the CLI session-key dance. Needs the
  // API key + secret saved first (the backend reads them from settings/env).
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

  const sendTest = async (provider: 'lastfm' | 'listenbrainz') => {
    try {
      const r = await adminFetch('/scrobble/test', {
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

  // Step 1: ask the controller for an auth token + URL, open it for the user.
  const connectLastfm = async () => {
    setConnecting(true);
    try {
      const r = await adminFetch('/scrobble/lastfm/connect', { method: 'POST' });
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

  // Step 2: trade the authorized token for a session key; the controller saves
  // it and switches scrobbling on, so a refresh reflects "connected".
  const finishLastfm = async () => {
    if (!authToken) return;
    setConnecting(true);
    try {
      const r = await adminFetch('/scrobble/lastfm/complete', {
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
      <SectionHeader
        eyebrow="scrobbling"
        title="Station-wide scrobbling to Last.fm and ListenBrainz."
        sub={<>
          Each backend is independent, pick one or both. Tracks scrobble only when at
          least one listener is tuned in to the stream. For Last.fm, enter your API key
          and secret, then hit <strong>Connect to Last.fm</strong> to authorize, no
          session-key wrangling. Nothing here leaves the controller.
        </>}
        metrics={[
          { n: lfReady ? 'on' : 'off', l: 'last.fm', accent: lfReady },
          { n: lbReady ? 'on' : 'off', l: 'listenbrainz', accent: lbReady },
        ]}
      />

      <Card
        title="Last.fm"
        sub={lfReady ? `scrobbling as ${savedLf.username || '(unknown)'}` : 'not connected'}
      >
        <div className="grid gap-[18px]">
          <div className="field">
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
              scrobbled to your Last.fm profile.
            </div>
          </div>

          <div className="field">
            <Label>API key</Label>
            <Input
              type="password"
              autoComplete="new-password"
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
              Get one at <code>last.fm/api/account/create</code>. Falls back to
              <code> LASTFM_API_KEY</code> in <code>.env</code> when blank.
            </div>
          </div>

          <div className="field">
            <Label>API secret</Label>
            <Input
              type="password"
              autoComplete="new-password"
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
              Paired with the API key. Falls back to <code>LASTFM_API_SECRET</code>.
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
                  ? 'Opens Last.fm to grant access, then fills in your session key and switches scrobbling on, no terminal needed.'
                  : 'A Last.fm tab opened. Click “Yes, allow access” there, then finish here.'}
            </div>
          </div>

          <div className="field">
            <Label>Session key</Label>
            <Input
              type="password"
              autoComplete="current-password"
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
        </div>

        <SaveBar
          note="Applies on the next track transition, no restart needed."
          busy={busy}
          onSave={saveLastfm}
          saveLabel="Save Last.fm"
          extra={
            <Btn sm onClick={() => sendTest('lastfm')} disabled={busy || !lfReady}>
              Test
            </Btn>
          }
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
              autoComplete="current-password"
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
        </div>

        <SaveBar
          note="Applies on the next track transition, no restart needed."
          busy={busy}
          onSave={saveListenbrainz}
          saveLabel="Save ListenBrainz"
          extra={
            <Btn sm onClick={() => sendTest('listenbrainz')} disabled={busy || !lbReady}>
              Test
            </Btn>
          }
        />
      </Card>
    </>
  );
}
