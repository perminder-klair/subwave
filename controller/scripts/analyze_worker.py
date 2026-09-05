#!/usr/bin/env python3
"""
Acoustic-analysis worker — line-protocol child process.

The Node side (controller/src/music/analyzer.ts) spawns this once and keeps it
alive, because importing librosa takes a couple of seconds and we don't want to
eat that per track in a bulk pass. Protocol is one JSON object per line over
stdin/stdout, same shape as the Kokoro/PocketTTS workers.

Request:  {"id": "<song id>", "url": "<http stream url>"}   (worker downloads)
       |  {"id": "<song id>", "path": "<local file path>"}  (caller owns it)
Response: {"id": "<echoed>", "ok": true, "bpm": 122.0, "key": "8A",
           "intro_ms": 8200, "confidence": 0.71,
           "audio_embedding": [/* 512 floats, OPTIONAL */]}
       |  {"id": "<echoed>", "ok": false, "error": "..."}

`audio_embedding` is present ONLY when ANALYZE_AUDIO_EMBEDDING is enabled AND a
CLAP model loaded — a 512-d, L2-normalised vector of how the track SOUNDS
(timbre / instrumentation / production), derived from the waveform itself. When
disabled or the model is absent the field is omitted entirely and the worker
behaves exactly as it did before (bpm/key/intro only) — never a hard failure.

This deliberately lives OUTSIDE the controller image — librosa pulls in
numba/scipy/soundfile, which the controller must stay lean of. It runs in the
tts-heavy sidecar's analyzer venv, or in a standalone offline venv on the
operator's machine. Audio is fetched from the Subsonic stream URL (auth baked
into the query string) to a temp file, then only the first ANALYZE_SECONDS are
decoded — enough for tempo/key and the intro estimate, a fraction of the bytes.
(The CLAP embedding additionally decodes a mid-song and a late window from the
same file — see embed_windows — so the vector reflects the whole track, not
just its intro.)

The embedder also answers text requests ({"texts": [...]}) with CLAP
text-tower embeddings in the SAME 512-d space, which is what makes
natural-language "sounds like ..." search and zero-shot mood scoring against
the stored audio vectors possible.
"""

import contextlib
import ctypes
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import warnings

# 40s is enough for stable BPM (beat_track) / key (chroma); intro detection
# only needs the first ~20-30s. Env-overridable; the window is shared by
# bpm/key, CLAP and Demucs, and Demucs cost scales linearly with it (60→40
# measured ~1.5x faster) — keep the three defaults (here, config.ts,
# docker/analyzer/server.py) in sync.
#
# Every env read here treats an EMPTY value as unset (`.strip() or default`,
# like the CLAP_MODEL reads below): compose passes these through as
# `VAR=${VAR:-}`, which injects empty strings for anything the operator didn't
# set — a plain get(name, default) then returns "" and float("")/get_model("")
# crash or corrupt the download path (the '' checkpoint hit Errno 21).
ANALYZE_SECONDS = float(os.environ.get("ANALYZE_SECONDS", "").strip() or "40")
ANALYZE_SR = int(os.environ.get("ANALYZE_SR", "").strip() or "22050")
FETCH_TIMEOUT_S = float(os.environ.get("ANALYZE_FETCH_TIMEOUT_S", "").strip() or "60")
# Ceiling for the one-shot ffmpeg pre-decode (ensure_fast_decode) — the input
# is a byte-capped download, seconds of decode work even on a weak NAS CPU.
FFMPEG_DECODE_TIMEOUT_S = float(
    os.environ.get("ANALYZE_FFMPEG_TIMEOUT_S", "").strip() or "120"
)

# --- CLAP audio embedding (optional, opt-in) -------------------------------
# Off unless ANALYZE_AUDIO_EMBEDDING is truthy. CLAP wants 48 kHz mono; the
# embedding dim is fixed by the model (LAION-CLAP audio projection = 512).
EMBED_ENABLED = os.environ.get("ANALYZE_AUDIO_EMBEDDING", "").strip().lower() in (
    "1", "true", "yes",
)
CLAP_SR = 48000
CLAP_EMBED_DIM = 512
# How many windows the CLAP embed averages over (clamped 1..3): 3 = start/mid/
# late (default), 2 = start/mid, 1 = the pre-multi-window leading-window-only
# behaviour. CLAP cost per track scales linearly — this is the speed lever for
# the embedding pass (ANALYZE_SECONDS scales everything else too).
CLAP_WINDOWS = int(os.environ.get("ANALYZE_CLAP_WINDOWS", "").strip() or "3")

# --- Outro analysis ---------------------------------------------------------
# Tail window (seconds) decoded from the END of the file for the outro
# features (wind-down start, fade-vs-cold ending, tail loudness/tempo/bars).
# Only runs when the local file is COMPLETE — a byte-capped download's tail is
# the middle of the song, so the caller passes a completeness flag and an
# unknown/short tail simply omits the field (consumers treat absence as "no
# outro signal, behave as today").
OUTRO_SECONDS = float(os.environ.get("ANALYZE_OUTRO_SECONDS", "").strip() or "20")

# --- Silence trim (dead-air gaps at the file's edges) -----------------------
# Absolute peak floor (dBFS) below which a frame counts as SILENCE. This is
# deliberately NOT the relative gate estimate_intro_ms / analyze_outro use:
# those ask "where does the music come in / start winding down" against the
# track's OWN loud level, so a quiet piano intro or a long ring-out trips them.
# A dead-air gap is an absolute property of the file — near-digital silence, a
# bad rip's leading blank, mastering slack at the end — and measuring it
# against a relative reference eats real music. Emitted as lead_silence_ms /
# tail_silence_ms; the controller decides whether a gap is worth cutting.
SILENCE_DBFS = float(os.environ.get("ANALYZE_SILENCE_DBFS", "").strip() or "-50")

# --- Vocal-activity ranges (optional, opt-in) ------------------------------
# Off unless ANALYZE_VOCAL_ACTIVITY is truthy. Runs Demucs source separation to
# isolate the vocal stem, then thresholds its energy envelope into present/
# absent ranges. Heavy (a real torch model) — gated like CLAP. Demucs wants
# 44.1 kHz stereo.
VOCAL_ENABLED = os.environ.get("ANALYZE_VOCAL_ACTIVITY", "").strip().lower() in (
    "1", "true", "yes",
)
DEMUCS_SR = 44100
DEMUCS_MODEL = os.environ.get("DEMUCS_MODEL", "").strip() or "htdemucs"


def _env_float(name, default):
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        # Runs at module load, before log() is defined — write stderr directly.
        sys.stderr.write(
            f"[analyze-worker] {name}={raw!r} is not a number; using default {default}\n"
        )
        return default


def _env_int(name, default, minimum=1):
    """Whole-number env var, warn-and-fall-back — the Python half of the
    controller's `envInt` (controller/src/util/env.ts). A bare `int(raw)`
    RAISED on a typo, which for ANALYZE_MAX_BYTES took the whole download with
    it while the TS side quietly produced NaN: the same bad value put the two
    fetch paths on two different envelopes (#1549). Floats are rejected rather
    than truncated, same as envInt."""
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    # Matched against the same shape envInt accepts rather than handed straight
    # to int(), which is looser than the TS side: it takes "1_000" and non-ASCII
    # digits, both of which would land the two fetch paths on different caps.
    if not re.fullmatch(r"[-+]?[0-9]+", raw):
        # Runs at module load, before log() is defined — write stderr directly.
        sys.stderr.write(
            f"[analyze-worker] {name}={raw!r} is not a whole number; using default {default}\n"
        )
        return default
    value = int(raw)
    if value < minimum:
        sys.stderr.write(
            f"[analyze-worker] {name}={raw!r} must be at least {minimum}; using default {default}\n"
        )
        return default
    return value


# Cap the download so we don't pull whole albums of bytes for a short analysis
# window — ~3 MB covers 2 min of most codecs. Mirrors ANALYZE_MAX_BYTES in
# controller/src/music/analyzer.ts so both fetch paths read the same envelope,
# which is why it is parsed with the same posture (fall back to the default on
# anything malformed, never raise and never NaN).
ANALYZE_MAX_BYTES = _env_int("ANALYZE_MAX_BYTES", 12 * 1024 * 1024)


# Vocal-stem gate thresholds (issue #1125). The stem is thresholded against BOTH
# its own loud level (self-relative, catches quiet-but-present vocals) AND a
# fraction of the FULL-MIX loud level (an absolute-ish floor). Demucs never
# separates cleanly: an instrumental's vocal stem carries residual bleed (pad
# swells, cymbals, guitar harmonics). A purely self-relative gate scales down to
# that bleed and mass-flags instrumentals as vocal. Anchoring the floor to the
# whole song's loudness fixes it — bleed sits far below the mix, real vocals
# don't. Both tunable so operators can adapt to their masters' compression.
VOCAL_STEM_REL = _env_float("VOCAL_STEM_REL", 0.15)  # x 90th-pct of vocal-stem RMS
VOCAL_MIX_FLOOR = _env_float("VOCAL_MIX_FLOOR", 0.06)  # x 90th-pct of full-mix RMS
# Absolute RMS floor for the TAIL detect() pass (feature: vocal-aware
# transitions): a fading outro's separation bleed otherwise reads as artefact
# "vocals". ~-40 dBFS — genuine sung tails sit well above it, bleed well
# below. Tunable like the pair above and for the same reason.
TAIL_VOCAL_MIN_LOUD = _env_float("TAIL_VOCAL_MIN_LOUD", 0.01)

# Krumhansl-Kessler key profiles (major/minor), indexed from the tonic.
MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

# Camelot code per pitch class (C=0 … B=11), one table per mode.
MAJOR_CAMELOT = ["8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B"]
MINOR_CAMELOT = ["5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A"]


def emit(obj):
    # Ride any LOST capability out on every message (see capability_loss). It
    # goes here, in the one serializer, rather than at the handful of response
    # sites, because the whole point is that no path can forget to report it —
    # a graceful degrade answers ok=true with the field simply absent, which is
    # exactly the shape that made the failure invisible in the first place.
    # Absent when nothing has failed, so the common wire is byte-identical.
    lost = capability_loss()
    if lost:
        obj = {**obj, "capability_loss": lost}
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(msg):
    sys.stderr.write(f"[analyze-worker] {msg}\n")
    sys.stderr.flush()


# --- Decoder log noise (issue #1300, bug 16a) -------------------------------
# Normal-operation output from the decode stack reads like corruption and is
# the single largest source of "is my library broken?" reports:
#
#   [src/libmpg123/parse.c:wetwork():1349] error: Giving up resync after 1024 bytes
#   Note: Illegal Audio-MPEG-Header 0x00000000 at offset 12345
#   Warning: Xing stream size off by more than 1%
#   UserWarning: PySoundFile failed. Trying audioread instead.
#
# None of it affects the result — libmpg123 (inside libsndfile) narrates its
# resync over ID3 padding on perfectly good MP3s, and librosa narrates its own
# fallback. Two different channels, so two different mechanisms:
#
#   * The librosa/soundfile ones are Python `warnings` → filtered at source.
#   * The libmpg123 ones are written to fd 2 by C code, which never passes
#     through sys.stderr. Those need the fd captured across the decode and
#     replayed minus the known-benign lines (see quiet_decoder_noise) — the
#     filtering is deliberately a REPLAY, not a discard, so an unrecognised
#     line still reaches the log rather than being silently eaten.
#
# ANALYZE_VERBOSE_DECODER=1 turns both off and restores the raw firehose.
VERBOSE_DECODER = os.environ.get("ANALYZE_VERBOSE_DECODER", "").strip().lower() in (
    "1", "true", "yes",
)

# libmpg123 prefixes its lines with the C source position that emitted them:
#
#   [src/libmpg123/parse.c:wetwork():1349] error: Giving up resync after 1024 bytes
#
# That header says WHO is talking, never WHAT about — so it is stripped, not
# matched. Keying on the header alone would drop every libmpg123 line including
# the ones nobody has seen yet, which is precisely the discard this filter is
# built to avoid: the point of replaying is that an unrecognised line survives.
_LIBMPG123_HEADER_RE = re.compile(
    r"^\[src/libmpg123/[^\]]*\]\s*(?:error|warning|note|debug)\s*:\s*", re.IGNORECASE
)

