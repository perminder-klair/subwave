'use client';

// Webhooks — /admin/webhooks. Outbound HTTP POSTs to operator-configured
// endpoints on station events. See controller/src/broadcast/webhooks.ts
// for the fan-out + the documented payload shapes.

import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { useAdminAuth } from '../../lib/adminAuth';
import { notify, errorMessage } from '../../lib/notify';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Card, Btn, Pill, Eyebrow, Toggle } from './ui';

interface Webhook {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  authHeader: string;       // 'set' sentinel from the server when a value is stored.
}

interface WebhooksResponse {
  events: string[];
  webhooks: Webhook[];
}

function clientMintId() {
  const b = crypto.getRandomValues(new Uint8Array(3));
  return 'wh_' + [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

function blank(events: string[]): Webhook {
  return {
    id: clientMintId(),
    url: '',
    events: events.slice(0, 1),
    enabled: true,
    authHeader: '',
  };
}

function valid(h: Webhook): boolean {
  if (!/^https?:\/\//.test(h.url.trim())) return false;
  if (h.url.trim().length > 500) return false;
  if (!h.events.length) return false;
  return true;
}

// ── Reference examples ──────────────────────────────────────────────────────
// Every payload below mirrors what broadcast/webhooks.ts actually POSTs. All
// carry `event` + `t` (ISO timestamp); the rest is event-specific. Kept inline
// so an operator can wire a relay without reading the controller source.

interface PayloadDoc {
  event: string;
  blurb: string;
  json: string;
}

const PAYLOADS: PayloadDoc[] = [
  {
    event: 'track.play',
    blurb: 'A track started. `source` is "auto" (the playlist), "ai" (picker agent) or "request"; `artist`/`album`/`requestedBy` may be null.',
    json: `{
  "event": "track.play",
  "t": "2026-06-02T19:04:12.880Z",
  "title": "Teardrop",
  "artist": "Massive Attack",
  "album": "Mezzanine",
  "source": "auto",
  "requestedBy": null
}`,
  },
  {
    event: 'dj.link',
    blurb: 'A between-track auto-DJ link (the light-ducked voice). The chattiest stream — most relays filter this one out.',
    json: `{
  "event": "dj.link",
  "t": "2026-06-02T19:07:55.020Z",
  "text": "That was Massive Attack — staying in the deep end for this next one."
}`,
  },
  {
    event: 'dj.say',
    blurb: 'A scheduled spoken segment (station ID, hourly time, weather). `kind` is the original announce kind.',
    json: `{
  "event": "dj.say",
  "t": "2026-06-02T20:00:01.300Z",
  "text": "You're locked into SUB/WAVE — eight o'clock.",
  "kind": "hourly-check"
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
    blurb: 'What the "Send test" button fires — ignores the event subscriptions so you can sanity-check a fresh hook.',
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
    title: 'Discord — “now playing” via a Cloudflare Worker',
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
    title: 'Home Assistant — pulse a light on every track',
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
    title: 'n8n / Pipedream — durable relay with retries',
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
      sub="reference — what each event sends, and how to wire it"
    >
      <div className="text-[12px] leading-[1.6] text-muted">
        Every payload is JSON, fire-and-forget, with <code>event</code> and an ISO <code>t</code> timestamp.
        Most targets want a different shape than sub-wave emits, so point hooks at a relay that reshapes
        the body — these examples do exactly that.
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
  const [events, setEvents] = useState<string[] | null>(null);
  const [hooks, setHooks] = useState<Webhook[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!hydrated || needsAuth) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await adminFetch('/webhooks');
        if (!r.ok) throw new Error(`failed (${r.status})`);
        const j = (await r.json()) as WebhooksResponse;
        if (cancelled) return;
        setEvents(j.events);
        setHooks(j.webhooks || []);
      } catch (e) {
        if (cancelled) return;
        setErr(errorMessage(e));
      }
    })();
    return () => { cancelled = true; };
  }, [hydrated, needsAuth, adminFetch]);

  const save = async (next: Webhook[]) => {
    setBusy(true);
    try {
      const r = await adminFetch('/webhooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhooks: next }),
      });
      const j = (await r.json().catch(() => ({}))) as { webhooks?: Webhook[]; error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      setHooks(j.webhooks || []);
      notify.ok('Webhooks saved.');
    } catch (e) {
      notify.err(`Save failed: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const fireTest = async (id: string) => {
    try {
      const r = await adminFetch(`/webhooks/${id}/test`, { method: 'POST' });
      if (!r.ok) throw new Error(`failed (${r.status})`);
      notify.ok('Test payload sent.');
    } catch (e) {
      notify.err(`Test failed: ${errorMessage(e)}`);
    }
  };

  if (err) {
    return (
      <div className="grid gap-4">
        <Card title="Webhooks"><div className="text-[13px] text-[var(--danger)]">controller error: {err}</div></Card>
      </div>
    );
  }
  if (!hooks || !events) {
    return (
      <div className="grid gap-4">
        <Card title="Webhooks"><div className="text-[13px] text-muted italic">loading…</div></Card>
      </div>
    );
  }

  const allValid = hooks.every(valid);

  return (
    <div className="grid gap-4">
      <section className="card">
        <div className="border-b border-ink p-4">
          <Eyebrow className="text-vermilion">webhooks</Eyebrow>
          <div className="mt-1.5 text-[22px] font-extrabold tracking-[-0.02em]">
            Pipe station events into other systems.
          </div>
          <div className="mt-1 text-[11px] leading-[1.6] text-muted">
            Each row POSTs a JSON event to <code>url</code> the moment it happens — no retry queue, no buffer.
            Best paired with a relay like a Cloudflare Worker or n8n. See
            <code> controller/src/routes/webhooks.ts </code> for the payload shapes.
          </div>
        </div>
        <div className="flex items-center gap-3 bg-[var(--ink-softer)] p-3.5">
          <span className="caption">{hooks.length} hook{hooks.length === 1 ? '' : 's'}</span>
          <span className="caption text-vermilion">
            {hooks.filter(h => h.enabled).length} enabled
          </span>
          <span className="ml-auto" />
          <Btn
            sm
            onClick={() => setHooks([...hooks, blank(events)])}
            disabled={hooks.length >= 16}
          >Add</Btn>
          <Btn
            sm
            tone="accent"
            onClick={() => save(hooks)}
            disabled={!allValid || busy}
          >{busy ? 'Saving…' : 'Save'}</Btn>
        </div>
      </section>

      {hooks.length === 0 && (
        <Card title="No webhooks yet">
          <div className="text-[12px] leading-[1.6] text-muted">
            Click <strong>Add</strong> above to wire your first one. Common targets: Discord webhooks (chat),
            n8n / Pipedream (relay + retry), Home Assistant (lights pulse on a track change).
          </div>
        </Card>
      )}

      {hooks.map((h, i) => {
        const update = (patch: Partial<Webhook>) => {
          const next = [...hooks];
          next[i] = { ...h, ...patch };
          setHooks(next);
        };
        const remove = () => setHooks(hooks.filter((_, j) => j !== i));
        const toggleEvent = (ev: string) => {
          const has = h.events.includes(ev);
          update({ events: has ? h.events.filter(e => e !== ev) : [...h.events, ev] });
        };
        return (
          <Card
            key={h.id}
            title={h.url || <span className="text-muted italic">(new webhook)</span>}
            right={
              <>
                <Pill tone={h.enabled ? 'accent' : 'default'} dot={h.enabled}>
                  {h.enabled ? 'enabled' : 'disabled'}
                </Pill>
                <Toggle on={h.enabled} onClick={() => update({ enabled: !h.enabled })} />
              </>
            }
          >
            <div className="grid gap-3">
              <div>
                <Label className="caption">URL</Label>
                <Input
                  value={h.url}
                  onChange={e => update({ url: e.target.value })}
                  placeholder="https://discord.com/api/webhooks/…"
                  spellCheck={false}
                />
              </div>
              <div>
                <Label className="caption">Authorization header (optional)</Label>
                <Input
                  value={h.authHeader === 'set' ? '' : h.authHeader}
                  placeholder={h.authHeader === 'set' ? '(stored — leave blank to keep)' : 'Bearer …'}
                  onChange={e => update({ authHeader: e.target.value })}
                  spellCheck={false}
                />
                <div className="mt-1 text-[10px] text-muted">
                  Sent verbatim as the <code>Authorization</code> header. Stored at rest in <code>settings.json</code>.
                </div>
              </div>
              <div>
                <Label className="caption">Events</Label>
                <div className="mt-1 flex flex-wrap gap-2">
                  {events.map(ev => {
                    const on = h.events.includes(ev);
                    return (
                      <Pill
                        key={ev}
                        tone={on ? 'accent' : 'default'}
                        dot={on}
                        onClick={() => toggleEvent(ev)}
                        className="cursor-pointer"
                      >
                        {ev}
                      </Pill>
                    );
                  })}
                </div>
              </div>
              <div className="mt-1 flex items-center gap-2">
                <Btn sm tone="accent" onClick={() => fireTest(h.id)} disabled={!h.url}>
                  Send test
                </Btn>
                <span className="ml-auto" />
                <Btn sm tone="danger" onClick={remove}>Remove</Btn>
              </div>
            </div>
          </Card>
        );
      })}

      <ExamplesSection />
    </div>
  );
}
