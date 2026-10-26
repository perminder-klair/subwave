// No test file's comments tell you to run a test file outside its runner
// (#2019). The runner is what hands each controller file a temp STATE_DIR (the
// header of scripts/run-tests.ts explains the two layers); `tsx
// scripts/foo.test.ts` on its own falls through config.ts to the repo's own
// state/, which on a host running the station is the live state root. A header
// is the line a contributor or an agent copies, so it names the runner form,
// `npm test -- <filter>`. web/ has the same rule (web/scripts/run-tests.mjs),
// so its test roots are read too.
//
// Comments are found by a TypeScript parse, not a line regex, so a string
// holding a command (this file's own cases) is never read as one. A bare run is
// `tsx` or `node` (a path in front counts: node_modules/.bin/tsx), its flags
// and their values, then a script naming a test file that exists, or a template for one
// (`<name>.test.ts`, `*.test.ts`, `$t.test.ts`). A made-up name like foo above
// names no file, which is what lets a comment describe the hazard.
//
// Run: `npm test -- test-headers`.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, type Dirent } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptsDir, '../..');
// The roots web/scripts/run-tests.mjs lists; a root added there belongs here.
const WEB_ROOTS = ['tests', 'components', 'hooks', 'lib', 'scripts'];
const TEST_FILE = /\.test\.(?:ts|tsx|mjs)$/;

function testFiles(dir: string, out: string[] = []): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.next') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) testFiles(full, out);
    else if (TEST_FILE.test(e.name)) out.push(full);
  }
  return out;
}

const files = [scriptsDir, ...WEB_ROOTS.map((r) => join(repoRoot, 'web', r))].flatMap((d) => testFiles(d));
const testStem = (path: string) => basename(path).replace(/(\.test)\.[cm]?[jt]sx?$/, '$1');
const known = new Set(files.map(testStem));

// Every comment in a file, with the line it starts on. A comment is trivia
// beside a token, so the walk visits every token, not only every node: one
// that is last in a block or a literal sits before the closing `}` or `]`,
// where no node starts or ends.
function comments(path: string, text = readFileSync(path, 'utf8')): Array<{ line: number; text: string }> {
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : path.endsWith('.mjs') ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, kind);
  const found = new Map<number, string>();
  const collect = (ranges: ts.CommentRange[] | undefined) => {
    for (const r of ranges ?? []) found.set(r.pos, text.slice(r.pos, r.end));
  };
  const visit = (node: ts.Node) => {
    // A JSDoc node lies inside its comment and JSX text is text, so neither
    // borders on trivia. The JSDoc comment is still read, before its token.
    if (ts.isJSDoc(node) || node.kind === ts.SyntaxKind.JsxText) return;
    const children = node.getChildren(sf);
    if (children.length === 0) {
      collect(ts.getLeadingCommentRanges(text, node.pos));
      collect(ts.getTrailingCommentRanges(text, node.end));
    }
    children.forEach(visit);
  };
  visit(sf);
  return [...found].map(([pos, body]) => ({ line: sf.getLineAndCharacterOfPosition(pos).line + 1, text: body }));
}

