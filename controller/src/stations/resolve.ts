// Boot-time resolution of the active station dir. Imported by config.ts at
// module load — keep this file leaf-level (node:fs/path + pure.ts only).
// Spec §3: resolution happens ONCE per process start; a pointer change only
// takes effect through the switch sequence (mixer restart + controller exit).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseActivePointer } from './pure.js';

// The id from stations/active.json, but only if its directory actually
// exists — a dangling pointer must never boot the controller into a void.
export function activeStationId(root: string): string | null {
  try {
    const raw = readFileSync(join(root, 'stations', 'active.json'), 'utf8');
    const id = parseActivePointer(raw);
    if (id && existsSync(join(root, 'stations', id))) return id;
  } catch {}
  return null;
}

export function resolveActiveStationDir(root: string): string {
  const id = activeStationId(root);
  return id ? join(root, 'stations', id) : root;
}
