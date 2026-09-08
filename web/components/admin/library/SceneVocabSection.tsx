'use client';

// Scene vocabulary (#1577) -- the genre tag set as one curatable list, inside
// the Tagging panel. "Scene" is the Observatory's name for a genre tag; the
// storage is `tracks.genres`. Self-contained (own fetching + merge, modelled on
// BlockRulesCard). Fetched on EXPAND rather than polled.

import { useMemo, useState } from 'react';
import { useDebounceValue } from 'usehooks-ts';
import { Tags, Loader2, X, AlertTriangle } from 'lucide-react';
import { adminJson } from '../../../lib/admin-query';
import { notify } from '../../../lib/notify';
import { Btn } from '../ui';
import { Input } from '../../ui/input';
import { Checkbox } from '../../ui/checkbox';
import { V3Alert } from '../../ui/alert';
import { V3AlertDialog } from '../../ui/alert-dialog';
import { cn } from '../../../lib/cn';
import { libraryKeys } from './queries';
import type { SceneAlias, SceneCount, SceneReference } from './types';
import { useAdminMutation, useAdminQuery } from './useAdminQuery';

interface SceneVocabResponse {
  scenes: SceneCount[];
  aliases: SceneAlias[];
}

interface MergeResponse extends SceneVocabResponse {
  target: string;
  sources: string[];
  /** Fold keys the merge actually recorded -- empty when the rule set already
   *  said everything this merge asked for, which is not a stale listing. */
  recorded: string[];
  tracksChanged: number;
  /** Shows / rules / playlists that named a retired value and now match
   *  nothing. */
  references: SceneReference[];
}

/** POST /library/scenes/references — the same question, asked first. */
interface ReferencesResponse {
  references: SceneReference[];
}

type Sort = 'tracks' | 'name';

// Below this a scene is a one-off worth looking at. Display only.
const TAIL_MAX = 3;

const NO_SCENES: SceneCount[] = [];
const NO_ALIASES: SceneAlias[] = [];
const NO_REFERENCES: SceneReference[] = [];

/** What the operator calls each kind, singular, for the warning line. */
const KIND_LABEL: Record<SceneReference['kind'], string> = {
  show: 'Show',
  rule: 'Never-play rule',
  playlist: 'Playlist',
};

/**
 * The warning body: one line per filter, NAMING it. `remaining` is the REST of
 * that filter's own list and nothing more, so the copy claims nothing more
 * either -- an empty `remaining` does NOT establish that the filter now matches
 * no tracks (another spelling may still catch it, and a tag rule reaches moods
 * and Last.fm tags too).
 */
function ReferenceLines({ items }: { items: readonly SceneReference[] }) {
  return (
    <ul className="flex flex-col gap-1">
      {items.map(r => (
        <li key={`${r.kind}:${r.id}`} className="text-[12px] leading-[1.45]">
          <span className="caption !tracking-[0.04em]">{KIND_LABEL[r.kind]}</span>{' '}
          <b>{r.name}</b> filters on {r.orphaned.map(v => `“${v}”`).join(', ')}, which this
          merge retires
          {r.remaining.length
            ? ` — it also filters on ${r.remaining.map(v => `“${v}”`).join(', ')}.`
            : ' — it has no other value.'}
        </li>
      ))}
    </ul>
  );
}