const COMMAND = /^(?:\S*\/)?(?:tsx|node)$/;
const NAMES_A_TEST = /\.test(?:\.[cm]?[jt]sx?)?$/;
const TEMPLATE = /[<>*${}]/;
// Quotes, brackets and sentence punctuation around a word of prose.
const word = (w: string) => w.replace(/^[`'"([]+/, '').replace(/[`'")\],.;:]+$/, '');

// Whether a line of comment runs a test file outside a runner.
function runsBare(line: string, knownTests: ReadonlySet<string>): boolean {
  const words = line.split(/\s+/).map(word);
  return words.some((w, i) => {
    if (!COMMAND.test(w)) return false;
    let j = words[i + 1] === 'watch' ? i + 2 : i + 1;
    // A flag can take the next word as its value (`--import tsx`,
    // `--test-name-pattern drop`), so that word is passed over unless it is a
    // flag or the script itself.
    while (words[j]?.startsWith('-')) {
      j += 1;
      if (words[j] !== undefined && !words[j].startsWith('-') && !NAMES_A_TEST.test(words[j])) j += 1;
    }
    const script = words[j] ?? '';
    return NAMES_A_TEST.test(script) && (TEMPLATE.test(script) || knownTests.has(testStem(script)));
  });
}

test('no test file comment runs a test file outside its runner', () => {
  const found: string[] = [];
  for (const path of files) {
    for (const c of comments(path)) {
      c.text.split('\n').forEach((line, i) => {
        if (runsBare(line, known)) found.push(`${relative(repoRoot, path)}:${c.line + i}: ${line.trim()}`);
      });
    }
  }
  assert.deepEqual(found, [], 'name the runner instead: `npm test -- <filter>`, from controller/ or web/');
});

test('the scan reaches both packages and reads their headers', () => {
  const rel = files.map((f) => relative(repoRoot, f));
  assert.ok(rel.includes('controller/scripts/test-headers.test.ts'));
  assert.ok(rel.includes('web/scripts/debug-icecast.test.tsx'));
  const own = comments(fileURLToPath(import.meta.url));
  assert.ok(own.some((c) => c.line === 1), 'the first line is a comment');
  assert.ok(own.some((c) => c.text === '// Run: `npm test -- test-headers`.'), 'the header run line is read');
});

test('a comment is read wherever it sits, and a string never is', () => {
  for (const [path, text] of [
    ['x.ts', 'test("t", () => {\n  run();\n  // MARK\n});\n'],
    ['x.ts', 'if (x) { /* MARK */ }\n'],
    ['x.ts', 'const o = {\n  a: 1,\n  // MARK\n};\n'],
    ['x.ts', '/** MARK */\nfunction f() {}\n'],
    ['x.tsx', 'const e = <div>{/* MARK */}</div>;\n'],
    ['x.mjs', 'run(); // MARK\n'],
  ]) assert.ok(comments(path, text).some((c) => c.text.includes('MARK')), text);
  assert.deepEqual(comments('x.ts', 'const s = "// MARK", r = /\\/\\/ MARK/, t = `/* MARK ${s} */`;\n'), []);
});

test('the check reads a bare run in each form, and passes the runner and prose', () => {
  const knownTests = new Set(['moods.test']);
  for (const line of [
    '// Run: `tsx scripts/moods.test.ts`.',
    '// Run: npx tsx scripts/moods.test.ts (auto-discovered by npm test).',
    '// Run: `tsx --test scripts/moods.test.ts` (folded into `npm test`).',
    '// Row count is env-tunable:   OBS_SCALE_N=200000 tsx scripts/moods.test.ts',
    '// Run from web/: ../controller/node_modules/.bin/tsx --test scripts/moods.test.ts',
    '// Run from the repo root: npx tsx web/lib/moods.test.ts',
    ' *  node --import tsx --test scripts/moods.test.ts',
    '// node --test scripts/moods.test.ts',
    '// tsx scripts/moods.test',
    '// Run any one with `tsx scripts/<name>.test.ts`.',
    '// node --test scripts/*.test.ts',
    '//   npx tsx "scripts/$t.test.ts"',
    "// One case: `tsx --test --test-name-pattern 'drops' scripts/moods.test.ts`.",
    '// node --test-reporter spec --test scripts/moods.test.ts',
    '// tsx watch scripts/moods.test.ts',
  ]) assert.equal(runsBare(line, knownTests), true, line);

  for (const line of [
    '// Run: `npm test -- moods.test.ts`.',
    '// node:assert-via-tsx style, matching scripts/moods.test.ts.',
    '// `tsx scripts/foo.test.ts` on its own falls through config.ts',
    '// `tsx scripts/run-tests.ts moods.test.ts`',
    ' *  imports it would drag React and Next into `node --test`. */',
    '// tsx resolves `scripts/moods.test` to the file.',
  ]) assert.equal(runsBare(line, knownTests), false, line);
});