# Benign decoder chatter, matched against the MESSAGE (header already stripped)
# and anchored tightly enough that a real decode error still gets through:
# "giving up resync" mid-file is narration, "cannot open" / "invalid data" is
# not. Matched case-insensitively against one whole line. The `note:`/`warning:`
# prefixes are optional because libsndfile emits some of these bare.
_LEVEL = r"(?:note|warning|error)\s*:\s*"
_DECODER_NOISE_PATTERNS = [
    rf"^(?:{_LEVEL})?giving up resync",        # resync over ID3 padding
    rf"^(?:{_LEVEL})?no comment text",         # empty ID3 comment frame
    rf"^(?:{_LEVEL})?illegal audio-mpeg-header",  # junk bytes before frame one
    rf"^(?:{_LEVEL})?xing stream size off",    # VBR header vs actual size
    rf"^(?:{_LEVEL})?skipped \d+ bytes",       # ID3 / padding skip
    rf"^(?:{_LEVEL})?junk at the beginning",   # ditto, older libmpg123 wording
    r"pysoundfile failed\. trying audioread",
    r"deprecated as of librosa version",
    r"librosa will remove support for .*audioread",
    # A Python warning header from the decode stack. Deliberately requires the
    # MESSAGE to name the fallback too, not just the module: `librosa/....py:N:
    # SomeWarning` on its own also carries things worth reading (an n_fft wider
    # than the signal is how a truncated file announces itself), and swallowing
    # those is the over-match that costs an operator their only evidence.
    # warnings.filterwarnings below normally stops these at source; this catches
    # the ones raised before the filters are installed, or by a child that
    # doesn't inherit them.
    r"^\S*(?:librosa|soundfile|audioread)\S*\.py:\d+:\s+\w*warning:.*"
    r"(?:audioread|pysoundfile|soundfile)",
]
_DECODER_NOISE_RE = re.compile("|".join(_DECODER_NOISE_PATTERNS), re.IGNORECASE)


def is_decoder_noise(line):
    """Whether one stderr line is known-benign decode narration.

    Pure and unit-pinned (scripts/analyzer_noise_test.py) because the cost of
    getting it wrong is asymmetric: a missed pattern is cosmetic, a pattern that
    over-matches swallows the decode error an operator needs to see. So the
    match is always against the MESSAGE — a libmpg123 line whose text we don't
    recognise is kept, header and all.
    """
    text = (line or "").strip()
    if not text:
        return True
    text = _LIBMPG123_HEADER_RE.sub("", text, count=1)
    return _DECODER_NOISE_RE.search(text) is not None


@contextlib.contextmanager
def quiet_decoder_noise():
    """Capture fd 2 for the duration of a decode, then replay it minus the noise.

    Scoped as tightly as possible — around the decode call itself, never around
    a whole request — so the worker's own progress logging is not held back
    behind a multi-minute Demucs pass. A log line from the idle-release thread
    landing inside the window is replayed on the way out (order shifts by the
    length of one decode; nothing is lost).

    Degrades to a plain pass-through if fd 2 can't be duplicated — some hosts
    run the worker with stderr closed, and a decode is not worth failing over.
    """
    if VERBOSE_DECODER:
        yield
        return
    try:
        saved = os.dup(2)
    except OSError:
        yield
        return
    try:
        sink = tempfile.TemporaryFile()
    except OSError:
        # No writable temp — nothing to capture into. Give fd 2 straight back
        # rather than leaking the dup, and let the noise through.
        os.close(saved)
        yield
        return
    try:
        sys.stderr.flush()
        os.dup2(sink.fileno(), 2)
        yield
    finally:
        try:
            sys.stderr.flush()
        except Exception:  # noqa: BLE001 — restoring fd 2 matters more
            pass
        os.dup2(saved, 2)
        os.close(saved)
        try:
            sink.seek(0)
            captured = sink.read().decode("utf-8", "replace")
        except Exception:  # noqa: BLE001 — never fail a decode over its log
            captured = ""
        sink.close()
        kept = [ln for ln in captured.splitlines() if not is_decoder_noise(ln)]
        if kept:
            sys.stderr.write("\n".join(kept) + "\n")
            sys.stderr.flush()


def load_audio(librosa, *args, **kwargs):
    """librosa.load with the decode stack's benign chatter filtered out."""
    with quiet_decoder_noise():
        return librosa.load(*args, **kwargs)


if not VERBOSE_DECODER:
    # The Python-warning half. librosa raises both of these on files that
    # analyse perfectly well — the soundfile→audioread fallback notice and the
    # deprecation that rides with it — once per load, i.e. up to six times per
    # track. ensure_fast_decode already removes the CAUSE where ffmpeg exists;
    # this quiets the narration where it doesn't.
    warnings.filterwarnings("ignore", message=r".*PySoundFile failed.*")
    warnings.filterwarnings("ignore", message=r".*audioread.*", category=FutureWarning)
    warnings.filterwarnings("ignore", category=FutureWarning, module="librosa")


# Model weights the heavy tier fetches on first use. Named here so a failed
# load can say WHICH download died rather than echoing a bare urllib traceback.
_WEIGHT_HOST_HINTS = ("huggingface.co", "hf.co", "hf-mirror", "cdn-lfs")


def summarize_load_error(ex):
    """One short, actionable line for a CLAP/Demucs load failure.

    This is the text an operator eventually reads in the admin panel, so the
    common cause gets named outright: the heavy images do NOT bake the weights
    (docker/Dockerfile.analyzer), they download them into HF_HOME on first use,
    and a box with no outbound reach fails there forever. Anything else is
    passed through truncated — a wrong-but-specific reason beats a generic one.
    """
    text = f"{ex}".strip() or type(ex).__name__
    lowered = text.lower()
    offline = any(h in lowered for h in _WEIGHT_HOST_HINTS) or any(
        s in lowered
        for s in ("connection refused", "temporary failure in name resolution",
                  "max retries exceeded", "offlinemodeisenabled", "couldn't connect")
    )
    if offline:
        return (
            "model weights could not be downloaded (the heavy analyzer fetches them "
            f"from huggingface.co on first use and this host has no reach): {text[:200]}"
        )
    return text[:240]


def capability_loss():
    """Capabilities this worker advertised at ready but has since LOST.

    The ready line's probe is `find_spec`, i.e. "are the libraries installed" —
    it runs before any model has been asked to load, so a heavy image whose
    weight download fails reports capable=true forever. Riding the real reason
    back on every response is what lets the caller correct that, and the caller
    (docker/analyzer/server.py) is what makes it survive a worker respawn:
    _embed_failed lives in THIS process, and the sidecar's idle recycle starts a
    new one. Empty dict = nothing lost, the overwhelmingly common case.
    """
    lost = {}
    if _embed_failed:
        lost["audio_embedding"] = _embed_error or "CLAP load failed"
    if _vocal_failed:
        lost["vocal_activity"] = _vocal_error or "Demucs load failed"
    return lost


# --- Torch device for the heavy models (CLAP / Demucs) ----------------------
# ANALYZE_DEVICE ∈ auto (default) | cpu | cuda. `auto` picks cuda when torch
# actually sees a GPU (the subwave-analyzer-cuda flavour on an NVIDIA host)
# and cpu everywhere else — on the cpu-wheel images torch.cuda.is_available()
# is always False, so existing installs behave exactly as before. A cuda
# request without a visible GPU warns and falls back to cpu: device selection
# must never fail an analysis pass. The torch import stays lazy — only the
# heavy code paths call this, so the librosa-only venv never needs torch.
_DEVICE = None


def resolve_device():
    global _DEVICE
    if _DEVICE is not None:
        return _DEVICE
    import torch

    want = os.environ.get("ANALYZE_DEVICE", "").strip().lower() or "auto"
    if want not in ("auto", "cpu", "cuda"):
        log(f"ANALYZE_DEVICE={want} not recognised (auto|cpu|cuda); using auto")
        want = "auto"
    if want != "cpu" and torch.cuda.is_available():
        _DEVICE = "cuda"
        log(f"analysis device: cuda ({torch.cuda.get_device_name(0)})")
    else:
        if want == "cuda":
            log(
                "ANALYZE_DEVICE=cuda but torch sees no CUDA device "
                "(cpu-only wheels, no GPU exposed to the container, or missing "
                "nvidia-container-toolkit); falling back to cpu"
            )
        _DEVICE = "cpu"
        log("analysis device: cpu")
    return _DEVICE


# --- Idle model release (#1099 follow-up; CPU arming per #1204) -------------
# The resident CLAP + Demucs models hold multiple GB even when no analysis is
# running. A daemon thread drops the model singletons after the idle window
# passes with no HEAVY use (0 disables); the next request lazy-reloads from the
# on-disk HF / torch-hub cache.
#
# On cuda that starves co-resident GPU work (a local TTS/LLM on the same card
# OOMed hours after a pass finished). On cpu it looked free — "system RAM is
# cheap" — but #1204 showed otherwise: one admin backfill (or a stem-cache
# pass, or a single sound search) force-loads both models into the long-lived
# worker regardless of this process's env defaults, nothing ever releases them,
# and on a small host the kernel eventually parks ~1.5GB of cold weights in
# swap indefinitely. So the thread arms on both devices now.
#
# The window is device-aware: cuda keeps 300s (VRAM contention is urgent and a
# GPU reload is fast), cpu defaults longer because a cold CPU reload is seconds
# of latency that lands on interactive callers (analyzer.embedTexts gives sound
# search a 20s deadline), and swap pressure is not urgent the way a starved GPU
# is. ANALYZE_IDLE_UNLOAD_S overrides both. NOTE: torch's imported modules (and
# on cuda its context) survive until the process exits — a few hundred MB stays
# resident either way; stopping the analyzer container is the full release.
IDLE_UNLOAD_CUDA_S = 300.0
IDLE_UNLOAD_CPU_S = 1800.0
_IDLE_UNLOAD_ENV = os.environ.get("ANALYZE_IDLE_UNLOAD_S", "").strip()

# Heavy-model clock, deliberately NOT a general request clock. A lean
# bpm/key/loudness request touches no model, so letting it refresh this would
# pin CLAP + Demucs in memory forever on any station with steady analysis
# traffic — the release would only ever fire on an idle box (#1204). Only an
# actual embedder / detector use moves it. `_model_lock` (held across request
# handling AND unload) is what keeps a release from racing a request in flight.
_heavy_last_used = time.time()
_model_lock = threading.Lock()  # held during request handling AND unload
_idle_thread_started = False


def _touch_heavy():
    """Mark CLAP/Demucs as just used — resets the idle-release countdown."""
    global _heavy_last_used
    _heavy_last_used = time.time()


def _idle_unload_seconds():
    """Resolve the idle window. Called only from the arming path, never at
    import: the default depends on the device, and resolve_device() imports
    torch — which the lean librosa-only venv doesn't have."""
    if _IDLE_UNLOAD_ENV:
        try:
            return float(_IDLE_UNLOAD_ENV)
        except ValueError:
            log(
                f"ANALYZE_IDLE_UNLOAD_S={_IDLE_UNLOAD_ENV!r} is not a number; "
                "using the per-device default"
            )
    return IDLE_UNLOAD_CUDA_S if resolve_device() == "cuda" else IDLE_UNLOAD_CPU_S


