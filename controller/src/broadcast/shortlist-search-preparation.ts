// Optional structured preparation and independent verification produce bounded
// queries for a show airing, each call under its own deadline, sharing one
// durable result.
// Query execution stays in music/shortlist.ts; this module never picks a track,
// sees persona Leanings/listener chat, or changes speech context.
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { config } from '../config.js';
import { djObject, withDeadline } from '../llm/sdk.js';
import * as settings from '../settings.js';
import * as budget from './dj-budget.js';
import { showPreparation } from './show-preparation.js';
import { instruction } from '../llm/internal/prompts/instructions.js';
import { groundShortlistSearches, preparedShortlistSearchSchema, shortlistSearchSchema, type ShortlistSearch } from '../music/shortlist-search.js';
import { createSerialFileWriter } from '../util/atomic-file.js';
import { logEvent } from '../observability/events.js';

export type ShortlistSearchBrief = {
  occurrenceId: string;
  expiresAt: number;
  topic: string;
  editorial?: string;
  presenterNames?: readonly string[];
};

const recordSchema = z.object({
  key: z.string(), expiresAt: z.number().finite(),
  status: z.enum(['ready', 'failed']),
  searches: shortlistSearchSchema.shape.searches,
  attempts: z.number().int().min(1).max(2), retryAt: z.number().finite(),
});
const PREPARATION_VERSION = 4;
const verificationSchema = z.object({ accepted: z.array(z.number().int().min(0).max(2)).max(3) }).strict();
const storeSchema = z.object({ version: z.literal(PREPARATION_VERSION), records: z.array(recordSchema).max(64) });
type SearchRecord = z.infer<typeof recordSchema>;

function shortlistSearchInput(brief: ShortlistSearchBrief) {
  return { topic: brief.topic.trim().slice(0, 2000), editorial: brief.editorial?.trim().slice(0, 2000) || '',
    presenters: (brief.presenterNames ?? []).slice(0, 4).map(name => name.slice(0, 80)),
  };
}

