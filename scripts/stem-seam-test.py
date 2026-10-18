#!/usr/bin/env python3
"""Stem-seam render harness, Python half (driven by scripts/stem-seam-test.sh).

  stem-seam-test.py prepare <work-dir> <repo-dir>
      Writes synthetic 120 BPM tracks (P, X, Y) as FLAC, fakes the stem cache
      for X's tail and Y's head, and renders the blend clip with the REAL
      worker (controller/scripts/analyze_worker.py render_transition). Prints
      the worker's blend_start_sec / in_cue_sec / clip_sec as JSON.

  stem-seam-test.py predecessor <work-dir> <trim-samples>
      Rewrites P shortened by <trim-samples> at its end, so X starts (and so
      every later seam lands) at a different phase within a 20 ms frame.

  stem-seam-test.py analyse <wav> <seam-x> <seam-y> [tolerance-ms]
      Finds the click onsets in a Liquidsoap render and checks the beat grid
      around the two clip seams. Exit 0 = every interval is one beat, within
      the tolerance (default 5 ms).

  mixer <radio.liq> <work-dir>
      Extracts the full transition callback and actual cross wiring, verbatim.
  render-script <work-dir> <name> <station-cross> <fixture.json>
      Builds a render using the controller's real annotations.
  analyse-render <wav> <log> <fixture.json> <clip-sec> <tolerance-ms>
      Locates seams from the measured overlaps, checks buffers and beat grid,
      and the sample-level placement of Y against the clip at clip -> Y.
  y-format <work-dir> <flac|flac-3600|mp3>
      Re-encodes Y so its cue lands at another distance from a codec frame.
  cuein-prepare <work-dir> / cuein-script <work-dir> <case> /
  cuein-analyse <work-dir> <predictions.json> <label>
      The `stem-seam-test.sh cuein` measurement: where liq_cue_in really
      lands per format, against the controller's cue-landing prediction.

Why clicks: the script cannot hear a stutter, but a stutter on a beat grid is
an interval that is not one beat (a bar shortened by the seam overlap, a beat
played twice or not at all). Every source here — X's drums, the borrowed loop
the worker builds from them, Y's drums — sits on ONE continuous 0.5 s grid
when the seams are right, so any interval off 0.5 s is the seam's fault.
"""

import json
import os
import re
import sys

import numpy as np
import soundfile as sf

SR = 44100
BEAT = 0.5          # 120 BPM
BAR = 4 * BEAT
X_DUR = 60.0
Y_DUR = 60.0
OUTRO_SECONDS = 20.0  # analyze_worker default: tail window = decoded dur - 20 s
HEAD_SECONDS = 40.0   # analyze_worker default ANALYZE_SECONDS
WIND_DOWN = 54.0      # X's outro "wind-down" start: the last usable bar ends here

# P's length in samples, less this trim (STEM_SEAM_P_TRIM). A predecessor of
# exactly 60 s ends on a frame boundary, and so does every seam after it; a
# trim moves the whole render off the frame grid, which is where `cross` loses
# a partial frame.
P_TRIM = int(os.environ.get("STEM_SEAM_P_TRIM", "0"))

SEAM_WINDOW = 2.5     # seconds either side of a seam that are checked
# A clip seam's buffer may fall up to one frame short of its stamp (`cross`
# buffers whole frames) and, on a mixer that aligns clip seams, runs past it by
# up to radio.liq's clip_seam_slack. Short station crossfades leaking into the
# seam (the #1774 bug) still land far outside this window.
BUFFER_SHORT_MS = 25.0
BUFFER_LONG_MS = 150.0

# SAMPLE-LEVEL PLACEMENT at clip -> Y (#2003). The clip's tail is Y's own head
# stems, so the seam crossfades near-identical audio: any offset between the
# two sides is a comb filter (2.9 ms notched a 165 Hz pad 24 dB) that the 5 ms
# beat grid cannot see. Both sides are cross-correlated against Y itself; the
# Y-timeline offsets they imply must agree within this many samples.
PLACEMENT_TOLERANCE_SAMPLES = float(os.environ.get("SEAM_PLACEMENT_SAMPLES", "2"))
PLACEMENT_WINDOW = 1.0     # seconds of audio correlated on each side
PLACEMENT_GUARD = 0.05     # kept clear of the crossfade buffer
PLACEMENT_MAX_LAG = 0.15   # search +-; unique against the 0.5 s click period


