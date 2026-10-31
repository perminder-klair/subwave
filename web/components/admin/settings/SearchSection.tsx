'use client';

import type { ChangeEvent } from 'react';
import { useState } from 'react';
import { errorMessage } from '../../../lib/notify';
import { adminResponse } from '../../../lib/admin-query';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectGroup, SelectLabel,
} from '../../ui/select';
import {
  SEARCH_PROVIDER_CATALOG, SEARCH_PROVIDER_GROUPS, SETTINGS_SEARCH_PROVIDERS, SETTINGS_SEARXNG_ENGINES_MAX,
  type SearchProviderEntry, type SearchProviderGroup,
} from '@/lib/schemas.generated';
import { Card, Btn, Pill } from '../ui';
import {
  SectionHeader, SaveBar, KeyStatus, KeyTestResult,
  type SectionProps,
} from './shared';

// Labels, hints and key fields come from the search catalogue
// (controller/src/schemas/settings.ts, mirrored by gen:schemas).
const searchProvider = (id: string | undefined): SearchProviderEntry | undefined =>
  SEARCH_PROVIDER_CATALOG.find(p => p.id === id);

const searchProviderLabel = (id: string | undefined): string =>
  searchProvider(id)?.label || id || '—';

const SEARCH_GROUP_LABELS: Record<SearchProviderGroup, string> = {
  keyless: 'No key needed',
  keyed: 'Needs an API key',
  'self-hosted': 'Self-hosted',
};

// The server's providers under their Select groups, in SEARCH_PROVIDER_GROUPS
// order, each keeping the server's order. An id the catalogue doesn't know
// goes last, under "Other".
export function groupSearchProviders(ids: readonly string[]): { label: string; ids: string[] }[] {
  const known = new Set<string>(SEARCH_PROVIDER_CATALOG.map(p => p.id));
  return [
    ...SEARCH_PROVIDER_GROUPS.map(group => ({
      label: SEARCH_GROUP_LABELS[group],
      ids: ids.filter(id => searchProvider(id)?.group === group),
    })),
    { label: 'Other', ids: ids.filter(id => !known.has(id)) },
  ].filter(g => g.ids.length > 0);
}

