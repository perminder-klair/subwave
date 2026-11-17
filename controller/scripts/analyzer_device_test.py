#!/usr/bin/env python3
# Unit test for the analyzer's device choice, resolve_device() in
# analyze_worker (#2280). Pure stdlib: a fake `torch` module stands in for the
# real one, so it runs anywhere, with or without a GPU.
# Run: `python3 scripts/analyzer_device_test.py` (exit 0 = pass).
#
# What this pins down:
#   - a card torch can see but has no kernels for (a Pascal GTX 1060 under the
#     cu128 build) falls back to cpu, under `auto` AND an explicit `cuda`,
#     because `is_available()` alone said yes and every CLAP/Demucs call then
#     failed one track at a time;
#   - the warning names the card, its sm_XY, the wheel's arch list, the image
#     tag for that card, and that Demucs on cpu is slow;
#   - a working card still gets cuda, `cpu` never touches the card, and the
#     no-GPU fallback is unchanged;
#   - only a missing kernel image is final. Any other failure (out of memory,
#     a CUDA init error) retests at a later job's start, backing off, and a
#     pass moves the worker to cuda with no restart; the warning's advice fits
#     the cause (no driver advice for out of memory);
#   - a failed self-test drops its tensor and empties torch's cache.

import gc
import io
import json
import os
import sys
import types
import weakref

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import analyze_worker as aw  # noqa: E402

failures = 0

CU128_ARCHES = ["sm_75", "sm_80", "sm_86", "sm_90", "sm_100", "sm_120"]
CU124_ARCHES = ["sm_50", "sm_60", "sm_70", "sm_75", "sm_80", "sm_86", "sm_90"]
NO_KERNEL = "CUDA error: no kernel image is available for execution on the device"


def test(name, fn):
    global failures
    try:
        fn()
        print(f"  ✓ {name}")
    except Exception as err:  # noqa: BLE001 — a failed assert is a reported case
        failures += 1
        print(f"  ✗ {name}\n      {err}")


def fake_torch(
    available=True,
    name="NVIDIA GeForce GTX 1060 6GB",
    capability=(6, 1),
    arch_list=CU128_ARCHES,
    kernel_error=None,
    capability_raises=False,
    errors=None,
):
    """A `torch` module shaped like the real one as far as resolve_device()
    goes. `kernel_error` set = the card is visible but every kernel fails,
    which is exactly what a wheel without the card's arch does. `errors`, a
    list, scripts one self-test after another instead (None = that one
    passes; past the end the card works). `calls` counts how often the
    self-test touched the card, `empty_cache` how often the cache was freed,
    and `tensors` holds weak references to every tensor made."""
    calls = {"kernel": 0, "empty_cache": 0}
    tensors = []

    class Tensor:
        def __init__(self, n):
            self.n, self.v = n, 1.0
            tensors.append(weakref.ref(self))

        def mul_(self, k):
            i = calls["kernel"]
            calls["kernel"] += 1
            err = kernel_error
            if errors is not None:
                err = errors[i] if i < len(errors) else None
            if err:
                raise RuntimeError(err)
            self.v *= k
            return self

        def sum(self):
            return types.SimpleNamespace(item=lambda: self.v * self.n)

    def ones(n, device=None):
        assert device == "cuda", f"self-test must run on the card, got {device}"
        return Tensor(n)

    def get_device_capability(_i=0):
        if capability_raises:
            raise RuntimeError("driver gone")
        return capability

    cuda = types.SimpleNamespace(
        is_available=lambda: available,
        get_device_name=lambda _i=0: name,
        get_device_capability=get_device_capability,
        get_arch_list=lambda: list(arch_list),
        synchronize=lambda: None,
        empty_cache=lambda: calls.__setitem__("empty_cache", calls["empty_cache"] + 1),
    )
    mod = types.ModuleType("torch")
    mod.cuda = cuda
    mod.ones = ones
    mod.tensors = tensors
    return mod, calls


