#!/usr/bin/env python3
"""Score three bar grids against human downbeat labels on GTZAN.

  a       today's grid: the worker's own decode and facet_head (librosa
          beat_track, every 4th beat a bar)
  small0  Beat This small0 through the worker's DownbeatTracker
  final0  Beat This final0, the same way

GTZAN is the one public set upstream held out of training for every `small*`
and `final*` checkpoint (README of beat_this v1.1.0), so it is a fair test.
Labels: GTZAN-Rhythm (Marchand & Peeters), github.com/TempoBeatDownbeat/
gtzan_tempo_beat. Runs in a venv with the analyzer's pins plus onnxruntime
and mir_eval; never imports torch. See README.md.

  python evaluate.py run   GENRES_DIR MODELS_DIR results.jsonl [--procs 3]
  python evaluate.py score results.jsonl ANNOTATIONS_DIR metrics.json

`run` appends one JSON line per clip and resumes where it stopped. `score`
reports, per genre and overall:
  downF      downbeat F-measure, mir_eval.beat.f_measure, ±70 ms, first 5 s
             trimmed (mir_eval's default, as upstream's paper metrics do)
  barPrec    share of emitted bars within 70 ms of a true downbeat (untrimmed)
  cueHit     render_transition's two cue bars, bars[CARRY_BARS] and
             bars[CARRY_BARS + TAIL_FULL_BARS], BOTH within 70 ms of a true
             downbeat; a grid too short to cue counts as a miss
  beatF      beat F-measure, same settings as downF
  bpm        60 / median inter-beat interval vs the annotated tempo: within
             4% (ok), within 4% of double or half (octave), or other
"""

import argparse
import glob
import importlib.util
import json
import os
import sys
import time
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "controller", "scripts"))
WORKER = os.path.join(HERE, "..", "..", "controller", "scripts", "analyze_worker.py")

TOL = 0.07
CARRY_BARS = 4       # render_transition's constants
TAIL_FULL_BARS = 2
SYSTEMS = (("a", "a_beats", "a_bars"), ("small0", "small0_beats", "small0_down"),
           ("final0", "final0_beats", "final0_down"))

_aw = _librosa = _trackers = None


def _init(models_dir):
    global _aw, _librosa, _trackers
    os.environ.pop("ANALYZE_DOWNBEATS", None)  # grid (a) is today's, always
    spec = importlib.util.spec_from_file_location("analyze_worker", WORKER)
    _aw = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(_aw)
    import librosa

    _librosa = librosa
    _trackers = {}
    for k in ("small0", "final0"):
        _trackers[k] = _aw.DownbeatTracker(os.path.join(models_dir, f"beat_this-{k}.onnx"), 1)
        _trackers[k].load()


def _one(item):
    clip, path = item
    row = {"clip": clip}
    try:
        y_src, sr = _aw.load_audio(_librosa, path, sr=_aw.ANALYZE_SR, mono=False, duration=_aw.ANALYZE_SECONDS)
        y = _librosa.to_mono(y_src)
        row["dur_s"] = len(y) / sr
        t = time.perf_counter()
        head = _aw.facet_head(y, sr, _librosa)
        row["t_head"] = time.perf_counter() - t
        row["a_bpm"] = head.get("bpm")
        row["a_beats"] = [b / 1000.0 for b in head.get("beats", [])]
        row["a_bars"] = [b / 1000.0 for b in head.get("bars", [])]
        for k, tracker in _trackers.items():
            t = time.perf_counter()
            b, d = tracker.track(y, sr, _librosa)
            row[f"t_{k}"] = time.perf_counter() - t
            row[f"{k}_beats"] = [float(x) for x in b]
            row[f"{k}_down"] = [float(x) for x in d]
    except Exception as e:  # noqa: BLE001 — recorded, reported as skipped
        row["error"] = f"{type(e).__name__}: {e}"
    return row


