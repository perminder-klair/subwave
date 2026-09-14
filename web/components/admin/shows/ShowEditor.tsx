'use client';

// Inline show editor. Fields bind to react-hook-form via `control`+`index`
// (`shows.${index}.<field>`); ShowsPanel.saveShow persists the single row.
// Keyed by show id at the call site, so switching shows remounts and clears
// the AiFill box and genreDraft buffer (neither is form data).

import type { ChangeEvent, ReactNode, RefObject } from 'react';
import { useId, useMemo, useState } from 'react';
import { useController, type Control, type FieldErrors, type UseFormTrigger } from 'react-hook-form';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Field, FieldTitle, FieldDescription, FieldError } from '../../ui/field';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  SelectGroup,
} from '../../ui/select';
import { Card, Btn, Eyebrow } from '../ui';
import { TagField } from '../TagField';
import { EditorDialog, EditorFooter } from '../../ui/editor-dialog';
import { AiFill } from '../AiFill';
import GenreSuggest from '../GenreSuggest';
import { GuestPersonaPicker, ThemePicker, PlaylistPicker } from './ShowPickers';
import { cn } from '../../../lib/cn';
import { fieldAria } from '@/lib/form';
import { SwitchField, TextField, TextareaField, ToggleGroupField } from '@/lib/form-fields';
import {
  ANY_SENTINEL,
  INHERIT_SENTINEL,
  DECADES,
  ENERGY_OPTIONS,
  FILTER_VALUES_MAX,
  GUESTS_MAX,
  NAME_MAX,
  EXCLUDED_PLAYLISTS_MAX,
  PLAYLISTS_MAX,
  TAGS_MAX,
  TAG_MAX,
  TAG_RE,
  TOPIC_MAX,
  VOCAL_OPTIONS,
  YEAR_MAX,
  YEAR_MIN,
  eraLabelOf,
  resolveEraDraft,
  sameEra,
} from './types';
import type { EraWindow, Persona, PlaylistIndexStatus, Show, ShowsFormValues, SkillOption, ThemeOption } from './types';
import { hasAnyMusicFilter, showPayload } from './lib';
import { ChipRow } from './ChipRow';
import { displayedMatchingTracks, type CandidateDiagnostic } from './candidate-diagnostic';
import { fetchShowCandidates, useShowBlocklistQuery } from './queries';

// Operator-facing labels for the developer-facing schema keys.
const FIELD_LABELS: Record<string, string> = {
  name: 'name',
  personaId: 'host',
  guestPersonaIds: 'guests',
  maxTrackSeconds: 'track length cap',
  minTrackLengthSeconds: 'minimum track length',
  fadeAtShowEnd: 'fade at show end',
  segmentSkill: 'feature skill',
  playlistIds: 'playlists',
  excludedPlaylistIds: 'excluded playlists',
};

// Some rules root on an ARRAY field (`eras.0.fromYear`), so walk down to the
// first real message rather than assuming every key is a leaf `{message}`.
function firstFieldError(errs: FieldErrors<Show> | undefined): { key: string; message: string } | null {
  if (!errs) return null;
  for (const key of Object.keys(errs)) {
    const v = errs[key as keyof Show] as { message?: string } | Record<string, unknown> | undefined;
    if (!v) continue;
    if (typeof v.message === 'string') return { key, message: v.message };
    const nested = firstFieldError(v as FieldErrors<Show>);
    if (nested) return { key, message: nested.message };
  }
  return null;
}

interface ShowEditorProps {
  show: Show;
  index: number;
  control: Control<ShowsFormValues>;
  // Forces the OTHER side of the host/guest cross-field `.check()` to
  // re-surface; see personaIdCtl below.
  trigger: UseFormTrigger<ShowsFormValues>;
  // This row's slice of formState.errors.shows, sourced from ShowsPanel.
  errors: FieldErrors<Show> | undefined;
  editorRef: RefObject<HTMLDivElement | null>;
  personas: Persona[];
  moods: string[];
  themes: ThemeOption[];
  skills: SkillOption[];
  activeThemeId: string;
  genres: string[];
  // Tags used by the OTHER shows, offered as one-click adds.
  tagSuggestions: string[];
  playlists: { id: string; name: string; songCount: number | null }[];
  // Only 'ready' means /dj/playlists answered, so an id absent from
  // `playlists` can't be called missing while the index is merely unknown.
  playlistsStatus: PlaylistIndexStatus;
  apiBase: string;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  minTrackSeconds?: number;
  // Station-wide minimum a blank field inherits, so the hint can say what
  // "inherit" means today.
  stationMinTrackLengthSeconds?: number;
  busy: boolean;
  isNew: boolean;       // show the AI-draft field only while creating
  valid: boolean;
  // Used only by the AI-draft apply, which sets several fields at once.
  onApplyDraft: (patch: Partial<Show>) => void;
  onSave: () => void;   // Save show — persists just this show (POST /shows)
  onClose: () => void;
  onRemove: () => void;
}