export function createShortlistSearchPreparation({ file, generate, verify, now = Date.now, timeoutMs = 10_000 }: {
  file: string;
  generate: (prompt: string, signal?: AbortSignal) => Promise<unknown>;
  verify: (prompt: string, signal?: AbortSignal) => Promise<unknown>;
  now?: () => number;
  timeoutMs?: number;
}) {
  let recovered: Promise<void> | null = null;
  const records = new Map<string, SearchRecord>();
  const pending = new Map<string, Promise<ShortlistSearch[]>>();
  const write = createSerialFileWriter(file);
  const report = (error: unknown, stage: string) => logEvent('shortlist.searchPreparation', {
    stage, error: error instanceof Error ? error.message : String(error),
  });
  const recover = () => recovered ??= (async () => {
    try {
      const raw = JSON.parse(await readFile(file, 'utf8'));
      // Earlier versions lacked an independent semantic check.
      if (raw?.version !== PREPARATION_VERSION) return;
      const store = storeSchema.parse(raw);
      for (const record of store.records) if (record.expiresAt > now()) records.set(record.key, record);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) report(error, 'recovery');
    }
  })();
  async function save(record: SearchRecord) {
    for (const [key, value] of records) if (value.expiresAt <= now()) records.delete(key);
    records.delete(record.key);
    records.set(record.key, record);
    while (records.size > 64) records.delete(records.keys().next().value!);
    try {
      await mkdir(dirname(file), { recursive: true });
      await write(JSON.stringify({ version: PREPARATION_VERSION, records: [...records.values()] }));
    } catch (error) { report(error, 'save'); } // Retain the in-memory result even if disk is unavailable.
  }
  async function prepare(key: string, brief: ShortlistSearchBrief, prompt: string, input: ReturnType<typeof shortlistSearchInput>): Promise<ShortlistSearch[]> {
    await recover();
    const previous = records.get(key);
    if (previous?.status === 'ready' && previous.expiresAt > now()) return previous.searches;
    if (previous?.status === 'failed' && previous.expiresAt > now()
      && (previous.attempts >= 2 || previous.retryAt > now())) return [];
    try {
      // Each call gets its own deadline: with one shared, a slow generation left
      // the verification no time at all. The result is cached for the airing, so
      // only its first pick, or a retry after a failure, waits on them.
      const raw = await withDeadline(timeoutMs, 'Shortlist search preparation', signal => generate(prompt, signal));
      const { searches } = preparedShortlistSearchSchema.parse(raw);
      const proposals = searches.flatMap((search, index) => groundShortlistSearches([search], [input.topic, input.editorial], input.presenters).length
        ? [{ index, kind: search.kind, query: search.query, evidence: search.evidence }] : []);
      let distinct: ShortlistSearch[] = [];
      if (proposals.length) {
        // Do not expose the proposer's intent label to the independent check.
        // It judges the quoted instruction in its original brief, rather than
        // treating a model-assigned label as evidence that music was requested.
        const verdict = verificationSchema.parse(await withDeadline(timeoutMs, 'Shortlist search verification',
          signal => verify(JSON.stringify({ brief: input, proposals }), signal)));
        if (verdict.accepted.some(index => !proposals.some(proposal => proposal.index === index))) throw new Error('Search verification returned an unknown proposal');
        const accepted = new Set(verdict.accepted);
        distinct = groundShortlistSearches(searches.filter((_search, index) => accepted.has(index)),
          [input.topic, input.editorial], input.presenters);
      }
      if (brief.expiresAt <= now()) return [];
      await save({ key, expiresAt: brief.expiresAt, status: 'ready', searches: distinct, attempts: 1, retryAt: 0 });
      logEvent('shortlist.searchPreparation', { stage: 'ready', occurrenceId: brief.occurrenceId, searches: distinct, rejected: searches.length - distinct.length });
      return distinct;
    } catch (error) {
      report(error, 'generate');
      if (brief.expiresAt > now()) await save({ key, expiresAt: brief.expiresAt, status: 'failed', searches: [],
        attempts: previous?.status === 'failed' ? Math.min(2, previous.attempts + 1) : 1, retryAt: now() + 5 * 60_000 });
      return [];
    }
  }
  function ensure(brief: ShortlistSearchBrief): Promise<ShortlistSearch[]> {
    if (!brief.occurrenceId || !Number.isFinite(brief.expiresAt) || brief.expiresAt <= now() || !(brief.topic.trim() || brief.editorial?.trim())) return Promise.resolve([]);
    const input = shortlistSearchInput(brief);
    const prompt = JSON.stringify(input);
    const key = createHash('sha256').update(JSON.stringify([PREPARATION_VERSION, brief.occurrenceId, brief.expiresAt, prompt])).digest('hex');
    const running = pending.get(key);
    if (running) return running;
    const operation = prepare(key, { ...brief }, prompt, input).finally(() => pending.delete(key));
    pending.set(key, operation);
    return operation;
  }
  return { ensure };
}

export const shortlistSearchPreparation = createShortlistSearchPreparation({
  file: `${config.stateDir}/shortlist-search-preparations.json`,
  generate: (prompt, signal) => djObject({
    system: instruction('picker', 'shortlist-search-preparation'), prompt,
    schema: preparedShortlistSearchSchema,
    temperature: 0.1, maxOutputTokens: 768, kind: 'djShortlistSearchPreparation',
    signal,
  }),
  verify: (prompt, signal) => {
    if (!budget.optionalSegmentsAllowed()) throw new Error('Search verification paused by the token budget');
    return djObject({
      system: instruction('picker', 'shortlist-search-verification'), prompt,
      schema: verificationSchema,
      temperature: 0, maxOutputTokens: 128, kind: 'djShortlistSearchVerification',
      signal,
    });
  },
});

// Shared by live picking and the Discovery Bench. Gate before any occurrence
// lookup, cache read or model call, including on migrated Candidate Pool stations.
export async function prepareShortlistSearches({ activeShow, context, showAt = null, episodeSource = null }: {
  activeShow: any; context: any; showAt?: Date | null; episodeSource?: unknown;
}): Promise<ShortlistSearch[]> {
  if (settings.get().llm?.shortlistSearchPreparation !== true || !activeShow || episodeSource
    || !budget.optionalSegmentsAllowed()) return [];
  const occurrence = showPreparation.occurrence({
    context: showAt ? { ...context, at: showAt.toISOString() } : context,
  });
  if (!occurrence) return [];
  return shortlistSearchPreparation.ensure({
    occurrenceId: occurrence.id, expiresAt: occurrence.endsAt,
    topic: activeShow.topic ?? '', editorial: context?.episodeEditorial,
    presenterNames: [activeShow.persona?.name, ...(activeShow.guests ?? []).map((guest: any) => guest.name)]
      .filter((name): name is string => typeof name === 'string' && !!name),
  });
}
