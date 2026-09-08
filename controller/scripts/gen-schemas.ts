// Generates web/lib/schemas.generated.ts from controller/src/schemas/*.ts, so the
// admin forms validate against the exact schema the controller enforces. The web
// package can't import controller/src at build time, hence a checked-in mirror
// kept honest by CI (`npm run gen:schemas`, diffed by the lint workflow).
// Only pure schema modules are mirrored; *-server.ts siblings are excluded.
// The output is ONE FLAT FILE built by the web package, so buildMirror() enforces
// unique top-level names across modules, exactly one zod import form, and no
// reference to any module but zod — all at generate time, naming the source file.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src', 'schemas');
const OUT = join(HERE, '..', '..', 'web', 'lib', 'schemas.generated.ts');

export interface SchemaModule {
  /** Bare filename, e.g. 'webhook.ts' — used in banners and error messages. */
  file: string;
  source: string;
}

// The ONE zod import form a mirrored module may use. Quote style and semicolon are
// optional, because eslint's zod-only rule is not sensitive to either.
const CANONICAL_ZOD_IMPORT = /^import\s*\{\s*z\s*\}\s*from\s*["']zod["']\s*;?\s*$/;

/**
 * Every top-level name a module introduces — declarations, imported bindings, and
 * exported names. Parsed with the TypeScript compiler, not a regex: a MISS is the
 * dangerous direction, since the collision guard can only throw on names it was
 * told about. Export names count because the flat mirror shares one export
 * namespace. Names are de-duplicated per module; an invalid module yields a
 * partial tree rather than a throw.
 *
 *
 *
 *
 */
export function collectDeclarations(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    'schema.ts',
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const names = new Set<string>();

  // A binding name is either an identifier or a destructuring pattern, and a
  // pattern introduces one name per element, nested arbitrarily deep.
  const addBinding = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      names.add(name.text);
      return;
    }
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) addBinding(element.name);
    }
  };

  const isDefaultExport = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) &&
    !!ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);

  for (const statement of sourceFile.statements) {
    if (isDefaultExport(statement)) names.add('default');

    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) addBinding(decl.name);
    } else if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)
    ) {
      // `export default function () {}` is anonymous — already counted above.
      // A module declaration's name may be a string literal (`declare module 'x'`).
      if (statement.name && ts.isIdentifier(statement.name)) names.add(statement.name.text);
    } else if (ts.isImportDeclaration(statement)) {
      // An import binding occupies the flat file's scope like any declaration.
      const clause = statement.importClause;
      if (clause?.name) names.add(clause.name.text);
      const bound = clause?.namedBindings;
      if (bound && ts.isNamespaceImport(bound)) names.add(bound.name.text);
      if (bound && ts.isNamedImports(bound)) {
        for (const element of bound.elements) names.add(element.name.text);
      }
    } else if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        for (const element of clause.elements) names.add(element.name.text);
      }
      if (clause && ts.isNamespaceExport(clause)) names.add(clause.name.text);
    } else if (ts.isExportAssignment(statement)) {
      // `export default <expr>` and `export = <expr>`.
      names.add('default');
    }
  }

  return [...names];
}

/**
 * The module specifier a statement pulls in, or null. Re-exports count:
 * `export { x } from './y.js'` references another module exactly like an import,
 * but names no `import` keyword, so a line-wise check never saw it.
 *
 */
function moduleSpecifierOf(statement: ts.Statement): string | null {
  if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
    const spec = statement.moduleSpecifier;
    return spec && ts.isStringLiteral(spec) ? spec.text : null;
  }
  if (ts.isImportEqualsDeclaration(statement)) {
    const ref = statement.moduleReference;
    return ts.isExternalModuleReference(ref) && ts.isStringLiteral(ref.expression)
      ? ref.expression.text
      : null;
  }
  return null;
}

/**
 * Rejects everything a mirrored module may not reference, and returns the one zod
 * import it may, as a node, so the strip below cuts exactly that statement.
 * A non-zod import copied into the mirror resolves against the WEB package and
 * fails at web build time, inside a generated file nobody may edit. eslint states
 * the same rule as the merge gate; this half fires at generate time.
 * A namespace/default import or extra named bindings are REJECTED, not rewritten:
 * rewriting could change what the code means or silently drop a binding.
 *
 *
 *
 */
