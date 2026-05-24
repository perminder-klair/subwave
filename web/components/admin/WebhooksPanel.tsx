'use client';

// Webhooks — /admin/webhooks. Outbound HTTP POSTs to operator-configured
// endpoints on station events. See controller/src/broadcast/webhooks.ts
// for the fan-out + the documented payload shapes.

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
    </div>
  );
}
