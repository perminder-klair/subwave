'use client';

// Rule entries on the Blocked tab (#1300 FR 1) — attribute/tag "never air"
// predicates beside the id-entry table: genre/tag/mood/artist/album/title
// values, an optional seasonal allow-window ("Christmas tracks only air
// Dec 1–26"), and an optional show scope. Self-contained (own fetching + CRUD
// against /library/blocklist/rules, modelled on FestivalsSection) so
// LibraryPanel only mounts it and re-marks rows after a change.

import { useId, useState } from 'react';
import { CalendarRange, Plus, ShieldBan, Snowflake } from 'lucide-react';
import {
  Controller, useWatch, type Control, type DefaultValues,
} from 'react-hook-form';
import type { z } from 'zod';
import { AdminResponseError, adminJson, adminResponse } from '../../../lib/admin-query';
import { notify, errorMessage } from '../../../lib/notify';
import { Card, Btn } from '../ui';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '../../ui/select';
import { Modal } from '../../ui/modal';
import { V3AlertDialog } from '../../ui/alert-dialog';
import { SkeletonRows } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { cn } from '../../../lib/cn';
import { FieldError } from '../../ui/field';
import { blockRuleSchema, RULE_TEXT_MAX } from '@/lib/schemas.generated';
import { useZodForm, applyServerFieldErrors, fieldAria } from '@/lib/form';
import { TextField } from '@/lib/form-fields';
import type { BlockRuleStat, RuleField, SeasonWindow } from './types';
import { libraryKeys } from './queries';
import { useAdminMutation, useAdminQuery } from './useAdminQuery';
import { settingsKeys } from '../settings/queries';
import { showKeys } from '../shows/queries';
import type { SettingsResponse as ShowSettingsResponse } from '../shows/types';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTH_SHORT = MONTH_NAMES.map(m => m.slice(0, 3));

const DAYS_IN_MONTH = (m: number) => {
  if (m === 2) return 29;
  if ([4, 6, 9, 11].includes(m)) return 30;
  return 31;
};

const FIELD_OPTIONS: Array<{ value: RuleField; label: string; hint: string }> = [
  { value: 'tag', label: 'Any tag', hint: 'exact match across genre tags, moods, audio moods and Last.fm tags — the widest net' },
  { value: 'genre', label: 'Genre', hint: 'blocking a genre also blocks its refinements — "Punk" covers "Punk Rock"' },
  { value: 'mood', label: 'Mood', hint: 'editorial + audio moods' },
  { value: 'artist', label: 'Artist name', hint: 'exact name match — for one specific artist, the row action is more precise' },
  { value: 'album', label: 'Album name', hint: 'exact name match' },
  { value: 'title', label: 'Track title', hint: 'exact title match' },
  { value: 'playlist', label: 'Playlist', hint: 'blocks every member of the selected Navidrome playlists' },
];

// The RHF-bound shape of one rule form — matches blockRuleSchema's OUTPUT
// (z.output), which is also close enough to its input to serve as
// defaultValues: every field that isn't structurally typed in the schema
// (label/values/season/showIds are z.unknown()/z.preprocess() so the schema
// coerces and reports rather than requiring a shaped input) collapses to
// `unknown` on the input side, same as FestivalsSection/SkillEditModal — so
// `form.control` is cast to `Control<RuleForm>` once below rather than fought
// at every call site.
interface RuleForm {
  label: string;
  field: RuleField;
  values: string[];
  season: SeasonWindow | null;
  showIds: string[];
}

const EMPTY_RULE: RuleForm = { label: '', field: 'tag', values: [], season: null, showIds: [] };

// The headline ask, one click: Christmas out of season.
const XMAS_PRESET: RuleForm = {
  label: 'Christmas songs',
  field: 'tag',
  values: ['christmas'],
  season: { from: { month: 12, day: 1 }, to: { month: 12, day: 26 } },
  showIds: [],
};

