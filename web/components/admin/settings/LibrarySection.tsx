'use client';

import type { ChangeEvent } from 'react';
import { useEffect, useState } from 'react';
import { notify, errorMessage } from '../../../lib/notify';
import { adminResponse } from '../../../lib/admin-query';
import { useModelDiscovery } from '@/hooks/useModelDiscovery';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectGroup,
} from '../../ui/select';
import { Card, Btn, Seg } from '../ui';
import { Advanced } from './section-chrome';
import { EmbeddingProviderSelector } from '../embedding/EmbeddingProviderSelector';
import { ModelCombobox } from '../llm/ModelCombobox';
import { LLM_ENV_VARS, llmProviderLabel } from '../llm/providerMeta';
import { cn } from '../../../lib/cn';
import {
  SectionHeader, SaveBar, KeyStatus,
  type SectionProps,
} from './shared';

// The #1 trip-up is typing an HF/locca repo id like
// "nomic-ai/nomic-embed-text-v1.5-GGUF" as an Ollama tag, which 404s — Ollama
// wants the short tag. dim is shown so an already-tagged library can be matched.
const EMBED_MODEL_SUGGESTIONS: Record<string, { id: string; dim: number }[]> = {
  ollama: [
    { id: 'nomic-embed-text', dim: 768 },
    { id: 'mxbai-embed-large', dim: 1024 },
    { id: 'bge-m3', dim: 1024 },
    { id: 'all-minilm', dim: 384 },
  ],
  openai: [
    { id: 'text-embedding-3-small', dim: 1536 },
    { id: 'text-embedding-3-large', dim: 3072 },
  ],
  google: [{ id: 'text-embedding-004', dim: 768 }],
  openrouter: [
    { id: 'openai/text-embedding-3-small', dim: 1536 },
    { id: 'openai/text-embedding-3-large', dim: 3072 },
  ],
  requesty: [
    { id: 'openai/text-embedding-3-small', dim: 1536 },
    { id: 'openai/text-embedding-3-large', dim: 3072 },
  ],
};

const LLM_BATCH_SIZES = [5, 10, 25] as const;

interface LibrarySectionProps extends SectionProps {
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  refresh: () => void;
}

