// Export ring entries verbatim in JSON or NDJSON (#1485 FR 15). Both /debug and
// export are admin-gated; any redaction belongs in record(), shared by both readers.
// Pure serialization is pinned by scripts/llm-call-export.test.ts.

export type LlmCallExportFormat = 'json' | 'ndjson';

/** `?format=` → a supported format. Anything unrecognised is the JSON default. */
export function llmCallExportFormat(raw: unknown): LlmCallExportFormat {
  return String(raw ?? '').trim().toLowerCase() === 'ndjson' ? 'ndjson' : 'json';
}

/**
 * `subwave-llm-calls-<YYYY-MM-DDTHH-MM-SS>.<ext>`.
 *
 * Second resolution, not the day stamp the backup export uses: an operator
 * chasing one bad pick pulls this several times in a session, and same-day
 * exports that overwrite each other in the downloads folder are how the "before"
 * copy gets lost. Colons are stripped because Windows and Android refuse them
 * in a filename.
 */
export function llmCallExportFilename(format: LlmCallExportFormat, now = new Date()): string {
  const stamp = now.toISOString().slice(0, 19).replace(/:/g, '-');
  return `subwave-llm-calls-${stamp}.${format === 'ndjson' ? 'ndjson' : 'json'}`;
}

export const LLM_CALL_EXPORT_CONTENT_TYPE: Record<LlmCallExportFormat, string> = {
  // Include charset for non-ASCII names, titles and scripts.
  json: 'application/json; charset=utf-8',
  ndjson: 'application/x-ndjson; charset=utf-8',
};

/**
 * The bytes to send.
 *
 * JSON gets a thin envelope — when the export was taken and how many calls it
 * holds — so a file found on a desk months later can still say what it is. That
 * is metadata ABOUT the export, not a widening of the log: `calls` is the ring
 * verbatim. NDJSON gets no envelope at all, because a header line would be a
 * record every consumer of the format then has to special-case.
 *
 * A call that cannot be serialised (a cycle, a BigInt an SDK left in `usage`)
 * must not take the whole export down with it — NDJSON drops that one line and
 * keeps the rest, which is the point of a line-delimited format.
 */
export function serializeLlmCalls(
  calls: unknown[],
  format: LlmCallExportFormat,
  now = new Date(),
): string {
  const list = Array.isArray(calls) ? calls : [];
  if (format === 'ndjson') {
    const lines: string[] = [];
    for (const call of list) {
      try {
        lines.push(JSON.stringify(call));
      } catch {
        /* one unserialisable call must not cost the other 119 */
      }
    }
    return lines.length ? `${lines.join('\n')}\n` : '';
  }
  return `${JSON.stringify({
    exportedAt: now.toISOString(),
    count: list.length,
    calls: list,
  }, null, 2)}\n`;
}
