// Small in-memory provider-call ring for Debug. It deliberately contains no
// bearer token, request body, response body, lyric text, or raw Genius data.
export interface SleeveNotesProviderCall {
  t: string;
  provider: 'genius';
  endpoint: 'search' | 'song' | 'album' | 'annotation';
  title: string;
  artist: string | null;
  ok: boolean;
  status: number | null;
  ms: number;
  error?: string;
}

const MAX_CALLS = 100;
const calls: SleeveNotesProviderCall[] = [];

export function recordProviderCall(call: SleeveNotesProviderCall): void {
  calls.unshift(call);
  if (calls.length > MAX_CALLS) calls.length = MAX_CALLS;
}

export function recentProviderCalls(): SleeveNotesProviderCall[] {
  return calls.slice();
}

export function clearProviderCallsForTest(): void {
  calls.length = 0;
}
