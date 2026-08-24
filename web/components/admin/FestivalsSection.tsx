'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  useController, useFieldArray, useWatch, type Control,
} from 'react-hook-form';
import { z } from 'zod';
import { useAdminAuth } from '../../lib/adminAuth';
import { AdminResponseError } from '../../lib/admin-query';
import { notify, errorMessage } from '../../lib/notify';
import { useZodForm, applyServerFieldErrors, fieldAria } from '@/lib/form';
import { TextField, SelectField } from '@/lib/form-fields';
import { Card, Btn } from './ui';
import { SectionHeader } from './settings/shared';
import { Field, FieldLabel, FieldError } from '@/components/ui/field';
import { Input } from '../ui/input';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '../ui/select';
import { Modal } from '../ui/modal';
import { V3AlertDialog } from '../ui/alert-dialog';
import { SkeletonRows } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import {
  useSettingsMutation,
  useSettingsQuery,
} from './settings/queries';
import {
  festivalsSchema,
  SETTINGS_FESTIVAL_DESCRIPTION_MAX,
  SETTINGS_FESTIVAL_NAME_MAX,
  SETTINGS_FESTIVAL_WINDOW_DAYS_MAX,
} from '@/lib/schemas.generated';

// festivalsSchema is a factory, and a hand-validated
// `z.unknown().superRefine().transform()` rather than a structural array, so
// `z.input<>` collapses to `unknown` and no nested path type-checks as a
// FieldPath. `ReturnType`/`z.output` pull the real output shape at the type
// level only; the per-render schema below is what validates at runtime.
type FestivalsArray = z.output<ReturnType<typeof festivalsSchema>>;
type FestivalsFormValues = { festivals: FestivalsArray };
type Festival = FestivalsArray[number];
type FestivalSettingsData = {
  values?: { festivals?: unknown };
  tts?: { moods?: unknown };
};

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

// Display only — the controller owns the real window logic in
// getFestivalContext. `until` wraps the year boundary.
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