def _release_models(idle_s=None):
    """Drop the loaded model singletons and hand their memory back. Leaves the
    *_failed flags alone, so the next request reloads instead of no-opping."""
    global _embedder, _vocal_detector
    import gc

    freed = []
    if _embedder is not None:
        _embedder = None
        freed.append("CLAP")
    if _vocal_detector is not None:
        _vocal_detector = None
        freed.append("Demucs")
    if not freed:
        return
    gc.collect()
    where = "system memory"
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            where = "GPU memory"
    except Exception:  # noqa: BLE001 — freeing is best-effort
        pass
    # Hand the freed tensor heap back to the OS. gc.collect() returns it to
    # glibc's arenas, which keeps it as cold anonymous pages the kernel then
    # swaps out — exactly the 1.5GB #1204 measured. malloc_trim releases the
    # trimmable top of those arenas instead. No-op (and harmless) off glibc.
    try:
        ctypes.CDLL(None).malloc_trim(0)
    except Exception:  # noqa: BLE001 — best-effort, absent on musl/macOS
        pass
    idle_note = f"idle {int(idle_s)}s — " if idle_s else ""
    # The sidecar's /health residency tracking matches this line on the
    # worker's stderr ("released" + "reloads on next use" — see
    # docker/analyzer/server.py _pump_stderr); keep the wording in sync.
    log(
        f"{idle_note}released {' + '.join(freed)} from {where} "
        "(reloads on next use)"
    )


def _idle_release_loop(idle_s):
    while True:
        time.sleep(30)
        if time.time() - _heavy_last_used < idle_s:
            continue
        with _model_lock:
            # Re-check under the lock: a request may have landed while we
            # waited to acquire it (a slow track holds the lock for minutes).
            if time.time() - _heavy_last_used >= idle_s:
                _release_models(idle_s)


def _maybe_start_idle_release():
    """Arm the idle-release thread — once, on either device (unload enabled).
    Called after a heavy model actually loads."""
    global _idle_thread_started
    if _idle_thread_started:
        return
    idle_s = _idle_unload_seconds()
    if idle_s <= 0:
        return
    _idle_thread_started = True
    threading.Thread(
        target=_idle_release_loop, args=(idle_s,), daemon=True, name="idle-release"
    ).start()
    log(f"idle model release armed — models unload after {int(idle_s)}s without heavy use")


def _pearson(a, b):
    n = len(a)
    ma = sum(a) / n
    mb = sum(b) / n
    num = sum((a[i] - ma) * (b[i] - mb) for i in range(n))
    da = sum((a[i] - ma) ** 2 for i in range(n)) ** 0.5
    db = sum((b[i] - mb) ** 2 for i in range(n)) ** 0.5
    if da == 0 or db == 0:
        return 0.0
    return num / (da * db)


# Enharmonic-preserving spelling isn't recoverable from chroma; use sharps.
PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def _score_key(chroma_vec):
    """Krumhansl-Schmuckler over all 24 keys for one chroma vector. Returns
    (camelot_code, separation, tonic_pc, mode) — separation (best - 2nd best
    correlation, 0..1-ish) is a rough confidence; mode is 'major'/'minor'."""
    scores = []  # (corr, camelot, tonic_pc, mode)
    for tonic in range(12):
        rotated = [chroma_vec[(tonic + i) % 12] for i in range(12)]
        scores.append((_pearson(MAJOR_PROFILE, rotated), MAJOR_CAMELOT[tonic], tonic, "major"))
        scores.append((_pearson(MINOR_PROFILE, rotated), MINOR_CAMELOT[tonic], tonic, "minor"))
    scores.sort(reverse=True, key=lambda s: s[0])
    best_corr, best_code, tonic_pc, mode = scores[0]
    separation = max(0.0, min(1.0, best_corr - scores[1][0]))
    return best_code, separation, tonic_pc, mode


def estimate_key(chroma_mean):
    """Whole-window key as (camelot_code, separation), for the scalar field."""
    code, separation, _tonic, _mode = _score_key(chroma_mean)
    return code, separation


def estimate_key_ranges(chroma, sr, librosa, window_s=10.0):
    """Per-region key (tonic + mode) over time. Windows the already-computed
    chroma (~window_s each), scores
    each, and merges adjacent windows sharing a key. Returns
    [{startMs,endMs,tonic,mode}] or None. Best-effort: any failure → None."""
    import numpy as np

    try:
        hop = 512
        n_frames = chroma.shape[1]
        if n_frames < 8:
            return None
        frames_per_win = max(1, int(round(window_s * sr / hop)))
        ranges = []
        for start in range(0, n_frames, frames_per_win):
            chunk = chroma[:, start : start + frames_per_win]
            if chunk.shape[1] == 0:
                continue
            vec = [float(x) for x in np.mean(chunk, axis=1)]
            _code, _sep, tonic_pc, mode = _score_key(vec)
            tonic = PITCH_NAMES[tonic_pc]
            start_ms = int(round(start * hop / sr * 1000.0))
            end_ms = int(round(min(start + frames_per_win, n_frames) * hop / sr * 1000.0))
            if end_ms <= start_ms:
                continue
            if ranges and ranges[-1]["tonic"] == tonic and ranges[-1]["mode"] == mode:
                ranges[-1]["endMs"] = end_ms  # merge a run of the same key
            else:
                ranges.append({"startMs": start_ms, "endMs": end_ms, "tonic": tonic, "mode": mode})
        return ranges or None
    except Exception as e:  # noqa: BLE001 — key ranges are best-effort
        log(f"key-range estimation failed: {e}")
        return None


def silence_edges_ms(y, sr):
    """(lead_ms, tail_ms, tail_start_ms) of near-silence at the edges of the
    decoded buffer `y`, measured against the ABSOLUTE SILENCE_DBFS floor.

    `tail_start_ms` is where the trailing gap OPENS, as an offset into this
    buffer — the caller adds the buffer's own position in the file to make it
    absolute. It exists because the gap LENGTH alone can only become a cue
    point by subtracting from a duration, and the only duration the controller
    has is the container tag, which disagrees with the decoded file often
    enough (VBR headers) to move the cut by that difference.

    Returns (None, None, None) when NO frame in the buffer clears the floor: a
    window with nothing audible in it cannot say where the gap ends, only that
    it outlasts the window, and a guess there would cut real audio. Callers
    treat None as "no signal, behave as today"."""
    import numpy as np

    if y is None or np.size(y) == 0 or not sr:
        return (None, None, None)
    y = np.asarray(y)
    if y.ndim > 1:
        y = np.max(np.abs(y), axis=0)
    n = int(y.size)
    frame, hop = 2048, 512
    # Frame-wise PEAK, not RMS: a 2048-sample RMS window straddling the first
    # transient averages it away and reads the attack as still-silent, which
    # would trim the head of the note we are trying to preserve.
    #
    # The stride runs to `n`, not to the last WHOLE frame: numpy clamps the
    # short final slices. Stopping at `n - frame + 1` leaves up to hop-1
    # samples at the very end unexamined (~23ms at 22.05 kHz) — small, but it
    # is signal read as gap, i.e. an error in the one direction that CUTS
    # audio, and the tail is the edge where a wrong cue point costs a song's
    # ending rather than its first note.
    starts = np.arange(0, max(1, n), hop)
    peaks = np.array([float(np.max(np.abs(y[s : s + frame]))) for s in starts])
    thr = 10.0 ** (SILENCE_DBFS / 20.0)
    loud = np.nonzero(peaks >= thr)[0]
    if loud.size == 0:
        return (None, None, None)
    lead_ms = float(starts[int(loud[0])]) / float(sr) * 1000.0
    # The tail gap opens at the END of the last audible frame, not its start.
    last_end = min(n, int(starts[int(loud[-1])]) + frame)
    tail_ms = float(n - last_end) / float(sr) * 1000.0
    tail_start_ms = float(last_end) / float(sr) * 1000.0
    return (max(0.0, lead_ms), max(0.0, tail_ms), max(0.0, tail_start_ms))


def estimate_intro_ms(y, sr, librosa):
    """Rough intro length: the first time the short-term energy rises and stays
    above a fraction of the track's typical loud level — i.e. where the track
    'comes in' after any quiet count-in. This is an energy heuristic, NOT true
    vocal-onset detection, so callers treat it as a soft budget, never a gate."""
    import numpy as np

    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=512)[0]
    if rms.size == 0:
        return None
    loud = float(np.percentile(rms, 80))
    if loud <= 0:
        return None
    threshold = 0.30 * loud
    times = librosa.frames_to_time(np.arange(rms.size), sr=sr, hop_length=512)
    # First frame that crosses the threshold and stays above it for ~0.5s.
    sustain_frames = max(1, int(0.5 * sr / 512))
    for i in range(rms.size):
        if rms[i] >= threshold:
            window = rms[i : i + sustain_frames]
            if window.size and float(np.mean(window)) >= threshold:
                return max(0.0, float(times[i]) * 1000.0)
    return 0.0


def estimate_sections(y, sr, librosa, chroma=None):
    """Coarse structural segmentation over the DECODED window (the first
    ANALYZE_SECONDS only — so this is reliable for the intro / leading sections,
    not a full-song outro). librosa agglomerative clustering on a chroma+MFCC
    feature stack → a handful of contiguous {startMs,endMs} spans. Best-effort:
    any failure returns None and the field is omitted, so a
    consumer treats absence as 'no structure, behave as today'. `chroma` may be
    passed in to avoid recomputing the (expensive) CQT done in analyze()."""
    import numpy as np

    try:
        hop = 512  # librosa default for chroma_cqt / mfcc; ties frames→time
        if chroma is None:
            chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=hop)
        mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13, hop_length=hop)
        # Trim to a common frame count (CQT vs mel framing can differ by one).
        n_frames = min(chroma.shape[1], mfcc.shape[1])
        if n_frames < 8:
            return None
        feat = np.vstack([
            librosa.util.normalize(chroma[:, :n_frames], axis=0),
            librosa.util.normalize(mfcc[:, :n_frames], axis=0),
        ])
        dur_s = n_frames * hop / sr
        # ~1 section per 15s of decoded audio, clamped to a sane 2..8.
        k = int(max(2, min(8, round(dur_s / 15.0))))
        if k >= n_frames:
            return None
        # Left-boundary frames of each segment; always includes 0.
        bounds = librosa.segment.agglomerative(feat, k)
        times = librosa.frames_to_time(bounds, sr=sr, hop_length=hop)
        edges = [float(t) for t in times] + [dur_s]
        sections = []
        for i in range(len(edges) - 1):
            start_ms = int(round(edges[i] * 1000.0))
            end_ms = int(round(edges[i + 1] * 1000.0))
            if end_ms > start_ms:
                sections.append({"startMs": start_ms, "endMs": end_ms})
        return sections or None
    except Exception as e:  # noqa: BLE001 — structure is best-effort
        log(f"structure segmentation failed: {e}")
        return None


# ---------------------------------------------------------------------------
# CLAP embedder — two backends, decided at load time:
#   * ONNX (lean): CLAP_MODEL_PATH points at an exported audio-encoder .onnx;
#     run via onnxruntime. Feature extraction still goes through transformers'
#     ClapProcessor so the mel preprocessing is exactly what CLAP expects (the
#     genuinely fiddly part), regardless of how the encoder runs.
#   * transformers (fallback): no .onnx → load the full ClapModel from a HF id
#     (CLAP_MODEL, default laion/clap-htsat-unfused) and call get_audio_features.
# Both produce the same 512-d L2-normalised vector. All heavy imports are lazy
# so a worker with embeddings DISABLED never needs torch/transformers/onnx and
# the librosa-only venv keeps working.
# ---------------------------------------------------------------------------
def clap_batch_enabled(mode, device):
    """Only the published CUDA transformers path benefits from window batching.

    CPU torch keeps the old one-window memory envelope, and arbitrary ONNX
    exports may not have a dynamic batch axis.
    """
    return mode == "transformers" and device == "cuda"


