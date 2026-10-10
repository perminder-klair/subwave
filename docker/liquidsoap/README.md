# Liquidsoap 2.4.5 with upstream #5257

Long-running stations can spend an increasing share of CPU walking unifier
reference chains. Restarting clears the chains but does not fix their growth.
Both broadcast and AIO images rebuild 2.4.5 with the path-compression change
from [savonet/liquidsoap#5257](https://github.com/savonet/liquidsoap/pull/5257).
The station script and its standard library stay on 2.4.5.

## Pinned inputs

- Liquidsoap source: `d2bf3eb209391815e8d6a84b6cbf7ad4168d703d` (`v2.4.5`).
- Vendored, unmodified patch: upstream commit
  `de68528a87d0cd2137b6dd53abf0110d21974ad3`.
- Upstream Debian trixie / OCaml 4.14.2 builder and 2.4.5 runtime: multi-platform
  manifest digests in both Dockerfiles. No rolling tags or `opam update`.
- FFmpeg bindings: `49c9545a964ea32429569e0803f7f2a0cc8e19db` (`v1.3.1`),
  matching the upstream 2.4.5 release build. Other binding sources and compiler
  packages come from the pinned builder. This is a source rebuild, not a
  byte-for-byte recreation of the upstream release toolchain.

The builder's FDK-AAC binding reports 0.3.3, whereas the published 2.4.5 binary
reports 0.3.4. The native FDK library is retained from the runtime image; AAC
encoding is exercised by the smoke test. All configured runtime paths and
supported input/output features match the published image. Review these build
records when replacing either pinned image, rather than assuming a compiler
image's dependencies match a release just because both say OCaml 4.14.2.

The build fails if the patch does not apply or its resulting source hash
changes. It compiles the actual unifier module into a regression executable:
stock 2.4.5 must fail, and the patched module must compress a million-link chain
and preserve shared reads/writes and self-unification. No timing threshold is
used. Only the rebuilt executable and build records enter the runtime image;
the compiler stays in the build stage. The stock stdlib cache is regenerated.

`liquidsoap --version` still reports 2.4.5. To distinguish the patched build,
inspect `/usr/share/doc/liquidsoap-subwave/source.txt`; the same directory records
`--build-config`, installed compiler packages and binding source revisions.

Keep the `liquidsoap-build` and `liquidsoap-patched` stages identical in both
Dockerfiles. The AIO heavy/CUDA variants inherit the same patched stage.
Remove this backport once a tested stable upstream release includes #5257.

## Validation

The [v1.18.0 validation report](../../docs/validation/liquidsoap-1.18.0/README.md)
records published-image identity checks, broadcast and AIO smoke results, and
the shortened endurance comparison. It also lists the checks still unverified.

From the repository root:

```sh
docker build -f docker/Dockerfile.broadcast -t subwave-test/broadcast:unifier .
docker build -f docker/Dockerfile.aio --target liquidsoap-patched \
  -t subwave-test/aio-liquidsoap:unifier .
python3 scripts/liquidsoap-image-smoke.py subwave-test/broadcast:unifier
python3 scripts/liquidsoap-image-smoke.test.py -v
```

The smoke test uses a unique container, an ephemeral loopback port, disposable
state and generated tones. It runs the baked `radio.liq`, checks repeated track
changes, both voice channels and a manual jingle, then decodes non-silent MP3,
Opus, AAC and FLAC captures. It retains logs and per-minute Docker CPU/memory
samples and removes its container on exit, including SIGTERM. Containers default
to 2 CPUs, 512 MiB, 128 processes and bounded Docker logs; `--cpus` and `--memory`
can override those resource limits. It needs Docker, Python 3 and ffmpeg.
It does not start a controller or connect to a music library.

Music gets a 30-second startup allowance. Thereafter the generated tracks must
produce at least three new starts in every 60-second interval, and the latest
`now-playing.json` timestamp must remain at most 30 seconds old. Re-reading an
unchanged marker never refreshes it. Future/backwards timestamps and markers
for anything other than the generated music are rejected. Missing/partially
written files may recover only while the last valid timestamp remains fresh.
Healthy emergency audio cannot satisfy these music-progress checks. The
deterministic CLI tests include the old false-pass case, normal progress and
delayed startup, without needing Docker or sleeping in real time.

The AIO target above validates its patched Liquidsoap stage, not the complete
AIO application. Full AIO builds remain part of release validation.

Before production rollout, run a 24–48-hour soak with frequent transitions:

```sh
python3 scripts/liquidsoap-image-smoke.py subwave-test/broadcast:unifier \
  --seconds 86400 --evidence-dir /real-disk/new-soak-directory \
  --test-source-sha "$(git rev-parse HEAD)" --image-source-sha BUILD_COMMIT
```

Use a durable supervisor such as a dedicated systemd service for a day-long
run, with stdout/stderr redirected to a persistent log. Do not hold a shared
build/test resource lock for the duration. Give that service a stop timeout and
an independent cleanup action for the unique container name in `status.json`,
so forced termination also removes only its disposable container.

`--evidence-dir` must be new or empty. `status.json` is atomically updated with
the immutable image ID, supplied image/test commit SHAs, runner SHA-256, UTC
start/deadline, resource limits, progress heartbeat, final result and cleanup
status. `stats.jsonl` retains per-minute CPU/memory samples plus track counts
and marker age; `intervals.jsonl` records successful music-progress intervals.
Both Docker and Liquidsoap's file diagnostics are retained and checked during
the run, so a warning cannot disappear unnoticed when Docker logs rotate.
Timestamped clock catch-up warnings inside the same 30-second startup allowance
are retained in `status.json` as `startup_latency_warnings`. Any later warning,
or one whose timestamp cannot be parsed, fails the run. The container uses UTC
for these comparisons. This allows the observed stock and patched cold-boot
catch-up without excusing latency during steady operation.

Review the retained CPU samples for growth and both logs for latency warnings.
Passing the short smoke test or structural regression does not establish
long-uptime production behaviour. Deploy the tested broadcast image during a
quiet period, retain the previous image for rollback and monitor CPU over the
following weeks. Rebuilding/restarting an unpatched 2.4.5 image is insufficient.
