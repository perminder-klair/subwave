# Unified tagging modal — design

**Date:** 2026-06-28
**Status:** Drafted, awaiting user review
**Area:** `web/` (admin library panel + new modal) and `controller/` (tagger CLI flags + `/dj/tag-library` body + `startTagger`)

## Problem

`/admin/library`'s `LibraryTaggingPanel` scatters tagging controls across the
surface, and the **Start tagging** button runs the *entire* pipeline with no way
to pick which phases run. Today's controls:

- **Start tagging** button (`onStart` → `POST /dj/tag-library`) — always a full
  forward run; no step selection.
- **Reconcile** button (`onReconcile`) — walk Navidrome + prune orphans
  (`--reconcile-only`), a separate primary button.
- **Maintenance & advanced** inline drawer (`maintOpen`) holding:
  - acoustic-analysis status + coverage minibar,
  - audio-fingerprint (sounds-like / CLAP): **Analyse new tracks**
    (`onAnalyzeAudio`) + **Enable/Disable** (`onToggleAudio`) + vocal-activity,
  - **Re-scan** maintenance passes — reseed / reEnrich / reAnalyze / upgrade
    (`onRescan`).

The operator has no control over *which* steps a run does — useful when, say,
re-tagging moods without re-paying the acoustic-analysis cost, or running a
reconcile-and-enrich without an LLM pass. The slow acoustic-analysis phase
(~1.1s/track; see the 2026-06-28 tagger benchmark) is forced on every run.

## Goals

- One **Start tagging…** button opens a single modal that is the home for every
  library/tagging control.
- A **Run** tab with checkboxes to select/deselect pipeline steps
  (default all on), so the operator runs exactly the phases they want —
  including reconcile-with-Navidrome as a selectable step.
- Fold the separate **Reconcile** button and the entire **Maintenance &
  advanced** drawer (acoustic/audio controls + re-scan passes) into the modal.
- No invalid step combinations possible.
- Coverage meters and live run-state stay visible in the panel (the modal is for
  *actions*, not status).

## Non-goals

- No change to the tagging algorithm, phase order, or pipeline behaviour beyond
  letting phases be skipped.
- No new dependencies; reuse the existing `Modal` primitive
  (`web/components/ui/modal.tsx`, already used by admin panels). Tabs are local
  state (a button row + conditional render) — there is no shared Tabs component
  and we won't add one.
- No persistence of the operator's last checkbox selection (defaults reset to
  all-on each open). YAGNI until asked.
- No change to embeddings, TTS, or playback paths.

## Current state — control inventory

| Control | Handler | Backend |
|---|---|---|
| Start tagging | `onStart` | `POST /dj/tag-library` `{limit,reseed,reEnrich,reAnalyze,upgrade}` |
| Reconcile | `onReconcile` | reconcile-only run (`--reconcile-only`) |
| Stop | `onStop` | `POST /dj/tag-library/stop` |
| Analyse new tracks | `onAnalyzeAudio` | `startAnalyzer({audio:true})` |
| Enable/Disable audio fp | `onToggleAudio` | settings toggle |
| Re-scan passes | `onRescan(opts)` | `POST /dj/tag-library` `{reseed,reEnrich,reAnalyze,upgrade}` |
| Limit / batch | `batch`/`setBatch` | `limit` on the tag run |

CLI flags that already exist in `music/tag-library.ts`: `--limit`, `--batch`,
`--skip-enrich`, `--skip-analyze`, `--no-propagate`, `--reconcile-only`,
`--re-enrich`, `--re-analyze`, `--reseed`, `--upgrade`.

Pipeline phases: `walk(reconcile) → enrich → embed → seed → propagate →
active-learn → analyze`. Hard dependencies: seed/propagate/active-learn require
embeddings; enrich and analyze are independent of tagging.

## Design

### The modal — `LibraryTaggingModal`

A new component opened by the panel's primary **Start tagging…** button. Three
tabs, one per intent. Built on `Modal` (`web/components/ui/modal.tsx`); the tab
strip is local component state (no shared Tabs primitive).

```
┌─ Tagging ───────────────────────────────────────────────┐
│  [ Run ]   [ Acoustic & audio ]   [ Re-scan ]           │
│─────────────────────────────────────────────────────────│
│ RUN  — process new / untagged tracks                    │
│   Steps to run:                                         │
│    ☑ Reconcile with Navidrome   sync list + prune gone  │
│    ☑ Enrich metadata            Last.fm tags + lyrics   │
│    ☑ Tag moods (LLM)            embed → seed → spread   │
│    ☑ Analyze acoustics          bpm / key  (engine: on) │
│   Advanced:  Limit [ 100 ▾ ]  (100 / 500 / all)         │
│                                    [ Cancel ] [ Start ] │
└─────────────────────────────────────────────────────────┘
```

**Run tab** — four step checkboxes (default all on) + the Limit/batch selector
(the existing `batch` "advanced" control). `Start` is disabled when no step is
checked. A step whose backend is unavailable (e.g. *Analyze* when no analysis
engine is running) renders disabled + greyed with the existing "engine off"
hint and the how-to link.

**Acoustic & audio tab** — the moved controls: **Analyse new tracks**
(`onAnalyzeAudio`), **Enable/Disable** audio fingerprint (`onToggleAudio`), the
vocal-activity toggle, and the engine-status hints/warnings ("engine off",
"missing CLAP", "build WITH_DEMUCS=1"). These are the contextual warnings that
belong next to the controls.

