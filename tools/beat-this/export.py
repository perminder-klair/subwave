#!/usr/bin/env python3
"""Export a Beat This! checkpoint to ONNX and prove the export matches PyTorch.

Runs in a throwaway venv with CPU torch and beat_this pinned (see README.md);
the analyzer itself never imports torch. Steps:

  1. sha256-verify the checkpoint BEFORE torch.load touches it (a .ckpt is a
     pickle). beat_this' own loader then opens it with weights_only=True.
  2. Compute reference logits with the UNMODIFIED upstream model on real-audio
     spectrogram chunks (upstream's own LogMelSpect front end).
  3. Trace the model with a dynamic time axis (batch fixed at 1), opset 17,
     with the time-direction attention computed in small groups (below).
  4. Run the same chunks through onnxruntime and fail unless every logit
     agrees with step 2 to within --atol.

Why group. Every attention along time builds a frames x frames score map
per sequence and head, and the three frontend blocks each run 32 such maps at
once (one per frequency band and head): 32 x 1500 x 1500 float32 is 288 MB,
plus its softmax, live together. That is the same in small0 and final0 (both
have stem_dim 32), and final0's main transformer adds 16 more per layer.
Attention never mixes maps, so --attn-group N computes the same numbers N
maps at a time. --attn-group 0 exports upstream's graph unchanged. Step 4
compares against the unpatched model, so a grouping mistake cannot pass.

Usage:
  python export.py --ckpt beat_this-small0.ckpt \
      --sha256 6074be2c4d490c5f6101fcc374a1ec72ae93456e23bb6019783b849f5dc7d47b \
      --out beat_this-small0.onnx --audio some.wav [--audio more.mp3 ...]

Exit status is non-zero on a hash mismatch or a parity failure, so a Docker
builder stage that runs it cannot ship a model that disagrees with upstream.
"""

import argparse
import hashlib
import json
import sys

# Spectrogram lengths (frames, 50 fps) checked for parity. 1500 is upstream's
# chunk size; 1013 is a 20 s tail window plus its two 6-frame borders; the
# rest are odd lengths to catch anything the trace baked in.
PARITY_LENGTHS = (1500, 1013, 512, 1237)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def logits_module(model):
    """BeatThis returns a dict; the graph returns a plain (beat, downbeat)."""
    import torch

    class Logits(torch.nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, spect):
            out = self.m(spect)
            return out["beat"], out["downbeat"]

    return Logits(model).eval()


def group_attention(maps_per_group, min_len=64):
    """Patch roformer.Attend.forward (beat_this v1.1.0) so attention over a
    long axis runs `maps_per_group` attention maps at a time. Attention is
    computed per map (one sequence, one head), and the softmax runs over each
    map's own rows, so this is the same arithmetic as upstream's
    F.scaled_dot_product_attention with only one group's scores live. The
    split happens after the rotary embedding, which is applied once.

    The branch is decided at trace time: the frequency-direction attention
    (8 to 32 positions) keeps upstream's call, and only the time-direction
    attention, traced at 1500 frames, is grouped. Reshapes keep the time axis
    as -1 so it stays dynamic in the exported graph."""
    import torch
    import torch.nn.functional as F
    from beat_this.model import roformer

    upstream = roformer.Attend.forward

    def forward(self, q, k, v):
        seqs, heads, length, dim = q.shape
        if length <= min_len or self.training:
            return upstream(self, q, k, v)
        assert self.scale is None, "beat_this v1.1.0 never sets a custom scale"
        scale = dim ** -0.5  # F.scaled_dot_product_attention's default
        qf = q.reshape(seqs * heads, -1, dim) * scale
        kf = k.reshape(seqs * heads, -1, dim)
        vf = v.reshape(seqs * heads, -1, dim)
        out = torch.cat([
            torch.matmul(F.softmax(torch.matmul(qg, kg.transpose(-1, -2)), dim=-1), vg)
            for qg, kg, vg in zip(
                torch.split(qf, maps_per_group), torch.split(kf, maps_per_group),
                torch.split(vf, maps_per_group),
            )
        ])
        return out.reshape(seqs, heads, -1, dim)

    roformer.Attend.forward = forward


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--sha256", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--audio", action="append", default=[], help="real audio for the parity check")
    ap.add_argument("--opset", type=int, default=17)
    ap.add_argument("--attn-group", type=int, default=2,
                    help="attention maps per group on the time axis; 0 = upstream graph unchanged")
    ap.add_argument("--atol", type=float, default=2e-3)
    args = ap.parse_args()

    got = sha256(args.ckpt)
    if got != args.sha256.lower():
        sys.exit(f"checkpoint sha256 mismatch: {got} != {args.sha256}")
    if not args.audio:
        sys.exit("--audio is required: parity is only proven on real audio")

    import numpy as np
    import onnxruntime as ort
    import torch
    from beat_this.inference import load_model
    from beat_this.preprocessing import LogMelSpect, load_audio

    model = load_model(args.ckpt, "cpu")
    wrapped = logits_module(model)

    # Reference logits from the unmodified model, before any patching.
    mel = LogMelSpect()
    chunks = []
    for path in args.audio:
        signal, sr = load_audio(path)
        if signal.ndim == 2:
            signal = signal.mean(1)
        if sr != 22050:
            import soxr

            signal = soxr.resample(signal, in_rate=sr, out_rate=22050)
        spect = mel(torch.tensor(signal, dtype=torch.float32))
        for length in PARITY_LENGTHS:
            if len(spect) >= length:
                chunk = spect[:length].unsqueeze(0)
                with torch.no_grad():
                    tb, td = wrapped(chunk)
                chunks.append((chunk.numpy(), tb.numpy(), td.numpy()))
    if not chunks:
        sys.exit("no parity chunk was long enough; pass audio of at least 30 s")

    if args.attn_group > 0:
        group_attention(args.attn_group)
    dummy = torch.zeros(1, 1500, 128)
    with torch.no_grad():
        torch.onnx.export(
            wrapped,
            (dummy,),
            args.out,
            input_names=["spect"],
            output_names=["beat", "downbeat"],
            dynamic_axes={"spect": {1: "frames"}, "beat": {1: "frames"}, "downbeat": {1: "frames"}},
            opset_version=args.opset,
            do_constant_folding=True,
            dynamo=False,
        )

    so = ort.SessionOptions()
    so.intra_op_num_threads = 2
    sess = ort.InferenceSession(args.out, so, providers=["CPUExecutionProvider"])
    worst = 0.0
    for spect, tb, td in chunks:
        ob, od = sess.run(["beat", "downbeat"], {"spect": spect})
        worst = max(worst, float(np.abs(ob - tb).max()), float(np.abs(od - td).max()))

    import onnx

    m = onnx.load(args.out)
    report = {
        "ckpt": args.ckpt,
        "ckpt_sha256": got,
        "onnx": args.out,
        "onnx_sha256": sha256(args.out),
        "opset": args.opset,
        "attn_group": args.attn_group,
        "params": int(sum(p.numel() for p in model.parameters())),
        "parity_chunks": len(chunks),
        "max_abs_logit_diff": worst,
        "torch": torch.__version__,
        "onnxruntime": ort.__version__,
        "onnx_ir": m.ir_version,
        "nodes": len(m.graph.node),
    }
    print(json.dumps(report, indent=2))
    if worst > args.atol:
        sys.exit(f"parity failure: max abs logit diff {worst:.3g} > {args.atol}")


if __name__ == "__main__":
    main()