class ClapEmbedder:
    def __init__(self):
        self.mode = None
        self.processor = None
        self.session = None   # onnx
        self.input_name = None
        self.model = None     # transformers
        self.text_model = None  # lazy text tower for onnx mode

    def load(self):
        from transformers import ClapProcessor

        # Empty strings count as unset — the compose files pass these through
        # as `${CLAP_MODEL:-}` etc., which exports "" when the operator hasn't
        # set them in the root .env.
        onnx_path = os.environ.get("CLAP_MODEL_PATH", "").strip()
        hf_id = os.environ.get("CLAP_MODEL", "").strip() or "laion/clap-htsat-unfused"
        # The processor (feature extraction) is keyed to a HF model; default to
        # the same id as the encoder, override with CLAP_FEATURE_MODEL when the
        # .onnx was exported from a differently-named checkpoint.
        feat_id = os.environ.get("CLAP_FEATURE_MODEL", "").strip() or hf_id

        if onnx_path and os.path.exists(onnx_path):
            import onnxruntime as ort

            self.processor = ClapProcessor.from_pretrained(feat_id)
            self.session = ort.InferenceSession(
                onnx_path, providers=["CPUExecutionProvider"]
            )
            self.input_name = self.session.get_inputs()[0].name
            self.mode = "onnx"
            log(f"CLAP onnx encoder loaded: {onnx_path} (features: {feat_id})")
        else:
            if onnx_path:
                log(f"CLAP_MODEL_PATH set but missing ({onnx_path}); using transformers")
            from transformers import ClapModel

            self.model = ClapModel.from_pretrained(hf_id)
            self.model.eval()
            self.model.to(resolve_device())
            self.processor = ClapProcessor.from_pretrained(hf_id)
            self.mode = "transformers"
            log(f"CLAP transformers model loaded: {hf_id}")

    def _embed_onnx(self, y48, sr):
        import numpy as np

        # transformers renamed the ClapProcessor audio kwarg `audios` → `audio`
        # and turned the old name into a hard error (not just a warning) in
        # recent releases. Try the new name, fall back to the old one so this
        # works against whatever transformers the analyzer venv resolved.
        try:
            inputs = self.processor(
                audio=y48, sampling_rate=sr, return_tensors="np"
            )
        except (TypeError, ValueError):
            inputs = self.processor(
                audios=y48, sampling_rate=sr, return_tensors="np"
            )
        feats = inputs["input_features"]
        feats_np = np.asarray(feats, dtype=np.float32)
        out = self.session.run(None, {self.input_name: feats_np})
        return np.asarray(out[0]).reshape(-1)

    @staticmethod
    def _normalise(vec):
        import numpy as np

        if vec.shape[0] != CLAP_EMBED_DIM:
            raise RuntimeError(
                f"unexpected CLAP embedding dim {vec.shape[0]} (want {CLAP_EMBED_DIM})"
            )
        # L2-normalise so the vec0 table's cosine distance is well-conditioned.
        norm = float(np.linalg.norm(vec))
        if norm > 0:
            vec = vec / norm
        return [float(x) for x in vec]

    def _embed_transformers(self, windows, sr):
        import numpy as np
        import torch

        audio = list(windows)
        try:
            inputs = self.processor(
                audio=audio, sampling_rate=sr, return_tensors="pt"
            )
        except (TypeError, ValueError):
            inputs = self.processor(
                audios=audio, sampling_rate=sr, return_tensors="pt"
            )
        feats = inputs["input_features"].to(resolve_device())
        with torch.no_grad():
            emb = self.model.get_audio_features(input_features=feats)
        # transformers ≤4.x returns the projected tensor directly; 5.x wraps
        # it in BaseModelOutputWithPooling.
        if hasattr(emb, "pooler_output"):
            emb = emb.pooler_output
        rows = np.asarray(emb.cpu().numpy())
        if rows.ndim == 1:
            rows = rows.reshape(1, -1)
        if rows.shape[0] != len(audio):
            raise RuntimeError(
                f"unexpected CLAP embedding batch {rows.shape[0]} (want {len(audio)})"
            )
        return [self._normalise(row) for row in rows]

    def embed_many(self, windows, sr):
        """Embed one track's windows, batching only the CUDA model forward."""
        if not windows:
            return []
        if self.mode == "onnx":
            return [self._normalise(self._embed_onnx(window, sr)) for window in windows]
        if not self.batches_windows():
            return [self._embed_transformers([window], sr)[0] for window in windows]
        try:
            return self._embed_transformers(windows, sr)
        except Exception as ex:  # noqa: BLE001 - preserve the old memory envelope
            log(f"CLAP window batch failed ({ex}); retrying sequentially")
            try:
                import torch

                torch.cuda.empty_cache()
            except Exception:  # noqa: BLE001 - cache release is best-effort
                pass
            return [self._embed_transformers([window], sr)[0] for window in windows]

    def batches_windows(self):
        """Whether decoded windows should be retained for one model batch."""
        return self.mode == "transformers" and clap_batch_enabled(
            self.mode, resolve_device()
        )

    def embed(self, y48, sr):
        """Compatibility surface for callers that genuinely have one window."""
        return self.embed_many([y48], sr)[0]

    def _resolve_text_model(self):
        """The CLAP text tower. In transformers mode it's the loaded ClapModel;
        in onnx mode the on-disk export is the AUDIO encoder only, so the text
        tower is lazily loaded via ClapTextModelWithProjection (torch required
        — a lean venv without torch raises here and the caller degrades)."""
        if self.mode == "transformers":
            return self.model
        if self.text_model is None:
            from transformers import ClapTextModelWithProjection

            hf_id = os.environ.get("CLAP_MODEL", "").strip() or "laion/clap-htsat-unfused"
            feat_id = os.environ.get("CLAP_FEATURE_MODEL", "").strip() or hf_id
            m = ClapTextModelWithProjection.from_pretrained(feat_id)
            m.eval()
            m.to(resolve_device())
            self.text_model = m
            log(f"CLAP text tower loaded: {feat_id}")
        return self.text_model

    def embed_texts(self, texts):
        """CLAP text-tower embeddings — 512-d, L2-normalised, in the SAME space
        as the audio vectors (CLAP is trained contrastively on audio–text
        pairs), so cosine against stored audio vectors is meaningful. Powers
        natural-language "sounds like ..." search and zero-shot mood scoring."""
        import numpy as np
        import torch

        model = self._resolve_text_model()
        inputs = self.processor(text=list(texts), return_tensors="pt", padding=True)
        inputs = inputs.to(resolve_device())
        with torch.no_grad():
            emb = model.get_text_features(**inputs) if hasattr(model, "get_text_features") \
                else model(**inputs)
        # transformers ≤4.x returns the projected tensor directly; 5.x wraps it
        # (text_embeds on the projection model, pooler_output on ClapModel).
        if hasattr(emb, "text_embeds"):
            emb = emb.text_embeds
        elif hasattr(emb, "pooler_output"):
            emb = emb.pooler_output
        arr = np.asarray(emb.cpu().numpy(), dtype=np.float64)
        if arr.ndim == 1:
            arr = arr.reshape(1, -1)
        if arr.shape[1] != CLAP_EMBED_DIM:
            raise RuntimeError(
                f"unexpected CLAP text embedding dim {arr.shape[1]} (want {CLAP_EMBED_DIM})"
            )
        out = []
        for row in arr:
            n = float(np.linalg.norm(row))
            out.append([float(x) for x in (row / n if n > 0 else row)])
        return out


def clap_window_offsets(duration_s, window_s, max_windows=None):
    """Start offsets (seconds) of the CLAP embed windows. Short tracks keep the
    single leading window; longer tracks add a mid-song window, and genuinely
    long ones a late (~80%) window, so the vector reflects the whole track.
    `max_windows` (default CLAP_WINDOWS / ANALYZE_CLAP_WINDOWS, clamped 1..3)
    caps the count — 1 restores the old leading-window-only behaviour."""
    n = CLAP_WINDOWS if max_windows is None else max_windows
    n = max(1, min(3, n))
    if n == 1 or not duration_s or duration_s <= window_s * 1.5:
        return [0.0]
    span = duration_s - window_s
    offsets = [0.0, span * 0.5]
    if n >= 3 and duration_s >= window_s * 3.0:
        offsets.append(span * 0.8)
    return offsets


def embed_windows(embedder, path, librosa, duration_s):
    """CLAP embedding averaged over up to three windows spread across the track
    (start / middle / late), mean + L2-renormalised. A single leading window
    misrepresents any track whose intro doesn't sound like the song (a quiet
    build-up embeds as ambient); averaging windows fixes that with the same
    model, dim and storage schema. The local file may be byte-capped
    (fetch_audio / the controller's downloadCapped truncate), so its real
    decodable length can be shorter than the header duration — a non-leading
    window that decodes to under ~5s is skipped, and the worst case degrades to
    exactly the old leading-window behaviour. `duration_s` is the caller's
    header-duration probe (0.0 = unknown → leading window only)."""
    import numpy as np

    batch_windows = embedder.batches_windows()
    windows = []
    vecs = []
    for offset in clap_window_offsets(duration_s, ANALYZE_SECONDS):
        try:
            y48, _sr48 = load_audio(
                librosa, path, sr=CLAP_SR, mono=True, offset=offset, duration=ANALYZE_SECONDS
            )
        except Exception as e:  # noqa: BLE001 — a bad window never kills the embed
            log(f"CLAP window decode at {offset:.0f}s failed: {e}")
            continue
        if y48 is None or len(y48) == 0:
            continue
        if offset > 0 and len(y48) < CLAP_SR * 5:
            continue  # truncated tail of a byte-capped download
        if batch_windows:
            windows.append(y48)
        else:
            # Preserve the CPU/ONNX one-window memory envelope: decode, embed,
            # and release each window before moving to the next offset.
            vecs.append(np.asarray(embedder.embed(y48, CLAP_SR), dtype=np.float64))
    if batch_windows:
        vecs = [
            np.asarray(vec, dtype=np.float64)
            for vec in embedder.embed_many(windows, CLAP_SR)
        ]
    if not vecs:
        return None
    mean = np.mean(vecs, axis=0)
    norm = float(np.linalg.norm(mean))
    if norm > 0:
        mean = mean / norm
    return [float(x) for x in mean]


