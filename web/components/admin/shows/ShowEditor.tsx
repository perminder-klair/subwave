'use client';

// The inline show editor. Real fields bind straight to react-hook-form via
// `control`+`index` (`shows.${index}.<field>`); nothing is saved here — Save
// show (ShowsPanel.saveShow) persists just this one row. Keyed by show id at
// the call site, so switching shows remounts this component (which resets the
// AiFill box and the local genreDraft buffer — neither is form data).

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
import { EditorDialog, EditorFooter } from '../../ui/editor-dialog';
import { AiFill } from '../AiFill';
import GenreSuggest from '../GenreSuggest';
import { GuestPersonaPicker, ThemePicker, PlaylistPicker } from './ShowPickers';
import { cn } from '../../../lib/cn';
import { fieldAria } from '@/lib/form';
import { SwitchField, TextField, TextareaField, ToggleGroupField } from '@/lib/form-fields';
import {
  ANY_SENTINEL,
  DECADES,
  ENERGY_OPTIONS,
  FILTER_VALUES_MAX,
  GUESTS_MAX,
  NAME_MAX,
  EXCLUDED_PLAYLISTS_MAX,
  PLAYLISTS_MAX,
  TOPIC_MAX,
  VOCAL_OPTIONS,
  eraLabelOf,
  sameEra,
} from './types';
import type { EraWindow, Persona, PlaylistIndexStatus, Show, ShowsFormValues, SkillOption, ThemeOption } from './types';
import { hasAnyMusicFilter, showPayload } from './lib';
import { ChipRow } from './ChipRow';
import { displayedMatchingTracks, type CandidateDiagnostic } from './candidate-diagnostic';
import { fetchShowCandidates, useShowBlocklistQuery } from './queries';

// The footer names the field the schema objected to; the schema's own keys are
// developer-facing, so the common ones get an operator-facing label.
const FIELD_LABELS: Record<string, string> = {
  name: 'name',
  personaId: 'host',
  guestPersonaIds: 'guests',
  maxTrackSeconds: 'track length cap',
  segmentSkill: 'feature skill',
  playlistIds: 'playlists',
  excludedPlaylistIds: 'excluded playlists',
};

// react-hook-form's per-row error object nests by field name, and a couple of
// this show's rules root on an ARRAY field (`eras.0.fromYear`) rather than a
// scalar — walk down to the first real message rather than assuming every key
// is a leaf `{message}`.
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
  // Only needed by personaId's/guestPersonaIds' onChange, to force the OTHER
  // side of the host/guest cross-field `.check()` to re-surface — see the
  // comment on the personaId Controller below for why a plain field.onChange
  // isn't enough here.
  trigger: UseFormTrigger<ShowsFormValues>;
  // This row's own slice of formState.errors.shows — sourced from ShowsPanel
  // so this component never re-derives validity of its own.
  errors: FieldErrors<Show> | undefined;
  editorRef: RefObject<HTMLDivElement | null>;
  personas: Persona[];
  moods: string[];
  themes: ThemeOption[];
  skills: SkillOption[];
  activeThemeId: string;
  genres: string[];
  playlists: { id: string; name: string; songCount: number | null }[];
  // Only 'ready' means /dj/playlists actually answered, so an id absent from
  // `playlists` can't be called missing while the index is merely unknown.
  playlistsStatus: PlaylistIndexStatus;
  apiBase: string;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  minTrackSeconds?: number;
  busy: boolean;
  isNew: boolean;       // show the AI-draft field only while creating
  valid: boolean;
  // Only used by the AI-draft "apply", which hands back several fields at once;
  // every keystroke field binds straight to `control` instead.
  onApplyDraft: (patch: Partial<Show>) => void;
  onSave: () => void;   // Save show — persists just this show (POST /shows)
  onClose: () => void;
  onRemove: () => void;
}