export function ShowEditor({
  show, index, control, trigger, errors, editorRef, personas, moods, themes, skills, activeThemeId, genres, tagSuggestions, playlists,
  playlistsStatus, apiBase,
  adminFetch, minTrackSeconds, stationMinTrackLengthSeconds, busy, isNew, valid, onApplyDraft,
  onSave, onClose, onRemove,
}: ShowEditorProps) {
  const uid = useId();
  const [tagDraftBlocked, setTagDraftBlocked] = useState(false);
  const editorValid = valid && !tagDraftBlocked;
  // `index` is a runtime number, so cast to the template-literal type
  // FieldPath<ShowsFormValues> needs.
  const path = <K extends string>(field: K) => `shows.${index}.${field}` as `shows.${number}.${K}`;

  // What the schema actually objected to; the gate fails for many reasons
  // beyond a missing name or persona.
  const gateIssue = (() => {
    if (valid) return null;
    const first = firstFieldError(errors);
    if (!first) return 'this show fails validation';
    const root = first.key.split('.')[0] ?? first.key;
    const label = FIELD_LABELS[root] ?? root;
    return label ? `${label}: ${first.message}` : first.message;
  })();

  // TextField/SwitchField cover plain-value fields; anything with cross-field
  // or array work stays on a raw useController (see lib/form-fields.tsx).
  // personaId is raw because RHF populates errors per PATH: picking a host who
  // is already a guest roots the issue at `guestPersonaIds`, which nothing
  // re-validates until touched. This Controller trigger()s the sibling.
  const personaIdCtl = useController({ control, name: path('personaId') });
  const personaIdAria = fieldAria(`${uid}-${path('personaId')}`, personaIdCtl.fieldState.error, { hasDescription: true });
  const guestsCtl = useController({ control, name: path('guestPersonaIds') });
  const themeCtl = useController({ control, name: path('themeId') });
  const segmentSkillCtl = useController({ control, name: path('segmentSkill') });
  const moodsCtl = useController({ control, name: path('moods') });
  const erasCtl = useController({ control, name: path('eras') });
  const vocalsCtl = useController({ control, name: path('vocals') });
  const genresCtl = useController({ control, name: path('genres') });
  const maxTrackSecondsCtl = useController({ control, name: path('maxTrackSeconds') });
  const minTrackLengthSecondsCtl = useController({ control, name: path('minTrackLengthSeconds') });
  const fadeAtShowEndCtl = useController({ control, name: path('fadeAtShowEnd') });
  const tagsCtl = useController({ control, name: path('tags') });

  const candidateKey = JSON.stringify(showPayload(show));
  const [candidateBusy, setCandidateBusy] = useState(false);
  const [candidateError, setCandidateError] = useState<string | null>(null);
  const [candidateReport, setCandidateReport] = useState<{ key: string; value: CandidateDiagnostic } | null>(null);
  const visibleCandidateReport = candidateReport?.key === candidateKey ? candidateReport.value : null;
  const calculateCandidates = async () => {
    setCandidateBusy(true); setCandidateError(null);
    try {
      const j = await fetchShowCandidates(adminFetch, show);
      setCandidateReport({ key: candidateKey, value: j });
    } catch (err) { setCandidateError(err instanceof Error ? err.message : String(err)); }
    finally { setCandidateBusy(false); }
  };

  // Text buffer, not form data; resets on the per-show remount.
  const [genreDraft, setGenreDraft] = useState('');
  const addGenre = (g: string, { keepDraft = false } = {}) => {
    const v = g.trim().slice(0, 64);
    const current = genresCtl.field.value ?? [];
    if (!v || current.length >= FILTER_VALUES_MAX) return;
    if (current.some((x: string) => x.toLowerCase() === v.toLowerCase())) {
      if (!keepDraft) setGenreDraft('');
      return;
    }
    genresCtl.field.onChange([...current, v]);
    if (!keepDraft) setGenreDraft('');
  };
  // A suggestion chip narrows the list it came from, so keep the draft on
  // click. Committing typed text (Enter/Add) still clears it.
  const addGenreFromSuggestion = (g: string) => addGenre(g, { keepDraft: true });

  // Custom era range text buffers (#1599). Error raised only on Add.
  const [eraFrom, setEraFrom] = useState('');
  const [eraTo, setEraTo] = useState('');
  const [eraDraftError, setEraDraftError] = useState('');
  // EVERY write to `eras` goes through here: any write can falsify the draft
  // error, which is a verdict on one Add press against the array as it stood.
  const setEras = (next: EraWindow[]) => {
    erasCtl.field.onChange(next);
    setEraDraftError('');
  };
  const addEraRange = () => {
    const current: EraWindow[] = erasCtl.field.value ?? [];
    if (current.length >= FILTER_VALUES_MAX) return;
    const r = resolveEraDraft(eraFrom, eraTo, current);
    if ('error' in r) { setEraDraftError(r.error); return; }
    // A range spelling out a decade lights that chip rather than appearing twice.
    setEras([...current, r.window]);
    setEraFrom(''); setEraTo('');
  };
  // Genres no track carries. The controller resolves free text onto the nearest
  // library tag, silently broadening or dropping the filter. Mirrors
  // show-filter.normGenre. An empty library list means not fetched or failed --
  // never warn on a fetch failure.
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const knownGenres = useMemo(() => new Set(genres.map(norm)), [genres]);
  const showGenres: string[] = genresCtl.field.value ?? [];
  const unknownGenres = genres.length
    ? showGenres.filter(g => !knownGenres.has(norm(g)))
    : [];
  // Hint only: show-scoped blocklist rules are edited on Library -> Blocked.
  // Best-effort, 0 hides the line.
  const blocklistQuery = useShowBlocklistQuery(adminFetch, true);
  const scopedRuleCount = (blocklistQuery.data || [])
    .filter(rule => rule.showIds?.includes(show.id)).length;

  const guestIds: string[] = guestsCtl.field.value ?? [];
  const eras: EraWindow[] = erasCtl.field.value ?? [];
  // Windows matching no decade preset. The decade row caps on what IT has
  // selected, so hand it the REMAINING budget or the schema refuses a save the
  // UI still offered.
  const customEras = eras.filter(e => !DECADES.some(d => sameEra(e, d)));

  // A chip multi-select has no single labelable element, so it names itself
  // via aria-labelledby/groupProps.
  const guestsAria = fieldAria(`${uid}-${path('guestPersonaIds')}`, guestsCtl.fieldState.error, { hasDescription: true });
  const themeAria = fieldAria(`${uid}-${path('themeId')}`, themeCtl.fieldState.error, { hasDescription: true });
  const segmentSkillAria = fieldAria(`${uid}-${path('segmentSkill')}`, segmentSkillCtl.fieldState.error, { hasDescription: true });
  const moodsAria = fieldAria(`${uid}-${path('moods')}`, moodsCtl.fieldState.error, { hasDescription: true });
  const erasAria = fieldAria(`${uid}-${path('eras')}`, erasCtl.fieldState.error, { hasDescription: true });
  const vocalsAria = fieldAria(`${uid}-${path('vocals')}`, vocalsCtl.fieldState.error, { hasDescription: true });
  const genresAria = fieldAria(`${uid}-${path('genres')}`, genresCtl.fieldState.error, { hasDescription: true });
  const maxTrackSecondsAria = fieldAria(`${uid}-${path('maxTrackSeconds')}`, maxTrackSecondsCtl.fieldState.error, { hasDescription: true });
  const minTrackLengthSecondsAria = fieldAria(`${uid}-${path('minTrackLengthSeconds')}`, minTrackLengthSecondsCtl.fieldState.error, { hasDescription: true });
  const fadeAtShowEndAria = fieldAria(`${uid}-${path('fadeAtShowEnd')}`, fadeAtShowEndCtl.fieldState.error, { hasDescription: true });
  const tagsAria = fieldAria(`${uid}-${path('tags')}`, tagsCtl.fieldState.error, { hasDescription: true });

  return (
    <EditorDialog
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={<Eyebrow className="text-vermilion">{isNew ? 'New show' : 'Edit show'}</Eyebrow>}
      sub={<span className="caption truncate">{show.name.trim() || 'define a show'}</span>}
      footer={
        <EditorFooter
          status={(
            <>
              <span
                className={cn(
                  'size-1.5 flex-none rounded-full',
                  editorValid ? 'bg-[var(--accent)]' : 'bg-[var(--danger)]',
                )}
              />
              <span className="min-w-0">
                {tagDraftBlocked
                  ? <span className="text-[var(--danger)]">tags: finish or correct the pending tag</span>
                  : gateIssue
                  ? <span className="text-[var(--danger)]">{gateIssue}</span>
                  : 'saves this show · schedule it on the grid, then Save schedule'}
              </span>
            </>
          )}
          actions={[
            { id: 'remove', label: 'Remove', tone: 'danger', onClick: onRemove },
          ]}
          primary={[
            { id: 'close', label: 'Close', onClick: onClose },
            {
              id: 'save',
              label: busy ? 'Saving…' : 'Save show',
              tone: 'accent',
              onClick: () => { if (!tagDraftBlocked) onSave(); },
              disabled: busy || !editorValid,
            },
          ]}
        />
      }
    >
      <div ref={editorRef} className="grid">
        <Card flat title="Identity" bodyClass="grid gap-3.5">
          {isNew && (
            <AiFill<Partial<Omit<Show, 'personaId' | 'themeId'>> & { personaId?: string | null; themeId?: string | null }>
              endpoint="/generate/show"
              resultKey="show"
              adminFetch={adminFetch}
              placeholder="e.g. a Sunday-morning gospel hour, warm and uplifting"
              onApply={(s) => onApplyDraft({
                ...s,
                personaId: s.personaId ?? show.personaId ?? '',
                themeId: s.themeId ?? '',
              })}
            />
          )}
          <TextField control={control} name={path('name')} label="show name" placeholder="e.g. The Late Shift" maxLength={NAME_MAX} />
          <span className="field-hint -mt-2">{show.name.trim().length}/{NAME_MAX}</span>

          {/* Sits in Identity, not Music: a tag files the show and reaches
              nothing on air. */}
          <Field data-invalid={tagsAria.invalid || undefined}>
            <FieldTitle {...tagsAria.labelledByProps}>tags</FieldTitle>
            <div {...tagsAria.groupProps}>
              <TagField
                value={tagsCtl.field.value || []}
                onChange={tagsCtl.field.onChange}
                pattern={TAG_RE}
                max={TAGS_MAX}
                charMax={TAG_MAX}
                suggestions={tagSuggestions}
                noun="show"
                onDraftBlockedChange={setTagDraftBlocked}
                disabled={busy}
              />
            </div>
            <FieldDescription {...tagsAria.descriptionProps}>
              Freeform filing for the show list — by daypart, by season, by
              whatever you group on. Up to {TAGS_MAX}. Nothing on air reads them.
            </FieldDescription>
            <FieldError {...tagsAria.errorProps} errors={tagsCtl.fieldState.error ? [tagsCtl.fieldState.error] : undefined} />
          </Field>

          {/* Raw Controller: switching the host must re-trigger
              `guestPersonaIds`' error entry. */}
          <div className="field">
            <Label {...personaIdAria.labelProps}>persona owner</Label>
            <Select
              value={personaIdCtl.field.value || ''}
              onValueChange={val => {
                personaIdCtl.field.onChange(val);
                void trigger(path('guestPersonaIds'));
              }}
            >
              <SelectTrigger {...personaIdAria.controlProps} onBlur={personaIdCtl.field.onBlur} ref={personaIdCtl.field.ref} aria-label="Persona owner">
                <SelectValue placeholder="Pick a host" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {personas.map(p => (
                    <SelectItem key={p.id} value={p.id}>{p.name?.trim() || 'Unnamed'}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription {...personaIdAria.descriptionProps}>
              Who hosts this show. Changing the host after guests are picked can
              leave a guest who is also the new host — Save will refuse and name
              the guests field until you remove the overlap.
            </FieldDescription>
            <FieldError {...personaIdAria.errorProps} errors={personaIdCtl.fieldState.error ? [personaIdCtl.fieldState.error] : undefined} />
          </div>

          {personas.length > 1 && (
            <Field data-invalid={guestsAria.invalid || undefined}>
              <FieldTitle {...guestsAria.labelledByProps}>guest co-hosts</FieldTitle>
              <div {...guestsAria.groupProps}>
                <GuestPersonaPicker
                  personas={personas.filter(p => p.id !== show.personaId)}
                  value={guestIds}
                  onChange={guestsCtl.field.onChange}
                  apiBase={apiBase}
                  max={GUESTS_MAX}
                />
              </div>
              <FieldDescription {...guestsAria.descriptionProps}>
                Optional, up to {GUESTS_MAX}. While this show airs, guests take
                some of the talk breaks (station IDs, time checks, weather and
                news) in their own voice. The host still drives the music and
                track intros.
              </FieldDescription>
              <FieldError {...guestsAria.errorProps} errors={guestsCtl.fieldState.error ? [guestsCtl.fieldState.error] : undefined} />

              <div className="mt-1">
                <SwitchField
                  control={control}
                  name={path('banter')}
                  label="Banter breaks"
                  disabled={guestIds.length === 0}
                  description="Short scripted back-and-forth between the host and guests, each voice rendered separately. Up to twice an hour, depending on the persona's talk frequency. Needs at least one guest."
                />
              </div>
            </Field>
          )}

          <Field>
            <SwitchField
              control={control}
              name={path('pauseTalk')}
              label="Pause-and-talk breaks"
              description="Long skill segments pause the music at a track boundary and speak in the clear. Shorter clips still duck normally; choose the length threshold in Station voice settings."
            />
          </Field>

          <Field>
            <SwitchField
              control={control}
              name={path('programme')}
              label="Programme (produced episode)"
              description="The DJ produces each airing as a full episode from the topic brief: an intro up top, a planned feature mid-hour, and a sign-off in the closing minutes. Fresh angle every episode."
            />
            {show.programme && (
              <div className="mt-2 grid gap-1">
                <Label {...segmentSkillAria.labelProps}>feature segment skill</Label>
                <Select
                  value={segmentSkillCtl.field.value || ANY_SENTINEL}
                  onValueChange={val => segmentSkillCtl.field.onChange(val === ANY_SENTINEL ? '' : val)}
                >
                  <SelectTrigger {...segmentSkillAria.controlProps} onBlur={segmentSkillCtl.field.onBlur} ref={segmentSkillCtl.field.ref} aria-label="Feature segment skill">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value={ANY_SENTINEL}>Producer&apos;s choice</SelectItem>
                      {skills.map(s => (
                        <SelectItem key={s.kind} value={s.kind}>{s.label || s.name || s.kind}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription {...segmentSkillAria.descriptionProps}>
                  Optional. Pin the mid-hour feature to one skill, like news for
                  a morning roundup. Producer&apos;s choice lets each episode
                  decide.
                </FieldDescription>
                <FieldError {...segmentSkillAria.errorProps} errors={segmentSkillCtl.fieldState.error ? [segmentSkillCtl.fieldState.error] : undefined} />
              </div>
            )}
          </Field>

          {/* Raw Controller: ThemePicker renders colour swatches, not a
              text dropdown. */}
          <Field data-invalid={themeAria.invalid || undefined}>
            <FieldTitle {...themeAria.labelledByProps}>theme override (applied while this show is on air)</FieldTitle>
            <div {...themeAria.groupProps}>
              <ThemePicker
                themes={themes}
                activeThemeId={activeThemeId}
                value={themeCtl.field.value || ''}
                onChange={id => themeCtl.field.onChange(id)}
              />
            </div>
            <FieldDescription {...themeAria.descriptionProps}>
              Optional. The player switches to this palette while the show airs,
              then back to the station default. Manage themes in
              Settings → Theme.
            </FieldDescription>
            <FieldError {...themeAria.errorProps} errors={themeCtl.fieldState.error ? [themeCtl.fieldState.error] : undefined} />
          </Field>
        </Card>

        <Card flat title="Music" bodyClass="grid gap-3.5">
          <Field data-invalid={moodsAria.invalid || undefined}>
            <FieldTitle {...moodsAria.labelledByProps}>music moods</FieldTitle>
            <div {...moodsAria.groupProps}>
              <ChipRow
                options={moods.map(m => ({ key: m, label: m }))}
                selected={moodsCtl.field.value ?? []}
                onToggle={m => {
                  const cur: string[] = moodsCtl.field.value ?? [];
                  moodsCtl.field.onChange(cur.includes(m) ? cur.filter(x => x !== m) : [...cur, m]);
                }}
              />
            </div>
            <FieldDescription {...moodsAria.descriptionProps}>
              Pick any that fit; a track matching any of them qualifies. None
              selected = Any (auto), following the station&apos;s own mood.
            </FieldDescription>
            <FieldError {...moodsAria.errorProps} errors={moodsCtl.fieldState.error ? [moodsCtl.fieldState.error] : undefined} />
          </Field>

          <Field data-invalid={erasAria.invalid || undefined}>
            <FieldTitle {...erasAria.labelledByProps}>eras</FieldTitle>
            <div {...erasAria.groupProps}>
              <ChipRow
                options={DECADES.map(d => ({ key: d.key, label: d.label }))}
                selected={DECADES.filter(d => eras.some(e => sameEra(e, d))).map(d => d.key)}
                cap={FILTER_VALUES_MAX - customEras.length}
                onToggle={key => {
                  const d = DECADES.find(x => x.key === key)!;
                  const existing = eras.find(e => sameEra(e, d));
                  setEras(
                    existing
                      ? eras.filter(e => e !== existing)
                      : [...eras, { fromYear: d.from, toYear: d.to }],
                  );
                }}
              />
              {/* Custom windows stay visible and removable so they can't
                  silently constrain picks. */}
              {customEras.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {customEras.map((e, i) => (
                    <button
                      key={`${e.fromYear ?? ''}-${e.toYear ?? ''}-${i}`}
                      type="button"
                      onClick={() => setEras(eras.filter(x => x !== e))}
                      className="min-h-9 border border-ink bg-ink px-2 py-0.5 text-[12px] text-bg sm:min-h-0"
                      title="Remove this custom era window"
                    >
                      {eraLabelOf(e)} ×
                    </button>
                  ))}
                </div>
              )}
              {/* Add a range the decade chips can't spell. Both inputs carry
                  their own aria-label because the group title names the whole
                  field, not either box. */}
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Input
                  id={`${uid}-show-era-from`}
                  type="number" inputMode="numeric"
                  min={YEAR_MIN} max={YEAR_MAX}
                  aria-label="custom era start year"
                  className="w-[7.5rem] flex-none"
                  value={eraFrom}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => { setEraFrom(e.target.value); setEraDraftError(''); }}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addEraRange(); } }}
                  placeholder="from"
                  disabled={eras.length >= FILTER_VALUES_MAX}
                />
                <span aria-hidden="true" className="text-[12px] text-muted">–</span>
                <Input
                  id={`${uid}-show-era-to`}
                  type="number" inputMode="numeric"
                  min={YEAR_MIN} max={YEAR_MAX}
                  aria-label="custom era end year"
                  className="w-[7.5rem] flex-none"
                  value={eraTo}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => { setEraTo(e.target.value); setEraDraftError(''); }}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addEraRange(); } }}
                  placeholder="to"
                  disabled={eras.length >= FILTER_VALUES_MAX}
                />
                <Btn
                  className="min-h-9 flex-none sm:min-h-0"
                  onClick={addEraRange}
                  disabled={(!eraFrom.trim() && !eraTo.trim()) || eras.length >= FILTER_VALUES_MAX}
                >
                  Add range
                </Btn>
              </div>
              {eraDraftError && (
                <span role="alert" className="field-hint text-vermilion">{eraDraftError}</span>
              )}
            </div>
            <FieldDescription {...erasAria.descriptionProps}>
              Pick any decades, even non-adjacent ones ({'"'}90s + 2010s{'"'}).
              Or add your own range — a single year (2026 to 2026), or one
              side left blank for an open end. Up to {FILTER_VALUES_MAX}{' '}
              windows; none selected = any era.
            </FieldDescription>
            <FieldError {...erasAria.errorProps} errors={erasCtl.fieldState.error ? [erasCtl.fieldState.error] : undefined} />
          </Field>

          <ToggleGroupField
            control={control}
            name={path('energies')}
            label="energy"
            multiple
            options={ENERGY_OPTIONS.map(e => ({ value: e, label: e }))}
          />

          <Field data-invalid={vocalsAria.invalid || undefined}>
            <FieldTitle {...vocalsAria.labelledByProps}>vocals</FieldTitle>
            {/* Single-valued: picking one REPLACES the other and clicking the
                selected chip clears back to any -- which ToggleGroupField's
                single-select branch blocks, so this stays a raw Controller. */}
            <div {...vocalsAria.groupProps}>
              <ChipRow
                options={VOCAL_OPTIONS}
                selected={vocalsCtl.field.value ? [vocalsCtl.field.value] : []}
                onToggle={v => vocalsCtl.field.onChange(vocalsCtl.field.value === v ? '' : v)}
                cap={VOCAL_OPTIONS.length}
              />
            </div>
            <FieldDescription {...vocalsAria.descriptionProps}>
              None selected = any. Backed by vocal-activity analysis, so it only
              steers tracks that have had a vocal pass — on a library without
              one it simply doesn&apos;t apply, and the show plays as before.
            </FieldDescription>
            <FieldError {...vocalsAria.errorProps} errors={vocalsCtl.fieldState.error ? [vocalsCtl.fieldState.error] : undefined} />
          </Field>

          <Field data-invalid={genresAria.invalid || undefined}>
            <FieldTitle {...genresAria.labelledByProps}>genre leans</FieldTitle>
            <div {...genresAria.groupProps}>
              {showGenres.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {showGenres.map(g => (
                    <button
                      key={g}
                      type="button"
                      onClick={() => genresCtl.field.onChange(showGenres.filter(x => x !== g))}
                      className="min-h-9 border border-ink bg-ink px-2 py-0.5 text-[12px] text-bg sm:min-h-0"
                      title="Remove this genre"
                    >
                      {g} ×
                    </button>
                  ))}
                </div>
              )}
              <div className="flex min-w-0 gap-2">
                <Input
                  id={`${uid}-show-genre`}
                  type="text" value={genreDraft} maxLength={64}
                  list={`${uid}-show-genre-options`}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setGenreDraft(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addGenre(genreDraft); } }}
                  placeholder={showGenres.length ? 'add another genre' : 'e.g. Jazz (optional)'}
                  disabled={showGenres.length >= FILTER_VALUES_MAX}
                />
                <Btn
                  className="min-h-9 flex-none sm:min-h-0"
                  onClick={() => addGenre(genreDraft)}
                  disabled={!genreDraft.trim() || showGenres.length >= FILTER_VALUES_MAX}
                >
                  Add
                </Btn>
              </div>
              <datalist id={`${uid}-show-genre-options`}>
                {[...genres].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })).map(g => <option key={g} value={g} />)}
              </datalist>
            </div>
            <FieldDescription {...genresAria.descriptionProps}>
              Up to {FILTER_VALUES_MAX}; a track matching any of them qualifies.
            </FieldDescription>
            <FieldError {...genresAria.errorProps} errors={genresCtl.fieldState.error ? [genresCtl.fieldState.error] : undefined} />
            {unknownGenres.length > 0 && (
              <span role="alert" className="field-hint text-vermilion">
                No track in your library is tagged{' '}
                {unknownGenres.map((g, i) => (
                  <span key={g}>{i > 0 ? ', ' : ''}&ldquo;{g}&rdquo;</span>
                ))}
                . The station falls back to the closest tag it can find, so this show
                will air broader results than you asked for — or, if nothing is close,
                the genre filter switches off entirely. Pick a genre from the
                suggestions, or re-tag the tracks in Navidrome.
              </span>
            )}
          </Field>

          <GenreSuggest
            adminFetch={adminFetch}
            value={genreDraft}
            selected={showGenres}
            onSelect={addGenreFromSuggestion}
            disabled={showGenres.length >= FILTER_VALUES_MAX}
          />

          <SwitchField
            control={control}
            name={path('filtersStrict')}
            label="Strict filter"
            disabled={!hasAnyMusicFilter(show)}
            description="Hard-enforces every filter set above (mood, era, energy, genre); off-filter tracks play only as a last resort. When off, they're soft leans the DJ can break for flow. Needs at least one filter set."
          />

          <span className="field-hint -mt-1.5">
            Optional steer for this show: mood, genre, era, energy, or any mix.
            Soft by default, so the DJ leans toward them but can break them for
            flow; Strict filter above makes them hard rules. Mood set to Any
            (auto) follows the station&apos;s own mood instead of pinning one.
          </span>


          <Field>
            <PlaylistIdsField
              control={control}
              name={path('playlistIds')}
              playlists={playlists}
              status={playlistsStatus}
              max={PLAYLISTS_MAX}
              label="playlist anchor"
            >
              <span className="field-hint">
                Pin one or more Navidrome playlists and their combined tracks
                become this show&apos;s pool. The AI DJ still sequences and talks
                over them. Pick none to let genre/era/mood drive selection
                (up to 10).
              </span>
            </PlaylistIdsField>
          </Field>

          {show.playlistIds.length > 0 && (
            <SwitchField
              control={control}
              name={path('playlistStrict')}
              label="Playlist only (strict)"
              description="On: play only the pinned playlist(s); off-playlist tracks air only as a last resort. Off: the playlist dominates but the DJ can still wander for variety. Listener requests always get through, either way."
            />
          )}

          {/* Offered only behind the strict toggle: without it the show can
              leave the playlist, so "every track once" has no set to be true
              of. The controller treats the combination as inert. */}
          {show.playlistIds.length > 0 && show.playlistStrict && (
            <SwitchField
              control={control}
              name={path('playlistExhaust')}
              label="Play the whole playlist before repeating"
              description="On: every track in the pinned playlist(s) airs once before any of them comes round again, however long the playlist is. Off: repeats are governed by the station-wide no-repeat window. Add tracks in Navidrome and the rotation widens on the next pick. A playlist too short to rotate falls back to the station window rather than risking a gap."
            />
          )}

          <Field>
            <PlaylistIdsField
              control={control}
              name={path('excludedPlaylistIds')}
              playlists={playlists}
              status={playlistsStatus}
              max={EXCLUDED_PLAYLISTS_MAX}
              label="excluded playlists"
            >
              <span className="field-hint">
                Tracks from these playlists never play during this show, whatever
                the other filters say. Handy for blocking genres or moods that
                don&apos;t fit: gather them in a Navidrome playlist and exclude it
                here (up to 10).
              </span>
            </PlaylistIdsField>
          </Field>
          <Field>
            <FieldTitle>matching tracks</FieldTitle>
            <FieldDescription>
              See how many tracks fit the music filters above. Excluded playlists
              are already removed from the count. Live picks also account for
              recent plays and the track already on air.
            </FieldDescription>
            <div className="mt-2 flex items-center gap-2">
              <Btn className="min-h-9 sm:min-h-0" onClick={calculateCandidates} disabled={!valid || candidateBusy}>
                {candidateBusy ? 'Counting…' : 'Count matching tracks'}
              </Btn>
              {!valid && <span className="field-hint">Finish the required show fields first.</span>}
            </div>
            {candidateError && <span role="alert" className="field-hint text-vermilion">Could not count matching tracks: {candidateError}</span>}
            {visibleCandidateReport && (
              <div className="mt-2 grid gap-1 border border-ink bg-[var(--muted)] p-3 text-sm">
                {hasAnyMusicFilter(show) ? (
                  <>
                    <span>
                      <strong>{displayedMatchingTracks(visibleCandidateReport).toLocaleString()}</strong>{' '}
                      tracks match these music filters after excluded playlists{visibleCandidateReport.strict
                        ? ', and form this show’s selection pool.'
                        : '. With Strict filter off, the DJ prefers them but can go outside them for flow.'}
                    </span>
                  </>
                ) : (
                  <span className="field-hint">No music filters selected. Add a mood, era, energy, vocal type, or genre to count matches.</span>
                )}
                {visibleCandidateReport.playlist && (
                  <span className="field-hint">Playlist anchor: {visibleCandidateReport.playlist.total.toLocaleString()} tracks · {visibleCandidateReport.playlist.matchingFilters.toLocaleString()} match these filters · {visibleCandidateReport.playlist.afterExclusions.toLocaleString()} after exclusions</span>
                )}
                {visibleCandidateReport.warnings.map(warning => <span key={warning} className="field-hint text-vermilion">{warning}</span>)}
              </div>
            )}
          </Field>

          {scopedRuleCount > 0 && (
            <span className="field-hint">
              {scopedRuleCount} blocklist rule{scopedRuleCount === 1 ? '' : 's'} also
              appl{scopedRuleCount === 1 ? 'ies' : 'y'} to this show — managed on{' '}
              <a href="/admin/library?tab=blocked" className="underline">Library → Blocked</a>.
            </span>
          )}
        </Card>

        <Card flat title="Brief" bodyClass="grid gap-3.5">
          <TextareaField
            control={control}
            name={path('topic')}
            label="topic (fed to the DJ as the show theme)"
            rows={7}
            placeholder="e.g. Slow ambient, modern classical and downtempo for the late shift. Think Nils Frahm, Hammock, Bonobo's quieter side, nothing with a hard beat. Keep the host calm and unhurried, like a friend talking you down at 1am."
            description="The brief the AI DJ works from. The more you describe, the better it picks music and writes links: genres, eras, moods, artists to lean into or avoid, time of day, the listener, how the host should sound. Write it like you're briefing a real DJ before their slot."
            maxLength={TOPIC_MAX}
          />
          <span className="field-hint -mt-2">{show.topic.trim().length}/{TOPIC_MAX}</span>

          {/* Raw Controller: the clamping onChange (floors at 0) is work
              TextField's plain passthrough doesn't expose. */}
          <div className="field">
            <Label {...maxTrackSecondsAria.labelProps}>max track length (seconds)</Label>
            <Input
              {...maxTrackSecondsAria.controlProps}
              type="number"
              min={0}
              max={36000}
              placeholder="inherit"
              value={maxTrackSecondsCtl.field.value ?? ''}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const raw = e.target.value.trim();
                maxTrackSecondsCtl.field.onChange(raw === '' ? null : Math.max(0, parseInt(raw, 10) || 0));
              }}
              onBlur={maxTrackSecondsCtl.field.onBlur}
              ref={maxTrackSecondsCtl.field.ref}
            />
            <FieldDescription {...maxTrackSecondsAria.descriptionProps}>
              The longest a single track plays during this show; anything longer
              fades out at the limit. Blank uses the station limit, 0 means no
              limit (good for long mixes or DJ sets), or set at
              least {minTrackSeconds ?? 30}s to cap it here.
            </FieldDescription>
            <FieldError {...maxTrackSecondsAria.errorProps} errors={maxTrackSecondsCtl.fieldState.error ? [maxTrackSecondsCtl.fieldState.error] : undefined} />
          </div>

          {/* Same raw-Controller reason as the cap. Separate fields because
              each side is independently inheritable (blank). */}
          <div className="field">
            <Label {...minTrackLengthSecondsAria.labelProps}>minimum track length (seconds)</Label>
            <Input
              {...minTrackLengthSecondsAria.controlProps}
              type="number"
              min={0}
              max={3600}
              placeholder="inherit"
              value={minTrackLengthSecondsCtl.field.value ?? ''}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const raw = e.target.value.trim();
                minTrackLengthSecondsCtl.field.onChange(raw === '' ? null : Math.max(0, parseInt(raw, 10) || 0));
              }}
              onBlur={minTrackLengthSecondsCtl.field.onBlur}
              ref={minTrackLengthSecondsCtl.field.ref}
            />
            <FieldDescription {...minTrackLengthSecondsAria.descriptionProps}>
              The shortest a track can be to get picked for this show &mdash; the
              way to keep 40-second skits, interludes and album intros off air.
              Unlike the cap above this drops the track from the pool rather than
              trimming it, so nothing short is ever chosen. Blank uses the
              station setting{stationMinTrackLengthSeconds
                ? ` (${stationMinTrackLengthSeconds}s)`
                : ' (currently off)'}, 0 means no floor, or set at
              least {minTrackSeconds ?? 30}s to set one here. Listener requests
              are always exempt.
            </FieldDescription>
            <FieldError {...minTrackLengthSecondsAria.errorProps} errors={minTrackLengthSecondsCtl.fieldState.error ? [minTrackLengthSecondsCtl.fieldState.error] : undefined} />
          </div>
          {/* Tri-state: "inherit" is a real answer, so a Switch would be wrong. */}
          <div className="field">
            <Label {...fadeAtShowEndAria.labelProps}>fade out at the show change</Label>
            <Select
              value={fadeAtShowEndCtl.field.value == null ? INHERIT_SENTINEL : String(fadeAtShowEndCtl.field.value)}
              onValueChange={val => fadeAtShowEndCtl.field.onChange(val === INHERIT_SENTINEL ? null : val === 'true')}
            >
              <SelectTrigger {...fadeAtShowEndAria.controlProps} onBlur={fadeAtShowEndCtl.field.onBlur} ref={fadeAtShowEndCtl.field.ref} aria-label="Fade out at the show change">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value={INHERIT_SENTINEL}>Station default</SelectItem>
                  <SelectItem value="true">Fade at the boundary</SelectItem>
                  <SelectItem value="false">Let it run over</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription {...fadeAtShowEndAria.descriptionProps}>
              When this show ends, a track still playing is faded out at the
              boundary instead of running into the next show. Worth turning on
              for long-form music (ambient, classical, prog) where one record
              can outlast the slot; a short overrun is left alone either way.
              A cut needs both enough music played before the boundary and more
              than a minute of overrun. A low maximum track length can prevent
              boundary fading, but tracks starting near the end of the show can
              still run into the next one.
            </FieldDescription>
            <FieldError {...fadeAtShowEndAria.errorProps} errors={fadeAtShowEndCtl.fieldState.error ? [fadeAtShowEndCtl.fieldState.error] : undefined} />
          </div>
        </Card>
      </div>
    </EditorDialog>
  );
}

// Shared shape for the two playlist checkbox groups (anchor + exclusions):
// same picker, different field path, cap and group ARIA.
function PlaylistIdsField({
  control, name, playlists, status, max, label, children,
}: {
  control: Control<ShowsFormValues>;
  name: `shows.${number}.playlistIds` | `shows.${number}.excludedPlaylistIds`;
  playlists: { id: string; name: string; songCount: number | null }[];
  status: PlaylistIndexStatus;
  max: number;
  label: string;
  children?: ReactNode;
}) {
  const uid = useId();
  const { field, fieldState } = useController({ control, name });
  const aria = fieldAria(`${uid}-${name}`, fieldState.error);
  return (
    <>
      <FieldTitle {...aria.labelledByProps}>{label}</FieldTitle>
      {children}
      <div {...aria.groupProps}>
        <PlaylistPicker
          playlists={playlists}
          status={status}
          selected={field.value ?? []}
          max={max}
          onChange={field.onChange}
        />
        <FieldError {...aria.errorProps} errors={fieldState.error ? [fieldState.error] : undefined} />
      </div>
    </>
  );
}
