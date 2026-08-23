'use client';

import type { ChangeEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useDynamicStyle } from '../../../hooks/useDynamicStyle';
import { notify, errorMessage } from '../../../lib/notify';
import { adminJson, useAdminMutation } from '../../../lib/admin-query';
import { applyTheme, cacheTheme, resolveFont } from '../../../lib/theme';
import { useThemeSwitcher } from '../../ThemeProvider';
import { V3AlertDialog } from '../../ui/alert-dialog';
import { Modal } from '../../ui/modal';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Card, Btn, Pill, Seg } from '../ui';
import { SkeletonRows } from '../../ui/skeleton';
import { AiFill } from '../AiFill';
import { cn } from '../../../lib/cn';
import { SkinGallery } from './SkinGallery';
import { DEFAULT_SKIN_ID, SKINS } from '../../skins';
import { THEME_TOKENS, THEME_TOKEN_KEYS, SWATCH_KEYS, DISPLAY_FONT_IDS, MONO_FONT_IDS } from '../../../lib/theme-tokens.generated';
import {
  SectionHeader,
  type SettingsData, type SaveSettings, type SettingsFieldErrors,
} from './shared';
import {
  adminThemeKeys,
  reconcileAdminThemesAfterWrite,
  useAdminThemesQuery,
  type AdminTheme,
  type AdminThemesResponse,
} from '../themes-queries';

interface ThemeSectionProps {
  data: SettingsData;
  busy: boolean;
  saveSettings: SaveSettings;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  /** Server-side errors from the last save, keyed by dotted path. */
  fieldErrors: SettingsFieldErrors;
}

// Set by the controller's /themes responses. Built-ins ship in the image and
// can't be removed; only user themes (state/themes/*.json) show Edit/Remove.
type ThemeDef = AdminTheme;

// SWATCH_KEYS + THEME_TOKENS come from the generated registry mirror, so this
// form, the controller validator and the no-flash bootstrap can't drift.

// One ref per swatch because useDynamicStyle takes a single element. Arbitrary
// token values can't go through Tailwind utilities and issue #50 bans the inline
// `style` prop, hence the DOM-API hook.
function Swatch({ color }: { color?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useDynamicStyle(ref, { background: color || 'transparent' });
  return <span ref={ref} className="h-7 w-7" aria-hidden="true" />;
}

// Applies the in-progress tokens to a scoped subtree, never the live page theme.
// Set via the DOM API, not the inline style prop (issue #50); omitted tokens
// derive from the globals.css :root fallbacks, exactly like the real system.
function ThemePreview({ tokens, mode }: { tokens: Record<string, string>; mode: 'light' | 'dark' }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    for (const key of THEME_TOKEN_KEYS) el.style.removeProperty(key);
    for (const [k, v] of Object.entries(tokens)) {
      if (!v.trim()) continue;
      const isFont = k === '--display-font' || k === '--mono-font';
      el.style.setProperty(k, isFont ? resolveFont(v) : v);
    }
  }, [tokens, mode]);
  return (
    <div ref={ref} data-theme={mode} className="grid gap-2 border border-line bg-bg p-3 text-ink">
      <div className="flex items-baseline justify-between">
        <span className="font-display text-[22px] leading-none">Aa Now Playing</span>
        <span className="text-[9px] tracking-[0.2em] text-ink-faint uppercase">preview</span>
      </div>
      <div className="grid gap-1 border border-surface-border bg-surface p-2.5">
        <span className="text-[12px] text-ink">a track title</span>
        <span className="text-[11px] text-muted">an artist · an album</span>
        <span className="text-[10px] text-ink-faint">tertiary caption / timestamp</span>
        <div className="mt-1.5 flex items-center gap-2">
          <span className="bg-vermilion px-2 py-1 text-[10px] font-semibold text-white">Accent</span>
          <span className="bg-accent-soft px-2 py-1 text-[10px] text-ink">tint</span>
          <span className="border border-line px-2 py-1 text-[10px] text-ink">hairline</span>
          <span className="ml-auto inline-block h-3.5 w-3.5 bg-accent-2" title="accent 2" />
        </div>
      </div>
    </div>
  );
}

