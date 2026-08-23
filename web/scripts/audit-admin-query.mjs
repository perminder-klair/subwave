import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const rootArg = process.argv.indexOf('--root');
const root = rootArg === -1
  ? path.resolve(import.meta.dirname, '..', 'components', 'admin')
  : path.resolve(process.argv[rootArg + 1]);
const marker = '// admin-query-imperative: ';
const incomplete = process.argv.includes('--allow-incomplete');

// A cacheable admin read belongs to TanStack Query. These are deliberately
// narrow one-shot/browser-only exceptions, keyed by path relative to the
// audited admin component root. The matching marker must sit immediately above
// the call, and unused entries fail so the list cannot silently go stale.
const allowed = new Map([
  ['AdminShell.tsx', new Set(['first-run-redirect'])],
  ['ArchivesPanel.tsx', new Set(['archive-download'])],
  ['BackupPanel.tsx', new Set(['backup-export'])],
  ['DoctorPanel.tsx', new Set(['diagnosis-command', 'diagnosis-stream'])],
  ['connect/ConnectPanel.tsx', new Set(['openapi-download'])],
  ['connect/Playground.tsx', new Set(['operator-api-command'])],
  ['personas/helpers.ts', new Set(['random-avatar-download'])],
  ['playlist-builder/generate.ts', new Set([
    'generation-job-start', 'generation-sync-fallback', 'generation-job-poll',
  ])],
  ['settings/LibrarySection.tsx', new Set(['locca-discovery-probe'])],
  ['settings/shared.tsx', new Set(['protected-audio-preview'])],
  ['skills/SkillEditModal.tsx', new Set(['skill-export'])],
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

function calleeName(call) {
  return ts.isIdentifier(call.expression) ? call.expression.text : null;
}

function isQueryModule(file) {
  const name = path.basename(file);
  return name === 'queries.ts' || name === 'useAdminQuery.ts' || name.endsWith('-queries.ts');
}

function isInsideOwnedOperation(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (!ts.isCallExpression(parent)) continue;
    const name = calleeName(parent);
    if (name && [
      'useAdminQuery', 'useQuery', 'useQueries', 'useInfiniteQuery',
      'useAdminMutation', 'useMutation', 'fetchQuery',
    ].includes(name)) {
      return true;
    }
  }
  return false;
}

function isReadCall(call, initIndex) {
  const init = call.arguments[initIndex];
  if (!init || init.kind === ts.SyntaxKind.UndefinedKeyword) return true;
  if (!ts.isObjectLiteralExpression(init)) return true;
  const method = init.properties.find(property =>
    ts.isPropertyAssignment(property)
    && ((ts.isIdentifier(property.name) && property.name.text === 'method')
      || (ts.isStringLiteral(property.name) && property.name.text === 'method'))
  );
  if (!method || !ts.isPropertyAssignment(method)) return true;
  return !ts.isStringLiteralLike(method.initializer)
    || method.initializer.text.toUpperCase() === 'GET';
}

function classificationFor(sourceFile, call) {
  const line = sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile)).line;
  const lines = sourceFile.text.split(/\r?\n/);
  const previous = lines[line - 1]?.trim() ?? '';
  return previous.startsWith(marker) ? previous.slice(marker.length) : null;
}

function record(file, sourceFile, call, kind) {
  const relative = path.relative(root, file);
  const classification = classificationFor(sourceFile, call);
  if (
    classification
    && allowed.get(relative)?.has(classification)
    && !used.get(relative)?.has(classification)
  ) {
    used.get(relative).add(classification);
    return;
  }
  const line = sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile)).line + 1;
  violations.push(`${path.relative(process.cwd(), file)}:${line}: unclassified ${kind}`);
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
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name === 'adminFetch') {
        record(file, sourceFile, node, 'adminFetch call');
      } else if (name === 'fetch') {
        record(file, sourceFile, node, 'native fetch read');
      } else if (
        (name === 'adminJson' || name === 'adminResponse')
        && isReadCall(node, 2)
        && !isQueryModule(file)
        && !isInsideOwnedOperation(node)
      ) {
        record(file, sourceFile, node, `${name} read outside a query`);
      } else if (name === 'fetcher' && isReadCall(node, 1)) {
        record(file, sourceFile, node, 'raw fetcher read');
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

for (const [file, classifications] of allowed) {
  for (const classification of classifications) {
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
