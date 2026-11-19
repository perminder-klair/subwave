import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOUSEKEEPING_TIMEOUT_MS = 120_000;

export function runSleeveNotesHousekeeping(): Promise<void> {
  const child = fork(fileURLToPath(new URL('./housekeeping-worker.ts', import.meta.url)), [], {
    execArgv: ['--import', import.meta.resolve('tsx')],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  child.stderr?.on('data', (chunk: Buffer) => console.warn('[sleeve-notes] Housekeeping worker:', chunk.toString().trim()));

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`Sleeve Notes housekeeping exceeded ${HOUSEKEEPING_TIMEOUT_MS}ms`));
    }, HOUSEKEEPING_TIMEOUT_MS);

    child.on('message', (message: { error?: string }) => {
      finish(message.error ? new Error(message.error) : undefined);
    });
    child.on('error', error => finish(error));
    child.on('exit', code => {
      if (!settled) finish(new Error(`Sleeve Notes housekeeping worker exited (${code})`));
    });
    child.send({}, error => {
      if (error) finish(error);
    });
  });
}
