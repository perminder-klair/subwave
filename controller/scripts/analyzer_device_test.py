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
#   - the card is tested once per process, whatever the failure: no request
#     tests it again or moves the worker to cuda, however much later it comes;
#   - the warning's advice fits the cause: out of memory gets neither the
#     driver nor the image-tag advice, and says a restart once memory is free
#     puts the analyzer back on the GPU;
#   - a failed self-test drops its tensor and empties torch's cache.

import gc
import importlib.machinery
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
    arch_list_raises=False,
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

    def get_arch_list():
        if arch_list_raises:
            raise RuntimeError("arch list unavailable")
        return list(arch_list)

    cuda = types.SimpleNamespace(
        is_available=lambda: available,
        get_device_name=lambda _i=0: name,
        get_device_capability=get_device_capability,
        get_arch_list=get_arch_list,
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

    # ── One self-test per process, whatever the failure ────────────────────
    test("out of memory: no driver or tag advice, and a restart puts it back on the GPU", oom_warning)
    for label, err in (("no kernel image", NO_KERNEL), ("out of memory", OOM),
                       ("an init error", INIT), ("a driver error", DRIVER)):
        test(f"{label} at boot stays cpu for every later request, the card never retested",
             lambda err=err: device_is_final(err))

    # ── What a failed self-test leaves on the card ─────────────────────────
    test("a failed self-test drops its tensor and empties the cache", self_test_releases)
    test("torch's message classifies the failure before the arch list does", message_decides_kind)
    test("an arch list torch cannot report is unknown, not a missing kernel image", arch_list_unknown)
    test("releasing cpu models beside a visible card says system memory, not GPU", release_names_device)

    print("PASS" if failures == 0 else f"FAIL ({failures})")
    sys.exit(1 if failures else 0)


OOM = "CUDA out of memory. Tried to allocate 2.00 MiB (GPU 0; 5.93 GiB total capacity)"
INIT = "CUDA error: initialization error"
DRIVER = "CUDA driver version is insufficient for CUDA runtime version"


def oom_warning():
    torch, _ = fake_torch(name="NVIDIA GeForce RTX 3060", capability=(8, 6), errors=[OOM])
    device, lines = resolve(None, torch)
    assert device == "cpu", device
    warn = next(l for l in lines if "self-test failed" in l)
    assert "out of memory" in warn and "RuntimeError" in warn, warn
    assert "no free memory when the analyzer started" in warn, warn
    assert "restarting the analyzer" in warn and "back on the GPU" in warn, \
        f"the out-of-memory warning must say a restart recovers the GPU: {warn}"
    for advice in ("driver", "no kernels", "ANALYZER_CUDA_TAG", ":ampere"):
        assert advice not in warn, f"out of memory must not get {advice!r} advice: {warn}"


def device_is_final(err):
    """The self-test fails at boot with `err`, then the card works. Days of
    requests of every kind later, the worker is still on cpu and the card was
    tested exactly once: nothing retests it or switches the device."""
    torch, calls = fake_torch(name="NVIDIA GeForce RTX 3060", capability=(8, 6), errors=[err])
    clock = [1000.0]

    def tick():
        clock[0] += 86_400.0  # every look at the clock is a day later
        return clock[0]

    seen = []

    def uses_device(*_a, **_k):
        seen.append(aw.resolve_device())
        return {}

    names = ("log", "time", "get_embedder", "analyze_facet_request", "analyze", "emit")
    saved = {n: getattr(aw, n) for n in names}
    saved_stdin = sys.stdin
    saved_mods = {m: sys.modules.get(m) for m in ("torch", "librosa", "numpy")}
    saved_env = os.environ.pop("ANALYZE_DEVICE", None)
    torch.__spec__ = importlib.machinery.ModuleSpec("torch", None)  # main() find_specs it
    try:
        sys.modules["torch"] = torch
        sys.modules["librosa"] = types.ModuleType("librosa")
        sys.modules["numpy"] = sys.modules.get("numpy") or types.ModuleType("numpy")
        aw.log = lambda _m: None
        aw.time = types.SimpleNamespace(time=tick, sleep=lambda _s: None)
        reset_device_state()
        assert aw.resolve_device() == "cpu"
        aw.get_embedder = lambda force=False: uses_device()
        aw.analyze_facet_request = uses_device
        aw.analyze = uses_device
        aw.emit = lambda _o: None
        reqs = [{"id": 1, "texts": ["warm pads"]},
                {"id": 2, "path": "/m/a.flac", "facets": ["edges"]},
                {"id": 3, "path": "/m/a.flac"}] * 4
        sys.stdin = io.StringIO("\n".join(json.dumps(r) for r in reqs) + "\n")
        aw.main()
        assert seen and all(d == "cpu" for d in seen), f"device moved: {seen}"
        assert aw._DEVICE == "cpu", aw._DEVICE
        assert calls["kernel"] == 1, f"the card was tested {calls['kernel']} times"
    finally:
        for n, v in saved.items():
            setattr(aw, n, v)
        sys.stdin = saved_stdin
        for m, v in saved_mods.items():
            if v is None:
                sys.modules.pop(m, None)
            else:
                sys.modules[m] = v
        if saved_env is not None:
            os.environ["ANALYZE_DEVICE"] = saved_env
        reset_device_state()


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
    warn = aw._cuda_fallback_warning(probe, RuntimeError("CUDA error: 2 MiB"), "oom")
    assert "held by another process" in warn and "driver" not in warn, warn



def arch_list_unknown():
    torch, _ = fake_torch(name="NVIDIA GeForce RTX 3060", capability=(8, 6), kernel_error=INIT,
                          arch_list_raises=True)
    device, lines = resolve(None, torch)
    assert device == "cpu", device
    warn = next(l for l in lines if "self-test failed" in l)
    assert "an unknown arch list" in warn, warn
    for advice in ("no kernels", "ANALYZER_CUDA_TAG", ":ampere"):
        assert advice not in warn, f"an unknown arch list read as no kernel image: {warn}"
    assert aw.cuda_failure_kind(RuntimeError(INIT), (8, 6), None) == "other"
    assert aw.cuda_failure_kind(RuntimeError(NO_KERNEL), (8, 6), None) == "no_kernel"



def release_names_device():
    torch, _ = fake_torch(name="NVIDIA GeForce GTX 1060 6GB", kernel_error=NO_KERNEL)
    saved = (sys.modules.get("torch"), aw.log, aw._DEVICE, aw._embedder, aw._vocal_detector)
    lines = []
    try:
        sys.modules["torch"] = torch
        aw.log = lines.append
        for device, where in (("cpu", "system memory"), ("cuda", "GPU memory")):
            aw._DEVICE = device
            aw._embedder, aw._vocal_detector = object(), None
            lines.clear()
            aw._release_models()
            assert len(lines) == 1 and f"released CLAP from {where}" in lines[0], (device, lines)
    finally:
        torch_prev, aw.log, aw._DEVICE, aw._embedder, aw._vocal_detector = saved
        if torch_prev is None:
            sys.modules.pop("torch", None)
        else:
            sys.modules["torch"] = torch_prev


if __name__ == "__main__":
    main()