def analyze_outro(path, librosa, duration_s, complete=None):
    """Tail features for the crossfade seam — the outgoing track's ending is
    what actually decides whether a transition lands. Decodes the last
    OUTRO_SECONDS and returns
      {startMs, ending: 'fade'|'cold', lufs?, bpm?, beats?, bars?}
    with all timestamps ABSOLUTE (offset by the tail's position), or None when
    the tail decodes short (a truncated file's "tail" is mid-song audio — never
    emit features measured off the wrong region).

    A track too short for a distinct outro returns only the edge-silence
    fields, and only when `complete` is True — see the gate below.
    Pure librosa (+ optional pyloudnorm), so this runs on the LEAN tier too."""
    import numpy as np

    if not duration_s:
        return None
    distinct_outro = duration_s > OUTRO_SECONDS + 1.0
    # The short-track path reads the tail off a decode that starts at ZERO, so
    # the short-decode backstop below cannot prove completeness the way it does
    # for a real tail window: there, the seek to duration-20s is itself the
    # proof (a truncated file cannot reach it), while from offset 0 a file
    # truncated to 70% decodes 70% and passes. Nothing but the caller's own
    # completeness flag can settle it, so a short track with an UNKNOWN
    # completeness is skipped rather than measured mid-song — and skipped
    # BEFORE the decode, which is also the full-file decode this path would
    # otherwise pay for on every short track that previously returned here.
    if not distinct_outro and complete is not True:
        return None
    offset = max(0.0, duration_s - OUTRO_SECONDS) if distinct_outro else 0.0
    # Channel-preserving decode for the loudness meter (the tail LUFS must be
    # comparable to the body's stereo loudness_lufs — issue #998); RMS shape
    # and the beat grid work off the mono downmix as before.
    y_src, sr = load_audio(librosa, path, sr=ANALYZE_SR, mono=False, offset=offset)
    y = librosa.to_mono(y_src) if y_src is not None else None
    # Validation backstop for an unknown completeness: a truncated file either
    # errors here or decodes well short of the requested tail — skip it.
    expected_s = min(OUTRO_SECONDS, duration_s)
    if y is None or len(y) < ANALYZE_SR * expected_s * 0.6:
        return None

    # A short track has no distinct musical outro to characterize, but a
    # COMPLETE file still exposes its real tail. Return only that independent
    # edge measurement; analyze() lifts it to the top-level result and then
    # discards the empty outro shell.
    if not distinct_outro:
        _lead_t, tail_silence_ms, tail_start_ms = silence_edges_ms(y, sr)
        if tail_silence_ms is None:
            return None
        return {
            "tail_silence_ms": int(round(tail_silence_ms)),
            # offset is 0.0 here, so the buffer offset IS the file offset.
            "tail_start_ms": int(round(offset * 1000.0 + tail_start_ms)),
        }

    hop = 512
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=hop)[0]
    if rms.size == 0:
        return None
    loud = float(np.percentile(rms, 95))
    if loud <= 0:
        return None
    times = librosa.frames_to_time(np.arange(rms.size), sr=sr, hop_length=hop)

    # Wind-down start: the LAST time the tail sits at full level (≥60% of its
    # own loud reference) — everything after it is the ending. A tail that
    # holds level to the end winds down at the very end (cold).
    thr_hi = 0.6 * loud
    last_loud = None
    for i in range(rms.size - 1, -1, -1):
        if rms[i] >= thr_hi:
            last_loud = i
            break
    wind_start_s = offset if last_loud is None else offset + float(times[last_loud])
    wind_span_s = max(0.0, duration_s - wind_start_s)

    # Ending type: a fade lands near-silent (final ~1.5s well below the tail's
    # loud level) after a real decline (≥3s wind-down); everything else — a hit,
    # a ring-out, a hard stop — reads as cold for transition purposes.
    tail_frames = max(1, int(1.5 * sr / hop))
    end_level = float(np.mean(rms[-tail_frames:]))
    ending = "fade" if (end_level < 0.15 * loud and wind_span_s >= 3.0) else "cold"

    # Tail loudness — comparable to the track's loudness_lufs, so consumers can
    # judge how hot the material under the next intro will actually be.
    lufs, _peak = measure_loudness(y_src, sr)

    # Tail tempo + grid (absolute ms) — the truer anchor for bar-aligning the
    # exit than the leading window's tempo (outros drift/ritard).
    bpm_t = None
    beats_ms = []
    bars_ms = []
    try:
        tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
        t = float(np.atleast_1d(tempo)[0])
        bpm_t = round(t, 1) if 30 <= t <= 300 else None
        bt = librosa.frames_to_time(beat_frames, sr=sr)
        beats_ms = [int(round((offset + float(x)) * 1000.0)) for x in bt]
        bars_ms = beats_ms[::4]
    except Exception as e:  # noqa: BLE001 — the grid is garnish, never a gate
        log(f"outro beat grid failed: {e}")

    out = {"startMs": int(round(wind_start_s * 1000.0)), "ending": ending}
    # Trailing dead air (absolute floor — see SILENCE_DBFS). Rides this decode
    # because the tail window is already in memory AND because this function is
    # the one place a COMPLETE file is proven: a byte-capped download's "tail"
    # is mid-song, and a cue_out measured off it would cut the song in half.
    # Lifted to a top-level result field by analyze(), so outro_json never
    # carries it. A fully-silent tail window reads None and is omitted — the
    # gap outlasts OUTRO_SECONDS and we cannot see where it begins.
    _lead_t, tail_silence_ms, tail_start_ms = silence_edges_ms(y, sr)
    if tail_silence_ms is not None:
        out["tail_silence_ms"] = int(round(tail_silence_ms))
        # ABSOLUTE offset of the gap's start, so the controller never has to
        # reconstruct it as (tagged duration - gap): the tag and the decoded
        # file disagree often enough to move the cut by the difference.
        out["tail_start_ms"] = int(round(offset * 1000.0 + tail_start_ms))
    if lufs is not None:
        out["lufs"] = lufs
    if bpm_t is not None:
        out["bpm"] = bpm_t
    if beats_ms:
        out["beats"] = beats_ms
    if bars_ms:
        out["bars"] = bars_ms
    return out


# Lazily loaded, at most once. None means "no embeddings this run" — either
# disabled or a load failure (which we log once and then never retry, so one bad
# model can't make every track fail).
_embedder = None
_embed_failed = False
# Why the load failed, in one short line. Reported back on every response (see
# capability_loss) so the caller can tell "this image has no CLAP" from "CLAP is
# here but couldn't load", which are the same `capable: false` today and need
# very different advice.
_embed_error = None


def get_embedder(force=False):
    global _embedder, _embed_failed, _embed_error
    # `force` is the per-request opt-in (the controller's admin toggle sends
    # "embed": true) — it lazy-loads CLAP even when ANALYZE_AUDIO_EMBEDDING
    # isn't in this process's env. A previous load failure still wins: one bad
    # model can't make every subsequent track retry the load.
    if _embed_failed or not (EMBED_ENABLED or force):
        return None
    if _embedder is None:
        try:
            e = ClapEmbedder()
            e.load()
            _embedder = e
            _maybe_start_idle_release()
        except Exception as ex:  # noqa: BLE001 — degrade, never crash the worker
            log(f"CLAP load failed ({ex}); audio embeddings disabled for this run")
            _embed_failed = True
            _embed_error = summarize_load_error(ex)
            return None
    # On the fresh load AND on every cache hit: continued use keeps the model
    # warm, so a long backfill never releases mid-pass (#1204).
    _touch_heavy()
    return _embedder


# The vocal gate, split out of the detector so it's testable without torch /
# demucs / real audio (scripts/vocal_gate_test.py). Takes the vocal-stem RMS
# envelope and the FULL-MIX RMS envelope (same hop) and returns [{startMs,endMs}]
# where vocals are present. The stem is gated against BOTH its own loud level
# (self-relative, catches quiet-but-present vocals) AND a fraction of the mix
# loud level (issue #1125): Demucs never separates cleanly, so an instrumental's
# vocal stem carries residual bleed (pad swells, cymbals, guitar harmonics); a
# purely self-relative gate scales down to that bleed and mass-flags
# instrumentals as vocal. The mix-anchored floor keeps bleed below the line
# while real vocals — a genuine fraction of the mix — still cross. Frames that
# sustain above threshold merge into ranges (gaps <0.4s bridged so a breath
# doesn't split a phrase); sub-300ms blips are dropped as separation artefacts.
def vocal_ranges_from_rms(rms, mix_rms, sr, hop):
    import numpy as np

    if rms.size == 0:
        return []
    loud = float(np.percentile(rms, 90))
    if loud <= 0:
        return []
    mix_loud = float(np.percentile(mix_rms, 90)) if mix_rms.size else 0.0
    thr = max(VOCAL_STEM_REL * loud, VOCAL_MIX_FLOOR * mix_loud)
    # frames → seconds; librosa.frames_to_time's default is frames * hop / sr.
    times = np.arange(rms.size) * (hop / float(sr))
    active = rms >= thr
    ranges = []
    merge_gap_ms = 400
    i = 0
    n = rms.size
    while i < n:
        if not active[i]:
            i += 1
            continue
        j = i
        while j + 1 < n and active[j + 1]:
            j += 1
        start_ms = int(round(float(times[i]) * 1000.0))
        end_ms = int(round(float(times[min(j + 1, n - 1)]) * 1000.0))
        if ranges and start_ms - ranges[-1]["endMs"] <= merge_gap_ms:
            ranges[-1]["endMs"] = end_ms
        else:
            ranges.append({"startMs": start_ms, "endMs": end_ms})
        i = j + 1
    # Drop sub-300ms blips (separation artefacts, not sung lines).
    return [r for r in ranges if r["endMs"] - r["startMs"] >= 300]


# ---------------------------------------------------------------------------
# Vocal-activity detector — Demucs source separation → vocal energy envelope →
# present/absent time ranges. All heavy imports (torch, demucs) are lazy so a
# worker with vocal activity DISABLED never needs them and the librosa-only venv
# keeps working. Same degrade-never-crash contract as the CLAP embedder.
# ---------------------------------------------------------------------------
class VocalActivityDetector:
    def __init__(self):
        self.model = None
        self.sources = None  # stem order, e.g. ['drums','bass','other','vocals']

    def load(self):
        from demucs.pretrained import get_model

        self.model = get_model(DEMUCS_MODEL)
        self.model.eval()
        self.sources = list(self.model.sources)
        if "vocals" not in self.sources:
            raise RuntimeError(f"demucs model {DEMUCS_MODEL} has no 'vocals' stem")

    def separate(self, stereo):
        """stereo: float32 array shaped (2, N) at DEMUCS_SR. One apply_model
        pass → {stem_name: float32 ndarray (channels, N)} for all model stems
        (drums/bass/other/vocals for htdemucs). The single separation is
        shared by vocal-activity detection AND the stem cache (feature:
        stem-blend transitions) — never run Demucs twice on one window."""
        import numpy as np
        import torch

        wav = torch.from_numpy(np.ascontiguousarray(stereo, dtype=np.float32))
        if wav.ndim == 1:
            wav = wav.unsqueeze(0).repeat(2, 1)
        from demucs.apply import apply_model

        with torch.no_grad():
            # apply_model moves the model + chunks to the device itself (this
            # is how the demucs CLI's -d flag works), so no .to() here.
            est = apply_model(self.model, wav.unsqueeze(0), device=resolve_device())[0]
        return {
            name: est[i].cpu().numpy()
            for i, name in enumerate(self.sources)
        }

    def detect(self, stereo, sr, librosa, min_loud=0.0, stems=None):
        """stereo: float32 array shaped (2, N) at DEMUCS_SR. Returns a list of
        {startMs,endMs} where the isolated vocal stem is active — possibly empty
        (an instrumental). Raises on failure; the caller degrades to None.
        `min_loud` is an absolute RMS floor on the stem's loud reference, on top
        of the relative + mix-anchored gate in vocal_ranges_from_rms: both of
        those self-scale to the window, so a window that is pure separation
        bleed (a vocal-free fading outro) can still emit artefact ranges — the
        absolute floor turns those into a clean []. 0.0 = off (the head window
        keeps its historical behaviour).
        `stems` (optional): a pre-computed separate() result for this window,
        so a caller that also caches stems pays for one separation, not two."""
        import numpy as np

        if stems is None:
            stems = self.separate(stereo)
        vocals = stems["vocals"].mean(axis=0)
        # Full-mix reference for the mix-anchored floor. separate() returns
        # stems only, so the mix comes from the input window (mono-safe).
        mix = np.asarray(stereo, dtype=np.float32)
        mix = mix.mean(axis=0) if mix.ndim > 1 else mix

        hop = 512
        rms = librosa.feature.rms(y=vocals, frame_length=2048, hop_length=hop)[0]
        if rms.size == 0:
            return []
        if float(np.percentile(rms, 90)) <= min_loud:
            return []
        mix_rms = librosa.feature.rms(y=mix, frame_length=2048, hop_length=hop)[0]
        return vocal_ranges_from_rms(rms, mix_rms, sr, hop)


def estimate_pace(y, sr, librosa, window_s=5.0):
    """Perceptual energy/momentum curve over the decoded window, decoupled from
    BPM (a high-tempo track can read low pace during a sparse breakdown). Mean
    onset-strength (spectral-flux) energy per ~window_s window, normalised 0..1
    by the loudest window. Span shape: [{startMs,endMs,value}]. Best-
    effort: any failure returns None and the field is omitted."""
    import numpy as np

    try:
        hop = 512
        onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
        if onset_env.size == 0:
            return None
        frames_per_win = max(1, int(round(window_s * sr / hop)))
        peak = float(np.max(onset_env))
        if peak <= 0:
            return None
        curve = []
        for start in range(0, onset_env.size, frames_per_win):
            chunk = onset_env[start : start + frames_per_win]
            if chunk.size == 0:
                continue
            value = round(float(np.mean(chunk)) / peak, 3)
            start_ms = int(round(start * hop / sr * 1000.0))
            end_ms = int(round(min(start + frames_per_win, onset_env.size) * hop / sr * 1000.0))
            if end_ms > start_ms:
                curve.append({"startMs": start_ms, "endMs": end_ms, "value": value})
        return curve or None
    except Exception as e:  # noqa: BLE001 — pace is best-effort
        log(f"pace estimation failed: {e}")
        return None


_vocal_detector = None
_vocal_failed = False
# Twin of _embed_error — see there.
_vocal_error = None


