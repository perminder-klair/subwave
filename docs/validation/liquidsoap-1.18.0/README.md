# Liquidsoap v1.18.0 validation results

The published AMD64 broadcast, lean AIO, and heavy AIO images contain the
expected Liquidsoap backport. Their scoped runtime smoke checks passed.
The endurance comparison is inconclusive: the final run stopped at the
operator's request after 3h49m and 1,712 observed track starts per side.

This report records the October 6 and 7, 2026 follow-up to
[#1806](https://github.com/perminder-klair/subwave/issues/1806).
The backport shipped through
[#1764](https://github.com/perminder-klair/subwave/pull/1764) in v1.18.0.
The [release image publishing run](https://github.com/perminder-klair/subwave/actions/runs/37381325507)
completed broadcast builds on AMD64 and ARM64, and lean, heavy, and CUDA AIO
builds on AMD64. Successful builds alone do not establish runtime behavior.

## Published executable identity

The final AMD64 broadcast, lean AIO, and heavy AIO filesystems contain matching
`/usr/bin/liquidsoap` executables and source records:

| Record | Value |
| --- | --- |
| Liquidsoap source | `d2bf3eb209391815e8d6a84b6cbf7ad4168d703d`, version 2.4.5 |
| Upstream patch | `de68528a87d0cd2137b6dd53abf0110d21974ad3`, upstream #5257 |
| Executable SHA-256 | `c082fee0936ee2e0944932a0273791bcb08c5740f658447685519e106a2ba320` |

The published CUDA AMD64 executable-copy and source-record layers match those
records too. That inspection did not reconstruct the complete CUDA filesystem
or run the image on an NVIDIA host. The published ARM64 executable was not
independently inspected during this follow-up.

[results.json](results.json) records the immutable image identities, published
digests, inspection scope, and source records. `liquidsoap --version` still
reports 2.4.5, so the version string alone cannot identify the patch.

## Runtime smoke results

| Image | Result | Observed track starts | Coverage |
| --- | --- | ---: | --- |
| Published broadcast | Passed | 22 | Music progress, both voice channels, manual jingle, four decoded codecs |
| Unfixed control | Passed | 22 | Same broadcast smoke checks |
| Published lean AIO | Passed | 3 | Startup, HTTP routes, authentication, settings, music progress, health, four decoded codecs |
| Published heavy AIO | Passed | 3 | Same AIO smoke checks |

All four smoke runs decoded non-silent MP3, Opus, AAC, and FLAC audio.
The AIO runs fetched the player, admin page, state, now-playing metadata, and
tune-in file over HTTP. They verified that unauthenticated settings access
returned 401, then saved and read back an authenticated settings change.
Both AIO containers were healthy, with zero container restarts.

The disposable AIO fixture served two generated 60-second WAV tracks over a
local Subsonic HTTP endpoint. A wrapper started that fixture, then executed the
published supervisor. The controller owned the playlist through its usual
library flow. These checks did not exercise a real library, browser JavaScript
interaction, heavy model inference, or CUDA execution.

## Shortened endurance comparison

Both sides started at 08:46:08 UTC on October 7 and stopped at approximately
12:35:01 UTC. Each observed 1,712 track starts, with zero container restarts
before the requested stop. Both containers were healthy immediately before
stopping and were subsequently removed.

The retained logs contain no steady-state clock warnings. Each side had one
cold-start catch-up warning within the runner's 30-second startup allowance.
Stopping the service interrupted final log collection, so the retained logs
do not establish a clean final partial minute.

The runner records SIGTERM interruption as `failed`. The result records
preserve that status and label the run as stopped early, rather than changing
the result to a pass. The final four-codec checks at the soak deadline were
not reached. The separate short smoke results above remain valid.

The issue required at least 24 uninterrupted hours and 12,240 observed
transitions. The planned run was 30 hours to allow enough transitions at this
fixture's cadence. The shortened run satisfies neither requirement and cannot
establish long-uptime stability or a performance improvement.

## Test conditions and measurement limits

Tests ran on a shared AMD64 workstation with eight logical CPUs and about
12 GiB RAM. The final pair used the same baked release radio script, generated
12-second tones, four-second crossfades, and codec configuration.
Each container had two CPUs, a 512 MiB memory limit, swap disabled, and a
256 MiB memory reservation. No other qualification probes overlapped this pair.

The unfixed control replaced the release executable with stock upstream 2.4.5
and regenerated its standard-library cache. Its FDK-AAC binding reports 0.3.4,
while the patched build reports 0.3.3. The comparison therefore does not isolate
the patch from every toolchain difference.

Unchanged per-minute Docker samples are in
[fixed-soak-stats.jsonl](fixed-soak-stats.jsonl) and
[stock-soak-stats.jsonl](stock-soak-stats.jsonl). Each file contains 229 samples,
including startup. Excluding startup, the first and latest 30-sample mean CPU
usage was 12.46% and 11.95% for fixed, and 12.36% and 14.48% for stock.
These are observations from one shortened comparison, not a measured speedup
or proof of the original failure's cause. Docker CPU percentages are relative
to one logical CPU. Marker age measures metadata freshness, not accumulated
listener playback delay.

An earlier pair failed after about 5h44m and 2,573 track starts per side.
Both sides logged clock warnings within one second during shared-host memory
pressure while AIO probes overlapped. That overlap prevents attributing the
failure to the patch. Its failed statuses are included in `results.json` and
its duration and transitions are not combined with the final pair.

Earlier fixture attempts also failed because the release did not expose the
selected settings key, or because the controller overwrote a manually seeded
playlist. The final fixture corrected those probe assumptions. A lean AIO
attempt still failed during the shared-host pressure event before its later
successful retry. The raw failed artifacts remain on the test workstation.

The first broadcast smoke attempt also failed during severe host pressure,
before its functional checks completed. Its Docker cleanup timed out, and its
disposable container was subsequently removed manually. The later passed
broadcast smoke used a fresh container.

## Outstanding validation

The early stop leaves these checks unverified:

- At least 24 uninterrupted hours and 12,240 observed transitions, with
  a worsening unfixed control. A clean control requires an inconclusive result
  and a longer run.
- Complete CUDA filesystem inspection and runtime checks on an NVIDIA host.
- Production image digest and patch identity, followed by CPU, memory, audio,
  metadata, and stream-delay observations beyond the original roughly nine-day
  failure onset. Uptime and restarts must accompany those observations.

No production deployment occurred during this validation. Issue #1806 was
closed by the operator before the early-stop request. That closure does not
turn the incomplete checks into passing results.

This directory contains outcome records and the final pair's raw CPU/memory
samples. Full logs, generated audio, fixture scripts, and earlier failed
artifacts remain on the test workstation. `results.json` records script hashes
and the test and image source revisions. The runner's elapsed field in the AIO
status is its last periodic sample; use start and finish timestamps for total
duration.