def reset_device_state():
    aw._DEVICE = None
    aw._cuda_retest_at = None
    aw._cuda_retest_gap = aw.CUDA_RETEST_MIN_S


def resolve(env, torch_mod):
    """Run resolve_device() fresh with ANALYZE_DEVICE=env and `torch_mod` as
    torch. Returns (device, log lines)."""
    lines = []
    saved = (sys.modules.get("torch"), aw.log, os.environ.get("ANALYZE_DEVICE"))
    try:
        sys.modules["torch"] = torch_mod
        aw.log = lambda m: lines.append(m)
        reset_device_state()
        if env is None:
            os.environ.pop("ANALYZE_DEVICE", None)
        else:
            os.environ["ANALYZE_DEVICE"] = env
        return aw.resolve_device(), lines
    finally:
        torch_prev, log_prev, env_prev = saved
        if torch_prev is None:
            sys.modules.pop("torch", None)
        else:
            sys.modules["torch"] = torch_prev
        aw.log = log_prev
        reset_device_state()
        if env_prev is None:
            os.environ.pop("ANALYZE_DEVICE", None)
        else:
            os.environ["ANALYZE_DEVICE"] = env_prev


def main():
    print("analysis device choice (analyze_worker.resolve_device):")

    # ── The #2280 report: a visible card the wheel has no kernels for ─────────
    def pascal_auto():
        torch, calls = fake_torch(kernel_error=NO_KERNEL)
        device, lines = resolve(None, torch)
        assert device == "cpu", f"expected cpu, got {device}"
        assert calls["kernel"] == 1, "the self-test should have run one op"
        warn = next((l for l in lines if "self-test failed" in l), None)
        assert warn, f"no fallback warning in {lines}"
        for needle in ("GTX 1060", "sm_61", "sm_75", "sm_120", ":pascal", "ANALYZER_CUDA_TAG=pascal", "no kernel image", "Demucs on cpu is slow"):
            assert needle in warn, f"warning lacks {needle!r}: {warn}"
        assert lines[-1] == "analysis device: cpu", lines

    test("auto on a Pascal card under cu128 falls back to cpu, naming the :pascal tag", pascal_auto)

    def pascal_explicit():
        torch, _ = fake_torch(kernel_error=NO_KERNEL)
        device, lines = resolve("cuda", torch)
        assert device == "cpu", f"expected cpu, got {device}"
        assert any("self-test failed" in l for l in lines), lines

    test("an explicit ANALYZE_DEVICE=cuda falls back the same way", pascal_explicit)

    def cached():
        torch, calls = fake_torch(kernel_error=NO_KERNEL)
        sys.modules["torch"] = torch
        saved_log = aw.log
        try:
            aw.log = lambda _m: None
            aw._DEVICE = None
            os.environ.pop("ANALYZE_DEVICE", None)
            assert aw.resolve_device() == "cpu"
            assert aw.resolve_device() == "cpu"
            assert calls["kernel"] == 1, f"self-test ran {calls['kernel']} times"
        finally:
            aw.log = saved_log
            aw._DEVICE = None
            sys.modules.pop("torch", None)

    test("the self-test runs once per worker, not per call", cached)

    # ── The paths that must not change ──────────────────────────────────────
    def working_card():
        torch, calls = fake_torch(name="NVIDIA GeForce RTX 3060", capability=(8, 6))
        device, lines = resolve(None, torch)
        assert device == "cuda", f"expected cuda, got {device}"
        assert calls["kernel"] == 1
        assert lines == ["analysis device: cuda (NVIDIA GeForce RTX 3060)"], lines

    test("a card the wheel covers still gets cuda", working_card)

    def pascal_on_cu124():
        torch, _ = fake_torch(arch_list=CU124_ARCHES)
        device, _ = resolve(None, torch)
        assert device == "cuda", f"expected cuda, got {device}"

    test("the same Pascal card under the cu124 build gets cuda", pascal_on_cu124)

    def cpu_never_probes():
        torch, calls = fake_torch(kernel_error=NO_KERNEL)
        device, lines = resolve("cpu", torch)
        assert device == "cpu"
        assert calls["kernel"] == 0, "ANALYZE_DEVICE=cpu must not touch the card"
        assert lines == ["analysis device: cpu"], lines

    test("ANALYZE_DEVICE=cpu never touches the card", cpu_never_probes)

    def no_gpu():
        torch, calls = fake_torch(available=False)
        device, lines = resolve("cuda", torch)
        assert device == "cpu"
        assert calls["kernel"] == 0
        assert any("torch sees no CUDA device" in l for l in lines), lines
        assert not any("self-test" in l for l in lines), lines
        device, lines = resolve(None, torch)
        assert device == "cpu" and lines == ["analysis device: cpu"], lines

    test("no visible GPU keeps its old fallback and wording", no_gpu)

    # ── The warning's advice ────────────────────────────────────────────────
    def covered_but_broken():
        torch, _ = fake_torch(name="NVIDIA GeForce RTX 3060", capability=(8, 6), kernel_error="CUDA driver version is insufficient")
        device, lines = resolve(None, torch)
        assert device == "cpu"
        warn = next(l for l in lines if "self-test failed" in l)
        assert "driver" in warn and ":ampere" not in warn, warn

    test("a covered card that still fails points at the driver, not a tag", covered_but_broken)

    def probes_guarded():
        torch, _ = fake_torch(kernel_error=NO_KERNEL, capability_raises=True)
        device, lines = resolve(None, torch)
        assert device == "cpu"
        assert any("sm_unknown" in l for l in lines), lines

    test("a failing capability probe cannot turn the fallback into a crash", probes_guarded)

    def arch_helpers():
        assert aw.cuda_arch_tag((6, 1)) == "pascal"
        assert aw.cuda_arch_tag((5, 2)) == "maxwell"
        assert aw.cuda_arch_tag((7, 0)) == "volta"
        assert aw.cuda_arch_tag((7, 5)) == "turing"
        assert aw.cuda_arch_tag((8, 6)) == "ampere"
        assert aw.cuda_arch_tag((8, 9)) == "ada"
        assert aw.cuda_arch_tag((9, 0)) == "hopper"
        assert aw.cuda_arch_tag((12, 0)) == "blackwell"
        assert aw.cuda_arch_tag((3, 7)) is None
        assert not aw.cuda_arch_covered((6, 1), CU128_ARCHES)
        assert aw.cuda_arch_covered((6, 1), CU124_ARCHES), "sm_60 SASS runs on sm_61"
        assert not aw.cuda_arch_covered((6, 0), ["sm_61"]), "sm_61 SASS does not run on sm_60"
        assert aw.cuda_arch_covered((8, 9), ["compute_80"]), "PTX JITs forward"
        assert aw.cuda_arch_covered((12, 0), CU128_ARCHES)
        assert aw.cuda_arch_covered((9, 0), ["sm_90a"])

    test("arch tag and coverage helpers", arch_helpers)

    # ── A failure that can clear: retest at a later job, never mid-job ──────
    test("out of memory falls back, retests at a later job and moves to cuda", oom_recovers)
    test("a failure that persists retests on a doubling gap, capped", retest_backoff)
    test("no kernel image is final: tested once per process, never again", no_kernel_final)
    test("the move to cuda resets the armed idle window to cuda's", idle_window_moves)
    test("every model-capable request runs the retest first, under the lock", loop_retests)

    # ── What a failed self-test leaves on the card ─────────────────────────
    test("a failed self-test drops its tensor and empties the cache", self_test_releases)
    test("torch's message classifies the failure before the arch list does", message_decides_kind)

    print("PASS" if failures == 0 else f"FAIL ({failures})")
    sys.exit(1 if failures else 0)


