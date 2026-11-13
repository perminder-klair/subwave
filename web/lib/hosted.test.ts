// The admin settings and personas pages are server components that CALL
// hostedFromEnv. Exported from a 'use client' module it is a client reference
// on the server, and calling it throws: the pilot's /admin/settings showed
// "Panel failed to render" (React #441) until it moved here. This pins the
// module server-safe, and the env parsing it does.
//
// Run: `npm test -- lib/hosted`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { hostedFromEnv } from './hosted';

test('lib/hosted.ts is not a client module, and the pages import hostedFromEnv from it', () => {
  const src = readFileSync(new URL('./hosted.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /^\s*['"]use client['"]/m);
  for (const page of ['../app/admin/settings/page.tsx', '../app/admin/personas/page.tsx', '../app/admin/imaging/page.tsx']) {
    const p = readFileSync(new URL(page, import.meta.url), 'utf8');
    assert.match(p, /import \{ hostedFromEnv \} from '[./]+\/lib\/hosted'/, page);
    assert.doesNotMatch(p, /hostedFromEnv[^;]*components\/admin\/HostedContext/, page);
  }
});

test('hosted only for an explicit truthy SUBWAVE_HOSTED', () => {
  assert.deepEqual(hostedFromEnv({}), { hosted: false });
  assert.deepEqual(hostedFromEnv({ SUBWAVE_HOSTED: '0' }), { hosted: false });
  assert.equal(hostedFromEnv({ SUBWAVE_HOSTED: ' TRUE ' }).hosted, true);
  assert.equal(hostedFromEnv({ SUBWAVE_HOSTED: '1' }).hosted, true);
});

test('music URLs: https only, and only when hosted', () => {
  const env = { SUBWAVE_MUSIC_UPLOAD_URL: 'https://up.example/x', SUBWAVE_MUSIC_LIBRARY_URL: 'javascript:alert(1)' };
  assert.deepEqual(hostedFromEnv(env), { hosted: false });
  assert.deepEqual(hostedFromEnv({ ...env, SUBWAVE_HOSTED: '1' }), { hosted: true, musicUploadUrl: 'https://up.example/x' });
});

// The pages hand hostedFromEnv's result to a client provider, so it is
// serialised into every hosted admin page, and those are served before sign-in
// (the auth gate is client-side). The box's listener ceiling is an unpublished
// guard for its shared port, enforced by Icecast, so it must not be in there.
test('the box\'s listener ceiling never reaches the admin pages', () => {
  const info = hostedFromEnv({ SUBWAVE_HOSTED: '1', SUBWAVE_LISTENER_CAP: '4321', SUBWAVE_MAX_BITRATE: '192' });
  assert.deepEqual(info, { hosted: true, maxBitrate: 192 });
  assert.doesNotMatch(JSON.stringify(info), /4321/);
  for (const page of ['../app/admin/settings/page.tsx', '../app/admin/personas/page.tsx', '../app/admin/imaging/page.tsx']) {
    assert.doesNotMatch(readFileSync(new URL(page, import.meta.url), 'utf8'), /SUBWAVE_LISTENER_CAP/, page);
  }
});

test('bitrate ceiling: whole kbps from SUBWAVE_MAX_BITRATE, only when hosted', () => {
  assert.equal(hostedFromEnv({ SUBWAVE_HOSTED: '1', SUBWAVE_MAX_BITRATE: '192' }).maxBitrate, 192);
  assert.equal(hostedFromEnv({ SUBWAVE_MAX_BITRATE: '192' }).maxBitrate, undefined);
  // 48: under MP3's lowest bitrate (64), which the MP3 mount could never honour.
  for (const bad of ['', '16', '48', '19.5', 'lots']) {
    assert.equal(hostedFromEnv({ SUBWAVE_HOSTED: '1', SUBWAVE_MAX_BITRATE: bad }).maxBitrate, undefined, bad);
  }
});

test('a malformed SUBWAVE_HOSTED is not hosted, as the controller reads it', () => {
  for (const word of ['ture', 'enabled', '2']) {
    assert.deepEqual(hostedFromEnv({ SUBWAVE_HOSTED: word }), { hosted: false }, word);
  }
  assert.equal(hostedFromEnv({ SUBWAVE_HOSTED: 'on' }).hosted, true);
});

test('the persona engine picker takes the controller\'s rule from the mirror, not a copy', () => {
  const src = readFileSync(new URL('../components/admin/tts/EngineVoiceFields.tsx', import.meta.url), 'utf8');
  assert.match(src, /import \{ hostedPersonaEngines \} from '[./]+\/lib\/schemas\.generated'/);
  assert.doesNotMatch(src, /\['inherit', 'kokoro', 'piper'/);
});

// SUB/WAVE Cloud sells listening hours; the listener and bitrate ceilings are
// unpublished guards for the box's shared port. The settings panel still
// enforces the bitrate ceiling, and no copy frames either one as the plan's
// limit. (It can't show the listener number: HostedInfo no longer carries it,
// which tsc enforces.)
//
// `web/` has no DOM test environment, so this parses SettingsPanel.tsx rather
// than rendering it, the posture of personas/persona-removal.test.ts.
const panel = ts.createSourceFile(
  'SettingsPanel.tsx',
  readFileSync(new URL('../components/admin/SettingsPanel.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX,
);

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, child => walk(child, visit));
}

// What a reader sees: JSX text and string literals (labels, hints, toasts),
// never comments. Entities decoded and whitespace collapsed, so a phrase split
// across source lines still reads as one.
function panelCopy(): string[] {
  const copy: string[] = [];
  walk(panel, n => {
    if (ts.isJsxText(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)
      || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      const text = n.text.replace(/&apos;/g, '\'').replace(/\s+/g, ' ').trim();
      if (text) copy.push(text);
    }
  });
  return copy;
}

test('no settings panel copy frames a ceiling as the plan\'s', () => {
  const copy = panelCopy();
  assert.ok(copy.some(t => t.includes('Managed by SUB/WAVE Cloud')), 'the walk reads the panel\'s copy');
  const planFraming = /\b(?:this|your|the|its|station's)\s+plan\b|\bplan's\b|\bplan\s+(?:limits?|ceilings?)\b/i;
  assert.deepEqual(copy.filter(t => planFraming.test(t)), []);
});

test('every listener-mount bitrate picker offers only values under the hosted ceiling', () => {
  // The ceiling comes from the hosted context, and underCeiling filters by it.
  let fromHosted = false;
  let filtersByCeiling = false;
  const ceiled = new Set<string>();
  walk(panel, n => {
    if (ts.isVariableDeclaration(n) && n.initializer) {
      const init = n.initializer;
      if (ts.isObjectBindingPattern(n.name) && ts.isCallExpression(init)
        && ts.isIdentifier(init.expression) && init.expression.text === 'useHosted'
        && n.name.elements.some(e => ts.isIdentifier(e.name) && e.name.text === 'maxBitrate')) {
        fromHosted = true;
      }
      if (ts.isIdentifier(n.name) && n.name.text === 'underCeiling') {
        walk(init, m => { if (ts.isIdentifier(m) && m.text === 'maxBitrate') filtersByCeiling = true; });
      }
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'underCeiling') {
      const [arg] = n.arguments;
      if (arg && ts.isIdentifier(arg)) ceiled.add(arg.text);
    }
  });
  assert.ok(fromHosted, 'maxBitrate is read from useHosted()');
  assert.ok(filtersByCeiling, 'underCeiling filters by maxBitrate');
  assert.deepEqual([...ceiled].sort(), ['AAC_BITRATES', 'MP3_BITRATES', 'OPUS_BITRATES']);
});