function findZodImport(mod: SchemaModule, sourceFile: ts.SourceFile): ts.Statement | null {
  const where = `controller/src/schemas/${mod.file}`;
  let zodImport: ts.Statement | null = null;

  for (const statement of sourceFile.statements) {
    const specifier = moduleSpecifierOf(statement);
    if (specifier === null) continue;
    const text = statement.getText(sourceFile);
    const oneLine = text.split('\n').map((l) => l.trim()).join(' ');

    if (specifier !== 'zod') {
      throw new Error(
        `gen:schemas — ${where} references the module "${specifier}":\n` +
          `    ${oneLine}\n` +
          `  Mirrored modules are copied verbatim into web/lib/schemas.generated.ts, which is\n` +
          `  built by the WEB package — so this specifier has to resolve there too, and\n` +
          `  project paths, node builtins and controller-only packages do not. A mirrored\n` +
          `  module may reference only 'zod'. Move anything else into a *-server.ts sibling,\n` +
          `  which is not mirrored.`,
      );
    }

    if (!CANONICAL_ZOD_IMPORT.test(text)) {
      throw new Error(
        `gen:schemas — ${where} imports zod as:\n` +
          `    ${oneLine}\n` +
          `  The mirror is one flat file with a single \`import { z } from 'zod'\` at the top, so a\n` +
          `  mirrored module must use exactly that form (on one line). Rewrite the import and use\n` +
          `  \`z.\` accessors (z.ZodType, z.infer, …) for anything else you need from zod.`,
      );
    }

    if (zodImport) {
      throw new Error(
        `gen:schemas — ${where} imports zod twice. The mirror carries one \`import { z } from 'zod'\`\n` +
          `  for every module, so a second one here would redeclare \`z\` in the flat file.`,
      );
    }
    zodImport = statement;
  }

  return zodImport;
}

// Validates the module's references and drops its own zod import. Cut by node
// position, so an indented but canonical import cannot survive and redeclare `z`.
function stripZodImport(mod: SchemaModule): string {
  const sourceFile = ts.createSourceFile(
    'schema.ts',
    mod.source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const zodImport = findZodImport(mod, sourceFile);
  // A module that needs no zod (constants only) is fine — nothing to strip.
  if (!zodImport) return mod.source.trim();

  const src = mod.source;
  // Widen the cut to the whole line, so removing it leaves no blank line behind.
  let from = zodImport.getStart(sourceFile);
  while (from > 0 && (src[from - 1] === ' ' || src[from - 1] === '\t')) from--;
  let to = zodImport.end;
  while (to < src.length && (src[to] === ' ' || src[to] === '\t' || src[to] === ';')) to++;
  if (src[to] === '\r') to++;
  if (src[to] === '\n') to++;

  return (src.slice(0, from) + src.slice(to)).trim();
}

export function buildMirror(modules: SchemaModule[]): string {
  // Seeded with the name the generated preamble declares, so a module declaring `z` collides here.
  const seen = new Map<string, string>([['z', "the mirror's own `import { z } from 'zod'`"]]);

  const parts = modules.map((mod) => {
    const stripped = stripZodImport(mod);
    const where = `controller/src/schemas/${mod.file}`;
    for (const name of collectDeclarations(stripped)) {
      const prev = seen.get(name);
      if (prev) {
        throw new Error(
          `gen:schemas — duplicate top-level name "${name}".\n` +
            `  declared in ${where}\n` +
            `  already declared in ${prev}\n` +
            `  Every src/schemas/*.ts module is concatenated into ONE file\n` +
            `  (web/lib/schemas.generated.ts), so top-level names share a single scope —\n` +
            `  including module-private ones. Rename one of them (e.g. WEBHOOK_ID_RE).`,
        );
      }
      seen.set(name, where);
    }
    const rule = '─'.repeat(Math.max(0, 40 - mod.file.length));
    return `// ─── from controller/src/schemas/${mod.file} ${rule}\n\n${stripped}`;
  });

  return `// GENERATED FILE — do not edit by hand.
// Mirror of controller/src/schemas/*.ts. Regenerate with:
//   cd controller && npm run gen:schemas
// CI fails if this drifts from the controller schemas.
//
// These are the SAME schemas the controller enforces. The form resolver and the
// route middleware therefore cannot disagree.

import { z } from 'zod';

${parts.join('\n\n')}
`;
}

function main() {
  const files = readdirSync(SRC)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('-server.ts'))
    .sort();

  const modules = files.map((file) => ({ file, source: readFileSync(join(SRC, file), 'utf8') }));
  writeFileSync(OUT, buildMirror(modules));
  console.log(`wrote ${OUT} (${files.length} module${files.length === 1 ? '' : 's'})`);
}

// Importable by scripts/schemas.test.ts without writing the mirror.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
