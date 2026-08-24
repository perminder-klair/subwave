'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  useQueryClient,
  type QueryClient,
  type QueryFunction,
  type QueryKey,
} from '@tanstack/react-query';
import { useDebounceValue } from 'usehooks-ts';
import { adminJson, useAdminQuery, type AdminFetch } from '@/lib/admin-query';

export interface ModelDiscoveryInput {
  provider: string;
  baseUrl?: string;
  ollamaUrl?: string;
  scope?: 'embedding' | 'chat';
}

export interface VoiceDiscoveryInput { provider: string; baseUrl?: string; }
export interface DiscoveredVoice { id: string; label: string; hint?: string; }
export type ModelDiscoveryResponse = { ok: boolean; models: string[]; error?: string };
export type VoiceDiscoveryResponse = { ok: boolean; voices: DiscoveredVoice[]; error?: string };

export const discoveryKeys = {
  all: ['discovery'] as const,
  models: (input: ModelDiscoveryInput) => ['discovery', 'models', input] as const,
  voices: (input: VoiceDiscoveryInput) => ['discovery', 'voices', input] as const,
};

const compact = (value: string | undefined): string | undefined => value?.trim() || undefined;

export function normalizeModelDiscoveryInput(input: ModelDiscoveryInput): ModelDiscoveryInput {
  const baseUrl = compact(input.baseUrl);
  const ollamaUrl = compact(input.ollamaUrl);
  return { provider: input.provider.trim(), ...(baseUrl ? { baseUrl } : {}), ...(ollamaUrl ? { ollamaUrl } : {}), ...(input.scope ? { scope: input.scope } : {}) };
}

export function normalizeVoiceDiscoveryInput(input: VoiceDiscoveryInput): VoiceDiscoveryInput {
  const baseUrl = compact(input.baseUrl);
  return { provider: input.provider.trim(), ...(baseUrl ? { baseUrl } : {}) };
}

function sameInput<T>(left: T, right: T): boolean { return JSON.stringify(left) === JSON.stringify(right); }

function queryString(input: object): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(input)) if (typeof value === 'string' && value) params.set(name, value);
  return params.toString();
}

export function fetchModels(adminFetch: AdminFetch, input: ModelDiscoveryInput, signal: AbortSignal): Promise<ModelDiscoveryResponse> {
  return adminJson(adminFetch, `/settings/llm/models?${queryString(input)}`, undefined, signal);
}

export function fetchVoices(adminFetch: AdminFetch, input: VoiceDiscoveryInput, signal: AbortSignal): Promise<VoiceDiscoveryResponse> {
  return adminJson(adminFetch, `/settings/tts/voices?${queryString(input)}`, undefined, signal);
}

export async function refreshDiscoveryQuery<T>(
  client: QueryClient,
  queryKey: QueryKey,
  queryFn: QueryFunction<T>,
): Promise<T> {
  await client.cancelQueries({ queryKey, exact: true }, { silent: true });
  return client.fetchQuery({ queryKey, queryFn, staleTime: 0 });
}

function useDiscoveryInput<T>(raw: T) {
  const [debounced] = useDebounceValue(raw, 400);
  const [refreshed, setRefreshed] = useState<T | null>(null);
  const usesRefreshed = refreshed !== null && sameInput(refreshed, raw) && !sameInput(debounced, raw);
  const refreshInput = useCallback(() => { setRefreshed(raw); return raw; }, [raw]);
  return { input: usesRefreshed ? refreshed : debounced, refreshInput, isRawTransition: !usesRefreshed && !sameInput(raw, debounced) };
}

function discoveryError(data: { ok: boolean; error?: string } | undefined, error: unknown, enabled: boolean): string | null {
  if (!enabled) return null;
  if (data && !data.ok) return data.error || 'Discovery failed';
  return error instanceof Error ? error.message : error ? 'Discovery failed' : null;
}

export function useModelDiscoveryQuery(rawInput: ModelDiscoveryInput, enabled: boolean, adminFetch: AdminFetch) {
  const { provider, baseUrl, ollamaUrl, scope } = rawInput;
  const raw = useMemo(() => normalizeModelDiscoveryInput({ provider, baseUrl, ollamaUrl, scope }), [provider, baseUrl, ollamaUrl, scope]);
  const { input, refreshInput } = useDiscoveryInput(raw);
  const client = useQueryClient();
  const query = useAdminQuery<ModelDiscoveryResponse>({
    key: discoveryKeys.models(input), adminFetch,
    request: (fetcher, signal) => fetchModels(fetcher, input, signal),
    enabled: enabled && !!input.provider,
    staleTime: 30_000,
    placeholderData: previous => previous,
  });
  const refresh = useCallback(() => {
    if (!enabled || !raw.provider) return;
    const next = refreshInput();
    const queryKey = discoveryKeys.models(next);
    void refreshDiscoveryQuery(
      client,
      queryKey,
      ({ signal }) => fetchModels(adminFetch, next, signal),
    ).catch(() => {});
  }, [adminFetch, client, enabled, raw.provider, refreshInput]);
  return {
    models: enabled && query.data?.ok ? (Array.isArray(query.data.models) ? query.data.models : []) : [],
    loading: enabled && query.isFetching,
    error: discoveryError(query.data, query.error, enabled),
    refresh,
  };
}

export function useVoiceDiscoveryQuery(rawInput: VoiceDiscoveryInput, enabled: boolean, adminFetch: AdminFetch) {
  const { provider, baseUrl } = rawInput;
  const raw = useMemo(() => normalizeVoiceDiscoveryInput({ provider, baseUrl }), [provider, baseUrl]);
  const { input, refreshInput, isRawTransition } = useDiscoveryInput(raw);
  const client = useQueryClient();
  const query = useAdminQuery<VoiceDiscoveryResponse>({
    key: discoveryKeys.voices(input), adminFetch,
    request: (fetcher, signal) => fetchVoices(fetcher, input, signal),
    enabled: enabled && !!input.provider,
    staleTime: 30_000,
  });
  const refresh = useCallback(() => {
    if (!enabled || !raw.provider) return;
    const next = refreshInput();
    const queryKey = discoveryKeys.voices(next);
    void refreshDiscoveryQuery(
      client,
      queryKey,
      ({ signal }) => fetchVoices(adminFetch, next, signal),
    ).catch(() => {});
  }, [adminFetch, client, enabled, raw.provider, refreshInput]);
  return {
    voices: enabled && !isRawTransition && query.data?.ok && Array.isArray(query.data.voices) ? query.data.voices : [],
    loading: enabled && query.isFetching,
    error: discoveryError(query.data, query.error, enabled),
    refresh,
  };
}
