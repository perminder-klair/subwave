'use client';

import { useRef, useState } from 'react';
import { z } from 'zod';
import { useController } from 'react-hook-form';
import { useZodForm, fieldAria } from '@/lib/form';
import { TextField, SelectField, SwitchField } from '@/lib/form-fields';
import {
  Field,
  FieldLabel,
  FieldError,
} from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  llmProbeSchema,
  navidromeProbeSchema,
  TTS_ENGINES,
  TTS_CLOUD_PROVIDERS,
  SETTINGS_STATION_NAME_MAX,
} from '@/lib/schemas.generated';
import type { WizardController, WizardData } from './useWizard';
import { ProviderSelector } from '../admin/llm/ProviderSelector';
import { ModelCombobox } from '../admin/llm/ModelCombobox';
import { PROVIDER_IDS } from '../admin/llm/providerMeta';
import { useModelDiscovery } from '@/hooks/useModelDiscovery';
import { LocationPicker } from '../LocationPicker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { V3Alert } from '@/components/ui/alert';

// Presentation primitives kept local to the wizard, so a screen most operators
// see once doesn't drag in the full admin UI library. Labels, fills and borders
// ride the theme tokens.

// Shared by the bare-span composite-control labels below (Provider/Model/
// Location — none of these are a single labelable input, so none of them use
// FieldLabel/htmlFor; see the comment at each site).
const WIZARD_LABEL_CLASS =
  'font-mono text-[11px] font-bold tracking-[0.18em] text-ink uppercase';

function StepHeader({ title, blurb }: { title: string; blurb: string }) {
  return (
    <div className="mb-5">
      <h2 className="font-display text-xl font-bold text-ink">{title}</h2>
      <p className="mt-1 text-sm text-muted">{blurb}</p>
    </div>
  );
}

function TestPill({ result }: { result: { ok: boolean | null; msg?: string } }) {
  if (result.ok === null) return null;
  return (
    <div
      role="status"
      className={
        'mt-2 inline-block border px-2 py-0.5 font-mono text-xs ' +
        (result.ok
          ? 'border-ink bg-accent-soft text-ink'
          : 'border-destructive text-destructive')
      }
    >
      {result.ok ? '✓ ' : '✗ '}
      {result.msg || (result.ok ? 'connection ok' : 'connection failed')}
    </div>
  );
}

function NextButton({ disabled }: { disabled: boolean }) {
  return (
    <div className="mt-2 flex justify-end">
      <Button type="submit" variant="solid" disabled={disabled}>
        Next →
      </Button>
    </div>
  );
}

// ─── NAVIDROME ────────────────────────────────────────────────────────────
//
// Skipping Navidrome mid-wizard is a supported path (useWizard.save() and
// routes/onboarding.ts both persist empty creds fine — the only thing that
// requires all three fields is the PROBE), so this step's own schema carries
// no format rules at all: Next stays enabled regardless of content. The
// stricter, shared navidromeProbeSchema gates only the Test button, with the
// exact rule the controller enforces server-side.
const navidromeStepSchema = z.object({
  url: z.string(),
  user: z.string(),
  pass: z.string(),
});

