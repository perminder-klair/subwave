'use client';

// Skills editor. A skill only fires autonomously when it is enabled here AND
// assigned to the persona on air (/admin/personas). "Run now" is an operator
// override: it bypasses the enable toggle, the persona assignment, the
// frequency gate and the cooldown.
import type { ReactNode } from 'react';
import { useMemo, useRef, useState } from 'react';
import { cn } from '../../lib/cn';
import { notify, errorMessage } from '../../lib/notify';
import { useAdminAuth } from '../../lib/adminAuth';
import { adminJson, adminResponse, useAdminMutation } from '../../lib/admin-query';
import { useRosterView } from '../../lib/adminView';
import { RefreshCw, Plus, Users, Upload, Search, X } from 'lucide-react';
import { Card, Btn, Pill, Eyebrow, MetaChip, Toggle } from './ui';
import RosterViewToggle from './RosterViewToggle';
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
import SkillsTable from './skills/SkillsTable';
import { cooldownLabel, iconFor } from './skills/shared';
import type { Skill, SortMode, StatusFilter } from './skills/shared';
import { useSettingsQuery } from './settings/queries';
import {
  skillKeys,
  useCommunitySkillsQuery,
  useInstalledSkillsQuery,
  writeInstalledSkills,
} from './skills/queries';

// A show's skills are its HOST persona's, plus its pinned feature segment.
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

interface SkillToggleResponse {
  skills?: Skill[];
  error?: string;
}

interface SkillRunResponse {
  spoken?: string | null;
  // false when the skill ran but had nothing usable to speak from — a normal
  // outcome, not a failure, so it arrives as a 200 with a reason attached.
  aired?: boolean;
  reason?: string | null;
  error?: string;
}

type ModalState = { mode: 'create' } | { mode: 'edit'; skill: Skill };

interface SkillDescriptionProps {
  text?: string;
  keyUrl?: string;
}