def click_train(dur, level_down=0.5, level_beat=0.35, freq=2000.0):
    """A decaying tone burst on every beat, accented on the downbeat."""
    n = int(dur * SR)
    out = np.zeros(n, np.float32)
    k = np.arange(int(0.04 * SR))
    burst = (np.sin(2 * np.pi * freq * k / SR) * np.exp(-k / (0.006 * SR))).astype(np.float32)
    t = 0.0
    i = 0
    while t < dur - 0.05:
        a = int(round(t * SR))
        m = min(burst.size, n - a)
        out[a:a + m] += burst[:m] * (level_down if i % 4 == 0 else level_beat)
        t += BEAT
        i += 1
    return out


def pad(dur, freq, level=0.08):
    t = np.arange(int(dur * SR)) / SR
    return (np.sin(2 * np.pi * freq * t) * level).astype(np.float32)


def stereo(x):
    return np.stack([x, x], axis=1)


def write_stems(dirpath, window, stems):
    os.makedirs(dirpath, exist_ok=True)
    for name, data in stems.items():
        sf.write(os.path.join(dirpath, f"{window}-{name}.flac"), stereo(data), SR, subtype="PCM_16", format="FLAC")


def prepare(work, repo):
    os.makedirs(work, exist_ok=True)
    # Full tracks = sum of their stems, exactly what the station would decode.
    x_st = {"drums": click_train(X_DUR), "other": pad(X_DUR, 110.0),
            "bass": np.zeros(int(X_DUR * SR), np.float32), "vocals": np.zeros(int(X_DUR * SR), np.float32)}
    y_st = {"drums": click_train(Y_DUR, freq=3000.0), "other": pad(Y_DUR, 165.0),
            "bass": np.zeros(int(Y_DUR * SR), np.float32), "vocals": np.zeros(int(Y_DUR * SR), np.float32)}
    sf.write(os.path.join(work, "x.flac"), stereo(sum(x_st.values())), SR, subtype="PCM_16", format="FLAC")
    sf.write(os.path.join(work, "p.flac"), stereo(sum(x_st.values())), SR, subtype="PCM_16", format="FLAC")
    sf.write(os.path.join(work, "y.flac"), stereo(sum(y_st.values())), SR, subtype="PCM_16", format="FLAC")

    tail_start = X_DUR - OUTRO_SECONDS
    a = int(tail_start * SR)
    write_stems(os.path.join(work, "stems-x"), "tail", {k: v[a:] for k, v in x_st.items()})
    with open(os.path.join(work, "stems-x", "tail-meta.json"), "w") as f:
        json.dump({"tail_start_sec": tail_start, "duration_sec": X_DUR}, f)
    h = int(HEAD_SECONDS * SR)
    write_stems(os.path.join(work, "stems-y"), "head", {k: v[:h] for k, v in y_st.items()})

    sys.path.insert(0, os.path.join(repo, "controller", "scripts"))
    import analyze_worker  # noqa: E402 — stdlib-only at import; numpy/soundfile inside the op

    out_bars = [int(round(b * 1000)) for b in np.arange(tail_start, X_DUR + 1e-9, BAR)]
    in_bars = [int(round(b * 1000)) for b in np.arange(0.0, HEAD_SECONDS - 1.0, BAR)]
    res = analyze_worker.render_transition({
        "out": {"stems_dir": os.path.join(work, "stems-x"), "duration_s": X_DUR,
                "outro": {"start_ms": int(WIND_DOWN * 1000), "bars": out_bars, "lufs": None},
                "gain_db": 0.0},
        "in": {"stems_dir": os.path.join(work, "stems-y"), "bars": in_bars, "gain_db": 0.0},
        "out_dir": work,
        "clip_name": "clip.wav",
        "target_lufs": -14,
    })
    if not res.get("ok"):
        print(json.dumps(res))
        sys.exit(1)
    print(json.dumps({k: res[k] for k in ("blend_start_sec", "in_cue_sec", "clip_sec")}))


