import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const rootArg = process.argv.indexOf('--root');
const root = rootArg === -1
  ? path.resolve(import.meta.dirname, '..', 'components', 'admin')
  : path.resolve(process.argv[rootArg + 1]);
const imperativeMarker = '// admin-query-imperative: ';
const ownedMarker = '// admin-query-owned: ';
const incomplete = process.argv.includes('--allow-incomplete');

// Browser-only/one-shot reads that deliberately do not belong in Query. Every
// entry validates the exact callee, HTTP method, and endpoint (or controlled
// endpoint expression). A matching marker must be immediately above the call;
// unused entries fail so this list cannot become a filename-only exemption.
const allowed = new Map([
  ['AdminShell.tsx', new Map([
    ['first-run-redirect', { callee: 'nativeFetch', method: 'GET', path: /\/onboarding\/status$/ }],
  ])],
  ['ArchivesPanel.tsx', new Map([
    ['archive-download', { callee: 'adminResponse', method: 'GET', path: /^\/archives\/file\/\$\{\}$/ }],
  ])],
  ['BackupPanel.tsx', new Map([
    ['backup-export', { callee: 'adminResponse', method: 'GET', path: /^\/backup\/export$/ }],
  ])],
  ['DoctorPanel.tsx', new Map([
    ['diagnosis-command', { callee: 'adminResponse', method: 'GET', path: /^\/doctor$/ }],
    ['diagnosis-stream', { callee: 'adminResponse', method: 'GET', path: /^\/doctor\/stream$/ }],
  ])],
  ['connect/ConnectPanel.tsx', new Map([
    ['openapi-download', { callee: 'adminResponse', method: 'GET', path: /^catalog\.openapiPath$/ }],
  ])],
  ['connect/Playground.tsx', new Map([
    ['operator-api-command', { callee: 'adminResponse', method: 'endpoint.method', path: /^relPath$/ }],
  ])],
  ['personas/helpers.ts', new Map([
    ['random-avatar-download', {
      callee: 'nativeFetch',
      method: 'GET',
      path: /^https:\/\/api\.dicebear\.com\/9\.x\/\$\{\}\/png\?seed=\$\{\}&size=\$\{\}$/,
    }],
  ])],
  ['playlist-builder/generate.ts', new Map([
    ['generation-job-start', { callee: 'rawFetcher', method: 'POST', path: /^\/playlists\/generate\/jobs$/ }],
    ['generation-sync-fallback', { callee: 'rawFetcher', method: 'POST', path: /^\/playlists\/generate$/ }],
    ['generation-job-poll', { callee: 'rawFetcher', method: 'GET', path: /^\/playlists\/generate\/jobs\/\$\{\}$/ }],
  ])],
  ['settings/LibrarySection.tsx', new Map([
    ['locca-discovery-probe', {
      callee: 'adminResponse',
      method: 'GET',
      path: /^\/settings\/llm\/discover\?baseUrl=\$\{\}$/,
    }],
  ])],
  ['settings/shared.tsx', new Map([
    ['protected-audio-preview', { callee: 'adminResponse', method: 'GET', path: /^path$/ }],
  ])],
  ['skills/SkillEditModal.tsx', new Map([
    ['skill-export', { callee: 'adminResponse', method: 'GET', path: /^\/dj\/skills\/\$\{\}\/export$/ }],
  ])],
]);
const used = new Map([...allowed].map(([file]) => [file, new Set()]));
const violations = [];

function filesAt(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesAt(target);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [target] : [];
  });
}

function propertyName(node) {
  if (!node) return null;
  return ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : null;
}

function memberCanonical(expression) {
  if (!ts.isPropertyAccessExpression(expression)) return null;
  if (
    expression.name.text === 'fetch'
    && ts.isIdentifier(expression.expression)
    && (expression.expression.text === 'window' || expression.expression.text === 'globalThis')
  ) return 'nativeFetch';
  if (expression.name.text === 'fetchQuery') return 'fetchQuery';
  return null;
}

function buildBindings(sourceFile) {
  const aliases = new Map([
    ['adminJson', 'adminJson'],
    ['adminResponse', 'adminResponse'],
    ['adminFetch', 'adminFetch'],
    ['fetcher', 'rawFetcher'],
    ['fetch', 'nativeFetch'],
    ['useAdminQuery', 'useAdminQuery'],
    ['useQuery', 'useQuery'],
    ['useQueries', 'useQueries'],
    ['useInfiniteQuery', 'useInfiniteQuery'],
    ['fetchQuery', 'fetchQuery'],
  ]);
  const initializers = new Map();

  function collect(node) {
    if (ts.isImportSpecifier(node)) {
      const imported = (node.propertyName ?? node.name).text;
      if (aliases.has(imported)) aliases.set(node.name.text, aliases.get(imported));
    } else if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
    ) {
      initializers.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collect);
  }
  collect(sourceFile);

  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, initializer] of initializers) {
      const canonical = ts.isIdentifier(initializer)
        ? aliases.get(initializer.text)
        : memberCanonical(initializer);
      if (canonical && aliases.get(name) !== canonical) {
        aliases.set(name, canonical);
        changed = true;
      }
    }
  }
  return { aliases, initializers };
}

function canonicalCallee(call, aliases) {
  if (ts.isIdentifier(call.expression)) return aliases.get(call.expression.text) ?? null;
  return memberCanonical(call.expression);
}

function resolvedInitializer(node, initializers, seen = new Set()) {
  if (!node || !ts.isIdentifier(node) || seen.has(node.text)) return node;
  const next = initializers.get(node.text);
  if (!next) return node;
  seen.add(node.text);
  return resolvedInitializer(next, initializers, seen);
}

