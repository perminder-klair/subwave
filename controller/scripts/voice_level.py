"""On-air level for a rendered voice clip, shared by the heavy-engine workers.

RMS-normalise the clip to a target, then soft-limit the peaks that pushes up
instead of hard-clipping them: the tanh knee is transparent below KNEE and
never passes CEILING (~-0.26 dBFS), so a hotter target never chops into harsh
clipping and every sample stays under full scale.

pocket_tts_worker.py and chatterbox_worker.py each run in their own venv and
import this from the directory they live in (controller/scripts in the
controller image, /app/workers in the tts-heavy sidecar), so it needs nothing
but numpy. Each worker owns its target and the env var that tunes it, because
the right level depends on the engine's crest factor (see each worker); both
read that var through target_from_env().
"""

import math
import os

import numpy as np

KNEE = 0.70
CEILING = 0.97


def level(audio, target_rms):
    """Return `audio` (float32, any shape) at `target_rms`, peaks soft-limited."""
    audio = np.asarray(audio, dtype=np.float32)
    rms = float(np.sqrt(np.mean(audio * audio))) if audio.size else 0.0
    if rms > 0:
        audio = audio * (target_rms / rms)
    mag = np.abs(audio)
    over = mag > KNEE
    audio[over] = np.sign(audio[over]) * (
        KNEE + (CEILING - KNEE) * np.tanh((mag[over] - KNEE) / (CEILING - KNEE))
    )
    return audio


def target_from_env(name, default, log):
    """The RMS target env var `name` sets, else `default`.

    Empty reads as unset: the tts-heavy compose files forward the var as
    `${NAME:-}`, so a sidecar whose operator never set it sees "". Anything
    that is not a positive number is logged through `log` and reads the
    default, so a typo costs the tuning rather than stopping the worker.
    """
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        value = None
    if value is not None and math.isfinite(value) and value > 0:
        return value
    log(f"{name}={raw!r} is not a positive number; using {default}")
    return default