def y_format(work, fmt):
    """Re-encode Y so its cue lands elsewhere relative to a codec frame. Prints
    the file name. `flac` = the libsndfile original (4096-sample blocks:
    11.7 s lands 126 samples late); `flac-3600` = 3600-sample blocks (2430
    samples, 55 ms late); `mp3` = LAME CBR 320 (lands EARLY by its encoder
    delay minus the frame offset: not compensable, expected to fail)."""
    import subprocess
    if fmt == "flac":
        print("y.flac")
        return
    args = {"flac-3600": (["-c:a", "flac", "-frame_size", "3600"], "y-3600.flac"),
            "mp3": (["-c:a", "libmp3lame", "-b:a", "320k"], "y.mp3")}
    if fmt not in args:
        raise ValueError(f"unknown Y format {fmt}")
    codec, name = args[fmt]
    subprocess.run([os.environ.get("FFMPEG", "ffmpeg"), "-v", "error", "-y", "-i", os.path.join(work, "y.flac"),
                    *codec, os.path.join(work, name)], check=True)
    print(name)


def _hp_mono(x):
    """Mono first difference: keeps the clicks, all but removes the pads, so
    the correlation peak is the click grid's and not a pad period's."""
    m = x.mean(axis=1) if x.ndim == 2 else x
    return np.diff(m, prepend=m[:1])


def placement(render, ref, window_start, expected_ref_start):
    """Reference sample index that best matches render[window_start:+window],
    searched +-PLACEMENT_MAX_LAG around `expected_ref_start`. Returns
    (index, normalised peak)."""
    from scipy.signal import correlate
    n = int(PLACEMENT_WINDOW * SR)
    lag = int(PLACEMENT_MAX_LAG * SR)
    needle = render[window_start:window_start + n]
    lo = max(0, expected_ref_start - lag)
    hay = ref[lo:expected_ref_start + lag + n]
    if needle.size < n or hay.size < n:
        raise ValueError("placement window runs off the render or the reference")
    cc = correlate(hay, needle, mode="valid", method="fft")
    k = int(np.argmax(cc))
    seg = hay[k:k + n]
    peak = float(cc[k] / (np.linalg.norm(needle) * np.linalg.norm(seg) + 1e-12))
    return lo + k, peak


def predecessor(work, trim):
    data, sr = sf.read(os.path.join(work, "x.flac"), dtype="float32", always_2d=True)
    if trim:
        data = data[:-trim]
    sf.write(os.path.join(work, "p.flac"), data, sr, subtype="PCM_16", format="FLAC")


def onsets(path):
    data, sr = sf.read(path, dtype="float32", always_2d=True)
    x = data.mean(axis=1)
    # The clicks are 2-3 kHz bursts over 110/165 Hz pads: a first difference
    # keeps the bursts and all but removes the pads.
    d = np.abs(np.diff(x, prepend=x[:1]))
    w = int(0.002 * sr)
    env = np.convolve(d, np.ones(w, np.float32) / w, mode="same")
    thr = 0.15 * float(env.max())
    found = []
    i = 0
    refractory = int(0.12 * sr)
    while i < env.size:
        if env[i] > thr:
            found.append(i / sr)  # the attack: first crossing of the threshold
            i += refractory
        else:
            i += 1
    return found


def analyse(path, seam_x, seam_y, tol_ms):
    """Check the beat grid in a window around each seam. Only the seams: the
    clip's own interior has a deliberate ride-out fade on the borrowed loop,
    whose quietest clicks sit under the onset threshold."""
    tol = tol_ms / 1000.0
    ts = onsets(path)
    worst_all = 0.0
    bad = 0
    for label, seam in (("X -> clip", seam_x), ("clip -> Y", seam_y)):
        win = [t for t in ts if seam - SEAM_WINDOW <= t <= seam + SEAM_WINDOW]
        worst = 0.0
        print(f"  {label} (around {seam:.2f}s): {len(win)} onsets")
        for a, b in zip(win, win[1:]):
            err = (b - a) - BEAT
            worst = max(worst, abs(err))
            mark = ""
            if abs(err) > tol:
                bad += 1
                mark = "  <-- " + ("short: a bar cut" if err < 0 else "long: a beat late or lost")
            if abs(err) > 0.001 or abs(a - seam) < 0.6:
                print(f"    {a:8.3f}s -> {b:8.3f}s  {(b - a) * 1000:6.1f} ms  ({err * 1000:+6.1f}){mark}")
        if len(win) < 2 * SEAM_WINDOW / BEAT - 2:
            bad += 1
            print("    too few onsets: the render is shorter than expected or a seam went silent")
        print(f"    worst beat error at this seam: {worst * 1000:.1f} ms")
        worst_all = max(worst_all, worst)
    print(f"  worst beat error: {worst_all * 1000:.1f} ms (tolerance {tol_ms:.0f} ms)")
    sys.exit(1 if bad else 0)


