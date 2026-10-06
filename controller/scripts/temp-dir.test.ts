import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';

const root = createTempDir(join(tmpdir(), 'subwave-temp-dir-test-'));
const helperUrl = new URL('./test-utils/temp-dir.ts', import.meta.url).href;

for (const [name, ending, status] of [
  ['normal completion', '', 0],
  ['explicit failure exit', 'process.exit(7);', 7],
  ['failed setup', 'throw new Error("fixture setup failed");', 1],
] as const) {
  test(`temporary state is removed after ${name}`, () => {
    const scratch = join(root, name);
    mkdirSync(scratch);
    const unrelated = join(scratch, 'unrelated');
    mkdirSync(unrelated);
    const script = `
      import { createTempDir } from ${JSON.stringify(helperUrl)};
      import { mkdirSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const directories = Array.from({ length: 20 }, () => createTempDir(${JSON.stringify(join(scratch, 'owned-'))}));
      for (const directory of directories) {
        mkdirSync(join(directory, 'nested'));
        writeFileSync(join(directory, 'nested', 'settings.json'), '{}');
      }
      console.log(JSON.stringify(directories));
      ${ending}
    `;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.ifError(child.error);
    assert.equal(child.status, status, child.stderr);
    const directories: unknown = JSON.parse(child.stdout.trim());
    assert.ok(Array.isArray(directories));
    assert.equal(directories.length, 20);
    for (const directory of directories) {
      assert.equal(typeof directory, 'string');
      assert.equal(existsSync(directory), false, `${directory} was left behind`);
    }
    assert.equal(existsSync(unrelated), true, 'cleanup only removes directories owned by the helper');
    assert.doesNotMatch(child.stderr, /MaxListenersExceededWarning/);
  });
}
