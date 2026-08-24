'use client';

// Webhooks. See controller/src/broadcast/webhooks.ts for the fan-out and the
// documented payload shapes.

import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Controller, useFieldArray } from 'react-hook-form';
import { z } from 'zod';
import { useAdminAuth } from '../../lib/adminAuth';
import { AdminResponseError, adminJson, useAdminMutation } from '../../lib/admin-query';
import { notify, errorMessage } from '../../lib/notify';
import { useZodForm, applyServerFieldErrors, fieldAria } from '@/lib/form';
import {
  webhooksSchema,
  WEBHOOKS_LIMIT,
  type WebhookEvent,
} from '@/lib/schemas.generated';
import { Input } from '../ui/input';
import { Field, FieldLabel, FieldDescription, FieldError } from '@/components/ui/field';
import { SkeletonRows } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Card, Btn, Pill, Eyebrow, Toggle } from './ui';
import {
  patchWebhooks,
  useSensitiveWebhooksMutation,
  useWebhooksQuery,
  type WebhooksResponse,
} from './operations-queries';

// The form owns the list; the patch shape the route accepts is wider.
const formSchema = z.object({ webhooks: webhooksSchema });
type FormValues = z.input<typeof formSchema>;
type SavedWebhooks = z.output<typeof formSchema>['webhooks'];
// A row as the FORM sees it. This is z.input, so `enabled` and `authHeader`
// are optional here — the schema .default()s them — even though blank() and
// every server response populate both.
type WebhookRow = FormValues['webhooks'][number];