def mixer(radio_path, work):
    """Lift the mixer implementation, including #1774 when present, verbatim."""
    with open(radio_path) as f:
        radio = f.read()
    default = re.search(r'^crossfade_duration = ref\(([0-9.]+)\)', radio, re.M)
    if default is None:
        raise ValueError("Cannot find the station's default crossfade")
    start = radio.find("cross_prev_end = ref")
    if start < 0:
        start = radio.index("def dj_transition(a, b) =")
    end = radio.index("# The PRE-cross handle", start)
    with open(os.path.join(work, "transition.liq"), "w") as f:
        f.write(radio[start:end])
    region = radio[radio.index('music = amplify(override="liq_amplify"'):radio.index("# DJ VOICE")]
    cross = re.search(r'^music = cross\(.*?^\)', region, re.M | re.S)
    if cross is None or "persist_override=true" not in cross.group():
        raise ValueError("Cannot find the production cross with persist_override")
    mapping = region.find("music = metadata.map")
    wiring = region[mapping:cross.end()] if mapping >= 0 else cross.group()
    with open(os.path.join(work, "cross.liq"), "w") as f:
        f.write(wiring.replace("  dj_transition,", "  seam_transition,"))
    print(float(default.group(1)))


def render_script(work, name, station_sec, fixture_path):
    with open(fixture_path) as f:
        fixture = json.load(f)
    uris = [json.dumps(uri.replace(fixture["libraryPath"], "#{w}")) for uri in fixture["uris"]]
    with open(os.path.join(work, "transition.liq")) as f:
        transition = f.read()
    with open(os.path.join(work, "cross.liq")) as f:
        cross = f.read()
    script = f'''settings.log.stdout := true
settings.log.level := 3
settings.init.allow_root := true
w = environment.get(default="/work", "W")
crossfade_duration = ref({station_sec})
q = request.queue(id="q")
list.iter(fun (p) -> ignore(q.push(request.create(p))), [{', '.join(uris)}])
music = q
{transition}
def seam_transition(a, b) =
  a_name = if a.metadata["subwave_clip"] == "1" then "clip" else a.metadata["title"] end
  b_name = if b.metadata["subwave_clip"] == "1" then "clip" else b.metadata["title"] end
  overlap = min(source.remaining(a.source), source.remaining(b.source))
  log("STEMSEAM: #{{a_name}} -> #{{b_name}} overlap=#{{overlap}}")
  dj_transition(a, b)
end
{cross}
output.file(%wav, fallible=true, "#{{w}}/seam-{name}.wav", music)
clock.assign_new(sync="none", [music])
thread.run(delay=10., fun() -> shutdown())
'''
    with open(os.path.join(work, f"seam-{name}.liq"), "w") as f:
        f.write(script)


def analyse_render(path, log_path, fixture_path, clip_sec, tol_ms):
    with open(log_path) as f:
        log = f.read()
    with open(fixture_path) as f:
        fixture = json.load(f)
    overlaps = {}
    for a, b in (("P", "X"), ("X", "clip"), ("clip", "Y")):
        values = re.findall(rf'STEMSEAM: {a} -> {b} overlap=([0-9.]+(?:[eE][-+]?[0-9]+)?)', log)
        if len(values) != 1:
            raise ValueError(f"Expected exactly one {a} -> {b} transition, got {values}")
        overlaps[a] = float(values[0])
    # seam_x is where the X -> clip BUFFER starts. The clip itself enters
    # b_delay later (radio.liq delays the incoming side to the cue lead); the
    # 2.5 s analysis window spans both, so the window is not moved.
    seam_x = X_DUR - P_TRIM / SR - overlaps["P"] + fixture["outCueSec"] - overlaps["X"]
    seam_y = seam_x + clip_sec - overlaps["clip"]
    for a in ("X", "clip"):
        off_ms = (overlaps[a] - fixture["crossSec"]) * 1000
        if off_ms < -BUFFER_SHORT_MS or off_ms > BUFFER_LONG_MS:
            print(f"  wrong {a} seam buffer: {overlaps[a]}s, expected {fixture['crossSec']}s"
                  f" (-{BUFFER_SHORT_MS:.0f}/+{BUFFER_LONG_MS:.0f} ms)")
            sys.exit(1)
    waits = [float(v) for v in re.findall(r'incoming waits ([0-9.]+(?:[eE][-+]?[0-9]+)?)s', log)]
    placed = check_placement(path, fixture, seam_x, seam_y, overlaps["clip"], waits, clip_sec)
    try:
        analyse(path, seam_x, seam_y, tol_ms)
    except SystemExit as e:
        sys.exit(1 if (e.code or not placed) else 0)


