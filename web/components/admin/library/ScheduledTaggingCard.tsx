'use client';

// Scheduled tagging (#2282): the `tagger.auto` block, edited on the Library
// Tagger's Run tab and saved through POST /settings. The controller owns every
// decision (broadcast/tag-schedule.ts); this card edits the setting and shows
// the scheduled job's own record (GET /settings `taggerSchedule`).
//
// Hydrates from the settings read and re-seeds when the stored value changes
// (a save, or a refetch on focus) only while the form is clean, so a refetch
// never clobbers an edit in progress.

import { useEffect, useState } from 'react';
import { useWatch } from 'react-hook-form';
import { useAdminAuth } from '../../../lib/adminAuth';
import { AdminResponseError } from '../../../lib/admin-query';
import { errorMessage } from '../../../lib/notify';
import { applyServerFieldErrors, useZodForm } from '../../../lib/form';
import { SwitchField, TextField, ToggleGroupField } from '../../../lib/form-fields';
import {
  SETTINGS_TAGGER_AUTO_MODES,
  TAGGER_AUTO_DEFAULTS,
  TAGGER_AUTO_LIMIT_BOUNDS,
  taggerAutoFormSchema,
  type TaggerAutoSettings,
} from '../../../lib/schemas.generated';
import { Btn, Pill } from '../ui';
import { useSettingsMutation, useSettingsQuery } from '../settings/queries';
import type { SettingsData, TaggerScheduleView } from '../settings/shared';

const MODE_LABELS: Record<(typeof SETTINGS_TAGGER_AUTO_MODES)[number], string> = {
  off: 'Off',
  daily: 'Daily',
};

const STEP_FIELDS = [
  { key: 'reconcile', label: 'Reconcile with Navidrome' },
  { key: 'enrich', label: 'Enrich metadata' },
  { key: 'tagMoods', label: 'Tag moods (LLM)' },
  { key: 'analyze', label: 'Analyze acoustics' },
] as const;

// The form's values before the first read: the shipped defaults, copied out of
// the frozen constant. The card renders only once the controller has sent
// `values.tagger.auto`, whose load path fills every field, so these are never
// shown; they only seed useZodForm until then.
const BEFORE_READ: TaggerAutoSettings = { ...TAGGER_AUTO_DEFAULTS, steps: { ...TAGGER_AUTO_DEFAULTS.steps } };

const formKey = (f: TaggerAutoSettings) =>
  `${f.mode}/${f.time}/${f.limit}/${STEP_FIELDS.map(s => (f.steps[s.key] ? 1 : 0)).join('')}`;