function methodFor(call, canonical, sourceFile, initializers) {
  const initIndex = canonical === 'adminJson' || canonical === 'adminResponse' ? 2 : 1;
  const init = resolvedInitializer(call.arguments[initIndex], initializers);
  if (!init || (ts.isIdentifier(init) && init.text === 'undefined')) return 'GET';
  if (!ts.isObjectLiteralExpression(init)) return init.getText(sourceFile);
  const method = init.properties.find(property =>
    (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))
    && propertyName(property.name) === 'method'
  );
  if (!method) return 'GET';
  if (ts.isShorthandPropertyAssignment(method)) return method.name.text;
  if (ts.isStringLiteralLike(method.initializer)) return method.initializer.text.toUpperCase();
  return method.initializer.getText(sourceFile);
}

function pathFor(call, canonical, sourceFile) {
  const index = canonical === 'adminJson' || canonical === 'adminResponse' ? 1 : 0;
  const endpoint = call.arguments[index];
  if (!endpoint) return '<missing>';
  if (ts.isStringLiteralLike(endpoint) || ts.isNoSubstitutionTemplateLiteral(endpoint)) {
    return endpoint.text;
  }
  if (ts.isTemplateExpression(endpoint)) {
    return endpoint.head.text
      + endpoint.templateSpans.map(span => '${}' + span.literal.text).join('');
  }
  return endpoint.getText(sourceFile);
}

function markerFor(sourceFile, call, prefix) {
  const line = sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile)).line;
  const previous = sourceFile.text.split(/\r?\n/)[line - 1]?.trim() ?? '';
  return previous.startsWith(prefix) ? previous.slice(prefix.length) : null;
}

function isInsideOwnedOperation(node, aliases) {
  const properties = new Set();
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isPropertyAssignment(parent)) {
      const name = propertyName(parent.name);
      if (name) properties.add(name);
    }
    if (!ts.isCallExpression(parent)) continue;
    const owner = canonicalCallee(parent, aliases);
    if (owner === 'useAdminQuery' && properties.has('request')) return true;
    if (
      ['useQuery', 'useQueries', 'useInfiniteQuery', 'fetchQuery'].includes(owner)
      && properties.has('queryFn')
    ) return true;
  }
  return false;
}

function location(file, sourceFile, call) {
  const line = sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile)).line + 1;
  return `${path.relative(process.cwd(), file)}:${line}`;
}

function validateImperative(file, sourceFile, call, canonical, method, endpoint, classification) {
  const relative = path.relative(root, file);
  const spec = allowed.get(relative)?.get(classification);
  const prefix = location(file, sourceFile, call);
  if (!spec) {
    violations.push(`${prefix}: unknown imperative classification ${classification}`);
    return;
  }
  if (used.get(relative)?.has(classification)) {
    violations.push(`${prefix}: duplicate imperative classification ${classification}`);
    return;
  }
  const mismatches = [];
  if (canonical !== spec.callee) mismatches.push(`callee ${canonical ?? '<unknown>'}`);
  if (method !== spec.method) mismatches.push(`method ${method}`);
  if (!spec.path.test(endpoint)) mismatches.push(`path ${endpoint}`);
  if (mismatches.length) {
    violations.push(`${prefix}: ${classification} allowlist mismatch (${mismatches.join(', ')})`);
    return;
  }
  used.get(relative).add(classification);
}

function validateOwned(file, sourceFile, call, canonical, method, endpoint, ownership) {
  const expected = ownership.match(/^([^ ]+) (.+)$/);
  const prefix = location(file, sourceFile, call);
  if (!expected) {
    violations.push(`${prefix}: malformed query ownership marker ${ownership}`);
    return false;
  }
  if (!['adminJson', 'adminResponse', 'rawFetcher', 'nativeFetch'].includes(canonical)) {
    violations.push(`${prefix}: query ownership marker has unsupported callee ${canonical ?? '<unknown>'}`);
    return false;
  }
  if (expected[1] !== method || expected[2] !== endpoint) {
    violations.push(
      `${prefix}: query ownership mismatch (expected ${expected[1]} ${expected[2]}, got ${method} ${endpoint})`,
    );
    return false;
  }
  return true;
}

for (const file of filesAt(root)) {
  const text = fs.readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const { aliases, initializers } = buildBindings(sourceFile);

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const canonical = canonicalCallee(node, aliases);
      const imperative = markerFor(sourceFile, node, imperativeMarker);
      const ownership = markerFor(sourceFile, node, ownedMarker);
      if (canonical) {
        const method = canonical ? methodFor(node, canonical, sourceFile, initializers) : '<unknown>';
        const endpoint = canonical ? pathFor(node, canonical, sourceFile) : '<unknown>';
        if (imperative) {
          validateImperative(file, sourceFile, node, canonical, method, endpoint, imperative);
        } else if (ownership) {
          validateOwned(file, sourceFile, node, canonical, method, endpoint, ownership);
        } else if (canonical === 'adminFetch') {
          violations.push(`${location(file, sourceFile, node)}: direct adminFetch call`);
        } else if (
          method === 'GET'
          && ['adminJson', 'adminResponse', 'rawFetcher', 'nativeFetch'].includes(canonical)
          && !isInsideOwnedOperation(node, aliases)
        ) {
          violations.push(
            `${location(file, sourceFile, node)}: ${canonical} read outside query ownership`,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

for (const [file, classifications] of allowed) {
  for (const classification of classifications.keys()) {
    if (!used.get(file)?.has(classification)) {
      violations.push(`${file}: unused allowlist entry ${classification}`);
    }
  }
}

if (violations.length) {
  console.error(violations.join('\n'));
  if (!incomplete) process.exitCode = 1;
} else {
  console.log('admin query audit passed');
}