def get_vocal_detector(force=False):
    global _vocal_detector, _vocal_failed, _vocal_error
    if _vocal_failed or not (VOCAL_ENABLED or force):
        return None
    if _vocal_detector is None:
        try:
            d = VocalActivityDetector()
            d.load()
            _vocal_detector = d
            _maybe_start_idle_release()
        # BaseException, not Exception: demucs' fatal() raises SystemExit on an
        # unusable model (e.g. a *_q quantized checkpoint without diffq), which
        # sails past `except Exception` and killed the whole worker — every
        # later request (bpm/key included) then 500'd "worker not ready".
        except BaseException as ex:  # noqa: BLE001 — degrade, never crash the worker
            log(f"Demucs load failed ({ex or type(ex).__name__}); vocal activity disabled for this run")
            _vocal_failed = True
            _vocal_error = summarize_load_error(ex)
            return None
    # Fresh load AND cache hit — see get_embedder (#1204).
    _touch_heavy()
    return _vocal_detector


def write_stems(stems, window, dest_dir):
    """Persist a separate() result as 16-bit FLAC at DEMUCS_SR into dest_dir
    as <window>-<stem>.flac (feature: stem-blend transitions — the cache that
    makes transition renders a fast mix instead of a fresh separation).
    tmp+rename per file so a crashed write never leaves a truncated stem for
    the render op to trust. Raises on failure; callers degrade."""
    import soundfile as sf

    os.makedirs(dest_dir, exist_ok=True)
    for name, data in stems.items():
        path = os.path.join(dest_dir, f"{window}-{name}.flac")
        tmp = path + ".tmp"
        sf.write(tmp, data.T, DEMUCS_SR, subtype="PCM_16", format="FLAC")
        os.replace(tmp, path)


def write_tail_meta(dest_dir, tail_start_s, duration_s):
    """Alignment sidecar for the cached tail stems. The tail window was cut at
    DECODED duration - OUTRO_SECONDS; render_transition must slice the bar
    grid against that exact offset. Re-deriving it from the library's tagged
    duration (an integer from Subsonic) disagrees by up to ~1s, which shifts
    the borrowed drum loop off the downbeat — so the true offset rides with
    the stems and a render without it is a clean cache miss."""
    path = os.path.join(dest_dir, "tail-meta.json")
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump({
            "tail_start_sec": round(float(tail_start_s), 3),
            "duration_sec": round(float(duration_s), 3),
        }, f)
    os.replace(tmp, path)


def render_transition(req):
    """Pre-rendered stem-blend transition (feature: stem-blend transitions —
    docs/stem-transitions-research.md Option B). Mixes the OUTGOING track's
    cached tail stems with the INCOMING track's cached head stems into one
    WAV that airs between them: [out cue_out at blend_start] → clip → [in
    cue_in at in_cue]. CACHE-HIT-ONLY by design — this runs inside the drain
    deadline window, so it must be a fast mix, never a fresh separation; any
    missing stem file is a clean {ok:false} and the controller falls back to
    a plain pair-aware crossfade.

    v1 preset — "beat carry": the outgoing track's last full-energy bar of
    drums (chosen from its measured tail bar grid, before the wind-down)
    keeps looping under the incoming track's opening bars, retriggered on
    the INCOMING grid so the borrowed groove locks to the new tempo; the
    incoming drums drop in hard on a downbeat; two full-mix bars later the
    clip hands off to the real track. blend_start lands on the END of the
    loop source bar, so the loop audibly continues the bar the listener
    just heard — the cut reads as a DJ move, not an edit."""
    import numpy as np
    import soundfile as sf

    out_spec = req.get("out") or {}
    in_spec = req.get("in") or {}
    out_dir = req.get("out_dir")
    clip_name = req.get("clip_name") or "transition.wav"
    target_lufs = req.get("target_lufs")
    if not out_dir or not out_spec.get("stems_dir") or not in_spec.get("stems_dir"):
        return {"ok": False, "error": "missing out/in stems_dir or out_dir"}

    stem_names = ("drums", "bass", "other", "vocals")

    def load_window(stems_dir, window):
        stems = {}
        for name in stem_names:
            p = os.path.join(stems_dir, f"{window}-{name}.flac")
            if not os.path.exists(p):
                return None
            data, sr_f = sf.read(p, dtype="float32", always_2d=True)  # (N, ch)
            if sr_f != DEMUCS_SR or data.shape[0] == 0:
                return None
            stems[name] = data
        return stems

    tail = load_window(out_spec["stems_dir"], "tail")
    head = load_window(in_spec["stems_dir"], "head")
    if tail is None or head is None:
        return {"ok": False, "error": "stems-missing"}

    sr = DEMUCS_SR
    # Alignment comes from the meta sidecar written WITH the stems (decoded
    # duration + the exact tail offset) — never from out_spec's duration_s,
    # which is the library's tagged integer and can sit ~1s off the decoded
    # timeline the bar grid was measured on. Stems without the sidecar (an
    # older cache) are a clean miss; a re-analysis pass refreshes them.
    try:
        with open(os.path.join(out_spec["stems_dir"], "tail-meta.json")) as f:
            tail_meta = json.load(f)
        tail_start_s = float(tail_meta["tail_start_sec"])
        dur_s = float(tail_meta["duration_sec"])
    except Exception:
        return {"ok": False, "error": "stems-meta-missing"}
    if dur_s <= OUTRO_SECONDS + 1.0 or tail_start_s < 0.0:
        return {"ok": False, "error": "out-track-too-short"}

    def to_stereo(x, n):
        """First n samples as (n, 2) float32, zero-padded if short."""
        a = x[:n]
        if a.shape[1] == 1:
            a = np.repeat(a, 2, axis=1)
        a = a[:, :2]
        if a.shape[0] < n:
            a = np.vstack([a, np.zeros((n - a.shape[0], 2), np.float32)])
        return a

    # --- Outgoing side: the drum-loop source bar + the blend start --------
    outro = out_spec.get("outro") or {}
    out_bars = [b / 1000.0 for b in (outro.get("bars") or [])]
    wind_down_s = float(outro.get("start_ms") or (dur_s - 10.0) * 1000.0) / 1000.0
    usable = [
        (b1, b2)
        for b1, b2 in zip(out_bars, out_bars[1:])
        if b1 >= tail_start_s + 0.05 and b2 <= min(wind_down_s, dur_s) and 0.4 < (b2 - b1) < 4.0
    ]
    if not usable:
        return {"ok": False, "error": "no-usable-out-bar"}
    loop_b1, loop_b2 = usable[-1]  # last full-energy bar before the wind-down
    blend_start_s = loop_b2        # out cue_out lands on this bar boundary
    i1 = int((loop_b1 - tail_start_s) * sr)
    i2 = int((loop_b2 - tail_start_s) * sr)
    drum_loop = to_stereo(tail["drums"], tail["drums"].shape[0])[i1:i2]
    if drum_loop.shape[0] < sr // 8:
        return {"ok": False, "error": "loop-too-short"}

    # --- Incoming side: bar grid, carry region, hand-off point ------------
    CARRY_BARS = 4       # bars of borrowed groove under the new intro
    TAIL_FULL_BARS = 2   # full-mix bars after the drop before the decoder hand-off
    in_bars = [b / 1000.0 for b in (in_spec.get("bars") or []) if 0.0 <= b / 1000.0 <= ANALYZE_SECONDS - 1.0]
    if len(in_bars) < CARRY_BARS + TAIL_FULL_BARS + 1:
        return {"ok": False, "error": "no-in-grid"}
    carry_end_s = in_bars[CARRY_BARS]
    in_cue_s = in_bars[CARRY_BARS + TAIL_FULL_BARS]
    head_len_s = min(h.shape[0] for h in head.values()) / sr
    if in_cue_s > head_len_s - 0.25:
        return {"ok": False, "error": "cue-past-window"}

    n = int(in_cue_s * sr)
    if n <= sr:  # a sub-second clip means the grids are degenerate
        return {"ok": False, "error": "clip-too-short"}

    # --- Per-source gains (before summing, so the borrowed loop and the new
    # track each land at their own corrected level; the brick-wall limiter
    # upstream only ever sees sane material) --------------------------------
    #
    # `gain_db` is the station's OWN answer for that track — the same dB the
    # queue stamps as liq_amplify (controller music/loudness.ts), resolved
    # through the operator's loudness.source, boost cap and peak headroom cap.
    # Using it is what keeps a clip at the level of the tracks either side of
    # it (#1240). The lufs fallback below is the pre-#1240 maths, kept for an
    # older controller talking to this worker: it normalises from the leading
    # 40s window alone and ignores ReplayGain tags, so it drifts.
    def gain_for(spec):
        gd = spec.get("gain_db")
        if isinstance(gd, (int, float)):
            return float(10.0 ** (float(gd) / 20.0))
        lufs = spec.get("lufs")
        if target_lufs is None or not isinstance(lufs, (int, float)):
            return 1.0
        g = 10.0 ** ((float(target_lufs) - float(lufs)) / 20.0)
        return float(min(4.0, max(0.25, g)))  # ±12 dB sanity clamp

    g_in = gain_for(in_spec)
    g_out = gain_for(out_spec) * (10.0 ** (-3.0 / 20.0))  # loop sits under the new track

    # --- Mix ---------------------------------------------------------------
    # The incoming track's own content and the BORROWED loop are summed into
    # separate buffers so the peak guard below can duck the thing we added
    # rather than the thing the listener is about to hear at full level.
    mix_buf = np.zeros((n, 2), dtype=np.float32)
    for name in ("bass", "other", "vocals"):
        mix_buf += to_stereo(head[name], n) * g_in
    dstart = int(carry_end_s * sr)
    head_drums = to_stereo(head["drums"], n) * g_in
    mix_buf[dstart:] += head_drums[dstart:]  # incoming beat drops on the downbeat

    loop_buf = np.zeros((n, 2), dtype=np.float32)
    loop_len = drum_loop.shape[0]
    for k in range(CARRY_BARS):
        b1 = int(in_bars[k] * sr)
        b2 = min(int(in_bars[k + 1] * sr), n)
        m = b2 - b1
        if m <= 0:
            continue
        reps = int(np.ceil(m / loop_len))
        piece = np.tile(drum_loop, (reps, 1))[:m] * g_out  # wrap, never a gap
        if k == CARRY_BARS - 1:  # ride out over the last carry bar
            piece = piece * np.linspace(1.0, 0.0, m, dtype=np.float32)[:, None]
        loop_buf[b1:b2] += piece

    # Peak safety toward the bus limiter's comfort zone. The station caps every
    # track's boost at this same -1 dBFS headroom, so scaling the WHOLE clip to
    # fit — what this did before #1240 — silently undid the level match and
    # dropped the clip several dB under its neighbours. The loop is the element
    # we added on top, so the loop is what yields: bisect its gain until the sum
    # fits (exact, on the real sum — not a worst-case bound), floored at -12 dB
    # under its intended level. Only if the incoming content ALONE clips (it
    # shouldn't: its gain is headroom-capped upstream) does the whole clip get
    # scaled, and that is logged rather than silent.
    ceiling = 10.0 ** (-1.0 / 20.0)  # -1 dBFS, the headroom the station's own per-track gain cap leaves
    LOOP_DUCK_FLOOR = 0.25           # -12 dB: duck the groove harder than this and the beat carry is gone
    head_peak = float(np.max(np.abs(mix_buf)))
    if head_peak > ceiling:
        log(f"render_transition: incoming stems peak {head_peak:.3f} over ceiling; scaling whole clip")
        scale = ceiling / head_peak
        mix_buf *= scale
        loop_buf *= scale

    def sum_peak(s):
        return float(np.max(np.abs(mix_buf + loop_buf * s)))

    duck = 1.0
    if sum_peak(1.0) > ceiling:
        if sum_peak(LOOP_DUCK_FLOOR) > ceiling:
            duck = LOOP_DUCK_FLOOR  # can't fit even ducked — the backstop below catches real clipping
        else:
            lo, hi = LOOP_DUCK_FLOOR, 1.0
            for _ in range(12):  # ~0.02% resolution; each step is one array pass
                midpoint = (lo + hi) / 2.0
                if sum_peak(midpoint) > ceiling:
                    hi = midpoint
                else:
                    lo = midpoint
            duck = lo
    mix_buf += loop_buf * duck

    # Backstop: whatever the duck settled on, never hand the encoder a sample
    # that clips in 16-bit. Between the ceiling and here is ~1 dB of real
    # headroom, so this engages only when the duck floor wasn't enough.
    final_peak = float(np.max(np.abs(mix_buf)))
    if final_peak > 0.995:
        mix_buf *= 0.995 / final_peak

    # 10ms edge declicks (the clip meets its neighbours through ~0.3s
    # crossfades, but a hard first/last sample still clicks through them).
    e = max(1, int(0.01 * sr))
    ramp = np.linspace(0.0, 1.0, e, dtype=np.float32)[:, None]
    mix_buf[:e] *= ramp
    mix_buf[-e:] *= ramp[::-1]

    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, os.path.basename(clip_name))
    tmp = out_path + ".tmp"
    sf.write(tmp, mix_buf, sr, subtype="PCM_16", format="WAV")
    os.replace(tmp, out_path)
    return {
        "ok": True,
        "path": out_path,
        "blend_start_sec": round(blend_start_s, 3),
        "in_cue_sec": round(in_cue_s, 3),
        "clip_sec": round(n / sr, 3),
    }


