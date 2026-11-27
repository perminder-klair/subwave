// Shared by the router's HTTP-level tests: a temp ROUTER_DIR, a running
// router on an ephemeral port, and Subsonic auth helpers.
//
// config.ts reads its environment at import, so env is set BEFORE the dynamic
// import. node --test runs each file in its own process, so each test file gets
// a fresh router.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const USER = 'subwave';
export const PASS = 'test-password-0123456789';

export interface RunningRouter {
  base: string;
  dir: string;
  server: Server;
  /** Query string with a fresh salt+token, as a Subsonic client sends. */
  auth(user?: string, pass?: string): string;
  rest(endpoint: string, params?: Record<string, string | number | string[]>): Promise<Record<string, any>>;
  internal(path: string, init?: RequestInit): Promise<Response>;
  writeConfig(config: unknown): void;
  close(): Promise<void>;
}

export function authQuery(user = USER, pass = PASS): string {
  const salt = randomBytes(6).toString('hex');
  const token = createHash('md5').update(pass + salt).digest('hex');
  return `u=${encodeURIComponent(user)}&t=${token}&s=${salt}&v=1.16.1&c=test&f=json`;
}

export async function startRouter(opts: { pluginsDir?: string; env?: Record<string, string> } = {}): Promise<RunningRouter> {
  const dir = mkdtempSync(join(tmpdir(), 'router-test-'));
  mkdirSync(join(dir, 'plugins'), { recursive: true });
  process.env.ROUTER_DIR = dir;
  process.env.ROUTER_POLL_MS = '100';
  if (opts.pluginsDir) process.env.ROUTER_PLUGINS_DIR = opts.pluginsDir;
  for (const [k, v] of Object.entries(opts.env ?? {})) process.env[k] = v;

  const { start } = await import('../src/server.js');
  const server = await start(0, '127.0.0.1');
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;
  const basic = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

  return {
    base,
    dir,
    server,
    auth: authQuery,
    async rest(endpoint, params = {}) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (Array.isArray(v)) for (const item of v) qs.append(k, item);
        else qs.set(k, String(v));
      }
      const resp = await fetch(`${base}/rest/${endpoint}?${authQuery()}&${qs}`);
      return ((await resp.json()) as Record<string, any>)['subsonic-response'];
    },
    internal(path, init = {}) {
      return fetch(`${base}/internal${path}`, {
        ...init,
        headers: { authorization: basic, 'content-type': 'application/json', ...(init.headers as Record<string, string>) },
      });
    },
    writeConfig(config) {
      writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
    },
  };
}

export function configWith(sources: unknown[], extra: Record<string, unknown> = {}) {
  return { version: 1, auth: { user: USER, pass: PASS }, merge: false, sources, ...extra };
}

// A 16-bit mono WAV of `seconds` of silence: real audio bytes, well over the
// 4 KiB floor, with no dependency to make it.
export function wav(seconds: number): Buffer {
  const rate = 8000;
  const data = Buffer.alloc(rate * 2 * seconds);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** A music folder in the Artist/Album/NN Title layout the folder example reads:
 *  two albums of silent WAVs, each with a cover. The caller removes it. */
export function makeMusicFolder(): string {
  const music = mkdtempSync(join(tmpdir(), 'conformance-folder-'));
  for (const [artist, album, tracks] of [
    ['Sigur Rós', 'Takk...', ['01 Takk.wav', '02 Glósóli.wav']],
    ['Boards of Canada', 'Music Has the Right to Children', ['01 Wildlife Analysis.wav', '02 An Eagle in Your Mind.wav', '03 The Color of the Fire.wav']],
  ] as const) {
    const dir = join(music, artist, album);
    mkdirSync(dir, { recursive: true });
    for (const t of tracks) writeFileSync(join(dir, t), wav(1));
    writeFileSync(join(dir, 'cover.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70]));
  }
  return music;
}