// The modal's fields, bound into the `festivals` field array at `idx`. Its own
// component rather than inline JSX so its hook calls are unconditional from its
// own perspective; the parent mounts it only while a row is open.
//
// Name, description and mood bind through the shared TextField/SelectField, and
// their ids embed the literal RHF path (dots included — legal in a DOM id).
// Month, day and windowDays stay hand-rolled on useController + fieldAria:
// month's onChange also clamps day and windowDays clamps itself, neither of
// which the bound components' plain field.onChange can express.
function FestivalModalFields({
  idx,
  control,
  moods,
  fieldId,
}: {
  idx: number;
  control: Control<FestivalsFormValues>;
  moods: string[];
  fieldId: string;
}) {
  const monthField = useController({ control, name: `festivals.${idx}.month` });
  const dayField = useController({ control, name: `festivals.${idx}.day` });
  const windowField = useController({ control, name: `festivals.${idx}.windowDays` });

  const monthAria = fieldAria(`${fieldId}-month`, monthField.fieldState.error);
  const dayAria = fieldAria(`${fieldId}-day`, dayField.fieldState.error);
  const windowAria = fieldAria(`${fieldId}-window`, windowField.fieldState.error);

  const month = monthField.field.value;
  const moodOptions = moods.map(m => ({ value: m, label: m }));

  return (
    <div className="grid gap-4">
      <TextField
        control={control}
        name={`festivals.${idx}.name`}
        label="Name"
        placeholder="e.g. New Year's Day"
        maxLength={SETTINGS_FESTIVAL_NAME_MAX}
      />

      <div className="grid grid-cols-2 gap-3">
        <Field data-invalid={monthAria.invalid || undefined}>
          <FieldLabel {...monthAria.labelProps}>Month</FieldLabel>
          <Select
            value={String(month)}
            onValueChange={v => {
              // Clamp the day so Oct 31 → February can't leave an
              // impossible date in the form. The schema owns the actual
              // month/day validity rule — this is display convenience only.
              const nextMonth = Number(v);
              monthField.field.onChange(nextMonth);
              const maxDay = DAYS_IN_MONTH(nextMonth);
              if (dayField.field.value > maxDay) dayField.field.onChange(maxDay);
            }}
          >
            <SelectTrigger {...monthAria.controlProps} onBlur={monthField.field.onBlur} ref={monthField.field.ref}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MONTH_NAMES.map((name, i) => (
                <SelectItem key={i + 1} value={String(i + 1)}>{name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldError {...monthAria.errorProps} errors={monthField.fieldState.error ? [monthField.fieldState.error] : undefined} />
        </Field>

        <Field data-invalid={dayAria.invalid || undefined}>
          <FieldLabel {...dayAria.labelProps}>Day</FieldLabel>
          <Select
            value={String(dayField.field.value)}
            onValueChange={v => dayField.field.onChange(Number(v))}
          >
            <SelectTrigger {...dayAria.controlProps} onBlur={dayField.field.onBlur} ref={dayField.field.ref}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: DAYS_IN_MONTH(month) }, (_, i) => (
                <SelectItem key={i + 1} value={String(i + 1)}>{i + 1}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldError {...dayAria.errorProps} errors={dayField.fieldState.error ? [dayField.fieldState.error] : undefined} />
        </Field>
      </div>

      <TextField
        control={control}
        name={`festivals.${idx}.description`}
        label="Description (optional)"
        placeholder="Short note about the festival"
        description="A short note your DJ can weave into its chat while the festival is on."
        maxLength={SETTINGS_FESTIVAL_DESCRIPTION_MAX}
      />

      <div className="grid grid-cols-2 gap-3">
        <SelectField
          control={control}
          name={`festivals.${idx}.mood`}
          label="Mood"
          options={moodOptions}
        />

        <Field data-invalid={windowAria.invalid || undefined}>
          <FieldLabel {...windowAria.labelProps}>
            Window <span className="text-muted">(days)</span>
          </FieldLabel>
          <Input
            {...windowAria.controlProps}
            type="number"
            min={0}
            max={SETTINGS_FESTIVAL_WINDOW_DAYS_MAX}
            value={String(windowField.field.value)}
            onChange={e => {
              const n = Math.max(
                0,
                Math.min(SETTINGS_FESTIVAL_WINDOW_DAYS_MAX, Number(e.target.value) || 0),
              );
              windowField.field.onChange(n);
            }}
            onBlur={windowField.field.onBlur}
            ref={windowField.field.ref}
          />
          <FieldError {...windowAria.errorProps} errors={windowField.fieldState.error ? [windowField.fieldState.error] : undefined} />
        </Field>
      </div>
      <div className="field-hint -mt-2">
        Music and spoken tone shift into the mood for the days around the date — a 3-day
        window covers a full week.
      </div>
    </div>
  );
}

export default function FestivalsSection() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const settingsQuery = useSettingsQuery<FestivalSettingsData>({
    adminFetch,
    enabled: hydrated && !needsAuth,
  });
  const [loaded, setLoaded] = useState(false);
  const [moods, setMoods] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Which-row-is-open UI state, kept out of the form. `editIdx` is the
  // festivals[] index open in the modal for BOTH add and edit — an "add"
  // appends a blank row immediately so its fields bind through the same field
  // array. `editing` distinguishes the two on Cancel: remove the fresh append,
  // or revert the edit to the snapshot taken on open.
  const [editing, setEditing] = useState(false);
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const editSnapshot = useRef<Festival | null>(null);
  const appliedRevisionRef = useRef(0);
  const pendingSettingsRef = useRef<{ revision: number; data: FestivalSettingsData } | null>(null);
  const fieldId = useId();

  // moodNames is nullable on the shared context, where null means "this caller
  // cannot check that rule". The browser has the live list, so pass it — that's
  // what makes the editor refuse a dead mood exactly when the controller would.
  // Memoised because a factory schema rebuilds the resolver on every render.
  const schema = useMemo(
    () => z.object({ festivals: festivalsSchema({ moodNames: moods }) }),
    [moods],
  );
  const form = useZodForm(schema, { festivals: [] });
  // Widens the control's declared `{ festivals: unknown }` (see the schema
  // comment at the top of this file) to the schema's OUTPUT type — the type
  // every row really holds, since the form is seeded only from server data or
  // EMPTY_FESTIVAL. Type-level only; same object at runtime.
  const arrayControl = form.control as unknown as Control<FestivalsFormValues>;
  const { fields, append, update, remove: removeField } = useFieldArray({
    control: arrayControl,
    name: 'festivals',
    keyName: '_rhfKey',
  });
  const watchedFestivals = useWatch({ control: arrayControl, name: 'festivals' }) ?? [];

  const saveMutation = useSettingsMutation<FestivalSettingsData>({ adminFetch });

  useEffect(() => {
    if (settingsQuery.error) {
      setErr(errorMessage(settingsQuery.error));
      return;
    }
    const revision = settingsQuery.dataUpdatedAt;
    if (settingsQuery.data && revision && appliedRevisionRef.current !== revision) {
      pendingSettingsRef.current = { revision, data: settingsQuery.data };
    }
    const pending = pendingSettingsRef.current;
    if (!pending || (loaded && form.formState.isDirty)) return;
    const j = pending.data;
    // validateFestivalsStrict normalises on every save, so trust the shape here.
    const vals = j?.values?.festivals;
    const loadedList = Array.isArray(vals) ? (vals as Festival[]) : [];
    form.reset({ festivals: sortFestivals(loadedList) });
    setLoaded(true);
    // Vocabulary comes from the server so the dropdown can't drift from what
    // the controller will accept.
    const moodVals = j?.tts?.moods;
    setMoods(Array.isArray(moodVals) ? (moodVals as string[]) : []);
    setErr(null);
    appliedRevisionRef.current = pending.revision;
    pendingSettingsRef.current = null;
  }, [
    settingsQuery.data, settingsQuery.dataUpdatedAt, settingsQuery.error,
    loaded, form, form.formState.isDirty,
  ]);

  const load = useCallback(async () => { await settingsQuery.refetch(); }, [settingsQuery]);

  // `moods` (and so the schema's vocabulary) arrives asynchronously. Once the
  // real list lands, re-validate rather than remounting the form, which would
  // drop an edit already in progress.
  useEffect(() => {
    void form.trigger();
  }, [moods, form]);

  const persist = useCallback(async (list: Festival[]) => {
    setBusy(true);
    try {
      const receipt = await saveMutation.mutateAsync({ festivals: list });
      form.reset({ festivals: sortFestivals(list) });
      setEditIdx(null);
      setEditing(false);
      const saved = `${list.length} festival${list.length === 1 ? '' : 's'} saved`;
      if (receipt.refreshError) notify.err(`${saved}, but refresh failed: ${receipt.refreshError}`);
      else notify.ok(saved);
    } catch (e) {
      if (e instanceof AdminResponseError) {
        applyServerFieldErrors(form, (e.body as { fieldErrors?: Record<string, string> }).fieldErrors);
      }
      notify.err(`Save failed: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  }, [form, saveMutation]);

  const commit = form.handleSubmit(values => persist(values.festivals));

  const startAdd = () => {
    append({ ...EMPTY_FESTIVAL });
    // `fields.length` here is this render's (pre-append) count, i.e. exactly
    // the index the new row lands at.
    setEditIdx(fields.length);
    setEditing(true);
    // errors populate lazily, so without this the modal opens on a disabled
    // Save with no message under the blank Name field explaining why.
    void form.trigger('festivals');
  };

  const startEdit = (idx: number) => {
    editSnapshot.current = watchedFestivals[idx] ?? null;
    setEditIdx(idx);
    setEditing(false);
  };

  const cancelEdit = () => {
    if (editIdx === null) return;
    if (editing) {
      removeField(editIdx);
    } else if (editSnapshot.current) {
      update(editIdx, editSnapshot.current);
    }
    setEditIdx(null);
    setEditing(false);
    editSnapshot.current = null;
  };

  const confirmRemove = () => {
    if (confirmDelete == null) return;
    const updated = watchedFestivals.filter((_, i) => i !== confirmDelete);
    setConfirmDelete(null);
    setEditIdx(null);
    setEditing(false);
    void persist(updated);
  };

  if (!hydrated || needsAuth) return null;

  // Grouped into month sections, carrying the original index so a row click
  // edits the right entry.
  const now = new Date();
  const timings = watchedFestivals.map(f => festivalTiming(f, now));
  const nextIdx = timings.length
    ? timings.reduce((best, t, i) => (t.until < (timings[best]?.until ?? Infinity) ? i : best), 0)
    : -1;
  const months: Array<{ month: number; rows: Array<{ f: Festival; idx: number }> }> = [];
  watchedFestivals.forEach((f, idx) => {
    const last = months[months.length - 1];
    if (last && last.month === f.month) last.rows.push({ f, idx });
    else months.push({ month: f.month, rows: [{ f, idx }] });
  });

  return (
    <section className="grid gap-6">
      <SectionHeader
        eyebrow="festivals"
        title="Festival calendar."
        sub="Dates that set a mood, marked across the year. Add your local holidays, regional celebrations, or personal landmarks — the station leans into the nearest one as it comes around."
        metrics={loaded ? [{ n: String(watchedFestivals.length), l: `date${watchedFestivals.length === 1 ? '' : 's'}`, accent: true }] : undefined}
        actions={
          <Btn tone="accent" className="min-h-9 sm:min-h-0" onClick={startAdd} disabled={!loaded}>
            Add festival
          </Btn>
        }
      />

      {err && <ErrorState error={err} onRetry={load} />}

      {!loaded && !err && <SkeletonRows rows={4} />}

      {loaded && (
        <Card
          title="Calendar"
          sub={`${watchedFestivals.length} date${watchedFestivals.length === 1 ? '' : 's'} · click one to edit`}
        >
          {watchedFestivals.length === 0 ? (
            <EmptyState
              title="Nothing on the calendar yet"
              description="Add your first date to get started."
            />
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
                      /* Mood/window drop to a second row on mobile: three
                         columns leave the name only ~170px at 390px. */
                      className="grid w-full cursor-pointer grid-cols-[30px_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 px-1.5 py-2 text-left hover:bg-[var(--ink-soft)] sm:grid-cols-[30px_1fr_auto] sm:gap-y-0"
                    >
                      <span className="mono-num col-start-1 row-start-1 text-[12px] text-muted">
                        {String(f.day).padStart(2, '0')}
                      </span>
                      <span className="col-start-2 row-start-1 min-w-0">
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
                      <span className="col-start-2 row-start-2 flex items-baseline gap-2.5 text-[10px] tracking-[0.08em] text-muted sm:col-start-3 sm:row-start-1">
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
        open={editIdx !== null}
        onOpenChange={o => { if (!o) cancelEdit(); }}
        title={editing ? 'new festival' : 'edit festival'}
        sub={!editing && editIdx !== null ? watchedFestivals[editIdx]?.name : undefined}
        width={520}
        footer={
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            {!editing && editIdx !== null ? (
              <Btn sm tone="danger" className="min-h-9 sm:min-h-0" onClick={() => setConfirmDelete(editIdx)} disabled={busy}>
                Remove
              </Btn>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-2">
              <Btn sm className="min-h-9 sm:min-h-0" onClick={cancelEdit} disabled={busy}>Cancel</Btn>
              <Btn
                sm
                tone="accent"
                className="min-h-9 sm:min-h-0"
                onClick={commit}
                disabled={busy || !form.formState.isValid}
              >
                {busy ? 'Saving…' : editing ? 'Add festival' : 'Save changes'}
              </Btn>
            </div>
          </div>
        }
      >
        {editIdx !== null && (
          <FestivalModalFields idx={editIdx} control={arrayControl} moods={moods} fieldId={fieldId} />
        )}
      </Modal>

      <V3AlertDialog
        open={confirmDelete != null}
        onOpenChange={(o) => { if (!o) setConfirmDelete(null); }}
        title="Remove festival"
        description={
          confirmDelete != null
            ? `Remove "${watchedFestivals[confirmDelete]?.name}" from the festival calendar?`
            : ''
        }
        confirmLabel="Remove"
        danger
        onConfirm={confirmRemove}
      />
    </section>
  );
}
