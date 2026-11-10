// Whole-matrix check for .github/workflows/publish-images.yml (#2265).
//
// An image built by more than one matrix entry (today only subwave-aio-cuda,
// one entry per torch wheel) carries two rules that no single job can check,
// because each job sees only its own entry:
//   1. Exactly one entry is primary. The primary alone takes :latest, the plain
//      version tags and the plain sha- tag, so two primaries race for :latest
//      on every release and whichever job finishes last owns it; none leaves
//      the image without a :latest.
//   2. Each floating tag, a build's `cuda_family` and every name in its
//      `arch_tags`, sits on exactly one entry. Two entries owning :pascal race
//      for it the same way. An architecture tag points at the newest build that
//      still supports its GPU (the AIO CUDA tag table in
//      docs/internals/infrastructure.md).
// The workflow's tagplan step checks only what one entry can show (a
// cuda_family build says primary: true or false; arch_tags needs a
// cuda_family). This checks the rest, from the controller leg of lint.yml:
//
//   cd controller && npm run check:publish-matrix
//
// scripts/check-publish-matrix.test.ts pins each rule and runs it against the
// real workflow.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
export const WORKFLOW = join(HERE, '..', '..', '.github', 'workflows', 'publish-images.yml');

/** One `strategy.matrix.include` entry as YAML parsed it; nothing is assumed. */
export type MatrixEntry = Record<string, unknown>;

/**
 * The build matrix of a publish-images.yml source. Throws when the list is
 * missing or empty, so a restructured workflow fails the check instead of
 * passing it with nothing compared.
 */
export function loadMatrix(source: string): MatrixEntry[] {
  const include = parse(source)?.jobs?.build?.strategy?.matrix?.include;
  if (!Array.isArray(include) || include.length === 0) {
    throw new Error('no jobs.build.strategy.matrix.include list to check');
  }
  return include;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Every whole-matrix rule the entries break, one message each; empty when they pass. */
export function checkPublishMatrix(include: MatrixEntry[]): string[] {
  const errors: string[] = [];
  const byImage = new Map<string, MatrixEntry[]>();
  include.forEach((entry, i) => {
    const image = text(entry.image);
    if (!image) {
      errors.push(`matrix entry ${i + 1} has no image`);
      return;
    }
    byImage.set(image, [...(byImage.get(image) ?? []), entry]);
  });

  for (const [image, entries] of byImage) {
    const families = entries.map((e) => text(e.cuda_family));
    const label = (i: number) => (families[i] ? `${image} [${families[i]}]` : image);

    if (entries.length > 1 && families.some((f) => !f)) {
      errors.push(`${image} has ${entries.length} builds, so each needs a cuda_family to name it`);
    }

    // tagplan's own reading: an entry with no cuda_family is the image's only
    // build, so it is primary whatever it says.
    let primaries = 0;
    entries.forEach((e, i) => {
      if (!families[i]) {
        if (text(e.arch_tags)) errors.push(`${label(i)}: arch_tags needs a cuda_family`);
        primaries += 1;
      } else if (e.primary === true) {
        primaries += 1;
      } else if (e.primary !== false) {
        errors.push(`${label(i)} must set primary: true or false`);
      }
    });
    if (primaries !== 1) {
      errors.push(`${image} has ${primaries} primary builds; exactly one takes :latest`);
    }

    const owners = new Map<string, Set<number>>();
    entries.forEach((e, i) => {
      if (!families[i]) return;
      const arch = text(e.arch_tags).split(/\s+/).filter(Boolean);
      for (const tag of [families[i], ...arch]) {
        if (tag === 'latest') {
          errors.push(`${label(i)}: latest is the primary build's plain tag, never a build or architecture tag`);
        }
        owners.set(tag, (owners.get(tag) ?? new Set<number>()).add(i));
      }
    });
    for (const [tag, who] of owners) {
      if (who.size > 1) {
        const names = [...who].map(label).join(', ');
        errors.push(`${image}:${tag} is on ${who.size} builds (${names}); each tag sits on exactly one`);
      }
    }
  }
  return errors;
}

function main() {
  let errors: string[];
  let include: MatrixEntry[] = [];
  try {
    include = loadMatrix(readFileSync(WORKFLOW, 'utf8'));
    errors = checkPublishMatrix(include);
  } catch (err) {
    errors = [(err as Error).message];
  }
  if (errors.length) {
    for (const e of errors) console.error(`publish-images.yml: ${e}`);
    process.exit(1);
  }
  const multi = [...new Set(include.filter((e) => text(e.cuda_family)).map((e) => text(e.image)))];
  console.log(
    `publish-images.yml: ${include.length} builds pass` +
      (multi.length ? ` (one primary and one owner per tag for ${multi.join(', ')})` : ''),
  );
}

// Importable by scripts/check-publish-matrix.test.ts without exiting.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
