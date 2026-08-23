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
const ownershipArg = process.argv.indexOf('--ownership-registry');

// A helper read is owned only when all four links are exact: source file,
// containing exported function, request shape (including AbortSignal), and an
// actual query consumer. Comments are never evidence. The fixture override is
// used only by the audit's executable self-tests; the production command uses
// this complete registry and fails every stale entry.
const defaultOwnershipRegistry = [
  {
    file: 'dash/queries.ts', function: 'fetchDashStatus',
    reads: [
      { callee: 'adminJson', method: 'GET', path: '/now-playing', signal: 'signal' },
      { callee: 'adminJson', method: 'GET', path: '/state', signal: 'signal' },
      { callee: 'adminJson', method: 'GET', path: '/session', signal: 'signal' },
    ],
    consumers: [{ file: 'DashPanel.tsx', owner: 'useAdminQuery', property: 'request', count: 1 }],
  },
  {
    file: 'dash/queries.ts', function: 'fetchConnections',
    reads: [{ callee: 'adminJson', method: 'GET', path: '/listeners/connections', signal: 'signal' }],
    consumers: [{ file: 'DashPanel.tsx', owner: 'useAdminQuery', property: 'request', count: 1 }],
  },
  {
    file: 'dash/queries.ts', function: 'fetchHealthStats',
    reads: [{ callee: 'adminJson', method: 'GET', path: '/stats', signal: 'signal' }],
    consumers: [{ file: 'DashPanel.tsx', owner: 'useAdminQuery', property: 'request', count: 1 }],
  },
  {
    file: 'dash/queries.ts', function: 'fetchRequests',
    reads: [{ callee: 'adminJson', method: 'GET', path: '/requests', signal: 'signal' }],
    consumers: [{ file: 'DashPanel.tsx', owner: 'useAdminQuery', property: 'request', count: 1 }],
  },
  {
    file: 'dash/queries.ts', function: 'fetchSuggestions',
    reads: [{ callee: 'adminJson', method: 'GET', path: '/generate/say-suggestions', signal: 'signal' }],
    consumers: [{ file: 'DashPanel.tsx', owner: 'useAdminQuery', property: 'request', count: 1 }],
  },
  {
    file: 'dash/queries.ts', function: 'fetchTakeover',
    reads: [{ callee: 'adminJson', method: 'GET', path: '/schedule', signal: 'signal' }],
    consumers: [{ file: 'dash/TakeoverCard.tsx', owner: 'useAdminQuery', property: 'request', count: 1 }],
  },
  {
    file: 'dash/queries.ts', function: 'fetchNavidromeStatus',
    reads: [{ callee: 'adminJson', method: 'GET', path: '/doctor/navidrome', signal: 'signal' }],
    consumers: [{ file: 'NavidromeBanner.tsx', owner: 'useAdminQuery', property: 'request', count: 1 }],
  },
  {
    file: 'dash/queries.ts', function: 'fetchMusicStarved',
    reads: [{ callee: 'adminJson', method: 'GET', path: '/state', signal: 'signal' }],
    consumers: [{ file: 'MusicStarvedBanner.tsx', owner: 'useAdminQuery', property: 'request', count: 1 }],
  },
  {
    file: 'debug/queries.ts', function: 'fetchDebug',
    reads: [{ callee: 'adminJson', method: 'GET', path: '/debug', signal: 'signal' }],
    consumers: [{ file: 'DebugPanel.tsx', owner: 'useAdminQuery', property: 'request', count: 1 }],
  },
  {
    file: 'debug/queries.ts', function: 'fetchStateListing',
    reads: [{ callee: 'adminJson', method: 'GET', path: '/debug/state-tree?path=${}', signal: 'signal' }],
    consumers: [{ file: 'debug/StateTree.tsx', owner: 'useQueries', property: 'queryFn', count: 1 }],
  },
  {
    file: 'playlist-builder/queries.ts', function: 'fetchPlaylistDetail',
    reads: [{ callee: 'adminJson', method: 'GET', path: '/playlists/${}', signal: 'signal' }],
    consumers: [
      { file: 'PlaylistBuilderPanel.tsx', owner: 'fetchQuery', property: 'queryFn', count: 2 },
    ],
  },
  {
    file: 'themes-queries.ts', function: 'fetchAdminThemes',
    reads: [{ callee: 'adminJson', method: 'GET', path: '/themes', signal: 'signal' }],
    consumers: [
      { file: 'themes-queries.ts', owner: 'useAdminQuery', property: 'request', count: 1 },
      { file: 'themes-queries.ts', owner: 'fetchQuery', property: 'queryFn', count: 1 },
    ],
  },
];

