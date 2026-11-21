# Shared Beat This inference for regular grids

Upstream [#2244](https://github.com/perminder-klair/subwave/pull/2244) can
improve regular-stem grids before the larger Sub/Beats feature lands. This
contribution keeps its opt-in behavior while separating reusable inference from
worker policy, fixing tail inference after a Librosa tempo error, and preserving
the evidence needed to understand a cached grid.

## Scope and compatibility

The shared module retains the existing `small0` numerical pipeline. The worker
owns its flag, fallback and independent idle lifetime. The learned beats and
bars remain paired; BPM/key remain Librosa's. Timing support from local intervals
and Librosa is diagnostic, never a qualification veto. It cannot certify bar
phase. Invalid timestamp shapes are errors; empty/musically uncertain grids do
not become new qualification rules.

Optional provenance follows head/tail arrays through flat and facet protocols,
local and sidecar clients, the library scan and SQLite. It records the actual
ONNX hash, preprocessing version, decoded absolute window, local evidence and,
when available, the staged encoded source hash/size/completeness. Refresh/reset
paths replace or clear that metadata with their grids; an unmeasured tail keeps
its original evidence. Older rows remain unknown, and no analysis version bump
or automatic library backfill is introduced. The generated web schema changes
only because schemas are mirrored by repository policy.

This is a foundation for Sub/Beats, not full Sub/Beats preparation. Reuse still
requires matching current source/model/preprocessing and sufficient coverage.
The later full-recording adapter must retain its independent onset, energy,
passage and phase checks, and compatibility with existing prepared stems.

## Numerical and worker verification

[Machine-readable results](2026-11-13-beat-this-shared-grid.json) contain only
case labels, durations and counts; no source paths, audio, weights or station
state are included.

- Seven complete recordings, totaling 1,755.68 s, plus 12/20/40 s excerpts:
  all 3,892 beat and 1,014 downbeat timestamps match the saved PR #2244 ONNX
  results exactly across 10 cases. Those reference results had already been
  compared with the current PyTorch pipeline; this is an extraction regression
  check, not a fresh accuracy benchmark against human labels.
- Real flat/facet requests for the same complete recording produce identical
  head/tail arrays and provenance, including one source fingerprint shared by
  both windows. The candidate worker is imported from its explicit path so the
  sibling Sub/Beats checkout cannot supply a different worker.
- All 17 downbeat tests pass in the existing heavy analyzer runtime, including
  the synthetic music test using the real pinned model. Regressions cover a
  Librosa exception, disagreement/absent comparison evidence, corrupt output,
  source completeness and fingerprinting before owned-file cleanup.
- Flag-off characterization matches all 11 stored fixtures, and facet answers
  match the flat response for those fixtures. Snapshots were not updated.
- Six TypeScript tests cover wire mappings, flat/facet SQLite round trips and
  reopen, nullable-column upgrade without moving `user_version`, malformed or
  future metadata, stale-label replacement, reset/replaced-audio clearing, and atomic grid/provenance
  adoption when Navidrome rotates IDs.

Runtime: immutable existing analyzer image
`6417ddae7c08dbce16ce2f55f84f9d200245d14733cc778dd18715dff38df709`,
Python 3.11, NumPy 2.4.6, Librosa 0.11.0 and onnxruntime 1.27.0; CPU-only,
two CPUs/two inference threads, 3 GiB limit, network disabled, read-only audio
and code mounts, temporary state. No live station operations were performed.

New images, ARM/CUDA execution and the full Sub/Beats preparation/cache lifecycle
are outside this contribution's validation. The earlier memory/speed assessment
remains an inference comparison, not a measured end-to-end scan improvement.

## Controller regression run

The full serial controller suite ran all 551 files / 6,316 tests. It reported
6,314 passes and two failures, both schema-drift assertions identifying the new
column as unclassified for ID adoption. The fix places head provenance in the
existing atomic analysis group. After that fix, all 98 ID-related tests, all 8
explicit-storage tests, and all 6 provenance tests pass, including the two
originally failing assertions. The full suite was not repeated after that
focused correction; no other failures were reported in the broad run.

The complete web suite also passes: 633 tests across 98 files. The only web
source change is the generated schema mirror.

Final `npm run lint` passes in both controller and web, including their TypeScript
checks. Controller ESLint reports the existing warning backlog with zero errors;
web lint is clean. `npm test -- analyzer-python` passes after the final changes.
The schema mirror was generated with `npm run gen:schemas`; `git diff --check`
passes.