interface SearchSectionProps extends SectionProps {
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
}
export function SearchSection({ data, form, setForm, busy, saveSettings, adminFetch, fieldErrors }: SearchSectionProps) {
  const [keyTest, setKeyTest] = useState<{ ok: boolean; message: string; latencyMs: number } | null>(null);
  const [keyTesting, setKeyTesting] = useState(false);
  const [testingSearxng, setTestingSearxng] = useState(false);
  const [searxngTestResult, setSearxngTestResult] = useState<{ ok: boolean; results?: number; error?: string } | null>(null);

  const handleTestSearxng = async () => {
    setTestingSearxng(true);
    setSearxngTestResult(null);
    try {
      const res = await adminResponse(adminFetch, '/settings/search/test-searxng', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: form.search.baseUrl }),
      });
      const j = await res.json();
      setSearxngTestResult(j);
    } catch (err: unknown) {
      setSearxngTestResult({ ok: false, error: err instanceof Error ? err.message : 'request failed' });
    } finally {
      setTestingSearxng(false);
    }
  };

  const save = () => saveSettings({
    search: {
      provider: form.search.provider,
      // 'set' is getRedacted()'s redaction sentinel; update() ignores it anyway, but
      // skipping it keeps the patch tidy.
      ...(form.search.apiKey && form.search.apiKey !== 'set'
        ? { apiKey: form.search.apiKey }
        : {}),
      ...(form.search.provider === 'searxng'
        ? {
            baseUrl: form.search.baseUrl ?? '',
            searxngEngines: form.search.searxngEngines ?? '',
          }
        : {}),
    },
  });

  const savedSearch = data.values?.search || {};
  const providers = data.search?.providers || [...SETTINGS_SEARCH_PROVIDERS];
  const provider = form.search.provider;
  const entry = searchProvider(provider);
  // Keyed providers share the SEARCH_API_KEY slot; the controller probes the
  // right endpoint based on the provider sent along with a key test.
  const keyed = entry && entry.key !== 'none' ? entry : undefined;
  const searchDirty = provider !== savedSearch.provider
    || (!!keyed
        && form.search.apiKey
        && form.search.apiKey !== 'set'
        && form.search.apiKey !== (savedSearch.apiKey || ''))
    || (provider === 'searxng'
        && ((form.search.baseUrl ?? '') !== (savedSearch.baseUrl || '')
            || (form.search.searxngEngines ?? '') !== (savedSearch.searxngEngines || '')));
  const apiKeySet = form.search.apiKey === 'set' || !!data.env?.SEARCH_API_KEY;

  const testApiKey = async () => {
    const value = form.search.apiKey === 'set' ? '' : form.search.apiKey;
    if (!value.trim()) return;
    setKeyTesting(true);
    setKeyTest(null);
    try {
      const r = await adminResponse(adminFetch, '/settings/secrets/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // `provider` tells the controller which endpoint to probe — the same
        // SEARCH_API_KEY slot holds a Tavily, Brave or Keenable key.
        body: JSON.stringify({ key: 'SEARCH_API_KEY', value: value.trim(), provider }),
      });
      const j = await r.json() as { ok: boolean; message: string; latencyMs: number };
      setKeyTest(j);
    } catch (e) {
      setKeyTest({ ok: false, message: errorMessage(e), latencyMs: 0 });
    } finally {
      setKeyTesting(false);
    }
  };

  return (
    <>
      <SectionHeader
        eyebrow="web search"
        title="Where the DJ gets live facts about the artist on air."
        sub={<>
          The segment director can air a single line of recent artist context between
          tracks, when the active backend returns something worth saying. DuckDuckGo
          is free and keyless; Tavily, Brave and Firecrawl are keyed but return full web results;
          SearXNG is keyless if you self-host it; Keenable returns web results with no
          key. Switching here reroutes the next call, no restart.
        </>}
        metrics={[{ n: String(providers.length), l: 'providers' }]}
      />

      <Card title="Provider" sub="active backend">
        <div className="grid gap-[18px]">
          <div className="flex items-start gap-2.5 border border-[var(--accent)] bg-[var(--ink-softer)] p-3">
            <span className="mt-1 size-1.5 flex-none rounded-full bg-vermilion" />
            <div className="grid min-w-0 gap-0.5">
              <span className="text-[11px] font-bold tracking-[0.12em] text-vermilion uppercase">
                Routing now · {searchProviderLabel(savedSearch.provider || 'duckduckgo')}
              </span>
              <span className="text-[14px] leading-[1.5] text-muted">
                {searchDirty
                  ? <>Your edits below aren&apos;t live until you Save.</>
                  : <>This is the saved, running config.</>}
              </span>
            </div>
          </div>

          <div className="field">
            <div className="flex items-center gap-2">
              <Label>Provider</Label>
              {searchDirty && <Pill tone="accent" dot>unsaved</Pill>}
            </div>
            <Select
              value={provider}
              onValueChange={v => {
                // A key-test verdict is per-provider: don't let a green "Tavily key
                // valid" linger after switching to Brave.
                setKeyTest(null);
                setForm(f => ({ ...f, search: { ...f.search, provider: v } }));
              }}
            >
              <SelectTrigger className="max-w-[360px]" aria-label="Provider"><SelectValue /></SelectTrigger>
              <SelectContent>
                {groupSearchProviders(providers).map(g => (
                  <SelectGroup key={g.label}>
                    <SelectLabel>{g.label}</SelectLabel>
                    {g.ids.map(p => (
                      <SelectItem key={p} value={p}>{searchProviderLabel(p)}</SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
            <div className="field-hint">{entry?.hint}</div>
          </div>

          {keyed && (
            <>
              <div className="field">
                <Label>{keyed.keyName} API key{keyed.key === 'optional' ? ' (optional)' : ''}</Label>
                <div className="flex flex-wrap items-stretch gap-2 sm:flex-nowrap">
                  <Input
                    type="password"
                    autoComplete="off"
                    value={form.search.apiKey === 'set' ? '' : form.search.apiKey}
                    placeholder={form.search.apiKey === 'set' ? '•••••• (key on file)' : keyed.keyPlaceholder}
                    onChange={(e: ChangeEvent<HTMLInputElement>) =>
                      setForm(f => ({ ...f, search: { ...f.search, apiKey: e.target.value } }))
                    }
                    className="max-w-[360px]"
                  />
                  <Btn
                    onClick={testApiKey}
                    disabled={
                      keyTesting ||
                      !form.search.apiKey.trim() ||
                      form.search.apiKey === 'set'
                    }
                  >
                    {keyTesting ? 'Testing…' : 'Test key'}
                  </Btn>
                </div>
                <div className="field-hint">
                  {keyed.key === 'optional' && <>Not needed to search; a key raises the rate limit. </>}
                  {keyed.keyPrefix && <>Only a <code>{keyed.keyPrefix}…</code> key is used: any other key on file, such as one saved for Tavily or Brave, is ignored and searches run keyless. </>}
                  Get one at <a href={keyed.keyUrl} target="_blank" rel="noreferrer" className="underline">{keyed.keyUrl?.replace(/^https:\/\//, '')}</a>.
                  Stored alongside the other admin settings. Falls back to
                  <code> SEARCH_API_KEY</code> in <code>.env</code> when blank. Set
                  one or the other, not both.
                </div>
              </div>
              {/* A keyless provider isn't "missing" anything, so skip the red banner,
                  and a key on file may be another provider's, which a prefix-gated
                  provider ignores, so "ready to use" would overclaim. */}
              {keyed.key !== 'optional' && <KeyStatus envVar="SEARCH_API_KEY" present={apiKeySet} />}
              {/* The controller knows whether the key Keenable would send is a keen_
                  one. A saved key already shows in the field's placeholder, so only
                  an env key needs saying. */}
              {provider === 'keenable' && data.search?.keenableKeySource === 'env' && (
                <KeyStatus
                  envVar="SEARCH_API_KEY"
                  present
                  detail={<><code>SEARCH_API_KEY</code> holds a Keenable key, so searches use it and get the higher rate limit.</>}
                />
              )}
              {keyTest && <KeyTestResult result={keyTest} />}
            </>
          )}

          {provider === 'searxng' && (
            <>
              <div className="field">
                <Label>SearXNG URL</Label>
                <div className="flex flex-wrap items-stretch gap-2 sm:flex-nowrap">
                  <Input
                    type="url"
                    placeholder="http://192.168.0.112:8888"
                    value={form.search.baseUrl ?? ''}
                    onChange={(e: ChangeEvent<HTMLInputElement>) =>
                      setForm(f => ({ ...f, search: { ...f.search, baseUrl: e.target.value } }))
                    }
                    className="max-w-[360px]"
                  />
                  <Btn onClick={handleTestSearxng} disabled={!form.search?.baseUrl || testingSearxng}>
                    {testingSearxng ? 'Testing…' : 'Test'}
                  </Btn>
                </div>
                {searxngTestResult && (
                  <p role="status" className={`text-sm ${searxngTestResult.ok ? 'text-green-600' : 'text-destructive'}`}>
                    {searxngTestResult.ok
                      ? `Connected · ${searxngTestResult.results} results`
                      : `Failed: ${searxngTestResult.error}`}
                  </p>
                )}
                <div className="field-hint">
                  Self-hosted SearXNG instance. No API key required. Ensure JSON format is
                  enabled in your SearXNG <code>settings.yml</code>.
                </div>
              </div>

              <div className="field">
                <Label>Engines (optional)</Label>
                <Input
                  type="text"
                  placeholder="google, duckduckgo web, wikipedia"
                  maxLength={SETTINGS_SEARXNG_ENGINES_MAX}
                  value={form.search.searxngEngines ?? ''}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    setForm(f => ({ ...f, search: { ...f.search, searxngEngines: e.target.value } }))
                  }
                  className="max-w-[360px]"
                />
                <div className="field-hint">
                  Comma-separated list restricting which engines SearXNG queries for
                  SUB/WAVE&apos;s calls only — your browser traffic keeps the instance
                  defaults. Leave blank to use the full default engine set. Names must
                  match the <code>name:</code> field in SearXNG&apos;s{' '}
                  <code>settings.yml</code> exactly (e.g. <code>duckduckgo web</code>,
                  not the internal <code>engine:</code> module id): SearXNG silently
                  ignores a name it doesn&apos;t recognise rather than erroring.
                </div>
              </div>
            </>
          )}
        </div>
      </Card>

      <SaveBar
        note="Applies to the next web-search call, no restart needed."
        busy={busy}
        onSave={save}
        saveLabel="Save web search"
        errors={fieldErrors}
        ownedKeys={['search']}
      />
    </>
  );
}
