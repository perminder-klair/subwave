'use client';

import type { ChangeEvent } from 'react';
import { useState } from 'react';
import { errorMessage } from '../../../lib/notify';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectGroup,
} from '../../ui/select';
import { Card, Btn, Pill } from '../ui';
import {
  SectionHeader, SaveBar, KeyStatus, KeyTestResult,
  type SectionProps,
} from './shared';

const SEARCH_PROVIDER_LABELS: Record<string, string> = {
  duckduckgo: 'DuckDuckGo (free, no key)',
  tavily: 'Tavily (paid web search)',
  searxng: 'SearXNG (self-hosted)',
};

const searchProviderLabel = (id: string | undefined): string =>
  (id && SEARCH_PROVIDER_LABELS[id]) || id || '—';

interface SearchSectionProps extends SectionProps {
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
}
export function SearchSection({ data, form, setForm, busy, saveSettings, adminFetch }: SearchSectionProps) {
  const [tavilyKeyTest, setTavilyKeyTest] = useState<{ ok: boolean; message: string; latencyMs: number } | null>(null);
  const [tavilyKeyTesting, setTavilyKeyTesting] = useState(false);
  const [testingSearxng, setTestingSearxng] = useState(false);
  const [searxngTestResult, setSearxngTestResult] = useState<{ ok: boolean; results?: number; error?: string } | null>(null);

  const handleTestSearxng = async () => {
    setTestingSearxng(true);
    setSearxngTestResult(null);
    try {
      const res = await adminFetch('/settings/search/test-searxng', {
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
      // Don't echo back 'set' — that's the redaction sentinel from getRedacted().
      // The controller's update() ignores it, but skipping it keeps the patch tidy.
      ...(form.search.apiKey && form.search.apiKey !== 'set'
        ? { apiKey: form.search.apiKey }
        : {}),
      ...(form.search.provider === 'searxng'
        ? { baseUrl: form.search.baseUrl ?? '' }
        : {}),
    },
  });

  const savedSearch = data.values?.search || {};
  const providers = data.search?.providers || ['duckduckgo', 'tavily', 'searxng'];
  const provider = form.search.provider;
  const searchDirty = provider !== savedSearch.provider
    || (provider === 'tavily'
        && form.search.apiKey
        && form.search.apiKey !== 'set'
        && form.search.apiKey !== (savedSearch.apiKey || ''))
    || (provider === 'searxng'
        && (form.search.baseUrl ?? '') !== (savedSearch.baseUrl || ''));
  const tavilyKeySet = form.search.apiKey === 'set' || !!data.env?.SEARCH_API_KEY;

  const testTavilyKey = async () => {
    const value = form.search.apiKey === 'set' ? '' : form.search.apiKey;
    if (!value.trim()) return;
    setTavilyKeyTesting(true);
    setTavilyKeyTest(null);
    try {
      const r = await adminFetch('/settings/secrets/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'SEARCH_API_KEY', value: value.trim() }),
      });
      const j = await r.json() as { ok: boolean; message: string; latencyMs: number };
      setTavilyKeyTest(j);
    } catch (e) {
      setTavilyKeyTest({ ok: false, message: errorMessage(e), latencyMs: 0 });
    } finally {
      setTavilyKeyTesting(false);
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
          is free and keyless; Tavily is paid but returns full web results. Switching
          here reroutes the next call, no restart.
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
              <span className="text-[11px] leading-[1.5] text-muted">
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
              onValueChange={v => setForm(f => ({ ...f, search: { ...f.search, provider: v } }))}
            >
              <SelectTrigger className="max-w-[360px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {providers.map(p => (
                    <SelectItem key={p} value={p}>{searchProviderLabel(p)}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <div className="field-hint">
              {provider === 'duckduckgo'
                ? 'DuckDuckGo Instant Answer, free and keyless. Useful for definitions and well-known entities; silent otherwise. The segment director treats silence as a valid outcome.'
                : provider === 'tavily'
                ? 'Tavily, paid web search with full results and an answer summary. Needs an API key.'
                : 'SearXNG, self-hosted meta-search aggregating Google, Brave, DDG and more. No API key needed — just a running SearXNG instance.'}
            </div>
          </div>

          {provider === 'tavily' && (
            <>
              <div className="field">
                <Label>Tavily API key</Label>
                <div className="flex items-stretch gap-2">
                  <Input
                    type="password"
                    value={form.search.apiKey === 'set' ? '' : form.search.apiKey}
                    placeholder={form.search.apiKey === 'set' ? '•••••• (key on file)' : 'tvly-…'}
                    onChange={(e: ChangeEvent<HTMLInputElement>) =>
                      setForm(f => ({ ...f, search: { ...f.search, apiKey: e.target.value } }))
                    }
                    className="max-w-[360px]"
                  />
                  <Btn
                    onClick={testTavilyKey}
                    disabled={
                      tavilyKeyTesting ||
                      !form.search.apiKey.trim() ||
                      form.search.apiKey === 'set'
                    }
                  >
                    {tavilyKeyTesting ? 'Testing…' : 'Test key'}
                  </Btn>
                </div>
                <div className="field-hint">
                  Stored alongside the other admin settings. Falls back to
                  <code> SEARCH_API_KEY</code> in <code>.env</code> when blank. Set
                  one or the other, not both.
                </div>
              </div>
              <KeyStatus envVar="SEARCH_API_KEY" present={tavilyKeySet} />
              {tavilyKeyTest && <KeyTestResult result={tavilyKeyTest} />}
            </>
          )}

          {provider === 'searxng' && (
            <>
              <div className="field">
                <Label>SearXNG URL</Label>
                <div className="flex items-stretch gap-2">
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
                  <p className={`text-sm ${searxngTestResult.ok ? 'text-green-600' : 'text-destructive'}`}>
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
            </>
          )}
        </div>
      </Card>

      <SaveBar
        note="Applies to the next web-search call, no restart needed."
        busy={busy}
        onSave={save}
        saveLabel="Save web search"
      />
    </>
  );
}