OOM = "CUDA out of memory. Tried to allocate 2.00 MiB (GPU 0; 5.93 GiB total capacity)"
INIT = "CUDA error: initialization error"


class Rig:
    """Drives resolve_device() and the per-job retest with a fake torch and a
    fake clock, as the worker's request loop would."""

    def __init__(self, torch_mod):
        self.torch = torch_mod
        self.lines = []
        self.now = [1000.0]

    def __enter__(self):
        self.saved = (sys.modules.get("torch"), aw.log, aw.time, os.environ.get("ANALYZE_DEVICE"),
                      aw._embedder, aw._vocal_detector, aw._idle_thread_started,
                      aw._idle_window_s, aw._IDLE_UNLOAD_ENV)
        sys.modules["torch"] = self.torch
        aw.log = self.lines.append
        aw.time = types.SimpleNamespace(time=lambda: self.now[0], sleep=lambda _s: None)
        os.environ.pop("ANALYZE_DEVICE", None)
        aw._IDLE_UNLOAD_ENV = ""
        reset_device_state()
        return self

    def __exit__(self, *_exc):
        (torch_prev, aw.log, aw.time, env_prev, aw._embedder, aw._vocal_detector,
         aw._idle_thread_started, aw._idle_window_s, aw._IDLE_UNLOAD_ENV) = self.saved
        if torch_prev is None:
            sys.modules.pop("torch", None)
        else:
            sys.modules["torch"] = torch_prev
        if env_prev is not None:
            os.environ["ANALYZE_DEVICE"] = env_prev
        reset_device_state()

    def job_at(self, t):
        """A request starting at t seconds after boot: the retest hook, then the
        device the job's models would use."""
        self.now[0] = 1000.0 + t
        aw.retest_cuda_at_job_start()
        return aw.resolve_device()