// Saved as state/themes/<id>.json via POST /themes. Passing an existing theme's id
// overwrites that file (edit); omitting it derives a new id from the name (create).
function ThemeEditorModal({
  open,
  onOpenChange,
  editing,
  adminFetch,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  editing: ThemeDef | null;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  onSaved: (themes: ThemeDef[], savedId?: string) => void;
}) {
  const isEdit = editing != null;
  const queryClient = useQueryClient();
  const themeCtx = useThemeSwitcher();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [mode, setMode] = useState<'light' | 'dark'>('dark');
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const saveMutation = useAdminMutation<AdminThemesResponse, Record<string, unknown>>({
    adminFetch,
    request: (body, fetcher) => adminJson(fetcher, '/themes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    toastOnError: false,
  });

  // Keyed on `open` so re-opening always starts clean.
  useEffect(() => {
    if (!open) return;
    setErr(null);
    if (editing) {
      setName(editing.name);
      setDescription(editing.description || '');
      setMode(editing.mode);
      setTokens({ ...editing.tokens });
    } else {
      setName(''); setDescription(''); setMode('dark'); setTokens({});
    }
  }, [open, editing]);

  const applyDraft = (t: {
    name?: string;
    description?: string;
    mode?: 'light' | 'dark';
    tokens?: Record<string, string>;
  }) => {
    if (t.name && !name.trim()) setName(t.name);
    if (t.description) setDescription(t.description);
    if (t.mode) setMode(t.mode);
    if (t.tokens) setTokens(prev => ({ ...prev, ...t.tokens }));
  };

  const save = async () => {
    if (!name.trim() || saveMutation.isPending) return;
    setErr(null);
    try {
      // Drop blank tokens — an omitted token derives from the base palette in
      // globals.css, and an empty value would fail the typed validator.
      const cleaned = Object.fromEntries(Object.entries(tokens).filter(([, v]) => v.trim() !== ''));
      const body: Record<string, unknown> = { name: name.trim(), description: description.trim(), mode, tokens: cleaned };
      // Keeps the same file even if the operator renamed the theme.
      if (isEdit && editing) body.id = editing.id;
      await saveMutation.mutateAsync(body);
      const reconciled = await reconcileAdminThemesAfterWrite(
        queryClient,
        adminFetch,
        themeCtx?.refreshThemes,
      );
      if (!reconciled.ok) {
        notify.err(
          `Theme "${name.trim()}" ${isEdit ? 'updated' : 'saved'}, but refresh failed: ${errorMessage(reconciled.error)}`,
        );
        onOpenChange(false);
        return;
      }
      onSaved(reconciled.data.themes, isEdit && editing ? editing.id : undefined);
      notify.ok(`${isEdit ? 'updated' : 'saved'} "${name.trim()}"`);
      onOpenChange(false);
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      width={640}
      title={isEdit ? 'edit theme' : 'create theme'}
      sub={name.trim() || 'a custom palette'}
      footer={
        <>
          {err && <span className="mr-auto text-[12px] text-[var(--danger)]">{err}</span>}
          <Btn onClick={() => onOpenChange(false)} disabled={saveMutation.isPending}>Cancel</Btn>
          <Btn tone="accent" onClick={save} disabled={saveMutation.isPending || !name.trim()}>
            {saveMutation.isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Save theme'}
          </Btn>
        </>
      }
    >
      <div className="grid gap-3">
        <AiFill<{ name?: string; description?: string; mode?: 'light' | 'dark'; tokens?: Record<string, string> }>
          endpoint="/generate/theme"
          resultKey="theme"
          adminFetch={adminFetch}
          placeholder="e.g. a warm sepia newspaper, easy on the eyes"
          extra={{ mode }}
          onApply={applyDraft}
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <div className="field">
            <Label>theme name</Label>
            <Input value={name} maxLength={60} onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)} placeholder="e.g. Sepia Press" />
          </div>
          <Seg
            value={mode}
            onChange={(v) => setMode(v as 'light' | 'dark')}
            options={[{ id: 'dark', label: 'Dark' }, { id: 'light', label: 'Light' }]}
          />
        </div>
        <div className="grid gap-1.5">
          {THEME_TOKENS.map(({ key, label, type, group, fontSet }, i) => (
            <div key={key} className="grid gap-1.5">
              {group !== (i > 0 ? THEME_TOKENS[i - 1]?.group : null) && (
                <div className="mt-2 text-[10px] tracking-[0.16em] text-ink-faint uppercase first:mt-0">{group}</div>
              )}
              <div className="grid grid-cols-[auto_5.5rem_1fr] items-center gap-2">
                <span className="inline-flex shrink-0 border border-ink">
                  <Swatch color={type === 'color' ? tokens[key] : undefined} />
                </span>
                <span className="text-[11px] tracking-[0.12em] text-muted uppercase">{label}</span>
                {type === 'font' ? (
                  <select
                    value={tokens[key] || ''}
                    onChange={(e: ChangeEvent<HTMLSelectElement>) => setTokens(prev => ({ ...prev, [key]: e.target.value }))}
                    className="border border-ink bg-field px-2 py-1.5 font-mono text-[12px] text-ink"
                  >
                    <option value="">default ({fontSet === 'mono' ? 'jetbrains' : 'fraunces'})</option>
                    {(fontSet === 'mono' ? MONO_FONT_IDS : DISPLAY_FONT_IDS).map(id => <option key={id} value={id}>{id}</option>)}
                  </select>
                ) : type === 'grain' ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="range" min={0} max={1} step={0.05}
                      value={tokens[key] ? Number(tokens[key]) : 0}
                      onChange={(e: ChangeEvent<HTMLInputElement>) => setTokens(prev => ({ ...prev, [key]: e.target.value }))}
                      className="w-full accent-vermilion"
                      aria-label={label}
                    />
                    <span className="w-8 shrink-0 text-right font-mono text-[11px] text-muted">{tokens[key] || '—'}</span>
                  </div>
                ) : (
                  <Input
                    value={tokens[key] || ''}
                    maxLength={100}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setTokens(prev => ({ ...prev, [key]: e.target.value }))}
                    placeholder="#000000 or rgba(…)"
                    className="font-mono text-[12px]"
                  />
                )}
              </div>
            </div>
          ))}
        </div>
        <ThemePreview tokens={tokens} mode={mode} />
      </div>
    </Modal>
  );
}

