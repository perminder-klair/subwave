'use client';

import type { ChangeEvent } from 'react';
import { useEffect, useState } from 'react';
import { notify, errorMessage } from '../../../lib/notify';
import { useModelDiscovery } from '@/hooks/useModelDiscovery';
import { V3AlertDialog } from '../../ui/alert-dialog';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectGroup,
} from '../../ui/select';
import { Card, Btn, Pill, Seg } from '../ui';
import { ProviderSelector } from '../llm/ProviderSelector';
import { ModelCombobox } from '../llm/ModelCombobox';
import { LLM_ENV_VARS, llmProviderLabel } from '../llm/providerMeta';
import {
  SectionHeader, SaveBar, KeyStatus, KeyTestResult, KEY_HINTS,
  type SectionProps,
} from './shared';

// LLM provider descriptors, the cloud-key env-var map and the badge logic live
// in ./llm/providerMeta (imported above) — shared with the ProviderSelector card
// grid and, later, the onboarding wizard. Don't redefine them here.

interface LlmSectionProps extends SectionProps {
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  refresh: () => void;
}
export function LlmSection({ data, form, setForm, busy, saveSettings, adminFetch, refresh }: LlmSectionProps) {
  const [primaryKeyInput, setPrimaryKeyInput] = useState('');
  const [fallbackKeyInput, setFallbackKeyInput] = useState('');
  const [primaryKeyTest, setPrimaryKeyTest] = useState<{ ok: boolean; message: string; latencyMs: number } | null>(null);
  const [primaryKeyTesting, setPrimaryKeyTesting] = useState(false);
  const [fallbackKeyTest, setFallbackKeyTest] = useState<{ ok: boolean; message: string; latencyMs: number } | null>(null);
  const [fallbackKeyTesting, setFallbackKeyTesting] = useState(false);

  useEffect(() => { setPrimaryKeyInput(''); }, [form.llm.provider]);
  useEffect(() => { setFallbackKeyInput(''); }, [form.llm.fallback.provider]);
  useEffect(() => { setPrimaryKeyTest(null); }, [form.llm.provider]);
  useEffect(() => { setFallbackKeyTest(null); }, [form.llm.fallback.provider]);

  const [compatKeyInput, setCompatKeyInput] = useState('');
  const [compatFallbackKeyInput, setCompatFallbackKeyInput] = useState('');
  const [compatKeyTest, setCompatKeyTest] = useState<{ ok: boolean; message: string; latencyMs: number } | null>(null);
  const [compatFallbackKeyTest, setCompatFallbackKeyTest] = useState<{ ok: boolean; message: string; latencyMs: number } | null>(null);
  const [compatKeyTesting, setCompatKeyTesting] = useState(false);
  const [compatFallbackKeyTesting, setCompatFallbackKeyTesting] = useState(false);
  useEffect(() => { setCompatKeyInput(''); setCompatKeyTest(null); }, [form.llm.provider]);
  useEffect(() => { setCompatFallbackKeyInput(''); setCompatFallbackKeyTest(null); }, [form.llm.fallback.provider]);

  // Embeddings inherit settings.llm by default (embedding.provider === ''), so
  // switching the CHAT provider silently changes the EMBEDDING model too — which
  // invalidates an already-embedded library and breaks vector search until a
  // re-embed (#dimension-mismatch). When the library is embedded and embeddings
  // are inheriting, pin them to the index's actual model on a provider switch and
  // surface a notice so the operator understands what happened (and can opt to
  // re-embed on the new provider instead).
  const [embedPinNotice, setEmbedPinNotice] = useState<{ model: string; dim: number; newProvider: string } | null>(null);
  const changeLlmProvider = (v: string) => {
    if (v === form.llm.provider) return;
    const inheriting = (form.embedding.provider ?? '') === '';
    const meta = data.libraryStats?.embeddingMeta;
    const pin = inheriting && !!meta?.model;
    setForm(f => {
      if (!f) return f;
      const next = { ...f, llm: { ...f.llm, provider: v } };
      if (pin && meta) {
        // Stored as "provider:model" (e.g. "ollama:nomic-embed-text"); split on
        // the FIRST colon so ollama tags with their own colon (bge-m3:latest)
        // keep the tag intact in the model field.
        const i = meta.model.indexOf(':');
        const pinProvider = i > 0 ? meta.model.slice(0, i) : '';
        const pinModel = i > 0 ? meta.model.slice(i + 1) : meta.model;
        if (pinProvider) next.embedding = { ...f.embedding, provider: pinProvider, model: pinModel };
      }
      return next;
    });
    if (pin && meta) setEmbedPinNotice({ model: meta.model, dim: meta.dim, newProvider: v });
  };

  const primaryKeyVar = LLM_ENV_VARS[form.llm.provider];
  const primaryKeySet = !!(primaryKeyVar && data.env?.[primaryKeyVar]);

  const primaryDiscoveryEnabled =
    form.llm.provider === 'ollama'
    || form.llm.provider === 'locca'
    || (form.llm.provider === 'openai-compatible' && !!form.llm.baseUrl.trim())
    || (form.llm.provider === 'openrouter')
    || (!!primaryKeyVar && primaryKeySet);

  const primaryDiscovery = useModelDiscovery({
    provider: form.llm.provider,
    baseUrl: form.llm.baseUrl,
    ollamaUrl: form.llm.ollamaUrl,
    enabled: primaryDiscoveryEnabled,
    adminFetch,
  });

  const fallbackKeyVar = LLM_ENV_VARS[form.llm.fallback.provider];
  const fallbackKeySet = !!(fallbackKeyVar && data.env?.[fallbackKeyVar]);

  const fallbackDiscoveryEnabled =
    form.llm.fallback.enabled && (
      form.llm.fallback.provider === 'ollama'
      || form.llm.fallback.provider === 'locca'
      || (form.llm.fallback.provider === 'openai-compatible' && !!form.llm.fallback.baseUrl.trim())
      || (form.llm.fallback.provider === 'openrouter')
      || (!!fallbackKeyVar && fallbackKeySet)
    );

  const fallbackDiscovery = useModelDiscovery({
    provider: form.llm.fallback.provider,
    baseUrl: form.llm.fallback.baseUrl,
    ollamaUrl: form.llm.fallback.ollamaUrl,
    enabled: fallbackDiscoveryEnabled,
    adminFetch,
  });

  const saveKey = async (envVar: string, value: string): Promise<boolean> => {
    if (!value.trim()) return true;
    try {
      const r = await adminFetch('/settings/secrets', {
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

  const testKey = async (
    envVar: string,
    value: string,
    setTesting: (v: boolean) => void,
    setResult: (r: { ok: boolean; message: string; latencyMs: number } | null) => void,
    clearInput?: () => void,
  ) => {
    const hasTyped = !!value.trim();
    if (!hasTyped && !data.env?.[envVar]) return;
    setTesting(true);
    setResult(null);
    try {
      const r = await adminFetch('/settings/secrets/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: envVar, value: value.trim() }),
      });
      const j = await r.json() as { ok: boolean; message: string; latencyMs: number };
      setResult(j);
      if (j.ok && hasTyped) {
        const saved = await saveKey(envVar, value);
        if (saved) { notify.ok('Key verified and saved'); clearInput?.(); refresh(); }
      } else if (j.ok) {
        notify.ok('Key verified (on file)');
      }
    } catch (e) {
      setResult({ ok: false, message: errorMessage(e), latencyMs: 0 });
    } finally {
      setTesting(false);
    }
  };

  const testCompatKey = async (
    apiKey: string,
    baseUrl: string,
    model: string,
    setTesting: (v: boolean) => void,
    setResult: (r: { ok: boolean; message: string; latencyMs: number } | null) => void,
  ) => {
    if (!baseUrl.trim()) { setResult({ ok: false, message: 'Set a Base URL first', latencyMs: 0 }); return; }
    if (!model.trim()) { setResult({ ok: false, message: 'Set a Model first', latencyMs: 0 }); return; }
    setTesting(true);
    setResult(null);
    try {
      const r = await adminFetch('/settings/llm/probe-compat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKey.trim(), baseUrl: baseUrl.trim(), model: model.trim() }),
      });
      const j = await r.json() as { ok: boolean; message: string; latencyMs: number };
      setResult(j);
    } catch (e) {
      setResult({ ok: false, message: errorMessage(e), latencyMs: 0 });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    await saveSettings({
      llm: {
        provider: form.llm.provider,
        model: form.llm.model,
        ollamaUrl: form.llm.ollamaUrl,
        numCtx: form.llm.numCtx,
        repeatPenalty: form.llm.repeatPenalty,
        baseUrl: form.llm.baseUrl,
        reasoning: form.llm.reasoning,
        toolChoice: form.llm.toolChoice,
        pickerAgent: form.llm.pickerAgent,
        noRepeatWindow: form.llm.noRepeatWindow,
        requestWebResolve: form.llm.requestWebResolve,
        agentTimeoutMs: form.llm.agentTimeoutMs,
        pauseWhenEmpty: form.llm.pauseWhenEmpty,
        dailyTokenCap: form.llm.dailyTokenCap,
        budgetSoftPct: form.llm.budgetSoftPct,
        exemptRequests: form.llm.exemptRequests,
        maxOutputTokens: form.llm.maxOutputTokens,
        ...(form.llm.provider === 'openai-compatible' && compatKeyInput.trim()
          ? { apiKey: compatKeyInput.trim() }
          : {}),
        fallback: {
          enabled: form.llm.fallback.enabled,
          provider: form.llm.fallback.provider,
          model: form.llm.fallback.model,
          ollamaUrl: form.llm.fallback.ollamaUrl,
          numCtx: form.llm.fallback.numCtx,
          repeatPenalty: form.llm.fallback.repeatPenalty,
          baseUrl: form.llm.fallback.baseUrl,
          reasoning: form.llm.fallback.reasoning,
          ...(form.llm.fallback.provider === 'openai-compatible' && compatFallbackKeyInput.trim()
            ? { apiKey: compatFallbackKeyInput.trim() }
            : {}),
        },
      },
    });
    // Save API keys if typed — these go to secrets.env, not settings.json
    const primaryKeyVar = LLM_ENV_VARS[form.llm.provider];
    if (primaryKeyVar && primaryKeyInput.trim()) {
      const ok = await saveKey(primaryKeyVar, primaryKeyInput);
      if (ok) { notify.ok('API key saved'); setPrimaryKeyInput(''); refresh(); }
    }
    const fallbackKeyVar = LLM_ENV_VARS[form.llm.fallback.provider];
    if (fallbackKeyVar && fallbackKeyInput.trim()) {
      const ok = await saveKey(fallbackKeyVar, fallbackKeyInput);
      if (ok) { notify.ok('API key saved'); setFallbackKeyInput(''); refresh(); }
    }
    if (form.llm.provider === 'openai-compatible' && compatKeyInput.trim()) {
      setCompatKeyInput('');
    }
    if (form.llm.fallback.provider === 'openai-compatible' && compatFallbackKeyInput.trim()) {
      setCompatFallbackKeyInput('');
    }
  };

  const savedLlm = data.values?.llm || {};
  const activeLabel = data.llm?.active || '';
  const activeColon = activeLabel.indexOf(':');
  const activeProvider = activeColon > -1 ? activeLabel.slice(0, activeColon) : (savedLlm.provider || '');
  const activeModel = activeColon > -1 ? activeLabel.slice(activeColon + 1) : '';
  const llmDirty = form.llm.provider !== savedLlm.provider
    || (form.llm.model || '').trim() !== (savedLlm.model || '').trim();

  return (
    <>
      <SectionHeader
        eyebrow="llm provider"
        title="The model that writes scripts and picks tracks."
        sub="Ollama runs on the homelab box and needs no key; the cloud providers are opt-in. Switching here reroutes every LLM call, no redeploy."
        metrics={[{ n: String((data.llm?.providers || []).length), l: 'providers' }]}
        manualHref="/manual/llm"
      />

      <Card title="Provider" sub="active routing">
        <div className="grid gap-[18px]">
          <div className="flex items-start gap-2.5 border border-[var(--accent)] bg-[var(--ink-softer)] p-3">
            <span className="mt-1 size-1.5 flex-none rounded-full bg-vermilion" />
            <div className="grid min-w-0 gap-0.5">
              <span className="text-[11px] font-bold tracking-[0.12em] text-vermilion uppercase">
                Routing now · {llmProviderLabel(activeProvider)}
              </span>
              <span className="text-[11px] leading-[1.5] text-muted">
                {activeModel
                  ? <>Model <code>{activeModel}</code>, every LLM call goes here. {llmDirty ? 'Your edits below aren’t live until you Save.' : 'This is the saved, running config.'}</>
                  : <>No model is set for this provider yet.</>}
              </span>
            </div>
          </div>

          <div className="field">
            <div className="flex items-center gap-2">
              <Label>Provider</Label>
              {llmDirty && <Pill tone="accent" dot>unsaved</Pill>}
            </div>
            <ProviderSelector
              value={form.llm.provider}
              providerIds={data.llm?.providers || ['ollama']}
              env={data.env}
              onChange={changeLlmProvider}
            />
            <div className="field-hint">
              {llmDirty
                ? 'Provider changed. Hit "Save LLM provider" below to route every call here.'
                : 'The provider every LLM call routes through. Switching reroutes instantly on save, no redeploy.'}
            </div>
          </div>

          {form.llm.provider === 'ollama' && (
            <div className="field">
              <Label>Ollama server URL</Label>
              <Input
                value={form.llm.ollamaUrl}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setForm(f => ({ ...f, llm: { ...f.llm, ollamaUrl: e.target.value } }))
                }
                placeholder="http://localhost:11434"
                className="max-w-[360px]"
              />
              <div className="field-hint">
                Where the Ollama server runs. Leave blank for the default
                (<code>http://localhost:11434</code>).
              </div>
            </div>
          )}

          {form.llm.provider === 'ollama' && (
            <div className="field">
              <Label>Context window (num_ctx)</Label>
              <Input
                type="number"
                min={0}
                step={1024}
                value={form.llm.numCtx}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setForm(f => ({ ...f, llm: { ...f.llm, numCtx: Number(e.target.value) } }))
                }
                placeholder="16384"
                className="max-w-[200px]"
              />
              <div className="field-hint">
                Tokens of context for <strong>local</strong> Ollama models.
                Ollama&apos;s own default is 4096, which is too small for the DJ
                agent: the prompt gets truncated and the model fails to pick a
                track (the &ldquo;agent did not call the done tool&rdquo; error).
                16384 is a safe default for a 7&ndash;9B model on a 12GB GPU;
                raise it for reasoning models, lower it on tight VRAM. Set 0 to
                use Ollama&apos;s default. Ignored for <code>:cloud</code> models.
              </div>
            </div>
          )}

          {form.llm.provider === 'openai-compatible' && (
            <div className="field">
              <Label>Server base URL</Label>
              <Input
                value={form.llm.baseUrl}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setForm(f => ({ ...f, llm: { ...f.llm, baseUrl: e.target.value } }))
                }
                placeholder="http://192.168.1.101:8080/v1"
                className="max-w-[360px]"
              />
              <div className="field-hint">
                Any OpenAI-compatible server (llama.cpp, vLLM, LM Studio…),
                including the <code>/v1</code> suffix. Must be reachable from the
                controller container. Use the host’s LAN or Tailscale IP, not
                <code>127.0.0.1</code>.
              </div>
            </div>
          )}

          {form.llm.provider === 'openai-compatible' && (
            <>
              <div className="field">
                <Label>Bearer token</Label>
                <div className="flex items-stretch gap-2">
                  <Input
                    type="password"
                    value={compatKeyInput}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setCompatKeyInput(e.target.value)}
                    placeholder={(data.values?.llm as { keys?: Record<string, unknown> })?.keys?.['openai-compatible'] === 'set' ? '•••••• (on file)' : 'Bearer token (optional)'}
                    className="max-w-[360px]"
                  />
                  <Btn
                    onClick={() =>
                      testCompatKey(
                        compatKeyInput || '',
                        form.llm.baseUrl,
                        form.llm.model,
                        setCompatKeyTesting,
                        setCompatKeyTest,
                      )
                    }
                    disabled={compatKeyTesting || !form.llm.baseUrl.trim()}
                  >
                    {compatKeyTesting ? 'Testing…' : 'Test connection'}
                  </Btn>
                </div>
                <div className="field-hint">
                  Optional — only needed when the server requires bearer authentication.
                  Saved to <code>settings.json</code>, takes effect on next save.
                </div>
              </div>
              {compatKeyTest && <KeyTestResult result={compatKeyTest} />}
            </>
          )}

          {form.llm.provider === 'locca' && (
            <div className="field">
              <Label>locca server base URL</Label>
              <Input
                value={form.llm.baseUrl}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setForm(f => ({ ...f, llm: { ...f.llm, baseUrl: e.target.value } }))
                }
                placeholder="http://host.docker.internal:8080/v1"
                className="max-w-[360px]"
              />
              <div className="field-hint">
                Leave blank to use the locca server on the host
                (<code>http://host.docker.internal:8080/v1</code>). Override only
                for a non-default port or a remote host. Bring a model up with{' '}
                <code>locca serve &lt;model&gt; --yes</code>; the model id below is
                what locca reports at <code>/v1/models</code>.{' '}
                <a
                  href="https://github.com/perminder-klair/locca"
                  target="_blank"
                  rel="noreferrer"
                  className="font-bold text-vermilion underline decoration-[1.5px] underline-offset-2"
                >
                  locca on GitHub ↗
                </a>
              </div>
            </div>
          )}

          {(form.llm.provider === 'openai-compatible' || form.llm.provider === 'locca') && (
            <div className="field">
              <Label>Repetition penalty (repeat_penalty)</Label>
              <Input
                type="number"
                min={1}
                max={2}
                step={0.05}
                value={form.llm.repeatPenalty}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setForm(f => ({ ...f, llm: { ...f.llm, repeatPenalty: Number(e.target.value) } }))
                }
                placeholder="1.15"
                className="max-w-[200px]"
              />
              <div className="field-hint">
                Repetition penalty sent to the local server (llama.cpp, vLLM, LM
                Studio). llama.cpp&apos;s own default is <code>1.0</code> = OFF,
                which lets the track-picker agent run away repeating a token block
                and never finish a pick. <strong>1.15</strong> is a sane floor;
                raise toward 1.25 if a model still loops. Set <code>1.0</code> to
                disable (e.g. a vLLM server that rejects the{' '}
                <code>repeat_penalty</code> field — its name there is{' '}
                <code>repetition_penalty</code>).
              </div>
            </div>
          )}

          {LLM_ENV_VARS[form.llm.provider] && (() => {
            const keyVar = LLM_ENV_VARS[form.llm.provider]!;
            return (
              <>
                <div className="field">
                  <Label>{llmProviderLabel(form.llm.provider)} API key</Label>
                  <div className="flex items-stretch gap-2">
                    <Input
                      type="password"
                      value={primaryKeyInput}
                      placeholder={data.env?.[keyVar] ? '•••••• (on file)' : (KEY_HINTS[keyVar] ?? '')}
                      onChange={(e: ChangeEvent<HTMLInputElement>) => setPrimaryKeyInput(e.target.value)}
                      className="max-w-[360px]"
                    />
                    <Btn
                      onClick={() => testKey(keyVar, primaryKeyInput, setPrimaryKeyTesting, setPrimaryKeyTest, () => setPrimaryKeyInput(''))}
                      disabled={primaryKeyTesting || (!primaryKeyInput.trim() && !data.env?.[keyVar])}
                    >
                      {primaryKeyTesting ? 'Testing…' : 'Test key'}
                    </Btn>
                  </div>
                  <div className="field-hint">
                    Stored in <code>state/secrets.env</code>, takes effect immediately. Leave blank to keep the existing key.
                  </div>
                  {keyVar === 'OPENAI_API_KEY' && (
                    <div className="field-hint">
                      This key is shared across LLM and Cloud TTS.
                    </div>
                  )}
                </div>
                {primaryKeyTest && <KeyTestResult result={primaryKeyTest} />}
              </>
            );
          })()}

          <div className="field">
            <Label>Model</Label>
            <div className="flex items-stretch gap-2">
              {primaryDiscovery.models.length > 0 ? (
                <ModelCombobox
                  models={primaryDiscovery.models}
                  value={form.llm.model}
                  onChange={v => setForm(f => ({ ...f, llm: { ...f.llm, model: v } }))}
                  placeholder="Select a model"
                />
              ) : (
                <Input
                  value={form.llm.model}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    setForm(f => ({ ...f, llm: { ...f.llm, model: e.target.value } }))
                  }
                  disabled={!primaryDiscoveryEnabled && form.llm.provider !== 'ollama'}
                  placeholder={
                    !primaryDiscoveryEnabled
                      ? (form.llm.provider === 'openai-compatible' ? 'Set a base URL first' : 'Set an API key above to discover and select a model')
                      : form.llm.provider === 'ollama'
                        ? 'nemotron-3-super:cloud'
                        : form.llm.provider === 'deepseek'
                          ? 'deepseek-v4-flash'
                          : form.llm.provider === 'openai-compatible' || form.llm.provider === 'locca'
                            ? 'Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf'
                            : 'model id'
                  }
                  className="max-w-[360px]"
                />
              )}
              {primaryDiscovery.loading
                ? <span className="animate-pulse text-[11px] whitespace-nowrap text-muted">discovering…</span>
                : primaryDiscoveryEnabled && (
                  <Btn onClick={primaryDiscovery.refresh} title="Refresh model list">↻</Btn>
                )
              }
            </div>
            <div className="field-hint">
              {primaryDiscovery.models.length > 0
                ? `${primaryDiscovery.models.length} model${primaryDiscovery.models.length !== 1 ? 's' : ''} discovered. Pick one from the list.`
                : !primaryDiscoveryEnabled
                  ? (form.llm.provider === 'openai-compatible'
                      ? 'Set a base URL above to discover available models.'
                      : 'Set an API key above to discover and select a model.')
                  : primaryDiscovery.error
                    ? `Discovery failed: ${primaryDiscovery.error}. Type a model ID manually.`
                    : primaryDiscovery.loading
                      ? 'Discovering models…'
                      : 'No models discovered. Type a model ID manually.'}
            </div>
          </div>

          {primaryKeyVar && (
            <KeyStatus envVar={primaryKeyVar} present={!!data.env?.[primaryKeyVar]} />
          )}

          {form.llm.provider === 'openai-compatible' && (
            <div className="field">
              <Label>Forced tool calls</Label>
              <Seg
                accent
                value={form.llm.toolChoice === 'auto' ? 'auto' : 'required'}
                options={[
                  { id: 'required', label: 'Required' },
                  { id: 'auto', label: 'Auto' },
                ]}
                onChange={v => setForm(f => ({ ...f, llm: { ...f.llm, toolChoice: v } }))}
              />
              <div className="field-hint">
                How the picker forces the model to return a structured pick.
                <code>Required</code> (default) sends{' '}
                <code>tool_choice:&quot;required&quot;</code> — the reliable path for
                local models. Switch to <code>Auto</code> only if your server
                <strong> crashes</strong> on a tool call: some newer vLLM images
                (notably Intel/XPU builds) mishandle the guided-decoding backend
                that <code>required</code> engages, while <code>auto</code> never
                does. On <code>Auto</code> a capable model still calls the tool;
                misses fall back to the stateless picker.
              </div>
            </div>
          )}
        </div>
      </Card>

      <Card title="Fallback" sub="backup when the primary is offline">
        <div className="grid gap-[18px]">
          <div className="grid grid-cols-[1fr_auto] items-center gap-4">
            <div>
              <div className="text-[13px] font-bold">Use a backup LLM</div>
              <div className="mt-0.5 max-w-[480px] text-[11px] leading-[1.5] text-muted">
                When the primary host can&apos;t be reached (connection refused,
                DNS failure, timeout, e.g. a GPU box that&apos;s powered off), the
                call is retried once against this backup, then routes straight back
                to the primary on the next call. A primary that&apos;s up but busy
                (rate-limited or erroring) is <em>not</em> failed over. Heavy work
                like library tagging stays on the primary, so a smaller backup
                model is fine here.
              </div>
            </div>
            <Seg
              accent
              value={form.llm.fallback.enabled ? 'on' : 'off'}
              options={[
                { id: 'off', label: 'Off' },
                { id: 'on', label: 'On' },
              ]}
              onChange={v =>
                setForm(f => ({ ...f, llm: { ...f.llm, fallback: { ...f.llm.fallback, enabled: v === 'on' } } }))
              }
            />
          </div>

          {form.llm.fallback.enabled && (
            <>
              <div className="field">
                <Label>Backup provider</Label>
                <Select
                  value={form.llm.fallback.provider}
                  onValueChange={v =>
                    setForm(f => ({ ...f, llm: { ...f.llm, fallback: { ...f.llm.fallback, provider: v } } }))
                  }
                >
                  <SelectTrigger className="max-w-[360px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {(data.llm?.providers || ['ollama']).map(p => (
                        <SelectItem key={p} value={p}>{llmProviderLabel(p)}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <div className="field-hint">
                  The provider to fall back to. Can differ from the primary, e.g.
                  primary on a self-hosted box, backup on always-on Ollama.
                </div>
              </div>

              {form.llm.fallback.provider === 'ollama' && (
                <div className="field">
                  <Label>Backup Ollama server URL</Label>
                  <Input
                    value={form.llm.fallback.ollamaUrl}
                    onChange={(e: ChangeEvent<HTMLInputElement>) =>
                      setForm(f => ({ ...f, llm: { ...f.llm, fallback: { ...f.llm.fallback, ollamaUrl: e.target.value } } }))
                    }
                    placeholder="http://localhost:11434"
                    className="max-w-[360px]"
                  />
                  <div className="field-hint">
                    Where the backup Ollama server runs. Leave blank for the
                    default (<code>http://localhost:11434</code>).
                  </div>
                </div>
              )}

              {form.llm.fallback.provider === 'ollama' && (
                <div className="field">
                  <Label>Backup context window (num_ctx)</Label>
                  <Input
                    type="number"
                    min={0}
                    step={1024}
                    value={form.llm.fallback.numCtx}
                    onChange={(e: ChangeEvent<HTMLInputElement>) =>
                      setForm(f => ({ ...f, llm: { ...f.llm, fallback: { ...f.llm.fallback, numCtx: Number(e.target.value) } } }))
                    }
                    placeholder="16384"
                    className="max-w-[200px]"
                  />
                  <div className="field-hint">
                    Tokens of context for a <strong>local</strong> backup Ollama
                    model. Set 0 for Ollama&apos;s default. Ignored for
                    <code>:cloud</code> models.
                  </div>
                </div>
              )}

              {form.llm.fallback.provider === 'openai-compatible' && (
                <div className="field">
                  <Label>Backup server base URL</Label>
                  <Input
                    value={form.llm.fallback.baseUrl}
                    onChange={(e: ChangeEvent<HTMLInputElement>) =>
                      setForm(f => ({ ...f, llm: { ...f.llm, fallback: { ...f.llm.fallback, baseUrl: e.target.value } } }))
                    }
                    placeholder="http://192.168.1.101:8080/v1"
                    className="max-w-[360px]"
                  />
                  <div className="field-hint">
                    OpenAI-compatible server URL including the <code>/v1</code>
                    suffix, required for this provider.
                  </div>
                </div>
              )}

              {form.llm.fallback.provider === 'openai-compatible' && (
                <>
                  <div className="field">
                    <Label>Bearer token</Label>
                    <div className="flex items-stretch gap-2">
                      <Input
                        type="password"
                        value={compatFallbackKeyInput}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => setCompatFallbackKeyInput(e.target.value)}
                        placeholder={(data.values?.llm as { keys?: Record<string, unknown> })?.keys?.['openai-compatible'] === 'set' ? '•••••• (on file)' : 'Bearer token (optional)'}
                        className="max-w-[360px]"
                      />
                      <Btn
                        onClick={() =>
                          testCompatKey(
                            compatFallbackKeyInput || '',
                            form.llm.fallback.baseUrl,
                            form.llm.fallback.model,
                            setCompatFallbackKeyTesting,
                            setCompatFallbackKeyTest,
                          )
                        }
                        disabled={compatFallbackKeyTesting || !form.llm.fallback.baseUrl.trim()}
                      >
                        {compatFallbackKeyTesting ? 'Testing…' : 'Test connection'}
                      </Btn>
                    </div>
                    <div className="field-hint">
                      Optional — only needed when the backup server requires bearer
                      authentication. Saved to <code>settings.json</code>, takes effect on
                      next save.
                    </div>
                  </div>
                  {compatFallbackKeyTest && <KeyTestResult result={compatFallbackKeyTest} />}
                </>
              )}

              {(form.llm.fallback.provider === 'openai-compatible' || form.llm.fallback.provider === 'locca') && (
                <div className="field">
                  <Label>Repetition penalty (repeat_penalty)</Label>
                  <Input
                    type="number"
                    min={1}
                    max={2}
                    step={0.05}
                    value={form.llm.fallback.repeatPenalty}
                    onChange={(e: ChangeEvent<HTMLInputElement>) =>
                      setForm(f => ({ ...f, llm: { ...f.llm, fallback: { ...f.llm.fallback, repeatPenalty: Number(e.target.value) } } }))
                    }
                    placeholder="1.15"
                    className="max-w-[200px]"
                  />
                  <div className="field-hint">
                    Repetition penalty for the backup local server. <strong>1.15</strong>{' '}
                    is a sane floor (llama.cpp&apos;s own default is <code>1.0</code> =
                    off); set <code>1.0</code> to disable.
                  </div>
                </div>
              )}

              {LLM_ENV_VARS[form.llm.fallback.provider] && (() => {
                const keyVar = LLM_ENV_VARS[form.llm.fallback.provider]!;
                return (
                  <>
                    <div className="field">
                      <Label>{llmProviderLabel(form.llm.fallback.provider)} API key</Label>
                      <div className="flex items-stretch gap-2">
                        <Input
                          type="password"
                          value={fallbackKeyInput}
                          placeholder={data.env?.[keyVar] ? '•••••• (on file)' : (KEY_HINTS[keyVar] ?? '')}
                          onChange={(e: ChangeEvent<HTMLInputElement>) => setFallbackKeyInput(e.target.value)}
                          className="max-w-[360px]"
                        />
                        <Btn
                          onClick={() => testKey(keyVar, fallbackKeyInput, setFallbackKeyTesting, setFallbackKeyTest, () => setFallbackKeyInput(''))}
                          disabled={fallbackKeyTesting || (!fallbackKeyInput.trim() && !data.env?.[keyVar])}
                        >
                          {fallbackKeyTesting ? 'Testing…' : 'Test key'}
                        </Btn>
                      </div>
                      <div className="field-hint">
                        Stored in <code>state/secrets.env</code>, takes effect immediately. Leave blank to keep the existing key.
                      </div>
                    </div>
                    {fallbackKeyTest && <KeyTestResult result={fallbackKeyTest} />}
                  </>
                );
              })()}

              <div className="field">
                <Label>Backup model</Label>
                <div className="flex items-stretch gap-2">
                  {fallbackDiscovery.models.length > 0 ? (
                    <ModelCombobox
                      models={fallbackDiscovery.models}
                      value={form.llm.fallback.model}
                      onChange={v => setForm(f => ({ ...f, llm: { ...f.llm, fallback: { ...f.llm.fallback, model: v } } }))}
                      placeholder="Select a model"
                    />
                  ) : (
                    <Input
                      value={form.llm.fallback.model}
                      onChange={(e: ChangeEvent<HTMLInputElement>) =>
                        setForm(f => ({ ...f, llm: { ...f.llm, fallback: { ...f.llm.fallback, model: e.target.value } } }))
                      }
                      disabled={!fallbackDiscoveryEnabled && form.llm.fallback.provider !== 'ollama'}
                      placeholder={
                        !fallbackDiscoveryEnabled
                          ? (form.llm.fallback.provider === 'openai-compatible' ? 'Set a base URL first' : 'Set an API key above to discover and select a model')
                          : form.llm.fallback.provider === 'ollama'
                            ? 'llama3.2:3b'
                            : form.llm.fallback.provider === 'deepseek'
                              ? 'deepseek-chat'
                              : form.llm.fallback.provider === 'openai-compatible' || form.llm.fallback.provider === 'locca'
                                ? 'Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf'
                                : 'model id'
                      }
                      className="max-w-[360px]"
                    />
                  )}
                  {fallbackDiscovery.loading
                    ? <span className="animate-pulse text-[11px] whitespace-nowrap text-muted">discovering…</span>
                    : fallbackDiscoveryEnabled && (
                      <Btn onClick={fallbackDiscovery.refresh} title="Refresh model list">↻</Btn>
                    )
                  }
                </div>
                <div className="field-hint">
                  {fallbackDiscovery.models.length > 0
                    ? `${fallbackDiscovery.models.length} model${fallbackDiscovery.models.length !== 1 ? 's' : ''} discovered. Pick one from the list.`
                    : !fallbackDiscoveryEnabled
                      ? (form.llm.fallback.provider === 'openai-compatible'
                          ? 'Set a base URL above to discover available models.'
                          : 'Set an API key above to discover and select a model.')
                      : fallbackDiscovery.error
                        ? `Discovery failed: ${fallbackDiscovery.error}. Type a model ID manually.`
                        : fallbackDiscovery.loading
                          ? 'Discovering models…'
                          : 'No models discovered. Type a model ID manually.'}
                </div>
              </div>

              {fallbackKeyVar && (
                <KeyStatus envVar={fallbackKeyVar} present={!!data.env?.[fallbackKeyVar]} />
              )}

              <div className="grid grid-cols-[1fr_auto] items-center gap-4">
                <div>
                  <div className="text-[13px] font-bold">Backup chain-of-thought</div>
                  <div className="mt-0.5 max-w-[480px] text-[11px] leading-[1.5] text-muted">
                    Whether the backup model may emit a reasoning step. Off by
                    default, like the primary.
                  </div>
                </div>
                <Seg
                  accent
                  value={form.llm.fallback.reasoning ? 'on' : 'off'}
                  options={[
                    { id: 'off', label: 'Off' },
                    { id: 'on', label: 'On' },
                  ]}
                  onChange={v =>
                    setForm(f => ({ ...f, llm: { ...f.llm, fallback: { ...f.llm.fallback, reasoning: v === 'on' } } }))
                  }
                />
              </div>
            </>
          )}
        </div>
      </Card>

      <Card title="Reasoning" sub="thinking models">
        <div className="grid grid-cols-[1fr_auto] items-center gap-4">
          <div>
            <div className="text-[13px] font-bold">Chain-of-thought</div>
            <div className="mt-0.5 max-w-[480px] text-[11px] leading-[1.5] text-muted">
              When off, the picker tells the model to skip or minimize its
              internal thinking step. Wired across providers that expose a
              thinking knob: Ollama, openai-compatible (Qwen3), Gemini 2.5/3.x,
              OpenAI o-series and gpt-5, Claude (adaptive thinking) and DeepSeek
              V4. DJ scripts and structured picks are short, and an uncapped
              thought chain just balloons latency and cost. Leave off unless
              you&apos;re running a model that genuinely needs it. Note: on
              Claude and DeepSeek the picker always suppresses thinking for its
              structured/tool calls, since those APIs reject forced tool calls while
              thinking, so there this toggle affects only the free-text DJ
              lines.
            </div>
          </div>
          <Seg
            accent
            value={form.llm.reasoning ? 'on' : 'off'}
            options={[
              { id: 'off', label: 'Off' },
              { id: 'on', label: 'On' },
            ]}
            onChange={v => setForm(f => ({ ...f, llm: { ...f.llm, reasoning: v === 'on' } }))}
          />
        </div>

        <div className="field mt-4">
          <Label>Max response size (tokens)</Label>
          <Input
            type="number"
            min={0}
            max={8000}
            step={500}
            value={form.llm.maxOutputTokens}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setForm(f => ({ ...f, llm: { ...f.llm, maxOutputTokens: Math.min(8000, Math.max(0, Number(e.target.value))) } }))
            }
            placeholder="0"
            className="max-w-[200px]"
          />
          <div className="field-hint">
            Caps the tokens the model may generate per response &mdash; the size
            of each reply, not a daily total. <strong>0 = use the built-in
            defaults</strong> (the default). Set a value (500&ndash;8000) to
            shrink it: useful on a local model with a small context window, where
            an oversized response allowance crowds out the system prompt and tool
            list and risks truncation &mdash; especially with reasoning off, where
            replies are short anyway. Values between 1 and 499 round up to 500.
          </div>
        </div>
      </Card>

      <Card title="Next-track picker" sub="how the DJ chooses">
        <div className="grid grid-cols-[1fr_auto] items-center gap-4">
          <div>
            <div className="text-[13px] font-bold">Agentic picker</div>
            <div className="mt-0.5 max-w-[480px] text-[11px] leading-[1.5] text-muted">
              When on, the next-track picker is a tool-using agent that explores the library
              itself. Needs a model that handles multi-step tool calls well. Leave off for
              small local models &mdash; skill segments (weather, news, &hellip;) then also run as a
              single call instead of a tool loop.
            </div>
          </div>
          <Seg
            accent
            value={form.llm.pickerAgent ? 'agent' : 'pool'}
            options={[
              { id: 'pool', label: 'Candidate pool' },
              { id: 'agent', label: 'Agent' },
            ]}
            onChange={v => setForm(f => ({ ...f, llm: { ...f.llm, pickerAgent: v === 'agent' } }))}
          />
        </div>

        {form.llm.pickerAgent && (
          <div className="field mt-4">
            <Label>Agent deadline (seconds)</Label>
            <Input
              type="number"
              min={5}
              max={180}
              step={5}
              value={Math.round(form.llm.agentTimeoutMs / 1000)}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setForm(f => ({ ...f, llm: { ...f.llm, agentTimeoutMs: Number(e.target.value) * 1000 } }))
              }
              placeholder="45"
              className="max-w-[200px]"
            />
            <div className="field-hint">
              How long an agent pick or listener request may run before falling
              back to the stateless picker. Slow reasoning models often need
              20&ndash;40s per pick; lower it for snappier fallbacks on a fast
              model. 5&ndash;180s.
            </div>
          </div>
        )}

        {form.llm.pickerAgent && (
          <div className="mt-4 grid grid-cols-[1fr_auto] items-center gap-4">
            <div>
              <div className="text-[13px] font-bold">Resolve described requests via web</div>
              <div className="mt-0.5 max-w-[480px] text-[11px] leading-[1.5] text-muted">
                When on, a listener who <em>describes</em> a track instead of naming it
                (&ldquo;the song from the new Dune movie&rdquo;) gets it looked up on the
                web, then matched against your library. Needs a web-search provider
                configured under Web search; otherwise it has no effect.
              </div>
            </div>
            <Seg
              accent
              value={form.llm.requestWebResolve ? 'on' : 'off'}
              options={[
                { id: 'off', label: 'Off' },
                { id: 'on', label: 'On' },
              ]}
              onChange={v => setForm(f => ({ ...f, llm: { ...f.llm, requestWebResolve: v === 'on' } }))}
            />
          </div>
        )}

        <div className="field mt-4">
          <Label>No-repeat window (tracks)</Label>
          <Input
            type="number"
            min={0}
            max={290}
            step={10}
            value={form.llm.noRepeatWindow}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setForm(f => ({ ...f, llm: { ...f.llm, noRepeatWindow: Math.max(0, Number(e.target.value)) } }))
            }
            placeholder="100"
            className="max-w-[200px]"
          />
          <div className="field-hint">
            The last N <strong>distinct</strong> tracks can never be re-picked &mdash; a hard
            guard on both the agent and candidate-pool pickers, on top of the time-based
            window. Auto-scales down on a small library so it never blocks everything.
            {' '}<strong>0 = off</strong>. Listener requests stay exempt. 0&ndash;290.
          </div>
        </div>
      </Card>

      <Card title="Idle behaviour" sub="when no one's listening">
        <div className="grid grid-cols-[1fr_auto] items-center gap-4">
          <div>
            <div className="text-[13px] font-bold">Pause DJ when empty</div>
            <div className="mt-0.5 max-w-[480px] text-[11px] leading-[1.5] text-muted">
              When on, the DJ stops making LLM calls (track picks, links, station
              IDs, hourly checks, segments and listener requests) whenever Icecast
              reports zero listeners. The stream keeps playing from the auto
              playlist, and the DJ resumes the moment someone tunes back in.
            </div>
          </div>
          <Seg
            accent
            value={form.llm.pauseWhenEmpty ? 'on' : 'off'}
            options={[
              { id: 'off', label: 'Off' },
              { id: 'on', label: 'On' },
            ]}
            onChange={v => setForm(f => ({ ...f, llm: { ...f.llm, pauseWhenEmpty: v === 'on' } }))}
          />
        </div>
      </Card>

      <Card title="Daily token budget" sub="cap LLM spend per day">
        <div className="field">
          <Label>Daily token cap</Label>
          <Input
            type="number"
            min={0}
            step={10000}
            value={form.llm.dailyTokenCap}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setForm(f => ({ ...f, llm: { ...f.llm, dailyTokenCap: Math.max(0, Number(e.target.value)) } }))
            }
            placeholder="0"
            className="max-w-[200px]"
          />
          <div className="field-hint">
            Hard ceiling on tokens the DJ may spend per day (UTC), counted from
            the same usage stats as the token ticker. <strong>0 = unlimited</strong>
            {' '}(the default &mdash; leave it off for a free local model). When set,
            the DJ drops to the cheap picker and mutes optional segments as it
            nears the cap, then stops calling the model entirely and coasts on the
            auto playlist once it&rsquo;s hit &mdash; music never stops.
          </div>
        </div>

        {form.llm.dailyTokenCap > 0 && (
          <div className="field mt-4">
            <Label>Soft threshold (%)</Label>
            <Input
              type="number"
              min={0}
              max={100}
              step={5}
              value={form.llm.budgetSoftPct}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setForm(f => ({ ...f, llm: { ...f.llm, budgetSoftPct: Math.min(100, Math.max(0, Number(e.target.value))) } }))
              }
              placeholder="80"
              className="max-w-[200px]"
            />
            <div className="field-hint">
              At this percent of the cap the DJ enters the cheap tier: stateless
              pool picks, no links or station IDs, no weather/news/etc. 0 or 100
              disables the soft tier (straight to the hard cap).
            </div>
          </div>
        )}

        {form.llm.dailyTokenCap > 0 && (
          <div className="mt-4 grid grid-cols-[1fr_auto] items-center gap-4">
            <div>
              <div className="text-[13px] font-bold">Always answer requests</div>
              <div className="mt-0.5 max-w-[480px] text-[11px] leading-[1.5] text-muted">
                When on, listener requests are still answered by the AI DJ even
                over the cap &mdash; a human asked, so honour it. When off,
                requests over the cap fall back to plain library matching like
                everything else.
              </div>
            </div>
            <Seg
              accent
              value={form.llm.exemptRequests ? 'on' : 'off'}
              options={[
                { id: 'off', label: 'Off' },
                { id: 'on', label: 'On' },
              ]}
              onChange={v => setForm(f => ({ ...f, llm: { ...f.llm, exemptRequests: v === 'on' } }))}
            />
          </div>
        )}
      </Card>

      <SaveBar
        note={`Active model: ${data.llm?.active}. Applies to the next LLM call, no restart needed.`}
        busy={busy}
        onSave={save}
        saveLabel="Save LLM provider"
      />

      {/* Chat-provider switch would otherwise drag the inherited embedding model
          with it and invalidate the already-embedded library. We pinned
          embeddings to the index's model; this notice explains it and lets the
          operator instead opt to re-embed on the new provider. The SAFE outcome
          (keep the pin) is the default — only the explicit confirm switches. */}
      <V3AlertDialog
        open={embedPinNotice != null}
        onOpenChange={(o) => { if (!o) setEmbedPinNotice(null); }}
        title="Embeddings kept on your library's model"
        description={embedPinNotice ? (
          <>
            Your library is embedded with <code>{embedPinNotice.model}</code> ({embedPinNotice.dim}-d
            vectors). Embeddings were following the chat provider, so switching to{' '}
            <strong>{llmProviderLabel(embedPinNotice.newProvider)}</strong> would have changed the
            embedding model too — and a different model produces incompatible vectors, breaking
            library / vibe search until you re-embed every track.
            {' '}To keep search working, embeddings are now <strong>pinned</strong> to{' '}
            <code>{embedPinNotice.model}</code> (Library tagger → Embedding). Switch embeddings to
            the new provider instead? You’ll need to re-embed the whole library afterwards.
          </>
        ) : ''}
        confirmLabel="switch embeddings too"
        cancelLabel="keep pinned"
        danger
        onConfirm={() => {
          setForm(f => (f ? { ...f, embedding: { ...f.embedding, provider: '', model: '' } } : f));
          setEmbedPinNotice(null);
        }}
      />
    </>
  );
}
