'use client';

// Skills editor — /admin/skills. The autonomous DJ segments (weather, news,
// now-playing digs, random facts) the station can fire between tracks.
//
// Each skill is toggled on/off station-wide here. A skill only fires
// autonomously when it is enabled here AND assigned to the persona on air
// (see /admin/personas). "Run now" is an operator override — it fires the
// segment immediately, bypassing the enable toggle, the persona assignment,
// the frequency gate, and the cooldown.
//
// Creating and editing a skill (custom or built-in) opens the SkillEditModal
// "segment sheet" — the list here is just the roster + quick actions.
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { notify, errorMessage } from '../../lib/notify';
import { useAdminAuth } from '../../lib/adminAuth';
import { RefreshCw, Plus, Users } from 'lucide-react';
import { Card, Btn, Pill, Eyebrow, Toggle } from './ui';
import { V3Alert } from '../ui/alert';
import { Modal } from '../ui/modal';
import SkillEditModal from './skills/SkillEditModal';

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
  feed?: string | null;
  feedMaxItems?: number | null;
}

// One entry in the shipped community catalog (GET /dj/skills/community).
interface CommunitySkill {
  slug: string;
  label: string;
  brief: string;
  cooldown?: string;
  window?: 'any' | 'commute';
  context?: string;
  installed?: boolean;   // a state/skills/<slug>/ folder already exists
  reserved?: boolean;    // slug shadows a built-in kind — can't be installed
}

interface SkillsResponse {
  skills?: Skill[];
}

interface CommunityResponse {
  community?: CommunitySkill[];
}

interface SkillToggleResponse {
  skills?: Skill[];
  error?: string;
}

interface SkillRunResponse {
  spoken?: string;
  error?: string;
}

