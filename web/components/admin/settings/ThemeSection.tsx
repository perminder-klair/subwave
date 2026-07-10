'use client';

import type { ChangeEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useDynamicStyle } from '../../../hooks/useDynamicStyle';
import { notify, errorMessage } from '../../../lib/notify';
import { applyTheme, cacheTheme } from '../../../lib/theme';
import { V3AlertDialog } from '../../ui/alert-dialog';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Card, Btn, Pill, Seg } from '../ui';
import { AiFill } from '../AiFill';
import { cn } from '../../../lib/cn';
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

// Swatch columns shown per theme card — chosen to read the palette at a
// glance: paper, ink, accent, and the muted overlay (which doubles as the
// hover wash, so it telegraphs interactive state).
const SWATCH_KEYS = ['--bg', '--ink', '--accent', '--overlay'] as const;

// Each swatch is its own ref because useDynamicStyle wants a single element
// per call. The arbitrary token values can't go through Tailwind utilities
// (issue #50 bans the inline `style` prop), so we route them through the
// DOM-API hook instead.
function Swatch({ color }: { color?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useDynamicStyle(ref, { background: color || 'transparent' });
  return <span ref={ref} className="h-7 w-7" aria-hidden="true" />;
}

// The 7 themable tokens (mirrors controller THEME_TOKEN_KEYS) with human
// labels for the create form. Generated drafts and manual edits both fill these.
const THEME_TOKENS: { key: string; label: string }[] = [
  { key: '--bg', label: 'background' },
  { key: '--ink', label: 'text' },
  { key: '--muted', label: 'muted text' },
  { key: '--accent', label: 'accent' },
  { key: '--overlay', label: 'overlay' },
  { key: '--soft-border', label: 'border' },
  { key: '--field', label: 'field' },
];

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
      const r = await adminFetch('/themes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), description: description.trim(), mode, tokens }),
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
        {THEME_TOKENS.map(({ key, label }) => (
          <div key={key} className="grid grid-cols-[auto_5.5rem_1fr] items-center gap-2">
            <span className="inline-flex shrink-0 border border-ink"><Swatch color={tokens[key]} /></span>
            <span className="text-[11px] tracking-[0.12em] text-muted uppercase">{label}</span>
            <Input
              value={tokens[key] || ''}
              maxLength={100}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setTokens(prev => ({ ...prev, [key]: e.target.value }))}
              placeholder="#000000 or rgba(…)"
              className="font-mono text-[12px]"
            />
          </div>
        ))}
      </div>
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
        eyebrow="theme"
        title="Station-wide visual theme."
        sub={<>Every listener and the admin UI render with this palette. Built-ins ship with the controller; drop custom JSONs in <code>state/themes/</code> and hit <em>Refresh</em>.</>}
        metrics={[
          {
            n: themes ? String(themes.length) : '—',
            l: 'themes',
            accent: true,
          },
        ]}
        manualHref="/manual/themes"
      />

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
