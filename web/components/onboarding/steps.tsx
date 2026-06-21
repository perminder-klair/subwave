'use client';

import { useState } from 'react';
import type { WizardController } from './useWizard';

// Tiny presentation primitives kept local to the wizard — avoids dragging the
// full admin UI library into a screen most operators see exactly once.

function StepHeader({ title, blurb }: { title: string; blurb: string }) {
  return (
    <div className="mb-5">
      <h2 className="text-xl font-semibold text-ink">{title}</h2>
      <p className="mt-1 text-sm text-ink/70">{blurb}</p>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium tracking-wide text-ink/60 uppercase">{label}</span>
      {children}
      {hint ? <span className="text-xs text-ink/50">{hint}</span> : null}
    </label>
  );
}

function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={
        'rounded border border-ink/30 bg-bg px-2 py-1.5 text-sm focus:border-ink focus:outline-none ' +
        (props.className || '')
      }
    />
  );
}

function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={
        'rounded border border-ink/30 bg-bg px-2 py-1.5 text-sm focus:border-ink focus:outline-none ' +
        (props.className || '')
      }
    />
  );
}

function TestPill({ result }: { result: { ok: boolean | null; msg?: string } }) {
  if (result.ok === null) return null;
  return (
    <div
      className={
        'mt-2 inline-block rounded px-2 py-0.5 text-xs ' +
        (result.ok ? 'bg-green-100 text-green-900' : 'bg-red-100 text-red-900')
      }
    >
      {result.ok ? '✓ ' : '✗ '}
      {result.msg || (result.ok ? 'connection ok' : 'connection failed')}
    </div>
  );
}

// ─── NAVIDROME ─────────────────────────────────────────────────────────────
export function NavidromeStep({ w }: { w: WizardController }) {
  const [busy, setBusy] = useState(false);
  const onTest = async () => {
    setBusy(true);
    await w.testNavidrome();
    setBusy(false);
  };
  return (
    <div>
      <StepHeader
        title="Connect Navidrome"
        blurb="SUB/WAVE plays from your Subsonic-compatible music library. Point it at your Navidrome and the AI DJ takes over."
      />
      <div className="grid gap-3">
        <Field label="Navidrome URL" hint="e.g. http://host.docker.internal:4533">
          <TextInput
            value={w.data.navidrome.url}
            placeholder="http://host.docker.internal:4533"
            onChange={e =>
              w.patch(d => ({ navidrome: { ...d.navidrome, url: e.target.value }, navidromeTest: { ok: null } }))
            }
          />
        </Field>
        <Field label="Username">
          <TextInput
            value={w.data.navidrome.user}
            autoComplete="username"
            onChange={e =>
              w.patch(d => ({ navidrome: { ...d.navidrome, user: e.target.value }, navidromeTest: { ok: null } }))
            }
          />
        </Field>
        <Field label="Password">
          <TextInput
            type="password"
            value={w.data.navidrome.pass}
            autoComplete="current-password"
            onChange={e =>
              w.patch(d => ({ navidrome: { ...d.navidrome, pass: e.target.value }, navidromeTest: { ok: null } }))
            }
          />
        </Field>
        <div>
          <button
            type="button"
            onClick={onTest}
            disabled={busy || !w.data.navidrome.url || !w.data.navidrome.user || !w.data.navidrome.pass}
            className="rounded border border-ink bg-ink px-3 py-1.5 text-xs font-medium tracking-wide text-bg uppercase hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? 'Testing…' : 'Test connection'}
          </button>
          <TestPill result={w.data.navidromeTest} />
        </div>
        <div className="rounded-md border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs text-ink/80">
          <strong>Music licensing:</strong> owning these files covers your own
          private listening, not <em>public</em> broadcast. If anyone but you
          can hear the stream, you&apos;re publicly performing copyrighted works
          and need the relevant licences (PRS&nbsp;+&nbsp;PPL in the UK,
          ASCAP/BMI&nbsp;+&nbsp;SoundExchange in the US) — or broadcast only
          content you&apos;re cleared to use (your own, Creative Commons,
          royalty-free, public domain). You are the broadcaster and are
          responsible for clearing these rights. Not legal advice.
        </div>
      </div>
    </div>
  );
}

