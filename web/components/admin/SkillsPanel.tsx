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
import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/cn';
import { notify, errorMessage } from '../../lib/notify';
import { useAdminAuth } from '../../lib/adminAuth';
import {
  RefreshCw, Plus, Users, Upload, Search, X,
  CloudSun, Newspaper, TrafficCone, Lightbulb, Cake, Disc3, Globe, Sparkles,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Card, Btn, Pill, Eyebrow, MetaChip, Toggle } from './ui';
import { V3Alert } from '../ui/alert';
import { SkeletonRows } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Modal } from '../ui/modal';
import { Input } from '../ui/input';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectGroup, SelectLabel,
} from '../ui/select';
import SkillEditModal from './skills/SkillEditModal';
import type { PersonaLite } from './skills/SkillEditModal';

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
  tags?: string[];
}

// Slim show shape from GET /settings — enough for the "filter by show" option
// (a show's skills are its HOST persona's, plus its pinned feature segment).
interface ShowLite {
  id: string;
  name: string;
  personaId: string;
  segmentSkill: string;
}

// Does this persona run the skill? `skills: null` is the "all skills" sentinel.
function personaHasSkill(p: PersonaLite, name: string): boolean {
  return p.skills === null || p.skills.includes(name);
}

type StatusFilter = 'all' | 'enabled' | 'disabled' | 'needs-key' | 'custom' | 'builtin';
type SortMode = 'az' | 'enabled' | 'cooldown';

// One entry in the shipped community catalog (GET /dj/skills/community).
interface CommunitySkill {
  slug: string;
  label: string;
  brief: string;
  cooldown?: string;
  window?: 'any' | 'commute';
  context?: string;
  submittedBy?: string;  // GitHub login of the contributor who submitted it
  dateAdded?: string;    // ISO date (YYYY-MM-DD) it first entered the catalog
  dateModified?: string; // ISO date (YYYY-MM-DD) of the last catalog change
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

// A glyph for each of the seven built-in segment kinds — fills the slate card's
// "face" slot where personas/shows have an avatar. Custom skills (and any
// unmapped kind) fall back to Sparkles, so this is not a maintenance trap.
const KIND_ICONS: Record<string, LucideIcon> = {
  weather: CloudSun,
  news: Newspaper,
  traffic: TrafficCone,
  curiosity: Lightbulb,
  'album-anniversary': Cake,
  'library-deep-cut': Disc3,
  'web-search': Globe,
};

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
  const [importing, setImporting] = useState(false);                 // zip import in flight?
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Roster context for the organisation tools — best-effort from GET /settings;
  // when it fails the DJ/show filter and assignment pills simply don't render.
  const [personas, setPersonas] = useState<PersonaLite[]>([]);
  const [shows, setShows] = useState<ShowLite[]>([]);

  // Organisation controls — component-local, reset on navigation.
  const [query, setQuery] = useState('');
  const [who, setWho] = useState('all');            // 'all' | 'p:<personaId>' | 's:<showId>'
  const [tagSel, setTagSel] = useState<string[]>([]);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [sort, setSort] = useState<SortMode>('az');

