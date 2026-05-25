// CLI helper that walks the operator through Last.fm's web auth flow and
// prints a long-lived session key they can paste into /admin/settings.
//
// Why this exists: SUB/WAVE's scrobbling integration is paste-only (no
// OAuth callback route, no redirect dance — see broadcast/scrobble.ts).
// But Last.fm doesn't hand out session keys directly; you still have to
// trade an auth token for one over auth.getSession. This script does that
// locally in the terminal so the operator never has to write code or wire
// up a callback URL on their host just to authorize the integration.
//
// Run:
//   cd controller && npm run lastfm-session
//
// You'll need an API account first: https://www.last.fm/api/account/create
// (any "Application name" / "Callback URL: http://localhost/" is fine — the
// callback isn't used by this flow.)

import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const API = 'https://ws.audioscrobbler.com/2.0/';

function sign(params: Record<string, string>, secret: string): string {
  const keys = Object.keys(params).filter(k => k !== 'format' && k !== 'callback').sort();
  const sigStr = keys.map(k => k + params[k]).join('') + secret;
  return createHash('md5').update(sigStr, 'utf8').digest('hex');
}

async function call(method: string, params: Record<string, string>, secret: string): Promise<any> {
  const all = { ...params, method };
  (all as any).api_sig = sign(all, secret);
  (all as any).format = 'json';
  const url = `${API}?${new URLSearchParams(all).toString()}`;
  const r = await fetch(url);
  const text = await r.text();
  let data: any = {};
  try { data = JSON.parse(text); } catch {}
  if (!r.ok || data?.error) {
    const msg = data?.message || text.slice(0, 200) || `HTTP ${r.status}`;
    throw new Error(`last.fm ${method}: ${msg}`);
  }
  return data;
}

async function main() {
  const rl = createInterface({ input, output });
  try {
    console.log('SUB/WAVE — Last.fm session key helper');
    console.log('-------------------------------------');
    console.log('Get an API account at https://www.last.fm/api/account/create');
    console.log('(any callback URL works; we will not use it).');
    console.log('');

    const apiKey = (await rl.question('Last.fm API key:    ')).trim();
    const apiSecret = (await rl.question('Last.fm API secret: ')).trim();
    if (!apiKey || !apiSecret) {
      console.error('Both API key and secret are required.');
      process.exit(1);
    }

    console.log('');
    console.log('Requesting an auth token…');
    const tokenRes = await call('auth.getToken', { api_key: apiKey }, apiSecret);
    const token: string = tokenRes?.token;
    if (!token) {
      console.error('Last.fm did not return a token. Response:', tokenRes);
      process.exit(1);
    }

    const authUrl = `https://www.last.fm/api/auth/?api_key=${encodeURIComponent(apiKey)}&token=${encodeURIComponent(token)}`;
    console.log('');
    console.log('Open this URL in a browser and click "Yes, allow access":');
    console.log('');
    console.log(`  ${authUrl}`);
    console.log('');
    await rl.question('Press Enter once you have authorized…');

    console.log('');
    console.log('Exchanging token for a session key…');
    const sessRes = await call(
      'auth.getSession',
      { api_key: apiKey, token },
      apiSecret,
    );
    const sk: string | undefined = sessRes?.session?.key;
    const user: string | undefined = sessRes?.session?.name;
    if (!sk) {
      console.error('Last.fm did not return a session key. Response:', sessRes);
      process.exit(1);
    }

    console.log('');
    console.log('Success — paste these into /admin/settings → Scrobbling → Last.fm:');
    console.log('');
    console.log(`  API key:     ${apiKey}`);
    console.log(`  API secret:  ${apiSecret}`);
    console.log(`  Session key: ${sk}`);
    console.log(`  Username:    ${user || '(unknown)'}`);
    console.log('');
    console.log('The session key does not expire. Keep it secret.');
  } finally {
    rl.close();
  }
}

main().catch(err => {
  console.error('Failed:', err?.message || err);
  process.exit(1);
});