const ownershipRegistry = ownershipArg === -1
  ? defaultOwnershipRegistry
  : JSON.parse(fs.readFileSync(path.resolve(process.argv[ownershipArg + 1]), 'utf8'));

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

function containingFunction(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionDeclaration(parent) && parent.name) return parent;
  }
  return null;
}

const ownedReadUse = ownershipRegistry.map(spec => spec.reads.map(() => 0));

function validateRegisteredRead(file, sourceFile, call, canonical, method, endpoint) {
  const relative = path.relative(root, file);
  const functionNode = containingFunction(call);
  const functionName = functionNode?.name?.text ?? null;
  for (let specIndex = 0; specIndex < ownershipRegistry.length; specIndex += 1) {
    const spec = ownershipRegistry[specIndex];
    if (spec.file !== relative || spec.function !== functionName) continue;
    for (let readIndex = 0; readIndex < spec.reads.length; readIndex += 1) {
      const read = spec.reads[readIndex];
      if (read.callee !== canonical || read.method !== method || read.path !== endpoint) continue;
      const signalIndex = canonical === 'adminJson' || canonical === 'adminResponse' ? 3 : null;
      const signal = signalIndex == null ? null : call.arguments[signalIndex];
      const signalIsParameter = functionNode?.parameters.some(parameter =>
        ts.isIdentifier(parameter.name) && parameter.name.text === read.signal);
      if (!signal || !ts.isIdentifier(signal) || signal.text !== read.signal || !signalIsParameter) {
        violations.push(
          `${location(file, sourceFile, call)}: registered query helper must forward AbortSignal ${read.signal}`,
        );
        return true;
      }
      ownedReadUse[specIndex][readIndex] += 1;
      if (ownedReadUse[specIndex][readIndex] > 1) {
        violations.push(
          `${location(file, sourceFile, call)}: duplicate registered read in ${spec.function}`,
        );
      }
      return true;
    }
  }
  return false;
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
        if (ownership) {
          violations.push(
            `${location(file, sourceFile, node)}: query ownership markers cannot authorize reads`,
          );
        }
        if (imperative) {
          validateImperative(file, sourceFile, node, canonical, method, endpoint, imperative);
        } else if (canonical === 'adminFetch') {
          violations.push(`${location(file, sourceFile, node)}: direct adminFetch call`);
        } else if (
          method === 'GET'
          && ['adminJson', 'adminResponse', 'rawFetcher', 'nativeFetch'].includes(canonical)
          && !isInsideOwnedOperation(node, aliases, initializers)
          && !validateRegisteredRead(file, sourceFile, node, canonical, method, endpoint)
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

function sourceFor(relative) {
  const file = path.resolve(root, relative);
  if (!fs.existsSync(file)) return null;
  const source = fs.readFileSync(file, 'utf8');
  return {
    file,
    sourceFile: ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    ),
  };
}

function isExportedFunction(sourceFile, name) {
  return sourceFile.statements.some(statement =>
    ts.isFunctionDeclaration(statement)
    && statement.name?.text === name
    && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function withoutExtension(file) {
  return file.replace(/\.(?:ts|tsx)$/, '');
}

function helperLocalNames(sourceFile, consumerFile, spec) {
  const names = new Set();
  if (spec.file === path.relative(root, consumerFile)) names.add(spec.function);
  const specTarget = withoutExtension(path.resolve(root, spec.file));
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    const modulePath = statement.moduleSpecifier.text;
    if (!modulePath.startsWith('.')) continue;
    const importTarget = withoutExtension(path.resolve(path.dirname(consumerFile), modulePath));
    if (importTarget !== specTarget && path.join(importTarget, 'index') !== specTarget) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === spec.function) names.add(element.name.text);
    }
  }

  const initializers = new Map();
  function collect(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      initializers.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collect);
  }
  collect(sourceFile);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, initializer] of initializers) {
      if (ts.isIdentifier(initializer) && names.has(initializer.text) && !names.has(name)) {
        names.add(name);
        changed = true;
      }
    }
  }
  return names;
}

function nodeKey(file, node) {
  return `${file}:${node.pos}:${node.end}`;
}

