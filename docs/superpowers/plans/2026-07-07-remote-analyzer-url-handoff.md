# Remote Analyzer URL Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an analyzer handoff mode so remote analyzers such as Odin receive stream URLs instead of controller-local temp paths.

**Architecture:** Keep the current analyzer HTTP API. Add a tiny pure helper that decides whether the analysis loop should prefetch local paths, then read `ANALYZE_HANDOFF` from config and use that helper in `runAnalysisPass`.

**Tech Stack:** Node.js, TypeScript, tsx test scripts, existing controller analyzer modules.

---

## Files

- Modify: `controller/src/config.ts`
- Modify: `controller/src/music/analyze.ts`
- Create: `controller/src/music/analyzer-handoff.ts`
- Create: `controller/scripts/analyzer-handoff.test.ts`

### Task 1: Add Pure Handoff Decision

- [ ] **Step 1: Write the failing test**

Create `controller/scripts/analyzer-handoff.test.ts`:

```ts
import assert from 'node:assert/strict';
import { shouldPrefetchAnalyzerAudio, normalizeAnalyzerHandoff } from '../src/music/analyzer-handoff.js';

let failures = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failures++;
    console.error(`  ✗ ${name}\n      ${err?.message || err}`);
  }
}

console.log('analyzer handoff:');

test('normalizes supported modes and falls back to auto', () => {
  assert.equal(normalizeAnalyzerHandoff('url'), 'url');
  assert.equal(normalizeAnalyzerHandoff('path'), 'path');
  assert.equal(normalizeAnalyzerHandoff('auto'), 'auto');
  assert.equal(normalizeAnalyzerHandoff(''), 'auto');
  assert.equal(normalizeAnalyzerHandoff('odin'), 'auto');
});

test('prefetch stays enabled for auto/path and is disabled for url', () => {
  assert.equal(shouldPrefetchAnalyzerAudio('auto'), true);
  assert.equal(shouldPrefetchAnalyzerAudio('path'), true);
  assert.equal(shouldPrefetchAnalyzerAudio('url'), false);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nall analyzer-handoff tests passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd controller && npm test -- analyzer-handoff`

Expected: failure because `controller/src/music/analyzer-handoff.ts` does not exist.

- [ ] **Step 3: Implement helper**

Create `controller/src/music/analyzer-handoff.ts`:

```ts
export type AnalyzerHandoffMode = 'auto' | 'path' | 'url';

export function normalizeAnalyzerHandoff(value: unknown): AnalyzerHandoffMode {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return raw === 'path' || raw === 'url' || raw === 'auto' ? raw : 'auto';
}

export function shouldPrefetchAnalyzerAudio(mode: AnalyzerHandoffMode): boolean {
  return mode !== 'url';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd controller && npm test -- analyzer-handoff`

Expected: pass.

### Task 2: Wire Config and Analysis Loop

- [ ] **Step 1: Add config field**

In `controller/src/config.ts`, import `normalizeAnalyzerHandoff` and add `handoff: normalizeAnalyzerHandoff(process.env.ANALYZE_HANDOFF)` under `config.analyzer`.

- [ ] **Step 2: Use helper in analysis loop**

In `controller/src/music/analyze.ts`, import `shouldPrefetchAnalyzerAudio`, compute `const prefetchAudio = shouldPrefetchAnalyzerAudio(config.analyzer.handoff);`, initialize `inflight` only when `prefetchAudio` is true, and only kick the next prefetch when true. When false, `localPath` remains null and the existing `analyzer.analyze(id, opts)` URL path runs.

- [ ] **Step 3: Verify**

Run:

```bash
cd controller
npm test -- analyzer-handoff
npm run typecheck
```

Expected: both commands exit 0.
