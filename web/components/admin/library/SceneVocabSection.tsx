'use client';

// Scene vocabulary (issue #1577) — the genre tag set as one curatable list,
// inside the Tagging panel beside the mood/energy coverage it comes out of.
//
// "Scene" is what the Observatory calls a genre tag and what the operator asked
// for; the storage is `tracks.genres`. After a full library pass a real
// catalogue carries near-duplicates and one-off spellings that each hold a
// handful of tracks, and until now there was no way to see them, let alone
// merge them.
//
// Self-contained (own fetching + merge, modelled on BlockRulesCard) so the
// presentational TaggingPanel only mounts it. Fetched on EXPAND rather than
// polled, like the analysis-failures list: a healthy vocabulary is not
// something anyone watches change, and the list is the whole tag set.

import { useMemo, useState } from 'react';
import { Tags, Loader2, X } from 'lucide-react';
import { adminJson } from '../../../lib/admin-query';
import { notify } from '../../../lib/notify';
import { Btn } from '../ui';
import { Input } from '../../ui/input';
import { Checkbox } from '../../ui/checkbox';
import { V3AlertDialog } from '../../ui/alert-dialog';
import { cn } from '../../../lib/cn';
import { libraryKeys } from './queries';
import type { SceneAlias, SceneCount } from './types';
import { useAdminMutation, useAdminQuery } from './useAdminQuery';

interface SceneVocabResponse {
  scenes: SceneCount[];
  aliases: SceneAlias[];
}

interface MergeResponse extends SceneVocabResponse {
  target: string;
  sources: string[];
  /** Fold keys the merge actually recorded — empty when the rule set already
   *  said everything this merge asked for, which is not the same as a stale
   *  listing and must not be reported as one. */
  recorded: string[];
  tracksChanged: number;
}

type Sort = 'tracks' | 'name';

// Below this a scene is a one-off worth looking at — the "3 tracks or fewer"
// tail is where the spelling variants live. Display only; nothing keys off it.
const TAIL_MAX = 3;

const NO_SCENES: SceneCount[] = [];
const NO_ALIASES: SceneAlias[] = [];

export default function SceneVocabSection() {
  const [open, setOpen] = useState(false);
  const [sort, setSort] = useState<Sort>('tracks');
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [target, setTarget] = useState('');
  const [confirming, setConfirming] = useState(false);

  const vocab = useAdminQuery<SceneVocabResponse>({
    key: libraryKeys.scenes(),
    path: '/library/scenes',
    enabled: open,
    toastOnError: true,
  });

  // Stable empty fallbacks: a fresh `[]` literal per render would change the
  // useMemo dependency every time, which is the whole point of memoising here.
  const scenes = vocab.data?.scenes ?? NO_SCENES;
  const aliases = vocab.data?.aliases ?? NO_ALIASES;
  const tail = scenes.filter(s => s.tracks <= TAIL_MAX).length;

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const rows = q ? scenes.filter(s => s.value.toLowerCase().includes(q)) : scenes.slice();
    // The server already sorts by count; only the A–Z view re-sorts, and it
    // uses localeCompare so accented tags file where a reader expects them.
    return sort === 'name' ? rows.sort((a, b) => a.value.localeCompare(b.value)) : rows;
  }, [scenes, filter, sort]);

  const pickedSet = new Set(picked);
  // The default survivor is the biggest of the ticked values — the spelling
  // most of the library already uses. Typing over it is the rename case.
  const suggested = picked.length
    ? [...picked].sort(
        (a, b) => (scenes.find(s => s.value === b)?.tracks ?? 0) - (scenes.find(s => s.value === a)?.tracks ?? 0),
      )[0]!
    : '';
  const to = target.trim() || suggested;
  // Verbatim, matching the server: "rock" ticked onto "Rock" is a real merge,
  // because the two are distinct stored rows and a walk re-reads whatever each
  // file says. A case-insensitive filter here disabled the button on exactly
  // the case-duplicate tail this section exists to clean up.
  const sources = picked.filter(v => v !== to);
  const affected = sources.reduce((n, v) => n + (scenes.find(s => s.value === v)?.tracks ?? 0), 0);

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
      setPicked([]);
      setTarget('');
      // The response carries the refreshed listing: after a merge every count
      // on screen is wrong, and merging is usually several in one sitting.
      qc.setQueryData(libraryKeys.scenes(), { scenes: data.scenes, aliases: data.aliases });
      // A merge rewrites the `genre` scalar on every affected row, so every
      // cached list OF TRACKS is now showing a retired spelling. `rows` is the
      // family they all sit under — the same reach a tag edit or a block
      // re-stamp uses, and the reason a non-Track list must never be filed
      // there. Skip it and Browse/Tracks keep the old value until remount.
      await Promise.all([
        qc.invalidateQueries({ queryKey: libraryKeys.rows }),
        // The genre pickers elsewhere (show editor, browse filter) read their
        // own endpoint and are now stale.
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
            </div>
          )}

          {aliases.length > 0 && (
            <div className="border-t border-dashed border-separator-strong pt-3">
              <span className="caption flex items-center gap-2">
                Folds applied on every scan
                <span className="mono-num">{aliases.length}</span>
              </span>
              {/* The left side is the fold KEY the controller matches against,
                  not any one spelling that was retired — several can share it,
                  and saying so is cheaper than showing a lower-cased tag that
                  matches nothing in the list above. */}
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
          `${sources.map(s => `“${s}”`).join(', ')} will be rewritten to “${to}” on ` +
          `${affected} track tag${affected === 1 ? '' : 's'}, and folded the same way on every ` +
          `future library scan. The old spellings are not recoverable.`
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