function registeredHelperSignalIndex(spec, sourceFile) {
  const declaration = sourceFile.statements.find(statement =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === spec.function);
  if (!declaration || !ts.isFunctionDeclaration(declaration)) return -1;
  const signals = new Set(spec.reads.map(read => read.signal));
  if (signals.size !== 1) return -1;
  const [signal] = signals;
  return declaration.parameters.findIndex(parameter =>
    ts.isIdentifier(parameter.name) && parameter.name.text === signal);
}

function callbackSignalBinding(callback, property) {
  const parameter = callback.parameters[property === 'request' ? 1 : 0];
  if (!parameter) return null;
  if (property === 'request') {
    return ts.isIdentifier(parameter.name)
      ? { kind: 'identifier', name: parameter.name.text }
      : null;
  }
  if (ts.isIdentifier(parameter.name)) {
    return { kind: 'property', name: parameter.name.text };
  }
  if (!ts.isObjectBindingPattern(parameter.name)) return null;
  const signal = parameter.name.elements.find(element =>
    propertyName(element.propertyName ?? element.name) === 'signal');
  return signal && ts.isIdentifier(signal.name)
    ? { kind: 'identifier', name: signal.name.text }
    : null;
}

function isCallbackSignal(node, binding) {
  if (!node || !binding) return false;
  if (binding.kind === 'identifier') {
    return ts.isIdentifier(node) && node.text === binding.name;
  }
  return ts.isPropertyAccessExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === binding.name
    && node.name.text === 'signal';
}

function unwrappedExpression(node) {
  let current = node;
  while (
    current
    && (ts.isParenthesizedExpression(current)
      || ts.isAsExpression(current)
      || ts.isTypeAssertionExpression(current)
      || ts.isSatisfiesExpression(current))
  ) current = current.expression;
  return current;
}

function directPropertyValues(expression, name, initializers) {
  const object = unwrappedExpression(resolvedInitializer(expression, initializers));
  if (!object || !ts.isObjectLiteralExpression(object)) return [];
  return object.properties.flatMap(property => {
    if (
      (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property))
      || propertyName(property.name) !== name
    ) return [];
    const value = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
    return [unwrappedExpression(resolvedInitializer(value, initializers))];
  });
}

function returnedExpressions(callback) {
  if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) return [];
  if (!ts.isBlock(callback.body)) return [unwrappedExpression(callback.body)];
  const values = [];
  function visit(node) {
    if (node !== callback.body && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))) return;
    if (ts.isReturnStatement(node) && node.expression) {
      values.push(unwrappedExpression(node.expression));
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(callback.body);
  return values;
}

function useQueriesEntries(expression, initializers) {
  const queries = unwrappedExpression(resolvedInitializer(expression, initializers));
  if (!queries) return [];
  if (ts.isArrayLiteralExpression(queries)) {
    return queries.elements.map(entry =>
      unwrappedExpression(resolvedInitializer(entry, initializers)));
  }
  if (
    ts.isCallExpression(queries)
    && ts.isPropertyAccessExpression(queries.expression)
    && queries.expression.name.text === 'map'
  ) {
    return returnedExpressions(queries.arguments[0]);
  }
  return [];
}

function queryPropertyValues(call, owner, property, initializers) {
  const options = call.arguments[0];
  if (!options) return [];
  if (owner !== 'useQueries') {
    return directPropertyValues(options, property, initializers);
  }
  if (property !== 'queryFn') return [];
  return directPropertyValues(options, 'queries', initializers).flatMap(queries =>
    useQueriesEntries(queries, initializers).flatMap(entry =>
      directPropertyValues(entry, 'queryFn', initializers)));
}

function isInsideOwnedOperation(node, aliases, initializers) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (!ts.isCallExpression(parent)) continue;
    const owner = canonicalCallee(parent, aliases);
    const property = owner === 'useAdminQuery'
      ? 'request'
      : ['useQuery', 'useQueries', 'useInfiniteQuery', 'fetchQuery'].includes(owner)
        ? 'queryFn'
        : null;
    if (!property) continue;
    for (const value of queryPropertyValues(parent, owner, property, initializers)) {
      if (!value || node.pos < value.pos || node.end > value.end) continue;
      if (!ts.isArrowFunction(value) && !ts.isFunctionExpression(value)) continue;
      let nearestFunction = node.parent;
      while (
        nearestFunction
        && !ts.isArrowFunction(nearestFunction)
        && !ts.isFunctionExpression(nearestFunction)
      ) nearestFunction = nearestFunction.parent;
      if (nearestFunction === value) return true;
    }
  }
  return false;
}