def fetch_audio(url):
    """Download (capped) to a temp file. Returns (path, complete) — `complete`
    is False when the byte cap truncated the download, which vetoes outro
    analysis (the file's "tail" would be mid-song audio)."""
    suffix = ".audio"
    fd, path = tempfile.mkstemp(suffix=suffix, prefix="swanalyze_")
    os.close(fd)
    req = urllib.request.Request(url, headers={"User-Agent": "subwave-analyzer/1"})
    with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT_S) as resp, open(path, "wb") as out:
        read = 0
        while True:
            chunk = resp.read(65536)
            if not chunk:
                break
            out.write(chunk)
            read += len(chunk)
            if read >= ANALYZE_MAX_BYTES:
                break
    return path, read < ANALYZE_MAX_BYTES


def ensure_fast_decode(path):
    """Give libsndfile a file it can open, or fall back to the original path.

    librosa's fast path is soundfile/libsndfile; when that can't open the
    container (m4a/AAC always; MP3s with junk bytes before the first frame
    header — issue #1073) EVERY librosa.load in the request silently drops to
    the deprecated audioread fallback: a fresh full-file ffmpeg decode per
    load (duration probe + body + up to 3 CLAP windows + outro + vocal), a
    warning per call, and audioread is removed in librosa 1.0. Probe once; if
    libsndfile can't open the file, decode it ONCE to a temp WAV (native
    rate/channels — the stereo BS.1770 loudness sum needs the real channel
    layout) and run the whole request off that. Returns (use_path,
    tmp_wav_or_None); the caller removes the tmp. Any failure — soundfile
    absent, no ffmpeg on PATH (bare local venv), decode error — returns the
    original path, i.e. exactly today's behaviour."""
    try:
        import soundfile as sf

        # Quieted like every other decode: libmpg123 narrates its resync over
        # ID3 padding right here, on the probe of a file it goes on to open
        # perfectly well.
        with quiet_decoder_noise(), sf.SoundFile(path):
            return path, None
    except Exception:  # noqa: BLE001 — any open failure routes to the pre-decode
        pass
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return path, None
    fd, wav = tempfile.mkstemp(suffix=".wav", prefix="swanalyze_dec_")
    os.close(fd)
    try:
        subprocess.run(
            [ffmpeg, "-v", "error", "-y", "-i", path,
             "-map", "0:a:0", "-acodec", "pcm_s16le", "-f", "wav", wav],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=FFMPEG_DECODE_TIMEOUT_S,
        )
        if os.path.getsize(wav) > 1024:
            log("libsndfile can't open this container; pre-decoded once via ffmpeg")
            return wav, wav
        log("ffmpeg pre-decode produced no audio; falling back to per-load decode")
    except subprocess.CalledProcessError as e:
        err = (e.stderr or b"").decode("utf-8", "replace").strip()[:200]
        log(f"ffmpeg pre-decode failed ({err or e}); falling back to per-load decode")
    except Exception as e:  # noqa: BLE001 — pre-decode is best-effort
        log(f"ffmpeg pre-decode failed ({e}); falling back to per-load decode")
    try:
        os.remove(wav)
    except OSError:
        pass
    return path, None


def measure_loudness(y, sr):
    """Integrated loudness (LUFS, ITU-R BS.1770 / EBU R128) + true-ish peak in
    dBFS over the decoded window. Accepts mono (n,) or librosa's multichannel
    (channels, n) — pass the STEREO decode when available: BS.1770 sums the
    energy of both channels, so the old mono average under-read center-heavy
    mixes by up to ~3 dB and every gain computed from it aired that much hot
    (issue #998). Best-effort: pyloudnorm is an optional dep, so a missing
    import or any failure returns (None, None) and the caller simply omits the
    fields — every consumer treats NULL as "no loudness, behave as today"
    (same contract as the CLAP embedding)."""
    import numpy as np

    try:
        import pyloudnorm as pyln
    except Exception as e:  # noqa: BLE001 — optional dependency
        log(f"pyloudnorm unavailable, skipping loudness: {e}")
        return None, None

    try:
        meter = pyln.Meter(sr)  # BS.1770 meter at the decode sample rate
        # pyloudnorm wants (samples,) or (samples, channels); librosa decodes
        # multichannel as (channels, samples).
        data = y.T if getattr(y, "ndim", 1) > 1 else y
        lufs = float(meter.integrated_loudness(data))
        peak = float(np.max(np.abs(y))) if np.size(y) else 0.0
        peak_db = 20.0 * float(np.log10(peak)) if peak > 0 else None
        # integrated_loudness returns -inf for digital silence; treat as no signal.
        if not np.isfinite(lufs):
            return None, peak_db
        return round(lufs, 2), (round(peak_db, 2) if peak_db is not None else None)
    except Exception as e:  # noqa: BLE001 — loudness is best-effort
        log(f"loudness measurement failed: {e}")
        return None, None


