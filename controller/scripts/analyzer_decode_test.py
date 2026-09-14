#!/usr/bin/env python3
"""Dependency-light predecode recovery tests for incomplete FLAC inputs.

The default suite uses stdlib WAV fixtures and a small SoundFile adapter. Pass
``--integration`` to generate and analyze a real frame-truncated FLAC with the
installed analyzer dependencies and ffmpeg.
"""

import os
import subprocess
import sys
import tempfile
import types
import wave

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import analyze_worker as aw  # noqa: E402


failures = 0


def test(name, fn):
    global failures
    try:
        fn()
        print(f"  ✓ {name}")
    except Exception as err:  # noqa: BLE001 — a failed assert is a reported case
        failures += 1
        print(f"  ✗ {name}\n      {err}")


class _AudioFrames:
    def __init__(self, frames, channels):
        self.shape = (frames, channels)


class _SoundFile:
    def __init__(self, path, fail_source=False, wav_subtype="PCM_16"):
        self.path = path
        self._reader = None
        if path.endswith(".wav"):
            self._reader = wave.open(path, "rb")
            self.format = "WAV"
            self.subtype = wav_subtype
            self.samplerate = self._reader.getframerate()
            self.channels = self._reader.getnchannels()
        else:
            if fail_source:
                raise RuntimeError("container open failed")
            with open(path, "rb") as source:
                self.format = "FLAC" if source.read(4) == b"fLaC" else "OGG"
            self.subtype = "PCM_16"
            self.samplerate = 44100
            self.channels = 2

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        if self._reader is not None:
            self._reader.close()
        return False

    def read(self, frames, dtype, always_2d):
        assert frames == 4096
        assert dtype == "int16"
        assert always_2d is True
        data = self._reader.readframes(frames)
        frame_bytes = self.channels * self._reader.getsampwidth()
        return _AudioFrames(len(data) // frame_bytes, self.channels)


class _SoundFileModule(types.ModuleType):
    def __init__(self, fail_source=False, wav_subtype="PCM_16"):
        super().__init__("soundfile")
        self.fail_source = fail_source
        self.wav_subtype = wav_subtype

    def SoundFile(self, path):
        return _SoundFile(path, self.fail_source, self.wav_subtype)


class _Completed:
    returncode = 0
    stderr = b""


def _write_pcm_wav(path, frames=512, channels=2):
    with wave.open(path, "wb") as out:
        out.setnchannels(channels)
        out.setsampwidth(2)
        out.setframerate(44100)
        out.writeframes(b"\0\0" * frames * channels)


def _runner(output="valid", returncode=0, error=None, calls=None, channels=2):
    def run(command, **_kwargs):
        if calls is not None:
            calls.append(command)
        wav = command[-1]
        if output == "valid":
            _write_pcm_wav(wav, channels=channels)
        elif output == "empty":
            _write_pcm_wav(wav, frames=0)
        elif output == "corrupt":
            with open(wav, "wb") as out:
                out.write(b"not a wav" + b"\0" * 2048)
        if error is not None:
            raise error(command)
        if returncode:
            raise subprocess.CalledProcessError(returncode, command, stderr=b"cut final frame")
        return _Completed()

    return run


class _PatchedDecode:
    def __init__(self, soundfile, runner, ffmpeg=True):
        self.soundfile = soundfile
        self.runner = runner
        self.ffmpeg = ffmpeg

    def __enter__(self):
        self.original_run = aw.subprocess.run
        self.original_which = aw.shutil.which
        self.original_soundfile = sys.modules.get("soundfile")
        sys.modules["soundfile"] = self.soundfile
        aw.subprocess.run = self.runner
        aw.shutil.which = lambda _name: "/usr/bin/ffmpeg" if self.ffmpeg else None

    def __exit__(self, *_args):
        aw.subprocess.run = self.original_run
        aw.shutil.which = self.original_which
        if self.original_soundfile is None:
            sys.modules.pop("soundfile", None)
        else:
            sys.modules["soundfile"] = self.original_soundfile


def _source(tmp, header=b"fLaC", name="track.audio"):
    path = os.path.join(tmp, name)
    with open(path, "wb") as out:
        out.write(header + b"source audio")
    return path


def t_known_incomplete_openable_flac_is_predecoded():
    calls = []
    with tempfile.TemporaryDirectory() as tmp, _PatchedDecode(
        _SoundFileModule(), _runner(calls=calls)
    ):
        source = _source(tmp)
        decoded, owned = aw.ensure_fast_decode(source, complete=False)
        assert decoded == owned and decoded != source, (decoded, owned)
        assert os.path.exists(decoded), decoded
        assert len(calls) == 1, calls
        command = calls[0]
        assert "-xerror" not in command and "-t" not in command, command
        assert command[command.index("-acodec") + 1] == "pcm_s16le", command
        assert command[command.index("-map") + 1] == "0:a:0", command
        os.remove(decoded)


def t_complete_and_unknown_openable_flac_keep_original():
    calls = []
    with tempfile.TemporaryDirectory() as tmp, _PatchedDecode(
        _SoundFileModule(), _runner(calls=calls)
    ):
        source = _source(tmp)
        assert aw.ensure_fast_decode(source, complete=True) == (source, None)
        assert aw.ensure_fast_decode(source) == (source, None)
        assert not calls, calls


def t_incomplete_non_flac_keeps_original():
    calls = []
    with tempfile.TemporaryDirectory() as tmp, _PatchedDecode(
        _SoundFileModule(), _runner(calls=calls)
    ):
        source = _source(tmp, header=b"OggS", name="misleading.flac")
        assert aw.ensure_fast_decode(source, complete=False) == (source, None)
        assert not calls, calls


def t_unopenable_native_flac_is_recovered_without_extension():
    with tempfile.TemporaryDirectory() as tmp, _PatchedDecode(
        _SoundFileModule(fail_source=True), _runner()
    ):
        source = _source(tmp)
        decoded, owned = aw.ensure_fast_decode(source, complete=False)
        assert decoded == owned and decoded != source, (decoded, owned)
        os.remove(decoded)


def t_recovery_preserves_native_multichannel_and_legacy_conversion():
    calls = []
    with tempfile.TemporaryDirectory() as tmp, _PatchedDecode(
        _SoundFileModule(), _runner(calls=calls, channels=4)
    ):
        source = _source(tmp)
        decoded, owned = aw.ensure_fast_decode(source, complete=False)
        assert decoded == owned and decoded != source, (decoded, owned)
        assert "-ac" not in calls[0], calls[0]
        os.remove(decoded)

    with tempfile.TemporaryDirectory() as tmp, _PatchedDecode(
        _SoundFileModule(fail_source=True), _runner()
    ):
        source = _source(tmp, header=b"OggS", name="legacy.audio")
        decoded, owned = aw.ensure_fast_decode(source)
        assert decoded == owned and decoded != source, (decoded, owned)
        os.remove(decoded)


def t_positive_nonzero_valid_pcm_is_accepted_only_for_recovery():
    with tempfile.TemporaryDirectory() as tmp, _PatchedDecode(
        _SoundFileModule(), _runner(returncode=7)
    ):
        source = _source(tmp)
        decoded, owned = aw.ensure_fast_decode(source, complete=False)
        assert decoded == owned and decoded != source, (decoded, owned)
        assert os.path.exists(decoded), decoded
        os.remove(decoded)

    calls = []
    with tempfile.TemporaryDirectory() as tmp, _PatchedDecode(
        _SoundFileModule(fail_source=True), _runner(returncode=7, calls=calls)
    ):
        source = _source(tmp, header=b"OggS")
        assert aw.ensure_fast_decode(source, complete=False) == (source, None)
        assert len(calls) == 1, calls
        assert not os.path.exists(calls[0][-1]), calls[0][-1]


def t_signal_status_and_unusable_outputs_are_rejected_and_removed():
    cases = [
        ("signal", _SoundFileModule(), _runner(returncode=-9)),
        ("empty", _SoundFileModule(), _runner(output="empty")),
        ("corrupt", _SoundFileModule(), _runner(output="corrupt")),
        ("wrong PCM subtype", _SoundFileModule(wav_subtype="FLOAT"), _runner()),
    ]
    for label, sf_module, runner in cases:
        calls = []
        wrapped = _runner(output="valid", calls=calls)
        if label == "signal":
            wrapped = _runner(returncode=-9, calls=calls)
        elif label == "empty":
            wrapped = _runner(output="empty", calls=calls)
        elif label == "corrupt":
            wrapped = _runner(output="corrupt", calls=calls)
        with tempfile.TemporaryDirectory() as tmp, _PatchedDecode(sf_module, wrapped):
            source = _source(tmp)
            assert aw.ensure_fast_decode(source, complete=False) == (source, None), label
            assert len(calls) == 1, (label, calls)
            assert not os.path.exists(calls[0][-1]), (label, calls[0][-1])


def t_timeout_missing_ffmpeg_and_validation_errors_fall_back_cleanly():
    timeout_calls = []
    timeout = lambda command: subprocess.TimeoutExpired(command, 1)
    with tempfile.TemporaryDirectory() as tmp, _PatchedDecode(
        _SoundFileModule(), _runner(error=timeout, calls=timeout_calls)
    ):
        source = _source(tmp)
        assert aw.ensure_fast_decode(source, complete=False) == (source, None)
        assert not os.path.exists(timeout_calls[0][-1]), timeout_calls

    calls = []
    with tempfile.TemporaryDirectory() as tmp, _PatchedDecode(
        _SoundFileModule(), _runner(calls=calls), ffmpeg=False
    ):
        source = _source(tmp)
        assert aw.ensure_fast_decode(source, complete=False) == (source, None)
        assert not calls, calls


def t_missing_nonzero_output_and_interruption_clean_up():
    calls = []
    with tempfile.TemporaryDirectory() as tmp, _PatchedDecode(
        _SoundFileModule(), _runner(output="missing", returncode=4, calls=calls)
    ):
        source = _source(tmp)
        assert aw.ensure_fast_decode(source, complete=False) == (source, None)
        assert not os.path.exists(calls[0][-1]), calls

    interrupted_calls = []
    interrupt = lambda _command: KeyboardInterrupt()
    with tempfile.TemporaryDirectory() as tmp, _PatchedDecode(
        _SoundFileModule(), _runner(error=interrupt, calls=interrupted_calls)
    ):
        source = _source(tmp)
        try:
            aw.ensure_fast_decode(source, complete=False)
            raise AssertionError("KeyboardInterrupt was swallowed")
        except KeyboardInterrupt:
            pass
        assert not os.path.exists(interrupted_calls[0][-1]), interrupted_calls


def run_lightweight():
    print("incomplete FLAC predecode")
    test("known-incomplete openable FLAC is predecoded", t_known_incomplete_openable_flac_is_predecoded)
    test("complete and unknown FLAC keep the original path", t_complete_and_unknown_openable_flac_keep_original)
    test("codec identity does not come from the filename", t_incomplete_non_flac_keeps_original)
    test("native FLAC header recovers an unopenable .audio file", t_unopenable_native_flac_is_recovered_without_extension)
    test("native multichannel and legacy conversion stay supported", t_recovery_preserves_native_multichannel_and_legacy_conversion)
    test("positive nonzero output is recovery-only", t_positive_nonzero_valid_pcm_is_accepted_only_for_recovery)
    test("signals and unusable WAVs are rejected and removed", t_signal_status_and_unusable_outputs_are_rejected_and_removed)
    test("timeout and missing ffmpeg preserve fallback", t_timeout_missing_ffmpeg_and_validation_errors_fall_back_cleanly)
    test("missing output and interruption clean temporary WAVs", t_missing_nonzero_output_and_interruption_clean_up)


def run_integration():
    try:
        import numpy as np
        import librosa
        import soundfile as sf
    except ImportError as err:
        raise RuntimeError(f"integration dependencies unavailable: {err}") from err
    if not aw.shutil.which("ffmpeg"):
        raise RuntimeError("integration dependency unavailable: ffmpeg")

    with tempfile.TemporaryDirectory() as tmp:
        source = os.path.join(tmp, "source.flac")
        staged = os.path.join(tmp, "first12m.audio")
        rng = np.random.default_rng(1670)
        pcm = rng.integers(-16000, 16000, size=(44100 * 100, 2), dtype=np.int16)
        sf.write(source, pcm, 44100, subtype="PCM_16")
        with open(source, "rb") as full, open(staged, "wb") as capped:
            capped.write(full.read(12 * 1024 * 1024))
        assert os.path.getsize(source) > os.path.getsize(staged)

        control, control_tmp = aw.ensure_fast_decode(source, complete=True)
        assert (control, control_tmp) == (source, None)

        probe_wav = os.path.join(tmp, "probe.wav")
        probe = subprocess.run(
            [aw.shutil.which("ffmpeg"), "-v", "error", "-y", "-i", staged,
             "-map", "0:a:0", "-acodec", "pcm_s16le", "-f", "wav", probe_wav],
            check=False, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        )
        probe_pcm, probe_sr = sf.read(probe_wav, dtype="int16", always_2d=True)
        assert probe_sr == 44100 and probe_pcm.shape[0] > 0
        decoder_error = probe.stderr.decode("utf-8", "replace").lower()
        assert "decode_frame" in decoder_error or "invalid residual" in decoder_error, (
            probe.returncode, decoder_error[-500:]
        )
        os.remove(probe_wav)

        decoded, decoded_tmp = aw.ensure_fast_decode(staged, complete=False)
        assert decoded == decoded_tmp and decoded != staged, (decoded, decoded_tmp)
        recovered, recovered_sr = sf.read(decoded, dtype="int16", always_2d=True)
        assert recovered_sr == 44100 and recovered.shape[0] > 0 and recovered.shape[1] == 2
        assert np.array_equal(recovered, pcm[:recovered.shape[0]])
        os.remove(decoded_tmp)

        result = aw.analyze(
            librosa, path=staged, complete=False, embed=False, vocal=False
        )
        assert "bpm" in result and "key" in result, result
        assert "outro" not in result and "tail_silence_ms" not in result, result


if "--integration" in sys.argv:
    print("real truncated FLAC integration")
    test("real recovered PCM reaches baseline analysis", run_integration)
else:
    run_lightweight()

if failures:
    print(f"✗ analyzer_decode_test.py: {failures} failure(s)")
    sys.exit(1)
print("✓ analyzer_decode_test.py passed")