def check_placement(path, fixture, seam_x, seam_y, d_clip, waits, clip_sec):
    """clip -> Y: where the clip's last pure second sits on Y's timeline, and
    where Y's first pure second does, must be the same mapping."""
    data, _ = sf.read(path, dtype="float32", always_2d=True)
    render = _hp_mono(data)
    ydata, _ = sf.read(os.path.join(os.path.dirname(path), "y.flac"), dtype="float32", always_2d=True)
    ref = _hp_mono(ydata)
    # The clip enters the X -> clip buffer `waits[0]` in; Y enters the
    # clip -> Y buffer `waits[1]` in (0 on a mixer without the alignment).
    w_x = waits[0] if len(waits) > 0 else 0.0
    w_y = waits[1] if len(waits) > 1 else 0.0
    clip_start = seam_x + w_x
    y_start = seam_y + w_y
    in_cue_w = fixture.get("workerInCueSec", fixture["inCueSec"])
    # Clip-time tau plays Y-time in_cue_w - clip_sec + tau (its last sample
    # reaches Y at the worker's cue-in).
    c_win = seam_y - PLACEMENT_GUARD - PLACEMENT_WINDOW
    c_exp = in_cue_w - clip_sec + (c_win - clip_start)
    y_win = seam_y + d_clip + PLACEMENT_GUARD
    y_exp = fixture["inCueSec"] + (y_win - y_start)
    try:
        c_idx, c_peak = placement(render, ref, int(round(c_win * SR)), int(round(c_exp * SR)))
        y_idx, y_peak = placement(render, ref, int(round(y_win * SR)), int(round(y_exp * SR)))
    except ValueError as e:
        print(f"  clip -> Y placement: {e}")
        return False
    clip_map = c_idx - int(round(c_win * SR))
    y_map = y_idx - int(round(y_win * SR))
    diff = y_map - clip_map
    ok = abs(diff) <= PLACEMENT_TOLERANCE_SAMPLES
    late = fixture.get("cueLateSec")
    print(f"  clip -> Y placement: clip side maps render->Y at {clip_map:+d}, Y side at {y_map:+d}"
          f" (peaks {c_peak:.2f}/{y_peak:.2f}); Y is {diff:+d} samples ({diff / SR * 1000:+.2f} ms) off the clip"
          f" [tolerance {PLACEMENT_TOLERANCE_SAMPLES:.0f}; stamped cue late"
          f" {'none' if late is None else f'{late * SR:.1f} samples'}; {fixture.get('cueLanding', '')}]"
          + ("" if ok else "  <-- comb filter / flam at clip -> Y"))
    return ok


# ---------------------------------------------------------------------------
# CUE-IN LANDING (#2003): `stem-seam-test.sh cuein`.
#
# Liquidsoap 2.4.x applies liq_cue_in at request resolution through the ffmpeg
# decoder, which emits the first packet at or after the cue WHOLE, so a track
# starts up to one codec frame late. This mode renders `annotate:liq_cue_in`
# with no transition, for every format Navidrome's format=raw can hand
# Liquidsoap, measures where each render really starts (cross-correlation
# against the source PCM) and compares that with the controller's prediction
# (controller/src/music/cue-landing.ts, via scripts/cue-landing-cli.ts).

CUEIN_REF_SEC = 44.0
# Exact codec-frame boundaries at 44.1 kHz: 5.12 s (4608, 1152), 10.24 s
# (1024, 1152, 4608), 20.48 s (1024, 1152, 4608), 40.96 s (1024, 1152, 4096,
# 4608); 40.961 s is 1 ms past one. The rest land mid-frame.
CUEIN_CUES = (1.0, 4.2, 5.12, 10.24, 11.7, 12.0, 15.385, 20.48, 40.96, 40.961)
CUEIN_LEN = 2.5
CUEIN_SILENCE_DB = -60.0


