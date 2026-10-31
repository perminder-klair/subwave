# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = [
#   "faster-whisper==1.2.1",
#   "av==18.1.0",  # faster-whisper 1.2.1's decode_audio passes an av.open() argument PyAV 19 dropped
#   "jiwer==4.0.0",
#   "whisper-normalizer==0.1.15",
# ]
# ///
"""Score a tts-bench run for intelligibility and, optionally, naturalness.

Intelligibility: each clip is transcribed with Whisper (faster-whisper) and
compared with the words a listener should hear (the line's `spoken`, else its
`text`), as word and character error rates. The same transcriber hears every
engine, so the rates rank engines against each other. They are not absolute:
Whisper has its own trouble with "Hoppipolla", and every engine pays for it.

Naturalness (--mos): UTMOS22, the strong learner, through tarepan/SpeechMOS
pinned at v1.2.0. torch.hub fetches and runs that repository's code, which is
why it is opt-in. It predicts a 1-5 opinion score per clip. Use it to screen
engines; a blind listen still makes the call.

Needs nothing from the station or the engines: only the run directory that
`npm run tts-bench` wrote. From the repo root:

  uv run controller/scripts/tts-bench/score.py <run dir>
  uv run --with torch --with torchaudio controller/scripts/tts-bench/score.py <run dir> --mos

Writes scores.json beside report.json and prints one table that puts the
bench's speed figures next to these.
"""

import argparse
import json
import re
import statistics
import sys
from pathlib import Path

# The persona languages the bench lines use, as Whisper language codes. A line
# in a language missing here is transcribed with Whisper's own detection.
WHISPER_LANG = {
    "english": "en", "spanish": "es", "french": "fr", "german": "de", "italian": "it",
    "portuguese": "pt", "dutch": "nl", "japanese": "ja", "hindi": "hi",
}

SPEECHMOS_REPO = "tarepan/SpeechMOS:v1.2.0"


def normalizers():
    from whisper_normalizer.basic import BasicTextNormalizer
    from whisper_normalizer.english import EnglishTextNormalizer

    return EnglishTextNormalizer(), BasicTextNormalizer(remove_diacritics=True)


