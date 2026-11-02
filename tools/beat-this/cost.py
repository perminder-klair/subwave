#!/usr/bin/env python3
"""One cost sample of the downbeat tracker, in a FRESH process. Prints JSON.

  python cost.py base - 1 WAV40 WAV30          # today's worker work only
  python cost.py ort MODEL.onnx THREADS WAV40 WAV30

Both modes first do what the analyzer already does for every track (import
numpy and librosa, decode, librosa beat_track), so the VmHWM of an `ort` run
minus that of a `base` run is the peak memory Beat This adds on top of
today's worker. Run each sample as its own process: VmHWM never goes down.
BT_ARENA=0 turns off onnxruntime's CPU memory arena.
"""

import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))


def vm(key):
    with open("/proc/self/status") as f:
        for line in f:
            if line.startswith(key + ":"):
                return int(line.split()[1]) / 1024.0  # MiB
    return None


def main():
    mode, model, threads, wav40, wav30 = sys.argv[1:6]
    threads = int(threads)
    out = {"mode": mode, "model": os.path.basename(model), "threads": threads}
    import numpy as np
    import librosa

    y40, sr = librosa.load(wav40, sr=22050, mono=True, duration=40.0)
    y30, _ = librosa.load(wav30, sr=22050, mono=True, duration=30.0)
    librosa.beat.beat_track(y=y40, sr=sr)  # numba JIT warm-up, as a real worker has done
    t = time.perf_counter()
    librosa.beat.beat_track(y=y40, sr=sr)
    out["librosa_beat_track_40s"] = round(time.perf_counter() - t, 3)
    out["rss_after_baseline_mib"] = round(vm("VmRSS"), 1)
    if mode == "ort":
        t = time.perf_counter()
        import onnxruntime as ort

        out["ort_import_s"] = round(time.perf_counter() - t, 3)
        sys.path.insert(0, os.path.join(HERE, "..", "..", "controller", "scripts"))
        import analyze_worker as aw

        so = ort.SessionOptions()
        so.intra_op_num_threads = threads
        so.inter_op_num_threads = 1
        out["arena"] = os.environ.get("BT_ARENA") != "0"
        if not out["arena"]:
            so.enable_cpu_mem_arena = False
        t = time.perf_counter()
        sess = ort.InferenceSession(model, so, providers=["CPUExecutionProvider"])
        out["session_s"] = round(time.perf_counter() - t, 3)
        out["rss_after_session_mib"] = round(vm("VmRSS"), 1)
        tracker = aw.DownbeatTracker(model, threads)
        tracker.session = sess
        tracker.input_name = sess.get_inputs()[0].name
        tracker.track(y30, sr, librosa)  # warm-up
        for label, y in (("30s", y30), ("40s", y40)):
            times = []
            for _ in range(3):
                t = time.perf_counter()
                tracker.track(y, sr, librosa)
                times.append(time.perf_counter() - t)
            out[f"track_{label}_s"] = round(float(np.median(times)), 3)
            out[f"track_{label}_min_s"] = round(float(np.min(times)), 3)
        t = time.perf_counter()
        tracker.logmel(y40, librosa)
        out["logmel_40s_s"] = round(time.perf_counter() - t, 3)
    out["vmhwm_mib"] = round(vm("VmHWM"), 1)
    out["vmrss_end_mib"] = round(vm("VmRSS"), 1)
    print(json.dumps(out))


if __name__ == "__main__":
    main()
