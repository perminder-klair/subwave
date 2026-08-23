'use client';

// A generation legitimately runs for minutes and Cloudflare cuts proxied responses
// off at ~100s with an HTML error page, so the panel starts a job
// (POST /playlists/generate/jobs) and polls it rather than holding one request
// open. Bodies are never parsed before checking they ARE JSON: WebKit reports
// r.json() on that HTML page as "The string did not match the expected pattern".

type AdminFetch = (path: string, init?: RequestInit) => Promise<Response>;

async function readJsonSafe(r: Response): Promise<any> {
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    throw new Error(`the curation service returned an unexpected response (HTTP ${r.status}) — is the controller reachable?`);
  }
  try {
    return await r.json();
  } catch {
    throw new Error(`the curation service returned malformed JSON (HTTP ${r.status})`);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const GEN_POLL_MS = 2000;
const GEN_DEADLINE_MS = 10 * 60_000;
const GEN_POLL_MISSES = 3; // consecutive transient poll failures tolerated

// Throws with an operator-readable message.
export async function runGenerationJob(fetcher: AdminFetch, body: unknown): Promise<any> {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
  // admin-query-imperative: generation-job-start
  const start = await fetcher('/playlists/generate/jobs', init);
  // A pre-jobs controller 404s here (mid-upgrade version skew) — fall back to
  // the synchronous endpoint rather than failing the click.
  if (start.status === 404) {
    // admin-query-imperative: generation-sync-fallback
    const r = await fetcher('/playlists/generate', init);
    const j = await readJsonSafe(r);
    if (!r.ok) throw new Error(j.error || 'generation failed');
    return j;
  }
  const started = await readJsonSafe(start);
  if (!start.ok || !started.jobId) throw new Error(started.error || 'generation failed to start');
  const deadline = Date.now() + GEN_DEADLINE_MS;
  let misses = 0;
  while (Date.now() < deadline) {
    await sleep(GEN_POLL_MS);
    let poll: any;
    try {
      // admin-query-imperative: generation-job-poll
      const r = await fetcher(`/playlists/generate/jobs/${started.jobId}`);
      poll = await readJsonSafe(r);
      if (!r.ok) throw new Error(poll.error || `poll failed (HTTP ${r.status})`);
    } catch (err) {
      if (++misses >= GEN_POLL_MISSES) throw err instanceof Error ? err : new Error('lost contact with the curation service');
      continue;
    }
    misses = 0;
    if (poll.status === 'running') continue;
    if (poll.status === 'error') throw new Error(poll.error || 'generation failed');
    return poll.result || {};
  }
  throw new Error('generation is taking unusually long — it may still land server-side; try again in a minute');
}

export const energyPct = (e?: string | null): number => (e === 'low' ? 34 : e === 'high' ? 92 : 64);
