// The receiver (librespot) sign-in: PKCE for Spotify's OWN desktop client id,
// the exact redirect librespot registers, librespot's scope list, and a token
// exchange that carries client_id + code_verifier and NO Authorization header
// (a public client). Plus the paste-back parser and the pending-state rules.
//
// Run: npm test -- spotify-receiver-auth

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  LIBRESPOT_CLIENT_ID, LIBRESPOT_REDIRECT_URI, LIBRESPOT_SCOPES,
  pkcePair, receiverAuthorizeUrl, parseReceiverRedirect, exchangeReceiverCode, refreshReceiverToken,
  beginReceiverAuth, takeReceiverVerifier,
} from '../src/music/sources/spotify/receiver-auth.js';

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

test('PKCE: S256 challenge of a 43–128 char verifier', () => {
  const { verifier, challenge } = pkcePair();
  assert.ok(verifier.length >= 43 && verifier.length <= 128);
  assert.equal(challenge, b64url(createHash('sha256').update(verifier).digest()));
});

test('the authorize URL is librespot’s: its client id, its redirect, its scopes, S256', () => {
  const u = new URL(receiverAuthorizeUrl({ challenge: 'c', state: 's' }));
  assert.equal(u.searchParams.get('client_id'), LIBRESPOT_CLIENT_ID);
  assert.equal(LIBRESPOT_CLIENT_ID, '65b708073fc0480ea92a077233ca87bd', 'librespot-core KEYMASTER_CLIENT_ID');
  assert.equal(u.searchParams.get('redirect_uri'), 'http://127.0.0.1:5588/login');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('code_challenge'), 'c');
  const scopes = (u.searchParams.get('scope') ?? '').split(' ');
  for (const s of LIBRESPOT_SCOPES) assert.ok(scopes.includes(s));
  assert.ok(scopes.includes('streaming'));
  assert.equal(LIBRESPOT_SCOPES.length, 26, 'librespot main.rs OAUTH_SCOPES, verbatim');
});

test('the pasted landing URL yields code + state; a bare code is accepted; junk is null', () => {
  assert.deepEqual(parseReceiverRedirect(`${LIBRESPOT_REDIRECT_URI}?code=AQabc123_-xyz&state=st1`), { code: 'AQabc123_-xyz', state: 'st1' });
  assert.deepEqual(parseReceiverRedirect('AQabcdefghijklmnopqrstuvwxyz0123456789'), { code: 'AQabcdefghijklmnopqrstuvwxyz0123456789', state: null });
  assert.equal(parseReceiverRedirect('http://127.0.0.1:5588/login?error=access_denied'), null);
  assert.equal(parseReceiverRedirect('not a url'), null);
  assert.equal(parseReceiverRedirect(''), null);
});

function fakeFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; init: any }> = [];
  const f = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return { ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as any;
  }) as unknown as typeof fetch;
  return { f, calls };
}

test('the code exchange is a PUBLIC-client request: client_id + code_verifier in the body, no Authorization header', async () => {
  const { f, calls } = fakeFetch({ access_token: 'A', refresh_token: 'R', expires_in: 3600, scope: 'streaming' });
  const tok = await exchangeReceiverCode('CODE', 'VERIFIER', f, () => 1_000);
  assert.equal(tok.accessToken, 'A');
  assert.equal(tok.refreshToken, 'R');
  assert.equal(tok.expiresAt, 1_000 + 3_600_000);
  const body = new URLSearchParams(String(calls[0].init.body));
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('client_id'), LIBRESPOT_CLIENT_ID);
  assert.equal(body.get('code_verifier'), 'VERIFIER');
  assert.equal(body.get('redirect_uri'), LIBRESPOT_REDIRECT_URI);
  assert.equal(calls[0].init.headers.Authorization, undefined);
});

test('refresh uses the same public-client shape; a rejection surfaces as SpotifyAuthError', async () => {
  const { f, calls } = fakeFetch({ access_token: 'A2', expires_in: 60 });
  const tok = await refreshReceiverToken('R', f, () => 0);
  assert.equal(tok.accessToken, 'A2');
  assert.equal(new URLSearchParams(String(calls[0].init.body)).get('grant_type'), 'refresh_token');
  const bad = fakeFetch({ error: 'invalid_grant', error_description: 'Refresh token revoked' }, 400);
  await assert.rejects(refreshReceiverToken('R', bad.f), /invalid_grant|revoked/);
});

test('pending states: the matching state hands back its verifier once; a lone pending sign-in accepts a state-less paste', () => {
  let now = 1_000;
  const clock = () => now;
  const a = beginReceiverAuth(clock);
  assert.ok(new URL(a.url).searchParams.get('state') === a.state);
  assert.ok(takeReceiverVerifier(a.state, clock));
  assert.equal(takeReceiverVerifier(a.state, clock), null, 'consumed');
  const b = beginReceiverAuth(clock);
  assert.ok(takeReceiverVerifier(null, clock), 'only one pending → the state-less paste is unambiguous');
  assert.equal(takeReceiverVerifier(b.state, clock), null);
  beginReceiverAuth(clock); beginReceiverAuth(clock);
  assert.equal(takeReceiverVerifier(null, clock), null, 'two pending → ambiguous, refused');
  now += 11 * 60 * 1000;
  const c = beginReceiverAuth(clock);
  assert.ok(takeReceiverVerifier(c.state, clock), 'a fresh state works after the old ones expired');
});
