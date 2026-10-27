// What Siri says back to "request a song on SUB/WAVE" (RequestSongIntent). The
// same POST /request and polling the request drawer does, cut short: Siri has
// to answer while the listener waits, where the drawer can wait a minute.
// Pure, so scripts/intent-request.test.ts can drive it.

import type { IntentReply } from '../../modules/app-intents';
import type { StationApi } from '../lib/api';
import { requestResultLabel } from '../lib/request-outcome';
import type { RequestResult } from '../lib/types';

// How long Siri is kept waiting for the DJ to match the request. Matching is
// a model call on the station's own LLM and can run longer; past this, Siri
// says the request is in and it carries on resolving without anyone waiting.
export const REQUEST_WAIT_MS = 10_000;
// The drawer's interval.
const POLL_INTERVAL_MS = 1500;

// The drawer's own line for a request still being matched.
export const ACCEPTED_MESSAGE = 'Got it — taking it to the booth.';

export interface AskForSongDeps {
  api: Pick<StationApi, 'postRequest' | 'pollRequest'>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  waitMs?: number;
}

export async function askForSong(text: string, deps: AskForSongDeps): Promise<IntentReply> {
  const asked = text.trim();
  if (!asked) return { ok: false, message: 'Tell me a song, an artist or a mood.' };
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;

  // A refusal is answered in the station's words: requests closed, nobody
  // tuned in, a rate limit, a full queue. A 400 carries `error`, not `message`.
  let posted: RequestResult & { error?: string };
  try {
    posted = await deps.api.postRequest({ text: asked });
  } catch {
    return { ok: false, message: "Couldn't reach the station. Check your connection and try again." };
  }
  if (!posted.success) {
    return {
      ok: false,
      message: posted.message || posted.error || "The station didn't take the request.",
    };
  }
  if (!posted.requestId) return { ok: true, message: ACCEPTED_MESSAGE };

  const deadline = now() + (deps.waitMs ?? REQUEST_WAIT_MS);
  while (now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    let data: RequestResult | null;
    try {
      data = await deps.api.pollRequest(posted.requestId);
    } catch {
      data = null;
    }
    if (data?.status === 'resolved') return { ok: true, message: spokenAnswer(data) };
    if (data?.status === 'failed') {
      return { ok: false, message: data.message || 'No match — try different words.' };
    }
    if (data?.status === 'unknown') break;
  }
  return { ok: true, message: ACCEPTED_MESSAGE };
}

/** The DJ's own acknowledgement when there is one; otherwise the drawer's
 *  label with the track it names. */
export function spokenAnswer(result: RequestResult): string {
  if (result.ack) return result.ack;
  const label = requestResultLabel({ ...result, pending: false });
  const title = result.track?.title;
  if (!title) return `${label}.`;
  const artist = result.track?.artist;
  return artist ? `${label}: ${title} by ${artist}.` : `${label}: ${title}.`;
}