def oom_recovers():
    torch, calls = fake_torch(name="NVIDIA GeForce RTX 3060", capability=(8, 6), errors=[OOM])
    with Rig(torch) as rig:
        assert aw.resolve_device() == "cpu"
        warn = next(l for l in rig.lines if "self-test failed" in l)
        assert "out of memory" in warn and "RuntimeError" in warn, warn
        assert "driver" not in warn, f"no driver advice for out of memory: {warn}"
        assert "testing the card again in 300s" in warn, warn
        aw._embedder = object()  # CLAP loaded on cpu for this job
        assert rig.job_at(10) == "cpu" and calls["kernel"] == 1, "not due yet: no retest"
        assert aw._embedder is not None, "a job before the retest keeps its cpu models"
        assert rig.job_at(300) == "cuda", "the retest passed, so this job runs on cuda"
        assert calls["kernel"] == 2
        assert aw._embedder is None, "cpu models are released so they reload onto the card"
        assert any("passed on retest" in l for l in rig.lines), rig.lines
        assert rig.job_at(10_000) == "cuda" and calls["kernel"] == 2, "cuda is final once reached"


def retest_backoff():
    torch, calls = fake_torch(name="NVIDIA GeForce RTX 3060", capability=(8, 6), kernel_error=INIT)
    with Rig(torch) as rig:
        assert aw.resolve_device() == "cpu"
        tested_at = []
        for t in range(0, 4 * 3600 + 1, 60):
            before = calls["kernel"]
            assert rig.job_at(t) == "cpu"
            if calls["kernel"] != before:
                tested_at.append(t)
        # Boot at 0, then 300, +600, +1200, +2400, then hourly.
        assert tested_at[:5] == [300, 900, 2100, 4500, 8100], tested_at
        gaps = [b - a for a, b in zip(tested_at, tested_at[1:])]
        assert max(gaps) <= aw.CUDA_RETEST_MAX_S, gaps
        warn = [l for l in rig.lines if "self-test failed" in l][-1]
        assert "initialization error" in warn and "driver" not in warn, warn


def no_kernel_final():
    torch, calls = fake_torch(kernel_error=NO_KERNEL)
    with Rig(torch) as rig:
        assert aw.resolve_device() == "cpu"
        warn = next(l for l in rig.lines if "self-test failed" in l)
        assert "testing the card again" not in warn, warn
        for t in (300, 3600, 86_400):
            assert rig.job_at(t) == "cpu"
        assert calls["kernel"] == 1, f"self-test ran {calls['kernel']} times"


