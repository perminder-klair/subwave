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
#     no-GPU fallback is unchanged.

import os
import sys
import types

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
):
    """A `torch` module shaped like the real one as far as resolve_device()
    goes. `kernel_error` set = the card is visible but every kernel fails,
    which is exactly what a wheel without the card's arch does. `calls` counts
    how often the self-test touched the card."""
    calls = {"kernel": 0}

    class Tensor:
        def __init__(self, n):
            self.n, self.v = n, 1.0

        def mul_(self, k):
            calls["kernel"] += 1
            if kernel_error:
                raise RuntimeError(kernel_error)
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
    )
    mod = types.ModuleType("torch")
    mod.cuda = cuda
    mod.ones = ones
    return mod, calls


def resolve(env, torch_mod):
    """Run resolve_device() fresh with ANALYZE_DEVICE=env and `torch_mod` as
    torch. Returns (device, log lines)."""
    lines = []
    saved = (sys.modules.get("torch"), aw.log, os.environ.get("ANALYZE_DEVICE"))
    try:
        sys.modules["torch"] = torch_mod
        aw.log = lambda m: lines.append(m)
        aw._DEVICE = None
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
        aw._DEVICE = None
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
        for needle in ("GTX 1060", "sm_61", "sm_75", "sm_120", ":pascal", "no kernel image", "Demucs on cpu is slow"):
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

    print("PASS" if failures == 0 else f"FAIL ({failures})")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