**Re-scan tab** — the four maintenance passes (reseed / reEnrich / reAnalyze /
upgrade) + **Run re-scan**, preserving the re-embed confirm dialog
(`V3AlertDialog`) before a `reseed`.

### What stays in the panel

- Coverage hero (mood/energy %), and the **acoustic** + **audio** coverage
  minibars (status only — the *controls* move, the *meters* stay).
- Live run progress (phase, %, dual-LLM legs, per-phase hint).
- "Last run" phase breakdown (idle).
- **Stop** button (during a run) and **View log**.
- The "Maintenance & advanced" disclosure button is removed; its drawer content
  now lives in the modal.

### Step → flag mapping (Run tab)

The Run tab sends `{reconcile, enrich, tagMoods, analyze}` (+ `limit`) to
`POST /dj/tag-library`. `broadcast/tagger.ts:startTagger` translates:

| Selection | Resulting CLI |
|---|---|
| all four on | full run **+ prune** |
| `enrich` off | `--skip-enrich` |
| `analyze` off | `--skip-analyze` |
| `tagMoods` off | `--skip-tag` *(new)* — skip embed + seed + propagate + active-learn |
| `reconcile` off | `--no-prune` *(new)* — walk but don't drop orphaned rows |
| only `reconcile` on | client routes to `POST /library/reconcile` (`--reconcile-only`) |
| nothing on | (Start disabled) |

Folding embed/seed/propagate/active-learn into the single **Tag moods** toggle
means every checkbox state maps to a valid run — no dependency conflicts to
police in the UI.

### Backend changes

1. **`music/tag-library.ts`**
   - Add `--skip-tag` flag (`skipTag`): when set, skip Phase 1 embed, Phase 2
     seed, Phase 3 propagate, Phase 4 active-learn. Phase 0 enrich and Phase 5
     analyze still run per their own flags. (Walk always runs.)
   - Add `--no-prune` flag: a normal run **already** prunes orphans after the
     Phase A walk, so reconcile-deselected suppresses that prune (the walk still
     runs — it's how untagged tracks are discovered). The existing empty-walk
     guard is retained.
   - `--reconcile-only` is unchanged (it already walks + prunes + exits).

2. **`routes/jingles.ts` `POST /dj/tag-library`**
   - Accept new optional body fields: `reconcile`, `enrich`, `tagMoods`,
     `analyze` (all booleans). When absent, behaviour is unchanged (full run) so
     existing callers/back-compat hold.
   - If only `reconcile` is true (and tagMoods/enrich/analyze all false), route
     to the reconcile-only start path (existing `startReconcile` / mode
     `'reconcile'`).

3. **`broadcast/tagger.ts` `startTagger`**
   - Extend opts with `{reconcile?, enrich?, tagMoods?, analyze?}` and build the
     argv: `--skip-enrich` when `enrich===false`, `--skip-analyze` when
     `analyze===false`, `--skip-tag` when `tagMoods===false`, `--no-prune` when
     `reconcile===false`. Only an explicit `false` skips; `undefined` leaves the
     phase on, so omitting the fields preserves the legacy full run. Existing
     re-* flags untouched.
   - `mode` stays `'tag'` for any run that includes tagging/enrich/analyze;
     reconcile-only keeps `'reconcile'`; the audio-fingerprint pass keeps
     `'analyze'`.

### Frontend changes

- **New:** `web/components/admin/LibraryTaggingModal.tsx` — the tabbed modal,
  receiving the existing handler props (`onStart` becomes "run with these
  steps", `onReconcile`, `onAnalyzeAudio`, `onToggleAudio`, `onRescan`) plus
  step/limit state. Keep it focused: one component, tabs are local state.
- **`LibraryTaggingPanel.tsx`** — replace the Start/Reconcile buttons with a
  single **Start tagging…** that opens the modal; delete the `maintOpen` drawer
  and the standalone Reconcile button; keep coverage bars, progress, breakdown,
  Stop, View-log. The `passes`/re-scan state moves into the modal.
- **`onStart`** signature grows to carry `{reconcile, enrich, tagMoods, analyze,
  limit}` from the Run tab (the parent page wires it to the request body).

## Edge cases

- **No step selected** → Start disabled (can't fire an empty run).
- **Analyze with no engine** → checkbox disabled + greyed, hint shown; never
  silently no-ops a checked box.
- **Tag moods off, enrich on** → walk + enrich only (pre-fetch Last.fm/lyrics
  without an LLM pass); valid, maps to `--skip-tag --skip-analyze`.
- **Empty Navidrome response during a prune run** → existing guard skips the
  prune (never wipes the DB).
- **Back-compat:** an old client that POSTs without the new step fields still
  gets a full run (defaults all-on).

## Testing

- `npm run lint` (eslint + `tsc --noEmit`) clean in `controller/` and `web/`
  (the merge gate).
- Manual: each tab's action fires the right run; reconcile-only still works;
  skip-combinations produce the expected `[tag] phase breakdown` (e.g. a
  `--skip-analyze` run shows no `analyze` lap); Start disabled with no steps.
- `--skip-tag` / `--prune` exercised via a small `--limit` run against the dev
  stack.

## Open questions

- None blocking. (Persistence of last selection and a "save as default" are
  deferred per Non-goals.)