export function NavidromeStep({ w }: { w: WizardController }) {
  const [busy, setBusy] = useState(false);
  const form = useZodForm(navidromeStepSchema, { ...w.data.navidrome });
  const values = form.watch();
  const navParsed = navidromeProbeSchema.safeParse(values);
  // Typing lives in this step's own form now, not in `w.data`, so the old
  // "reset the pill on every keystroke" behaviour (every onChange used to
  // patch `navidromeTest: { ok: null }`) has to be reproduced locally: track
  // what was actually tested, and hide the pill once the live values drift
  // from it — otherwise a stale "connection ok" would survive an edit until
  // the next Next-submit.
  const testedRef = useRef<string | null>(null);
  const stale = testedRef.current !== JSON.stringify(values);

  const onTest = async () => {
    if (!navParsed.success) return;
    setBusy(true);
    testedRef.current = JSON.stringify(values);
    try {
      await w.testNavidrome(navParsed.data);
    } finally {
      setBusy(false);
    }
  };

  const onNext = form.handleSubmit(vals => {
    // patch() itself merges with the existing data — the callback returns
    // only the keys to overwrite, never the whole object back (that would
    // clobber this very update on the next render).
    w.patch({
      navidrome: vals,
      // Commit clears the pill only when the committed values differ from
      // whatever was last tested — an untouched, already-tested value keeps
      // its result across Next.
      ...(testedRef.current !== JSON.stringify(vals) ? { navidromeTest: { ok: null } } : {}),
    });
    w.next();
  });

  return (
    <form onSubmit={onNext} noValidate>
      <StepHeader
        title="Connect Navidrome"
        blurb="SUB/WAVE plays from your Subsonic-compatible music library. Point it at your Navidrome and the AI DJ takes over."
      />
      <div className="grid gap-3">
        <TextField
          control={form.control}
          name="url"
          label="Navidrome URL"
          placeholder="http://host.docker.internal:4533"
          description="e.g. http://host.docker.internal:4533"
        />
        <TextField
          control={form.control}
          name="user"
          label="Username"
          autoComplete="username"
          description="tip: a dedicated Navidrome user that can only access the libraries you want on air keeps audiobooks and seasonal collections off the stream"
        />
        <TextField
          control={form.control}
          name="pass"
          label="Password"
          type="password"
          autoComplete="current-password"
        />
        <div>
          <Button
            type="button"
            variant="solid"
            onClick={onTest}
            disabled={busy || !navParsed.success}
          >
            {busy ? 'Testing…' : 'Test connection'}
          </Button>
          <TestPill result={stale ? { ok: null } : w.data.navidromeTest} />
        </div>
        <V3Alert title="Music licensing">
          Owning these files covers your own private listening, not{' '}
          <em>public</em> broadcast. If anyone but you can hear the stream,
          you&apos;re publicly performing copyrighted works and need the
          relevant licences (PRS&nbsp;+&nbsp;PPL in the UK,
          ASCAP/BMI&nbsp;+&nbsp;SoundExchange in the US) — or broadcast only
          content you&apos;re cleared to use (your own, Creative Commons,
          royalty-free, public domain). You are the broadcaster and are
          responsible for clearing these rights. Not legal advice.
        </V3Alert>
        <NextButton disabled={!form.formState.isValid} />
      </div>
    </form>
  );
}

// ─── LLM ────────────────────────────────────────────────────────────────
//
// Provider list, labels and blurbs come from admin/llm/providerMeta so
// onboarding and the admin Settings tab never drift.
//
// llmProbeSchema can't be handed to useZodForm directly: it's rooted at
// `z.unknown()`, so there is no object shape for RHF to bind fields against.
// This step's schema is a real z.object whose superRefine calls llmProbeSchema
// to run the ACTUAL rule, so formState.isValid is exactly that schema's verdict
// in a shape RHF can use.
const llmStepSchema = z.object({
  provider: z.string(),
  model: z.string(),
  apiKey: z.string(),
  baseUrl: z.string(),
  ollamaUrl: z.string(),
}).superRefine((val, ctx) => {
  const r = llmProbeSchema.safeParse(val);
  if (!r.success) {
    for (const issue of r.error.issues) {
      ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
    }
  }
});

// The hosted DJ Brain is a preset over the openai-compatible provider, not a
// provider of its own: one click fills base URL + model, the operator pastes
// the token, and everything downstream (probe, save, admin) is the ordinary
// compat path. Voice comes later from admin → Settings → DJ Brain.
const DJ_BRAIN_BASE_URL = 'https://my.getsubwave.com/v1';
const DJ_BRAIN_MODEL = 'dj-brain';
const DJ_BRAIN_SIGNUP_URL = 'https://my.getsubwave.com/brain';