def analyze(
    librosa, url=None, path=None, embed=None, vocal=None, complete=None,
    stems_dir=None, embedding_only=False,
):
    import numpy as np

    # A controller-provided path is pre-fetched onto the shared volume and
    # owned by the caller; only files fetch_audio downloads here are ours to
    # remove. Keeps the url path behaviour identical for back-compat.
    # `complete` says whether `path` holds the WHOLE file (the controller's
    # downloadCapped knows; our own fetch_audio determines it for url requests).
    # None = unknown (old caller) → outro analysis still runs, relying on its
    # decode-length validation; False = definitively truncated → skipped.
    owned = path is None
    if owned:
        path, complete = fetch_audio(url)
    # Pre-decode ONCE when libsndfile can't open the container (m4a, quirky
    # MP3s — issue #1073), so every load below takes the fast soundfile path
    # instead of audioread re-decoding the whole file per call. `src_path`
    # keeps the original download for the ownership cleanup; the WAV is always
    # ours to remove.
    src_path = path
    path, decoded_tmp = ensure_fast_decode(path)
    audio_embedding = None
    vocal_ranges = None
    outro = None
    try:
        # One header-duration probe shared by the CLAP windows and the outro
        # tail (both need to know where the file ends). 0.0 = unknown.
        try:
            duration_s = float(librosa.get_duration(path=path))
        except Exception as e:  # noqa: BLE001 — degrade to leading-window/no-outro
            log(f"duration probe failed ({e})")
            duration_s = 0.0

        # CLAP wants 48 kHz mono — decode fresh copies at that rate from the
        # SAME file (still present here, before the finally removes owned
        # temps), windowed across the track (see embed_windows). A model/
        # feature failure on one track never fails the whole analyze: we log
        # and emit bpm/key without the embedding.
        # Per-request `embed` wins over the env default in the ON direction
        # only: True forces a (lazy) CLAP load, None/absent keeps the env-driven
        # behaviour. False is never sent by the controller today.
        embedder = None if embed is False else get_embedder(force=embed is True)
        if embedder is not None:
            try:
                audio_embedding = embed_windows(embedder, path, librosa, duration_s)
            except Exception as e:  # noqa: BLE001 — embedding is best-effort
                log(f"audio embedding failed: {e}")
                audio_embedding = None
        # A sounds-like backfill over an otherwise-current track needs only the
        # CLAP vector. Returning here avoids re-running every CPU acoustic
        # feature (and Demucs via an env default) merely to fill that one column.
        if embedding_only:
            return {"audio_embedding": audio_embedding} if audio_embedding is not None else {}
        # Decode once WITH channels (a mono file still comes back 1-D): the
        # loudness meter needs real stereo for a correct BS.1770 channel sum
        # (issue #998); every other baseline feature works off the mono downmix.
        # This deliberately follows the embedding-only return above: a CLAP
        # backfill must not pay for the baseline window it will not consume.
        y_src, sr = load_audio(
            librosa, path, sr=ANALYZE_SR, mono=False, duration=ANALYZE_SECONDS
        )
        y = librosa.to_mono(y_src)
        # Outro (tail) features — only meaningful off a complete file; a
        # byte-capped download's "tail" is mid-song. Best-effort like the rest.
        # With an UNKNOWN completeness (old caller) the original path's
        # short-decode validation inside analyze_outro catches truncation, but
        # a pre-decoded WAV defeats that check (its duration IS the decodable
        # length, so the tail always decodes full) — skip outro rather than
        # risk measuring mid-song audio as the ending.
        if complete is not False and (complete is True or decoded_tmp is None):
            try:
                outro = analyze_outro(path, librosa, duration_s, complete)
            except Exception as e:  # noqa: BLE001 — outro is best-effort
                log(f"outro analysis failed: {e}")
                outro = None
        # Vocal activity — Demucs wants 44.1 kHz stereo; decode a third copy from
        # the same file. Gated like CLAP (per-request `vocal` forces the load).
        # Best-effort: a failure leaves vocal_ranges None (field omitted). A
        # successful run with no detected vocals emits [] — the distinct "empty"
        # value tells the controller this track WAS analysed (an instrumental),
        # so the backfill scope doesn't keep re-targeting it.
        # A stems_dir request implies separation even when vocal detection
        # wasn't asked for — the stem cache and vocal ranges share one
        # apply_model pass per window. Explicit vocal=False still wins.
        detector = None if vocal is False else get_vocal_detector(force=vocal is True or bool(stems_dir))
        stems_cached = None
        if detector is not None:
            try:
                ys, _srs = load_audio(
                    librosa, path, sr=DEMUCS_SR, mono=False, duration=ANALYZE_SECONDS
                )
                if ys is not None and np.size(ys) > 0:
                    head_stems = detector.separate(ys)
                    vocal_ranges = detector.detect(ys, DEMUCS_SR, librosa, stems=head_stems)
                    if stems_dir:
                        try:
                            write_stems(head_stems, "head", stems_dir)
                            stems_cached = True
                        except Exception as e:  # noqa: BLE001 — cache is best-effort
                            log(f"stem cache write (head) failed: {e}")
                            stems_cached = False
            except Exception as e:  # noqa: BLE001 — vocal activity is best-effort
                log(f"vocal activity failed: {e}")
                vocal_ranges = None
        # Tail vocal activity (feature: vocal-aware transitions) — the outro
        # window gets its own Demucs pass so transitions know whether the
        # ENDING is sung (the head pass above never sees the last 20s of a
        # normal-length track). Gated on the same detector AND a computed
        # outro: outro non-None already proves the file is complete and long
        # enough for a distinct tail. Spans are shifted to ABSOLUTE ms like
        # the outro's beat grid; [] = analysed instrumental tail, mirroring
        # the head semantics. TAIL_VOCAL_MIN_LOUD (see its definition) guards
        # against separation bleed on a fading outro.
        if detector is not None and outro is not None and "startMs" in outro:
            try:
                tail_offset = max(0.0, duration_s - OUTRO_SECONDS)
                y_tail, _srt = load_audio(
                    librosa, path, sr=DEMUCS_SR, mono=False,
                    offset=tail_offset, duration=OUTRO_SECONDS,
                )
                if y_tail is not None and np.size(y_tail) > 0:
                    tail_stems = detector.separate(y_tail)
                    tail_vocals = detector.detect(
                        y_tail, DEMUCS_SR, librosa, min_loud=TAIL_VOCAL_MIN_LOUD, stems=tail_stems
                    )
                    if stems_dir:
                        try:
                            write_stems(tail_stems, "tail", stems_dir)
                            write_tail_meta(stems_dir, tail_offset, duration_s)
                        except Exception as e:  # noqa: BLE001 — cache is best-effort
                            log(f"stem cache write (tail) failed: {e}")
                    shift_ms = tail_offset * 1000.0
                    outro["vocalRanges"] = [
                        {
                            "startMs": int(round(r["startMs"] + shift_ms)),
                            "endMs": int(round(r["endMs"] + shift_ms)),
                        }
                        for r in tail_vocals
                    ]
            except Exception as e:  # noqa: BLE001 — tail vocals are best-effort
                log(f"tail vocal activity failed: {e}")
    finally:
        if decoded_tmp is not None:
            try:
                os.remove(decoded_tmp)
            except OSError:
                pass
        if owned:
            try:
                os.remove(src_path)
            except OSError:
                pass

    if y is None or len(y) == 0:
        raise RuntimeError("decoded empty audio")

    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
    bpm = float(np.atleast_1d(tempo)[0])

    # Per-beat timestamps (ms) — already computed by beat_track, previously
    # discarded. Downbeats are a 4/4 heuristic (every 4th beat from the first):
    # librosa gives no true downbeat, but a bar grid is enough to bar-align a
    # crossfade. Best-effort: an empty/odd grid simply yields fewer/no bars.
    beats_ms = []
    bars_ms = []
    try:
        bt = librosa.frames_to_time(beat_frames, sr=sr)
        beats_ms = [int(round(float(t) * 1000.0)) for t in bt]
        bars_ms = beats_ms[::4]
    except Exception as e:  # noqa: BLE001 — beat grid is best-effort
        log(f"beat grid failed: {e}")
        beats_ms = []
        bars_ms = []

    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    chroma_mean = [float(x) for x in np.mean(chroma, axis=1)]
    key, key_sep = estimate_key(chroma_mean)

    # Per-region key (tonic + mode) over time — reuses the chroma above.
    key_ranges = estimate_key_ranges(chroma, sr, librosa)

    intro_ms = estimate_intro_ms(y, sr, librosa)

    # Leading dead air, off the SAME decoded head window (free). Absolute
    # floor, NOT intro_ms's relative one — see SILENCE_DBFS. None when the
    # whole window reads silent: the gap outlasts ANALYZE_SECONDS and we
    # cannot see where it ends, so the controller trims nothing.
    lead_silence_ms, _tail_head, _tail_start_head = silence_edges_ms(y, sr)

    # When vocal activity was measured, the start of the first vocal range is a
    # truer intro than the energy heuristic (an instrumental intro is exactly
    # the vocal-free leading region). Prefer it; fall back to the heuristic for
    # instrumentals ([] → keep the energy estimate) and un-run tracks.
    if vocal_ranges:
        intro_ms = float(vocal_ranges[0]["startMs"])

    # Structural sections over the decoded window (intro/leading sections are
    # the reliable part — the outro of a long track is beyond ANALYZE_SECONDS).
    # Reuses the chroma already computed for key estimation.
    sections = estimate_sections(y, sr, librosa, chroma=chroma)

    # Perceptual energy/momentum curve (decoupled from BPM).
    pace = estimate_pace(y, sr, librosa)

    # Perceptual loudness (LUFS) over the decoded window — feeds per-track gain
    # normalisation toward a target on the playback side. Measured off the
    # channel-preserving decode, not the mono downmix (issue #998). None when
    # pyloudnorm is absent or measurement fails.
    loudness_lufs, peak_db = measure_loudness(y_src, sr)

    # Overall confidence: dominated by how cleanly the key resolved, nudged by
    # whether we got a plausible tempo. Kept conservative on purpose.
    confidence = round(0.5 * key_sep + (0.5 if 40 <= bpm <= 220 else 0.0), 3)

    result = {
        "bpm": round(bpm, 1),
        "key": key,
        "intro_ms": int(intro_ms) if intro_ms is not None else None,
        "confidence": confidence,
    }
    # Edge dead air. Head rides this pass; the tail is measured inside
    # analyze_outro (the only place a COMPLETE file is proven) and lifted out
    # of the outro dict HERE so outro_json never carries it. Omitted when not
    # measured — absence means "no silence signal, behave as today".
    if lead_silence_ms is not None:
        result["lead_silence_ms"] = int(round(lead_silence_ms))
    if outro is not None and "tail_silence_ms" in outro:
        result["tail_silence_ms"] = outro.pop("tail_silence_ms")
        if "tail_start_ms" in outro:
            result["tail_start_ms"] = outro.pop("tail_start_ms")
        if not outro:
            outro = None
    # Only carry loudness fields when measured — absence signals "no loudness
    # this pass", so a worker without pyloudnorm is byte-for-byte today.
    if loudness_lufs is not None:
        result["loudness_lufs"] = loudness_lufs
    if peak_db is not None:
        result["peak_db"] = peak_db
    # Structural sections (omit when segmentation produced nothing).
    if sections:
        result["sections"] = sections
    # Pace curve (omit when none produced).
    if pace:
        result["pace_curve"] = pace
    # Beat / bar grid (omit when empty).
    if beats_ms:
        result["beats"] = beats_ms
    if bars_ms:
        result["bars"] = bars_ms
    # Per-region key ranges (omit when none produced).
    if key_ranges:
        result["key_ranges"] = key_ranges
    # Outro (tail) features — omit when not computed (short/truncated file,
    # decode failure), so consumers treat absence as "no outro signal".
    if outro is not None:
        result["outro"] = outro
    # Vocal-activity ranges. Emit even when empty ([] = analysed instrumental);
    # omit only when detection didn't run (None), so the controller can tell
    # "no vocals" from "not computed".
    if vocal_ranges is not None:
        result["vocal_ranges"] = vocal_ranges
    # Only carry the embedding when we actually produced one — its absence is
    # how every downstream consumer knows to behave as today.
    if audio_embedding is not None:
        result["audio_embedding"] = audio_embedding
    # Stem-cache outcome (only when a stems_dir was requested): True = head
    # stems written (tail rides along when the outro was computable).
    if stems_cached is not None:
        result["stems_cached"] = stems_cached
    return result


def main():
    try:
        import librosa  # noqa: F401
        import numpy  # noqa: F401
    except Exception as e:  # pragma: no cover
        emit({"id": None, "ok": False, "fatal": True, "error": f"import failed: {e}"})
        sys.exit(1)

    # Pre-warm the CLAP model (when enabled) BEFORE announcing ready, so the
    # one-time model download / load is paid during boot rather than on the
    # first /analyze — which would otherwise risk the request timeout and a
    # cascade while later requests queue behind a still-loading worker. A load
    # failure here just disables embeddings (get_embedder caught it); the worker
    # still boots and analyses bpm/key. The sidecar imposes no ready timeout; a
    # local-venv boot that exceeds its ready window simply restarts and finds
    # the weights cached the second time.
    if EMBED_ENABLED:
        log("ANALYZE_AUDIO_EMBEDDING on — loading CLAP model...")
        get_embedder()
    if VOCAL_ENABLED:
        log("ANALYZE_VOCAL_ACTIVITY on — loading Demucs model...")
        get_vocal_detector()

    # Tell the controller whether this worker can actually emit "sounds-like"
    # audio embeddings, so the admin UI can warn *before* a fruitless run rather
    # than after the fingerprint bar stays at 0. Capable = the CLAP libs are
    # present (image built WITH_CLAP=1) and we haven't already hit a hard load
    # failure. find_spec avoids importing torch when embeddings are off.
    audio_capable = (not _embed_failed) and (
        _embedder is not None
        or all(importlib.util.find_spec(m) is not None for m in ("torch", "transformers"))
    )
    # Same probe for vocal activity — the demucs + torch libs present (image
    # built WITH_DEMUCS=1) and no hard load failure yet.
    vocal_capable = (not _vocal_failed) and (
        _vocal_detector is not None
        or all(importlib.util.find_spec(m) is not None for m in ("torch", "demucs"))
    )
    # Text-tower probe: unlike onnx-mode audio (which runs without torch), the
    # text tower always needs torch + transformers, in both backend modes.
    text_capable = (not _embed_failed) and all(
        importlib.util.find_spec(m) is not None for m in ("torch", "transformers")
    )

    log("ready")
    emit({
        "id": None,
        "ready": True,
        "audio_embedding_capable": audio_capable,
        "vocal_activity_capable": vocal_capable,
        # Version signal as much as a capability: only workers that compute
        # tail vocal ranges (outro.vocalRanges) emit this key at all, so the
        # controller can gate the tail-vocal backfill widening on `=== true`
        # and a stale sidecar image never causes re-analysis churn.
        "tail_vocal_capable": vocal_capable,
        "text_embedding_capable": text_capable,
    })

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            emit({"id": None, "ok": False, "error": f"bad json: {e}"})
            continue
        rid = req.get("id")
        # Transition render (feature: stem-blend transitions) — dispatched by
        # op key; a pure mix of cached stems, seconds of CPU, no model.
        if req.get("op") == "render_transition":
            try:
                emit({"id": rid, **render_transition(req)})
            except Exception as e:  # noqa: BLE001 — one bad render never kills the worker
                emit({"id": rid, "ok": False, "error": str(e)})
            continue
        # Text-embedding request — {"texts": ["...", ...]} instead of url/path.
        # An explicit text request force-loads CLAP like embed:true does (the
        # caller asked for the shared audio-text space; env default irrelevant).
        texts = req.get("texts")
        if texts is not None:
            if (
                not isinstance(texts, list)
                or not texts
                or len(texts) > 64
                or not all(isinstance(t, str) and t.strip() for t in texts)
            ):
                emit({"id": rid, "ok": False, "error": "texts must be 1-64 non-empty strings"})
                continue
            with _model_lock:
                embedder = get_embedder(force=True)
                if embedder is None:
                    emit({"id": rid, "ok": False, "error": "CLAP unavailable (load failed or libs absent)"})
                    continue
                try:
                    emit({"id": rid, "ok": True, "text_embeddings": embedder.embed_texts(texts)})
                except Exception as e:  # noqa: BLE001 — one bad request never kills the worker
                    emit({"id": rid, "ok": False, "error": str(e)})
                # Re-stamp on the way out so the clock reads from the END of the
                # work, not its start. get_embedder() stamped on entry.
                _touch_heavy()
            continue
        url = req.get("url")
        path = req.get("path")
        if not url and not path:
            emit({"id": rid, "ok": False, "error": "missing url or path"})
            continue
        try:
            import librosa

            # No unconditional clock stamp here: this is the general request
            # path and a lean bpm/key pass must NOT keep CLAP/Demucs pinned
            # (#1204). The heavy clock is stamped inside get_embedder /
            # get_vocal_detector; _model_lock is what keeps an unload from
            # racing this request.
            heavy_before = _heavy_last_used
            with _model_lock:
                result = analyze(
                    librosa, url=url, path=path,
                    embed=req.get("embed"), vocal=req.get("vocal"),
                    complete=req.get("complete"), stems_dir=req.get("stems_dir"),
                    embedding_only=req.get("embedding_only") is True,
                )
                # If a getter stamped the clock, this request DID use a model —
                # re-stamp so the countdown starts from the end of the work, not
                # its start (Demucs on a long track holds the lock for minutes).
                if _heavy_last_used != heavy_before:
                    _touch_heavy()
            emit({"id": rid, "ok": True, **result})
        except Exception as e:
            emit({"id": rid, "ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