export default function SceneVocabSection() {
  const [open, setOpen] = useState(false);
  const [sort, setSort] = useState<Sort>('tracks');
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [target, setTarget] = useState('');
  const [confirming, setConfirming] = useState(false);
  // What the LAST merge broke. Kept on screen rather than toasted: it is a list
  // of show names the operator has to go and fix.
  const [aftermath, setAftermath] = useState<SceneReference[] | null>(null);

  const vocab = useAdminQuery<SceneVocabResponse>({
    key: libraryKeys.scenes(),
    path: '/library/scenes',
    enabled: open,
    toastOnError: true,
  });

  // Stable empty fallbacks: a fresh `[]` literal per render would change the
  // useMemo dependency every time.
  const scenes = vocab.data?.scenes ?? NO_SCENES;
  const aliases = vocab.data?.aliases ?? NO_ALIASES;
  const tail = scenes.filter(s => s.tracks <= TAIL_MAX).length;

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const rows = q ? scenes.filter(s => s.value.toLowerCase().includes(q)) : scenes.slice();
    // The server already sorts by count; only the A-Z view re-sorts, via
    // localeCompare so accented tags file where a reader expects them.
    return sort === 'name' ? rows.sort((a, b) => a.value.localeCompare(b.value)) : rows;
  }, [scenes, filter, sort]);

  const pickedSet = new Set(picked);
  // The default survivor is the biggest of the ticked values. Typing over it is
  // the rename case.
  const suggested = picked.length
    ? [...picked].sort(
        (a, b) => (scenes.find(s => s.value === b)?.tracks ?? 0) - (scenes.find(s => s.value === a)?.tracks ?? 0),
      )[0]!
    : '';
  const to = target.trim() || suggested;
  // Verbatim, matching the server: "rock" ticked onto "Rock" is a real merge,
  // because the two are distinct stored rows. A case-insensitive filter here
  // disabled the button on exactly the case-duplicate tail this section cleans.
  const sources = picked.filter(v => v !== to);
  const affected = sources.reduce((n, v) => n + (scenes.find(s => s.value === v)?.tracks ?? 0), 0);

  // The referenced-by warning, BEFORE the confirm (#1593). A merge retires a
  // spelling; a show, blocklist rule or playlist filter still naming it then
  // matches nothing, silently. The judgement stays on the server -- show-filter's
  // own matcher decides whether a filter survives the fold, and a second copy in
  // the browser would drift. A POST because the body carries up to 100 ticked
  // values. Only the typed survivor is debounced; ticking a box is one step.
  const [debouncedTo] = useDebounceValue(to, 250);
  const staged = sources.length > 0 && debouncedTo.length > 0;
  const warn = useAdminQuery<ReferencesResponse>({
    key: libraryKeys.sceneReferences(sources, debouncedTo),
    path: '/library/scenes/references',
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: sources, to: debouncedTo }),
    },
    enabled: open && staged,
    // Silent on failure, deliberately: advisory, and a controller predating the
    // endpoint would otherwise toast on every tick.
    toastOnError: false,
  });
  const references = staged ? (warn.data?.references ?? NO_REFERENCES) : NO_REFERENCES;

  const merge = useAdminMutation<MergeResponse, { from: string[]; to: string }>({
    request: (vars, fetcher) =>
      adminJson<MergeResponse>(fetcher, '/library/scenes/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(vars),
      }),
    toastOnError: true,
    onDone: async (data, _vars, qc) => {
      notify.ok(
        data.tracksChanged > 0
          ? `${data.tracksChanged} track${data.tracksChanged === 1 ? '' : 's'} now tagged “${data.target}”`
          : data.recorded.length > 0
            ? `Nothing to rewrite — “${data.target}” will be applied on the next library scan`
            : `Nothing to do — “${data.target}” already survives every spelling you picked`,
      );
      // The server's own answer, not the preview's: computed against the rule
      // set as it stood at the merge.
      setAftermath(data.references?.length ? data.references : null);
      setPicked([]);
      setTarget('');
      // The response carries the refreshed listing: after a merge every count on
      // screen is wrong.
      qc.setQueryData(libraryKeys.scenes(), { scenes: data.scenes, aliases: data.aliases });
      // A merge rewrites the `genre` scalar on every affected row, so every
      // cached list OF TRACKS is showing a retired spelling. `rows` is the family
      // they all sit under.
      await Promise.all([
        qc.invalidateQueries({ queryKey: libraryKeys.rows }),
        // The genre pickers elsewhere read their own endpoint and are now stale.
        qc.invalidateQueries({ queryKey: libraryKeys.genres() }),
        // Coverage's byGenre tally is memoised server-side and was just
        // invalidated there.
        qc.invalidateQueries({ queryKey: libraryKeys.coverage() }),
      ]);
    },
  });

  const forget = useAdminMutation<SceneVocabResponse, string>({
    request: (from, fetcher) =>
      adminJson<SceneVocabResponse>(fetcher, `/library/scenes/aliases/${encodeURIComponent(from)}`, {
        method: 'DELETE',
      }),
    toastOnError: true,
    onDone: (data, _from, qc) => {
      qc.setQueryData(libraryKeys.scenes(), { scenes, aliases: data.aliases });
    },
  });

  const busy = merge.isPending || forget.isPending;

  const toggle = (value: string) =>
    setPicked(prev => (prev.includes(value) ? prev.filter(v => v !== value) : [...prev, value]));

  const summary = !open
    ? 'merge near-duplicate genre tags'
    : vocab.isPending
      ? 'loading…'
      : `${scenes.length} scene${scenes.length === 1 ? '' : 's'}${tail ? ` · ${tail} with ${TAIL_MAX} tracks or fewer` : ''}`;

  return (
    <>
      <div className="border-b border-ink px-4 py-3.5 sm:px-6">
        <button
          type="button"
          className={cn(
            'inline-flex cursor-pointer flex-wrap items-center gap-1.5 text-[11px] font-bold',
            open ? 'text-ink' : 'text-muted hover:text-ink',
          )}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <Tags size={13} /> Scene vocabulary
          <span className="caption mono-num font-normal !tracking-[0.04em] text-muted !normal-case">
            — {summary}
          </span>
          <span aria-hidden>{open ? '▾' : '▸'}</span>
        </button>
      </div>

      {open && (
        <div className="flex flex-col gap-3 border-b border-ink px-4 py-4 sm:px-6">
          <span className="caption !tracking-[0.04em] !normal-case">
            Every genre tag your library carries, straight from the files. Tick the spellings that
            mean the same thing and merge them into one — the tracks are re-tagged in place, and the
            same fold is applied to every future library scan so it stays merged.
          </span>

          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="h-7 w-44 px-2 text-xs"
              placeholder="Filter scenes…"
              value={filter}
              aria-label="Filter scenes"
              onChange={e => setFilter(e.currentTarget.value)}
            />
            <Btn
              sm
              tone={sort === 'tracks' ? 'accent' : undefined}
              onClick={() => setSort('tracks')}
              title="Most-used first"
            >
              By tracks
            </Btn>
            <Btn
              sm
              tone={sort === 'name' ? 'accent' : undefined}
              onClick={() => setSort('name')}
              title="Alphabetical — near-duplicates sit next to each other"
            >
              A–Z
            </Btn>
            {vocab.isFetching && <Loader2 size={13} className="animate-spin text-muted" />}
            <span className="caption mono-num ml-auto !tracking-[0.04em]">
              {shown.length} shown
            </span>
          </div>

          {vocab.isPending ? (
            <span className="caption !normal-case">Reading the tag set…</span>
          ) : scenes.length === 0 ? (
            <span className="caption !normal-case">
              No genre tags yet — run a library scan first.
            </span>
          ) : (
            <ul className="max-h-72 divide-y divide-separator-strong overflow-y-auto border border-separator-strong">
              {shown.map(s => (
                <li key={s.value} className="flex items-center gap-2.5 px-2.5 py-1.5">
                  <Checkbox
                    checked={pickedSet.has(s.value)}
                    disabled={busy}
                    aria-label={`Select ${s.value}`}
                    onCheckedChange={() => toggle(s.value)}
                  />
                  <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{s.value}</span>
                  <span
                    className={cn(
                      'mono-num text-[11px]',
                      s.tracks <= TAIL_MAX ? 'text-vermilion' : 'text-muted',
                    )}
                  >
                    {s.tracks}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {picked.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 border border-ink bg-ink-soft px-2.5 py-2">
              <span className="caption !tracking-[0.04em] !normal-case">
                Merge <b className="mono-num">{picked.length}</b> scene
                {picked.length === 1 ? '' : 's'} into
              </span>
              <Input
                className="h-7 w-52 px-2 text-xs"
                value={target}
                placeholder={suggested}
                aria-label="Surviving scene name"
                disabled={busy}
                onChange={e => setTarget(e.currentTarget.value)}
              />
              <Btn
                sm
                tone="accent"
                disabled={busy || sources.length === 0 || !to}
                onClick={() => setConfirming(true)}
                title={
                  sources.length === 0
                    ? 'Pick a second scene, or type a different name to rename this one'
                    : `Rewrite ${affected} track tag${affected === 1 ? '' : 's'}`
                }
              >
                {merge.isPending ? <Loader2 size={12} className="animate-spin" /> : null} Merge
              </Btn>
              <Btn sm disabled={busy} onClick={() => { setPicked([]); setTarget(''); }}>
                Clear
              </Btn>
              <span className="caption basis-full !tracking-[0.04em] !normal-case">
                {sources.length === 0
                  ? 'Everything ticked already IS the target — type a new name above to rename it.'
                  : `${affected} track tag${affected === 1 ? '' : 's'} will be rewritten to “${to}”.`}
              </span>
              {references.length > 0 && (
                <div className="basis-full border border-vermilion bg-bg px-2.5 py-2 text-vermilion">
                  <span className="caption flex items-center gap-1.5 !text-vermilion">
                    <AlertTriangle size={12} />
                    {references.length} filter{references.length === 1 ? '' : 's'} name
                    {references.length === 1 ? 's' : ''} a spelling this merge retires
                  </span>
                  <div className="mt-1 text-ink">
                    <ReferenceLines items={references} />
                  </div>
                  {/* The merge is not blocked and the filter is not rewritten:
                      genre matching is one-directional. */}
                  <span className="caption mt-1 block !tracking-[0.04em] !normal-case">
                    The merge is still fine to run — these just need repointing at “{to}”
                    afterwards, by hand.
                  </span>
                </div>
              )}
            </div>
          )}

          {aftermath && aftermath.length > 0 && (
            <V3Alert
              tone="error"
              title={`${aftermath.length} filter${aftermath.length === 1 ? '' : 's'} to repoint`}
            >
              <ReferenceLines items={aftermath} />
              <div className="caption mt-1.5 flex items-center gap-2 !tracking-[0.04em] !normal-case">
                The merge is done; nothing repointed these for you.
                <button
                  type="button"
                  className="caption cursor-pointer underline"
                  onClick={() => setAftermath(null)}
                >
                  Dismiss
                </button>
              </div>
            </V3Alert>
          )}

          {aliases.length > 0 && (
            <div className="border-t border-dashed border-separator-strong pt-3">
              <span className="caption flex items-center gap-2">
                Folds applied on every scan
                <span className="mono-num">{aliases.length}</span>
              </span>
              {/* The left side is the fold KEY the controller matches against,
                  not any one retired spelling -- several can share it. */}
              <span className="caption mt-0.5 block !tracking-[0.04em] !normal-case">
                Matched on the left-hand key, ignoring case and spacing.
              </span>
              <ul className="mt-1.5 flex flex-wrap gap-1.5">
                {aliases.map(a => (
                  <li
                    key={a.from}
                    className="flex items-center gap-1.5 border border-separator-strong px-1.5 py-0.5 text-[11px] text-muted"
                  >
                    <span className="font-mono">{a.from}</span>
                    <span aria-hidden>→</span>
                    <span className="font-mono text-ink">{a.to}</span>
                    <button
                      type="button"
                      className="text-muted hover:text-vermilion"
                      disabled={busy}
                      aria-label={`Stop folding ${a.from} into ${a.to}`}
                      title="Stop applying this on future scans. Tracks already re-tagged keep the merged name — there is nothing to restore them to."
                      onClick={() => { void forget.mutateAsync(a.from).catch(() => undefined); }}
                    >
                      <X size={11} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <V3AlertDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Merge into “${to}”?`}
        description={
          <>
            {`${sources.map(s => `“${s}”`).join(', ')} will be rewritten to “${to}” on ` +
              `${affected} track tag${affected === 1 ? '' : 's'}, and folded the same way on every ` +
              `future library scan. The old spellings are not recoverable.`}
            {references.length > 0 && (
              <span className="mt-3 block border border-destructive px-2.5 py-2 text-destructive">
                <span className="caption block !text-destructive">
                  These name a spelling you are retiring
                </span>
                <span className="mt-1 block text-ink">
                  <ReferenceLines items={references} />
                </span>
              </span>
            )}
          </>
        }
        confirmLabel="merge"
        danger
        onConfirm={() => {
          void merge.mutateAsync({ from: sources, to }).catch(() => undefined);
        }}
      />
    </>
  );
}