// Which skill the modal is editing/creating, if any.
type ModalState = { mode: 'create' } | { mode: 'edit'; skill: Skill };

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
  const [modal, setModal] = useState<ModalState | null>(null); // open editor sheet, or null
  const [community, setCommunity] = useState<CommunitySkill[] | null>(null);
  const [installing, setInstalling] = useState<string | null>(null); // community slug installing, or null
  const [communityOpen, setCommunityOpen] = useState(false);         // community catalog modal open?

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
    // The community catalog is best-effort — a failure here shouldn't blank the
    // roster, so it fetches independently and just leaves the section empty.
    (async () => {
      try {
        const r = await adminFetch('/dj/skills/community');
        if (!r.ok) throw new Error(`failed (${r.status})`);
        const j = (await r.json()) as CommunityResponse;
        if (cancelled) return;
        setCommunity(Array.isArray(j.community) ? j.community : []);
      } catch {
        if (!cancelled) setCommunity([]);
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
      notify.ok(`Rescanned, ${j.custom ?? 0} custom skill${j.custom === 1 ? '' : 's'} loaded`);
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

  // Install a community skill into state/skills (arrives disabled). The route
  // returns the refreshed roster; we also flip the catalog entry to installed.
  const install = async (slug: string) => {
    setInstalling(slug);
    try {
      const r = await adminFetch(`/dj/skills/community/${slug}/install`, { method: 'POST' });
      const j = (await r.json().catch(() => ({}))) as SkillToggleResponse;
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      if (Array.isArray(j.skills)) setSkills(j.skills);
      setCommunity(cur => cur?.map(c => (c.slug === slug ? { ...c, installed: true } : c)) ?? cur);
      notify.ok(`Installed “${slug}” — disabled until you enable it`);
    } catch (e) {
      notify.err(`Install failed: ${errorMessage(e)}`);
    } finally { setInstalling(null); }
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
            <strong> and</strong> assigned to the persona on air. Set per-persona assignments
            on the Personas page. “Run now” is an operator override and ignores both.
          </div>
          <div className="mt-1 text-[11px] leading-[1.6] text-muted">
            Hit <strong>Edit</strong> on any skill to open its segment sheet — change the brief,
            cooldown, or which real-world context (time, weather…) it may mention (and, for News,
            its feed URL). Edits are saved to <code>state/skills/&lt;kind&gt;/SKILL.md</code>.
          </div>
          <div className="mt-1 text-[11px] leading-[1.6] text-muted">
            Add your own with <strong>New skill</strong> — it writes
            <code> state/skills/&lt;name&gt;/SKILL.md</code> for you. (You can still drop a folder there
            by hand — with an optional <code>tool.mjs</code> data tool — and hit <strong>Rescan</strong>.)
            Custom skills arrive <strong>disabled</strong>, so review them, then enable them before they can air.
          </div>
          <a
            href="/manual/skills"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block text-[11px] font-bold text-vermilion underline decoration-[1.5px] underline-offset-2"
          >
            Read this in the manual ↗
          </a>
        </div>
        <div className="flex items-center gap-4 bg-[var(--ink-softer)] p-3.5">
          <span className="caption">{skills.length} skill{skills.length === 1 ? '' : 's'}</span>
          <span className="caption text-vermilion">{enabledCount} enabled</span>
          <div className="ml-auto flex items-center gap-2">
            <Btn
              onClick={() => setCommunityOpen(true)}
              disabled={!community}
              title="Browse and install skills shared by other stations"
            >
              <Users size={14} /> Community
              {community && community.length > 0 && (
                <span className="ml-1 text-vermilion">{community.length}</span>
              )}
            </Btn>
            <Btn tone="accent" onClick={() => setModal({ mode: 'create' })}>
              <Plus size={14} /> New skill
            </Btn>
            <Btn
              onClick={rescan}
              disabled={rescanning}
              title={rescanning ? 'Rescanning state/skills…' : 'Rescan state/skills'}
            >
              <RefreshCw size={14} className={rescanning ? 'animate-spin' : ''} />
            </Btn>
          </div>
        </div>
      </section>

      {/* ── SKILL LIST ───────────────────────────────────────────────────── */}
      {skills.map(s => (
        <Card
          key={s.name}
          title={s.label || s.name}
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
                fires autonomously, even when enabled.
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
              <div className="line-clamp-2 text-[12px] leading-[1.6] text-muted">
                <SkillDescription text={s.description} keyUrl={s.keyUrl} />
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <Pill className="text-[8px]">{cooldownLabel(s.cooldownMs)}</Pill>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Btn
                tone="accent"
                onClick={() => runNow(s.name)}
                disabled={busy === s.name}
              >
                {busy === s.name ? 'Working…' : 'Run now'}
              </Btn>
              {/* Edit opens the segment-sheet modal for both built-in and custom
                  skills; Run now / Delete live inside the sheet. */}
              <Btn onClick={() => setModal({ mode: 'edit', skill: s })}>Edit</Btn>
            </div>
          </div>
        </Card>
      ))}

      {/* ── COMMUNITY CATALOG MODAL ──────────────────────────────────────── */}
      <Modal
        open={communityOpen}
        onOpenChange={setCommunityOpen}
        title="community"
        sub="skills shared by other stations"
        width={640}
      >
        <div className="text-[12px] leading-[1.65] text-muted">
          These prompt-only skills ship with SUB/WAVE and update when you do.
          <strong> Install</strong> copies one into <code>state/skills/</code> as your own
          editable skill — it arrives <strong>disabled</strong>, so review the brief, then
          enable it. Made one worth sharing? Hit <strong>Edit → Share to community</strong> on
          any custom skill.
        </div>
        <div className="mt-4 grid gap-3">
          {community && community.length > 0 ? (
            community.map(c => (
              <div key={c.slug} className="grid grid-cols-[1fr_auto] items-center gap-4 border border-ink p-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-extrabold">{c.label}</span>
                    {c.cooldown && <Pill className="text-[8px]">{c.cooldown} cooldown</Pill>}
                  </div>
                  <div className="mt-1 line-clamp-3 text-[12px] leading-[1.6] text-muted">{c.brief}</div>
                </div>
                <div className="flex flex-col items-end gap-2">
                  {c.installed ? (
                    <Pill tone="accent" dot>installed</Pill>
                  ) : c.reserved ? (
                    <Pill>reserved name</Pill>
                  ) : (
                    <Btn
                      tone="accent"
                      onClick={() => install(c.slug)}
                      disabled={installing === c.slug}
                    >
                      {installing === c.slug ? 'Installing…' : 'Install'}
                    </Btn>
                  )}
                </div>
              </div>
            ))
          ) : (
            <div className="py-6 text-center text-[13px] text-muted italic">
              No community skills yet.
            </div>
          )}
        </div>
      </Modal>

      {/* ── EDIT / CREATE MODAL ──────────────────────────────────────────── */}
      {modal && (
        <SkillEditModal
          mode={modal.mode}
          skill={modal.mode === 'edit' ? modal.skill : undefined}
          onClose={() => setModal(null)}
          onSkillsChange={next => { if (Array.isArray(next)) setSkills(next as Skill[]); }}
        />
      )}
    </div>
  );
}