def cuein_reference(sr):
    """Non-periodic stereo test signal: band-limited noise plus a log chirp,
    so cross-correlation has one peak. Deterministic."""
    n = int(CUEIN_REF_SEC * SR)
    rng = np.random.default_rng(2003)
    noise = rng.standard_normal((n, 2)).astype(np.float64)
    k = np.ones(8) / 8.0  # gentle low-pass: keeps lossy codecs honest
    noise = np.stack([np.convolve(noise[:, c], k, mode="same") for c in range(2)], axis=1)
    t = np.arange(n) / SR
    f0, f1 = 60.0, 6000.0
    chirp = np.sin(2 * np.pi * f0 * CUEIN_REF_SEC / np.log(f1 / f0) * (np.exp(t / CUEIN_REF_SEC * np.log(f1 / f0)) - 1))
    ref = 0.18 * noise / np.abs(noise).max() + 0.25 * np.stack([chirp, chirp], axis=1)
    ref = (ref * 0.9).astype(np.float32)
    if sr != SR:
        from scipy.signal import resample_poly
        g = np.gcd(sr, SR)
        ref = resample_poly(ref, sr // g, SR // g, axis=0).astype(np.float32)
    return ref


# (case, source rate, ffmpeg args or None for soundfile, file name)
CUEIN_FORMATS = (
    ("flac-libsndfile", 44100, None, "flac-libsndfile.flac"),
    ("flac-ffmpeg", 44100, ["-c:a", "flac"], "flac-ffmpeg.flac"),
    ("flac-4096", 44100, ["-c:a", "flac", "-frame_size", "4096"], "flac-4096.flac"),
    ("flac-1152", 44100, ["-c:a", "flac", "-frame_size", "1152"], "flac-1152.flac"),
    ("flac-48k", 48000, ["-c:a", "flac"], "flac-48k.flac"),
    ("flac-as-mp3", 44100, ["-c:a", "flac", "-f", "flac"], "flac-as-mp3.mp3"),
    ("mp3-cbr320", 44100, ["-c:a", "libmp3lame", "-b:a", "320k"], "mp3-cbr320.mp3"),
    ("mp3-v0", 44100, ["-c:a", "libmp3lame", "-q:a", "0"], "mp3-v0.mp3"),
    ("mp3-noxing", 44100, ["-c:a", "libmp3lame", "-b:a", "320k", "-write_xing", "0"], "mp3-noxing.mp3"),
    ("m4a-aac", 44100, ["-c:a", "aac", "-b:a", "256k"], "m4a-aac.m4a"),
    ("m4a-alac", 44100, ["-c:a", "alac"], "m4a-alac.m4a"),
    ("ogg-vorbis", 44100, ["-c:a", "libvorbis", "-q:a", "6"], "ogg-vorbis.ogg"),
    ("ogg-opus", 48000, ["-c:a", "libopus", "-b:a", "192k"], "ogg-opus.opus"),
    ("wav", 44100, ["-c:a", "pcm_s16le"], "wav.wav"),
)


def cuein_prepare(work):
    import subprocess
    d = os.path.join(work, "cuein")
    os.makedirs(d, exist_ok=True)
    refs = {}
    for sr in (44100, 48000):
        refs[sr] = cuein_reference(sr)
        sf.write(os.path.join(d, f"ref-{sr}.wav"), refs[sr], sr, subtype="FLOAT")
    only = [f for f in os.environ.get("CUEIN_FORMATS", "").split() if f]
    cases = []
    for case, sr, args, fname in CUEIN_FORMATS:
        if only and case not in only:
            continue
        out = os.path.join(d, fname)
        if args is None:
            sf.write(out, refs[sr], sr, subtype="PCM_16", format="FLAC")
        else:
            subprocess.run([os.environ.get("FFMPEG", "ffmpeg"), "-v", "error", "-y",
                            "-i", os.path.join(d, f"ref-{sr}.wav"), *args, out], check=True)
        cases.append({"case": case, "sr": sr, "file": fname})
    for i, path in enumerate(p for p in os.environ.get("CUEIN_FILES", "").split(":") if p):
        # Real library files, copied in so Liquidsoap (container or chroot)
        # sees them. No reference PCM: each is measured against its own full
        # ffmpeg decode, so the analyzer column does not apply.
        import shutil
        fname = f"file{i}{os.path.splitext(path)[1]}"
        shutil.copyfile(path, os.path.join(d, fname))
        cases.append({"case": f"file{i}", "sr": None, "file": fname, "external": True})
    with open(os.path.join(d, "manifest.json"), "w") as f:
        json.dump({"cues": list(CUEIN_CUES), "cases": cases}, f, indent=1)
    print(len(cases))


def cuein_script(work, case_name):
    """One Liquidsoap script per file, one request.queue + output per cue."""
    d = os.path.join(work, "cuein")
    with open(os.path.join(d, "manifest.json")) as f:
        man = json.load(f)
    case = next(c for c in man["cases"] if c["case"] == case_name)
    src = "#{w}/cuein/" + case["file"]
    lines = ["settings.log.stdout := true", "settings.log.level := 4", "settings.init.allow_root := true",
             'w = environment.get(default="/work", "W")', "srcs = ref([])"]
    for i, cue in enumerate(man["cues"]):
        uri = f'annotate:liq_cue_in="{cue}",liq_cue_out="{cue + CUEIN_LEN:.3f}":{src}'
        lines += [f'q{i} = request.queue(id="q{i}")',
                  f"ignore(q{i}.push(request.create({json.dumps(uri)})))",
                  f'output.file(%wav, fallible=true, "#{{w}}/cuein/out-{case_name}-{i}.wav", q{i})',
                  f"srcs := list.append(srcs(), [q{i}])"]
    # No cue_cut: removed upstream in 2.2.4, a deprecated no-op on 2.4.x.
    lines += ['clock.assign_new(sync="none", srcs())',
              "thread.run(delay=6., fun() -> shutdown())"]
    with open(os.path.join(d, f"cuein-{case_name}.liq"), "w") as f:
        f.write("\n".join(lines) + "\n")


def _mono(x):
    return x.mean(axis=1) if x.ndim == 2 else x


def _lag(hay, needle):
    """Index in `hay` where `needle` best matches (normalised peak)."""
    from scipy.signal import correlate
    cc = correlate(hay, needle, mode="valid", method="fft")
    return int(np.argmax(cc))


def _ffmpeg_decode(path, sr=None):
    import subprocess
    import tempfile
    fd, wav = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        cmd = [os.environ.get("FFMPEG", "ffmpeg"), "-v", "error", "-y", "-i", path, "-map", "0:a:0"]
        if sr:
            cmd += ["-ar", str(sr)]
        subprocess.run(cmd + ["-acodec", "pcm_s16le", "-f", "wav", wav], check=True)
        data, rate = sf.read(wav, dtype="float32", always_2d=True)
    finally:
        os.unlink(wav)
    return data, rate


def analyzer_decode(path):
    """Decode the way analyze_worker does: soundfile when it opens the file
    (ensure_fast_decode / load_audio), else one ffmpeg pre-decode to WAV."""
    try:
        data, rate = sf.read(path, dtype="float32", always_2d=True)
        return data, rate, "soundfile"
    except Exception:  # noqa: BLE001
        data, rate = _ffmpeg_decode(path)
        return data, rate, "ffmpeg"


def cuein_analyse(work, predictions_path, liq_label):
    d = os.path.join(work, "cuein")
    with open(os.path.join(d, "manifest.json")) as f:
        man = json.load(f)
    with open(predictions_path) as f:
        preds = json.load(f)
    refs = {sr: _mono(sf.read(os.path.join(d, f"ref-{sr}.wav"), dtype="float32")[0]) for sr in (44100, 48000)}
    head = int(0.2 * SR)
    win = SR
    search = int(0.2 * SR)
    rows = []
    bad = 0
    for case in man["cases"]:
        name = case["case"]
        path = os.path.join(d, case["file"])
        if case.get("external"):
            ref, _ = _ffmpeg_decode(path, SR)
            ref = _mono(ref)
            a_off, a_dec = 0.0, "n/a (own decode)"
        else:
            # Liquidsoap renders at 44.1 kHz; a 48 kHz source is compared with
            # the 44.1 kHz reference (the 48k file was resampled from it).
            ref = refs[44100]
            src_sr = case["sr"]
            adata, arate, a_dec = analyzer_decode(path)
            am = _mono(adata)
            r_native = refs[src_sr]
            s0 = int(2.0 * arate)
            seg = r_native[s0:s0 + arate]
            lo = max(0, s0 - int(0.2 * arate))
            # analyzer index = ref index + a_off (in source samples; >0 = the
            # decode carries priming/padding ahead of the music)
            a_off = (lo + _lag(am[lo:lo + arate + int(0.4 * arate)], seg)) - s0
            a_off = a_off * SR / arate  # express in 44.1 kHz samples
        for i, cue in enumerate(man["cues"]):
            out = os.path.join(d, f"out-{name}-{i}.wav")
            pred = preds.get(f"{name}|{cue}", {})
            if not os.path.exists(out):
                rows.append((name, cue, None, None, None, None, pred, a_dec, "no render"))
                bad += 1
                continue
            r = _mono(sf.read(out, dtype="float32", always_2d=True)[0])
            thr = 10 ** (CUEIN_SILENCE_DB / 20)
            nz = np.flatnonzero(np.abs(r) > thr)
            lead = int(nz[0]) if nz.size else r.size
            c = cue * SR
            lo = max(0, int(round(c)) + head - search)
            hay = ref[lo:lo + win + 2 * search]
            needle = r[head:head + win]
            if needle.size < win or hay.size < win:
                rows.append((name, cue, None, None, lead, a_off, pred, a_dec, "render too short"))
                bad += 1
                continue
            measured = (lo + _lag(hay, needle)) - head - c   # ref samples past the cue
            needed = measured + a_off                        # in the analyzer's timeline
            rows.append((name, cue, measured, needed, lead, a_off, pred, a_dec, ""))
            if pred.get("validated"):
                # The codec's rule must predict where Y really starts on the
                # analyzer's timeline, stampable (>= 0) or not; and whatever
                # the drain would stamp must be that same value.
                rule = pred.get("ruleLateSec")
                stamped = pred.get("lateSec")
                if case.get("external"):
                    ok = rule is not None and abs(rule * SR - measured) <= 1.0
                else:
                    ok = rule is not None and abs(rule * SR - needed) <= 1.0
                if ok and stamped is not None:
                    ok = abs(stamped - rule) < 1e-9
                if not ok:
                    bad += 1
                    rows[-1] = rows[-1][:8] + ("VALIDATED CODEC MISPREDICTED",)
    print(f"cue-in landing on {liq_label} (samples at 44.1 kHz; measured = Liquidsoap's first sample past the"
          f" cue on the source timeline; needed = same on the analyzer's decode timeline)")
    print(f"{'case':16} {'codec':9} {'cue':>7} {'meas':>8} {'pred':>8} {'diff':>6} {'anlz':>7} {'needed':>8} {'rule':>8} {'stamp':>7} {'sil':>5}  decode note")
    for name, cue, measured, needed, lead, a_off, pred, a_dec, note in rows:
        raw = pred.get("rawLateSec")
        p = raw * SR if isinstance(raw, (int, float)) else None
        fmt = lambda v, w=8: f"{v:{w}.1f}" if isinstance(v, (int, float)) else f"{'-':>{w}}"  # noqa: E731
        diff = (measured - p) if (measured is not None and p is not None) else None
        rl = pred.get("ruleLateSec")
        st = pred.get("lateSec")
        print(f"{name:16} {str(pred.get('codec')):9} {cue:7.3f} {fmt(measured)} {fmt(p)} {fmt(diff, 6)} {fmt(a_off, 7)}"
              f" {fmt(needed)} {fmt(rl * SR if rl is not None else None)} {fmt(st * SR if st is not None else None, 7)}"
              f" {fmt(lead, 5)}  {a_dec} {note}")
    print("meas/pred/needed/rule/stamp in samples; diff = meas - pred (plain packet rule); anlz = analyzer decode"
          " index - source index; rule = the codec's CODEC_RULES prediction ('-' = no rule); stamp = what the"
          " drain stamps ('-' = nothing); sil = leading samples under -60 dBFS")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "prepare":
        prepare(sys.argv[2], sys.argv[3])
    elif cmd == "y-format":
        y_format(sys.argv[2], sys.argv[3])
    elif cmd == "predecessor":
        predecessor(sys.argv[2], int(sys.argv[3]))
    elif cmd == "analyse":
        analyse(sys.argv[2], float(sys.argv[3]), float(sys.argv[4]), float(sys.argv[5]) if len(sys.argv) > 5 else 5.0)
    elif cmd == "mixer":
        mixer(sys.argv[2], sys.argv[3])
    elif cmd == "render-script":
        render_script(sys.argv[2], sys.argv[3], float(sys.argv[4]), sys.argv[5])
    elif cmd == "analyse-render":
        analyse_render(sys.argv[2], sys.argv[3], sys.argv[4], float(sys.argv[5]), float(sys.argv[6]))
    elif cmd == "cuein-prepare":
        cuein_prepare(sys.argv[2])
    elif cmd == "cuein-script":
        cuein_script(sys.argv[2], sys.argv[3])
    elif cmd == "cuein-analyse":
        cuein_analyse(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        print(__doc__)
        sys.exit(2)
