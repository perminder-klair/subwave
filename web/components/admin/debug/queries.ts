import { adminJson, type AdminFetch } from '../../../lib/admin-query';
import { playbackFailureHistorySchema } from '../../../lib/schemas.generated';
import type { DebugData, PlaybackFailureHistory } from './types';

export const debugKeys = {
  all: ['debug'] as const,
  playbackFailures: () => ['debug', 'playback-failures'] as const,
  status: () => ['debug', 'status'] as const,
  stateFiles: () => ['debug', 'state-files'] as const,
  stateFile: (path: string) => ['debug', 'state-files', path] as const,
  llmCalls: () => ['debug', 'llm-calls'] as const,
  subsonicCalls: () => ['debug', 'subsonic-calls'] as const,
};

export function fetchDebug(fetcher: AdminFetch, signal: AbortSignal): Promise<DebugData> {
  return adminJson(fetcher, '/debug', undefined, signal);
}

export interface StateEntry {
  name: string;
  isDir: boolean;
  isSymlink: boolean;
  size?: number;
  mtime?: string;
}

export interface StateListing {
  root?: string;
  path?: string;
  entries?: StateEntry[];
  shown?: number;
  total?: number;
  error?: string;
}

export function fetchStateListing(
  fetcher: AdminFetch,
  path: string,
  signal: AbortSignal,
): Promise<StateListing> {
  return adminJson(fetcher, `/debug/state-tree?path=${encodeURIComponent(path)}`, undefined, signal);
}

export async function fetchPlaybackFailures(fetcher: AdminFetch, signal: AbortSignal): Promise<PlaybackFailureHistory> {
  const body = await adminJson<unknown>(fetcher, '/debug/playback-failures', undefined, signal);
  const result = playbackFailureHistorySchema.safeParse(body);
  if (!result.success) {
    throw new Error('Unexpected failure history response');
  }
  return result.data;
}