// ─── LLM ───────────────────────────────────────────────────────────────────
const LLM_PROVIDERS = [
  { id: 'ollama', label: 'Ollama (local, no key)' },
  { id: 'locca', label: 'locca (local llama.cpp, no key)' },
  { id: 'anthropic', label: 'Anthropic Claude' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'google', label: 'Google Gemini' },
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'gateway', label: 'Vercel AI Gateway' },
  { id: 'openai-compatible', label: 'OpenAI-compatible (self-hosted)' },
];

export function LlmStep({ w }: { w: WizardController }) {
  const [busy, setBusy] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discovery, setDiscovery] = useState<
    { reachable: boolean; models: string[]; error?: string } | null
  >(null);
  const isOllama = w.data.llm.provider === 'ollama';
  const isLocca = w.data.llm.provider === 'locca';
  const isCustom = w.data.llm.provider === 'openai-compatible';
  const onTest = async () => {
    setBusy(true);
    await w.testLlm();
    setBusy(false);
  };
  const onDiscover = async () => {
    setDiscovering(true);
    setDiscovery(null);
    setDiscovery(await w.discoverLocca());
    setDiscovering(false);
  };
  return (
    <div>
      <StepHeader
        title="Pick a language model"
        blurb="The DJ talks between tracks. Ollama running on the host is the homelab default — no API key needed."
      />
      <div className="grid gap-3">
        <Field label="Provider">
          <Select
            value={w.data.llm.provider}
            onChange={e =>
              w.patch(d => ({ llm: { ...d.llm, provider: e.target.value }, llmTest: { ok: null } }))
            }
          >
            {LLM_PROVIDERS.map(p => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Model" hint="e.g. llama3.1:8b · claude-sonnet-4 · gpt-4o-mini">
          <TextInput
            value={w.data.llm.model}
            onChange={e => w.patch(d => ({ llm: { ...d.llm, model: e.target.value }, llmTest: { ok: null } }))}
          />
        </Field>
        {isOllama && (
          <Field label="Ollama URL" hint="Reachable from the controller container">
            <TextInput
              value={w.data.llm.ollamaUrl}
              onChange={e =>
                w.patch(d => ({ llm: { ...d.llm, ollamaUrl: e.target.value }, llmTest: { ok: null } }))
              }
            />
          </Field>
        )}
        {isCustom && (
          <Field label="Base URL" hint="e.g. http://localhost:8080/v1 (llama.cpp / vLLM / LM Studio)">
            <TextInput
              value={w.data.llm.baseUrl}
              onChange={e =>
                w.patch(d => ({ llm: { ...d.llm, baseUrl: e.target.value }, llmTest: { ok: null } }))
              }
            />
          </Field>
        )}
        {isLocca && (
          <Field
            label="Base URL"
            hint="Blank → http://host.docker.internal:8080/v1 (the locca server on the host)"
          >
            <TextInput
              value={w.data.llm.baseUrl}
              placeholder="http://host.docker.internal:8080/v1"
              onChange={e =>
                w.patch(d => ({ llm: { ...d.llm, baseUrl: e.target.value }, llmTest: { ok: null } }))
              }
            />
          </Field>
        )}
        {isLocca && (
          <div className="grid gap-2">
            <button
              type="button"
              onClick={onDiscover}
              disabled={discovering}
              className="w-fit rounded border border-ink px-3 py-1.5 text-xs font-medium tracking-wide uppercase hover:bg-ink hover:text-bg disabled:cursor-not-allowed disabled:opacity-40"
            >
              {discovering ? 'Detecting…' : 'Detect locca models'}
            </button>
            {discovery && !discovery.reachable && (
              <p className="text-xs text-amber-300">
                No locca server reachable{discovery.error ? ` (${discovery.error})` : ''}. Start one
                with <code>locca serve &lt;model&gt; --yes</code> on the host, then retry.
              </p>
            )}
            {discovery && discovery.reachable && discovery.models.length === 0 && (
              <p className="text-xs text-amber-300">locca is up but has no model loaded.</p>
            )}
            {discovery && discovery.reachable && discovery.models.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-ink/60">✓ locca detected — pick a model:</span>
                {discovery.models.map(id => (
                  <button
                    key={id}
                    type="button"
                    onClick={() =>
                      w.patch(d => ({ llm: { ...d.llm, model: id }, llmTest: { ok: null } }))
                    }
                    className={`rounded border px-2 py-1 text-xs ${
                      w.data.llm.model === id
                        ? 'border-ink bg-ink text-bg'
                        : 'border-ink/40 hover:border-ink'
                    }`}
                  >
                    {id}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {!isOllama && !isLocca && (
          <Field label="API key" hint="Stored in state/secrets.env (mode 0600), not in settings.json">
            <TextInput
              type="password"
              value={w.data.llm.apiKey}
              onChange={e =>
                w.patch(d => ({ llm: { ...d.llm, apiKey: e.target.value }, llmTest: { ok: null } }))
              }
            />
          </Field>
        )}
        <div>
          <button
            type="button"
            onClick={onTest}
            disabled={busy || !w.data.llm.model}
            className="rounded border border-ink bg-ink px-3 py-1.5 text-xs font-medium tracking-wide text-bg uppercase hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? 'Asking…' : 'Send a test prompt'}
          </button>
          <TestPill result={w.data.llmTest} />
        </div>
      </div>
    </div>
  );
}

// ─── TTS ───────────────────────────────────────────────────────────────────
export function TtsStep({ w }: { w: WizardController }) {
  const engine = w.data.tts.defaultEngine;
  const heavyPicked = engine === 'chatterbox' || engine === 'pocket-tts';
  const heavyEnabled = w.data.tts.heavyEnabled;
  return (
    <div>
      <StepHeader
        title="Choose a voice engine"
        blurb="Piper is the default — fast, local, decent. Kokoro is slower but more natural. Cloud routes through OpenAI or ElevenLabs."
      />
      <div className="grid gap-3">
        <Field label="Default engine">
          <Select
            value={w.data.tts.defaultEngine}
            onChange={e =>
              w.patch(d => ({
                tts: { ...d.tts, defaultEngine: e.target.value as typeof d.tts.defaultEngine },
              }))
            }
          >
            <option value="piper">Piper (fast, local)</option>
            <option value="kokoro">Kokoro (natural, local)</option>
            <option value="cloud">Cloud (OpenAI / ElevenLabs)</option>
            <option value="chatterbox">Chatterbox (voice cloning, sidecar)</option>
            <option value="pocket-tts">PocketTTS (multilingual, sidecar)</option>
          </Select>
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={heavyEnabled}
            onChange={e =>
              w.patch(d => ({ tts: { ...d.tts, heavyEnabled: e.target.checked } }))
            }
          />
          Enable Chatterbox + PocketTTS (tts-heavy sidecar, ~5–6 GB)
        </label>
        {heavyEnabled && (
          <div className="rounded-md border border-sky-400/40 bg-sky-400/10 px-3 py-2 text-sm text-sky-100">
            <strong>Heavy TTS enabled.</strong> The sidecar isn&apos;t started by default.
            On the machine running this stack, either:
            <ul className="mt-2 ml-5 list-disc space-y-1">
              <li>
                Add <code>COMPOSE_PROFILES=tts-heavy</code> to your <code>.env</code>, then run{' '}
                <code>docker compose up -d</code> — this enables it permanently.
              </li>
              <li>
                Or run <code>docker compose --profile tts-heavy up -d</code> for a one-off start.
              </li>
            </ul>
          </div>
        )}
        {heavyPicked && !heavyEnabled && (
          <div className="rounded-md border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-sm text-amber-200">
            <strong>Heads up:</strong> {engine === 'chatterbox' ? 'Chatterbox' : 'PocketTTS'} runs
            in the optional <code>tts-heavy</code> sidecar but you haven&apos;t enabled it above —
            this persona will silently fall back to Piper until the sidecar is started.
          </div>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={w.data.tts.cloud.enabled}
            onChange={e =>
              w.patch(d => ({
                tts: { ...d.tts, cloud: { ...d.tts.cloud, enabled: e.target.checked } },
              }))
            }
          />
          Enable cloud TTS as a fallback
        </label>
        {w.data.tts.cloud.enabled && (
          <>
            <Field label="Cloud TTS provider">
              <Select
                value={w.data.tts.cloud.provider}
                onChange={e =>
                  w.patch(d => ({
                    tts: { ...d.tts, cloud: { ...d.tts.cloud, provider: e.target.value } },
                  }))
                }
              >
                <option value="openai">OpenAI</option>
                <option value="elevenlabs">ElevenLabs</option>
              </Select>
            </Field>
            <Field label="API key">
              <TextInput
                type="password"
                value={w.data.tts.cloud.apiKey}
                onChange={e =>
                  w.patch(d => ({
                    tts: { ...d.tts, cloud: { ...d.tts.cloud, apiKey: e.target.value } },
                  }))
                }
              />
            </Field>
          </>
        )}
      </div>
    </div>
  );
}

// ─── DJ persona ────────────────────────────────────────────────────────────
export function DjStep({ w }: { w: WizardController }) {
  return (
    <div>
      <StepHeader
        title="DJ persona"
        blurb="The DJ's voice on air. Name your station and set your location for weather. Personality tuning lives in /admin/settings — keep this step short."
      />
      <div className="grid gap-3">
        <Field label="Station name">
          <TextInput
            value={w.data.dj.stationName}
            onChange={e => w.patch(d => ({ dj: { ...d.dj, stationName: e.target.value } }))}
          />
        </Field>
        <Field label="Location" hint="Used for weather + 'broadcasting from…' prompts">
          <TextInput
            value={w.data.dj.locationName}
            onChange={e => w.patch(d => ({ dj: { ...d.dj, locationName: e.target.value } }))}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Latitude" hint="-90 to 90">
            <TextInput
              inputMode="decimal"
              value={w.data.dj.lat}
              onChange={e => w.patch(d => ({ dj: { ...d.dj, lat: e.target.value } }))}
            />
          </Field>
          <Field label="Longitude" hint="-180 to 180">
            <TextInput
              inputMode="decimal"
              value={w.data.dj.lng}
              onChange={e => w.patch(d => ({ dj: { ...d.dj, lng: e.target.value } }))}
            />
          </Field>
        </div>
      </div>
    </div>
  );
}

// ─── REVIEW + SAVE ─────────────────────────────────────────────────────────
export function ReviewStep({
  w,
  onDone,
}: {
  w: WizardController;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const onSave = async () => {
    setBusy(true);
    setErr(null);
    const r = await w.save();
    if (r.ok) {
      onDone();
    } else {
      setErr(r.error || 'save failed');
      setBusy(false);
    }
  };
  const rows: Array<[string, string]> = [
    ['Navidrome', w.data.navidrome.url ? `${w.data.navidrome.user} @ ${w.data.navidrome.url}` : '— skipped —'],
    ['LLM', `${w.data.llm.provider} · ${w.data.llm.model}`],
    ['TTS', w.data.tts.defaultEngine + (w.data.tts.cloud.enabled ? ` (+ ${w.data.tts.cloud.provider})` : '')],
    ['Station', `${w.data.dj.stationName} — ${w.data.dj.locationName}`],
  ];
  return (
    <div>
      <StepHeader
        title="All set?"
        blurb="Review and save. Settings land in state/settings.json + state/setup-config.json; API keys land in state/secrets.env (mode 0600)."
      />
      <dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-2 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-ink/60">{k}</dt>
            <dd className="text-ink">{v}</dd>
          </div>
        ))}
      </dl>
      {err && <p className="mt-3 text-sm text-red-700">{err}</p>}
      <button
        type="button"
        onClick={onSave}
        disabled={busy}
        className="mt-5 rounded border border-ink bg-ink px-4 py-2 text-sm font-medium tracking-wide text-bg uppercase hover:opacity-90 disabled:opacity-40"
      >
        {busy ? 'Saving…' : 'Save and finish'}
      </button>
    </div>
  );
}