function clientMintId() {
  const b = crypto.getRandomValues(new Uint8Array(3));
  return 'wh_' + [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

function blank(events: WebhookEvent[]): WebhookRow & { id: string } {
  return {
    id: clientMintId(),
    url: '',
    events: events.slice(0, 1),
    enabled: true,
    authHeader: '',
  };
}

// Every payload below mirrors what broadcast/webhooks.ts actually POSTs. All
// carry `event` + `t` (ISO timestamp); the rest is event-specific.

interface PayloadDoc {
  event: string;
  blurb: string;
  json: string;
}

const PAYLOADS: PayloadDoc[] = [
  {
    event: 'track.play',
    blurb: 'A track started. By default always delivered; enable “Gate track.play on listeners” below to skip when nobody is tuned in (fail-closed on unknown count). `sourceTrackId` is the id in your music backend (Subsonic/Navidrome), so a relay can resolve the exact library item without matching on artist+title — null when the track came through without one. `source` is a different thing: how it got queued — "auto" (the playlist), "ai" (picker agent) or "request". `artist`/`album`/`requestedBy` may be null; `listeners` is included when the gate is on.',
    json: `{
  "event": "track.play",
  "t": "2026-06-02T19:04:12.880Z",
  "title": "Teardrop",
  "artist": "Massive Attack",
  "album": "Mezzanine",
  "sourceTrackId": "4f2c1a9b8e3d",
  "source": "auto",
  "requestedBy": null,
  "listeners": 1
}`,
  },
  {
    event: 'dj.link',
    blurb: 'A between-track auto-DJ link (the light-ducked voice). The chattiest stream, so most relays filter this one out. Fires when the words reach the stream, not when the clip was handed to the mixer.',
    json: `{
  "event": "dj.link",
  "t": "2026-06-02T19:07:55.020Z",
  "text": "That was Massive Attack — staying in the deep end for this next one.",
  "kind": "link",
  "voiceId": "9f3a7c21b408",
  "channel": "intro",
  "durationMs": 6200,
  "airedAt": "2026-06-02T19:07:54.980Z",
  "estimated": false
}`,
  },
  {
    event: 'dj.say',
    blurb: 'A scheduled spoken segment (station ID, hourly time, weather). `kind` is the original announce kind.',
    json: `{
  "event": "dj.say",
  "t": "2026-06-02T20:00:01.300Z",
  "text": "You're locked into SUB/WAVE — eight o'clock.",
  "kind": "hourly-check",
  "voiceId": "1c88de40aa72",
  "channel": "say",
  "durationMs": 4100,
  "airedAt": "2026-06-02T20:00:01.260Z",
  "estimated": false
}`,
  },
  {
    event: 'voice.queued',
    blurb: 'Fired when the station commits to a spoken clip — before the queue wait, the mixer poll and the lead-in, so it lands ahead of the words. For consumers that must PREPARE for speech (hand back from a live call, close a reply gate, start a duck ramp) rather than react once it has started. `estimatedAirInMs` is a forecast, never a measurement, which is what `estimated: true` says here — `voice.start` is the truth, and the same `voiceId` pairs them. The head start is however long the wait happens to be: behind another segment it is many seconds, on an idle chain about a second.',
    json: `{
  "event": "voice.queued",
  "t": "2026-06-02T19:07:53.700Z",
  "voiceId": "9f3a7c21b408",
  "kind": "link",
  "channel": "intro",
  "text": "That was Massive Attack — staying in the deep end for this next one.",
  "durationMs": 6200,
  "estimatedAirInMs": 1300,
  "expectedAirAt": "2026-06-02T19:07:55.000Z",
  "estimated": true,
  "streamBufferSeconds": 22
}`,
  },
  {
    event: 'voice.start',
    blurb: 'The same speech as dj.say/dj.link, but as a window rather than a ping — subscribe to this pair when you need to know exactly WHEN the DJ is talking (ducking a companion app, syncing an overlay, honest timestamps in a chat relay). `airedAt` is the live edge; every listener is `streamBufferSeconds` behind it for their whole connection, so sync to `airedAt + streamBufferSeconds` for what people actually hear. `durationMs` is the clip’s measured length. `estimated: true` means the air time could not be measured (a mixer older than this feature) and the timestamps are omitted rather than guessed. Note `airedAt` is the first word — the ducking starts up to a second earlier, under the silent lead-in the mixer pushes ahead of every clip.',
    json: `{
  "event": "voice.start",
  "t": "2026-06-02T19:07:55.020Z",
  "voiceId": "9f3a7c21b408",
  "kind": "link",
  "channel": "intro",
  "text": "That was Massive Attack — staying in the deep end for this next one.",
  "durationMs": 6200,
  "airedAt": "2026-06-02T19:07:54.980Z",
  "endsAt": "2026-06-02T19:08:01.180Z",
  "estimated": false,
  "streamBufferSeconds": 22
}`,
  },
  {
    event: 'voice.end',
    blurb: 'The close of the window opened by voice.start — same `voiceId`, fired when the clip finishes. Derived from the measured duration, so it needs no second look at the mixer.',
    json: `{
  "event": "voice.end",
  "t": "2026-06-02T19:08:01.190Z",
  "voiceId": "9f3a7c21b408",
  "kind": "link",
  "channel": "intro",
  "durationMs": 6200,
  "airedAt": "2026-06-02T19:07:54.980Z",
  "endedAt": "2026-06-02T19:08:01.180Z",
  "estimated": false
}`,
  },
  {
    event: 'request.received',
    blurb: 'A listener submitted a request. `text` is their raw ask; the picker resolves it to a track separately.',
    json: `{
  "event": "request.received",
  "t": "2026-06-02T19:10:33.412Z",
  "requestedBy": "ada",
  "text": "something by Aphex Twin please"
}`,
  },
  {
    event: 'test',
    blurb: 'What the "Send test" button fires. It ignores the event subscriptions so you can sanity-check a fresh hook.',
    json: `{
  "event": "test",
  "t": "2026-06-02T19:00:00.000Z",
  "note": "sub-wave webhook test fire"
}`,
  },
];

interface RecipeDoc {
  title: string;
  blurb: ReactNode;
  lang: string;
  code: string;
}

const RECIPES: RecipeDoc[] = [
  {
    title: 'Discord: “now playing” via a Cloudflare Worker',
    blurb: <>Discord expects <code>{'{ content }'}</code>, not sub-wave&apos;s shape, so reshape in a tiny relay. Point a <code>track.play</code> hook at the Worker; it forwards a message to your Discord webhook.</>,
    lang: 'js',
    code: `export default {
  async fetch(req, env) {
    const e = await req.json();
    if (e.event !== 'track.play') return new Response('ok');
    await fetch(env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: \`🎵 **\${e.title}** — \${e.artist ?? 'unknown'}\`,
      }),
    });
    return new Response('ok');
  },
};`,
  },
  {
    title: 'Home Assistant: pulse a light on every track',
    blurb: <>HA webhook triggers accept any JSON. Subscribe <code>track.play</code> and set the hook URL to your HA webhook (<code>…/api/webhook/&lt;id&gt;</code>).</>,
    lang: 'yaml',
    code: `# automation
trigger:
  - platform: webhook
    webhook_id: subwave_track
    local_only: false
action:
  - service: light.turn_on
    target: { entity_id: light.studio }
    data: { flash: short }`,
  },
  {
    title: 'n8n / Pipedream: durable relay with retries',
    blurb: <>sub-wave fires once with no retry queue. When delivery matters, put a workflow in front: add a Webhook node, subscribe the events you need, and branch on the event name.</>,
    lang: 'text',
    code: `Webhook node  →  Switch on {{ $json.event }}
  ├─ track.play        → append row in a sheet / log
  ├─ request.received  → notify you in Slack
  └─ dj.say            → ignore`,
  },
];

function Fold({ summary, children, open }: { summary: ReactNode; children: ReactNode; open?: boolean }) {
  return (
    <details open={open} className="border border-separator-strong bg-bg">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2">
        <span className="caption">{summary}</span>
      </summary>
      <div className="px-3 pt-1 pb-3">{children}</div>
    </details>
  );
}

function ExamplesSection() {
  return (
    <Card
      title="Payloads & recipes"
      sub="reference: what each event sends, and how to wire it"
    >
      <div className="text-[12px] leading-[1.6] text-muted">
        Every payload is JSON, fire-and-forget, with <code>event</code> and an ISO <code>t</code> timestamp.
        Most targets want a different shape than sub-wave emits, so point hooks at a relay that reshapes
        the body. The examples below do exactly that.
      </div>

      <div className="caption mt-4 mb-1.5">Event payloads</div>
      <div className="grid gap-1.5">
        {PAYLOADS.map((p, i) => (
          <Fold key={p.event} summary={p.event} open={i === 0}>
            <div className="mb-2 text-[11px] leading-[1.6] text-muted">{p.blurb}</div>
            <pre className="term">{p.json}</pre>
          </Fold>
        ))}
      </div>

      <div className="caption mt-4 mb-1.5">Integration recipes</div>
      <div className="grid gap-1.5">
        {RECIPES.map(r => (
          <Fold key={r.title} summary={r.title}>
            <div className="mb-2 text-[11px] leading-[1.6] text-muted">{r.blurb}</div>
            <pre className="term">{r.code}</pre>
          </Fold>
        ))}
      </div>
    </Card>
  );
}

export default function WebhooksPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const webhooksQuery = useWebhooksQuery(adminFetch, hydrated && !needsAuth, 'always');
  const events = webhooksQuery.data?.events ?? null;
  const [trackPlayListenerGated, setTrackPlayListenerGated] = useState(false);
  const [busy, setBusy] = useState(false);

  const form = useZodForm(formSchema, { webhooks: [] });
  // keyName defaults to 'id' — which would CLOBBER our webhook's own `id`
  // field. Renaming RHF's internal key is mandatory here, not cosmetic.
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: 'webhooks',
    keyName: '_rhfKey',
  });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (
      loaded
      || !webhooksQuery.data
      || webhooksQuery.error
      || webhooksQuery.isFetching
    ) return;
    form.reset({ webhooks: webhooksQuery.data.webhooks });
    setTrackPlayListenerGated(!!webhooksQuery.data.trackPlayListenerGated);
    setLoaded(true);
  }, [
    form,
    loaded,
    webhooksQuery.data,
    webhooksQuery.error,
    webhooksQuery.isFetching,
  ]);

  const saveMutation = useSensitiveWebhooksMutation<SavedWebhooks[number]>(adminFetch);
  const gateMutation = useAdminMutation<Partial<WebhooksResponse>, boolean>({
    adminFetch,
    request: (next, fetcher) => adminJson<Partial<WebhooksResponse>>(fetcher, '/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackPlayListenerGated: next }),
    }),
    onDone: (receipt, _next, client) => {
      patchWebhooks(client, { trackPlayListenerGated: !!receipt.trackPlayListenerGated });
    },
    toastOnError: false,
  });

  const save = form.handleSubmit(async (values) => {
    setBusy(true);
    try {
      const j = await saveMutation.mutateAsync(values.webhooks);
      // Re-seed from the server response so redacted authHeaders come back as
      // the 'set' sentinel rather than the value we just sent.
      form.reset({ webhooks: j.webhooks || [] });
      notify.ok('Webhooks saved.');
    } catch (e) {
      if (e instanceof AdminResponseError) applyServerFieldErrors(form, e.body.fieldErrors);
      notify.err(`Save failed: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  });

  // The gate persists the moment it's flipped: it must not ride the hooks Save
  // button, which an invalid draft row would disable. Doesn't touch `hooks`, so
  // unsaved row edits survive a toggle.
  const saveGate = async (next: boolean) => {
    setBusy(true);
    try {
      const j = await gateMutation.mutateAsync(next);
      setTrackPlayListenerGated(!!j.trackPlayListenerGated);
      notify.ok(`track.play listener gate ${j.trackPlayListenerGated ? 'on' : 'off'}.`);
    } catch (e) {
      notify.err(`Save failed: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const fireTest = async (id: string) => {
    try {
      await adminJson(adminFetch, `/webhooks/${id}/test`, { method: 'POST' });
      notify.ok('Test payload sent.');
    } catch (e) {
      notify.err(`Test failed: ${errorMessage(e)}`);
    }
  };

  if (webhooksQuery.error && !loaded) {
    return (
      <div className="grid gap-4">
        <Card title="Webhooks"><ErrorState error={errorMessage(webhooksQuery.error)} /></Card>
      </div>
    );
  }
  if (!loaded || !events) {
    return (
      <div className="grid gap-4">
        <Card title="Webhooks"><SkeletonRows rows={3} /></Card>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <section className="card">
        <div className="border-b border-ink p-4">
          <Eyebrow className="text-vermilion">webhooks</Eyebrow>
          <div className="mt-1.5 text-[22px] font-extrabold tracking-[-0.02em]">
            Pipe station events into other systems.
          </div>
          <div className="mt-1 text-[11px] leading-[1.6] text-muted">
            Each row POSTs a JSON event to <code>url</code> the moment it happens. No retry queue, no buffer.
            Best paired with a relay like a Cloudflare Worker or n8n. See
            <code> controller/src/routes/webhooks.ts </code> for the payload shapes.
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 bg-[var(--ink-softer)] p-3.5">
          <span className="caption">{fields.length} hook{fields.length === 1 ? '' : 's'}</span>
          <span className="caption text-vermilion">
            {form.watch('webhooks').filter(h => h.enabled).length} enabled
          </span>
          <span className="ml-auto" />
          <Btn
            sm
            onClick={() => append(blank(events))}
            disabled={fields.length >= WEBHOOKS_LIMIT}
          >Add</Btn>
          <Btn
            sm
            tone="accent"
            onClick={save}
            disabled={!form.formState.isValid || busy}
          >{busy ? 'Saving…' : 'Save'}</Btn>
        </div>
      </section>

      <Card
        title="track.play delivery"
        right={
          <Toggle
            on={trackPlayListenerGated}
            onClick={() => saveGate(!trackPlayListenerGated)}
            disabled={busy}
            ariaLabel="Gate track.play on listener count"
          />
        }
      >
        <div className="text-[12px] leading-[1.6] text-muted">
          Gate <code>track.play</code> on listener count (off by default). When on, hooks only
          receive the event when at least one listener is tuned in — unknown or zero count is
          skipped silently, matching scrobble. The payload includes <code>listeners</code> when
          fired. Applies immediately — no Save needed.
        </div>
      </Card>

      {fields.length === 0 && (
        <Card title="No webhooks yet">
          <EmptyState
            title="No webhooks yet"
            description="Add one to push now-playing and station events out to other services."
            action={<Btn sm onClick={() => append(blank(events))}>Add webhook</Btn>}
          />
        </Card>
      )}

      {fields.map((f, i) => {
        const row = form.watch(`webhooks.${i}`);
        const rowErrors = form.formState.errors.webhooks?.[i];
        // `enabled` is optional in z.input because the schema defaults it to
        // true; blank() and the server response always set it, so the ?? here
        // just re-states that default rather than papering over a real gap.
        const enabled = row.enabled ?? true;
        // Keyed off _rhfKey, not the array index: reordering or removing a row
        // must not hand a different row the ids a screen reader is already
        // pointing at.
        const urlAria = fieldAria(`wh-url-${f._rhfKey}`, rowErrors?.url);
        const authAria = fieldAria(`wh-auth-${f._rhfKey}`, rowErrors?.authHeader, {
          hasDescription: true,
        });
        const eventsAria = fieldAria(`wh-events-${f._rhfKey}`, rowErrors?.events);
        const toggleEvent = (ev: WebhookEvent) => {
          const has = row.events.includes(ev);
          form.setValue(
            `webhooks.${i}.events`,
            has ? row.events.filter(e => e !== ev) : [...row.events, ev],
            { shouldValidate: true, shouldDirty: true },
          );
        };
        return (
          <Card
            key={f._rhfKey}
            /* A webhook URL is one long unbreakable token and `.card-head` is a
               flex row that doesn't wrap, so break inside the title instead. */
            title={
              row.url
                ? <span className="break-all">{row.url}</span>
                : <span className="text-muted italic">(new webhook)</span>
            }
            right={
              <>
                <Pill tone={enabled ? 'accent' : 'default'} dot={enabled}>
                  {enabled ? 'enabled' : 'disabled'}
                </Pill>
                <Toggle
                  on={enabled}
                  onClick={() => form.setValue(`webhooks.${i}.enabled`, !enabled, { shouldDirty: true })}
                  ariaLabel="Enable webhook"
                />
              </>
            }
          >
            <div className="grid gap-3">
              <Field data-invalid={urlAria.invalid}>
                <FieldLabel className="caption" {...urlAria.labelProps}>URL</FieldLabel>
                <Input
                  {...form.register(`webhooks.${i}.url`)}
                  {...urlAria.controlProps}
                  placeholder="https://discord.com/api/webhooks/…"
                  aria-label="Webhook URL"
                  spellCheck={false}
                />
                <FieldError
                  {...urlAria.errorProps}
                  errors={rowErrors?.url ? [rowErrors.url] : undefined}
                />
              </Field>

              <Field data-invalid={authAria.invalid}>
                <FieldLabel className="caption" {...authAria.labelProps}>
                  Authorization header (optional)
                </FieldLabel>
                {/* Controller, not register: the 'set' sentinel must RENDER as
                    blank while remaining the stored form value, so the display
                    value diverges from the field value. Spreading register()
                    and overriding value/onChange would strand RHF's own
                    onChange and make this a controlled input inside an
                    uncontrolled registration. */}
                <Controller
                  control={form.control}
                  name={`webhooks.${i}.authHeader`}
                  render={({ field }) => (
                    <Input
                      {...authAria.controlProps}
                      ref={field.ref}
                      name={field.name}
                      onBlur={field.onBlur}
                      value={field.value === 'set' ? '' : (field.value ?? '')}
                      onChange={e => field.onChange(e.target.value)}
                      placeholder={field.value === 'set' ? '(stored, leave blank to keep)' : 'Bearer …'}
                      aria-label="Authorization header"
                      spellCheck={false}
                      // Opaque secret, so `off` — the convention every other
                      // credential box in admin/ follows. Left at the browser
                      // default, a password manager reads this as the site's
                      // own login: it offers to fill it, and offers to UPDATE
                      // the saved password when the form submits.
                      autoComplete="off"
                    />
                  )}
                />
                <FieldDescription {...authAria.descriptionProps} className="mt-1 text-[10px]">
                  Sent verbatim as the <code>Authorization</code> header. Stored at rest in <code>settings.json</code>.
                </FieldDescription>
                <FieldError
                  {...authAria.errorProps}
                  errors={rowErrors?.authHeader ? [rowErrors.authHeader] : undefined}
                />
              </Field>

              {/* No single labelable control here, so the Field itself is the
                  named group (it already carries role="group") and each chip
                  reports its own on/off via aria-pressed. */}
              <Field data-invalid={eventsAria.invalid} {...eventsAria.groupProps}>
                <FieldLabel asChild className="caption" {...eventsAria.labelledByProps}>
                  <span>Events</span>
                </FieldLabel>
                <div className="mt-1 flex flex-wrap gap-2">
                  {events.map(ev => {
                    const on = row.events.includes(ev);
                    return (
                      <Pill
                        key={ev}
                        tone={on ? 'accent' : 'default'}
                        dot={on}
                        onClick={() => toggleEvent(ev)}
                        pressed={on}
                        // These pills are the event picker, so they need a
                        // thumb-sized target on a phone.
                        className="min-h-9 cursor-pointer sm:min-h-0"
                      >
                        {ev}
                      </Pill>
                    );
                  })}
                </div>
                <FieldError
                  {...eventsAria.errorProps}
                  errors={rowErrors?.events ? [rowErrors.events] : undefined}
                />
              </Field>

              <div className="mt-1 flex items-center gap-2">
                <Btn sm tone="accent" onClick={() => fireTest(row.id!)} disabled={!row.url}>
                  Send test
                </Btn>
                <span className="ml-auto" />
                <Btn sm tone="danger" onClick={() => remove(i)}>Remove</Btn>
              </div>
            </div>
          </Card>
        );
      })}

      <ExamplesSection />
    </div>
  );
}
