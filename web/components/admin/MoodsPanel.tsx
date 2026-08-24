'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Trash2, Palette, Clock, CalendarDays, Volume2 } from 'lucide-react';
import {
  useController, useFieldArray, useWatch, type Control,
} from 'react-hook-form';
import { z } from 'zod';
import { useAdminAuth } from '../../lib/adminAuth';
import { AdminResponseError } from '../../lib/admin-query';
import { notify, errorMessage } from '../../lib/notify';
import { useZodForm, applyServerFieldErrors, fieldAria } from '@/lib/form';
import { TextField, SelectField, type Option } from '@/lib/form-fields';
import { Card, Btn, Eyebrow } from './ui';
import { SectionTabs } from './SectionTabs';
import { ScrollArea } from '../ui/scroll-area';
import { Field, FieldLabel, FieldError } from '@/components/ui/field';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '../ui/select';
import { Input } from '@/components/ui/input';
import { SkeletonCards } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/error-state';
import FestivalsSection from './FestivalsSection';
import {
  moodsSchema,
  moodScheduleSchema,
  weatherMoodsSchema,
  SETTINGS_MOODS_LIMIT,
  SETTINGS_MOOD_NAME_MAX,
  SETTINGS_MOOD_PROMPT_MAX,
} from '@/lib/schemas.generated';
import { VoicePreviewButton } from './tts/VoicePreviewButton';
import { defaultEngineVoice } from './tts/defaultVoice';
import { ENGINE_META } from './tts/engineMeta';
import {
  settingsKeys,
  useSettingsMutation,
  useSettingsQuery,
} from './settings/queries';

interface MoodEntry {
  name: string;
  clapPrompt: string;
}
interface Correction {
  from: string;
  to: string;
}
interface MoodsFormValues {
  moods: MoodEntry[];
  schedule: Record<string, string>;
  weather: Record<string, string>;
  corrections: Correction[];
}
interface TestVoiceDefaults {
  engine: string;
  voice: string;
  cloudProvider?: string;
  cloudModel?: string;
  speed?: number;
  // Kokoro's language code, so the test sample auditions the same voice the
  // Settings → TTS "Play sample" button does.
  lang?: string;
}

interface MoodSettingsData {
  values?: {
    moods?: unknown;
    moodSchedule?: unknown;
    weatherMoods?: unknown;
    tts?: {
      corrections?: unknown;
      defaultEngine?: string;
      kokoro?: { voice?: string; lang?: string };
      chatterbox?: { referenceVoice?: string };
      pocketTts?: { voice?: string };
      cloud?: { provider?: string; model?: string; voice?: string };
      speed?: Record<string, number>;
    };
  };
}

// The 8 fixed day-periods (controller context.ts getTimeContext) — only each
// period's MOOD is editable here; the hour ranges + vibe/show names stay in code.
const PERIODS: Array<{ id: string; label: string; hours: string }> = [
  { id: 'early-morning', label: 'Early morning', hours: '05–09' },
  { id: 'morning', label: 'Morning', hours: '09–12' },
  { id: 'midday', label: 'Midday', hours: '12–14' },
  { id: 'afternoon', label: 'Afternoon', hours: '14–17' },
  { id: 'drive-time', label: 'Drive-time', hours: '17–19' },
  { id: 'evening', label: 'Evening', hours: '19–22' },
  { id: 'late-evening', label: 'Late evening', hours: '22–01' },
  { id: 'after-hours', label: 'After hours', hours: '01–05' },
];

// The 6 fixed weather conditions (controller context.ts mapWeatherCode).
const CONDITIONS: Array<{ id: string; label: string }> = [
  { id: 'clear', label: 'Clear' },
  { id: 'cloudy', label: 'Cloudy' },
  { id: 'foggy', label: 'Foggy' },
  { id: 'rainy', label: 'Rainy' },
  { id: 'snowy', label: 'Snowy' },
  { id: 'stormy', label: 'Stormy' },
];

// Radix Select forbids an empty-string item value, so the weather "no steer"
// option rides a sentinel that maps back to '' on save.
const NONE = '__none__';

const MOODS_LIMIT = SETTINGS_MOODS_LIMIT;