export function LibrarySection({ data, form, setForm, busy, saveSettings, adminFetch, refresh, fieldErrors }: LibrarySectionProps) {
  const e = form.embedding;
  const [embeddingKeyInput, setEmbeddingKeyInput] = useState('');
  const [compatEmbedKeyInput, setCompatEmbedKeyInput] = useState('');

  useEffect(() => { setEmbeddingKeyInput(''); setCompatEmbedKeyInput(''); }, [form.embedding.provider]);

  const saveKey = async (envVar: string, value: string): Promise<boolean> => {
    if (!value.trim()) return true;
    try {
      const r = await adminResponse(adminFetch, '/settings/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [envVar]: value.trim() }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({})) as { error?: string };
        notify.err(j.error || `Key save failed (${r.status})`);
        return false;
      }
      return true;
    } catch (e) {
      notify.err(errorMessage(e));
      return false;
    }
  };

  const save = async () => {
    await saveSettings({
      embedding: {
        enabled: e.enabled,
        provider: e.provider,
        model: e.model,
        providerBaseUrls: e.providerBaseUrls,
        ollamaUrl: e.ollamaUrl,
        seedCount: parseInt(e.seedCount, 10) || 0,
        knnNeighbours: parseInt(e.knnNeighbours, 10) || 10,
        moodVoteThreshold: parseFloat(e.moodVoteThreshold) || 0.4,
        confidenceThreshold: parseFloat(e.confidenceThreshold) || 0.35,
        maxActiveLearningRounds: parseInt(e.maxActiveLearningRounds, 10) || 0,
        // NaN-safe rather than `|| 0.5` — 0 is a deliberate value (fusion off)
        // and must not be coerced back to the default.
        audioFusionWeight: Number.isFinite(parseFloat(e.audioFusionWeight))
          ? parseFloat(e.audioFusionWeight)
          : 0.5,
        batchSize: parseInt(e.batchSize, 10) || 25,
        enrichment: {
          lastfmTags: e.enrichment.lastfmTags,
          lyrics: e.enrichment.lyrics,
        },
        // Write only when typed; getRedacted()'s 'set' sentinel is ignored
        // server-side, so it never overwrites the stored key.
        ...(effectiveProvider === 'openai-compatible' && compatEmbedKeyInput.trim()
          ? { apiKey: compatEmbedKeyInput.trim() }
          : {}),
      },
    });
    // No separate toast/refresh: saveSettings covers the whole embedding patch, and
    // toasting ok here would lie when the save itself failed.
    if (effectiveProvider === 'openai-compatible' && compatEmbedKeyInput.trim()) {
      setCompatEmbedKeyInput('');
    }
    // embedKeyVar is set only for providers that use a conventional key.
    if (embedKeyVar && embeddingKeyInput.trim()) {
      const ok = await saveKey('EMBEDDING_API_KEY', embeddingKeyInput);
      if (ok) { notify.ok('API key saved'); setEmbeddingKeyInput(''); refresh(); }
    }
  };

  const savedEmbedding = data.values?.embedding || {};
  const llmProvider = data.values?.llm?.provider || 'ollama';
  const effectiveProvider = e.provider || llmProvider;
  const embedSuggestions = EMBED_MODEL_SUGGESTIONS[effectiveProvider] ?? [];

  // The embedding-capable subset, NOT the full LLM list: chat-only providers
  // (deepseek, gateway) have no embeddings endpoint (#493); OpenRouter shipped one
  // so it is back in (#522); Anthropic has no embedding API at all.
  const embedProviders = data.embedding?.providers ||
    ['ollama', 'openai-compatible', 'locca', 'openrouter', 'openai', 'google', 'requesty'];
  // Keep a stale explicit choice (a chat-only provider saved before this list
  // shrank) visible so the Select isn't blank and the warning below makes sense.
  const providers = e.provider && !embedProviders.includes(e.provider)
    ? [e.provider, ...embedProviders]
    : embedProviders;
  // False when "Follow LLM provider" resolves to a chat-only LLM, or a stale config
  // still names one. Drives the warning below.
  const canEmbed = embedProviders.includes(effectiveProvider);

  // Probe the endpoint up front rather than failing mid-run (#405 follow-up).
  const [probe, setProbe] = useState<
    { ok: boolean; dim: number | null; code: string; message: string } | null
  >(null);
  const [probing, setProbing] = useState(false);
  const [detecting, setDetecting] = useState(false);
  // Local servers (llama.cpp/locca) need a dedicated embedding endpoint; cloud
  // and Ollama providers serve embeddings on the same endpoint as chat.
  const needsServerUrl = effectiveProvider === 'locca' || effectiveProvider === 'openai-compatible';

  const embedKeyVar = LLM_ENV_VARS[effectiveProvider];
  const embedKeySet = !!(embedKeyVar && data.env?.[embedKeyVar]);
  // Embeddings reuse the DJ provider's key, so "present" means that provider's env
  // var OR the optional override. Keying off EMBEDDING_API_KEY alone would cry
  // "missing" for a provider whose key is already set for the DJ.
  const embedKeyPresent = embedKeySet || !!data.env?.['EMBEDDING_API_KEY'];

  // `||` (not `??`) so a field cleared in the form ('' entry) falls through to
  // the chat leg's URL, matching the pre-map `e.baseUrl || form.llm.baseUrl`.
  const embedBaseUrl = e.providerBaseUrls[effectiveProvider]
    || form.llm.providerBaseUrls[effectiveProvider]
    || '';

  const embedDiscoveryEnabled =
    effectiveProvider === 'ollama'
    || effectiveProvider === 'locca'
    || (effectiveProvider === 'openai-compatible' && !!embedBaseUrl.trim())
    || (effectiveProvider === 'openrouter')
    || (!!embedKeyVar && embedKeySet);

  const embedDiscovery = useModelDiscovery({
    provider: effectiveProvider,
    baseUrl: embedBaseUrl,
    ollamaUrl: e.ollamaUrl || form.llm.ollamaUrl,
    scope: 'embedding',
    enabled: embedDiscoveryEnabled,
    adminFetch,
  });

  // POST body, not query params — the unsaved bearer token must never ride a
  // URL that reverse-proxy access logs capture.
  const probeBody = () => {
    const b: Record<string, string> = {};
    if (e.provider) b.provider = e.provider;
    if (e.model) b.model = e.model;
    if (embedBaseUrl) b.baseUrl = embedBaseUrl;
    if (e.ollamaUrl) b.ollamaUrl = e.ollamaUrl;
    if (compatEmbedKeyInput.trim()) b.apiKey = compatEmbedKeyInput.trim();
    return b;
  };

  const runProbe = async () => {
    setProbing(true);
    setProbe(null);
    try {
      const r = await adminResponse(adminFetch, '/settings/embedding/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(probeBody()),
      });
      setProbe(await r.json());
    } catch (err) {
      setProbe({ ok: false, dim: null, code: 'unknown', message: errorMessage(err) });
    } finally {
      setProbing(false);
    }
  };

  // Locca's default port is 8090.
  const detect = async () => {
    setDetecting(true);
    setProbe(null);
    const url = 'http://host.docker.internal:8090/v1';
    try {
      let model = 'nomic-embed-text';
      try {
        const d = await (
          // admin-query-imperative: locca-discovery-probe
          await adminResponse(adminFetch, `/settings/llm/discover?baseUrl=${encodeURIComponent(url)}`)
        ).json();
        if (d.reachable && Array.isArray(d.models) && d.models.length) model = d.models[0];
      } catch {
        /* discovery is best-effort — fall through and probe with the default model */
      }
      const r = await adminResponse(adminFetch, '/settings/embedding/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'locca', baseUrl: url, model }),
      });
      const j = await r.json();
      setProbe(j);
      if (j.ok) {
        setForm(f => ({ ...f, embedding: { ...f.embedding, provider: 'locca', providerBaseUrls: { ...f.embedding.providerBaseUrls, locca: url }, model } }));
      }
    } catch (err) {
      setProbe({ ok: false, dim: null, code: 'unknown', message: errorMessage(err) });
    } finally {
      setDetecting(false);
    }
  };

  // What the tagger will embed with right now, resolved from the LIVE form (not
  // saved state): "Follow LLM" resolves the provider, a blank Model field resolves
  // to that provider's default.
  const embeddedMeta = data.libraryStats?.embeddingMeta || null;
  const suggestedDefault = EMBED_MODEL_SUGGESTIONS[effectiveProvider]?.[0];
  // Providers with no combobox suggestions that still resolve server-side.
  const OTHER_EMBED_DEFAULTS: Record<string, string> = {
    'openai-compatible': 'text-embedding-3-small',
    locca: 'nomic-embed-text',
    anthropic: 'text-embedding-3-small',
  };
  const effectiveModel =
    e.model?.trim() || suggestedDefault?.id || OTHER_EMBED_DEFAULTS[effectiveProvider] || '';
  // Prefer a real measurement (a green probe, or the dim the library was actually
  // embedded at) over the name→dim guess.
  const effectiveDim =
    probe?.dim ??
    embeddedMeta?.dim ??
    EMBED_MODEL_SUGGESTIONS[effectiveProvider]?.find(m => m.id === effectiveModel)?.dim ??
    suggestedDefault?.dim ??
    null;

  return (
    <>
      <SectionHeader
        eyebrow="library tagger"
        title="Embedding-propagated mood tagging."
        sub={<>
          The tagger embeds every track once (embedding provider below),
          LLM-tags a small representative seed set using your DJ&rsquo;s LLM
          (Settings → LLM), then KNN-propagates moods + energy to the rest.
          Cuts LLM call count ~10× vs. brute-force per-track tagging. Tune
          below; changes apply the next time the bulk tagger runs.
        </>}
        metrics={[
          {
            n: String(data.libraryStats?.total ?? '—'),
            l: 'tagged',
          },
        ]}
        manualHref="/manual/llm"
        manualLabel="How embeddings work"
      />

      <Card title="Tagger" sub="enabled?">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-4">
          <div>
            <div className="text-[13px] font-bold">Embedding-propagated tagging</div>
            <div className="mt-0.5 max-w-[480px] text-[14px] leading-[1.5] text-muted">
              When off, the bulk tagger refuses to start. Single-track retags
              from the Library admin page still work (they bypass the
              embedding pipeline).
            </div>
          </div>
          <Seg
            accent
            value={e.enabled ? 'on' : 'off'}
            options={[
              { id: 'off', label: 'Off' },
              { id: 'on', label: 'On' },
            ]}
            onChange={v =>
              setForm(f => ({ ...f, embedding: { ...f.embedding, enabled: v === 'on' } }))
            }
          />
        </div>

        <hr className="my-5 border-[var(--border)]" />

        <div className="field">
          <Label>LLM batch size</Label>
          <Select
            value={e.batchSize}
            onValueChange={v => setForm(f => ({ ...f, embedding: { ...f.embedding, batchSize: v } }))}
          >
            <SelectTrigger className="max-w-[100px]" aria-label="LLM batch size"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {LLM_BATCH_SIZES.map(s => (
                  <SelectItem key={s} value={String(s)}>{s} songs</SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <div className="field-hint">
            How many songs to tag in a single LLM call. Smaller models may need
            a lower batch size to avoid truncation or errors. 25 is the default.
          </div>
        </div>
      </Card>

      <Card title="Embedding server" sub="where embeddings come from">
        <div className="grid gap-[18px]">
          {/* Provider/model/dim resolve to a working default even with both fields
              blank, so say so rather than looking unconfigured. Hidden when the
              effective provider can't embed — the warning below covers that. */}
          {canEmbed && effectiveModel && (
            <div className="flex items-start gap-x-2 border border-[color-mix(in_oklab,var(--accent)_30%,transparent)] bg-[var(--accent-soft)] p-3 text-[11px] leading-[1.5] text-ink">
              <span className="flex-none text-[12px] leading-[1.5] text-[var(--accent)]">✓</span>
              <span className="min-w-0">
                Embeddings ready with defaults: <code>{llmProviderLabel(effectiveProvider)}</code>
                {!e.provider && <span className="text-muted"> (your DJ&rsquo;s provider)</span>}
                {' · '}<code>{effectiveModel}</code>
                {effectiveDim != null && <span className="text-muted"> · {effectiveDim}-d</span>}.
                <span className="text-muted"> Change the provider or model below to override.
                This provider makes the similarity vectors only — the per-track
                mood &amp; energy calls bill to your DJ&rsquo;s LLM
                (<code>{llmProviderLabel(llmProvider)}</code>, Settings → LLM).</span>
              </span>
            </div>
          )}
          <div className="field">
            <Label>Provider</Label>
            <EmbeddingProviderSelector
              // A blank stored provider resolves to the DJ's provider, so the
              // grid always shows an explicit selection (no "Follow LLM" card).
              value={effectiveProvider}
              providerIds={providers}
              env={data.env}
              onChange={v =>
                setForm(f => ({ ...f, embedding: { ...f.embedding, provider: v } }))
              }
              className="max-w-[560px]"
            />
            <div className="field-hint">
              Where the text embeddings come from — used for the sounds-like
              similarity and tag-propagation steps <em>only</em>. The mood &amp;
              energy tagging calls themselves always use your DJ&rsquo;s LLM
              provider (Settings → LLM), and bill there. Defaults to your DJ&rsquo;s
              provider, so Ollama-local users get <code>nomic-embed-text</code> free.
              Anthropic has no first-party embedding API; if your LLM is Anthropic,
              pick OpenAI here (needs <code>OPENAI_API_KEY</code>).
            </div>
            {/* The banner above already states the resolved provider/model/dim, so
                only the already-embedded-with-a-different-model warning goes here. */}
            {embeddedMeta && embeddedMeta.model !== effectiveModel && (
              <div className="field-hint">
                Your library is embedded with{' '}
                <code>{embeddedMeta.model}</code> ({embeddedMeta.dim}-d); changing
                the model means a full re-embed.
              </div>
            )}

            {!canEmbed && (
              <div
                role="alert"
                className="mt-2 max-w-[480px] border border-l-[3px] border-[var(--danger)] bg-[color-mix(in_oklab,var(--danger)_7%,transparent)] p-3"
              >
                <div className="flex items-center gap-2">
                  <span className="text-[13px] leading-none text-[var(--danger)]">⚠</span>
                  <span className="text-[11px] font-bold tracking-[0.14em] text-[var(--danger)] uppercase">
                    {llmProviderLabel(effectiveProvider)} can’t make embeddings
                  </span>
                </div>
                <p className="mt-2 text-[14px] leading-[1.55] text-muted">
                  {e.provider ? (
                    <><code>{llmProviderLabel(effectiveProvider)}</code> is a chat-only provider, with no embeddings endpoint, so the tagger can’t use it.</>
                  ) : (
                    <>Your DJ provider <code>{llmProviderLabel(llmProvider)}</code> is chat-only and has no embeddings endpoint.</>
                  )}{' '}
                  Pick a real embedding provider above. <strong>Ollama</strong> is local
                  and free (<code>nomic-embed-text</code>, auto-pulled on first run), or
                  use OpenAI / Google / locca. Your DJ stays on{' '}
                  <code>{llmProviderLabel(llmProvider)}</code>.
                </p>
              </div>
            )}
          </div>

          <div className="field">
            <Label>Model</Label>
            <div className="flex flex-wrap items-stretch gap-2 sm:flex-nowrap">
              {embedDiscovery.models.length > 0 ? (
                <ModelCombobox
                  models={embedDiscovery.models}
                  value={e.model}
                  onChange={v => setForm(f => ({ ...f, embedding: { ...f.embedding, model: v } }))}
                  // A blank field means "follow the provider default", so show that
                  // default rather than an empty "Select a model".
                  placeholder={effectiveModel ? `${effectiveModel} · default` : 'Select a model'}
                />
              ) : (
                <Input
                  value={e.model}
                  onChange={(ev: ChangeEvent<HTMLInputElement>) =>
                    setForm(f => ({ ...f, embedding: { ...f.embedding, model: ev.target.value } }))
                  }
                  placeholder={effectiveModel ? `${effectiveModel} · default` : 'model id'}
                  className="max-w-[360px]"
                />
              )}
              {embedDiscovery.loading
                ? <span className="animate-pulse text-[11px] whitespace-nowrap text-muted">discovering…</span>
                : embedDiscoveryEnabled && (
                  <Btn onClick={embedDiscovery.refresh} title="Refresh model list">↻</Btn>
                )
              }
            </div>
            <div className="field-hint">
              {embedDiscovery.models.length > 0
                ? `${embedDiscovery.models.length} model${embedDiscovery.models.length !== 1 ? 's' : ''} discovered. Keep the default${effectiveModel ? ` (${effectiveModel})` : ''} or pick another.`
                : !embedDiscoveryEnabled
                  ? (effectiveProvider === 'openai-compatible'
                      ? 'Set a base URL above to discover available models.'
                      : 'Set an API key above to discover and select a model.')
                  : embedDiscovery.error
                    ? `Discovery failed: ${embedDiscovery.error}. Type a model ID manually.`
                    : embedDiscovery.loading
                      ? 'Discovering models…'
                      : 'No models discovered. Type a model ID manually.'}
            </div>
            <div className="field-hint">
              Leave blank for the sensible default per provider. If you change
              this on a tagged library, the next run will reject the new dim.
              Hit <strong>Re-seed</strong> on the Library tab (or run{' '}
              <code>--reseed</code>) to drop and rebuild the vectors.
            </div>
            {embedSuggestions.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-muted">Suggested:</span>
                {embedSuggestions.map(s => (
                  <Btn
                    key={s.id}
                    sm
                    onClick={() =>
                      setForm(f => ({ ...f, embedding: { ...f.embedding, model: s.id } }))
                    }
                    title={`Use ${s.id} (${s.dim}-dim)`}
                  >
                    {s.id}
                    <span className="ml-1 text-muted">{s.dim}d</span>
                  </Btn>
                ))}
              </div>
            )}
          </div>

          {(effectiveProvider === 'openai-compatible' || effectiveProvider === 'locca') && (
            <div className="field">
              <Label>Embedding server base URL</Label>
              <Input
                value={e.providerBaseUrls[effectiveProvider] ?? ''}
                onChange={(ev: ChangeEvent<HTMLInputElement>) =>
                  setForm(f => ({ ...f, embedding: { ...f.embedding, providerBaseUrls: { ...f.embedding.providerBaseUrls, [effectiveProvider]: ev.target.value } } }))
                }
                placeholder="http://host.docker.internal:8090/v1"
                className="max-w-[360px]"
              />
              <div className="field-hint">
                Embeddings need a <strong>dedicated</strong> server: one
                llama.cpp / locca process can&apos;t serve both chat and
                embeddings.{' '}
                {effectiveProvider === 'locca' ? (
                  <>
                    Leave blank to use the locca embed server on its default port
                    (<code>http://host.docker.internal:8090/v1</code>). Start it
                    with <code>locca embed nomic</code>. Override only for a
                    non-default port or remote host.
                  </>
                ) : (
                  <>
                    Leave blank only if this server itself does embeddings;
                    otherwise run a separate embedding server (
                    <code>llama-server -m nomic-embed-text-v1.5.Q8_0.gguf --embeddings --pooling mean --port 8090</code>)
                    and point this at it, including the <code>/v1</code> suffix.
                  </>
                )}
                {' '}Must be reachable from the controller container. Use the host
                LAN/Tailscale IP or <code>host.docker.internal</code>, not{' '}
                <code>127.0.0.1</code>.
              </div>
            </div>
          )}

          {effectiveProvider === 'openai-compatible' && (
            <div className="field">
              <Label>Bearer token</Label>
              <Input
                type="password"
                autoComplete="off"
                value={compatEmbedKeyInput}
                onChange={(ev: ChangeEvent<HTMLInputElement>) => setCompatEmbedKeyInput(ev.target.value)}
                placeholder={
                  (data.values?.embedding as { apiKey?: string })?.apiKey === 'set'
                    ? '•••••• (on file)'
                    : 'Bearer token (optional)'
                }
                className="max-w-[360px]"
              />
              <div className="field-hint">
                Optional. Only needed when the embedding server requires bearer
                authentication. Saved to <code>settings.json</code>, takes effect
                on next save.
              </div>
            </div>
          )}

          {effectiveProvider === 'ollama' && (
            <div className="field">
              <Label>Embedding server URL</Label>
              <Input
                value={e.ollamaUrl}
                onChange={(ev: ChangeEvent<HTMLInputElement>) =>
                  setForm(f => ({ ...f, embedding: { ...f.embedding, ollamaUrl: ev.target.value } }))
                }
                placeholder="http://host.docker.internal:11434"
                className="max-w-[360px]"
              />
              <div className="field-hint">
                Leave blank to use the same Ollama server as chat (it serves
                embeddings too). Set this only to run embeddings against a
                different Ollama host.
              </div>
            </div>
          )}

          {/* embedKeyVar is undefined for ollama / openai-compatible / locca, which
              need no conventional key. The override only matters when embeddings run
              on a different provider than the DJ. */}
          {embedKeyVar && (
            <>
              <div className="field">
                <Label>Embedding API key override</Label>
                <Input
                  type="password"
                  autoComplete="off"
                  value={embeddingKeyInput}
                  placeholder={embedKeyPresent ? '•••••• (reusing your DJ key)' : `${embedKeyVar} — or set it in .env`}
                  onChange={(ev: ChangeEvent<HTMLInputElement>) => setEmbeddingKeyInput(ev.target.value)}
                  className="max-w-[360px]"
                />
                <div className="field-hint">
                  Optional. Embeddings reuse your DJ&rsquo;s <code>{embedKeyVar}</code> automatically;
                  only set this to run embeddings on a different provider than your DJ.
                  Stored in <code>state/secrets.env</code>.
                </div>
              </div>
              <KeyStatus envVar={embedKeyVar} present={embedKeyPresent} />
            </>
          )}

          <div className="field">
            <div className="flex flex-wrap items-center gap-2">
              {needsServerUrl && (
                <Btn sm onClick={detect} disabled={detecting || probing}>
                  {detecting
                    ? 'Detecting…'
                    : effectiveProvider === 'locca'
                      ? 'Detect locca server'
                      : 'Detect server'}
                </Btn>
              )}
              <Btn sm tone="accent" onClick={runProbe} disabled={probing || detecting}>
                {probing ? 'Testing…' : 'Test embeddings'}
              </Btn>
            </div>
            {probe && (
              <div
                role="status"
                className={cn(
                  'mt-2 max-w-[560px] rounded border bg-[var(--ink-softer)] px-3 py-2 text-[11px] leading-[1.6] whitespace-pre-wrap',
                  probe.ok
                    ? 'border-[var(--accent)] text-[color:var(--accent)]'
                    : 'border-[var(--danger)] text-[var(--danger)]',
                )}
              >
                {probe.ok
                  ? `✓ Producing embeddings${probe.dim ? ` (${probe.dim}-dim vectors)` : ''}, you're ready to tag.`
                  : `✗ ${probe.message}`}
              </div>
            )}
          </div>
        </div>
      </Card>

      {/* No run button: the bulk tagger is launched from the Library page's
          "Start tagging" flow. */}

      <Advanced note="seed count, propagation thresholds and enrichment">
      <Card title="Seed phase" sub="how many tracks to LLM-tag">
        <div className="grid gap-[18px]">
          <div className="field">
            <Label>Seed count</Label>
            <Input
              type="number"
              min={0}
              max={50000}
              value={e.seedCount}
              onChange={(ev: ChangeEvent<HTMLInputElement>) =>
                setForm(f => ({
                  ...f,
                  embedding: { ...f.embedding, seedCount: ev.target.value },
                }))
              }
              className="max-w-[180px]"
            />
            <div className="field-hint">
              How many tracks the LLM tags by hand before propagation kicks in.
              <code> 0</code> = auto: <code>~4% of the library</code> (floored at
              200, capped at 2500). For a 5k library that&apos;s 200; for 50k,
              2000. A denser seed set is often net-cheaper: more anchors means a
              smaller (expensive) active-learning residual. CLI{' '}
              <code>--seeds N</code> overrides this.
            </div>
          </div>
        </div>
      </Card>

      <Card title="Propagation" sub="KNN voting">
        <div className="grid gap-[18px]">
          <div className="field">
            <Label>KNN neighbours</Label>
            <Input
              type="number"
              min={1}
              max={50}
              value={e.knnNeighbours}
              onChange={(ev: ChangeEvent<HTMLInputElement>) =>
                setForm(f => ({
                  ...f,
                  embedding: { ...f.embedding, knnNeighbours: ev.target.value },
                }))
              }
              className="max-w-[180px]"
            />
            <div className="field-hint">
              How many nearest tagged neighbours vote on an untagged track&apos;s
              moods + energy. Default <code>10</code>, a broader, steadier vote
              than the old 5. Very high values dilute the vote on a sparsely-tagged
              library (coverage below counts against confidence).
            </div>
          </div>

          <div className="field">
            <Label>Mood vote threshold</Label>
            <Input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={e.moodVoteThreshold}
              onChange={(ev: ChangeEvent<HTMLInputElement>) =>
                setForm(f => ({
                  ...f,
                  embedding: { ...f.embedding, moodVoteThreshold: ev.target.value },
                }))
              }
              className="max-w-[180px]"
            />
            <div className="field-hint">
              Fraction of the total voting <em>weight</em> a mood must carry to
              propagate (neighbours vote weighted by similarity, so close matches
              count for more). Default <code>0.4</code>. Higher = stricter, fewer
              propagated tags; lower = looser, more drift.
            </div>
          </div>

          <div className="field">
            <Label>Confidence threshold</Label>
            <Input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={e.confidenceThreshold}
              onChange={(ev: ChangeEvent<HTMLInputElement>) =>
                setForm(f => ({
                  ...f,
                  embedding: { ...f.embedding, confidenceThreshold: ev.target.value },
                }))
              }
              className="max-w-[180px]"
            />
            <div className="field-hint">
              Minimum confidence for a propagated tag to be accepted; below it the
              track is queued for (pricier) LLM tagging. Confidence is{' '}
              <code>topSim × coverage</code>: the nearest tagged neighbour&apos;s
              similarity times the fraction of neighbours that were tagged. Being a
              product of two sub-1 numbers it compounds fast, so the default is{' '}
              <code>0.35</code>, not 0.6 (0.6 rejected even strong matches and sent
              most tracks to the LLM).
            </div>
          </div>

          <div className="field">
            <Label>Audio fusion weight</Label>
            <Input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={e.audioFusionWeight}
              onChange={(ev: ChangeEvent<HTMLInputElement>) =>
                setForm(f => ({
                  ...f,
                  embedding: { ...f.embedding, audioFusionWeight: ev.target.value },
                }))
              }
              className="max-w-[180px]"
            />
            <div className="field-hint">
              Lets tracks with a &ldquo;sounds-like&rdquo; (CLAP) vector pull
              audio-similar neighbours into the mood vote, scaled by this weight;
              sound is the stronger mood signal for instrumentals and tracks with
              thin metadata. <code>0</code> = text-only vote; <code>1</code> =
              trust audio similarity as much as text. Default <code>0.5</code>.
              Only applies where the acoustic analysis has produced audio vectors.
            </div>
          </div>

          <div className="field">
            <Label>Active-learning rounds</Label>
            <Input
              type="number"
              min={0}
              max={10}
              value={e.maxActiveLearningRounds}
              onChange={(ev: ChangeEvent<HTMLInputElement>) =>
                setForm(f => ({
                  ...f,
                  embedding: { ...f.embedding, maxActiveLearningRounds: ev.target.value },
                }))
              }
              className="max-w-[180px]"
            />
            <div className="field-hint">
              Max rounds of (LLM-tag the uncertain residual → re-propagate)
              after the first propagation pass. <code>0</code> skips active
              learning entirely. CLI <code>--max-rounds N</code> overrides
              this.
            </div>
          </div>
        </div>
      </Card>

      <Card title="Enrichment" sub="signals folded into the embedding text">
        <div className="grid gap-4">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-4">
            <div>
              <div className="text-[13px] font-bold">Last.fm tags</div>
              <div className="mt-0.5 max-w-[480px] text-[14px] leading-[1.5] text-muted">
                With a Last.fm API key configured (Scrobbling), crowd tags come
                straight from the Last.fm API and work on vanilla Navidrome.
                Without a key it falls back to Navidrome&apos;s{' '}
                <code>getArtistInfo2</code>, which only surfaces tags on a custom
                Navidrome, so leave off unless you have a key or that setup.
              </div>
            </div>
            <Seg
              accent
              value={e.enrichment.lastfmTags ? 'on' : 'off'}
              options={[
                { id: 'off', label: 'Off' },
                { id: 'on', label: 'On' },
              ]}
              onChange={v =>
                setForm(f => ({
                  ...f,
                  embedding: {
                    ...f.embedding,
                    enrichment: { ...f.embedding.enrichment, lastfmTags: v === 'on' },
                  },
                }))
              }
            />
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-4">
            <div>
              <div className="text-[13px] font-bold">Lyrics</div>
              <div className="mt-0.5 max-w-[480px] text-[14px] leading-[1.5] text-muted">
                Fetch a short lyric excerpt per track and fold it into the
                embedding text. Improves propagation quality on
                lyrically-driven tracks (folk, hip-hop, singer-songwriter);
                negligible effect on instrumentals.
              </div>
            </div>
            <Seg
              accent
              value={e.enrichment.lyrics ? 'on' : 'off'}
              options={[
                { id: 'off', label: 'Off' },
                { id: 'on', label: 'On' },
              ]}
              onChange={v =>
                setForm(f => ({
                  ...f,
                  embedding: {
                    ...f.embedding,
                    enrichment: { ...f.embedding.enrichment, lyrics: v === 'on' },
                  },
                }))
              }
            />
          </div>
        </div>
      </Card>
      </Advanced>

      <SaveBar
        note={`Saved values apply the next time the bulk tagger runs. Current run (if any) keeps its own snapshot.${
          savedEmbedding.provider || savedEmbedding.model
            ? ''
            : ' Provider/model defaults follow the LLM section.'
        }`}
        busy={busy}
        onSave={save}
        saveLabel="Save library tagger"
        errors={fieldErrors}
        ownedKeys={['embedding', 'audio']}
        // Both key boxes are component-local — the panel diffs FormState and
        // cannot see them, so a pasted key alone would leave the section
        // "clean" and unmount the very button that saves it.
        dirty={!!(embeddingKeyInput.trim() || compatEmbedKeyInput.trim())}
      />
    </>
  );
}
