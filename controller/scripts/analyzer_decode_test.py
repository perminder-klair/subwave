#!/usr/bin/env python3
"""Dependency-light predecode recovery tests for incomplete FLAC inputs.

The default suite uses stdlib WAV fixtures and a small SoundFile adapter. Pass
``--integration`` to generate and analyze a real frame-truncated FLAC with the
installed analyzer dependencies and ffmpeg. ``--model-integration`` additionally
runs the public heavy worker path with the supported CLAP and Demucs models; it
requires their public weights to be available or downloadable in the runtime's
configured caches.
"""

import functools
import glob
import http.server
import os
import resource
import subprocess
import sys
import tempfile
import threading
import time
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
    def __init__(
        self, path, fail_source=False, wav_format="WAV", wav_subtype="PCM_16",
        wav_samplerate=None, wav_channels=None, read_error=False,
    ):
        self.path = path
        self._reader = None
        if path.endswith(".wav"):
            self._reader = wave.open(path, "rb")
            self.format = wav_format
            self.subtype = wav_subtype
            self.samplerate = (
                self._reader.getframerate() if wav_samplerate is None else wav_samplerate
            )
            self.channels = self._reader.getnchannels() if wav_channels is None else wav_channels
            self.read_error = read_error
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
        if self.read_error:
            raise RuntimeError("PCM read failed")
        assert frames == 4096
        assert dtype == "int16"
        assert always_2d is True
        data = self._reader.readframes(frames)
        frame_bytes = self.channels * self._reader.getsampwidth()
        return _AudioFrames(len(data) // frame_bytes, self.channels)


class _SoundFileModule(types.ModuleType):
    def __init__(self, fail_source=False, **wav_options):
        super().__init__("soundfile")
        self.fail_source = fail_source
        self.wav_options = wav_options

    def SoundFile(self, path):
        return _SoundFile(path, fail_source=self.fail_source, **self.wav_options)


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
        elif output == "padded-header":
            _write_pcm_wav(wav, frames=0)
            with open(wav, "ab") as out:
                out.write(b"\0" * 2048)
        elif output == "oversize":
            _write_pcm_wav(wav, frames=4096, channels=channels)
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
        assert int(command[command.index("-fs") + 1]) == aw.PREDECODE_FFMPEG_MAX_BYTES, command
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
        _SoundFileModule(wav_format="WAVEX"), _runner(calls=calls, channels=4)
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


def t_complete_and_unknown_nonzero_outputs_stay_strict():
    for complete in (True, None):
        calls = []
        with tempfile.TemporaryDirectory() as tmp, _PatchedDecode(
            _SoundFileModule(fail_source=True), _runner(returncode=7, calls=calls)
        ):
            source = _source(tmp)
            decoded = aw.ensure_fast_decode(source, complete=complete)
            assert decoded == (source, None), (complete, decoded)
            assert len(calls) == 1, (complete, calls)
            assert not os.path.exists(calls[0][-1]), (complete, calls[0][-1])


def t_signal_status_and_unusable_outputs_are_rejected_and_removed():
    cases = [
        ("signal", _SoundFileModule(), "valid", -9),
        ("empty", _SoundFileModule(), "empty", 0),
        ("padded header", _SoundFileModule(), "padded-header", 0),
        ("corrupt", _SoundFileModule(), "corrupt", 0),
        ("wrong container", _SoundFileModule(wav_format="AIFF"), "valid", 0),
        ("wrong PCM subtype", _SoundFileModule(wav_subtype="FLOAT"), "valid", 0),
        ("invalid sample rate", _SoundFileModule(wav_samplerate=0), "valid", 0),
        ("invalid channels", _SoundFileModule(wav_channels=0), "valid", 0),
        ("PCM read error", _SoundFileModule(read_error=True), "valid", 0),
    ]
    for label, sf_module, output, returncode in cases:
        calls = []
        runner = _runner(output=output, returncode=returncode, calls=calls)
        with tempfile.TemporaryDirectory() as tmp, _PatchedDecode(sf_module, runner):
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


def t_oversize_recovery_output_is_rejected_and_removed():
    original_limit = getattr(aw, "PREDECODE_MAX_BYTES", None)
    original_ffmpeg_limit = getattr(aw, "PREDECODE_FFMPEG_MAX_BYTES", None)
    aw.PREDECODE_MAX_BYTES = 2048
    aw.PREDECODE_FFMPEG_MAX_BYTES = 1024
    try:
        for returncode in (0, 7):
            calls = []
            with tempfile.TemporaryDirectory() as tmp, _PatchedDecode(
                _SoundFileModule(), _runner(
                    output="oversize", returncode=returncode, calls=calls
                )
            ):
                source = _source(tmp)
                assert aw.ensure_fast_decode(source, complete=False) == (source, None)
                assert not os.path.exists(calls[0][-1]), calls
    finally:
        if original_limit is None:
            del aw.PREDECODE_MAX_BYTES
        else:
            aw.PREDECODE_MAX_BYTES = original_limit
        if original_ffmpeg_limit is None:
            del aw.PREDECODE_FFMPEG_MAX_BYTES
        else:
            aw.PREDECODE_FFMPEG_MAX_BYTES = original_ffmpeg_limit


def t_legacy_predecode_rejects_a_cap_stopped_output():
    calls = []
    original_limit = aw.PREDECODE_MAX_BYTES
    original_ffmpeg_limit = aw.PREDECODE_FFMPEG_MAX_BYTES
    aw.PREDECODE_MAX_BYTES = 32768
    aw.PREDECODE_FFMPEG_MAX_BYTES = 1024
    try:
        with tempfile.TemporaryDirectory() as tmp, _PatchedDecode(
            _SoundFileModule(fail_source=True), _runner(
                output="oversize", calls=calls
            )
        ):
            source = _source(tmp, header=b"OggS", name="legacy.audio")
            assert aw.ensure_fast_decode(source) == (source, None)
            assert int(calls[0][calls[0].index("-fs") + 1]) == 1024, calls[0]
            assert not os.path.exists(calls[0][-1]), calls
    finally:
        aw.PREDECODE_MAX_BYTES = original_limit
        aw.PREDECODE_FFMPEG_MAX_BYTES = original_ffmpeg_limit


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


def t_owned_url_download_is_removed_when_predecode_is_interrupted():
    with tempfile.TemporaryDirectory() as tmp:
        source = _source(tmp)
        original_fetch = aw.fetch_audio
        original_decode = aw.ensure_fast_decode
        original_numpy = sys.modules.get("numpy")
        aw.fetch_audio = lambda _url: (source, False)
        sys.modules["numpy"] = types.ModuleType("numpy")

        def interrupt(_path, complete=None):
            assert complete is False
            raise KeyboardInterrupt()

        aw.ensure_fast_decode = interrupt
        try:
            try:
                aw.analyze(object(), url="http://example.test/audio")
                raise AssertionError("KeyboardInterrupt was swallowed")
            except KeyboardInterrupt:
                pass
            assert not os.path.exists(source), source
        finally:
            aw.fetch_audio = original_fetch
            aw.ensure_fast_decode = original_decode
            if original_numpy is None:
                sys.modules.pop("numpy", None)
            else:
                sys.modules["numpy"] = original_numpy


def t_partial_url_download_is_removed_when_fetch_is_interrupted():
    with tempfile.TemporaryDirectory() as tmp:
        download = os.path.join(tmp, "owned.audio")
        concurrent = os.path.join(tmp, "concurrent.tmp")
        original_mkstemp = aw.tempfile.mkstemp
        original_urlopen = aw.urllib.request.urlopen
        created_fd = None
        concurrent_fd = None

        def mkstemp(*_args, **_kwargs):
            nonlocal created_fd
            fd = os.open(download, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
            created_fd = fd
            return fd, download

        class InterruptedResponse:
            def __init__(self):
                self.reads = 0

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _size):
                nonlocal concurrent_fd
                self.reads += 1
                if self.reads == 1:
                    return b"partial"
                concurrent_fd = os.open(
                    concurrent, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600
                )
                raise KeyboardInterrupt()

        aw.tempfile.mkstemp = mkstemp
        aw.urllib.request.urlopen = lambda *_args, **_kwargs: InterruptedResponse()
        try:
            try:
                aw.fetch_audio("http://example.test/audio")
                raise AssertionError("KeyboardInterrupt was swallowed")
            except KeyboardInterrupt:
                pass
            assert not os.path.exists(download), download
            assert concurrent_fd is not None and concurrent_fd != created_fd
            os.write(concurrent_fd, b"still open")
        finally:
            if concurrent_fd is not None:
                try:
                    os.close(concurrent_fd)
                except OSError:
                    pass
            aw.tempfile.mkstemp = original_mkstemp
            aw.urllib.request.urlopen = original_urlopen


def run_lightweight():
    print("incomplete FLAC predecode")
    test("known-incomplete openable FLAC is predecoded", t_known_incomplete_openable_flac_is_predecoded)
    test("complete and unknown FLAC keep the original path", t_complete_and_unknown_openable_flac_keep_original)
    test("codec identity does not come from the filename", t_incomplete_non_flac_keeps_original)
    test("native FLAC header recovers an unopenable .audio file", t_unopenable_native_flac_is_recovered_without_extension)
    test("native multichannel and legacy conversion stay supported", t_recovery_preserves_native_multichannel_and_legacy_conversion)
    test("positive nonzero output is recovery-only", t_positive_nonzero_valid_pcm_is_accepted_only_for_recovery)
    test("complete and unknown nonzero outputs stay strict", t_complete_and_unknown_nonzero_outputs_stay_strict)
    test("signals and unusable WAVs are rejected and removed", t_signal_status_and_unusable_outputs_are_rejected_and_removed)
    test("timeout and missing ffmpeg preserve fallback", t_timeout_missing_ffmpeg_and_validation_errors_fall_back_cleanly)
    test("over-limit recovery WAVs are rejected and removed", t_oversize_recovery_output_is_rejected_and_removed)
    test("cap-stopped legacy WAVs retain per-load fallback", t_legacy_predecode_rejects_a_cap_stopped_output)
    test("missing output and interruption clean temporary WAVs", t_missing_nonzero_output_and_interruption_clean_up)
    test("predecode interruption cleans the owned URL download", t_owned_url_download_is_removed_when_predecode_is_interrupted)
    test("fetch interruption cleans its partial URL download", t_partial_url_download_is_removed_when_fetch_is_interrupted)


def run_multichannel_integration():
    try:
        import numpy as np
        import soundfile as sf
    except ImportError as err:
        raise RuntimeError(f"integration dependencies unavailable: {err}") from err
    ffmpeg = aw.shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("integration dependency unavailable: ffmpeg")

    with tempfile.TemporaryDirectory() as tmp:
        source = os.path.join(tmp, "four-channel.audio")
        probe_wav = os.path.join(tmp, "four-channel.wav")
        rng = np.random.default_rng(1670)
        pcm = rng.integers(-16000, 16000, size=(44100 * 2, 4), dtype=np.int16)
        sf.write(source, pcm, 44100, subtype="PCM_16", format="FLAC")
        subprocess.run(
            [ffmpeg, "-v", "error", "-y", "-i", source,
             "-map", "0:a:0", "-acodec", "pcm_s16le", "-f", "wav", probe_wav],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        )
        with sf.SoundFile(probe_wav) as probe:
            assert probe.format == "WAVEX", probe.format
            assert probe.subtype == "PCM_16", probe.subtype
            block = probe.read(frames=4096, dtype="int16", always_2d=True)
            assert block.shape == (4096, 4), block.shape
        os.remove(probe_wav)

        decoded, decoded_tmp = aw.ensure_fast_decode(source, complete=False)
        assert decoded == decoded_tmp and decoded != source, (decoded, decoded_tmp)
        assert os.path.getsize(decoded) <= aw.PREDECODE_MAX_BYTES
        with sf.SoundFile(decoded) as recovered:
            assert recovered.format == "WAVEX", recovered.format
            assert recovered.channels == 4, recovered.channels
            block = recovered.read(frames=4096, dtype="int16", always_2d=True)
            assert block.shape == (4096, 4), block.shape
        os.remove(decoded_tmp)


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
        assert os.path.getsize(decoded) <= aw.PREDECODE_MAX_BYTES
        recovered, recovered_sr = sf.read(decoded, dtype="int16", always_2d=True)
        assert recovered_sr == 44100 and recovered.shape[0] > 0 and recovered.shape[1] == 2
        assert np.array_equal(recovered, pcm[:recovered.shape[0]])
        os.remove(decoded_tmp)

        result = aw.analyze(
            librosa, path=staged, complete=False, embed=False, vocal=False
        )
        assert "bpm" in result and "key" in result, result
        assert "outro" not in result and "tail_silence_ms" not in result, result


def run_bounded_recovery_integration():
    try:
        import numpy as np
        import librosa
        import soundfile as sf
    except ImportError as err:
        raise RuntimeError(f"integration dependencies unavailable: {err}") from err
    ffmpeg = aw.shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("integration dependency unavailable: ffmpeg")

    with tempfile.TemporaryDirectory() as tmp:
        source = os.path.join(tmp, "long-compressible.flac")
        staged = os.path.join(tmp, "long-compressible-capped.audio")
        sample_rate = 44100
        channels = 2
        raw_bytes_per_second = sample_rate * channels * 2
        noise_seconds = max(
            100,
            int((aw.ANALYZE_MAX_BYTES / raw_bytes_per_second) * 1.25) + 1,
        )
        silence = np.zeros((sample_rate, channels), dtype=np.int16)
        rng = np.random.default_rng(1674)
        with sf.SoundFile(
            source, mode="w", samplerate=sample_rate, channels=channels,
            subtype="PCM_16", format="FLAC",
        ) as encoded:
            for _ in range(600):
                encoded.write(silence)
            for _ in range(noise_seconds):
                encoded.write(
                    rng.integers(-16000, 16000, size=silence.shape, dtype=np.int16)
                )
        assert os.path.getsize(source) > aw.ANALYZE_MAX_BYTES, os.path.getsize(source)
        with open(source, "rb") as full, open(staged, "wb") as capped:
            capped.write(full.read(aw.ANALYZE_MAX_BYTES))
        assert os.path.getsize(staged) == aw.ANALYZE_MAX_BYTES

        probe = subprocess.run(
            [ffmpeg, "-v", "error", "-i", staged, "-f", "null", "-"],
            check=False, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        )
        assert probe.stderr, "the capped fixture must end in a real decoder error"

        decoded, decoded_tmp = aw.ensure_fast_decode(staged, complete=False)
        assert decoded == decoded_tmp and decoded != staged, (decoded, decoded_tmp)
        decoded_size = os.path.getsize(decoded)
        assert 1024 < decoded_size <= aw.PREDECODE_MAX_BYTES, decoded_size
        with sf.SoundFile(decoded) as recovered:
            assert recovered.format == "WAV", recovered.format
            assert recovered.channels == channels, recovered.channels
            recovered_seconds = recovered.frames / recovered.samplerate
            assert recovered_seconds >= aw.ANALYZE_SECONDS * 3, recovered_seconds
            offsets = aw.clap_window_offsets(recovered_seconds, aw.ANALYZE_SECONDS)
            assert len(offsets) == 3, offsets
            assert offsets[-1] + aw.ANALYZE_SECONDS <= recovered_seconds, offsets

        # The bounded file must still satisfy every consumer of an incomplete
        # recovery: all CLAP windows across its recovered span, the baseline
        # head, and the heavy vocal head. Outro and tail-vocal work are gated
        # off by complete=False and are asserted through analyze() above.
        class ProbeEmbedder:
            def __init__(self):
                self.windows = []

            def batches_windows(self):
                return False

            def embed(self, audio, sample_rate):
                self.windows.append((len(audio), sample_rate))
                return [1.0, 0.0]

        embedder = ProbeEmbedder()
        embedding = aw.embed_windows(embedder, decoded, librosa, recovered_seconds)
        assert embedding == [1.0, 0.0], embedding
        assert len(embedder.windows) == 3, embedder.windows
        assert all(
            sample_rate == aw.CLAP_SR
            and frames >= int(aw.CLAP_SR * (aw.ANALYZE_SECONDS - 0.1))
            for frames, sample_rate in embedder.windows
        ), embedder.windows
        baseline, baseline_sr = aw.load_audio(
            librosa, decoded, sr=aw.ANALYZE_SR, mono=False,
            duration=aw.ANALYZE_SECONDS,
        )
        assert baseline_sr == aw.ANALYZE_SR
        assert baseline.shape[-1] >= int(aw.ANALYZE_SR * (aw.ANALYZE_SECONDS - 0.1))
        vocal_head, vocal_sr = aw.load_audio(
            librosa, decoded, sr=aw.DEMUCS_SR, mono=False,
            duration=aw.ANALYZE_SECONDS,
        )
        assert vocal_sr == aw.DEMUCS_SR
        assert vocal_head.shape[-1] >= int(aw.DEMUCS_SR * (aw.ANALYZE_SECONDS - 0.1))
        os.remove(decoded_tmp)


def run_real_positive_status_recovery_integration():
    try:
        import numpy as np
        import soundfile as sf
    except ImportError as err:
        raise RuntimeError(f"integration dependencies unavailable: {err}") from err
    ffmpeg = aw.shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("integration dependency unavailable: ffmpeg")

    with tempfile.TemporaryDirectory() as tmp:
        source = os.path.join(tmp, "positive-status-source.flac")
        staged = os.path.join(tmp, "positive-status-capped.audio")
        rng = np.random.default_rng(1674)
        pcm = rng.integers(-16000, 16000, size=(44100 * 100, 2), dtype=np.int16)
        sf.write(source, pcm, 44100, subtype="PCM_16", format="FLAC")
        with open(source, "rb") as full, open(staged, "wb") as capped:
            capped.write(full.read(aw.ANALYZE_MAX_BYTES))

        natural_wav = os.path.join(tmp, "natural.wav")
        natural = subprocess.run(
            [ffmpeg, "-v", "error", "-y", "-i", staged,
             "-fs", str(aw.PREDECODE_FFMPEG_MAX_BYTES),
             "-map", "0:a:0", "-acodec", "pcm_s16le", "-f", "wav", natural_wav],
            check=False, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        )
        assert natural.stderr, "fixture must end in a real decoder error"
        assert aw._usable_recovery_wav(sf, natural_wav), natural.stderr[-500:]
        natural_pcm, natural_sr = sf.read(natural_wav, dtype="int16", always_2d=True)
        assert natural_sr == 44100 and natural_pcm.shape[0] > 0
        os.remove(natural_wav)

        # The current published ffmpeg treats a recoverable truncated final
        # frame as a successful transcode (rc=0). Inject only the positive exit
        # status after the real command produced its real partial WAV, matching
        # older/platform ffmpeg behavior without fabricating the media/output.
        original_run = aw.subprocess.run
        decoded_outputs = []

        def positive_after_real_decode(command, **kwargs):
            run_kwargs = dict(kwargs)
            run_kwargs["check"] = False
            completed = original_run(command, **run_kwargs)
            decoded_outputs.append(command[-1])
            assert completed.returncode == 0, completed.returncode
            assert aw._usable_recovery_wav(sf, command[-1]), command[-1]
            raise subprocess.CalledProcessError(
                7, command, stderr=(completed.stderr or b"") + b"\ncontrolled positive status"
            )

        aw.subprocess.run = positive_after_real_decode
        try:
            decoded, decoded_tmp = aw.ensure_fast_decode(staged, complete=False)
        finally:
            aw.subprocess.run = original_run
        assert decoded == decoded_tmp and decoded != staged, (decoded, decoded_tmp)
        recovered, recovered_sr = sf.read(decoded, dtype="int16", always_2d=True)
        assert recovered_sr == 44100 and recovered.shape[0] > 0
        assert np.array_equal(recovered, pcm[:recovered.shape[0]])
        os.remove(decoded_tmp)
        assert all(not os.path.exists(path) for path in decoded_outputs)
        print(
            "    positive-status evidence: "
            f"natural ffmpeg rc={natural.returncode}; injected rc=7 after real decode"
        )


def run_complete_legacy_cap_fallback_integration():
    try:
        import librosa
        import soundfile as sf
    except ImportError as err:
        raise RuntimeError(f"integration dependencies unavailable: {err}") from err
    ffmpeg = aw.shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("integration dependency unavailable: ffmpeg")

    with tempfile.TemporaryDirectory() as tmp:
        source = os.path.join(tmp, "complete-legacy.m4a")
        subprocess.run(
            [ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i",
             "sine=frequency=330:sample_rate=44100:duration=390",
             "-ac", "2", "-c:a", "aac", "-b:a", "96k", source],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        )
        try:
            with sf.SoundFile(source):
                raise AssertionError("legacy fixture unexpectedly opened through libsndfile")
        except RuntimeError:
            pass

        original_run = aw.subprocess.run
        predecodes = []

        def recording_run(command, **kwargs):
            completed = original_run(command, **kwargs)
            if command[-1].endswith(".wav"):
                with sf.SoundFile(command[-1]) as recovered:
                    predecodes.append({
                        "path": command[-1],
                        "bytes": os.path.getsize(command[-1]),
                        "seconds": recovered.frames / recovered.samplerate,
                    })
            return completed

        aw.subprocess.run = recording_run
        try:
            decoded, decoded_tmp = aw.ensure_fast_decode(source, complete=True)
        finally:
            aw.subprocess.run = original_run
        assert (decoded, decoded_tmp) == (source, None)
        assert len(predecodes) == 1, predecodes
        assert aw.PREDECODE_FFMPEG_MAX_BYTES <= predecodes[0]["bytes"] <= aw.PREDECODE_MAX_BYTES
        assert predecodes[0]["seconds"] < 390 - 1, predecodes
        assert not os.path.exists(predecodes[0]["path"]), predecodes

        duration = float(librosa.get_duration(path=source))
        assert 389.0 <= duration <= 391.0, duration
        result = aw.analyze(
            librosa, path=source, complete=True, embed=False, vocal=False,
        )
        assert "bpm" in result and "key" in result, result
        assert isinstance(result.get("outro"), dict), result
        assert result["outro"].get("startMs", 0) > aw.PREDECODE_FFMPEG_MAX_BYTES / (44100 * 2 * 2) * 1000
        print(
            "    legacy metrics: "
            f"predecode={predecodes[0]['seconds']:.3f}s, "
            f"source duration={duration:.3f}s, outro start={result['outro']['startMs']}ms"
        )


def run_real_cleanup_integration():
    try:
        import numpy as np
        import librosa
        import soundfile as sf
    except ImportError as err:
        raise RuntimeError(f"integration dependencies unavailable: {err}") from err
    if not aw.shutil.which("ffmpeg"):
        raise RuntimeError("integration dependency unavailable: ffmpeg")

    with tempfile.TemporaryDirectory() as tmp:
        complete_source = os.path.join(tmp, "cleanup-source.flac")
        rng = np.random.default_rng(1674)
        pcm = rng.integers(-16000, 16000, size=(44100 * 100, 2), dtype=np.int16)
        sf.write(complete_source, pcm, 44100, subtype="PCM_16", format="FLAC")

        # A real but unusably short FLAC reaches real ffmpeg, fails analysis,
        # and still releases both levels of temporary ownership.
        failed_source = os.path.join(tmp, "owned-failed.audio")
        with open(complete_source, "rb") as source, open(failed_source, "wb") as failed:
            failed.write(source.read(4))
        original_fetch = aw.fetch_audio
        aw.fetch_audio = lambda _url: (failed_source, False)
        before = set(glob.glob("/tmp/swanalyze_dec_*.wav"))
        failed = False
        try:
            try:
                aw.analyze(
                    librosa, url="http://example.test/failed.flac",
                    embed=False, vocal=False,
                )
            except Exception:  # noqa: BLE001 — this is the expected public failure
                failed = True
        finally:
            aw.fetch_audio = original_fetch
        assert failed, "invalid real FLAC unexpectedly analyzed"
        assert not os.path.exists(failed_source), failed_source
        assert set(glob.glob("/tmp/swanalyze_dec_*.wav")) == before

        # Interruption is necessarily controlled. Let real ffmpeg fully produce
        # a real recovery WAV first, then raise KeyboardInterrupt at the process
        # boundary and prove neither the WAV nor URL-owned source is stranded.
        interrupted_source = os.path.join(tmp, "owned-interrupted.audio")
        with open(complete_source, "rb") as source, open(interrupted_source, "wb") as staged:
            staged.write(source.read(aw.ANALYZE_MAX_BYTES))
        decoded_outputs = []
        original_fetch = aw.fetch_audio
        original_run = aw.subprocess.run
        aw.fetch_audio = lambda _url: (interrupted_source, False)

        def interrupt_after_real_decode(command, **kwargs):
            run_kwargs = dict(kwargs)
            run_kwargs["check"] = False
            completed = original_run(command, **run_kwargs)
            decoded_outputs.append(command[-1])
            assert completed.returncode == 0, completed.returncode
            assert os.path.getsize(command[-1]) > 1024
            raise KeyboardInterrupt()

        aw.subprocess.run = interrupt_after_real_decode
        try:
            try:
                aw.analyze(
                    librosa, url="http://example.test/interrupted.flac",
                    embed=False, vocal=False,
                )
                raise AssertionError("KeyboardInterrupt was swallowed")
            except KeyboardInterrupt:
                pass
        finally:
            aw.fetch_audio = original_fetch
            aw.subprocess.run = original_run
        assert not os.path.exists(interrupted_source), interrupted_source
        assert decoded_outputs and all(not os.path.exists(path) for path in decoded_outputs)


def run_multichannel_model_integration():
    try:
        import numpy as np
        import librosa
        import soundfile as sf
    except ImportError as err:
        raise RuntimeError(f"model integration dependencies unavailable: {err}") from err
    if not aw.shutil.which("ffmpeg"):
        raise RuntimeError("model integration dependency unavailable: ffmpeg")

    with tempfile.TemporaryDirectory() as tmp:
        source = os.path.join(tmp, "four-channel-model.flac")
        sample_rate = 44100
        frames = sample_rate * 6
        timeline = np.arange(frames, dtype=np.float32) / sample_rate
        pcm = np.stack([
            0.15 * np.sin(2.0 * np.pi * 220.0 * timeline),
            0.15 * np.sin(2.0 * np.pi * 330.0 * timeline),
            0.10 * np.sin(2.0 * np.pi * 440.0 * timeline),
            0.10 * np.sin(2.0 * np.pi * 550.0 * timeline),
        ], axis=1)
        sf.write(source, pcm, sample_rate, subtype="PCM_16", format="FLAC")

        decoded = []
        original_decode = aw.ensure_fast_decode

        def recording_decode(path, complete=None):
            use_path, tmp_path = original_decode(path, complete=complete)
            if tmp_path is not None:
                with sf.SoundFile(tmp_path) as recovered:
                    decoded.append({
                        "path": tmp_path,
                        "bytes": os.path.getsize(tmp_path),
                        "format": recovered.format,
                        "channels": recovered.channels,
                    })
            return use_path, tmp_path

        aw.ensure_fast_decode = recording_decode
        try:
            result = aw.analyze(
                librosa, path=source, complete=False, embed=True, vocal=True,
            )
        finally:
            aw.ensure_fast_decode = original_decode
        embedding = result.get("audio_embedding")
        assert isinstance(embedding, list) and len(embedding) == aw.CLAP_EMBED_DIM, (
            None if embedding is None else len(embedding)
        )
        assert all(np.isfinite(embedding)), embedding[:8]
        assert abs(float(np.linalg.norm(embedding)) - 1.0) < 1e-4
        assert isinstance(result.get("vocal_ranges"), list), result.keys()
        assert "outro" not in result and "tail_silence_ms" not in result, result
        assert len(decoded) == 1, decoded
        assert decoded[0]["format"] == "WAVEX", decoded
        assert decoded[0]["channels"] == 4, decoded
        assert decoded[0]["bytes"] <= aw.PREDECODE_MAX_BYTES, decoded
        assert not os.path.exists(decoded[0]["path"]), decoded


def run_bounded_model_integration():
    try:
        import numpy as np
        import librosa
        import soundfile as sf
    except ImportError as err:
        raise RuntimeError(f"model integration dependencies unavailable: {err}") from err
    if not aw.shutil.which("ffmpeg"):
        raise RuntimeError("model integration dependency unavailable: ffmpeg")

    with tempfile.TemporaryDirectory() as tmp:
        source = os.path.join(tmp, "model-ceiling.flac")
        sample_rate = 44100
        channels = 2
        silence = np.zeros((sample_rate, channels), dtype=np.int16)
        rng = np.random.default_rng(1674)
        raw_bytes_per_second = sample_rate * channels * 2
        noise_seconds = max(
            100,
            int((aw.ANALYZE_MAX_BYTES / raw_bytes_per_second) * 1.25) + 1,
        )
        with sf.SoundFile(
            source, mode="w", samplerate=sample_rate, channels=channels,
            subtype="PCM_16", format="FLAC",
        ) as encoded:
            for _ in range(600):
                encoded.write(silence)
            for _ in range(noise_seconds):
                encoded.write(
                    rng.integers(-16000, 16000, size=silence.shape, dtype=np.int16)
                )
        assert os.path.getsize(source) > aw.ANALYZE_MAX_BYTES

        class QuietHandler(http.server.SimpleHTTPRequestHandler):
            def log_message(self, _format, *_args):
                pass

        class QuietServer(http.server.ThreadingHTTPServer):
            def handle_error(self, _request, _client_address):
                pass

        handler = functools.partial(QuietHandler, directory=tmp)
        server = QuietServer(("127.0.0.1", 0), handler)
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()

        actual_embedder = aw.get_embedder(force=True)
        actual_detector = aw.get_vocal_detector(force=True)
        assert actual_embedder is not None, "CLAP model did not load"
        assert actual_detector is not None, "Demucs model did not load"

        class RecordingEmbedder:
            def __init__(self, delegate):
                self.delegate = delegate
                self.windows = []

            def batches_windows(self):
                return self.delegate.batches_windows()

            def embed(self, audio, sample_rate):
                self.windows.append((len(audio), sample_rate))
                return self.delegate.embed(audio, sample_rate)

            def embed_many(self, windows, sample_rate):
                self.windows.extend((len(audio), sample_rate) for audio in windows)
                return self.delegate.embed_many(windows, sample_rate)

        class RecordingDetector:
            def __init__(self, delegate):
                self.delegate = delegate
                self.inputs = []

            def separate(self, audio):
                self.inputs.append(tuple(audio.shape))
                return self.delegate.separate(audio)

            def detect(self, *args, **kwargs):
                return self.delegate.detect(*args, **kwargs)

        embedder = RecordingEmbedder(actual_embedder)
        detector = RecordingDetector(actual_detector)
        downloads = []
        decodes = []
        original_fetch = aw.fetch_audio
        original_decode = aw.ensure_fast_decode
        original_get_embedder = aw.get_embedder
        original_get_detector = aw.get_vocal_detector

        def recording_fetch(url):
            path, complete = original_fetch(url)
            downloads.append(path)
            return path, complete

        def recording_decode(path, complete=None):
            use_path, tmp_path = original_decode(path, complete=complete)
            if tmp_path is not None:
                with sf.SoundFile(tmp_path) as recovered:
                    decodes.append({
                        "path": tmp_path,
                        "bytes": os.path.getsize(tmp_path),
                        "seconds": recovered.frames / recovered.samplerate,
                        "channels": recovered.channels,
                    })
            return use_path, tmp_path

        aw.fetch_audio = recording_fetch
        aw.ensure_fast_decode = recording_decode
        aw.get_embedder = lambda force=False: embedder
        aw.get_vocal_detector = lambda force=False: detector
        started = time.monotonic()
        try:
            url = f"http://127.0.0.1:{server.server_port}/{os.path.basename(source)}"
            result = aw.analyze(librosa, url=url, embed=True, vocal=True)
        finally:
            elapsed = time.monotonic() - started
            aw.fetch_audio = original_fetch
            aw.ensure_fast_decode = original_decode
            aw.get_embedder = original_get_embedder
            aw.get_vocal_detector = original_get_detector
            server.shutdown()
            server.server_close()
            server_thread.join(timeout=5)

        embedding = result.get("audio_embedding")
        assert isinstance(embedding, list) and len(embedding) == aw.CLAP_EMBED_DIM
        assert all(np.isfinite(embedding))
        assert abs(float(np.linalg.norm(embedding)) - 1.0) < 1e-4
        assert isinstance(result.get("vocal_ranges"), list), result.keys()
        assert all(
            0 <= row["startMs"] < row["endMs"] <= aw.ANALYZE_SECONDS * 1000 + 100
            for row in result["vocal_ranges"]
        ), result["vocal_ranges"]
        assert "bpm" in result and "key" in result, result
        assert "outro" not in result and "tail_silence_ms" not in result, result

        assert len(downloads) == 1 and not os.path.exists(downloads[0]), downloads
        assert len(decodes) == 1, decodes
        assert aw.PREDECODE_FFMPEG_MAX_BYTES <= decodes[0]["bytes"] <= aw.PREDECODE_MAX_BYTES, decodes
        assert decodes[0]["seconds"] >= aw.ANALYZE_SECONDS * 3, decodes
        assert decodes[0]["channels"] == channels, decodes
        assert not os.path.exists(decodes[0]["path"]), decodes
        assert len(embedder.windows) == 3, embedder.windows
        assert all(
            sample_rate == aw.CLAP_SR
            and frames >= int(aw.CLAP_SR * (aw.ANALYZE_SECONDS - 0.1))
            for frames, sample_rate in embedder.windows
        ), embedder.windows
        assert detector.inputs == [
            (channels, int(aw.DEMUCS_SR * aw.ANALYZE_SECONDS))
        ], detector.inputs

        max_rss_mib = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0
        print(
            "    model metrics: "
            f"decoded={decodes[0]['bytes']} bytes, "
            f"recovered={decodes[0]['seconds']:.3f}s, "
            f"CLAP windows={len(embedder.windows)}, "
            f"elapsed={elapsed:.1f}s, max RSS={max_rss_mib:.1f} MiB"
        )


if "--model-integration" in sys.argv:
    print("actual CLAP + Demucs integration")
    test("four-channel WAVEX recovery reaches both real models", run_multichannel_model_integration)
    test("bounded URL recovery reaches all real-model windows", run_bounded_model_integration)
    test("real partial WAV survives a controlled positive ffmpeg status", run_real_positive_status_recovery_integration)
    test("complete legacy cap hit retains full duration and outro", run_complete_legacy_cap_fallback_integration)
    test("real failures and controlled interruption clean owned resources", run_real_cleanup_integration)
elif "--integration" in sys.argv:
    print("real FLAC integration")
    test("real four-channel WAVEX is accepted", run_multichannel_integration)
    test("real truncated PCM reaches baseline analysis", run_integration)
    test("compressible truncated FLAC recovery stays bounded", run_bounded_recovery_integration)
    test("real partial WAV survives a controlled positive ffmpeg status", run_real_positive_status_recovery_integration)
    test("complete legacy cap hit retains full duration and outro", run_complete_legacy_cap_fallback_integration)
    test("real failures and controlled interruption clean owned resources", run_real_cleanup_integration)
else:
    run_lightweight()

if failures:
    print(f"✗ analyzer_decode_test.py: {failures} failure(s)")
    sys.exit(1)
print("✓ analyzer_decode_test.py passed")
