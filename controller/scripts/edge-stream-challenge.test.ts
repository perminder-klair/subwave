// Icecast refuses a listener with a 401 carrying `WWW-Authenticate: Basic`. Both
// Caddyfiles — docker/Caddyfile and the AIO's docker/aio/Caddyfile, in lockstep —
// keep that challenge for a client that answers it and drop it for one that
// can't. ffmpeg, mpv, GStreamer and wget send `user:pass@` only after being
// challenged, so a blanket strip locks them out of a private station. A media
// element can't answer: the browser raises its native "Sign in" dialog over the
// whole page instead.
//
// The matcher below restates the Caddy rules the drop relies on — `query k=*`
// means the key is present, its name case-sensitive; `header` values are exact,
// and repeated lines for one field in a matcher are OR'd — rather than running
// Caddy, which CI does not have. Checked against caddy:2 directly, along with
// nginx and Traefik for the recipes pinned at the end.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const FILES = ['docker/Caddyfile', 'docker/aio/Caddyfile'];

type Rule = { query: string[]; headers: Record<string, string[]> };
type Request = { query?: string; dest?: string };

// The lines of `handle @streams { … }`, comments and blanks gone.
function streamBlock(file: string): string[] {
  const lines = readFileSync(root + file, 'utf8').split('\n');
  const at = lines.findIndex((l) => /^\s*handle\s+@streams\s*\{/.test(l));
  assert.notEqual(at, -1, `${file} has a handle @streams block`);
  const out: string[] = [];
  let depth = 1;
  for (const raw of lines.slice(at + 1)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (depth === 0) return out;
    out.push(line);
  }
  assert.fail(`${file}: handle @streams never closes`);
}

// The named matchers of a block, one line or `{ … }`.
function matchers(block: string[]): Map<string, Rule> {
  const named = new Map<string, Rule>();
  const add = (rule: Rule, line: string) => {
    const query = line.match(/^query\s+(\S+)=\*$/);
    const header = line.match(/^header\s+(\S+)\s+(\S+)$/);
    if (query) rule.query.push(query[1]);
    else if (header) (rule.headers[header[1].toLowerCase()] ??= []).push(header[2]);
    else assert.fail(`unmodelled matcher line: ${line}`);
  };
  for (let i = 0; i < block.length; i += 1) {
    const open = block[i].match(/^(@\S+)\s*(.*)$/);
    if (!open) continue;
    const rule: Rule = { query: [], headers: {} };
    named.set(open[1], rule);
    if (open[2] !== '{') {
      add(rule, open[2]);
      continue;
    }
    for (i += 1; block[i] !== '}'; i += 1) add(rule, block[i]);
  }
  return named;
}

function ruleMatches(rule: Rule, req: Request): boolean {
  const keys = (req.query ?? '').split('&').map((pair) => pair.split('=')[0]);
  const query = rule.query.every((k) => keys.includes(k));
  const headers = Object.entries(rule.headers).every(([field, values]) => field === 'sec-fetch-dest' && values.includes(req.dest ?? ''));
  return query && headers;
}

// Whether a 401 for this request reaches the client without its challenge.
function challengeDropped(block: string[], req: Request): boolean {
  const named = matchers(block);
  return block.some((line) => {
    const drop = line.match(/^header\s+(@\S+)\s+-WWW-Authenticate$/i);
    if (!drop) return false;
    const rule = named.get(drop[1]);
    assert.ok(rule, `${drop[1]} is defined in the block`);
    return ruleMatches(rule, req);
  });
}

// A client that answers a challenge, or that may: nothing about it says otherwise.
const KEEPS: Array<[string, Request]> = [
  ['ffmpeg, mpv, GStreamer, wget: no token, no fetch metadata', {}],
  ['a token-less URL with other parameters', { query: 't=1' }],
  ['a browser tab on the stream URL', { dest: 'document' }],
  ['a page fetch', { dest: 'empty' }],
  ['a parameter that only resembles the token', { query: 'xauth=x' }],
  ['the token name in another case, which the controller ignores', { query: 'Auth=x' }],
];

const DROPS: Array<[string, Request]> = [
  ['the web player, the app and Cast riding the token', { query: 'auth=stale' }],
  ['the web player: its cache-buster first', { query: 't=1&auth=stale' }],
  ['a token on a plain http origin, where browsers send no fetch metadata', { query: 'auth=stale' }],
  ['an <audio> tap before the token exists', { dest: 'audio' }],
  ['a <video> element', { dest: 'video' }],
];

for (const file of FILES) {
  test(`${file} keeps the challenge for a client that may answer it`, () => {
    const block = streamBlock(file);
    for (const [label, req] of KEEPS) assert.equal(challengeDropped(block, req), false, label);
  });

  test(`${file} drops the challenge for a client that can't answer it`, () => {
    const block = streamBlock(file);
    for (const [label, req] of DROPS) assert.equal(challengeDropped(block, req), true, label);
  });

  test(`${file} touches WWW-Authenticate nowhere else`, () => {
    const lines = readFileSync(root + file, 'utf8').split('\n').map((l) => l.trim());
    const live = lines.filter((l) => /www-authenticate/i.test(l) && !l.startsWith('#'));
    assert.ok(live.length > 0);
    // header_down has no matcher, and a bare `header -…` has none either: each is the blanket strip.
    for (const line of live) assert.match(line, /^header\s+@\S+\s+-WWW-Authenticate$/i);
    for (const line of live) assert.ok(streamBlock(file).includes(line), `${line} is inside handle @streams`);
  });
}

test('the two Caddyfiles treat a stream request the same', () => {
  const upstream = /^reverse_proxy\s+\S+\s*\{$/;
  const [a, b] = FILES.map((f) => streamBlock(f).map((l) => (upstream.test(l) ? 'reverse_proxy {' : l)));
  assert.deepEqual(a, b);
});

// A BYO proxy replicates the routes by hand, and each recipe has one easy way to
// get this wrong: hiding the header on the route every client takes.
test('the nginx recipes hide the challenge only on the media route', () => {
  const doc = readFileSync(`${root}docs/reverse-proxy.md`, 'utf8');
  const blocks = [...doc.matchAll(/```nginx\n([\s\S]*?)```/g)].map((m) => m[1]).filter((b) => b.includes('location ^~ /stream'));
  assert.equal(blocks.length, 2, 'nginx and Nginx Proxy Manager');
  for (const block of blocks) {
    const location = (name: string) => block.slice(block.indexOf(name)).split('\n}\n')[0];
    const stream = location('location ^~ /stream');
    const media = location('location @stream-media');
    assert.doesNotMatch(stream, /proxy_hide_header/);
    assert.match(stream, /error_page 418 = @stream-media;/);
    assert.match(stream, /if \(\$arg_auth\) \{\s*return 418;/);
    assert.match(stream, /if \(\$http_sec_fetch_dest ~ \^\(audio\|video\)\$\) \{\s*return 418;/);
    assert.match(media, /proxy_hide_header WWW-Authenticate;/);
    // The internal route still has to be a live stream route.
    for (const directive of ['proxy_buffering off;', 'proxy_cache off;', 'proxy_read_timeout 1h;', 'gzip off;']) {
      assert.ok(media.includes(directive), directive);
    }
  }
});

test('the Traefik recipe drops the challenge on a second router, never the first', () => {
  const doc = readFileSync(`${root}docs/reverse-proxy.md`, 'utf8');
  const yaml = [...doc.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]).find((b) => b.includes('subwave-stream.rule'));
  assert.ok(yaml, 'the Traefik overlay');
  const label = (name: string) => yaml.split('\n').find((l) => l.trim().startsWith(`${name}:`))?.trim().slice(name.length + 1).trim();
  assert.equal(label('traefik.http.routers.subwave-stream.middlewares'), undefined);
  assert.equal(label('traefik.http.middlewares.subwave-no-challenge.headers.customresponseheaders.WWW-Authenticate'), '""');
  assert.equal(label('traefik.http.routers.subwave-stream-media.middlewares'), 'subwave-no-challenge');
  assert.equal(label('traefik.http.routers.subwave-stream-media.service'), 'subwave-stream');
  assert.match(label('traefik.http.routers.subwave-stream-media.rule') ?? '', /QueryRegexp\(`auth`, `\.\+`\).*HeaderRegexp\(`Sec-Fetch-Dest`, `\^\(audio\|video\)\$`\)/);
  const priority = (router: string) => Number(label(`traefik.http.routers.${router}.priority`)?.replace(/"/g, ''));
  assert.ok(priority('subwave-stream-media') > priority('subwave-stream'), 'the media router wins');
});
