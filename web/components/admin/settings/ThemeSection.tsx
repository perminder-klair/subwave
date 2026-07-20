'use client';

import type { ChangeEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useDynamicStyle } from '../../../hooks/useDynamicStyle';
import { notify, errorMessage } from '../../../lib/notify';
import { applyTheme, cacheTheme, resolveDisplayFont } from '../../../lib/theme';
import { V3AlertDialog } from '../../ui/alert-dialog';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Card, Btn, Pill, Seg } from '../ui';
import { AiFill } from '../AiFill';
import { cn } from '../../../lib/cn';
import { SkinGallery } from './SkinGallery';
import { DEFAULT_SKIN_ID, SKINS } from '../../skins';
import { THEME_TOKENS, THEME_TOKEN_KEYS, SWATCH_KEYS, DISPLAY_FONT_IDS } from '../../../lib/theme-tokens.generated';
import {
  SectionHeader,
  type SettingsData, type SaveSettings,
} from './shared';

interface ThemeSectionProps {
  data: SettingsData;
  busy: boolean;
  saveSettings: SaveSettings;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
}

interface ThemeDef {
  id: string;
  name: string;
  description?: string;
  mode: 'light' | 'dark';
  tokens: Record<string, string>;
  // Set by the controller's /themes responses. Built-ins ship in the image and
  // can't be removed; only user themes (state/themes/*.json) show a Remove button.
  builtin?: boolean;
}

// SWATCH_KEYS (paper / ink / accent / overlay — reads the palette at a glance,
// overlay doubles as the hover wash) + THEME_TOKENS come from the generated
// registry mirror now, so this form, the controller validator and the no-flash
// bootstrap can't drift.