const fmtSeason = (s: SeasonWindow) =>
  `${MONTH_SHORT[s.from.month - 1]} ${s.from.day} – ${MONTH_SHORT[s.to.month - 1]} ${s.to.day}`;

// Chip-style multi-value input: type, Enter/comma commits. A plain text field
// split on save would hide the any-of semantics the chips make visible.
function ValuesInput({ id, values, onChange, placeholder, suggestions }: {
  id: string;
  values: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
  suggestions?: string[];
}) {
  const [draft, setDraft] = useState('');
  const listId = `${id}-suggest`;
  const commit = () => {
    const t = draft.trim();
    setDraft('');
    if (!t) return;
    if (values.some(v => v.toLowerCase() === t.toLowerCase())) return;
    onChange([...values, t]);
  };
  return (
    <div>
      {values.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {values.map(v => (
            <span key={v} className="lib-mtag inline-flex items-center gap-1">
              {v}
              <button
                type="button"
                className="cursor-pointer border-0 bg-transparent p-0 leading-none text-muted hover:text-ink"
                onClick={() => onChange(values.filter(x => x !== v))}
                aria-label={`remove ${v}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <Input
        id={id}
        value={draft}
        list={suggestions?.length ? listId : undefined}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); }
        }}
        onBlur={commit}
        placeholder={placeholder}
        maxLength={64}
      />
      {suggestions && suggestions.length > 0 && (
        <datalist id={listId}>
          {suggestions.map(s => <option key={s} value={s} />)}
        </datalist>
      )}
    </div>
  );
}

export function BlockRulesCard({ onChanged }: { onChanged?: () => void }) {
  const [busy, setBusy] = useState(false);
  // Whether the editor modal is open — separate from the form's own state
  // now that the rule being edited lives in react-hook-form rather than a
  // `RuleForm | null` useState.
  const [formOpen, setFormOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // Picker vocab, loaded once alongside the rules. Failures degrade to free
  // text (genres) / an empty list with a hint (shows, playlists).
  const fieldId = useId();

  const form = useZodForm(
    blockRuleSchema,
    EMPTY_RULE as DefaultValues<z.input<typeof blockRuleSchema>>,
  );
  const control = form.control as unknown as Control<RuleForm>;
  const fieldWatch = useWatch({ control, name: 'field' });
  const labelWatch = useWatch({ control, name: 'label' });

  const rulesQuery = useAdminQuery<BlockRuleStat[]>({
    key: libraryKeys.blockRules(),
    path: '/library/blocklist',
    parse: raw => (raw as { rules?: BlockRuleStat[] }).rules || [],
    toastOnError: true,
  });
  const genresQuery = useAdminQuery<string[]>({
    key: libraryKeys.genres(),
    path: '/library/genres',
    parse: raw => ((raw as { genres?: Array<{ value: string }> }).genres || [])
      .map(genre => genre.value).filter(Boolean),
  });
  const showsQuery = useAdminQuery<ShowSettingsResponse>({
    key: settingsKeys.detail(),
    path: '/settings',
  });
  const playlistsQuery = useAdminQuery<Array<{ id: string; name: string; songCount: number | null }>>({
    key: libraryKeys.rulePlaylists(),
    path: '/dj/playlists',
    parse: raw => (raw as { results?: Array<{ id: string; name: string; songCount: number | null }> })
      .results || [],
  });
  const rules = rulesQuery.data ?? (rulesQuery.error ? [] : null);
  const genres = genresQuery.data ?? [];
  const shows = (showsQuery.data?.values?.shows || []).flatMap(show => (
    show.id && show.name ? [{ id: show.id, name: show.name }] : []
  ));
  const playlists = playlistsQuery.data ?? [];

  type SaveVars = { id: string | null; values: RuleForm };
  type SaveReceipt = { rule?: BlockRuleStat; purged?: number };
  const saveMutation = useAdminMutation<SaveReceipt, SaveVars>({
    request: ({ id, values }, fetcher) => adminJson<SaveReceipt>(
      fetcher,
      id ? `/library/blocklist/rules/${encodeURIComponent(id)}` : '/library/blocklist/rules',
      {
        method: id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      },
    ),
    onDone: async (_receipt, _vars, client) => {
      await client.invalidateQueries({ queryKey: libraryKeys.blockRules(), exact: true });
      await client.invalidateQueries({ queryKey: showKeys.blocklist(), exact: true });
    },
    toastOnError: false,
  });
  const deleteMutation = useAdminMutation<void, string>({
    request: async (id, fetcher) => {
      try {
        await adminResponse(fetcher, `/library/blocklist/rules/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        });
      } catch (error) {
        if (!(error instanceof AdminResponseError) || error.status !== 404) throw error;
      }
    },
    onDone: async (_receipt, _id, client) => {
      await client.invalidateQueries({ queryKey: libraryKeys.blockRules(), exact: true });
      await client.invalidateQueries({ queryKey: showKeys.blocklist(), exact: true });
    },
    toastOnError: false,
  });

  // The form is bound to blockRuleSchema via react-hook-form/zodResolver —
  // the SAME schema the route runs (validateBody(blockRuleSchema) on both
  // POST and PUT) — so the FORM is react-hook-form shaped now. The
  // individual CONTROLS underneath it still mostly aren't: the "Match on"
  // picker needs a side effect plain SelectField can't express (clearing
  // `values` when the field type changes — see its own comment below), and
  // the chip `values` input plus the two month/day season pickers stay on
  // raw `Controller` because ValuesInput's commit-on-Enter/blur behaviour and
  // the season toggle/month-day cascade are real work none of the five bound
  // field components expose. Form: react-hook-form shaped. Controls: mostly
  // not, same as before.
  const onSubmit = form.handleSubmit(async (values) => {
    setBusy(true);
    try {
      // `values` is the TRANSFORMED (z.output) payload — trimmed label,
      // blank values dropped, duplicates collapsed — so what the operator
      // sees accepted is what gets stored.
      const j = await saveMutation.mutateAsync({ id: editId, values });
      setFormOpen(false);
      setEditId(null);
      notify.ok(`Rule ${editId ? 'updated' : 'added'}${j.purged ? ` — ${j.purged} queued track${j.purged === 1 ? '' : 's'} dropped` : ''}`);
      onChanged?.();
    } catch (e) {
      if (e instanceof AdminResponseError) applyServerFieldErrors(form, e.body.fieldErrors);
      notify.err(`Save failed: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  });

  const remove = async (id: string) => {
    setBusy(true);
    try {
      await deleteMutation.mutateAsync(id);
      setFormOpen(false);
      setEditId(null);
      notify.ok('Rule removed');
      onChanged?.();
    } catch (e) {
      notify.err(`Remove failed: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (rule: BlockRuleStat) => {
    form.reset({
      label: rule.label,
      field: rule.field,
      values: [...rule.values],
      season: rule.season ? { from: { ...rule.season.from }, to: { ...rule.season.to } } : null,
      showIds: [...rule.showIds],
    });
    setEditId(rule.id);
    setFormOpen(true);
  };

  const playlistNameOf = (id: string) => playlists.find(p => p.id === id)?.name || `(missing) ${id}`;
  const showNameOf = (id: string) => shows.find(s => s.id === id)?.name || `(deleted show) ${id}`;

  const rows = rules || [];

  return (
    <>
      <Card
        title="Blocking rules"
        sub="Attribute rules beside the entries below — block a whole genre or tag, keep seasonal music to its dates, or scope a block to certain shows"
        right={
          <div className="flex items-center gap-2">
            {rows.length === 0 && rules !== null && (
              <Btn
                sm
                onClick={() => { form.reset(XMAS_PRESET); setEditId(null); setFormOpen(true); }}
                title="Prefill: tracks tagged christmas only air Dec 1–26"
              >
                <Snowflake size={11} /> Seasonal preset
              </Btn>
            )}
            <Btn
              sm
              tone="accent"
              onClick={() => { form.reset(EMPTY_RULE); setEditId(null); setFormOpen(true); }}
              disabled={rules === null}
            >
              <Plus size={11} /> Add rule
            </Btn>
          </div>
        }
        bodyClass="!p-0"
      >
        {rules === null ? (
          <SkeletonRows rows={2} className="m-4" />
        ) : rows.length === 0 ? (
          <EmptyState
            compact
            title="No rules yet"
            description={<>Rules block by attribute — every track tagged <em>christmas</em>, a whole genre, a playlist — where the entries below block one exact id.</>}
          />
        ) : (
          rows.map(rule => (
            <button
              key={rule.id}
              type="button"
              disabled={busy}
              onClick={() => startEdit(rule)}
              className="flex w-full cursor-pointer items-center gap-3 border-b border-dashed border-[var(--separator-strong)] px-4 py-2.5 text-left last:border-b-0 hover:bg-[var(--ink-soft)]"
            >
              <ShieldBan size={14} className={cn('shrink-0', rule.active ? 'text-vermilion' : 'text-muted')} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2.5">
                  <span className="lib-title truncate">{rule.label}</span>
                  {rule.active ? (
                    <span className="flex-none text-[9px] font-bold tracking-[0.2em] text-vermilion uppercase">● blocking</span>
                  ) : (
                    <span className="flex-none text-[9px] font-bold tracking-[0.2em] text-muted uppercase">
                      {rule.season ? 'in season' : 'inactive'}
                    </span>
                  )}
                </span>
                <span className="lib-artist block truncate">
                  {FIELD_OPTIONS.find(f => f.value === rule.field)?.label || rule.field}
                  {': '}
                  {rule.field === 'playlist' ? rule.values.map(playlistNameOf).join(', ') : rule.values.join(', ')}
                </span>
              </span>
              <span className="hidden items-center gap-2.5 text-[11px] text-muted sm:flex">
                {rule.season && (
                  <span className="inline-flex items-center gap-1" title="allowed on air only between these dates">
                    <CalendarRange size={11} aria-hidden /> {fmtSeason(rule.season)}
                  </span>
                )}
                {rule.showIds.length > 0 && (
                  <span title={rule.showIds.map(showNameOf).join(', ')}>
                    {rule.showIds.length} show{rule.showIds.length === 1 ? '' : 's'}
                  </span>
                )}
                <span className="mono-num" title="tracks in the library this rule matches (whether or not it is blocking right now)">
                  {rule.matchCount} track{rule.matchCount === 1 ? '' : 's'}
                </span>
              </span>
            </button>
          ))
        )}
      </Card>

      <Modal
        open={formOpen}
        onOpenChange={o => { if (!o) { setFormOpen(false); setEditId(null); } }}
        title={editId ? 'edit rule' : 'new rule'}
        sub={editId ? labelWatch : undefined}
        width={560}
        footer={
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            {editId ? (
              <Btn sm tone="danger" className="min-h-9 sm:min-h-0" onClick={() => setConfirmDelete(editId)} disabled={busy}>
                Remove
              </Btn>
            ) : <span />}
            <div className="flex items-center gap-2">
              <Btn
                sm
                className="min-h-9 sm:min-h-0"
                onClick={() => { setFormOpen(false); setEditId(null); }}
                disabled={busy}
              >
                Cancel
              </Btn>
              <Btn
                sm
                tone="accent"
                className="min-h-9 sm:min-h-0"
                onClick={() => { void onSubmit(); }}
                disabled={busy || !form.formState.isValid}
              >
                {busy ? 'Saving…' : editId ? 'Save changes' : 'Add rule'}
              </Btn>
            </div>
          </div>
        }
      >
        {formOpen && (
          <div className="grid gap-4">
            <TextField control={control} name="label" label="Name" placeholder="e.g. Christmas songs" maxLength={RULE_TEXT_MAX} />

            {/* Raw Controller, not SelectField: switching "Match on" has to clear
                `values` too. Without it, leftover chip values from one field type
                (e.g. genre names) would silently ride along as extra, meaningless
                entries in a rule that's now scoped to `playlist` — the playlist
                checkbox branch below only ever ADDS to `values`, so nothing else
                would ever clear the stale ones. That's real work SelectField's
                plain field.onChange passthrough doesn't expose. */}
            <Controller
              control={control}
              name="field"
              render={({ field: rhfField, fieldState }) => {
                const baseId = `${fieldId}-field`;
                const aria = fieldAria(baseId, fieldState.error);
                const fieldOpt = FIELD_OPTIONS.find(f => f.value === rhfField.value);
                return (
                  <div className="field">
                    <Label {...aria.labelProps}>Match on</Label>
                    <Select
                      value={rhfField.value}
                      onValueChange={v => {
                        rhfField.onChange(v as RuleField);
                        form.setValue('values', [], { shouldValidate: true, shouldDirty: true });
                      }}
                    >
                      <SelectTrigger {...aria.controlProps} onBlur={rhfField.onBlur} ref={rhfField.ref} aria-label="Match on">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {FIELD_OPTIONS.map(f => (
                          <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {fieldOpt && <div className="field-hint mt-1">{fieldOpt.hint}</div>}
                    {fieldState.error && <FieldError {...aria.errorProps} errors={[fieldState.error]} />}
                  </div>
                );
              }}
            />

            {/* Raw Controller: a chip input (commit-on-Enter/blur, its own draft
                state) and a checkbox list are both group controls with no single
                labelable element — house policy per lib/form-fields.tsx's header
                scopes chip inputs to Controller, and aria-labelledby/groupProps
                (not htmlFor) is how a Field wrapping a GROUP names itself. */}
            <Controller
              control={control}
              name="values"
              render={({ field, fieldState }) => {
                const baseId = `${fieldId}-values`;
                const aria = fieldAria(baseId, fieldState.error);
                if (fieldWatch === 'playlist') {
                  return (
                    <div className="field">
                      <Label {...aria.labelledByProps}>Playlists</Label>
                      {playlists.length === 0 ? (
                        <div className="field-hint">No Navidrome playlists found (or Navidrome unreachable) — reopen this dialog to retry.</div>
                      ) : (
                        <div {...aria.groupProps} className="grid max-h-44 gap-1 overflow-auto">
                          {playlists.map(pl => (
                            <label key={pl.id} className="flex cursor-pointer items-center gap-2 text-[12px]">
                              <input
                                type="checkbox"
                                checked={field.value.includes(pl.id)}
                                onChange={() => field.onChange(
                                  field.value.includes(pl.id)
                                    ? field.value.filter(v => v !== pl.id)
                                    : [...field.value, pl.id],
                                )}
                              />
                              <span className="truncate">{pl.name}</span>
                              {pl.songCount != null && <span className="mono-num text-[10px] text-muted">{pl.songCount}</span>}
                            </label>
                          ))}
                        </div>
                      )}
                      {/* Same group, same `values` field — `values` resets to
                          [] on every switch INTO playlist mode (see the field
                          Controller above), so an unchecked list is the
                          default state here, not a rare edge case. Rendering
                          the error is the better answer to "why is Save
                          disabled": the alternative (stop spreading
                          aria-describedby) would leave a screen-reader user
                          with aria-invalid and no explanation at all. */}
                      {fieldState.error && <FieldError {...aria.errorProps} errors={[fieldState.error]} />}
                    </div>
                  );
                }
                return (
                  <div className="field">
                    <Label {...aria.labelledByProps}>Values <span className="text-muted">(any of, Enter to add)</span></Label>
                    <div {...aria.groupProps}>
                      <ValuesInput
                        id={baseId}
                        values={field.value}
                        onChange={field.onChange}
                        placeholder={fieldWatch === 'genre' ? 'e.g. Death Metal' : fieldWatch === 'tag' ? 'e.g. christmas' : 'add a value…'}
                        suggestions={fieldWatch === 'genre' || fieldWatch === 'tag' ? genres : undefined}
                      />
                    </div>
                    {fieldState.error && <FieldError {...aria.errorProps} errors={[fieldState.error]} />}
                  </div>
                );
              }}
            />

            <Controller
              control={control}
              name="season"
              render={({ field }) => {
                const season = field.value;
                return (
                  <div className="field">
                    <label className="flex cursor-pointer items-center gap-2 text-[12px]">
                      <input
                        type="checkbox"
                        checked={season !== null}
                        onChange={() => field.onChange(
                          season ? null : { from: { month: 12, day: 1 }, to: { month: 12, day: 26 } },
                        )}
                      />
                      <span>Seasonal — allow on air only between two dates</span>
                    </label>
                    {season && (
                      <>
                        <div className="mt-2 grid grid-cols-2 gap-3">
                          {(['from', 'to'] as const).map(end => (
                            <div key={end} className="grid grid-cols-2 gap-2">
                              <div className="field">
                                <Label htmlFor={`${fieldId}-${end}-m`}>{end === 'from' ? 'From' : 'To'}</Label>
                                <Select
                                  value={String(season[end].month)}
                                  onValueChange={v => {
                                    const month = Number(v);
                                    field.onChange({
                                      ...season,
                                      [end]: { month, day: Math.min(season[end].day, DAYS_IN_MONTH(month)) },
                                    });
                                  }}
                                >
                                  <SelectTrigger id={`${fieldId}-${end}-m`} aria-label={`${end} month`}>
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
                                <Label htmlFor={`${fieldId}-${end}-d`}>Day</Label>
                                <Select
                                  value={String(season[end].day)}
                                  onValueChange={v => field.onChange({
                                    ...season,
                                    [end]: { ...season[end], day: Number(v) },
                                  })}
                                >
                                  <SelectTrigger id={`${fieldId}-${end}-d`} aria-label={`${end} day`}>
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {Array.from({ length: DAYS_IN_MONTH(season[end].month) }, (_, i) => (
                                      <SelectItem key={i + 1} value={String(i + 1)}>{i + 1}</SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                            </div>
                          ))}
                        </div>
                        <div className="field-hint mt-1">
                          Matching tracks are blocked the rest of the year. A window may wrap the year end (Dec 1 → Jan 6).
                        </div>
                      </>
                    )}
                  </div>
                );
              }}
            />

            <Controller
              control={control}
              name="showIds"
              render={({ field }) => (
                <div className="field">
                  <Label>Only during certain shows <span className="text-muted">(optional — empty is station-wide)</span></Label>
                  {shows.length === 0 ? (
                    <div className="field-hint">No shows defined — the rule applies station-wide.</div>
                  ) : (
                    <div className="grid max-h-36 gap-1 overflow-auto">
                      {shows.map(s => (
                        <label key={s.id} className="flex cursor-pointer items-center gap-2 text-[12px]">
                          <input
                            type="checkbox"
                            checked={field.value.includes(s.id)}
                            onChange={() => field.onChange(
                              field.value.includes(s.id)
                                ? field.value.filter(v => v !== s.id)
                                : [...field.value, s.id],
                            )}
                          />
                          <span className="truncate">{s.name}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )}
            />
          </div>
        )}
      </Modal>

      <V3AlertDialog
        open={confirmDelete != null}
        onOpenChange={o => { if (!o) setConfirmDelete(null); }}
        title="Remove rule"
        description={
          confirmDelete != null
            ? `Remove "${rows.find(r => r.id === confirmDelete)?.label ?? confirmDelete}"? Everything it blocks becomes pickable again.`
            : ''
        }
        confirmLabel="Remove"
        danger
        onConfirm={() => {
          if (confirmDelete != null) { void remove(confirmDelete); setConfirmDelete(null); }
        }}
      />
    </>
  );
}