def run(args):
    from multiprocessing import Pool

    done = set()
    if os.path.exists(args.out):
        with open(args.out) as f:
            done = {json.loads(line)["clip"] for line in f if line.strip()}
    items = []
    for genre in sorted(os.listdir(args.genres)):
        if not os.path.isdir(os.path.join(args.genres, genre)):
            continue  # the tarball carries a stray .DS_Store
        files = sorted(x for x in os.listdir(os.path.join(args.genres, genre)) if x.endswith(".wav"))
        if args.limit_per_genre:
            files = files[: args.limit_per_genre]
        for fn in files:
            clip = fn[:-4].replace(".", "_")  # blues.00000 -> blues_00000
            if clip not in done:
                items.append((clip, os.path.join(args.genres, genre, fn)))
    print(f"{len(items)} clips to run ({len(done)} already done)", flush=True)
    t0 = time.time()
    with Pool(args.procs, initializer=_init, initargs=(args.models,)) as pool, open(args.out, "a") as out:
        for i, row in enumerate(pool.imap_unordered(_one, items, chunksize=2), 1):
            out.write(json.dumps(row) + "\n")
            out.flush()
            if i % 50 == 0 or "error" in row:
                print(f"{i}/{len(items)} {time.time() - t0:.0f}s {row['clip']} {row.get('error', '')}", flush=True)


def load_annotations(ann_dir):
    import numpy as np

    out = {}
    for p in glob.glob(os.path.join(ann_dir, "beats", "*.beats")):
        clip = os.path.basename(p)[len("gtzan_"):-len(".beats")]
        beats, down = [], []
        labelled = True
        with open(p) as f:
            for line in f:
                parts = line.split()
                if not parts:
                    continue
                beats.append(float(parts[0]))
                if len(parts) < 2:
                    labelled = False  # beat times only: no downbeat labels
                elif parts[1].split(".")[0] == "1":
                    down.append(float(parts[0]))
        bpm_path = os.path.join(ann_dir, "tempo", f"gtzan_{clip}.bpm")
        bpm = float(open(bpm_path).read().split()[0]) if os.path.exists(bpm_path) else None
        out[clip] = {
            "beats": np.array(beats),
            "down": np.array(down) if labelled and len(down) >= 2 else None,
            "bpm": bpm,
        }
    return out


