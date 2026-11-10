"""Deterministic CLI tests: real marker files, simulated Docker/audio/time."""
import array
import contextlib
from datetime import datetime, timezone
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "liquidsoap_smoke", os.environ.get(
        "SMOKE_RUNNER_PATH", Path(__file__).with_name("liquidsoap-image-smoke.py")
    )
)
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class SimulatedStation:
    """Boundary adapter; emergency audio remains healthy even without music."""

    def __init__(self, evidence, first_track=2, stalled_at=None, cadence=8,
                 stamp_offset=0, radio_warning_at=None, interrupt_at=None,
                 unparseable_warning=False, late_warning_in_cleanup=False):
        self.evidence = evidence
        self.elapsed = 0
        self.epoch = 1_800_000_000
        self.first_track = first_track
        self.stalled_at = stalled_at
        self.cadence = cadence
        self.stamp_offset = stamp_offset
        self.radio_warning_at = radio_warning_at
        self.interrupt_at = interrupt_at
        self.unparseable_warning = unparseable_warning
        self.late_warning_in_cleanup = late_warning_in_cleanup
        self.decoded_codecs = 0
        self.final_log_reads = 0
        self.removed = False

    def sleep(self, seconds):
        self.elapsed += seconds
        if self.interrupt_at is not None and self.elapsed >= self.interrupt_at:
            raise InterruptedError("simulated SIGTERM")
        state = self.evidence / "state"
        at = min(self.elapsed, self.stalled_at or self.elapsed)
        if at >= self.first_track:
            stamp = (self.epoch + self.first_track + self.stamp_offset
                     + int((at - self.first_track) // self.cadence) * self.cadence)
            (state / "now-playing.json").write_text(json.dumps({
                "timestamp": stamp, "subsonic_id": "a", "title": "Test a",
            }))
        if self.elapsed >= 27:
            voice = "smoke-intro" if self.elapsed >= 42 else "smoke-say"
            (state / "voice-playing.json").write_text(json.dumps({"voiceId": voice}))
        if self.elapsed >= 57:
            (state / "jingle-playing.json").write_text('{}')

    def output(self, args, **_kwargs):
        if args[0] == "ffmpeg":
            self.decoded_codecs += 1
            # A healthy emergency loop cannot prove music is still advancing.
            return array.array("h", [2000] * 44100).tobytes()
        if args[:3] == ("docker", "image", "inspect"):
            return json.dumps([{"Id": "sha256:candidate"}])
        if args[:2] == ("docker", "inspect"):
            return 'true\n'
        if args[:2] == ("docker", "port"):
            return '127.0.0.1:32768\n'
        if args[:2] == ("docker", "stats"):
            return '{"CPUPerc":"12%","MemUsage":"170MiB"}\n'
        if args[:2] == ("docker", "exec"):
            return ''
        return 'container\n'

    def run(self, args, **_kwargs):
        if args[:3] == ["docker", "rm", "-f"]:
            self.removed = True
        if args[:2] == ["docker", "exec"] and self.late_warning_in_cleanup:
            if self.decoded_codecs == 4:
                self.final_log_reads += 1
                if self.final_log_reads > 1:
                    return subprocess.CompletedProcess(args, 0, stdout='Latency is too high', stderr='')
        if args[:2] == ["docker", "exec"] and self.radio_warning_at is not None:
            if self.elapsed >= self.radio_warning_at:
                at = datetime.fromtimestamp(self.epoch + self.radio_warning_at, timezone.utc)
                log = at.strftime('%Y/%m/%d %H:%M:%S') + ' [clock.stream_mp3:2] Latency is too high'
                if self.unparseable_warning:
                    log = 'Latency is too high without a timestamp'
                return subprocess.CompletedProcess(args, 0, stdout=log, stderr='')
        return subprocess.CompletedProcess(args, 0, stdout='', stderr='')


class SmokeCliTests(unittest.TestCase):
    def run_station(self, **scenario):
        with tempfile.TemporaryDirectory() as root:
            evidence = Path(root) / "evidence"
            evidence.mkdir()
            station = SimulatedStation(evidence, **scenario)
            capture = contextlib.nullcontext(io.BytesIO(b'healthy audio'))
            with (
                patch.object(sys, "argv", ["smoke", "candidate", "--seconds", "300"]),
                patch.object(smoke.tempfile, "mkdtemp", return_value=str(evidence)),
                patch.object(smoke, "tone"),
                patch.object(smoke.time, "monotonic", side_effect=lambda: station.elapsed),
                patch.object(smoke.time, "time", side_effect=lambda: station.epoch + station.elapsed),
                patch.object(smoke.time, "sleep", side_effect=station.sleep),
                patch.object(smoke.subprocess, "check_output", side_effect=station.output),
                patch.object(smoke.subprocess, "run", side_effect=station.run),
                patch.object(smoke.urllib.request, "urlopen", return_value=capture),
                contextlib.redirect_stdout(io.StringIO()),
            ):
                try:
                    smoke.main()
                except (AssertionError, RuntimeError, InterruptedError) as error:
                    station.status = json.loads((evidence / "status.json").read_text())
                    station.stats = (evidence / "stats.jsonl").read_text()
                    station.logs = (evidence / "radio.log").read_text()
                    station.intervals = []
                    self.assertEqual(station.status["phase"], "failed")
                    self.assertTrue(station.status["container_removed"])
                    self.assertTrue(station.stats, "CPU diagnostics must survive failure")
                    return error, station.removed
            if not (evidence / "status.json").exists():
                # Allows the stalled-music regression to demonstrate an old
                # runner's false success, rather than failing on missing files.
                return None, station.removed
            station.status = json.loads((evidence / "status.json").read_text())
            station.intervals = [json.loads(line) for line in (evidence / "intervals.jsonl").read_text().splitlines()]
            self.assertEqual(station.status["phase"], "passed")
            self.assertTrue(station.intervals)
            if station.radio_warning_at is not None:
                self.assertEqual(len(station.status["startup_latency_warnings"]), 1)
            return None, station.removed

    def test_stalled_music_fails_even_when_emergency_audio_is_healthy(self):
        error, removed = self.run_station(stalled_at=58)
        self.assertIsNotNone(error, "Eight early starts and healthy emergency audio must fail")
        self.assertIn("Stale now-playing", str(error))
        self.assertTrue(removed, "Failure must remove the disposable container")

    def test_normal_music_continues_across_multiple_intervals(self):
        error, removed = self.run_station()
        self.assertIsNone(error)
        self.assertTrue(removed)

    def test_delayed_start_within_allowance_passes(self):
        error, removed = self.run_station(first_track=25)
        self.assertIsNone(error)
        self.assertTrue(removed)

    def test_missing_music_after_startup_allowance_fails(self):
        error, removed = self.run_station(first_track=31)
        self.assertIn("startup allowance", str(error))
        self.assertTrue(removed)

    def test_fresh_but_insufficient_interval_progress_fails(self):
        error, removed = self.run_station(cadence=24)
        self.assertIn("Music stopped advancing", str(error))
        self.assertTrue(removed)

    def test_repeated_observation_cannot_make_an_old_timestamp_fresh(self):
        error, removed = self.run_station(stamp_offset=-120)
        self.assertIn("Stale now-playing", str(error))
        self.assertTrue(removed)

    def test_future_timestamp_cannot_extend_freshness(self):
        error, removed = self.run_station(stamp_offset=120)
        self.assertIn("in the future", str(error))
        self.assertTrue(removed)

    def test_latency_warning_in_file_log_fails_with_healthy_markers(self):
        error, removed = self.run_station(radio_warning_at=90)
        self.assertIn("Stream clock fell behind", str(error))
        self.assertTrue(removed)

    def test_startup_clock_warning_is_retained_without_failing_steady_progress(self):
        error, removed = self.run_station(radio_warning_at=3)
        self.assertIsNone(error)
        self.assertTrue(removed)

    def test_unparseable_warning_cannot_use_startup_allowance(self):
        error, removed = self.run_station(radio_warning_at=3, unparseable_warning=True)
        self.assertIn("outside startup allowance", str(error))
        self.assertTrue(removed)

    def test_interruption_preserves_failed_status_and_removes_container(self):
        error, removed = self.run_station(interrupt_at=70)
        self.assertIn("simulated SIGTERM", str(error))
        self.assertTrue(removed)

    def test_final_diagnostic_failure_cannot_leave_a_passed_result(self):
        error, removed = self.run_station(late_warning_in_cleanup=True)
        self.assertIn("outside startup allowance", str(error))
        self.assertTrue(removed)


if __name__ == "__main__":
    unittest.main()
