'use client';

// Skills editor — /admin/skills. The autonomous DJ segments (weather, news,
// traffic, random facts) the station can fire between tracks.
//
// Each skill is toggled on/off station-wide here. A skill only fires
// autonomously when it is enabled here AND assigned to the persona on air
// (see /admin/personas). "Run now" is an operator override — it fires the
// segment immediately, bypassing the enable toggle, the persona assignment,
// the frequency gate, and the cooldown.
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { notify, errorMessage } from '../../lib/notify';
import { useAdminAuth } from '../../lib/adminAuth';
import { Card, Btn, Pill, Eyebrow, Toggle } from './ui';
import { V3Alert } from '../ui/alert';

interface Skill {
  name: string;
  label?: string;
  kind?: string;
  description?: string;
  enabled?: boolean;
  ready?: boolean;
  requiresKey?: string;
  keyUrl?: string;
  cooldownMs?: number;
  custom?: boolean;
}

interface SkillsResponse {
  skills?: Skill[];
}

interface SkillToggleResponse {
  skills?: Skill[];
  error?: string;
}

interface SkillRunResponse {
  spoken?: string;
  error?: string;
}

function cooldownLabel(ms?: number): string {
  if (!ms) return 'no cooldown';
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min cooldown`;
  const h = Math.round(min / 6) / 10;
  return `${h} h cooldown`;
}

interface SkillDescriptionProps {
  text?: string;
  keyUrl?: string;
}

// Renders a skill description, turning the "<Provider> API key" phrase into a
// link to where that key is issued (skill.keyUrl). Plain text when no keyUrl.
function SkillDescription({ text, keyUrl }: SkillDescriptionProps): ReactNode {
  const desc = text || 'No description.';
  const m = keyUrl ? desc.match(/[A-Z][\w-]* API key/) : null;
  if (!m || m.index == null) return desc;
  return (
    <>
      {desc.slice(0, m.index)}
      <a
        href={keyUrl}
        target="_blank"
        rel="noreferrer"
        className="font-bold text-vermilion underline decoration-[1.5px] underline-offset-2"
      >
        {m[0]}
      </a>
      {desc.slice(m.index + m[0].length)}
    </>
  );
}

export default function SkillsPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);   // skill name currently mutating, or null
  const [rescanning, setRescanning] = useState(false);

  useEffect(() => {
    if (!hydrated || needsAuth) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await adminFetch('/dj/skills');
        if (!r.ok) throw new Error(`failed (${r.status})`);
        const j = (await r.json()) as SkillsResponse;
        if (cancelled) return;
        setSkills(Array.isArray(j.skills) ? j.skills : []);
        setErr(null);
      } catch (e) {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [hydrated, needsAuth, adminFetch]);

  const toggle = async (name: string, on: boolean) => {
    setBusy(name);
    try {
      const r = await adminFetch('/dj/skill-toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, on }),
      });
      const j = (await r.json().catch(() => ({}))) as SkillToggleResponse;
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      if (Array.isArray(j.skills)) setSkills(j.skills);
    } catch (e) {
      notify.err(`Toggle failed: ${errorMessage(e)}`);
    } finally { setBusy(null); }
  };

  const rescan = async () => {
    setRescanning(true);
    try {
      const r = await adminFetch('/dj/skills/rescan', { method: 'POST' });
      const j = (await r.json().catch(() => ({}))) as SkillToggleResponse & { custom?: number };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      if (Array.isArray(j.skills)) setSkills(j.skills);
      notify.ok(`Rescanned — ${j.custom ?? 0} custom skill${j.custom === 1 ? '' : 's'} loaded`);
    } catch (e) {
      notify.err(`Rescan failed: ${errorMessage(e)}`);
    } finally { setRescanning(false); }
  };

  const runNow = async (name: string) => {
    setBusy(name);
    try {
      const r = await adminFetch('/dj/skill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const j = (await r.json().catch(() => ({}))) as SkillRunResponse;
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      notify.ok(j.spoken ? `On air: “${j.spoken}”` : `${name} fired`);
    } catch (e) {
      notify.err(`Run failed: ${errorMessage(e)}`);
    } finally { setBusy(null); }
  };

  if (err) {
    return (
      <div className="grid gap-4">
        <Card title="Skills">
          <div className="text-[13px] text-[var(--danger)]">controller error: {err}</div>
        </Card>
      </div>
    );
  }
  if (!skills) {
    return (
      <div className="grid gap-4">
        <Card title="Skills">
          <div className="text-[13px] text-muted italic">loading…</div>
        </Card>
      </div>
    );
  }

  const enabledCount = skills.filter(s => s.enabled).length;

  return (
    <div className="grid gap-4">
      {/* ── HERO ─────────────────────────────────────────────────────────── */}
      <section className="card">
        <div className="border-b border-ink p-4">
          <Eyebrow className="text-vermilion">skills</Eyebrow>
          <div className="mt-1.5 text-[22px] font-extrabold tracking-[-0.02em]">
            What the DJ does between tracks.
          </div>
          <div className="mt-1 text-[11px] leading-[1.6] text-muted">
            Each skill is an autonomous segment. A skill fires only when it is enabled here
            <strong> and</strong> assigned to the persona on air — set per-persona assignments
            on the Personas page. “Run now” is an operator override and ignores both.
          </div>
          <div className="mt-1 text-[11px] leading-[1.6] text-muted">
            Drop your own skills into <code>state/skills/&lt;name&gt;/SKILL.md</code> and hit
            <strong> Rescan</strong>. Custom skills arrive <strong>disabled</strong> — review,
            then enable them before they can air.
          </div>
        </div>
        <div className="flex items-center gap-4 bg-[var(--ink-softer)] p-3.5">
          <span className="caption">{skills.length} skill{skills.length === 1 ? '' : 's'}</span>
          <span className="caption text-vermilion">{enabledCount} enabled</span>
          <div className="ml-auto">
            <Btn onClick={rescan} disabled={rescanning}>
              {rescanning ? 'Rescanning…' : 'Rescan state/skills'}
            </Btn>
          </div>
        </div>
      </section>

      {/* ── SKILL LIST ───────────────────────────────────────────────────── */}
      {skills.map(s => (
        <Card
          key={s.name}
          title={s.label || s.name}
          sub={s.kind}
          right={
            <>
              {s.custom && <Pill>custom</Pill>}
              <Pill tone={s.enabled ? 'accent' : 'default'} dot={s.enabled}>
                {s.enabled ? 'enabled' : 'disabled'}
              </Pill>
              <Toggle
                on={s.enabled}
                disabled={busy === s.name}
                onClick={() => toggle(s.name, !s.enabled)}
              />
            </>
          }
        >
          {s.ready === false && (
            <div className="mb-3">
              <V3Alert tone="error" title="API key not set">
                This skill needs the <code>{s.requiresKey || 'required API key'}</code> environment
                variable set in <code>.env</code>. Until then it stays inert and never
                fires autonomously — even when enabled.
                {s.keyUrl && (
                  <>
                    {' '}
                    <a
                      href={s.keyUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="font-bold text-vermilion underline decoration-[1.5px] underline-offset-2"
                    >
                      Get a key here
                    </a>.
                  </>
                )}
              </V3Alert>
            </div>
          )}
          <div className="grid grid-cols-[1fr_auto] items-center gap-4">
            <div>
              <div className="text-[12px] leading-[1.6] text-muted">
                <SkillDescription text={s.description} keyUrl={s.keyUrl} />
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <Pill className="text-[8px]">{cooldownLabel(s.cooldownMs)}</Pill>
                <Pill className="text-[8px]">kind · {s.kind}</Pill>
              </div>
            </div>
            <Btn
              tone="accent"
              onClick={() => runNow(s.name)}
              disabled={busy === s.name}
            >
              {busy === s.name ? 'Working…' : 'Run now'}
            </Btn>
          </div>
        </Card>
      ))}
    </div>
  );
}
