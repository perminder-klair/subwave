// Runs the real SUB/WAVE music router (../../router) as a child process for
// controller tests (#692). Needs `npm --prefix router install`.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROUTER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../router');

export interface RouterProcess {
  url: string;
  port: number;
  child: ChildProcess;
  log(): string;
  stop(): void;
}

export async function startRouterProcess(routerDir: string, env: Record<string, string> = {}): Promise<RouterProcess> {
  if (!existsSync(join(ROUTER_ROOT, 'node_modules', 'tsx'))) {
    throw new Error('router dependencies are missing — run `npm --prefix router install` first');
  }
  mkdirSync(routerDir, { recursive: true });
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: ROUTER_ROOT,
    env: { ...process.env, ROUTER_DIR: routerDir, PORT: '0', ROUTER_HOST: '127.0.0.1', ROUTER_POLL_MS: '200', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stderr!.on('data', (d) => (output += d));
  const port = await new Promise<number>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`router did not start:\n${output}`)), 30_000);
    child.stdout!.on('data', (d) => {
      output += d;
      const m = /listening on [\d.]+:(\d+)/.exec(output);
      if (m) {
        clearTimeout(timer);
        ok(Number(m[1]));
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      fail(new Error(`router exited (${code}):\n${output}`));
    });
  });
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    child,
    log: () => output,
    stop: () => {
      child.kill();
    },
  };
}
