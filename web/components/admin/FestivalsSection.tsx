'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAdminAuth } from '../../lib/adminAuth';
import { notify, errorMessage } from '../../lib/notify';
import { Card, Btn, Eyebrow, Pill } from './ui';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '../ui/select';
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

function monthDayLabel(f: Festival): string {
  const m = MONTH_NAMES[f.month - 1] || String(f.month);
  return `${m} ${f.day}`;
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
      setFestivals([...loaded].sort((a, b) => a.month - b.month || a.day - b.day));
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
      setFestivals(updated);
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

  return (
    <section className="grid gap-6">
      <div>
        <Eyebrow>festivals</Eyebrow>
        <h2 className="text-[24px] font-bold tracking-[0.04em]">Festival calendar.</h2>
        <p className="mt-2 text-[13px] leading-[1.5] text-muted">
          Mood-forming dates the DJ leans into around the year. Add your local holidays,
          regional celebrations, or personal landmarks — the station&apos;s mood shifts
          to match the nearest active festival.
        </p>
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
        <>
          <Card title="Add festival" sub="define a new calendar entry">
            <div className="grid gap-4">
              {editing ? (
                <div className="grid gap-4 rounded border border-ink p-4">
                  <div className="flex items-center justify-between">
                    <Eyebrow>{editIdx !== null ? 'Editing festival' : 'New festival'}</Eyebrow>
                    <Btn sm tone="danger" onClick={cancelEdit}>cancel</Btn>
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
                    <Label>Name</Label>
                    <Input
                      value={editing.name}
                      onChange={e => updateField('name', e.target.value)}
                      placeholder="e.g. New Year's Day"
                      maxLength={80}
                    />
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
                      A brief note the DJ can weave into its on-air talk when the festival
                      is active — also shown in the list below.
                    </div>
                  </div>

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
                    <div className="field-hint mt-1">
                      The DJ leans into this mood when the festival is active —
                      music selection and spoken tone shift to match.
                    </div>
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
                    <div className="field-hint mt-1">
                      Number of days before and after the festival date where the mood is
                      active. e.g. 3 = the mood spans a full week around the day.
                    </div>
                  </div>

                  <Btn onClick={commitEdit} disabled={busy || !editing.name.trim()}>
                    {editIdx !== null ? 'Save changes' : 'Add festival'}
                  </Btn>
                </div>
              ) : (
                <Btn sm onClick={startAdd}>Add festival</Btn>
              )}
            </div>
          </Card>

          <Card
            title="Festivals"
            sub={`${festivals.length} calendar entr${festivals.length === 1 ? 'y' : 'ies'}`}
          >
            {festivals.length === 0 ? (
              <div className="text-[13px] text-muted italic">
                No festivals defined. Add one to get started.
              </div>
            ) : (
              // grid-cols-1 pins the track to minmax(0,1fr) so a long,
              // nowrap-truncated description can't blow the column out to its
              // max-content width and shove the pills/buttons past the card
              // edge (issue #898). shrink-0 on the fixed controls sends all the
              // slack to the truncating name/description column.
              <div className="grid grid-cols-1 gap-2">
                {festivals.map((f, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-3 border border-ink bg-bg p-3"
                  >
                    <Pill tone="ink" className="shrink-0">{monthDayLabel(f)}</Pill>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12px] font-bold tracking-[0.08em] uppercase">
                        {f.name}
                      </div>
                      {f.description ? (
                        <div className="truncate text-[12px] text-muted">{f.description}</div>
                      ) : null}
                    </div>
                    <Pill className="shrink-0">{f.mood}</Pill>
                    {f.windowDays ? (
                      <Pill tone="ink" className="shrink-0">{f.windowDays}d window</Pill>
                    ) : null}
                    <div className="flex shrink-0 items-center gap-1">
                      <Btn sm onClick={() => startEdit(i)} disabled={busy}>
                        Edit
                      </Btn>
                      <Btn sm tone="danger" onClick={() => setConfirmDelete(i)} disabled={busy}>
                        Remove
                      </Btn>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      )}

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
