'use client';

import { useEffect, useState } from 'react';
import { notify, errorMessage } from '../../../lib/notify';
import { adminResponse } from '../../../lib/admin-query';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Textarea } from '../../ui/textarea';
import { Btn, Card, Toggle } from '../ui';
import { type SaveSettings, type SettingsData } from './shared';

// The Spotify music source's settings. Two stores, two save paths — on purpose:
//   • credentials (client id / secret / the Connect flow) are SECRETS and talk
//     to /settings/spotify/* (state/secrets.env), like NavidromeSection talks to
//     /settings/navidrome;
//   • the catalog knobs (pool, device name, mismatch policy) are ordinary
//     settings under `spotify` and ride the shared saveSettings patch path.
interface SpotifySectionProps {
  data: SettingsData;
  busy: boolean;
  saveSettings: SaveSettings;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  refresh: () => void;
}

// `product` and `country` are null on every current Spotify app: February 2026
// removed both fields from /me. The probe still names the account, and `note`
// carries the explanation so the UI does not have to guess why they are absent.
type Probe = { ok: boolean; displayName?: string; product?: string | null; country?: string | null; note?: string; error?: string };

export function SpotifySection({ data, busy, saveSettings, adminFetch, refresh }: SpotifySectionProps) {
  const st = data.spotify;
  const sp = data.values?.spotify;
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [refreshToken, setRefreshToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [probing, setProbing] = useState(false);
  const [poolBusy, setPoolBusy] = useState(false);
  const [playlistText, setPlaylistText] = useState(() => (sp?.pool?.playlistIds ?? []).join('\n'));
  const [deviceName, setDeviceName] = useState(() => sp?.deviceName ?? '');
  const [receiverPaste, setReceiverPaste] = useState('');
  const [rps, setRps] = useState(() => String(sp?.quota?.requestsPer30s ?? 90));
  const [genresPerHour, setGenresPerHour] = useState(() => String(sp?.quota?.genresPerHour ?? 750));
  const [fullWalkHours, setFullWalkHours] = useState(() => String(sp?.pool?.fullWalkHours ?? 24));
  const rx = st?.receiver;

  // Save a number field on blur, and only when it actually changed. Saving an
  // unchanged value would have the 3-second /settings poll fighting the operator
  // for the contents of the input they are still in.
  const commitNumber = (raw: string, current: number, save: (n: number) => void) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n === current) return;
    save(Math.round(n));
  };

  // The OAuth callbacks bounce back here with ?spotify=… (the app) or
  // ?receiver=… (librespot): connected | error:<why>.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const app = params.get('spotify');
    const rcv = params.get('receiver');
    if (!app && !rcv) return;
    if (app === 'connected') notify.ok('Spotify connected');
    else if (app) notify.err(`Spotify connect failed: ${app.replace(/^error:/, '')}`);
    if (rcv === 'connected') notify.ok('Receiver signed in — it logs in on its next start');
    else if (rcv) notify.err(`Receiver sign-in failed: ${rcv.replace(/^error:/, '')}`);
    const url = new URL(window.location.href);
    url.searchParams.delete('spotify');
    url.searchParams.delete('receiver');
    window.history.replaceState({}, '', url.toString());
    refresh();
  }, [refresh]);

  const post = async (path: string, body?: unknown) => {
    const r = await adminResponse(adminFetch, path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return (await r.json().catch(() => ({}))) as Record<string, unknown> & { ok?: boolean; error?: string };
  };

  const saveCredentials = async () => {
    if (!clientId && !clientSecret) return notify.err('Enter the client id and/or secret first');
    setSaving(true);
    try {
      const j = await post('/settings/spotify/credentials', { clientId: clientId || undefined, clientSecret: clientSecret || undefined });
      if (j.ok === false) return notify.err(j.error || 'save failed');
      notify.ok('Spotify app credentials saved');
      setClientSecret('');
      refresh();
    } catch (err) { notify.err(errorMessage(err)); }
    finally { setSaving(false); }
  };

  const connect = async () => {
    try {
      const r = await adminResponse(adminFetch, '/settings/spotify/auth');
      const j = (await r.json()) as { ok?: boolean; url?: string; error?: string };
      if (!j.ok || !j.url) return notify.err(j.error || 'could not start the Spotify login');
      window.location.href = j.url;
    } catch (err) { notify.err(errorMessage(err)); }
  };

  const pasteToken = async () => {
    if (!refreshToken.trim()) return;
    setSaving(true);
    try {
      const j = await post('/settings/spotify/token', { refreshToken: refreshToken.trim() });
      if (j.ok === false) return notify.err(j.error || 'save failed');
      notify.ok('Refresh token stored');
      setRefreshToken('');
      refresh();
    } catch (err) { notify.err(errorMessage(err)); }
    finally { setSaving(false); }
  };

  const disconnect = async () => {
    setSaving(true);
    try {
      const j = await post('/settings/spotify/disconnect');
      if (j.ok === false) return notify.err(j.error || 'disconnect failed');
      notify.ok('Spotify disconnected');
      setProbe(null);
      refresh();
    } catch (err) { notify.err(errorMessage(err)); }
    finally { setSaving(false); }
  };

  const test = async () => {
    setProbing(true);
    try { setProbe(await post('/settings/spotify/test') as Probe); }
    catch (err) { setProbe({ ok: false, error: errorMessage(err) }); }
    finally { setProbing(false); }
  };

  const rebuildPool = async () => {
    setPoolBusy(true);
    try {
      const j = await post('/settings/spotify/pool/refresh');
      if (j.ok === false) return notify.err(j.error || 'pool build failed');
      notify.ok(`Pool rebuilt: ${j.tracks} tracks from ${(j.playlists as unknown[])?.length ?? 0} playlists`);
      refresh();
    } catch (err) { notify.err(errorMessage(err)); }
    finally { setPoolBusy(false); }
  };

  const clearHold = async () => {
    setSaving(true);
    try {
      await post('/settings/spotify/hold/clear');
      notify.ok('Rate-limit hold cleared — the station will ask again');
      refresh();
    } catch (err) { notify.err(errorMessage(err)); }
    finally { setSaving(false); }
  };

  const forgetRefused = async () => {
    setSaving(true);
    try {
      const j = (await post('/settings/spotify/unplayable/clear')) as { forgotten?: number; restored?: number };
      notify.ok(`Forgot ${j.forgotten ?? 0} refused track(s); ${j.restored ?? 0} back in the library`);
      refresh();
    } catch (err) { notify.err(errorMessage(err)); }
    finally { setSaving(false); }
  };

  const savePool = () => saveSettings({ spotify: { pool: { playlistIds: playlistText } } });

  const receiverSignIn = async () => {
    try {
      const r = await adminResponse(adminFetch, '/settings/spotify/receiver/auth');
      const j = (await r.json()) as { ok?: boolean; url?: string; error?: string };
      if (!j.ok || !j.url) return notify.err(j.error || 'could not start the receiver sign-in');
      window.location.href = j.url;
    } catch (err) { notify.err(errorMessage(err)); }
  };

  const receiverFinish = async () => {
    if (!receiverPaste.trim()) return;
    setSaving(true);
    try {
      const j = await post('/settings/spotify/receiver/code', { redirectUrl: receiverPaste.trim() });
      if (j.ok === false) return notify.err(j.error || 'sign-in failed');
      notify.ok('Receiver signed in — it logs in on its next start');
      setReceiverPaste('');
      refresh();
    } catch (err) { notify.err(errorMessage(err)); }
    finally { setSaving(false); }
  };
  const envHint = (envVar: string) => (
    <div className="field-hint">Set via <code>{envVar}</code> in the root <code>.env</code> — env always wins on boot.</div>
  );

  return (
    <>
      <Card title="Spotify account" sub="A Spotify Developer app + a Premium account. Music plays on a Spotify Connect receiver inside the broadcast container.">
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <Label htmlFor="sp-client-id">Client ID</Label>
            <Input id="sp-client-id" value={clientId} onChange={(e) => setClientId(e.target.value)}
              placeholder={st?.clientIdSet ? '•••••••• (set)' : '32-hex id from developer.spotify.com'} disabled={!!st?.env?.clientId} />
            {st?.env?.clientId ? envHint('SPOTIFY_CLIENT_ID') : null}
          </div>
          <div>
            <Label htmlFor="sp-client-secret">Client secret</Label>
            <Input id="sp-client-secret" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)}
              placeholder={st?.clientSecretSet ? '•••••••• (set — leave blank to keep)' : ''} disabled={!!st?.env?.clientSecret} />
            {st?.env?.clientSecret ? envHint('SPOTIFY_CLIENT_SECRET') : null}
          </div>
        </div>
        <div className="field-hint mt-2">
          Register this redirect URI on the app: <code>{st?.redirectUri ?? '…/api/settings/spotify/callback'}</code>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Btn sm onClick={saveCredentials} disabled={saving || (!clientId && !clientSecret)}>Save credentials</Btn>
          <Btn sm tone="accent" onClick={connect} disabled={saving || !st?.clientIdSet || !st?.clientSecretSet}>
            {st?.connected ? 'Reconnect Spotify' : 'Connect Spotify'}
          </Btn>
          <Btn sm onClick={test} disabled={probing || !st?.connected}>{probing ? 'Testing…' : 'Test'}</Btn>
          {st?.connected ? <Btn sm onClick={disconnect} disabled={saving || !!st?.env?.refreshToken}>Disconnect</Btn> : null}
          <span className="text-sm opacity-80">
            {st?.connected ? 'connected' : 'not connected'}
            {probe ? (probe.ok ? ` · ${probe.displayName}${probe.product ? ` · ${probe.product}` : ''}${probe.country ? ` · ${probe.country}` : ''}` : ` · ${probe.error}`) : ''}
          </span>
        </div>
        {probe?.ok && probe.note ? (
          <div className="field-hint mt-2">{probe.note}</div>
        ) : null}
        {probe?.ok && probe.product && probe.product !== 'premium' ? (
          <div className="field-hint mt-2">This account is <b>{probe.product}</b>. Spotify Connect playback needs Premium.</div>
        ) : null}
        <details className="mt-3">
          <summary className="cursor-pointer text-sm">Paste a refresh token instead</summary>
          <div className="mt-2 flex gap-2">
            <Input value={refreshToken} onChange={(e) => setRefreshToken(e.target.value)} placeholder="refresh token from an OAuth flow you ran elsewhere" disabled={!!st?.env?.refreshToken} />
            <Btn sm onClick={pasteToken} disabled={saving || !refreshToken.trim()}>Store</Btn>
          </div>
          {st?.env?.refreshToken ? envHint('SPOTIFY_REFRESH_TOKEN') : null}
        </details>
      </Card>

      <Card title="Library pool" sub="What counts as the station's library on Spotify. Random picks, genre browsing and the mood tagger draw from this pool; search reaches the whole catalog.">
        <Label htmlFor="sp-playlists">Playlists (one per line — ids, spotify:playlist: URIs or open.spotify.com links; empty = every playlist the account owns or follows)</Label>
        <Textarea id="sp-playlists" className="min-h-28 font-mono text-sm" value={playlistText}
          onChange={(e) => setPlaylistText(e.target.value)} disabled={busy} />
        <div className="mt-3 flex flex-wrap items-center gap-6">
          <label className="flex items-center gap-2 text-sm">
            <Toggle on={sp?.pool?.includeSaved !== false} disabled={busy}
              onClick={() => saveSettings({ spotify: { pool: { includeSaved: !(sp?.pool?.includeSaved !== false) } } })} ariaLabel="include saved tracks" />
            Include saved (liked) tracks
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Toggle on={!!sp?.pool?.includeSavedAlbums} disabled={busy}
              onClick={() => saveSettings({ spotify: { pool: { includeSavedAlbums: !sp?.pool?.includeSavedAlbums } } })} ariaLabel="include saved albums" />
            Include saved albums
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Btn sm onClick={savePool} disabled={busy || playlistText === (sp?.pool?.playlistIds ?? []).join('\n')}>Save playlists</Btn>
          <Btn sm onClick={rebuildPool} disabled={poolBusy || !st?.connected}>{poolBusy ? 'Rebuilding…' : 'Rebuild pool now'}</Btn>
          <span className="text-sm opacity-80">
            {st?.pool
              ? `${st.pool.tracks} tracks · ${st.pool.albums} albums · ${st.pool.playlists} playlists${st.pool.partial ? ' · partial' : ''}${st.pool.fromDisk ? ' · from the saved snapshot' : ''}`
              : 'pool not built yet — it builds on first use'}
          </span>
        </div>
        {/* A partial build used to say only "partial", which sent the operator
            to the container logs. The reasons ride out on the status now. */}
        {st?.pool?.notes?.length ? (
          <ul className="field-hint mt-2 list-disc pl-5">
            {st.pool.notes.map((n) => <li key={n}>{n}</li>)}
          </ul>
        ) : null}
        {st?.pool && st.pool.tracks === 0 ? (
          <div className="field-hint mt-2">
            An empty pool means nothing to play: the station falls back to the mixer&apos;s emergency loop.
            Spotify serves playlist contents only for playlists this account <b>owns or collaborates on</b> — a followed
            playlist resolves its name but returns no tracks.
          </div>
        ) : null}
        {/* Genre enrichment costs one request per artist (Spotify removed the
            batch read), so it fills a little per rebuild and is cached on disk.
            Without a progress line a converging background job looks broken. */}
        {st?.pool && (st.pool.genresPending ?? 0) > 0 ? (
          <div className="field-hint mt-2">
            Artist genres: <b>{(st.pool.artists ?? 0) - (st.pool.genresPending ?? 0)}</b> of{' '}
            <b>{st.pool.artists ?? 0}</b> artists tagged, {st.pool.genresPending} still to fetch.
            Spotify charges one request per artist, so this fills in the background at about{' '}
            <b>{sp?.quota?.genresPerHour ?? 750}/hour</b> and is remembered across restarts — genre shows and
            genre picking sharpen as it goes. It pauses while Spotify is holding the station off, and picks
            itself back up afterwards.
          </div>
        ) : null}
        {st?.pool?.truncated ? (
          <div className="field-hint mt-2">
            The pool stopped at its <b>{st.pool.tracks}-track cap</b>, so it holds only part of your
            playlists. Raise <code>maxTracks</code> to take in the rest. While the walk is capped the
            tagger will not remove tracks that have left your playlists either — it never deletes
            against a partial view of the library.
          </div>
        ) : null}
        {st?.pool && (st.pool.rateLimitedMs ?? 0) > 0 ? (
          <div className="field-hint mt-2">
            {st.pool.hold?.kind === 'quota' ? (
              <>
                <b>Spotify&apos;s developer-account quota is exhausted</b> — resuming in about{' '}
                {Math.ceil((st.pool.rateLimitedMs ?? 0) / 1000)}s. This is not the 30-second rate limit: since July
                2026 the Development Mode quota is counted per developer <b>account</b> and shared by every app on
                it. Music keeps playing throughout. If it keeps happening, ease the figures below down.
              </>
            ) : (
              <>
                <b>Spotify is rate-limiting this app</b> — resuming in about {Math.ceil((st.pool.rateLimitedMs ?? 0) / 1000)}s.
                The station holds off on its own; music keeps playing and enrichment continues when the window clears.
                The limit belongs to Development Mode and cannot be raised.
              </>
            )}
            <div className="mt-2">
              <Btn sm onClick={clearHold} disabled={saving}>Clear hold</Btn>
              <span className="ml-2">
                Only if you believe the hold is wrong — clearing it does not make Spotify more willing, it just lets
                the station ask once and find out.
              </span>
            </div>
          </div>
        ) : null}
        {/* The drip is the one background job with nothing on air to show for
            itself, so when it is standing down it has to say so. Eight hours of
            "0 of 123 tagged" with no explanation is what this line is for. */}
        {st?.pool?.dripSkip ? (
          <div className="field-hint mt-2">Artist genres: {st.pool.dripSkip}.</div>
        ) : null}
        {/* Spotify only tells the station a track is unplayable when it tries to
            play it — February 2026 removed every field that could have said so in
            advance — so the refusals are remembered. A shrinking library must be
            visible and undoable, hence the count, the titles and the button. */}
        {(st?.unplayable?.count ?? 0) > 0 ? (
          <div className="field-hint mt-2">
            <b>{st!.unplayable!.count} track(s)</b> Spotify refused to play on this account are being held
            back, so the DJ cannot keep picking them. Spotify gives no way to know this in advance — the
            station finds out by trying — and each one is forgotten again after{' '}
            {st!.unplayable!.ttlDays} days in case the licensing comes back.
            {st!.unplayable!.recent?.length ? (
              <div className="mt-1 opacity-80">
                {st!.unplayable!.recent.slice(0, 5).map((r) => (
                  <div key={r.id}>
                    {r.title || r.id}{r.artist ? ` — ${r.artist}` : ''}
                    {r.hits > 1 ? ` (refused ${r.hits}×)` : ''}
                  </div>
                ))}
                {st!.unplayable!.count > 5 ? <div>…and {st!.unplayable!.count - 5} more</div> : null}
              </div>
            ) : null}
            <div className="mt-2">
              <Btn sm onClick={forgetRefused} disabled={saving}>Forget refused tracks</Btn>
              <span className="ml-2">
                Puts them back in the library at no cost to your Spotify quota. They will be re-tagged the
                next time the tagger runs, and any that are still unplayable will simply be refused again.
              </span>
            </div>
          </div>
        ) : null}
        {st?.pool?.fromDisk ? (
          <div className="field-hint mt-2">
            This pool was restored from its saved snapshot, which is why the station was playing seconds after
            starting rather than walking your whole library first. It is re-checked against Spotify on the next
            refresh; until then the tagger will not remove tracks, since it never deletes against a view it has
            not confirmed itself.
          </div>
        ) : null}
      </Card>

      <Card title="Seam tracing" sub="Extra detail about how the station drives the Spotify receiver: every player event it folds, every seam decision, every play command and why a track was refused.">
        <label className="flex items-center gap-2 text-sm">
          <Toggle on={!!sp?.verboseLog} disabled={busy}
            onClick={() => saveSettings({ spotify: { verboseLog: !sp?.verboseLog } })} ariaLabel="verbose Spotify logging" />
          Verbose Spotify logging
        </label>
        <div className="field-hint mt-2">
          Takes effect immediately — no restart, no rebuild. Lines go to the controller&apos;s container log
          (<code>docker compose logs -f controller</code>, prefixed <code>[spotify+]</code>) and to the
          station&apos;s event log under <code>state/logs/</code>, never to the booth log, which is only 200
          lines deep and would be flushed within two minutes. Leave it off unless you are chasing something.
        </div>
      </Card>

      <Card title="Spotify quota" sub="Spotify meters this app on a rolling 30-second window, and since July 2026 the Development Mode budget is shared across every app on your developer account. These bound what the station spends on the catalogue; playback is exempt and never waits on them.">
        <div className="grid gap-4 md:grid-cols-3">
          <div>
            <Label htmlFor="sp-rps">Requests per 30s</Label>
            <Input id="sp-rps" type="number" min={10} max={1000} value={rps} disabled={busy}
              onChange={(e) => setRps(e.target.value)}
              onBlur={() => commitNumber(rps, sp?.quota?.requestsPer30s ?? 90, (n) => saveSettings({ spotify: { quota: { requestsPer30s: n } } }))} />
            <div className="field-hint">
              A starting ceiling rather than a promise: Spotify publishes no figure for Development Mode, so the
              station halves this whenever it is refused and eases back over quiet windows. Lower it if other apps
              share this developer account.
              {st?.pool?.pacer ? ` Currently allowing ${st.pool.pacer.ceiling}, with ${st.pool.pacer.usedInWindow ?? 0} used this window.` : ''}
              {st?.pool?.reads ? ` Reusing ${st.pool.reads.albums ?? 0} cached albums and ${st.pool.reads.searches ?? 0} searches.` : ''}
            </div>
          </div>
          <div>
            <Label htmlFor="sp-genres">Artist genres per hour</Label>
            <Input id="sp-genres" type="number" min={0} max={5000} value={genresPerHour} disabled={busy}
              onChange={(e) => setGenresPerHour(e.target.value)}
              onBlur={() => commitNumber(genresPerHour, sp?.quota?.genresPerHour ?? 750, (n) => saveSettings({ spotify: { quota: { genresPerHour: n } } }))} />
            <div className="field-hint">
              Spotify tags artists rather than tracks and removed the batch lookup, so each artist costs one request.
              This is a background drip that stops on its own once every artist is known. <b>0</b> turns it off and
              leaves whatever is already cached.
            </div>
          </div>
          <div>
            <Label htmlFor="sp-fullwalk">Full re-walk every (hours)</Label>
            <Input id="sp-fullwalk" type="number" min={1} max={168} value={fullWalkHours} disabled={busy}
              onChange={(e) => setFullWalkHours(e.target.value)}
              onBlur={() => commitNumber(fullWalkHours, sp?.pool?.fullWalkHours ?? 24, (n) => saveSettings({ spotify: { pool: { fullWalkHours: n } } }))} />
            <div className="field-hint">
              Most refreshes only re-read the playlists Spotify says have changed, which costs a handful of requests
              instead of one per fifty tracks. A full walk reads everything, and catches the rare edit that leaves a
              playlist&apos;s length and newest track untouched.
            </div>
          </div>
        </div>
      </Card>

      <Card title="Playback" sub="The Spotify Connect receiver (librespot) runs inside the broadcast container and is commanded by the station.">
        <div className="mb-4 rounded-md border border-ink p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">Receiver sign-in</span>
            <span className="text-sm opacity-80">
              {rx?.credentialsCached ? 'signed in (credentials cached)' : rx?.tokenValid ? 'token ready — the receiver logs in on its next start' : rx?.tokenPresent ? 'token expired' : 'not signed in'}
              {rx?.refreshTokenPresent ? ' · auto-renews' : ''}
            </span>
            <Btn sm tone="accent" onClick={receiverSignIn} disabled={saving}>{rx?.credentialsCached || rx?.tokenValid ? 'Sign the receiver in again' : 'Sign the receiver in'}</Btn>
          </div>
          <div className="field-hint mt-2">
            A second, separate login: the receiver speaks to Spotify as Spotify&apos;s own desktop client, so your app&apos;s
            token cannot be used for it. Spotify sends you to <code>{rx?.redirectUri ?? 'http://127.0.0.1:5588/login'}</code> afterwards.
            With <code>docker-compose.spotify.yml</code> in your compose command that page completes the sign-in by itself;
            otherwise it fails to load — copy the whole address from the address bar and paste it here.
          </div>
          <div className="mt-2 flex gap-2">
            <Input value={receiverPaste} onChange={(e) => setReceiverPaste(e.target.value)} placeholder="http://127.0.0.1:5588/login?code=…&state=…" />
            <Btn sm onClick={receiverFinish} disabled={saving || !receiverPaste.trim()}>Finish sign-in</Btn>
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <Label htmlFor="sp-device">Device name</Label>
            <Input id="sp-device" value={deviceName} onChange={(e) => setDeviceName(e.target.value)} placeholder="SUB/WAVE" disabled={busy}
              onBlur={() => { if (deviceName !== (sp?.deviceName ?? '')) saveSettings({ spotify: { deviceName } }); }} />
            <div className="field-hint">How the receiver appears in Spotify apps. Changing it needs a mixer restart.</div>
          </div>
          <div>
            <Label>If playback is moved to another device</Label>
            <div className="mt-1 flex gap-2">
              <Btn sm tone={sp?.mismatch !== 'follow' ? 'accent' : undefined} disabled={busy} onClick={() => saveSettings({ spotify: { mismatch: 'reclaim' } })}>Reclaim it</Btn>
              <Btn sm tone={sp?.mismatch === 'follow' ? 'accent' : undefined} disabled={busy} onClick={() => saveSettings({ spotify: { mismatch: 'follow' } })}>Follow it</Btn>
            </div>
            <div className="field-hint">Reclaim transfers playback back to the station and plays what the DJ picked; follow adopts whatever is playing.</div>
          </div>
        </div>
      </Card>
    </>
  );
}