// A LOCAL shape guard, not a mirror of a server rule: `tts` is one of the
// settings-patch-registry keys that deliberately has no zod schema (root
// CLAUDE.md, "What deliberately did NOT convert"), so these caps are the UI's
// own and there is nothing to mirror.
const CORRECTION_FROM_MAX = 80;
const CORRECTION_TO_MAX = 160;
const CORRECTIONS_LIMIT = 100;
const correctionsSchema = z
  .array(
    z.object({
      from: z.string().max(CORRECTION_FROM_MAX),
      to: z.string().max(CORRECTION_TO_MAX),
    }),
  )
  .max(CORRECTIONS_LIMIT);

type TabId = 'vocab' | 'moments' | 'festivals' | 'speech';
const TAB_IDS: TabId[] = ['vocab', 'moments', 'festivals', 'speech'];

// The one row control that can't be a plain TextField/SelectField off
// arrayControl — see the note inside.
function WeatherMoodSelect({
  control,
  condition,
  label,
  moodOptions,
  fieldId,
}: {
  control: Control<MoodsFormValues>;
  condition: string;
  label: string;
  moodOptions: Option[];
  fieldId: string;
}) {
  // Remapping the NONE sentinel in and out of field.onChange is onChange logic
  // SelectField doesn't expose — the same carve-out FestivalsSection makes for
  // month/day/windowDays.
  const { field, fieldState } = useController({ control, name: `weather.${condition}` });
  const aria = fieldAria(`${fieldId}-weather-${condition}`, fieldState.error);
  return (
    <Field data-invalid={aria.invalid || undefined}>
      <FieldLabel {...aria.labelProps}>{label}</FieldLabel>
      <Select
        value={field.value ? field.value : NONE}
        onValueChange={v => field.onChange(v === NONE ? '' : v)}
      >
        <SelectTrigger {...aria.controlProps} onBlur={field.onBlur} ref={field.ref}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>— none —</SelectItem>
          {moodOptions.map(o => (
            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldError {...aria.errorProps} errors={fieldState.error ? [fieldState.error] : undefined} />
    </Field>
  );
}

export default function MoodsPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const queryClient = useQueryClient();
  const settingsQuery = useSettingsQuery<MoodSettingsData>({
    adminFetch,
    enabled: hydrated && !needsAuth,
  });
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // which card is saving
  const fieldId = useId();

  // Active tab lives in the URL (?tab=…) so SectionTabs and the sidebar submenu
  // share one source of truth.
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const rawTab = searchParams.get('tab');
  const tab: TabId = (TAB_IDS as string[]).includes(rawTab ?? '') ? (rawTab as TabId) : 'vocab';

  // The station's default voice, used to speak the "Test corrections" sample —
  // resolved from settings.tts on load, never edited here.
  const [previewVoice, setPreviewVoice] = useState<TestVoiceDefaults>({ engine: 'piper', voice: '' });
  const [testText, setTestText] = useState('');

  // The PERSISTED mood list, deliberately not the live Vocabulary tab value:
  // it is both the vocabulary the schedule/weather cards validate against and
  // the options their Selects offer. `saveSchedule`/`saveWeather` post their
  // own key alone, so the server judges them against what is actually stored —
  // validating against the live list would let an operator assign an unsaved
  // mood name, pass client validation, and be rejected server-side. Advanced
  // only at load and on a successful moods-card save.
  const [savedMoodNames, setSavedMoodNames] = useState<string[]>([]);
  const appliedRevisionRef = useRef(0);
  const pendingSettingsRef = useRef<{ revision: number; data: MoodSettingsData } | null>(null);
  const moodOptions: Option[] = useMemo(
    () => savedMoodNames.map(m => ({ value: m, label: m })),
    [savedMoodNames],
  );

  const schema = useMemo(
    () =>
      z.object({
        moods: moodsSchema,
        schedule: moodScheduleSchema({ moodNames: savedMoodNames }),
        weather: weatherMoodsSchema({ moodNames: savedMoodNames }),
        corrections: correctionsSchema,
      }),
    [savedMoodNames],
  );
  const form = useZodForm(schema, { moods: [], schedule: {}, weather: {}, corrections: [] });
  // The three mirrored schemas are z.unknown().superRefine().transform(), not
  // structural z.object/z.array, so the form's declared field-values type
  // collapses to `unknown` for them (see FestivalsSection's FESTIVALS_TYPE_SHAPE
  // comment). These two casts widen it back to the real output shape at the
  // type level only.
  const arrayControl = form.control as unknown as Control<MoodsFormValues>;
  const getFormValue = <K extends keyof MoodsFormValues>(key: K): MoodsFormValues[K] =>
    form.getValues(key as never) as unknown as MoodsFormValues[K];

  const { fields: moodFields, append: appendMood, remove: removeMood } = useFieldArray({
    control: arrayControl,
    name: 'moods',
    keyName: '_rhfKey',
  });
  const { fields: corrFields, append: appendCorr, remove: removeCorr } = useFieldArray({
    control: arrayControl,
    name: 'corrections',
    keyName: '_rhfKey',
  });
  // Live (unsaved-included) corrections for the "Test corrections" preview —
  // watched rather than read once, so an edit to the list above updates the
  // sample without a save round trip first.
  const liveCorrections = useWatch({ control: arrayControl, name: 'corrections' }) ?? [];

  const saveMutation = useSettingsMutation<MoodSettingsData>({ adminFetch });

  // Swapping the resolver doesn't re-run it against already-computed error
  // state, so re-validate whenever the schema is rebuilt from a fresh
  // `savedMoodNames`.
  useEffect(() => {
    void form.trigger();
  }, [schema, form]);

  const hydrateSettings = useCallback((j: MoodSettingsData | null | undefined) => {
    if (!j) return;
    const v = j?.values || {};
    const loadedMoods = Array.isArray(v.moods) ? (v.moods as MoodEntry[]) : [];
    const rawSchedule = (v.moodSchedule && typeof v.moodSchedule === 'object'
      ? v.moodSchedule : {}) as Record<string, string>;
    const rawWeather = (v.weatherMoods && typeof v.weatherMoods === 'object'
      ? v.weatherMoods : {}) as Record<string, string>;
    const loadedCorr = Array.isArray(v.tts?.corrections)
      ? (v.tts!.corrections as Correction[]) : [];
    // A period with no stored value falls back to the first vocab entry.
    const firstMood = loadedMoods[0]?.name ?? '';
    const loadedSchedule = Object.fromEntries(
      PERIODS.map(p => [p.id, rawSchedule[p.id] || firstMood]),
    );
    // Weather gets no such fallback — '' means "no mood steer".
    const loadedWeather = Object.fromEntries(
      CONDITIONS.map(c => [c.id, rawWeather[c.id] || '']),
    );
    const next: MoodsFormValues = {
      moods: loadedMoods,
      schedule: loadedSchedule,
      weather: loadedWeather,
      corrections: loadedCorr,
    };
    form.reset(next);
    setSavedMoodNames(loadedMoods.map(m => m.name));
    setLoaded(true);

    // Which voice the "Test corrections" sample uses — the station's
    // configured default engine, resolved through the one shared ladder
    // (admin/tts/defaultVoice.ts) the Settings → TTS preview also walks.
    const rawTts = v.tts || {};
    const previewEngine = rawTts.defaultEngine || 'piper';
    setPreviewVoice({
      engine: previewEngine,
      voice: defaultEngineVoice(previewEngine, rawTts),
      cloudProvider: rawTts.cloud?.provider,
      cloudModel: previewEngine === 'cloud' ? rawTts.cloud?.model : undefined,
      speed: rawTts.speed?.[previewEngine],
      lang: rawTts.kokoro?.lang || undefined,
    });
    setErr(null);
    // `form` is stable and this callback only maps one accepted server revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    hydrateSettings(pending.data);
    appliedRevisionRef.current = pending.revision;
    pendingSettingsRef.current = null;
  }, [
    settingsQuery.data, settingsQuery.dataUpdatedAt, settingsQuery.error,
    loaded, form.formState.isDirty, hydrateSettings,
  ]);

  const load = useCallback(async () => { await settingsQuery.refetch(); }, [settingsQuery]);

  // Routed through the Next router so a soft nav re-derives `tab`.
  const selectTab = useCallback(
    (id: string) => {
      const params = new URLSearchParams(Array.from(searchParams.entries()));
      params.set('tab', id);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  // POST one settings slice, then advance only that top-level field's default.
  // Other cards keep both their live values and dirty/default comparison while
  // the safe server revision stays queued behind them.
  const persistPatch = useCallback(
    async (
      card: string,
      key: keyof MoodsFormValues,
      patch: Record<string, unknown>,
      nextValue: MoodsFormValues[keyof MoodsFormValues],
      okMsg: string,
      // Only the moods card uses this, to re-baseline savedMoodNames.
      onSuccess?: (saved: Record<string, unknown> | undefined) => void,
    ) => {
      setBusy(card);
      try {
        const receipt = await saveMutation.mutateAsync(patch);
        form.resetField(key as never, { defaultValue: nextValue as never });
        onSuccess?.(receipt.refreshError
          ? patch
          : queryClient.getQueryData<MoodSettingsData>(settingsKeys.detail())?.values);
        if (receipt.refreshError) notify.err(`${okMsg}, but refresh failed: ${receipt.refreshError}`);
        else notify.ok(okMsg);
      } catch (e) {
        if (e instanceof AdminResponseError) {
          applyServerFieldErrors(form, (e.body as { fieldErrors?: Record<string, string> }).fieldErrors);
        }
        notify.err(`Save failed: ${errorMessage(e)}`);
      } finally {
        setBusy(null);
      }
    },
    [form, queryClient, saveMutation],
  );

  const saveMoods = async () => {
    const ok = await form.trigger('moods');
    if (!ok) return;
    const raw = getFormValue('moods');
    const payload = raw.map(m => ({ name: m.name, clapPrompt: m.clapPrompt }));
    // The one save that can hit the controller's in-use removal guard
    // (assertNoOrphanMoods): renaming or removing a mood a time-of-day slot,
    // weather slot, festival or show still points at. It's a whole-request
    // rule with no field to attach to, so it surfaces as a toast.
    await persistPatch(
      'moods',
      'moods',
      { moods: payload },
      raw,
      `${raw.length} mood${raw.length === 1 ? '' : 's'} saved`,
      // The only place savedMoodNames advances. Prefer the server's own
      // normalised names over the raw payload, so an id the operator typed
      // un-normalised doesn't leak into the Moments dropdowns.
      saved => {
        const savedMoods = Array.isArray(saved?.moods) ? (saved.moods as MoodEntry[]) : payload;
        setSavedMoodNames(savedMoods.map(m => m.name));
      },
    );
  };

  const saveSchedule = async () => {
    const ok = await form.trigger('schedule');
    if (!ok) return;
    const value = getFormValue('schedule');
    await persistPatch('schedule', 'schedule', { moodSchedule: value }, value, 'Time-of-day moods saved');
  };

  const saveWeather = async () => {
    const ok = await form.trigger('weather');
    if (!ok) return;
    const value = getFormValue('weather');
    await persistPatch('weather', 'weather', { weatherMoods: value }, value, 'Weather moods saved');
  };

  const saveCorrections = async () => {
    const ok = await form.trigger('corrections');
    if (!ok) return;
    const raw = getFormValue('corrections');
    const effective = raw.map(c => ({ from: c.from.trim(), to: c.to.trim() })).filter(c => c.from);
    // The new default is the RAW value (blank scratch rows included) so the
    // dirty comparison stays structural; only the POSTED payload is filtered.
    await persistPatch('corrections', 'corrections', { tts: { corrections: effective } }, raw, 'Speech corrections saved');
  };

  // Per-card Save gate, not `form.formState.isValid` — that's the whole form's
  // validity, so an invalid vocab row would disable the moments/speech Save
  // buttons too. The bare index only works for TOP-LEVEL keys; a card keyed on
  // a nested path would need a `get(errors, path)` accessor.
  const cardState = (key: keyof MoodsFormValues) => {
    const errors = form.formState.errors as Record<string, unknown>;
    const dirty = form.formState.dirtyFields as Record<string, unknown>;
    return { invalid: !!errors[key], dirty: !!dirty[key] };
  };

  if (!hydrated || needsAuth) return null;

  const tabs = [
    { id: 'vocab' as TabId, label: 'Vocabulary', count: loaded ? moodFields.length : undefined, icon: Palette },
    { id: 'moments' as TabId, label: 'Moments', count: undefined as number | undefined, icon: Clock },
    { id: 'festivals' as TabId, label: 'Festivals', count: undefined as number | undefined, icon: CalendarDays },
    { id: 'speech' as TabId, label: 'Speech', count: loaded ? corrFields.length : undefined, icon: Volume2 },
  ];

  const moodsCard = cardState('moods');
  const scheduleCard = cardState('schedule');
  const weatherCard = cardState('weather');
  const correctionsCard = cardState('corrections');
  const effectiveCorr = liveCorrections
    .map(c => ({ from: (c.from ?? '').trim(), to: (c.to ?? '').trim() }))
    .filter(c => c.from);

  return (
    <div className="grid gap-4">
      <section className="card">
        <div className="border-b border-ink p-4">
          <Eyebrow className="text-vermilion">moods</Eyebrow>
          <div className="mt-1.5 text-[22px] font-extrabold tracking-[-0.02em]">
            Moods &amp; moments.
          </div>
          <div className="mt-1 text-[11px] leading-[1.6] text-muted">
            The words your library is tagged with, and which of them each part of the day, the
            weather, and the calendar leans into. Edit the list and every show, festival, and
            auto-DJ pick draws from it.
          </div>
        </div>
        <SectionTabs tabs={tabs} value={tab} onChange={selectTab} label="Moods sections" />
      </section>

      {err && <ErrorState error={err} onRetry={load} />}

      {!loaded && !err && tab !== 'festivals' && <SkeletonCards cards={6} />}

      {tab === 'vocab' && loaded && (
        <Card title="Mood vocabulary" sub="the moods every track is tagged with">
          <div className="field">
            <div className="field-hint">
              Give each mood a short id (letters, digits, dashes) and, if you like, a sound
              description we use for audio tagging (needs the heavy analyzer). Change a mood or its
              description and the older tags are marked stale; audio moods re-score on the next
              analysis pass, so re-run the tagger to refresh them. If a mood is still used by a
              show, festival, or one of the maps in Moments, you’ll need to reassign it before you
              can remove it.
            </div>
            <ScrollArea className="max-h-[420px]">
              <div className="flex flex-col gap-3 pr-2">
                {moodFields.map((field, idx) => (
                  <div
                    key={field._rhfKey}
                    className="flex flex-col gap-2 border-b border-ink/10 pb-3 last:border-0 sm:flex-row sm:items-end sm:gap-3"
                  >
                    <TextField
                      control={arrayControl}
                      name={`moods.${idx}.name`}
                      label="Mood id"
                      placeholder="id (e.g. mellow)"
                      className="sm:w-48 sm:shrink-0"
                      maxLength={SETTINGS_MOOD_NAME_MAX}
                    />
                    <TextField
                      control={arrayControl}
                      name={`moods.${idx}.clapPrompt`}
                      label="Sound description"
                      placeholder="sound description for audio tagging (optional)"
                      className="sm:flex-1"
                      maxLength={SETTINGS_MOOD_PROMPT_MAX}
                    />
                    <Btn
                      sm
                      title="Remove mood"
                      className="size-9 shrink-0 self-start sm:self-end"
                      onClick={() => removeMood(idx)}
                    >
                      <Trash2 size={12} />
                    </Btn>
                  </div>
                ))}
              </div>
            </ScrollArea>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Btn
                className="min-h-9 sm:min-h-0"
                disabled={moodFields.length >= MOODS_LIMIT}
                onClick={() => {
                  appendMood({ name: '', clapPrompt: '' });
                  // errors are populated lazily, so an untouched blank row
                  // would leave the Save button enabled and its click a no-op.
                  void form.trigger('moods');
                }}
              >
                Add mood
              </Btn>
              <Btn
                tone="accent"
                className="min-h-9 sm:min-h-0"
                disabled={busy !== null || !moodsCard.dirty || moodsCard.invalid}
                onClick={() => void saveMoods()}
              >
                {busy === 'moods' ? 'Saving…' : 'Save vocabulary'}
              </Btn>
            </div>
          </div>
        </Card>
      )}

      {tab === 'moments' && loaded && (
        <>
          <Card title="Time of day → mood" sub="the mood your station leans into through the day">
            <div className="grid gap-3">
              {PERIODS.map(p => (
                <SelectField
                  key={p.id}
                  control={arrayControl}
                  name={`schedule.${p.id}`}
                  label={`${p.label} · ${p.hours}`}
                  options={moodOptions}
                />
              ))}
              <div className="mt-1">
                <Btn
                  tone="accent"
                  className="min-h-9 sm:min-h-0"
                  disabled={busy !== null || !scheduleCard.dirty || scheduleCard.invalid}
                  onClick={() => void saveSchedule()}
                >
                  {busy === 'schedule' ? 'Saving…' : 'Save time-of-day moods'}
                </Btn>
              </div>
            </div>
          </Card>

          <Card title="Weather → mood" sub="how live weather colours the mood — this wins over time of day">
            <div className="grid gap-3">
              {CONDITIONS.map(c => (
                <WeatherMoodSelect
                  key={c.id}
                  control={arrayControl}
                  condition={c.id}
                  label={c.label}
                  moodOptions={moodOptions}
                  fieldId={fieldId}
                />
              ))}
              <div className="mt-1">
                <Btn
                  tone="accent"
                  className="min-h-9 sm:min-h-0"
                  disabled={busy !== null || !weatherCard.dirty || weatherCard.invalid}
                  onClick={() => void saveWeather()}
                >
                  {busy === 'weather' ? 'Saving…' : 'Save weather moods'}
                </Btn>
              </div>
            </div>
          </Card>
        </>
      )}

      {tab === 'festivals' && <FestivalsSection />}

      {tab === 'speech' && loaded && (
        <>
          <Card title="Speech corrections" sub="how names and tricky words should sound">
            <div className="field">
              <div className="field-hint">
                Find-and-replace rules we apply to every line before it’s spoken, for names and
                words the voice tends to get wrong (<em>GHz</em> →<em> gigahertz</em>, <em>Hozier</em>{' '}
                → <em>Ho-zeer</em>). Case doesn’t matter, and it matches whole words and phrases;
                leave the spoken form empty to drop a word entirely. New rules kick in from the next
                line — no restart needed.
              </div>
              <ScrollArea className="max-h-[360px]">
                <div className="flex flex-col gap-3 pr-2">
                  {corrFields.map((field, idx) => (
                    <div
                      key={field._rhfKey}
                      className="flex flex-col gap-2 border-b border-ink/10 pb-3 last:border-0 sm:flex-row sm:items-end sm:gap-3"
                    >
                      <TextField
                        control={arrayControl}
                        name={`corrections.${idx}.from`}
                        label="Text on air"
                        placeholder="text on air (e.g. GHz)"
                        className="sm:flex-1"
                        maxLength={CORRECTION_FROM_MAX}
                      />
                      <TextField
                        control={arrayControl}
                        name={`corrections.${idx}.to`}
                        label="Spoken form"
                        placeholder="spoken form (e.g. gigahertz)"
                        description="leave empty to drop the word"
                        maxLength={CORRECTION_TO_MAX}
                        className="sm:flex-1"
                      />
                      <Btn
                        sm
                        title="Remove correction"
                        className="size-9 shrink-0 self-start sm:self-end"
                        onClick={() => removeCorr(idx)}
                      >
                        <Trash2 size={12} />
                      </Btn>
                    </div>
                  ))}
                </div>
              </ScrollArea>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Btn
                  className="min-h-9 sm:min-h-0"
                  disabled={corrFields.length >= CORRECTIONS_LIMIT}
                  onClick={() => appendCorr({ from: '', to: '' })}
                >
                  Add correction
                </Btn>
                <Btn
                  tone="accent"
                  className="min-h-9 sm:min-h-0"
                  disabled={busy !== null || !correctionsCard.dirty || correctionsCard.invalid}
                  onClick={() => void saveCorrections()}
                >
                  {busy === 'corrections' ? 'Saving…' : 'Save corrections'}
                </Btn>
              </div>
            </div>
          </Card>

          <Card title="Test corrections" sub="hear a rule before saving, with the station's default voice">
            <div className="field">
              <div className="field-hint">
                Uses the corrections list above exactly as it stands right now, unsaved
                changes included, spoken by the station&apos;s default voice
                ({ENGINE_META[previewVoice.engine]?.label || previewVoice.engine}).
              </div>
              <Input
                aria-label="Test sentence"
                value={testText}
                onChange={e => setTestText(e.target.value)}
                placeholder="Type a line using a word you corrected…"
                maxLength={200}
              />
              <VoicePreviewButton
                className="mt-3"
                engine={previewVoice.engine}
                voice={previewVoice.voice}
                cloudProvider={previewVoice.cloudProvider}
                cloudModel={previewVoice.cloudModel}
                speed={previewVoice.speed}
                lang={previewVoice.lang}
                text={testText}
                corrections={effectiveCorr}
                disabled={!testText.trim()}
                adminFetch={adminFetch}
              />
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