export function LlmStep({ w }: { w: WizardController }) {
  const [busy, setBusy] = useState(false);
  const form = useZodForm(llmStepSchema, {
    provider: w.data.llm.provider,
    model: w.data.llm.model,
    apiKey: w.data.llm.apiKey,
    baseUrl: w.data.llm.baseUrl,
    ollamaUrl: w.data.llm.ollamaUrl,
  });
  const control = form.control;

  const provider = String(form.watch('provider') ?? '');
  const baseUrl = String(form.watch('baseUrl') ?? '');
  const ollamaUrl = String(form.watch('ollamaUrl') ?? '');
  const isOllama = provider === 'ollama';
  const isLocca = provider === 'locca';
  const isCustom = provider === 'openai-compatible';
  const isDjBrain = isCustom && baseUrl.trim() === DJ_BRAIN_BASE_URL;

  const providerField = useController({ control, name: 'provider' });
  const useDjBrain = () => {
    form.setValue('provider', 'openai-compatible', { shouldValidate: true });
    form.setValue('baseUrl', DJ_BRAIN_BASE_URL, { shouldValidate: true });
    form.setValue('model', DJ_BRAIN_MODEL, { shouldValidate: true });
    form.setValue('ollamaUrl', '', { shouldValidate: true });
  };
  const modelField = useController({ control, name: 'model' });
  const modelAria = fieldAria('llm-model', modelField.fieldState.error);

  // Same staleness tracking as NavidromeStep — see its comment.
  const testedRef = useRef<string | null>(null);
  const liveValues = form.watch();
  const stale = testedRef.current !== JSON.stringify(liveValues);

  const onTest = async () => {
    setBusy(true);
    testedRef.current = JSON.stringify(liveValues);
    try {
      await w.testLlm(form.getValues() as unknown as WizardData['llm']);
    } finally {
      setBusy(false);
    }
  };

  // Enabled for the keyless-discoverable providers; cloud providers need their
  // key saved on the box first, so they fall back to free-typing the model id.
  const discoveryEnabled =
    isOllama || isLocca ||
    (isCustom && !!baseUrl.trim()) ||
    provider === 'openrouter';
  const discovery = useModelDiscovery({
    provider,
    baseUrl,
    ollamaUrl,
    enabled: discoveryEnabled,
    adminFetch: w.auth.adminFetch,
  });

  const onNext = form.handleSubmit(vals => {
    const v = vals as unknown as WizardData['llm'];
    w.patch({
      llm: v,
      ...(testedRef.current !== JSON.stringify(liveValues) ? { llmTest: { ok: null } } : {}),
    });
    w.next();
  });

  return (
    <form onSubmit={onNext} noValidate>
      <StepHeader
        title="Pick a language model"
        blurb="The DJ talks between tracks. Ollama running on the host is the homelab default — no API key needed."
      />
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3 border border-ink bg-accent-soft p-3">
          <div className="grid gap-0.5">
            <span className={WIZARD_LABEL_CLASS}>No model to run?</span>
            <span className="text-sm text-ink">
              SUB/WAVE DJ Brain is a hosted brain for this station — one key, from £5/month.{' '}
              <a href={DJ_BRAIN_SIGNUP_URL} target="_blank" rel="noreferrer" className="underline">Get a key</a>
              {isDjBrain ? ', then paste it below.' : '.'}
            </span>
          </div>
          <Button type="button" variant={isDjBrain ? 'solid' : 'outline'} onClick={useDjBrain} disabled={isDjBrain}>
            {isDjBrain ? '✓ Using DJ Brain' : 'Use DJ Brain'}
          </Button>
        </div>
        {/* Bare span, not FieldLabel: ProviderSelector renders its own
            role="radiogroup" aria-label, and a wrapping <label> around a
            radiogroup of buttons hijacks clicks. Raw useController (not
            SelectField) because ProviderSelector is a radio-card composite
            the shared select wrapper can't express — see lib/form-fields.tsx's
            header. */}
        <div className="flex flex-col gap-1">
          <span className={WIZARD_LABEL_CLASS}>Provider</span>
          <ProviderSelector
            value={providerField.field.value}
            providerIds={PROVIDER_IDS}
            keyAware={false}
            onChange={providerField.field.onChange}
          />
        </div>
        {isOllama && (
          <TextField
            control={control}
            name="ollamaUrl"
            label="Ollama URL"
            description="Reachable from the controller container"
          />
        )}
        {isCustom && (
          <TextField
            control={control}
            name="baseUrl"
            label="Base URL"
            description={isDjBrain ? 'The hosted DJ Brain proxy' : 'e.g. http://localhost:8080/v1 (llama.cpp / vLLM / LM Studio)'}
          />
        )}
        {isLocca && (
          <TextField
            control={control}
            name="baseUrl"
            label="Base URL"
            placeholder="http://host.docker.internal:8080/v1"
            description="Blank → http://host.docker.internal:8080/v1 (the locca server on the host)"
          />
        )}
        {!isOllama && !isLocca && (
          <TextField
            control={control}
            name="apiKey"
            label="API key"
            type="password"
            autoComplete="off"
            description={isDjBrain
              ? 'Your DJ Brain access token from my.getsubwave.com/brain — stored in settings.json'
              : isCustom
                ? 'Optional for most self-hosted servers — stored in settings.json'
                : 'Stored in state/secrets.env (mode 0600), not in settings.json'}
          />
        )}
        {/* Bare span, not FieldLabel: the combobox trigger is a <button>, and
            a wrapping <label> would hijack the click. Raw useController: the
            control itself swaps between ModelCombobox and a plain input
            depending on live discovery state — neither TextField nor a
            select wrapper can express that swap alone. */}
        <div className="flex flex-col gap-1">
          <span className={WIZARD_LABEL_CLASS}>Model</span>
          <div className="flex items-stretch gap-2">
            {discovery.models.length > 0 ? (
              <ModelCombobox
                models={discovery.models}
                value={modelField.field.value}
                onChange={modelField.field.onChange}
                placeholder="Select a model"
              />
            ) : (
              <Input
                {...modelAria.controlProps}
                aria-label="Model"
                value={modelField.field.value}
                onChange={e => modelField.field.onChange(e.target.value)}
                onBlur={modelField.field.onBlur}
                ref={modelField.field.ref}
                placeholder={isOllama ? 'glm-5.1:cloud' : (isCustom || isLocca) ? 'model filename or id' : 'e.g. claude-sonnet-4 · gpt-4o-mini'}
                className="max-w-[360px] flex-1"
              />
            )}
            {discovery.loading
              ? <span className="self-center text-xs whitespace-nowrap text-muted">discovering…</span>
              : discoveryEnabled && (
                <button
                  type="button"
                  onClick={discovery.refresh}
                  title="Refresh model list"
                  className="border border-ink px-2.5 text-sm text-ink hover:bg-ink hover:text-bg"
                >↻</button>
              )
            }
          </div>
          <span className="text-xs text-muted">
            {discovery.models.length > 0
              ? `${discovery.models.length} model${discovery.models.length !== 1 ? 's' : ''} discovered — pick one or filter.`
              : discoveryEnabled
                ? (discovery.error
                    ? `Discovery failed: ${discovery.error}. Type a model ID manually.`
                    : discovery.loading
                      ? 'Discovering models…'
                      : 'No models found yet — set the URL above, or type a model ID.')
                : 'Type the model ID. Discovery runs here once the API key is saved.'}
          </span>
          <FieldError {...modelAria.errorProps} errors={modelField.fieldState.error ? [modelField.fieldState.error] : undefined} />
        </div>
        <div>
          {/* The step's own resolver IS llmProbeSchema now, so formState.isValid
              is byte-for-byte the old inline `llmProbeSchema.safeParse(w.data.llm)`
              check — kept as the one gate for both this button and Next, per
              the migration brief ("pick one and delete the other"). */}
          <Button variant="solid" type="button" onClick={onTest} disabled={busy || !form.formState.isValid}>
            {busy ? 'Asking…' : 'Send a test prompt'}
          </Button>
          <TestPill result={stale ? { ok: null } : w.data.llmTest} />
        </div>
        <NextButton disabled={!form.formState.isValid} />
      </div>
    </form>
  );
}