const NOTICE_CLASS =
  'border border-[color-mix(in_oklab,var(--accent)_35%,transparent)] bg-[var(--accent-soft)] px-3 py-2 text-[11px] leading-[1.5] text-ink !normal-case';

// Why the palette on screen isn't the one the station picker says is active.
//
// Three levels resolve a theme, each silently outranking the one below: this
// browser's override → the on-air show's themeId → the station default set
// here. Save a station theme while either of the upper two is in play and it
// applies, then appears to revert on the next poll — #1300 bug 12, reported as
// the setting not sticking. Nothing failed, so this is a note (role="status",
// since it can appear right after a save) and it renders only when a higher
// level is actually winning.
//
// Every input comes from ThemeProvider's own 30s /themes poll, deliberately:
// which show is on air changes on the clock, so a snapshot taken at mount would
// go stale in both directions.
function EffectiveThemeNotice({
  activeSource,
  active,
  stationDefault,
  activeShow,
  themes,
  overrideId,
}: {
  activeSource: 'show' | 'station' | null;
  active: string | null;
  stationDefault: string | null;
  activeShow: { id: string; name: string; themeId: string } | null;
  themes: ThemeDef[] | null;
  overrideId: string | null;
}) {
  const nameOf = (id: string | null | undefined) =>
    (id && themes?.find(t => t.id === id)?.name) || id || 'unknown';

  // The browser override is checked first because it outranks the show, and it
  // is the only level whose fix lives outside this page. Unlike the show below
  // it, there's no "changes nothing visible" case to stay quiet about: the
  // override outlives the save, so it will outrank whatever is picked next even
  // when it currently happens to match the station default.
  if (overrideId && themes?.some(t => t.id === overrideId)) {
    return (
      <div className={NOTICE_CLASS} role="status">
        <b>This browser is pinned to “{nameOf(overrideId)}”.</b> You picked a
        theme override for yourself from the player’s palette menu, so what you
        see here is that, not the station theme — listeners are unaffected.
        Clear the override in the player’s palette menu to follow the station
        again.
      </div>
    );
  }

  if (activeSource !== 'show' || !activeShow) return null;
  // A show pinning the same theme the station already defaults to changes
  // nothing anyone can see — saying so would be noise.
  if (active === stationDefault) return null;

  return (
    <div className={NOTICE_CLASS} role="status">
      <b>
        On air now: “{nameOf(active)}”, pinned by the show{' '}
        {activeShow.name || activeShow.id}.
      </b>{' '}
      A show’s own theme outranks the station default for as long as it is on
      air, so the theme you set below won’t be visible until the show ends. It
      is saved either way. To change what’s showing right now, edit that show’s
      theme override on the Shows page.
    </div>
  );
}

