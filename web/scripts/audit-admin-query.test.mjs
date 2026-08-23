import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const audit = path.resolve(import.meta.dirname, 'audit-admin-query.mjs');

// The production audit deliberately fails stale imperative entries, so an
// isolated ownership fixture supplies one exact call for every classification.
const validImperativeFixtures = {
  'AdminShell.tsx': `export async function run() {
  // admin-query-imperative: first-run-redirect
  return fetch('/api/onboarding/status');
}\n`,
  'ArchivesPanel.tsx': `export async function run(adminFetch) {
  // admin-query-imperative: archive-download
  return adminResponse(adminFetch, \`/archives/file/\${'x'}\`);
}\n`,
  'BackupPanel.tsx': `export async function run(adminFetch) {
  // admin-query-imperative: backup-export
  return adminResponse(adminFetch, '/backup/export');
}\n`,
  'DoctorPanel.tsx': `export async function run(adminFetch) {
  // admin-query-imperative: diagnosis-command
  await adminResponse(adminFetch, '/doctor');
  // admin-query-imperative: diagnosis-stream
  return adminResponse(adminFetch, '/doctor/stream', { headers: { Accept: 'text/event-stream' } });
}\n`,
  'connect/ConnectPanel.tsx': `export async function run(adminFetch, catalog) {
  // admin-query-imperative: openapi-download
  return adminResponse(adminFetch, catalog.openapiPath);
}\n`,
  'connect/Playground.tsx': `export async function run(adminFetch, relPath, endpoint) {
  // admin-query-imperative: operator-api-command
  return adminResponse(adminFetch, relPath, { method: endpoint.method });
}\n`,
  'personas/helpers.ts': `export async function run(style, seed, size) {
  // admin-query-imperative: random-avatar-download
  return fetch(\`https://api.dicebear.com/9.x/\${style}/png?seed=\${seed}&size=\${size}\`);
}\n`,
  'playlist-builder/generate.ts': `export async function run(fetcher, id) {
  const init = { method: 'POST' };
  // admin-query-imperative: generation-job-start
  await fetcher('/playlists/generate/jobs', init);
  // admin-query-imperative: generation-sync-fallback
  await fetcher('/playlists/generate', init);
  // admin-query-imperative: generation-job-poll
  return fetcher(\`/playlists/generate/jobs/\${id}\`);
}\n`,
  'settings/LibrarySection.tsx': `export async function run(adminFetch, url) {
  // admin-query-imperative: locca-discovery-probe
  return adminResponse(adminFetch, \`/settings/llm/discover?baseUrl=\${url}\`);
}\n`,
  'settings/shared.tsx': `export async function run(adminFetch, path) {
  // admin-query-imperative: protected-audio-preview
  return adminResponse(adminFetch, path);
}\n`,
  'skills/SkillEditModal.tsx': `export async function run(adminFetch, id) {
  // admin-query-imperative: skill-export
  return adminResponse(adminFetch, \`/dj/skills/\${id}/export\`);
}\n`,
};

const helper = `import { adminJson as readJson } from './admin-query';
export function fetchThemes(fetcher, signal) {
  return readJson(fetcher, '/themes', undefined, signal);
}\n`;
const registry = [{
  file: 'OwnedHelper.ts',
  function: 'fetchThemes',
  reads: [{ callee: 'adminJson', method: 'GET', path: '/themes', signal: 'signal' }],
  consumers: [{ file: 'Owned.tsx', owner: 'useAdminQuery', property: 'request', count: 1 }],
}];