function when(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

const OUTCOME_TEXT: Record<NonNullable<TaggerScheduleView['outcome']>, string> = {
  running: 'running now',
  ok: 'finished',
  failed: 'failed',
  stopped: 'stopped',
  held: 'held for you',
  skipped: 'skipped',
  missed: 'did not run',
  interrupted: 'interrupted by a restart',
};

function LastRun({ view }: { view: TaggerScheduleView | null | undefined }) {
  if (!view) return null;
  const lines: string[] = [];
  if (view.waiting) lines.push(`Waiting to start: ${view.waiting}.`);
  if (view.outcome) {
    const stamp = when(view.startedAt) || when(view.at);
    const head = view.startedAt ? `Last scheduled start ${stamp}` : `Last scheduled check ${stamp}`;
    lines.push(`${head}: ${OUTCOME_TEXT[view.outcome]}${view.detail ? ` (${view.detail})` : ''}.`);
  } else if (!view.waiting) {
    lines.push('No scheduled run yet.');
  }
  const bad = view.outcome === 'failed' || view.outcome === 'held' || view.outcome === 'missed';
  return (
    <div className={bad ? 'text-[12px] leading-[1.55] text-[var(--danger)]' : 'text-[12px] leading-[1.55] text-muted'}>
      {lines.map(l => <div key={l}>{l}</div>)}
    </div>
  );
}

export default function ScheduledTaggingCard() {
  const { adminFetch, hydrated, needsAuth } = useAdminAuth();
  const ready = hydrated && !needsAuth;
  const settingsQuery = useSettingsQuery<SettingsData>({ adminFetch, enabled: ready });
  const save = useSettingsMutation<SettingsData>({ adminFetch });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const data = settingsQuery.data;
  const supported = !!data?.values?.tagger?.auto;
  const stored = data?.values?.tagger?.auto ?? BEFORE_READ;
  const storedKey = formKey(stored);

  const form = useZodForm(taggerAutoFormSchema, stored);
  const mode = useWatch({ control: form.control, name: 'mode' });

  // Adopt the stored value on first paint, and whenever it moves under a clean form.
  useEffect(() => {
    if (!supported) return;
    if (!form.formState.isDirty) form.reset(stored);
  }, [storedKey, supported]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    setSaved(false);
    try {
      await save.mutateAsync({ tagger: { auto: values } });
      form.reset(values);
      setSaved(true);
    } catch (e) {
      if (e instanceof AdminResponseError) {
        // The controller keys errors by full path (`tagger.auto.time`); the form
        // is the `auto` block itself.
        const fieldErrors: Record<string, string> = {};
        for (const [k, v] of Object.entries(e.body?.fieldErrors ?? {})) {
          if (typeof v === 'string') fieldErrors[k.replace(/^tagger\.auto\./, '')] = v;
        }
        applyServerFieldErrors(form, fieldErrors);
        setError(typeof e.body?.error === 'string' ? e.body.error : e.message);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  });

  if (!data) {
    if (!settingsQuery.isError) return null;
    return (
      <section className="grid gap-2 border border-separator-strong p-3" role="alert">
        <span className="text-[12px] font-bold text-ink">Schedule</span>
        <p className="text-[12px] leading-[1.55] text-[var(--danger)]">
          Could not read the schedule settings. {errorMessage(settingsQuery.error)}
        </p>
        <div>
          <Btn onClick={() => { void settingsQuery.refetch(); }} disabled={settingsQuery.isFetching}>
            {settingsQuery.isFetching ? 'Retrying…' : 'Retry'}
          </Btn>
        </div>
      </section>
    );
  }
  // An older controller has no `tagger` block: it has no schedule to edit.
  if (!supported) return null;

  const tz = data.values?.timezone || data.serverTimezone || 'the station clock';
  const off = mode !== 'daily';

  return (
    <section className="grid gap-3 border border-separator-strong p-3" aria-labelledby="sched-tagging-title">
      <div className="flex items-center justify-between gap-2">
        <span id="sched-tagging-title" className="text-[12px] font-bold text-ink">Schedule</span>
        {stored.mode === 'daily'
          ? <Pill tone="accent">daily · {stored.time}</Pill>
          : <Pill tone="ink">off</Pill>}
      </div>
      <p className="text-[12px] leading-[1.55] text-muted">
        Tag new music once a day without pressing Start. The run starts within five minutes
        of the set time ({tz}), or as soon after it as the station is up that day. Turning
        the schedule on, or moving its time, after today&apos;s time has passed starts the
        first run tomorrow. It is skipped when Navidrome has nothing new and, with Tag moods
        on, nothing is untagged; enrichment or analysis still owed on tracks already in the
        library does not start it on its own. It never starts over another run, and waits
        for a Navidrome scan and for Quiet times when they are on. A failed run is not
        retried until the next day. An unattended run never confirms replaced files: a
        held run says so here and in the booth log each night until you answer it with a
        manual run.
      </p>
      <p className="text-[12px] leading-[1.55] text-muted">
        Two defaults differ from Start above. The schedule tags every untagged track unless
        you set a number here, where Start&apos;s Limit begins at the next 500. And it has no
        vocal step of its own: the Demucs vocal pass follows the Vocal activity setting, so
        with that on the scheduled run separates vocals too (very slow), where Start leaves
        it unticked.
      </p>
      <form className="grid gap-3" onSubmit={(e) => { void onSubmit(e); }}>
        <ToggleGroupField
          control={form.control}
          name="mode"
          label="Run"
          options={SETTINGS_TAGGER_AUTO_MODES.map(id => ({ value: id, label: MODE_LABELS[id] }))}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            control={form.control}
            name="time"
            label="At (station time)"
            type="time"
            disabled={off}
          />
          <TextField
            control={form.control}
            name="limit"
            label="Tracks per run"
            numeric
            min={TAGGER_AUTO_LIMIT_BOUNDS.min}
            max={TAGGER_AUTO_LIMIT_BOUNDS.max}
            step={1}
            disabled={off}
            description="0 tags everything untagged, like the Limit above set to all."
          />
        </div>
        <div className="grid gap-2">
          {STEP_FIELDS.map(s => (
            <SwitchField
              key={s.key}
              control={form.control}
              name={`steps.${s.key}`}
              label={s.label}
              disabled={off}
            />
          ))}
        </div>
        {error && <div className="text-[12px] leading-[1.55] text-[var(--danger)]">{error}</div>}
        <div className="flex flex-wrap items-center gap-2">
          <Btn tone="accent" type="submit" disabled={save.isPending || !form.formState.isDirty}>
            {save.isPending ? 'Saving…' : 'Save schedule'}
          </Btn>
          {form.formState.isDirty && (
            <Btn onClick={() => { form.reset(stored); setError(null); }} disabled={save.isPending}>
              Discard
            </Btn>
          )}
          {saved && !form.formState.isDirty && <span className="text-[12px] text-muted">Saved.</span>}
        </div>
      </form>
      <LastRun view={data.taggerSchedule} />
    </section>
  );
}