// Each swatch is its own ref because useDynamicStyle wants a single element
// per call. The arbitrary token values can't go through Tailwind utilities
// (issue #50 bans the inline `style` prop), so we route them through the
// DOM-API hook instead.
function Swatch({ color }: { color?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useDynamicStyle(ref, { background: color || 'transparent' });
  return <span ref={ref} className="h-7 w-7" aria-hidden="true" />;
}

// Live preview — applies the in-progress token map (+ resolved display font) to
// a scoped subtree so the operator sees the palette they're building without
// touching the live page theme. Tokens are set via the DOM API (ref), not the
// inline style prop (issue #50); omitted tokens derive from the base palette via
// the globals.css :root fallbacks, exactly like the real system.
function ThemePreview({ tokens, mode }: { tokens: Record<string, string>; mode: 'light' | 'dark' }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    for (const key of THEME_TOKEN_KEYS) el.style.removeProperty(key);
    for (const [k, v] of Object.entries(tokens)) {
      if (!v.trim()) continue;
      el.style.setProperty(k, k === '--display-font' ? resolveDisplayFont(v) : v);
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

// Create a custom theme from a description (AI-drafted) or by hand, then save it
// as state/themes/<id>.json via POST /themes. Tokens are editable before save so
// the operator reviews the palette first.
function ThemeCreator({
  adminFetch,
  onSaved,
}: {
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  onSaved: (themes: ThemeDef[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [mode, setMode] = useState<'light' | 'dark'>('dark');
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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

  const reset = () => {
    setName(''); setDescription(''); setTokens({}); setErr(null); setOpen(false);
  };

  const save = async () => {
    if (!name.trim() || saving) return;
    setSaving(true); setErr(null);
    try {
      // Drop blank tokens — an omitted token derives from the base palette in
      // globals.css, and an empty value would fail the typed validator.
      const cleaned = Object.fromEntries(Object.entries(tokens).filter(([, v]) => v.trim() !== ''));
      const r = await adminFetch('/themes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), description: description.trim(), mode, tokens: cleaned }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string; themes?: ThemeDef[] };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      onSaved(j.themes ?? []);
      notify.ok(`saved "${name.trim()}"`);
      reset();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <Btn sm tone="accent" onClick={() => setOpen(true)}>Create theme with AI</Btn>
    );
  }

  return (
    <div className="grid w-full basis-full gap-3 border border-ink p-3">
      <AiFill<{ name?: string; description?: string; mode?: 'light' | 'dark'; tokens?: Record<string, string> }>
        endpoint="/generate/theme"
        resultKey="theme"
        adminFetch={adminFetch}
        placeholder="e.g. a warm sepia newspaper, easy on the eyes"
        extra={{ mode }}
        onApply={applyDraft}
      />
      <div className="grid grid-cols-[1fr_auto] items-end gap-3">
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
        {THEME_TOKENS.map(({ key, label, type, group }, i) => (
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
                  <option value="">default (fraunces)</option>
                  {DISPLAY_FONT_IDS.map(id => <option key={id} value={id}>{id}</option>)}
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
      {err && <span className="text-[12px] text-[var(--danger)]">{err}</span>}
      <div className="flex gap-2">
        <Btn sm tone="accent" onClick={save} disabled={saving || !name.trim()}>
          {saving ? 'Saving…' : 'Save theme'}
        </Btn>
        <Btn sm onClick={reset} disabled={saving}>Cancel</Btn>
      </div>
    </div>
  );
}

export function ThemeSection({ data, busy, saveSettings, adminFetch }: ThemeSectionProps) {
  const [themes, setThemes] = useState<ThemeDef[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<ThemeDef | null>(null);

  const activeId = data.values?.theme?.active;
  const PUBLIC_API = (process.env.NEXT_PUBLIC_API_URL as string | undefined) || '/api';

  // Skin = the player's full-screen layout (ui.skin); distinct from the theme,
  // which is the palette. Both live in this section now. Save through the same
  // settings flow — the player picks it up on its next /state poll.
  const activeSkinId = SKINS.some(s => s.id === data.values?.ui?.skin)
    ? (data.values?.ui?.skin as string)
    : DEFAULT_SKIN_ID;
  const activeSkinName = SKINS.find(s => s.id === activeSkinId)?.name ?? 'Classic';
  const chooseSkin = (id: string) => { if (!busy) saveSettings({ ui: { skin: id } }); };

  // Theme list is public — fetch through the unauthenticated /themes endpoint
  // so a signed-out admin still sees swatches while signing in.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${PUBLIC_API}/themes`);
        if (!r.ok || cancelled) return;
        const j = (await r.json()) as { themes: ThemeDef[] };
        setThemes(j.themes);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [PUBLIC_API]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const r = await adminFetch('/themes/refresh', { method: 'POST' });
      const j = (await r.json().catch(() => ({}))) as { error?: string; themes?: ThemeDef[] };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      const next = j.themes ?? [];
      setThemes(next);
      notify.ok(`reloaded, ${next.length} theme${next.length === 1 ? '' : 's'}`);
    } catch (e) {
      notify.err(`Refresh failed: ${errorMessage(e)}`);
    } finally {
      setRefreshing(false);
    }
  };

  const choose = async (theme: ThemeDef) => {
    if (theme.id === activeId || busy) return;
    // Save through the existing settings flow. ThemeBootstrap's 30 s poll
    // would pick this up eventually, but the admin viewing this page wants
    // the swatch swap to feel instant — apply locally on click.
    applyTheme(theme);
    cacheTheme(theme);
    await saveSettings({ theme: { active: theme.id } });
  };

  // Delete a user theme's state/themes/<id>.json. If it was the active theme,
  // fall back to the first remaining one (built-ins lead the list) through the
  // normal selection flow so nothing points at a now-missing id.
  const remove = async (theme: ThemeDef) => {
    try {
      const r = await adminFetch(`/themes/${encodeURIComponent(theme.id)}`, { method: 'DELETE' });
      const j = (await r.json().catch(() => ({}))) as { error?: string; themes?: ThemeDef[] };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      const next = j.themes ?? [];
      setThemes(next);
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
        sub={<>The <strong>skin</strong> is the full-screen layout every listener sees; the <strong>theme</strong> is the palette it — and the admin UI — render in. Built-in themes ship with the controller; drop custom JSONs in <code>state/themes/</code> and hit <em>Refresh</em>.</>}
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
            stream from the skin’s own play button — browsers can’t autoplay, so a
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
            reacting to what the DJ is doing — on-air, picking, or idle — and tap it
            for a reaction. When off, the line falls back to the classic ♪/◇ marker.
            Applies live, no restart.
          </div>
        </div>
      </Card>

      <Card title="Create theme" sub="state/themes/*.json">
        <div className="grid gap-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <Btn sm onClick={refresh} disabled={refreshing || busy}>
              {refreshing ? 'Refreshing…' : 'Refresh themes'}
            </Btn>
            <ThemeCreator adminFetch={adminFetch} onSaved={setThemes} />
          </div>
          <div className="field-hint">
            Describe a look above and we&apos;ll draft the palette, or drop a JSON
            theme file in <code>state/themes/</code> and click <em>Refresh</em>,
            no controller restart needed. The folder includes a
            <code>README.md</code> with the format and the allowed token keys.
          </div>
        </div>
      </Card>

      <Card title="Picker" sub="active station theme">
        {error && (
          <div className="field-hint text-[var(--danger)]">
            Couldn’t load themes: {error}
          </div>
        )}
        {!themes && !error && (
          <div className="text-[13px] text-muted italic">loading…</div>
        )}
        {themes && (
          <div className="grid gap-2">
            {themes.map(t => {
              const isActive = t.id === activeId;
              return (
                <div key={t.id} className="flex items-stretch gap-2">
                  <button
                    type="button"
                    onClick={() => choose(t)}
                    disabled={busy}
                    className={cn(
                      'flex min-w-0 flex-1 items-center gap-3 border p-3 text-left disabled:cursor-not-allowed disabled:opacity-60',
                      isActive
                        ? 'border-vermilion bg-[var(--ink-softer)]'
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
                    <Btn
                      sm
                      tone="danger"
                      onClick={() => setConfirmRemove(t)}
                      disabled={busy}
                      title="Remove this custom theme"
                    >
                      Remove
                    </Btn>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

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