// Turns the "<Provider> API key" phrase into a link to skill.keyUrl; plain text
// when there is no keyUrl.
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
  const [busy, setBusy] = useState<string | null>(null);   // skill name currently mutating, or null
  const [modal, setModal] = useState<ModalState | null>(null); // open editor sheet, or null
  const [communityOpen, setCommunityOpen] = useState(false);         // community catalog modal open?
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryEnabled = hydrated && !needsAuth;
  const skillsQuery = useInstalledSkillsQuery(adminFetch, queryEnabled);
  const communityQuery = useCommunitySkillsQuery(adminFetch, queryEnabled);
  const settingsQuery = useSettingsQuery<{
    values?: {
      personas?: Array<{ id?: string; name?: string; skills?: string[] | null }>;
      shows?: Array<{ id?: string; name?: string; personaId?: string; segmentSkill?: string }>;
    };
  }>({ adminFetch, enabled: queryEnabled });
  const skills = skillsQuery.data ?? null;
  // Catalog failures have always degraded to an empty optional browser while
  // the installed roster stays usable.
  const community = communityQuery.data ?? (communityQuery.isError ? [] : null);

  // Best-effort organisation metadata shares the one redacted /settings owner.
  const { personas, shows } = useMemo(() => {
    const values = settingsQuery.data?.values;
    const ps = Array.isArray(values?.personas) ? values.personas : [];
    const sh = Array.isArray(values?.shows) ? values.shows : [];
    return {
      personas: ps.map(p => ({
        id: String(p.id || ''),
        name: String(p.name || ''),
        skills: Array.isArray(p.skills) ? p.skills.map(String) : null,
      })).filter(p => p.id) as PersonaLite[],
      shows: sh.map(s => ({
        id: String(s.id || ''),
        name: String(s.name || ''),
        personaId: String(s.personaId || ''),
        segmentSkill: typeof s.segmentSkill === 'string' ? s.segmentSkill : '',
      })).filter(s => s.id) as ShowLite[],
    };
  }, [settingsQuery.data]);

  const toggleMutation = useAdminMutation<SkillToggleResponse, { name: string; on: boolean }>({
    adminFetch,
    request: (vars, fetcher) => adminJson(fetcher, '/dj/skill-toggle', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(vars),
    }),
    onDone: (response, _vars, client) => writeInstalledSkills(client, response),
    toastOnError: false,
  });
  const rescanMutation = useAdminMutation<SkillToggleResponse & { custom?: number }, void>({
    adminFetch,
    request: (_vars, fetcher) => adminJson(fetcher, '/dj/skills/rescan', { method: 'POST' }),
    onDone: async (response, _vars, client) => {
      writeInstalledSkills(client, response);
      await client.invalidateQueries({ queryKey: skillKeys.files(), refetchType: 'all' });
    },
    toastOnError: false,
  });
  const importMutation = useAdminMutation<
    SkillToggleResponse & { slug?: string; hasTool?: boolean }, FormData
  >({
    adminFetch,
    request: (body, fetcher) => adminJson(fetcher, '/dj/skills/import', { method: 'POST', body }),
    onDone: async (response, _vars, client) => {
      writeInstalledSkills(client, response);
      await client.invalidateQueries({ queryKey: skillKeys.community(), exact: true });
    },
    toastOnError: false,
  });
  const installMutation = useAdminMutation<SkillToggleResponse, { slug: string }>({
    adminFetch,
    request: ({ slug }, fetcher) => adminJson(
      fetcher, `/dj/skills/community/${encodeURIComponent(slug)}/install`, { method: 'POST' },
    ),
    onDone: async (response, _vars, client) => {
      writeInstalledSkills(client, response);
      await client.invalidateQueries({ queryKey: skillKeys.community(), exact: true });
    },
    toastOnError: false,
  });
  const rescanning = rescanMutation.isPending;
  const importing = importMutation.isPending;
  const installing = installMutation.isPending ? installMutation.variables?.slug ?? null : null;

  const [query, setQuery] = useState('');
  const [who, setWho] = useState('all');            // 'all' | 'p:<personaId>' | 's:<showId>'
  const [tagSel, setTagSel] = useState<string[]>([]);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [sort, setSort] = useState<SortMode>('az');

  const [view, setView] = useRosterView('skills');

  const toggle = async (name: string, on: boolean) => {
    setBusy(name);
    try {
      await toggleMutation.mutateAsync({ name, on });
    } catch (e) {
      notify.err(`Toggle failed: ${errorMessage(e)}`);
    } finally { setBusy(null); }
  };

  const rescan = async () => {
    try {
      const j = await rescanMutation.mutateAsync();
      notify.ok(`Rescanned, ${j.custom ?? 0} custom skill${j.custom === 1 ? '' : 's'} loaded`);
    } catch (e) {
      notify.err(`Rescan failed: ${errorMessage(e)}`);
    }
  };

  const runNow = async (name: string) => {
    setBusy(name);
    try {
      const r = await adminResponse(adminFetch, '/dj/skill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const j = (await r.json().catch(() => ({}))) as SkillRunResponse;
      // A stand-down is reported as-is rather than as a success: the operator
      // pressed Run now and nothing went to air, and the reason is the whole
      // point of the answer (issue #1412).
      if (j.aired === false) {
        notify.info(`${name} stayed silent — ${j.reason || 'nothing usable to speak from'}`);
      } else {
        notify.ok(j.spoken ? `On air: “${j.spoken}”` : `${name} fired`);
      }
    } catch (e) {
      notify.err(`Run failed: ${errorMessage(e)}`);
    } finally { setBusy(null); }
  };

  // An imported bundle arrives disabled, and one carrying a tool.mjs runs code
  // once enabled — the toast says so.
  const importZip = async (file: File) => {
    try {
      const fd = new FormData();
      fd.append('file', file);
      const j = await importMutation.mutateAsync(fd);
      notify.ok(
        j.hasTool
          ? `Imported “${j.slug}” — includes a data tool that runs code; review it before enabling`
          : `Imported “${j.slug}” — disabled until you enable it`,
      );
    } catch (e) {
      notify.err(`Import failed: ${errorMessage(e)}`);
    }
  };

  // Installs into state/skills, disabled. The route returns the refreshed
  // roster; the catalog is then invalidated so its installed bit is authoritative.
  const install = async (slug: string) => {
    try {
      await installMutation.mutateAsync({ slug });
      notify.ok(`Installed “${slug}” — disabled until you enable it`);
    } catch (e) {
      notify.err(`Install failed: ${errorMessage(e)}`);
    }
  };

  if (skillsQuery.error) {
    return (
      <div className="grid gap-4">
        <Card title="Skills">
          <ErrorState error={errorMessage(skillsQuery.error)} />
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

  // The tag filter's vocabulary; hidden until a skill carries a tag.
  const allTags = [...new Set(skills.flatMap(s => s.tags || []))].sort();

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

  // Needs the roster; an empty string hides the pill.
  const assignmentLabel = (s: Skill): string => {
    if (!personas.length) return '';
    const n = personas.filter(p => personaHasSkill(p, s.name)).length;
    return n === personas.length ? 'All DJs' : `${n} of ${personas.length} DJs`;
  };

  // Only meaningful while the DJ/show filter is sitting on a show.
  const isPinned = (s: Skill): boolean =>
    who.startsWith('s:') && shows.find(x => x.id === who.slice(2))?.segmentSkill === s.name;

  return (
    <div className="grid gap-4">
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
        {/* Full-width row of its own on phones: an `ml-auto` cluster beside the
            counts pushed COMMUNITY / NEW SKILL off the right edge at 390px. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3 bg-[var(--ink-softer)] p-3.5">
          <span className="caption">
            {filtered ? `${visible.length} of ${skills.length}` : skills.length} skill{skills.length === 1 ? '' : 's'}
          </span>
          <span className="caption text-vermilion">{enabledCount} enabled</span>
          <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto sm:flex-nowrap">
            <Btn
              className="min-h-9 sm:min-h-0"
              onClick={() => setCommunityOpen(true)}
              disabled={!community}
              title="Browse and install skills shared by other stations"
            >
              <Users size={14} /> Community
              {community && community.length > 0 && (
                <span className="ml-1 text-vermilion">{community.length}</span>
              )}
            </Btn>
            <Btn className="min-h-9 sm:min-h-0" tone="accent" onClick={() => setModal({ mode: 'create' })}>
              <Plus size={14} /> New skill
            </Btn>
            <Btn
              className="min-h-9 min-w-9 sm:min-h-0 sm:min-w-0"
              onClick={rescan}
              disabled={rescanning}
              title={rescanning ? 'Rescanning state/skills…' : 'Rescan state/skills'}
            >
              <RefreshCw size={14} className={rescanning ? 'animate-spin' : ''} />
            </Btn>
          </div>
        </div>
      </section>

      <section className="card p-3.5">
        <div className="flex flex-wrap items-center gap-2">
          {/* Phones get the search on its own row and the selects full-width /
              paired; `sm:` restores the single desktop row of fixed widths. */}
          <div className="relative w-full flex-none sm:min-w-[200px] sm:flex-1">
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
              <SelectTrigger className="w-full sm:w-[190px]" aria-label="Filter by DJ or show">
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
          {/* Status + sort own one phone row between them. The wrapper is
              `display:contents` from sm: up, so on desktop both selects are
              direct children of the bar again and the row is unchanged. */}
          <div className="flex w-full gap-2 sm:contents">
            <Select value={status} onValueChange={v => setStatus(v as StatusFilter)}>
              <SelectTrigger className="min-w-0 flex-1 sm:w-[130px] sm:flex-none" aria-label="Filter by status">
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
              <SelectTrigger className="min-w-0 flex-1 sm:w-[140px] sm:flex-none" aria-label="Sort skills">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="az">A–Z</SelectItem>
                <SelectItem value="enabled">Enabled first</SelectItem>
                <SelectItem value="cooldown">Cooldown</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {filtered && (
            <Btn className="min-h-9 sm:min-h-0" onClick={clearFilters} title="Clear all filters">
              <X size={14} /> Clear
            </Btn>
          )}
          {/* Filters and sort drive both views. */}
          <div className="ml-auto">
            <RosterViewToggle view={view} onChange={setView} />
          </div>
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
                    'min-h-9 border border-ink px-2 py-0.5 text-[12px] sm:min-h-0',
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
      {view === 'list' && visible.length > 0 && (
        <SkillsTable
          skills={visible}
          busy={busy}
          assignmentLabel={assignmentLabel}
          isPinned={isPinned}
          sort={sort}
          onSort={setSort}
          onEdit={s => setModal({ mode: 'edit', skill: s })}
          onToggle={toggle}
          onRunNow={runNow}
        />
      )}

      {view === 'cards' && visible.map(s => {
        const Icon = iconFor(s);
        const spine = s.enabled ? 'bg-[var(--accent)]' : 'bg-separator-strong';
        const assign = assignmentLabel(s);
        const pinned = isPinned(s);
        return (
          // The whole card opens the edit sheet, so inner controls
          // stopPropagation and the onKeyDown guard (target === currentTarget)
          // keeps a keyboard press on them from also opening the editor.
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
            <span
              aria-hidden="true"
              className={cn('absolute inset-y-0 left-0 w-1 transition-[width] group-hover:w-1.5', spine)}
            />

            <div className="card-body flex gap-3.5">
              <span
                className={cn(
                  'grid size-12 flex-none place-items-center border border-ink bg-[var(--ink-softer)]',
                  s.enabled ? 'text-ink' : 'text-muted',
                )}
              >
                <Icon size={20} strokeWidth={1.75} aria-hidden />
              </span>

              {/* Text stack and toggle rail are siblings, so the taller rail
                  never inflates the name row. */}
              <div className="flex min-w-0 flex-1 items-start gap-3">
                <div className="grid min-w-0 flex-1 gap-2.5">
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

                  <p className="line-clamp-2 text-[12px] leading-[1.55] text-muted italic">
                    <SkillDescription text={s.description} keyUrl={s.keyUrl} />
                  </p>

                  <div className="flex flex-wrap gap-1">
                    <MetaChip>{cooldownLabel(s.cooldownMs)}</MetaChip>
                    {assign && <MetaChip>{assign}</MetaChip>}
                    {pinned && <MetaChip accent>pinned feature</MetaChip>}
                    {(s.tags || []).map(t => (
                      <MetaChip key={t}>#{t}</MetaChip>
                    ))}
                  </div>

                  <div className="flex items-center justify-between gap-3">
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); runNow(s.name); }}
                      disabled={busy === s.name}
                      className={cn('seg-pad seg-pad--slim min-h-9 sm:min-h-0', busy === s.name && 'is-firing')}
                    >
                      <span className="seg-led" aria-hidden />
                      <span className="seg-label">{busy === s.name ? 'Working…' : 'Run now'}</span>
                    </button>
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold tracking-[0.16em] text-muted uppercase transition-colors group-hover:text-vermilion">
                      Edit <span aria-hidden="true">→</span>
                    </span>
                  </div>
                </div>

                <div className="flex flex-none flex-col items-end gap-1 text-right">
                  <span onClick={e => e.stopPropagation()}>
                    <Toggle
                      on={s.enabled}
                      disabled={busy === s.name}
                      onClick={() => toggle(s.name, !s.enabled)}
                      ariaLabel={`Enable ${s.label || s.name}`}
                    />
                  </span>
                  <span className="caption">{s.enabled ? 'enabled' : 'disabled'}</span>
                </div>
              </div>
            </div>
          </article>
        );
      })}

      <Modal
        open={communityOpen}
        onOpenChange={setCommunityOpen}
        title="community"
        sub="skills shared by other stations"
        width={640}
        footer={
          <div className="flex w-full flex-wrap items-center justify-between gap-3">
            <span className="min-w-0 flex-1 text-[11px] leading-[1.5] text-muted">
              Got a skill someone shared as a <code>.zip</code>? Import it here — it may include a
              data tool that runs code, so it arrives disabled for review.
            </span>
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip,application/zip"
              aria-label="Import skill zip"
              className="hidden"
              onChange={e => {
                const f = e.target.files?.[0];
                if (f) importZip(f);
                e.target.value = ''; // allow re-selecting the same file
              }}
            />
            <Btn
              className="min-h-9 sm:min-h-0"
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
              <div key={c.slug} className="grid grid-cols-1 gap-3 border border-ink p-3 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-4">
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
                      className="min-h-9 sm:min-h-0"
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

      {modal && (
        <SkillEditModal
          mode={modal.mode}
          skill={modal.mode === 'edit' ? modal.skill : undefined}
          personas={personas}
          tagSuggestions={allTags}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