function consumerPropertyValues(sourceFile, aliases, initializers, consumer) {
  const values = [];
  function visit(node) {
    if (ts.isCallExpression(node) && canonicalCallee(node, aliases) === consumer.owner) {
      values.push(...queryPropertyValues(node, consumer.owner, consumer.property, initializers));
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return values;
}

function validateConsumer(spec, consumer, signalIndex, allowedReferences) {
  const parsed = sourceFor(consumer.file);
  if (!parsed) {
    violations.push(`${consumer.file}: missing registered query consumer for ${spec.function}`);
    return 0;
  }
  const { file, sourceFile } = parsed;
  const { aliases, initializers } = buildBindings(sourceFile);
  const names = helperLocalNames(sourceFile, file, spec);
  let count = 0;
  for (const value of consumerPropertyValues(sourceFile, aliases, initializers, consumer)) {
    if (ts.isIdentifier(value) && names.has(value.text)) {
      allowedReferences.add(nodeKey(file, value));
      count += 1;
      if (consumer.property !== 'request' || signalIndex !== 1) {
        violations.push(
          `${consumer.file}: direct ${spec.function} callback does not receive TanStack AbortSignal in its registered position`,
        );
      }
      continue;
    }
    if (!ts.isArrowFunction(value) && !ts.isFunctionExpression(value)) continue;
    const signalBinding = callbackSignalBinding(value, consumer.property);
    function visitCallback(node) {
      if (node !== value && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))) return;
      if (
        ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && names.has(node.expression.text)
      ) {
        allowedReferences.add(nodeKey(file, node.expression));
        count += 1;
        if (!isCallbackSignal(node.arguments[signalIndex], signalBinding)) {
          violations.push(
            `${location(file, sourceFile, node)}: ${spec.function} must receive the callback's TanStack AbortSignal in argument ${signalIndex + 1}`,
          );
        }
      }
      ts.forEachChild(node, visitCallback);
    }
    visitCallback(value.body);
  }
  return count;
}

function isHelperDefinitionReference(node, names) {
  const parent = node.parent;
  if (ts.isImportSpecifier(parent)) return true;
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return true;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return true;
  if (
    ts.isVariableDeclaration(parent)
    && parent.initializer === node
    && ts.isIdentifier(parent.name)
    && names.has(parent.name.text)
  ) return true;
  return false;
}

function rejectOutsideHelperReferences(spec, allowedReferences) {
  for (const file of filesAt(root)) {
    const relative = path.relative(root, file);
    const parsed = sourceFor(relative);
    if (!parsed) continue;
    const { sourceFile } = parsed;
    const names = helperLocalNames(sourceFile, file, spec);
    if (names.size === 0) continue;
    function visit(node) {
      if (
        ts.isIdentifier(node)
        && names.has(node.text)
        && !isHelperDefinitionReference(node, names)
        && !allowedReferences.has(nodeKey(file, node))
      ) {
        violations.push(
          `${location(file, sourceFile, node)}: ${spec.function} reference outside registered query consumer; use it as the exact callback or an actual call`,
        );
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }
}

for (let specIndex = 0; specIndex < ownershipRegistry.length; specIndex += 1) {
  const spec = ownershipRegistry[specIndex];
  const parsed = sourceFor(spec.file);
  if (!parsed || !isExportedFunction(parsed.sourceFile, spec.function)) {
    violations.push(`${spec.file}: missing exported registered query helper ${spec.function}`);
  }
  const signalIndex = parsed ? registeredHelperSignalIndex(spec, parsed.sourceFile) : -1;
  const allowedReferences = new Set();
  for (let readIndex = 0; readIndex < spec.reads.length; readIndex += 1) {
    const read = spec.reads[readIndex];
    if (ownedReadUse[specIndex][readIndex] !== 1) {
      violations.push(
        `${spec.file}: stale registered read ${spec.function} ${read.method} ${read.path}`,
      );
    }
  }
  for (const consumer of spec.consumers) {
    const actual = validateConsumer(spec, consumer, signalIndex, allowedReferences);
    if (actual !== consumer.count) {
      violations.push(
        `${consumer.file}: ${spec.function} expected ${consumer.count} ${consumer.owner}.${consumer.property} consumer(s), found ${actual}`,
      );
    }
  }
  rejectOutsideHelperReferences(spec, allowedReferences);
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
