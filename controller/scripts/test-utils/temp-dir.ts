import { mkdtempSync, rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const directories = new Set<string>();

process.once('exit', () => {
  for (const directory of directories) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch (error) {
      console.error(`Could not remove test directory ${directory}:`, error);
      process.exitCode ||= 1;
    }
  }
});

// Exit cleanup also covers failed module setup and legacy process.exit() calls.
// Test-specific teardown still closes databases and restores mocks first.
export function createTempDir(prefix: string): string {
  const directory = mkdtempSync(prefix);
  directories.add(directory);
  return directory;
}

// Node's fs request wraps (every ReqWrap<uv_fs_t> in src/node_file.h), each
// listed until its completion has run on the main thread. CloseReq is a
// FileHandle's close(): writeFileAtomic renames its temp into place after it,
// so a pending close is not the end of a write.
const FS_REQUESTS = new Set(['FSReqCallback', 'FSReqPromise', 'FileHandleReadWrap', 'CloseReq']);

function fsRequestsInFlight(): number {
  return process.getActiveResourcesInfo().filter((name) => FS_REQUESTS.has(name)).length;
}

// The after() teardown for a dir a test file removes itself. src's best-effort
// writers start an fs request and never await it: logEvent's append to
// logs/events-*.jsonl (and its module-load mkdir of logs/), the pick and
// Subsonic call logs, queue.persist() once its timer has fired. libuv runs
// those on its threadpool, which keeps working while a bare rmSync holds the
// main thread, so one still queued at teardown can create a file in a
// directory the walk has already emptied (ENOTEMPTY), or land after the walk
// and recreate the dir. Waiting until no request is in flight closes that,
// whoever started the write. A pending debounce timer cannot race this way:
// its callback runs only after rmSync has returned.
//
// The rmSync follows the passing check in the same synchronous block, so
// nothing can start a request in between. A request still in flight after
// timeoutMs fails the teardown rather than removing the dir under it.
export async function removeTempDir(directory: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (let pending = fsRequestsInFlight(); pending > 0; pending = fsRequestsInFlight()) {
    if (Date.now() >= deadline) {
      throw new Error(`Not removing ${directory}: ${pending} fs request(s) still in flight after ${timeoutMs} ms`);
    }
    await sleep(1);
  }
  rmSync(directory, { recursive: true, force: true });
}