def tidy(s: str) -> str:
    """What Whisper's normaliser leaves inconsistent between two right answers."""
    s = re.sub(r"(?<=\d)[ .:](?=\d)", "", s)      # "7 45", "7.45" (both from 7:45) and "745"
    s = re.sub(r"\b([a-z]) (?=[a-z]\b)", r"\1", s)  # "p m" (from p.m.) and "pm"
    s = s.replace("sub wave", "subwave")           # SUB/WAVE, however it was written
    return " ".join(s.split())


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("run_dir", type=Path)
    ap.add_argument("--whisper", default="small", help="faster-whisper model (default small; medium is slower and steadier)")
    ap.add_argument("--device", default="cpu", help="cpu or cuda")
    ap.add_argument("--mos", action="store_true", help="also predict UTMOS (fetches and runs tarepan/SpeechMOS)")
    args = ap.parse_args()

    report_path = args.run_dir / "report.json"
    if not report_path.is_file():
        print(f"no report.json in {args.run_dir}", file=sys.stderr)
        return 2
    report = json.loads(report_path.read_text())
    lines = {line["id"]: line for line in report["lines"]}
    records = [r for r in report["records"] if r["outcome"] == "ok" and r.get("clip")]
    if not records:
        print("no rendered clips to score", file=sys.stderr)
        return 1

    from faster_whisper import WhisperModel, decode_audio
    import jiwer

    english, basic = normalizers()
    print(f"Whisper {args.whisper} on {args.device}, {len(records)} clip(s)", flush=True)
    whisper = WhisperModel(args.whisper, device=args.device, compute_type="int8" if args.device == "cpu" else "float16")

    mos_model = None
    if args.mos:
        try:
            import torch
        except ImportError:
            print("--mos needs torch and torchaudio: uv run --with torch --with torchaudio ...", file=sys.stderr)
            return 2
        mos_model = torch.hub.load(SPEECHMOS_REPO, "utmos22_strong", trust_repo=True)

    scored = []
    for i, r in enumerate(records, 1):
        line = lines[r["line"]]
        lang = (line.get("language") or "English").strip().lower()
        code = WHISPER_LANG.get(lang)
        clip = args.run_dir / r["clip"]
        audio = decode_audio(str(clip), sampling_rate=16000)
        segments, _info = whisper.transcribe(
            audio, language=code, beam_size=5, condition_on_previous_text=False, vad_filter=False,
        )
        transcript = "".join(seg.text for seg in segments).strip()
        norm = english if code == "en" else basic
        ref = tidy(norm(line.get("spoken") or line["text"]))
        hyp = tidy(norm(transcript))
        row = {
            "engine": r["engine"], "line": r["line"], "category": r["category"], "iteration": r["iteration"],
            "transcript": transcript,
            # A rate over 1 is possible: a looping render inserts words.
            "wer": round(jiwer.wer(ref, hyp), 3) if hyp else 1.0,
            "cer": round(jiwer.cer(ref, hyp), 3) if hyp else 1.0,
        }
        if mos_model is not None:
            import torch

            with torch.no_grad():
                row["mos"] = round(float(mos_model(torch.from_numpy(audio).unsqueeze(0), 16000)[0]), 2)
        scored.append(row)
        print(f"  [{i}/{len(records)}] {r['engine']} {r['line']}#{r['iteration']}  wer {row['wer']}"
              + (f"  mos {row['mos']}" if "mos" in row else "")
              + (f"  heard: {transcript!r}" if row["wer"] > 0.25 else ""), flush=True)

    engines = list(dict.fromkeys(r["engine"] for r in scored))
    speed = {s["engine"]: s for s in (report.get("summary") or [])}
    summary = []
    for e in engines:
        mine = [r for r in scored if r["engine"] == e]
        by_cat = {}
        for c in dict.fromkeys(r["category"] for r in mine):
            by_cat[c] = round(statistics.mean(r["wer"] for r in mine if r["category"] == c), 3)
        worst = max(mine, key=lambda r: r["wer"])
        summary.append({
            "engine": e,
            "clips": len(mine),
            "wer": round(statistics.mean(r["wer"] for r in mine), 3),
            "cer": round(statistics.mean(r["cer"] for r in mine), 3),
            "werByCategory": by_cat,
            "worstLine": {"line": worst["line"], "wer": worst["wer"], "heard": worst["transcript"]},
            "mos": round(statistics.mean(r["mos"] for r in mine), 2) if mos_model is not None else None,
        })

    out = {"whisper": args.whisper, "mos": SPEECHMOS_REPO if args.mos else None, "summary": summary, "clips": scored}
    (args.run_dir / "scores.json").write_text(json.dumps(out, indent=1, ensure_ascii=False))

    categories = list(dict.fromkeys(r["category"] for r in scored))
    header = ["engine", "RTF p50", "warm p50", "WER", "CER", *[f"WER {c}" for c in categories]]
    if args.mos:
        header.append("MOS")
    rows = [header]
    for s in summary:
        sp = speed.get(s["engine"], {})
        row = [s["engine"], fmt(sp.get("rtfP50")), fmt(sp.get("warmP50Ms")), fmt(s["wer"]), fmt(s["cer"]),
               *[fmt(s["werByCategory"].get(c)) for c in categories]]
        if args.mos:
            row.append(fmt(s["mos"]))
        rows.append(row)
    widths = [max(len(r[i]) for r in rows) for i in range(len(header))]
    print()
    for r in rows:
        print("  ".join(c.ljust(widths[i]) if i == 0 else c.rjust(widths[i]) for i, c in enumerate(r)))
    print(f"\nScores: {args.run_dir / 'scores.json'}")
    return 0


def fmt(v) -> str:
    return "-" if v is None else str(v)


if __name__ == "__main__":
    sys.exit(main())
