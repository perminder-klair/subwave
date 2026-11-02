#!/usr/bin/env python3
"""Prove the analyzer's torch-free Beat This pipeline reproduces upstream.

For each audio file, compares the beat and downbeat times of
  upstream   beat_this.inference.File2Beats(<ckpt>, dbn=False)   (PyTorch)
  ours       analyze_worker.DownbeatTracker(<onnx>)               (numpy + onnxruntime)
and reports, per file, whether the two lists are identical, equal within one
50 fps frame (20 ms), or differ in length. Runs in the export venv (it needs
torch for the upstream side); see README.md.

Feed it 22050 Hz mono WAVs (GTZAN is already that) so both sides decode the
same samples: upstream reads files with torchaudio, the worker with librosa,
and on compressed audio the two decoders can disagree by a few samples, which
is a decode difference rather than a pipeline one.

usage: python parity.py --onnx beat_this-small0.onnx --ckpt beat_this-small0.ckpt \
           --out parity-small0.json AUDIO...
"""

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "controller", "scripts"))
import analyze_worker as aw  # noqa: E402

FRAME_S = 1.0 / aw.BT_FPS


def compare(ref, got):
    """(identical, within_one_frame, length_mismatch, max_abs_diff_s)"""
    import numpy as np

    ref = np.asarray(ref, float)
    got = np.asarray(got, float)
    if len(ref) != len(got):
        return False, False, True, None
    if len(ref) == 0:
        return True, True, False, 0.0
    d = np.abs(ref - got)
    return bool(np.all(d == 0)), bool(np.all(d <= FRAME_S + 1e-9)), False, float(d.max())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--onnx", required=True)
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--threads", type=int, default=2)
    ap.add_argument("audio", nargs="+")
    args = ap.parse_args()

    import librosa
    from beat_this.inference import File2Beats

    tracker = aw.DownbeatTracker(args.onnx, args.threads)
    tracker.load()
    upstream = File2Beats(checkpoint_path=args.ckpt, device="cpu", dbn=False)
    rows = []
    for path in args.audio:
        ref_b, ref_d = upstream(path)
        y, sr = librosa.load(path, sr=aw.BT_SR, mono=True)
        got_b, got_d = tracker.track(y, sr, librosa)
        rb = compare(ref_b, got_b)
        rd = compare(ref_d, got_d)
        row = {
            "path": path,
            "seconds": round(len(y) / sr, 2),
            "beats": len(ref_b),
            "downbeats": len(ref_d),
            "beat_identical": rb[0], "beat_within_frame": rb[1],
            "beat_length_mismatch": rb[2], "beat_max_diff_s": rb[3],
            "down_identical": rd[0], "down_within_frame": rd[1],
            "down_length_mismatch": rd[2], "down_max_diff_s": rd[3],
        }
        if not (rb[1] and rd[1]):
            row.update({
                "ref_beats": [float(x) for x in ref_b], "got_beats": [float(x) for x in got_b],
                "ref_down": [float(x) for x in ref_d], "got_down": [float(x) for x in got_d],
            })
        rows.append(row)
        print(json.dumps({k: v for k, v in row.items() if not k.startswith(("ref_", "got_"))}), flush=True)
    summary = {
        "files": len(rows),
        "beats_identical": sum(r["beat_identical"] for r in rows),
        "beats_within_frame": sum(r["beat_within_frame"] for r in rows),
        "beats_length_mismatch": sum(r["beat_length_mismatch"] for r in rows),
        "downbeats_identical": sum(r["down_identical"] for r in rows),
        "downbeats_within_frame": sum(r["down_within_frame"] for r in rows),
        "downbeats_length_mismatch": sum(r["down_length_mismatch"] for r in rows),
        "total_beats": sum(r["beats"] for r in rows),
        "total_downbeats": sum(r["downbeats"] for r in rows),
    }
    print(json.dumps(summary))
    with open(args.out, "w") as f:
        json.dump({"summary": summary, "rows": rows}, f, indent=1)
    if summary["beats_within_frame"] != len(rows) or summary["downbeats_within_frame"] != len(rows):
        sys.exit("parity failure: see the rows above")


if __name__ == "__main__":
    main()