export function ShowEditor({
  show, index, control, trigger, errors, editorRef, personas, moods, themes, skills, activeThemeId, genres, playlists,
  playlistsStatus, apiBase,
  adminFetch, minTrackSeconds, busy, isNew, valid, onApplyDraft,
  onSave, onClose, onRemove,
}: ShowEditorProps) {
  const uid = useId();
  // `index` is a runtime number, not a literal, so a plain template-literal
  // expression widens to `string` — cast to the template-literal type
  // FieldPath<ShowsFormValues> actually needs so every call site below
  // typechecks against the real field name it names.
  const path = <K extends string>(field: K) => `shows.${index}.${field}` as `shows.${number}.${K}`;

  // What the schema actually objected to. A hard-coded "needs a name and a
  // persona" is a dead end for every other reason the gate can fail — a retired
  // mood, a track cap under a raised crossfade floor, a backwards era window.
  const gateIssue = (() => {
    if (valid) return null;
    const first = firstFieldError(errors);
    if (!first) return 'this show fails validation';
    const root = first.key.split('.')[0] ?? first.key;
    const label = FIELD_LABELS[root] ?? root;
    return label ? `${label}: ${first.message}` : first.message;
  })();

  // TextField/SwitchField cover the plain-value fields; anything with real
  // cross-field or array work (a Radix empty-value sentinel, a clamping
  // onChange, a chip input, a manual re-trigger) stays on a raw useController,
  // per lib/form-fields.tsx's own header rule.
  //
  // personaId (host) is a raw Controller for a subtler reason. RHF populates
  // formState.errors per PATH: picking a host who is already a guest flips
  // `isValid` false immediately, but `errors.shows[i].guestPersonaIds` stays
  // `{}` — the cross-field issue is rooted at the SIBLING field, which nothing
  // re-validates until it is touched directly. So Save would read as enabled
  // off a stale errors tree. A plain field.onChange can't fire that re-trigger;
  // this Controller trigger()s the sibling explicitly.
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

  // The editor is remounted per show (keyed by id at the call site), so this
  // resets on switch — it's a text buffer, not form data.
  const [genreDraft, setGenreDraft] = useState('');
  const addGenre = (g: string) => {
    const v = g.trim().slice(0, 64);
    const current = genresCtl.field.value ?? [];
    if (!v || current.length >= FILTER_VALUES_MAX) return;
    if (current.some((x: string) => x.toLowerCase() === v.toLowerCase())) { setGenreDraft(''); return; }
    genresCtl.field.onChange([...current, v]);
    setGenreDraft('');
  };
  // Genres no track carries. The controller resolves free text onto the nearest
  // library tag, silently broadening the show ("Pop Punk" → "Pop") or dropping the
  // filter — invisible on air unless said here. Mirrors show-filter.normGenre so UI
  // and station agree on "the same tag". An empty library list means not fetched or
  // the endpoint failed — never warn on a fetch failure.
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const knownGenres = useMemo(() => new Set(genres.map(norm)), [genres]);
  const showGenres: string[] = genresCtl.field.value ?? [];
  const unknownGenres = genres.length
    ? showGenres.filter(g => !knownGenres.has(norm(g)))
    : [];
  // Discoverability hint only: blocklist rules scoped to this show are edited
  // on Library → Blocked, not here — but a filter that silently loses to a rule
  // there would be baffling without a pointer. Best-effort, 0 hides the line.
  const blocklistQuery = useShowBlocklistQuery(adminFetch, true);
  const scopedRuleCount = (blocklistQuery.data || [])
    .filter(rule => rule.showIds?.includes(show.id)).length;

  const guestIds: string[] = guestsCtl.field.value ?? [];
  const eras: EraWindow[] = erasCtl.field.value ?? [];

  // Guests group — a chip/card multi-select has no single labelable element,
  // so it names itself via aria-labelledby/groupProps, same convention as
  // BlockRulesCard's chip/checkbox fields.
  const guestsAria = fieldAria(`${uid}-${path('guestPersonaIds')}`, guestsCtl.fieldState.error, { hasDescription: true });
  const themeAria = fieldAria(`${uid}-${path('themeId')}`, themeCtl.fieldState.error, { hasDescription: true });
  const segmentSkillAria = fieldAria(`${uid}-${path('segmentSkill')}`, segmentSkillCtl.fieldState.error, { hasDescription: true });
  const moodsAria = fieldAria(`${uid}-${path('moods')}`, moodsCtl.fieldState.error, { hasDescription: true });
  const erasAria = fieldAria(`${uid}-${path('eras')}`, erasCtl.fieldState.error, { hasDescription: true });
  const vocalsAria = fieldAria(`${uid}-${path('vocals')}`, vocalsCtl.fieldState.error, { hasDescription: true });
  const genresAria = fieldAria(`${uid}-${path('genres')}`, genresCtl.fieldState.error, { hasDescription: true });
  const maxTrackSecondsAria = fieldAria(`${uid}-${path('maxTrackSeconds')}`, maxTrackSecondsCtl.fieldState.error, { hasDescription: true });

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
                  valid ? 'bg-[var(--accent)]' : 'bg-[var(--danger)]',
                )}
              />
              <span className="min-w-0">
                {gateIssue
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
              onClick: onSave,
              disabled: busy || !valid,
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

          {/* Raw Controller, not SelectField — see the comment on personaIdCtl
              above: switching the host has to re-trigger `guestPersonaIds`'
              own error entry, a side effect SelectField's plain
              field.onChange passthrough can't express. */}
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

          {/* Raw Controller, not SelectField: ThemePicker renders real colour
              swatches per theme (a card grid, not a text dropdown) — chrome
              SelectField's plain <select> can't express, the same reasoning
              Task 9 kept the custom TTS engine/voice card for. No Radix
              sentinel issue here either way; ThemePicker is plain buttons. */}
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
                onToggle={key => {
                  const d = DECADES.find(x => x.key === key)!;
                  const existing = eras.find(e => sameEra(e, d));
                  erasCtl.field.onChange(
                    existing
                      ? eras.filter(e => e !== existing)
                      : [...eras, { fromYear: d.from, toYear: d.to }],
                  );
                }}
              />
              {/* Custom windows (set via the API — no preset matches) stay
                  visible and removable so they can't silently constrain picks. */}
              {eras.some(e => !DECADES.some(d => sameEra(e, d))) && (
                <div className="flex flex-wrap gap-1">
                  {eras.filter(e => !DECADES.some(d => sameEra(e, d))).map((e, i) => (
                    <button
                      key={`${e.fromYear ?? ''}-${e.toYear ?? ''}-${i}`}
                      type="button"
                      onClick={() => erasCtl.field.onChange(eras.filter(x => x !== e))}
                      className="min-h-9 border border-ink bg-ink px-2 py-0.5 text-[12px] text-bg sm:min-h-0"
                      title="Remove this custom era window"
                    >
                      {eraLabelOf(e)} ×
                    </button>
                  ))}
                </div>
              )}
            </div>
            <FieldDescription {...erasAria.descriptionProps}>
              Pick any decades, even non-adjacent ones ({'"'}90s + 2010s{'"'}).
              None selected = any era.
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
            {/* Single-valued, unlike the filters around it: instrumental and
                vocal are mutually exclusive, and wanting both is wanting
                neither. Picking one REPLACES the other rather than capping at
                one selection; clicking the selected chip clears back to any —
                exactly the behaviour ToggleGroupField's single-select branch
                deliberately BLOCKS (it never lets onValueChange clear to ''),
                so this stays a raw ChipRow/Controller rather than that wrapper. */}
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
            onSelect={addGenre}
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

          {/* Raw Controller: a clamping onChange (floors at 0, coerces a bad
              parseInt to 0) is real work TextField's plain field.onChange
              passthrough doesn't expose. */}
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
        </Card>
      </div>
    </EditorDialog>
  );
}

// Shared shape for the two playlist checkbox groups (anchor + exclusions) —
// same PlaylistPicker, different field path and cap, each with its own group
// ARIA. A tiny local component rather than repeating the useController +
// fieldAria boilerplate twice inline.
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