function runAudit(files = {}, ownership = []) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'subwave-admin-audit-'));
  const allFiles = { ...validImperativeFixtures, ...files };
  for (const [relative, source] of Object.entries(allFiles)) {
    const target = path.join(fixtureRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  }
  const registryPath = path.join(fixtureRoot, 'ownership.json');
  fs.writeFileSync(registryPath, JSON.stringify(ownership));
  try {
    return spawnSync(
      process.execPath,
      [audit, '--root', fixtureRoot, '--ownership-registry', registryPath],
      { encoding: 'utf8' },
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

test('reports a direct adminFetch call split before its opening parenthesis', () => {
  const result = runAudit({ 'Multiline.ts': "const response = adminFetch\n('/fixture');\n" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Multiline\.ts:1: direct adminFetch call/);
});

test('rejects a decoy helper identifier that is not called', () => {
  const result = runAudit({
    'OwnedHelper.ts': helper,
    'Owned.tsx': `import { fetchThemes } from './OwnedHelper';
export function useThemes(adminFetch) {
  return useAdminQuery({
    key: ['themes'], adminFetch,
    request: (fetcher, signal) => { void fetchThemes; return Promise.resolve({}); },
  });
}\n`,
  }, registry);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /fetchThemes.*actual call|actual call.*fetchThemes/);
});

test('rejects a registered helper called imperatively elsewhere', () => {
  const result = runAudit({
    'OwnedHelper.ts': helper,
    'Owned.tsx': `import { fetchThemes } from './OwnedHelper';
export function useThemes(adminFetch) {
  return useAdminQuery({ key: ['themes'], adminFetch, request: fetchThemes });
}
export function runNow(adminFetch, signal) { return fetchThemes(adminFetch, signal); }
`,
  }, registry);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /fetchThemes.*outside registered query consumer/);
});

test('rejects a query callback that replaces TanStack signal', () => {
  const result = runAudit({
    'OwnedHelper.ts': helper,
    'Owned.tsx': `import { fetchThemes } from './OwnedHelper';
export function useThemes(adminFetch) {
  return useAdminQuery({
    key: ['themes'], adminFetch,
    request: (fetcher, signal) => fetchThemes(fetcher, new AbortController().signal),
  });
}\n`,
  }, registry);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /fetchThemes.*TanStack AbortSignal/);
});

test('rejects a query callback that forwards signal in the wrong helper position', () => {
  const result = runAudit({
    'OwnedHelper.ts': helper,
    'Owned.tsx': `import { fetchThemes } from './OwnedHelper';
export function useThemes(adminFetch) {
  return useAdminQuery({
    key: ['themes'], adminFetch,
    request: (fetcher, signal) => fetchThemes(signal, fetcher),
  });
}\n`,
  }, registry);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /fetchThemes.*TanStack AbortSignal/);
});

test('rejects a matching request nested below the direct query options', () => {
  const result = runAudit({
    'OwnedHelper.ts': helper,
    'Owned.tsx': `import { fetchThemes } from './OwnedHelper';
export function useThemes(adminFetch) {
  const otherRequest = () => Promise.resolve({});
  return useAdminQuery({
    key: ['themes'], adminFetch,
    request: otherRequest,
    meta: { request: (fetcher, signal) => fetchThemes(fetcher, signal) },
  });
}\n`,
  }, registry);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /fetchThemes.*outside registered query consumer|expected 1.*found 0/);
});

test('accepts a registered helper as the exact request callback', () => {
  const result = runAudit({
    'OwnedHelper.ts': helper,
    'Owned.tsx': `import { fetchThemes as loadThemes } from './OwnedHelper';
export function useThemes(adminFetch) {
  return useAdminQuery({ key: ['themes'], adminFetch, request: loadThemes });
}\n`,
  }, registry);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /admin query audit passed/);
});

test('accepts an actual helper call with destructured TanStack signal', () => {
  const queryRegistry = [{
    ...registry[0],
    consumers: [{ file: 'Owned.tsx', owner: 'useQuery', property: 'queryFn', count: 1 }],
  }];
  const result = runAudit({
    'OwnedHelper.ts': helper,
    'Owned.tsx': `import { fetchThemes } from './OwnedHelper';
export function useThemes(adminFetch) {
  return useQuery({
    queryKey: ['themes'],
    queryFn: ({ signal: querySignal }) => fetchThemes(adminFetch, querySignal),
  });
}\n`,
  }, queryRegistry);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /admin query audit passed/);
});

test('accepts a direct useQueries entry queryFn', () => {
  const queryRegistry = [{
    ...registry[0],
    consumers: [{ file: 'Owned.tsx', owner: 'useQueries', property: 'queryFn', count: 1 }],
  }];
  const result = runAudit({
    'OwnedHelper.ts': helper,
    'Owned.tsx': `import { fetchThemes } from './OwnedHelper';
export function useThemes(adminFetch, ids) {
  return useQueries({
    queries: ids.map(id => ({
      queryKey: ['themes', id],
      queryFn: ({ signal }) => fetchThemes(adminFetch, signal),
    })),
  });
}\n`,
  }, queryRegistry);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /admin query audit passed/);
});
