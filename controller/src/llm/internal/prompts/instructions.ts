// Static prompt sections ship from llm/instructions; conditional assembly stays in TS.
// These are source files, separate from operator persona/skill configuration, and
// must agree with provider discovery budgets. Validate once at module load so
// missing sections or malformed prompts fail at boot. See controller/CLAUDE.md.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const INSTRUCTIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../instructions');

// Only {lowerCamelIdentifier} is a placeholder; ordinary braces must stay literal.
const PLACEHOLDER = /\{([a-z][A-Za-z0-9]*)\}/g;

// Sections run from ## name to the next ## heading. The preamble is never sent to a model.
function parseSections(src: string, file: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = src.split(/^## +/m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf('\n');
    const name = (nl === -1 ? part : part.slice(0, nl)).trim();
    const body = (nl === -1 ? '' : part.slice(nl + 1)).trim();
    if (!name) continue;
    if (out.has(name)) throw new Error(`instructions: duplicate section "${name}" in ${file}`);
    if (!body) throw new Error(`instructions: empty section "${name}" in ${file}`);
    out.set(name, body);
  }
  if (!out.size) throw new Error(`instructions: ${file} defines no "## section" headings`);
  return out;
}

const FILES: Map<string, Map<string, string>> = (() => {
  const loaded = new Map<string, Map<string, string>>();
  for (const entry of readdirSync(INSTRUCTIONS_DIR)) {
    if (!entry.endsWith('.md')) continue;
    const name = entry.slice(0, -3);
    loaded.set(name, parseSections(readFileSync(join(INSTRUCTIONS_DIR, entry), 'utf8'), entry));
  }
  if (!loaded.size) throw new Error(`instructions: no .md files found in ${INSTRUCTIONS_DIR}`);
  return loaded;
})();

/**
 * One authored block, with `{placeholder}` values filled in.
 *
 * Throws on a missing file, a missing section, or a placeholder left
 * unsubstituted — all three are authoring slips, and a prompt that silently
 * ships the literal text "{topic}" to a model is worse than one that fails.
 */
export function instruction(file: string, section: string, vars: Record<string, string | number> = {}): string {
  const sections = FILES.get(file);
  if (!sections) throw new Error(`instructions: no such file "${file}.md" (have: ${[...FILES.keys()].join(', ')})`);
  const body = sections.get(section);
  if (body == null) throw new Error(`instructions: ${file}.md has no section "${section}" (have: ${[...sections.keys()].join(', ')})`);
  // Missing placeholders are judged against the TEMPLATE, never the filled
  // output: a value is free text (a show topic, a station name) and may itself
  // contain "{word}", which is content, not an authoring slip.
  const missing: string[] = [];
  const filled = body.replace(PLACEHOLDER, (whole, key: string) => {
    const v = vars[key];
    if (v == null) {
      missing.push(whole);
      return whole;
    }
    return String(v);
  });
  if (missing.length) throw new Error(`instructions: ${file}.md section "${section}" left ${missing.join(', ')} unsubstituted`);
  return filled;
}

// Expose section names so coverage tests catch authored sections no caller renders.
export function sectionNames(file: string): string[] {
  const sections = FILES.get(file);
  if (!sections) throw new Error(`instructions: no such file "${file}.md"`);
  return [...sections.keys()];
}

export function instructionFiles(): string[] {
  return [...FILES.keys()];
}