export function ThemeSection({ data, busy, saveSettings, adminFetch }: ThemeSectionProps) {
  const queryClient = useQueryClient();
  // Which level decided the theme actually on screen. ThemeProvider is the one
  // place that resolves all three — it owns the browser override (localStorage,
  // never seen by the server) and it polls /themes for the other two, painting
  // from the same response the provenance comes in. Reading it here instead of
  // snapshotting a second fetch is what keeps the notice in step with the paint.
  const themeCtx = useThemeSwitcher();
  const [confirmRemove, setConfirmRemove] = useState<ThemeDef | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<ThemeDef | null>(null);
  const themesQuery = useAdminThemesQuery(adminFetch, true);
  const themes = themesQuery.data?.themes ?? null;
  const error = themesQuery.error ? errorMessage(themesQuery.error) : null;

  const activeId = data.values?.theme?.active;

  // Skin = the player's full-screen layout (ui.skin); the theme is the palette. The
  // player picks a change up on its next /state poll.
  const activeSkinId = SKINS.some(s => s.id === data.values?.ui?.skin)
    ? (data.values?.ui?.skin as string)
    : DEFAULT_SKIN_ID;
  const activeSkinName = SKINS.find(s => s.id === activeSkinId)?.name ?? 'Classic';
  const chooseSkin = (id: string) => { if (!busy) saveSettings({ ui: { skin: id } }); };

  // The editing list carries `builtin`, which decides Edit/Remove. ShowsPanel
  // consumes the same exact query key for show overrides; mutations below
  // patch that one shared response rather than maintaining route-local copies.
  const refreshMutation = useAdminMutation<AdminThemesResponse, void>({
    adminFetch,
    request: (_unused, fetcher) => adminJson(fetcher, '/themes/refresh', { method: 'POST' }),
    toastOnError: false,
  });
  const removeMutation = useAdminMutation<AdminThemesResponse, ThemeDef>({
    adminFetch,
    request: (theme, fetcher) => adminJson(
      fetcher,
      `/themes/${encodeURIComponent(theme.id)}`,
      { method: 'DELETE' },
    ),
    toastOnError: false,
  });

  const refresh = async () => {
    try {
      await refreshMutation.mutateAsync();
      const reconciled = await reconcileAdminThemesAfterWrite(
        queryClient,
        adminFetch,
        themeCtx?.refreshThemes,
      );
      if (!reconciled.ok) {
        notify.err(`Themes reloaded, but refresh failed: ${errorMessage(reconciled.error)}`);
        return;
      }
      // A file dropped in can make a show's previously-dead themeId resolve, so
      // the answer to "who's winning" may have just changed too.
      await themeCtx?.refreshThemes();
      const next = reconciled.data.themes;
      notify.ok(`reloaded, ${next.length} theme${next.length === 1 ? '' : 's'}`);
    } catch (e) {
      notify.err(`Refresh failed: ${errorMessage(e)}`);
    }
  };

  const choose = async (theme: ThemeDef) => {
    if (theme.id === activeId || busy) return;
    // ThemeProvider's 30s poll would pick this up eventually; apply locally so the
    // swatch swap is instant.
    applyTheme(theme);
    cacheTheme(theme);
    const saved = await saveSettings({ theme: { active: theme.id } });
    if (!saved) {
      // POST rejection (or a failed redacted settings reconcile) must not leave
      // an unsaved optimistic palette in the DOM or pre-paint cache.
      await themeCtx?.refreshThemes();
      return;
    }
    const reconciled = await reconcileAdminThemesAfterWrite(
      queryClient,
      adminFetch,
      themeCtx?.refreshThemes,
    );
    if (!reconciled.ok) {
      notify.err(`Theme saved, but refresh failed: ${errorMessage(reconciled.error)}`);
      return;
    }
    // Re-read provenance now rather than up to 30s from now: if a show is
    // pinning its own theme, this save has just set a default that won't be
    // visible until the show ends, and the operator should learn that here — not
    // from the palette flipping back on ThemeProvider's next poll.
    await themeCtx?.refreshThemes();
  };

  // Re-apply when the edited theme is the one on air, so the admin page updates now.
  const onSaved = (next: ThemeDef[], savedId?: string) => {
    if (savedId && savedId === activeId) {
      const saved = next.find(t => t.id === savedId);
      if (saved) { applyTheme(saved); cacheTheme(saved); }
    }
  };

  // Deleting the active theme falls back to the first remaining one (built-ins lead
  // the list), so nothing points at a now-missing id.
  const remove = async (theme: ThemeDef) => {
    try {
      const receipt = await removeMutation.mutateAsync(theme);
      const reconciled = await reconcileAdminThemesAfterWrite(
        queryClient,
        adminFetch,
        undefined,
      );
      if (!reconciled.ok) {
        const remainingThemes = Array.isArray(receipt.themes)
          ? receipt.themes.filter(candidate => candidate.id !== theme.id)
          : [];
        const validActiveId = remainingThemes.some(candidate => candidate.id === activeId)
          ? activeId
          : undefined;
        const validStationDefault = remainingThemes.some(
          candidate => candidate.id === themeCtx?.stationDefault,
        )
          ? themeCtx?.stationDefault
          : undefined;
        const persistedFallbackId = validActiveId ?? validStationDefault;
        const fallback = remainingThemes.find(candidate => candidate.id === persistedFallbackId)
          ?? remainingThemes[0];
        const removedResolvedTheme = theme.id === activeId
          || theme.id === themeCtx?.stationActiveId
          || theme.id === themeCtx?.stationDefault
          || theme.id === themeCtx?.activeShow?.themeId;
        let fallbackSaved = false;
        if (removedResolvedTheme && !validActiveId && fallback) {
          // DELETE returns the freshly-listed safe registry even though it
          // omits `active`. Preserve a still-valid persisted station default;
          // only choose and save the first remaining id when that pointer was
          // itself deleted or invalid.
          fallbackSaved = await saveSettings({ theme: { active: fallback.id } });
        }
        // Removing the failed entry can wake its still-mounted observer. Stop
        // that race before either installing the receipt+persisted pointer or
        // leaving the exact cache absent. The combined entry is authoritative:
        // DELETE owns the remaining list and the secure settings write owns
        // the new active id.
        await queryClient.cancelQueries(
          { queryKey: adminThemeKeys.detail(), exact: true },
          { silent: true },
        );
        if (removedResolvedTheme && fallback && (validActiveId || fallbackSaved)) {
          queryClient.setQueryData(adminThemeKeys.detail(), {
            themes: remainingThemes,
            active: fallback.id,
          });
        } else {
          queryClient.removeQueries({ queryKey: adminThemeKeys.detail(), exact: true });
        }
        await themeCtx?.refreshThemes();
        notify.err(
          `Theme "${theme.name}" removed, but refresh failed: ${errorMessage(reconciled.error)}`,
        );
        return;
      }
      const next = reconciled.data.themes;
      // Deleting the theme a show pinned makes that pin unresolvable, so the
      // station default silently takes over — provenance just changed.
      await themeCtx?.refreshThemes();
      notify.ok(`removed "${theme.name}"`);
      if (theme.id === activeId && next[0]) await choose(next[0]);
    } catch (e) {
      notify.err(`Remove failed: ${errorMessage(e)}`);
    }
  };

  return (
    <>
      <SectionHeader
        eyebrow="skin & themes"
        title="The player’s layout and the station-wide palette."
        sub={<>The <strong>skin</strong> is the full-screen layout every listener sees; the <strong>theme</strong> is the palette it (and the admin UI) render in. Built-in themes ship with the controller; drop custom JSONs in <code>state/themes/</code> and hit <em>Refresh</em>.</>}
        metrics={[
          { n: activeSkinName, l: 'skin', accent: true },
          { n: themes ? String(themes.length) : '—', l: 'themes' },
        ]}
        manualHref="/manual/themes"
      />

      <Card title="Player skin" sub="the face every listener sees">
        <div className="grid gap-3">
          <SkinGallery activeSkinId={activeSkinId} busy={busy} onChoose={chooseSkin} />
          <div className="field-hint">
            Each skin is a different full-screen layout built on the same live
            data. This sets the station default; a listener can still pick a
            different skin for their own browser from the player’s palette menu.
            Applies live on the next poll, no restart.
          </div>
        </div>
      </Card>

      <Card title="Themes" sub="the station-wide palette">
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Btn sm tone="accent" onClick={() => { setEditing(null); setEditorOpen(true); }}>
              Create theme
            </Btn>
            <Btn sm onClick={refresh} disabled={refreshMutation.isPending || busy}>
              {refreshMutation.isPending ? 'Refreshing…' : 'Refresh'}
            </Btn>
          </div>
          <div className="field-hint">
            Describe a look in the editor and we&apos;ll draft the palette, or drop a JSON
            theme file in <code>state/themes/</code> and hit <em>Refresh</em>, no controller
            restart needed. The folder&apos;s <code>README.md</code> lists the format and the
            allowed token keys.
          </div>
          {error && (
            <div className="field-hint text-[var(--danger)]">
              Couldn’t load themes: {error}
            </div>
          )}
          <EffectiveThemeNotice
            activeSource={themeCtx?.activeSource ?? null}
            active={themeCtx?.stationActiveId ?? null}
            stationDefault={themeCtx?.stationDefault ?? null}
            activeShow={themeCtx?.activeShow ?? null}
            themes={themes}
            overrideId={themeCtx?.overrideId ?? null}
          />

          {!themes && !error && <SkeletonRows rows={4} />}
          {themes && (
            <div className="grid gap-2">
              {themes.map(t => {
                const isActive = t.id === activeId;
                return (
                  // basis-full: on a phone the swatch strip + name leaves no room
                  // beside Edit/Remove, so the picker takes the whole row and the
                  // actions wrap under it.
                  <div key={t.id} className="flex flex-wrap items-stretch gap-2 sm:flex-nowrap">
                    <button
                      type="button"
                      onClick={() => choose(t)}
                      disabled={busy}
                      className={cn(
                        'flex min-w-0 grow basis-full items-center gap-3 border p-3 text-left disabled:cursor-not-allowed disabled:opacity-60 sm:basis-0',
                        isActive
                          ? 'border-vermilion bg-accent-soft'
                          : 'border-ink bg-bg hover:bg-[var(--overlay)]',
                      )}
                    >
                      <span className="inline-flex shrink-0 border border-ink" aria-hidden="true">
                        {SWATCH_KEYS.map(k => (
                          <Swatch key={k} color={t.tokens[k]} />
                        ))}
                      </span>
                      <div className="grid min-w-0 flex-1 gap-0.5">
                        <span className="text-[12px] font-bold tracking-[0.12em] uppercase">
                          {t.name}
                        </span>
                        <span className="text-[11px] leading-[1.4] text-muted">
                          {t.description || (t.mode === 'dark' ? 'Dark palette' : 'Light palette')}
                        </span>
                      </div>
                      {isActive && <Pill tone="accent" dot>active</Pill>}
                    </button>
                    {!t.builtin && (
                      <>
                        <Btn
                          sm
                          onClick={() => { setEditing(t); setEditorOpen(true); }}
                          disabled={busy}
                          title="Edit this custom theme"
                        >
                          Edit
                        </Btn>
                        <Btn
                          sm
                          tone="danger"
                          onClick={() => setConfirmRemove(t)}
                          disabled={busy}
                          title="Remove this custom theme"
                        >
                          Remove
                        </Btn>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Card>

      <Card title="Tune-in overlay" sub="the full-bleed “tap to tune in” gate">
        <div className="field">
          <Label>Show the tune-in overlay</Label>
          <div className="flex items-center gap-2">
            <Seg
              options={[
                { id: 'on', label: 'On' },
                { id: 'off', label: 'Off' },
              ]}
              value={data?.values?.ui?.tuneInOverlay !== false ? 'on' : 'off'}
              onChange={id => { if (!busy) saveSettings({ ui: { tuneInOverlay: id === 'on' } }); }}
            />
          </div>
          <div className="field-hint">
            The full-screen “Tap to tune in” gate a new listener lands on. When
            off, the player loads paused with no takeover and listeners start the
            stream from the skin’s own play button; browsers can’t autoplay, so a
            tap is always needed somewhere. Applies live, no restart.
          </div>
        </div>
      </Card>

      <Card title="Booth Buddy" sub="the DJ-line mascot on the player">
        <div className="field">
          <Label>Show the Booth Sprite</Label>
          <div className="flex items-center gap-2">
            <Seg
              options={[
                { id: 'on', label: 'On' },
                { id: 'off', label: 'Off' },
              ]}
              value={data?.values?.ui?.boothBuddy === true ? 'on' : 'off'}
              onChange={id => { if (!busy) saveSettings({ ui: { boothBuddy: id === 'on' } }); }}
            />
          </div>
          <div className="field-hint">
            A small animated mascot that leads the DJ line on the listener player,
            reacting to what the DJ is doing (on-air, picking, or idle), and tap it
            for a reaction. When off, the line falls back to the classic ♪/◇ marker.
            Applies live, no restart.
          </div>
        </div>
      </Card>

      <ThemeEditorModal
        open={editorOpen}
        onOpenChange={setEditorOpen}
        editing={editing}
        adminFetch={adminFetch}
        onSaved={onSaved}
      />

      <V3AlertDialog
        open={confirmRemove != null}
        onOpenChange={(o) => { if (!o) setConfirmRemove(null); }}
        title="Remove theme"
        description={
          confirmRemove
            ? `Remove the custom theme "${confirmRemove.name}"? This deletes state/themes/${confirmRemove.id}.json permanently.`
            : ''
        }
        confirmLabel="remove"
        danger
        onConfirm={() => { if (confirmRemove) remove(confirmRemove); setConfirmRemove(null); }}
      />
    </>
  );
}