def score(args):
    import mir_eval
    import numpy as np

    def near(t, ref):
        return len(ref) > 0 and float(np.min(np.abs(ref - t))) <= TOL

    def fmeasure(ref, est, trim=True):
        ref = np.asarray(ref, float)
        est = np.asarray(est, float)
        if trim:
            ref = mir_eval.beat.trim_beats(ref)
            est = mir_eval.beat.trim_beats(est)
        if len(ref) == 0:
            return None
        if len(est) == 0:
            return 0.0
        return float(mir_eval.beat.f_measure(ref, est, TOL))

    def bpm_class(est_bpm, ann_bpm):
        if ann_bpm is None:
            return None
        if est_bpm is None:
            return "none"
        r = est_bpm / ann_bpm
        if abs(r - 1.0) <= 0.04:
            return "ok"
        if abs(r / 2.0 - 1.0) <= 0.04 or abs(r * 2.0 - 1.0) <= 0.04:
            return "octave"
        return "other"

    ann = load_annotations(args.annotations)
    rows = [json.loads(line) for line in open(args.results) if line.strip()]
    window_s = float(os.environ.get("ANALYZE_SECONDS", "").strip() or "40")
    skipped = []
    acc = defaultdict(lambda: defaultdict(list))
    for row in rows:
        clip = row["clip"]
        genre = clip.split("_")[0]
        if "error" in row:
            skipped.append({"clip": clip, "why": row["error"][:160]})
            continue
        a = ann.get(clip)
        if a is None:
            skipped.append({"clip": clip, "why": "no annotation"})
            continue
        groups = (genre, "ALL")
        for g in groups:
            acc[g]["n_beat"].append(1)
            if a["down"] is not None:
                acc[g]["n_down"].append(1)
        for name, bk, dk in SYSTEMS:
            beats = np.array(row[bk])
            bars = np.array(row[dk])
            est_bpm = 60.0 / float(np.median(np.diff(beats))) if len(beats) >= 2 else None
            bf = fmeasure(a["beats"], beats)
            bfu = fmeasure(a["beats"], beats, trim=False)
            cls = bpm_class(est_bpm, a["bpm"])
            for g in groups:
                if bf is not None:
                    acc[g][f"{name}.beatF"].append(bf)
                    acc[g][f"{name}.beatF_untrimmed"].append(bfu)
                if cls is not None:
                    acc[g][f"{name}.bpm_{cls}"].append(1)
                    acc[g][f"{name}.bpm_n"].append(1)
            if a["down"] is None:
                continue
            truth = a["down"]
            prec = float(np.mean([near(t, truth) for t in bars])) if len(bars) else 0.0
            in_bars = [b for b in bars if 0.0 <= b <= window_s - 1.0]  # render_transition's filter
            usable = len(in_bars) >= CARRY_BARS + TAIL_FULL_BARS + 1
            hit = usable and near(in_bars[CARRY_BARS], truth) and near(in_bars[CARRY_BARS + TAIL_FULL_BARS], truth)
            for g in groups:
                acc[g][f"{name}.downF"].append(fmeasure(truth, bars))
                acc[g][f"{name}.downF_untrimmed"].append(fmeasure(truth, bars, trim=False))
                acc[g][f"{name}.barPrec"].append(prec)
                acc[g][f"{name}.cueHit"].append(1.0 if hit else 0.0)
                acc[g][f"{name}.cueUsable"].append(1.0 if usable else 0.0)
                acc[g][f"{name}.emptyBars"].append(1.0 if len(bars) == 0 else 0.0)
        # The bpm the worker actually reports today (librosa's tempo estimate).
        cls = bpm_class(row.get("a_bpm"), a["bpm"])
        if cls is not None:
            for g in groups:
                acc[g][f"a_reported.bpm_{cls}"].append(1)
                acc[g]["a_reported.bpm_n"].append(1)

    table = {}
    for g, m in acc.items():
        t = {"n_beat": len(m["n_beat"]), "n_down": len(m["n_down"])}
        for name in ("a", "small0", "final0", "a_reported"):
            for k in ("beatF", "beatF_untrimmed", "downF", "downF_untrimmed", "barPrec", "cueHit",
                      "cueUsable", "emptyBars"):
                v = m.get(f"{name}.{k}")
                if v:
                    t[f"{name}.{k}"] = round(100.0 * float(np.mean(v)), 1)
            n = len(m.get(f"{name}.bpm_n", []))
            if n:
                for cls in ("ok", "octave", "other", "none"):
                    t[f"{name}.bpm_{cls}"] = round(100.0 * len(m.get(f"{name}.bpm_{cls}", [])) / n, 1)
        table[g] = t
    order = sorted(k for k in table if k != "ALL") + ["ALL"]
    result = {"table": {k: table[k] for k in order}, "skipped": skipped, "rows": len(rows)}
    with open(args.out, "w") as f:
        json.dump(result, f, indent=1)

    def tri(t, k):
        return " / ".join(f"{t.get(f'{s}.{k}', float('nan')):5.1f}" for s in ("a", "small0", "final0"))

    print(f"{'genre':<10}{'n':>5}{'nD':>5} | downF a/s/f | barPrec | cueHit | beatF | bpm ok | bpm octave")
    for g in order:
        t = table[g]
        print(f"{g:<10}{t['n_beat']:>5}{t['n_down']:>5} | " + " | ".join(
            tri(t, k) for k in ("downF", "barPrec", "cueHit", "beatF", "bpm_ok", "bpm_octave")))
    print("skipped:", skipped)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("genres")
    r.add_argument("models")
    r.add_argument("out")
    r.add_argument("--procs", type=int, default=3)
    r.add_argument("--limit-per-genre", type=int, default=0)
    s = sub.add_parser("score")
    s.add_argument("results")
    s.add_argument("annotations")
    s.add_argument("out")
    args = ap.parse_args()
    (run if args.cmd == "run" else score)(args)


if __name__ == "__main__":
    main()
