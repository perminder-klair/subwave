// The edge denies Icecast's URL-auth callback (#478) in BOTH Caddyfiles —
// docker/Caddyfile and the AIO's docker/aio/Caddyfile — which must stay in
// lockstep. The controller's router answers `/listener-auth/` and any case
// variant as well as the exact path, so an exact-path deny leaves those routed
// through `handle_path /api/*`. The deny must be a prefix.
//
// The matcher below restates the two Caddy path-matcher rules the deny relies
// on — case-insensitive, and a trailing `*` is a prefix — rather than running
// Caddy, which CI does not have. Checked against caddy:2 directly: the old
// exact rule proxied `/api/listener-auth/`, the prefix 404s every variant here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const FILES = ['docker/Caddyfile', 'docker/aio/Caddyfile'];

// The path tokens of the `handle` block that names listener-auth, and its
// position relative to the general API route.
function denyRule(file: string) {
  const lines = readFileSync(root + file, 'utf8').split('\n');
  const at = lines.findIndex((l) => /^\s*handle\s+\S*listener-auth/i.test(l));
  assert.notEqual(at, -1, `${file} has a listener-auth handle block`);
  const tokens = lines[at].trim().replace(/\{\s*$/, '').trim().split(/\s+/).slice(1);
  const body = lines.slice(at + 1, at + 4).join('\n');
  const api = lines.findIndex((l) => /^\s*handle_path\s+\/api\/\*/.test(l));
  return { tokens, body, at, api };
}

function caddyPathMatches(pattern: string, path: string): boolean {
  const p = pattern.toLowerCase();
  const v = path.toLowerCase();
  return p.endsWith('*') ? v.startsWith(p.slice(0, -1)) : v === p;
}

const DENIED = ['/api/listener-auth', '/api/listener-auth/', '/API/Listener-Auth', '/api/Listener-Auth/', '/api/listener-auth/x'];
const ROUTED = ['/api/station-auth', '/api/health', '/api/state', '/api/listen'];

for (const file of FILES) {
  test(`${file} denies every listener-auth variant the router answers`, () => {
    const { tokens, body, at, api } = denyRule(file);
    assert.match(body, /respond\s+404/, 'the block answers 404');
    assert.ok(api > at, 'the deny sits ahead of handle_path /api/*');
    for (const path of DENIED) {
      assert.ok(tokens.some((t) => caddyPathMatches(t, path)), `${path} is denied`);
    }
    for (const path of ROUTED) {
      assert.ok(!tokens.some((t) => caddyPathMatches(t, path)), `${path} still reaches the controller`);
    }
  });
}

test('the two Caddyfiles deny the same paths', () => {
  const [a, b] = FILES.map((f) => denyRule(f).tokens.join(' '));
  assert.equal(a, b);
});
