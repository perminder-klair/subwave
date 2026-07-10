'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAdminAuth } from '../../lib/adminAuth';
import { notify, errorMessage } from '../../lib/notify';
import { Card, Btn, Eyebrow } from './ui';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '../ui/select';
import { Modal } from '../ui/modal';
import { V3AlertDialog } from '../ui/alert-dialog';

interface Festival {
  month: number;
  day: number;
  name: string;
  mood: string;
  description?: string;
  windowDays?: number;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const DAYS_IN_MONTH = (m: number) => {
  if (m === 2) return 29;
  if ([4, 6, 9, 11].includes(m)) return 30;
  return 31;
};

const EMPTY_FESTIVAL: Festival = {
  month: 1,
  day: 1,
  name: '',
  mood: 'festival',
  description: '',
  windowDays: 0,
};

const sortFestivals = (list: Festival[]) =>
  [...list].sort((a, b) => a.month - b.month || a.day - b.day);

// Display-only date math (the controller owns the real window logic in
// getFestivalContext): `active` = today falls inside the ±window, `until` =
// days to the next occurrence, wrapping the year boundary.
function festivalTiming(f: Festival, now: Date) {
  const dayMs = 86400000;
  const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const diffs = [-1, 0, 1].map(dy =>
    Math.round((new Date(now.getFullYear() + dy, f.month - 1, f.day).getTime() - t0) / dayMs),
  );
  return {
    active: diffs.some(d => Math.abs(d) <= (f.windowDays || 0)),
    until: Math.min(...diffs.filter(d => d >= 0)),
  };
}

export default function FestivalsSection() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [festivals, setFestivals] = useState<Festival[] | null>(null);
  const [moods, setMoods] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Festival | null>(null);
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await adminFetch('/settings');
      if (!r.ok) throw new Error(`failed (${r.status})`);
      const j = (await r.json()) as any;
      // The controller validates + normalises festivals on every save
      // (validateFestivalsStrict), so trust the shape as-is here.
      const vals = j?.values?.festivals;
      const loaded: Festival[] = Array.isArray(vals) ? vals : [];
      setFestivals(sortFestivals(loaded));
      // Mood vocabulary comes from the server (SHOW_MOODS via tts.moods) so
      // the dropdown never drifts from what the controller will accept.
      setMoods(Array.isArray(j?.tts?.moods) ? j.tts.moods : []);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [adminFetch]);

  useEffect(() => {
    if (!hydrated || needsAuth) return;
    void load();
  }, [hydrated, needsAuth, load]);

  const save = async (updated: Festival[]) => {
    setBusy(true);
    try {
      const payload = updated.map(f => ({
        month: f.month,
        day: f.day,
        name: f.name,
        mood: f.mood,
        description: f.description || '',
        windowDays: f.windowDays || 0,
      }));
      const r = await adminFetch('/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ festivals: payload }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      setFestivals(sortFestivals(updated));
      setEditing(null);
      setEditIdx(null);
      notify.ok(`${updated.length} festival${updated.length === 1 ? '' : 's'} saved`);
    } catch (e) {
      notify.err(`Save failed: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const startAdd = () => {
    setEditing({ ...EMPTY_FESTIVAL });
    setEditIdx(null);
  };

  const startEdit = (idx: number) => {
    if (!festivals || !festivals[idx]) return;
    setEditing({ ...festivals[idx] });
    setEditIdx(idx);
  };

  const cancelEdit = () => {
    setEditing(null);
    setEditIdx(null);
  };

  const commitEdit = () => {
    if (!festivals || !editing) return;
    const name = editing.name.trim();
    if (!name) {
      notify.err('Name is required');
      return;
    }
    let updated: Festival[];
    if (editIdx !== null) {
      updated = festivals.map((f, i) => (i === editIdx ? editing : f));
    } else {
      updated = [...festivals, editing];
    }
    void save(updated);
  };

  const remove = (idx: number) => {
    if (!festivals) return;
    const updated = festivals.filter((_, i) => i !== idx);
    void save(updated);
  };

  const updateField = <K extends keyof Festival>(field: K, value: Festival[K]) => {
    if (!editing) return;
    setEditing({ ...editing, [field]: value });
  };

  if (!hydrated || needsAuth) return null;

  // Group the (already month/day-sorted) list into month sections, keeping the
  // original index so a row click edits the right entry. The soonest upcoming
  // festival gets an "up next" tag; anything inside its window reads "now".
  const now = new Date();
  const timings = (festivals || []).map(f => festivalTiming(f, now));
  const nextIdx = timings.length
    ? timings.reduce((best, t, i) => (t.until < (timings[best]?.until ?? Infinity) ? i : best), 0)
    : -1;
  const months: Array<{ month: number; rows: Array<{ f: Festival; idx: number }> }> = [];
  (festivals || []).forEach((f, idx) => {
    const last = months[months.length - 1];
    if (last && last.month === f.month) last.rows.push({ f, idx });
    else months.push({ month: f.month, rows: [{ f, idx }] });
  });

  return (
    <section className="grid gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Eyebrow>festivals</Eyebrow>
          <h2 className="text-[24px] font-bold tracking-[0.04em]">Festival calendar.</h2>
          <p className="mt-2 text-[13px] leading-[1.5] text-muted">
            Mood-forming dates the DJ leans into around the year. Add your local holidays,
            regional celebrations, or personal landmarks — the station&apos;s mood shifts
            to match the nearest active festival.
          </p>
        </div>
        <Btn tone="accent" className="shrink-0" onClick={startAdd} disabled={festivals === null}>
          Add festival
        </Btn>
      </div>

      {err && (
        <Card>
          <div className="text-[var(--danger)]">{err}</div>
        </Card>
      )}

      {festivals === null && !err && (
        <div className="text-[13px] text-muted italic">loading…</div>
      )}

      {festivals !== null && (
        <Card
          title="Calendar"
          sub={`${festivals.length} date${festivals.length === 1 ? '' : 's'} · click one to edit`}
        >
          {festivals.length === 0 ? (
            <div className="text-[13px] text-muted italic">
              No festivals defined. Add one to get started.
            </div>
          ) : (
            <div className="grid">
              {months.map(({ month, rows }) => (
                <div key={month}>
                  <div className="mt-4 mb-1 flex items-center gap-3 first:mt-0">
                    <span className="caption">{MONTH_NAMES[month - 1]}</span>
                    <span className="flex-1 border-t border-dashed border-separator-strong" />
                  </div>
                  {rows.map(({ f, idx }) => (
                    <button
                      key={idx}
                      type="button"
                      disabled={busy}
                      onClick={() => startEdit(idx)}
                      className="grid w-full cursor-pointer grid-cols-[30px_1fr_auto] items-baseline gap-x-3 px-1.5 py-2 text-left hover:bg-[var(--ink-soft)]"
                    >
                      <span className="mono-num text-[12px] text-muted">
                        {String(f.day).padStart(2, '0')}
                      </span>
                      <span className="min-w-0">
                        <span className="flex items-baseline gap-2.5">
                          <span className="truncate text-[13px] font-bold">{f.name}</span>
                          {timings[idx]?.active ? (
                            <span className="flex-none text-[9px] font-bold tracking-[0.2em] text-vermilion uppercase">
                              ● now
                            </span>
                          ) : idx === nextIdx ? (
                            <span className="flex-none text-[9px] font-bold tracking-[0.2em] text-muted uppercase">
                              up next · {timings[idx]?.until}d
                            </span>
                          ) : null}
                        </span>
                        {f.description ? (
                          <span className="block truncate text-[11px] leading-[1.5] text-muted">
                            {f.description}
                          </span>
                        ) : null}
                      </span>
                      <span className="flex items-baseline gap-2.5 text-[10px] tracking-[0.08em] text-muted">
                        <span>{f.mood}</span>
                        {f.windowDays ? <span className="mono-num">±{f.windowDays}d</span> : null}
                      </span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      <Modal
        open={editing !== null}
        onOpenChange={o => { if (!o) cancelEdit(); }}
        title={editIdx !== null ? 'edit festival' : 'new festival'}
        sub={editIdx !== null && editing ? editing.name : undefined}
        width={520}
        footer={
          <div className="flex w-full items-center justify-between gap-2">
            {editIdx !== null ? (
              <Btn sm tone="danger" onClick={() => setConfirmDelete(editIdx)} disabled={busy}>
                Remove
              </Btn>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-2">
              <Btn sm onClick={cancelEdit} disabled={busy}>Cancel</Btn>
              <Btn
                sm
                tone="accent"
                onClick={commitEdit}
                disabled={busy || !editing?.name.trim()}
              >
                {busy ? 'Saving…' : editIdx !== null ? 'Save changes' : 'Add festival'}
              </Btn>
            </div>
          </div>
        }
      >
        {editing && (
          <div className="grid gap-4">
            <div className="field">
              <Label>Name</Label>
              <Input
                value={editing.name}
                onChange={e => updateField('name', e.target.value)}
                placeholder="e.g. New Year's Day"
                maxLength={80}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="field">
                <Label>Month</Label>
                <Select
                  value={String(editing.month)}
                  onValueChange={v => {
                    // Clamp the day so switching e.g. Oct 31 → February
                    // can't leave an impossible date in the form.
                    const month = Number(v);
                    setEditing(cur => cur && ({
                      ...cur,
                      month,
                      day: Math.min(cur.day, DAYS_IN_MONTH(month)),
                    }));
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MONTH_NAMES.map((name, i) => (
                      <SelectItem key={i + 1} value={String(i + 1)}>{name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="field">
                <Label>Day</Label>
                <Select
                  value={String(editing.day)}
                  onValueChange={v => updateField('day', Number(v))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: DAYS_IN_MONTH(editing.month) }, (_, i) => (
                      <SelectItem key={i + 1} value={String(i + 1)}>{i + 1}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="field">
              <Label>Description <span className="text-muted">(optional)</span></Label>
              <Input
                value={editing.description || ''}
                onChange={e => updateField('description', e.target.value)}
                placeholder="Short note about the festival"
                maxLength={200}
              />
              <div className="field-hint mt-1">
                A brief note the DJ can weave into its on-air talk when the festival is active.
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="field">
                <Label>Mood</Label>
                <Select
                  value={editing.mood}
                  onValueChange={v => updateField('mood', v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {moods.map(m => (
                      <SelectItem key={m} value={m}>{m}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="field">
                <Label>Window <span className="text-muted">(days)</span></Label>
                <Input
                  type="number"
                  min={0}
                  max={14}
                  value={String(editing.windowDays ?? 0)}
                  onChange={e => updateField('windowDays', Math.max(0, Math.min(14, Number(e.target.value) || 0)))}
                />
              </div>
            </div>
            <div className="field-hint -mt-2">
              Music selection and spoken tone shift into the mood for the window around
              the date — e.g. a 3-day window spans a full week.
            </div>
          </div>
        )}
      </Modal>

      <V3AlertDialog
        open={confirmDelete != null}
        onOpenChange={(o) => { if (!o) setConfirmDelete(null); }}
        title="Remove festival"
        description={
          confirmDelete != null && festivals
            ? `Remove "${festivals[confirmDelete]?.name}" from the festival calendar?`
            : ''
        }
        confirmLabel="Remove"
        danger
        onConfirm={() => {
          if (confirmDelete != null) { remove(confirmDelete); setConfirmDelete(null); }
        }}
      />
    </section>
  );
}