  // Pull the slim persona/show roster out of GET /settings. Reused after the
  // modal saves DJ assignments, so the filter + pills stay accurate.
  const refreshRoster = useCallback(async () => {
    try {
      const r = await adminFetch('/settings');
      if (!r.ok) return;
      const j = (await r.json().catch(() => ({}))) as {
        values?: {
          personas?: Array<{ id?: string; name?: string; skills?: string[] | null }>;
          shows?: Array<{ id?: string; name?: string; personaId?: string; segmentSkill?: string }>;
        };
      };
      const ps = Array.isArray(j.values?.personas) ? j.values.personas : [];
      setPersonas(ps
        .map(p => ({
          id: String(p.id || ''),
          name: String(p.name || ''),
          skills: Array.isArray(p.skills) ? p.skills.map(String) : null,
        }))
        .filter(p => p.id));
      const sh = Array.isArray(j.values?.shows) ? j.values.shows : [];
      setShows(sh
        .map(s => ({
          id: String(s.id || ''),
          name: String(s.name || ''),
          personaId: String(s.personaId || ''),
          segmentSkill: typeof s.segmentSkill === 'string' ? s.segmentSkill : '',
        }))
        .filter(s => s.id));
    } catch { /* organisation tools degrade gracefully */ }
  }, [adminFetch]);

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
    // Roster for the DJ/show filter — best-effort like the community catalog.
    refreshRoster();
    return () => { cancelled = true; };
  }, [hydrated, needsAuth, adminFetch, refreshRoster]);

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

  // Re-fetch the community catalog (after an import may have flipped an entry's
  // installed flag). Best-effort — leaves the list as-is on failure.
  const refreshCommunity = async () => {
    try {
      const r = await adminFetch('/dj/skills/community');
      if (!r.ok) return;
      const j = (await r.json()) as CommunityResponse;
      if (Array.isArray(j.community)) setCommunity(j.community);
    } catch { /* keep current list */ }
  };

  // Import a skill from an uploaded .zip (SKILL.md + optional tool.mjs). Arrives
  // disabled; a bundle carrying a tool.mjs runs code once enabled, so the toast
  // says so. The controller derives the slug from the bundle's SKILL.md.
  const importZip = async (file: File) => {
    setImporting(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await adminFetch('/dj/skills/import', { method: 'POST', body: fd });
      const j = (await r.json().catch(() => ({}))) as SkillToggleResponse & { slug?: string; hasTool?: boolean };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      if (Array.isArray(j.skills)) setSkills(j.skills);
      await refreshCommunity();
      notify.ok(
        j.hasTool
          ? `Imported “${j.slug}” — includes a data tool that runs code; review it before enabling`
          : `Imported “${j.slug}” — disabled until you enable it`,
      );
    } catch (e) {
      notify.err(`Import failed: ${errorMessage(e)}`);
    } finally {
      setImporting(false);
    }
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
          <ErrorState error={err} />
        </Card>
      </div>
    );
  }
  if (!skills) {
    return (
      <div className="grid gap-4">
        <Card title="Skills">
          <SkeletonRows rows={4} />
        </Card>
      </div>
    );
  }

  const enabledCount = skills.filter(s => s.enabled).length;

  // Union of every tag in the catalog — the tag filter's vocabulary. Hidden
  // until at least one skill carries a tag.
  const allTags = [...new Set(skills.flatMap(s => s.tags || []))].sort();

  // Who runs this skill — drives the DJ/show filter and the assignment pill.
  const matchesWho = (s: Skill): boolean => {
    if (who === 'all') return true;
    if (who.startsWith('p:')) {
      const p = personas.find(x => x.id === who.slice(2));
      return !!p && personaHasSkill(p, s.name);
    }
    const show = shows.find(x => x.id === who.slice(2));
    if (!show) return true;
    if (show.segmentSkill === s.name) return true; // the show's pinned feature
    const host = personas.find(x => x.id === show.personaId);
    return !!host && personaHasSkill(host, s.name);
  };

  const matchesStatus = (s: Skill): boolean => {
    switch (status) {
      case 'enabled': return !!s.enabled;
      case 'disabled': return !s.enabled;
      case 'needs-key': return s.ready === false;
      case 'custom': return !!s.custom;
      case 'builtin': return !s.custom;
      default: return true;
    }
  };

  const q = query.trim().toLowerCase();
  const visible = skills
    .filter(s =>
      (!q
        || (s.label || '').toLowerCase().includes(q)
        || s.name.toLowerCase().includes(q)
        || (s.description || '').toLowerCase().includes(q))
      && (!tagSel.length || (s.tags || []).some(t => tagSel.includes(t)))
      && matchesWho(s)
      && matchesStatus(s))
    .sort((a, b) => {
      const az = (a.label || a.name).localeCompare(b.label || b.name);
      if (sort === 'enabled') return Number(!!b.enabled) - Number(!!a.enabled) || az;
      if (sort === 'cooldown') return (a.cooldownMs || 0) - (b.cooldownMs || 0) || az;
      return az;
    });

  const filtered = query.trim() !== '' || who !== 'all' || tagSel.length > 0 || status !== 'all';
  const clearFilters = () => { setQuery(''); setWho('all'); setTagSel([]); setStatus('all'); };

  // "All DJs" / "3 of 8 DJs" pill copy — needs the roster; empty string hides it.
  const assignmentLabel = (s: Skill): string => {
    if (!personas.length) return '';
    const n = personas.filter(p => personaHasSkill(p, s.name)).length;
    return n === personas.length ? 'All DJs' : `${n} of ${personas.length} DJs`;
  };

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
            Each skill is an autonomous segment. It fires only when it&apos;s enabled here
            <strong> and</strong> assigned to the persona on air. Assign DJs from a skill&apos;s
            Edit sheet, or per-persona on the Personas page. &quot;Run now&quot; is an operator
            override and ignores both.
          </div>
          <div className="mt-1 text-[11px] leading-[1.6] text-muted">
            Hit <strong>Edit</strong> on any skill to open its segment sheet: change the brief,
            cooldown, or which real-world context (time, weather) it may mention, plus the feed
            URL for News. Edits save to <code>state/skills/&lt;kind&gt;/SKILL.md</code>.
          </div>
          <div className="mt-1 text-[11px] leading-[1.6] text-muted">
            Add your own with <strong>New skill</strong> and it writes
            <code> state/skills/&lt;name&gt;/SKILL.md</code> for you. (You can also drop a folder there
            by hand, with an optional <code>tool.mjs</code> data tool, then hit <strong>Rescan</strong>.)
            Custom skills arrive <strong>disabled</strong>, so review them before enabling.
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
          <span className="caption">
            {filtered ? `${visible.length} of ${skills.length}` : skills.length} skill{skills.length === 1 ? '' : 's'}
          </span>
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

      {/* ── ORGANISE — search / filter / sort ─────────────────────────────── */}
      <section className="card p-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1">
            <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" />
            <Input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search skills…"
              aria-label="Search skills"
              className="pl-8"
            />
          </div>
          {personas.length > 0 && (
            <Select value={who} onValueChange={setWho}>
              <SelectTrigger className="w-[190px]" aria-label="Filter by DJ or show">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All DJs &amp; shows</SelectItem>
                <SelectGroup>
                  <SelectLabel>DJs</SelectLabel>
                  {personas.map(p => (
                    <SelectItem key={p.id} value={`p:${p.id}`}>DJ: {p.name}</SelectItem>
                  ))}
                </SelectGroup>
                {shows.length > 0 && (
                  <SelectGroup>
                    <SelectLabel>Shows</SelectLabel>
                    {shows.map(s => (
                      <SelectItem key={s.id} value={`s:${s.id}`}>Show: {s.name}</SelectItem>
                    ))}
                  </SelectGroup>
                )}
              </SelectContent>
            </Select>
          )}
          <Select value={status} onValueChange={v => setStatus(v as StatusFilter)}>
            <SelectTrigger className="w-[130px]" aria-label="Filter by status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any status</SelectItem>
              <SelectItem value="enabled">Enabled</SelectItem>
              <SelectItem value="disabled">Disabled</SelectItem>
              <SelectItem value="needs-key">Needs key</SelectItem>
              <SelectItem value="custom">Custom</SelectItem>
              <SelectItem value="builtin">Built-in</SelectItem>
            </SelectContent>
          </Select>
          <Select value={sort} onValueChange={v => setSort(v as SortMode)}>
            <SelectTrigger className="w-[140px]" aria-label="Sort skills">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="az">A–Z</SelectItem>
              <SelectItem value="enabled">Enabled first</SelectItem>
              <SelectItem value="cooldown">Cooldown</SelectItem>
            </SelectContent>
          </Select>
          {filtered && (
            <Btn onClick={clearFilters} title="Clear all filters">
              <X size={14} /> Clear
            </Btn>
          )}
        </div>
        {allTags.length > 0 && (
          <div className="mt-2.5 flex flex-wrap items-center gap-1">
            <span className="caption mr-1">tags</span>
            {allTags.map(t => {
              const on = tagSel.includes(t);
              return (
                <button
                  key={t}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setTagSel(cur => (on ? cur.filter(x => x !== t) : [...cur, t]))}
                  className={cn(
                    'border border-ink px-2 py-0.5 text-[12px]',
                    on ? 'bg-ink text-bg' : 'text-ink hover:bg-[var(--ink-soft)]',
                  )}
                >
                  {t}
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* ── SKILL LIST ───────────────────────────────────────────────────── */}
      {visible.length === 0 && (
        <Card title="No matches">
          <EmptyState
            title="No skills match"
            description="Nothing fits the current filters."
            action={
              <button type="button" onClick={clearFilters} className="font-bold text-vermilion underline decoration-[1.5px] underline-offset-2">
                Clear filters
              </button>
            }
          />
        </Card>
      )}
      {visible.map(s => {
        const Icon = KIND_ICONS[s.kind || s.name] ?? Sparkles;
        // Spine keyed to enabled state — the same signal the toggle carries.
        const spine = s.enabled ? 'bg-[var(--accent)]' : 'bg-separator-strong';
        const assign = assignmentLabel(s);
        const pinned = who.startsWith('s:')
          && shows.find(x => x.id === who.slice(2))?.segmentSkill === s.name;
        return (
          // The whole card opens the edit sheet; the Toggle, Run now, and the
          // API-key link stopPropagation so they act in place. The onKeyDown
          // guard (target === currentTarget) keeps a keyboard press on those
          // inner controls from bubbling up and also opening the editor.
          <article
            key={s.name}
            role="button"
            tabIndex={0}
            aria-label={`Edit ${s.label || s.name}`}
            onClick={() => setModal({ mode: 'edit', skill: s })}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setModal({ mode: 'edit', skill: s }); }
            }}
            className={cn(
              'group card relative cursor-pointer transition-colors hover:bg-[var(--ink-softer)]',
              'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)]',
            )}
          >
            {/* enabled/disabled spine */}
            <span
              aria-hidden="true"
              className={cn('absolute inset-y-0 left-0 w-1 transition-[width] group-hover:w-1.5', spine)}
            />

            <div className="card-body flex gap-3.5">
              {/* kind glyph — the face slot */}
              <span
                className={cn(
                  'grid size-12 flex-none place-items-center border border-ink bg-[var(--ink-softer)]',
                  s.enabled ? 'text-ink' : 'text-muted',
                )}
              >
                <Icon size={20} strokeWidth={1.75} aria-hidden />
              </span>

              {/* body — text stack + toggle rail as siblings, so the taller rail
                  never inflates the name row and pushes the description down */}
              <div className="flex min-w-0 flex-1 items-start gap-3">
                {/* text stack — name, description, facets, actions stack tightly */}
                <div className="grid min-w-0 flex-1 gap-2.5">
                  {/* name + custom flag */}
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-[17px] font-extrabold tracking-[-0.01em] text-ink">
                      {s.label || s.name}
                    </span>
                    {s.custom && <Pill className="text-[8px]">custom</Pill>}
                  </div>

                  {s.ready === false && (
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
                            onClick={e => e.stopPropagation()}
                            className="font-bold text-vermilion underline decoration-[1.5px] underline-offset-2"
                          >
                            Get a key here
                          </a>.
                        </>
                      )}
                    </V3Alert>
                  )}

                  {/* brief */}
                  <p className="line-clamp-2 text-[12px] leading-[1.55] text-muted italic">
                    <SkillDescription text={s.description} keyUrl={s.keyUrl} />
                  </p>

                  {/* facets — cadence, reach, tags */}
                  <div className="flex flex-wrap gap-1">
                    <MetaChip>{cooldownLabel(s.cooldownMs)}</MetaChip>
                    {assign && <MetaChip>{assign}</MetaChip>}
                    {pinned && <MetaChip accent>pinned feature</MetaChip>}
                    {(s.tags || []).map(t => (
                      <MetaChip key={t}>#{t}</MetaChip>
                    ))}
                  </div>

                  {/* actions — Run now on the left, Edit affordance on the right.
                      Same cart-pad language as the dash DJ segment pads, slimmed
                      to one line — LED arms on hover, blinks while running. */}
                  <div className="flex items-center justify-between gap-3">
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); runNow(s.name); }}
                      disabled={busy === s.name}
                      className={cn('seg-pad seg-pad--slim', busy === s.name && 'is-firing')}
                    >
                      <span className="seg-led" aria-hidden />
                      <span className="seg-label">{busy === s.name ? 'Working…' : 'Run now'}</span>
                    </button>
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold tracking-[0.16em] text-muted uppercase transition-colors group-hover:text-vermilion">
                      Edit <span aria-hidden="true">→</span>
                    </span>
                  </div>
                </div>

                {/* right rail — the toggle + its state */}
                <div className="flex flex-none flex-col items-end gap-1 text-right">
                  <span onClick={e => e.stopPropagation()}>
                    <Toggle
                      on={s.enabled}
                      disabled={busy === s.name}
                      onClick={() => toggle(s.name, !s.enabled)}
                    />
                  </span>
                  <span className="caption">{s.enabled ? 'enabled' : 'disabled'}</span>
                </div>
              </div>
            </div>
          </article>
        );
      })}

      {/* ── COMMUNITY CATALOG MODAL ──────────────────────────────────────── */}
      <Modal
        open={communityOpen}
        onOpenChange={setCommunityOpen}
        title="community"
        sub="skills shared by other stations"
        width={640}
        footer={
          <div className="flex w-full items-center justify-between gap-3">
            <span className="text-[11px] leading-[1.5] text-muted">
              Got a skill someone shared as a <code>.zip</code>? Import it here — it may include a
              data tool that runs code, so it arrives disabled for review.
            </span>
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={e => {
                const f = e.target.files?.[0];
                if (f) importZip(f);
                e.target.value = ''; // allow re-selecting the same file
              }}
            />
            <Btn
              onClick={() => fileInputRef.current?.click()}
              disabled={importing}
              title="Install a skill from a .zip bundle"
            >
              <Upload size={14} /> {importing ? 'Importing…' : 'Import .zip'}
            </Btn>
          </div>
        }
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
                  {(c.submittedBy || c.dateAdded) && (
                    <div className="mt-1.5 text-[10px] leading-[1.5] text-muted">
                      {c.submittedBy && (
                        <>
                          by{' '}
                          <a
                            href={`https://github.com/${c.submittedBy}`}
                            target="_blank"
                            rel="noreferrer"
                            className="font-bold text-vermilion underline decoration-[1.5px] underline-offset-2"
                          >
                            @{c.submittedBy}
                          </a>
                        </>
                      )}
                      {c.submittedBy && c.dateAdded && ' · '}
                      {c.dateAdded && <>added {c.dateAdded}</>}
                      {c.dateAdded && c.dateModified && c.dateModified !== c.dateAdded && (
                        <> · updated {c.dateModified}</>
                      )}
                    </div>
                  )}
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
          personas={personas}
          tagSuggestions={allTags}
          onClose={() => setModal(null)}
          onSkillsChange={next => { if (Array.isArray(next)) setSkills(next as Skill[]); }}
          onRosterChange={refreshRoster}
        />
      )}
    </div>
  );
}
