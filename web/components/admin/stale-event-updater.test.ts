// React nulls an event's `currentTarget` once the handler returns, and a
// functional state update (`setX(prev => …)`) runs later, during render. Read
// inside the updater, `e.currentTarget.value` throws "Cannot read properties of
// null (reading 'value')" and takes the whole admin panel down — which the Era
// tab's year boxes did on the first keystroke. Read the value first:
//   onChange={e => { const v = e.currentTarget.value; setX(d => ({ ...d, k: v })); }}
// (`e.target` survives, which is why the settings forms' updaters are fine.)
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url)); // web/components/
const UPDATER_READS_CURRENT_TARGET = /set[A-Z]\w*\(\s*\(?\w+\)?\s*=>[^;\n]*\.currentTarget\b/;

function* tsx(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* tsx(p);
    else if (p.endsWith('.tsx')) yield p;
  }
}

test('no functional state update reads the event\'s currentTarget', () => {
  const hits: string[] = [];
  for (const file of tsx(root)) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (UPDATER_READS_CURRENT_TARGET.test(line)) hits.push(`${relative(root, file)}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, []);
});

test('the guard itself catches the shape that broke the Era tab', () => {
  assert.ok(UPDATER_READS_CURRENT_TARGET.test(`onChange={e => setYearDraft(d => ({ ...d, [a.albumKey]: e.currentTarget.value }))} />`));
  assert.ok(!UPDATER_READS_CURRENT_TARGET.test(`onChange={e => { const v = e.currentTarget.value; setDraft(d => ({ ...d, [t.id]: v })); }}`));
  assert.ok(!UPDATER_READS_CURRENT_TARGET.test(`onChange={e => setFilter(e.currentTarget.value)}`));
});