def idle_window_moves():
    torch, _ = fake_torch(name="NVIDIA GeForce RTX 3060", capability=(8, 6), errors=[OOM])
    with Rig(torch) as rig:
        assert aw.resolve_device() == "cpu"
        aw._idle_thread_started = True  # armed while on cpu
        aw._idle_window_s = aw.IDLE_UNLOAD_CPU_S
        assert rig.job_at(300) == "cuda"
        assert aw._idle_window_s == aw.IDLE_UNLOAD_CUDA_S, aw._idle_window_s


def loop_retests():
    """main()'s request loop calls the retest at the start of each request
    that may load a model (texts, facets, analysis), and holds _model_lock
    while it does; a transition render, which loads none, does not."""
    seen = []
    names = ("retest_cuda_at_job_start", "get_embedder", "analyze_facet_request", "analyze", "emit")
    saved = {n: getattr(aw, n) for n in names}
    saved_stdin, saved_mods = sys.stdin, {m: sys.modules.get(m) for m in ("librosa", "numpy")}
    try:
        aw.retest_cuda_at_job_start = lambda: seen.append(aw._model_lock.locked())
        aw.get_embedder = lambda force=False: None
        aw.analyze_facet_request = lambda _l, _r: {}
        aw.analyze = lambda *_a, **_k: {}
        aw.emit = lambda _o: None
        sys.modules["librosa"] = types.ModuleType("librosa")
        sys.modules["numpy"] = sys.modules.get("numpy") or types.ModuleType("numpy")
        sys.stdin = io.StringIO("\n".join(json.dumps(r) for r in (
            {"id": 1, "texts": ["warm pads"]},
            {"id": 2, "path": "/m/a.flac", "facets": ["edges"]},
            {"id": 3, "path": "/m/a.flac"},
            {"id": 4, "op": "render_transition"},
        )) + "\n")
        aw.main()
    finally:
        for n, v in saved.items():
            setattr(aw, n, v)
        sys.stdin = saved_stdin
        for m, v in saved_mods.items():
            if v is None:
                sys.modules.pop(m, None)
            else:
                sys.modules[m] = v
    assert seen == [True, True, True], f"retest calls (lock held?): {seen}"


def self_test_releases():
    torch, calls = fake_torch(kernel_error=NO_KERNEL)
    err = aw.cuda_self_test(torch)
    assert err is not None
    gc.collect()
    assert torch.tensors and all(ref() is None for ref in torch.tensors), \
        "the returned exception's traceback must not keep the tensor alive"
    assert calls["empty_cache"] == 1, calls
    ok, ok_calls = fake_torch(name="NVIDIA GeForce RTX 3060", capability=(8, 6))
    assert aw.cuda_self_test(ok) is None
    assert ok_calls["empty_cache"] == 0, "a passing self-test leaves the cache alone"


def message_decides_kind():
    """torch's text wins over the advisory arch list: a missing kernel image on
    a card the list claims (a PTX JIT that failed) is still final, and out of
    memory is never final, by text or by torch's own exception type."""
    covered = ((8, 6), CU128_ARCHES)
    assert aw.cuda_failure_kind(RuntimeError(NO_KERNEL), *covered) == "no_kernel"
    assert aw.cuda_failure_kind(RuntimeError(OOM), *covered) == "oom"
    OutOfMemoryError = type("OutOfMemoryError", (RuntimeError,), {})
    assert aw.cuda_failure_kind(OutOfMemoryError("2.00 MiB"), *covered) == "oom"
    assert aw.cuda_failure_kind(RuntimeError(INIT), *covered) == "other"
    probe = ("RTX 3060", (8, 6), CU128_ARCHES)
    warn = aw._cuda_fallback_warning(probe, RuntimeError("CUDA error: 2 MiB"), "oom", 300)
    assert "held by another process" in warn and "driver" not in warn, warn


if __name__ == "__main__":
    main()