// ─── TTS ──────────────────────────────────────────────────────────────────
const ttsStepSchema = z.object({
  defaultEngine: z.enum(TTS_ENGINES),
  heavyEnabled: z.boolean(),
  cloud: z.object({
    enabled: z.boolean(),
    provider: z.enum(TTS_CLOUD_PROVIDERS),
    apiKey: z.string(),
    model: z.string(),
    voice: z.string(),
  }),
});

const TTS_ENGINE_OPTIONS = [
  { value: 'piper', label: 'Piper (fast, local)' },
  { value: 'kokoro', label: 'Kokoro (natural, local)' },
  { value: 'cloud', label: 'Cloud (OpenAI / ElevenLabs / Fish Audio)' },
  { value: 'chatterbox', label: 'Chatterbox (voice cloning, sidecar)' },
  { value: 'pocket-tts', label: 'PocketTTS (multilingual, sidecar)' },
  { value: 'remote', label: 'Remote (your own server)' },
];

// Only the three cloud providers the wizard actually collects credentials
// for — TTS_CLOUD_PROVIDERS (imported) also lists 'openai-compatible', which
// this step doesn't offer a base-URL field for, so it stays off this list.
const TTS_CLOUD_PROVIDER_OPTIONS = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'elevenlabs', label: 'ElevenLabs' },
  { value: 'fish-audio', label: 'Fish Audio' },
];

