import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..', 'components', 'admin');
const allowed = new Map([
  ['AdminShell.tsx', new Set(['authentication-probe'])],
]);
const marker = '// admin-query-imperative: ';
const incomplete = process.argv.includes('--allow-incomplete');
const used = new Map([...allowed].map(([file]) => [file, new Set()]));
const violations = [];

function filesAt(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesAt(target);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [target] : [];
  });
}

for (const file of filesAt(root)) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const base = path.basename(file);
  lines.forEach((line, index) => {
    for (const _match of line.matchAll(/\badminFetch\s*\(/g)) {
      const classification = lines[index - 1]?.trim().startsWith(marker)
        ? lines[index - 1].trim().slice(marker.length)
        : null;
      if (classification && allowed.get(base)?.has(classification) && !used.get(base).has(classification)) {
        used.get(base).add(classification);
      } else {
        violations.push(`${path.relative(process.cwd(), file)}:${index + 1}: unclassified adminFetch call`);
      }
    }
  });
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
