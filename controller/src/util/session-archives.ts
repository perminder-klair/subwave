import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionArchiveSummaryInput } from '../schemas/session-archives.js';
import { mapPool } from './async-pool.js';

function summarize(raw: unknown) {
  const s = sessionArchiveSummaryInput.parse(raw);
  return {
    id: s.id, kind: s.kind, key: s.key,
    startedAt: s.startedAt, endedAt: s.endedAt,
    show: s.show?.name || null,
    persona: s.persona?.name || null,
    turns: Array.isArray(s.messages) ? s.messages.length : 0,
  };
}

// Keep summaries, never chat histories. A changed or replaced file is re-read,
// and concurrent list requests share one scan with bounded filesystem work.
export function createSessionArchiveReader(dir: string) {
  type Summary = ReturnType<typeof summarize>;
  const cache = new Map<string, { stamp: string; summary: Summary | null }>();
  let pending: Promise<Summary[]> | null = null;

  async function scan(): Promise<Summary[]> {
    const names = await readdir(dir).then(rows => rows.filter(name => name.endsWith('.json'))).catch(() => []);
    const present = new Set(names);
    for (const name of cache.keys()) {
      if (!present.has(name)) cache.delete(name);
    }
    const entries = await mapPool(names, 8, async name => {
      try {
        const path = join(dir, name);
        const info = await stat(path);
        const stamp = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
        const saved = cache.get(name);
        if (saved?.stamp === stamp) return saved.summary;
        const text = await readFile(path, 'utf8');
        let summary: Summary | null;
        try {
          summary = summarize(JSON.parse(text));
        } catch {
          summary = null;
        }
        cache.set(name, { stamp, summary });
        return summary;
      } catch {
        cache.delete(name);
        return null;
      }
    });
    return entries.filter(entry => entry !== null)
      .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
  }

  return (): Promise<Summary[]> => {
    pending ??= scan().finally(() => { pending = null; });
    return pending;
  };
}