export function TtsStep({ w }: { w: WizardController }) {
  // WizardData's cloud.provider is a plain `string` (it also has to hold
  // 'openai-compatible', which this step's own narrower enum below never
  // offers) — cast the seed once rather than widen the schema.
  const form = useZodForm(ttsStepSchema, { ...w.data.tts } as z.input<typeof ttsStepSchema>);
  const engine = form.watch('defaultEngine');
  const heavyEnabled = form.watch('heavyEnabled');
  const cloudEnabled = form.watch('cloud.enabled');
  const heavyPicked = engine === 'chatterbox' || engine === 'pocket-tts';

  // Side-effecting onChange (clears the credential, and for Fish Audio
  // pre-fills its model/voice defaults) — a raw useController, not
  // SelectField, per lib/form-fields.tsx's header.
  const cloudProviderField = useController({ control: form.control, name: 'cloud.provider' });
  const cloudProviderAria = fieldAria('tts-cloud-provider', cloudProviderField.fieldState.error);

  const onNext = form.handleSubmit(vals => {
    w.patch(d => ({ tts: { ...d.tts, ...vals } }));
    w.next();
  });

  return (
    <form onSubmit={onNext} noValidate>
      <StepHeader
        title="Choose a voice engine"
        blurb="Piper is the default — fast, local, decent. Kokoro is slower but more natural. Cloud routes through OpenAI, ElevenLabs, or Fish Audio."
      />
      <div className="grid gap-3">
        <SelectField
          control={form.control}
          name="defaultEngine"
          label="Default engine"
          options={TTS_ENGINE_OPTIONS}
        />
        <SwitchField
          control={form.control}
          name="heavyEnabled"
          label="Enable Chatterbox + PocketTTS (tts-heavy sidecar, ~5–6 GB)"
        />
        {heavyEnabled && (
          <V3Alert title="Heavy TTS enabled">
            The sidecar isn&apos;t started by default. On the machine running
            this stack, either:
            <ul className="mt-2 ml-5 list-disc space-y-1">
              <li>
                Add <code>COMPOSE_PROFILES=tts-heavy</code> to your <code>.env</code>, then run{' '}
                <code>docker compose up -d</code> — this enables it permanently.
              </li>
              <li>
                Or run <code>docker compose --profile tts-heavy up -d</code> for a one-off start.
              </li>
            </ul>
          </V3Alert>
        )}
        {heavyPicked && !heavyEnabled && (
          <V3Alert tone="error" title="Heads up">
            {engine === 'chatterbox' ? 'Chatterbox' : 'PocketTTS'} runs in the
            optional <code>tts-heavy</code> sidecar but you haven&apos;t enabled
            it above — this persona will silently fall back to Piper until the
            sidecar is started.
          </V3Alert>
        )}
        <SwitchField
          control={form.control}
          name="cloud.enabled"
          label="Enable cloud TTS as a fallback"
        />
        {cloudEnabled && (
          <>
            <Field data-invalid={cloudProviderAria.invalid || undefined}>
              <FieldLabel {...cloudProviderAria.labelProps}>Cloud TTS provider</FieldLabel>
              <Select
                value={cloudProviderField.field.value}
                onValueChange={(provider) => {
                  cloudProviderField.field.onChange(provider);
                  // Credentials are provider-specific: never carry a typed key
                  // across a selector change.
                  form.setValue('cloud.apiKey', '', { shouldValidate: true, shouldDirty: true });
                  if (provider === 'fish-audio') {
                    form.setValue('cloud.model', 's2.1-pro', { shouldValidate: true, shouldDirty: true });
                    form.setValue('cloud.voice', '', { shouldValidate: true, shouldDirty: true });
                  }
                }}
              >
                <SelectTrigger
                  {...cloudProviderAria.controlProps}
                  onBlur={cloudProviderField.field.onBlur}
                  ref={cloudProviderField.field.ref}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {TTS_CLOUD_PROVIDER_OPTIONS.map(o => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldError {...cloudProviderAria.errorProps} errors={cloudProviderField.fieldState.error ? [cloudProviderField.fieldState.error] : undefined} />
            </Field>
            <TextField
              control={form.control}
              name="cloud.apiKey"
              label="API key"
              type="password"
              autoComplete="off"
            />
            {form.watch('cloud.provider') === 'fish-audio' && (
              <>
                <TextField
                  control={form.control}
                  name="cloud.model"
                  label="Fish model id"
                  placeholder="s2.1-pro"
                  maxLength={100}
                />
                <TextField
                  control={form.control}
                  name="cloud.voice"
                  label="Fish voice reference id"
                  placeholder="Paste an account, public, or custom reference_id"
                  maxLength={100}
                />
                <p className="text-xs text-muted">
                  Account voice discovery is available after setup in Admin → Settings → TTS.
                </p>
              </>
            )}
          </>
        )}
        <NextButton disabled={!form.formState.isValid} />
      </div>
    </form>
  );
}

// ─── DJ PERSONA ─────────────────────────────────────────────────────────
const djStepSchema = z.object({
  stationName: z.string().max(
    SETTINGS_STATION_NAME_MAX,
    `station name must be ${SETTINGS_STATION_NAME_MAX} chars or fewer`,
  ),
  locationName: z.string(),
  lat: z.string(),
  lng: z.string(),
  timezone: z.string(),
});

export function DjStep({ w }: { w: WizardController }) {
  const form = useZodForm(djStepSchema, {
    stationName: w.data.dj.stationName,
    locationName: w.data.dj.locationName,
    lat: w.data.dj.lat,
    lng: w.data.dj.lng,
    timezone: w.data.dj.timezone,
  });
  const locationName = form.watch('locationName');
  const lat = form.watch('lat');
  const lng = form.watch('lng');
  const timezone = form.watch('timezone');

  const onNext = form.handleSubmit(vals => {
    // `frequency` isn't part of this step's schema (nothing here edits it),
    // so merge rather than replace — a plain overwrite would drop it.
    w.patch(d => ({ dj: { ...d.dj, ...vals } }));
    w.next();
  });

  return (
    <form onSubmit={onNext} noValidate>
      <StepHeader
        title="DJ persona"
        blurb="The DJ's voice on air. Name your station and set your location for weather. Personality tuning lives in /admin/settings — keep this step short."
      />
      <div className="grid gap-3">
        <TextField control={form.control} name="stationName" label="Station name" />
        {/* Bare span, not FieldLabel: the picker is a composite (three fields
            at once) that can't live inside one <label>, and it has no single
            RHF field name to bind a Controller to — read/write directly via
            watch()/setValue() instead. */}
        <div className="flex flex-col gap-1">
          <span className={WIZARD_LABEL_CLASS}>Location</span>
          <LocationPicker
            variant="onboarding"
            value={{ locationName, lat, lng }}
            onChange={next => {
              form.setValue('locationName', next.locationName, { shouldValidate: true, shouldDirty: true });
              form.setValue('lat', next.lat, { shouldValidate: true, shouldDirty: true });
              form.setValue('lng', next.lng, { shouldValidate: true, shouldDirty: true });
            }}
            onPick={r => {
              if (r.timezone) form.setValue('timezone', r.timezone, { shouldValidate: true, shouldDirty: true });
            }}
          />
          <span className="text-xs text-muted">
            Search a city — coordinates and timezone fill in automatically. Used for weather +
            “broadcasting from…” prompts.
          </span>
          {timezone ? (
            <span className="text-xs text-muted">
              Timezone: {timezone} (from your location)
            </span>
          ) : null}
        </div>
        <NextButton disabled={!form.formState.isValid} />
      </div>
    </form>
  );
}

// ─── REVIEW + SAVE ──────────────────────────────────────────────────────
// No fields of its own (a read-only summary of `data` plus one Save button),
// so nothing here to bind to react-hook-form.
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
            <dt className="text-muted">{k}</dt>
            <dd className="text-ink">{v}</dd>
          </div>
        ))}
      </dl>
      {/* POST /onboarding/save never emits fieldErrors — it's a hand-rolled
          try/catch (routes/onboarding.ts), not validateBody(schema), so there
          is no field-addressable channel here to route through
          applyServerFieldErrors. Confirmed by reading the route AND by curl:
          see verify-forms.py's `onboarding` check. Plain string display, same
          as before. */}
      {err && <p role="alert" className="mt-3 text-sm text-destructive">{err}</p>}
      <Button variant="solid" size="lg" className="mt-5" onClick={onSave} disabled={busy}>
        {busy ? 'Saving…' : 'Save and finish'}
      </Button>
    </div>
  );
}
