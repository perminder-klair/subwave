#!/usr/bin/env python3
"""Run the baked radio.liq against disposable tones and Icecast, never live state.

Usage: python3 scripts/liquidsoap-image-smoke.py IMAGE [--seconds 180]
Use --seconds 86400 for a soak; the evidence directory is retained and printed.
Requires Docker and ffmpeg on the host. No controller or external services.
"""
import argparse
import array
from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid
import wave


def command(*args):
    return subprocess.check_output(args, text=True, timeout=30).strip()


class TrackProgress:
    """Generated 12s tracks must keep advancing, even if emergency audio works."""

    def __init__(self, startup_seconds=30, interval_seconds=60,
                 min_starts=3, max_marker_age=30):
        self.startup_seconds = startup_seconds
        self.interval_seconds = interval_seconds
        self.min_starts = min_starts
        self.max_marker_age = max_marker_age
        self.track_stamps = set()
        self.latest_stamp = None
        self.window_started = None
        self.window_count = 0

    def observe(self, elapsed, wall_time, marker):
        if marker is not None:
            stamp = marker.get("timestamp")
            if (isinstance(stamp, bool) or not isinstance(stamp, (int, float))
                    or not math.isfinite(stamp)):
                raise RuntimeError("Invalid now-playing timestamp")
            if marker.get("subsonic_id") not in {"a", "b"}:
                raise RuntimeError("Now-playing marker is not a generated music track")
            if stamp > wall_time + 5:
                raise RuntimeError("Now-playing timestamp is in the future")
            if self.latest_stamp is not None and stamp < self.latest_stamp:
                raise RuntimeError("Now-playing timestamp moved backwards")
            self.latest_stamp = stamp
            self.track_stamps.add(stamp)
        if elapsed < self.startup_seconds:
            return None
        if self.latest_stamp is None:
            raise RuntimeError("No music marker before the startup allowance expired")
        age = wall_time - self.latest_stamp
        if age > self.max_marker_age:
            raise RuntimeError(f"Stale now-playing marker: {age:.1f}s old")
        if self.window_started is None:
            self.window_started = elapsed
            self.window_count = len(self.track_stamps)
        if elapsed - self.window_started < self.interval_seconds:
            return None
        starts = len(self.track_stamps) - self.window_count
        interval = {"from": self.window_started, "to": elapsed,
                    "track_starts": starts, "marker_age_seconds": age}
        if starts < self.min_starts:
            raise RuntimeError(f"Music stopped advancing: {starts} starts in "
                               f"{elapsed - self.window_started:.1f}s")
        self.window_started = elapsed
        self.window_count = len(self.track_stamps)
        return interval

    def snapshot(self, wall_time):
        return {"track_starts": len(self.track_stamps),
                "latest_track_timestamp": self.latest_stamp,
                "marker_age_seconds": None if self.latest_stamp is None
                else wall_time - self.latest_stamp}


def write_json(path, value):
    pending = path.with_suffix(".tmp")
    pending.write_text(json.dumps(value, indent=2) + "\n")
    pending.replace(path)


def read_marker(path):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        # A concurrent write can briefly hide a marker; its last valid timestamp
        # must still satisfy the age/progress limits, never a fresh observation.
        return None


def utc_now():
    return datetime.fromtimestamp(time.time(), timezone.utc)


def interrupted(signum, _frame):
    raise InterruptedError(f"Interrupted by signal {signum}")


def check_latency(logs, started_wall_time, startup_seconds=30):
    startup_warnings = []
    for line in logs.splitlines():
        if "Latency is too high" not in line:
            continue
        stamp = re.search(r"\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2}", line)
        if stamp is not None:
            at = datetime.strptime(stamp.group(), "%Y/%m/%d %H:%M:%S").replace(tzinfo=timezone.utc)
            elapsed = at.timestamp() - started_wall_time
            if 0 <= elapsed < startup_seconds:
                startup_warnings.append(line)
                continue
        raise RuntimeError("Stream clock fell behind outside startup allowance (see retained logs)")
    return startup_warnings


def tone(path, frequency, seconds):
    samples = array.array("h", (
        int(5000 * math.sin(2 * math.pi * frequency * i / 44100))
        for i in range(44100 * seconds)
    ))
    if sys.byteorder != "little":
        samples.byteswap()
    with wave.open(str(path), "wb") as audio:
        audio.setparams((1, 2, 44100, 0, "NONE", "not compressed"))
        audio.writeframes(samples.tobytes())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image")
    parser.add_argument("--seconds", type=int, default=180)
    parser.add_argument("--evidence-dir", type=Path,
                        help="New or empty directory for durable evidence and status.json")
    parser.add_argument("--cpus", type=float, default=2)
    parser.add_argument("--memory", default="512m")
    parser.add_argument("--test-source-sha", help="Commit of this test checkout")
    parser.add_argument("--image-source-sha", help="Commit used to build the candidate image")
    args = parser.parse_args()
    if args.seconds < 120:
        parser.error("--seconds must be at least 120")
    if not math.isfinite(args.cpus) or args.cpus <= 0:
        parser.error("--cpus must be positive and finite")
    evidence = (args.evidence_dir or Path(tempfile.mkdtemp(prefix="subwave-liquidsoap-smoke-"))).resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    if any(evidence.iterdir()):
        parser.error("Evidence directory must be empty")
    state = evidence / "state"
    state.mkdir(mode=0o777)
    state.chmod(0o777)
    print(f"Evidence: {evidence}", flush=True)
    for name, frequency, seconds in [("a", 440, 12), ("b", 660, 12),
                                     ("voice", 880, 3), ("jingle", 1100, 8)]:
        tone(state / f"{name}.wav", frequency, seconds)
    (state / "auto.m3u").write_text("".join(
        f'annotate:title="Test {name}",artist="SUB/WAVE test",'
        f'subsonic_id="{name}":/var/sub-wave/{name}.wav\n' for name in ["a", "b"]
    ))
    for key, value in {"crossfade": "4", "jingle_ratio": "0",
                       "archive_enabled": "false", "opus_enabled": "true",
                       "aac_enabled": "true", "flac_enabled": "true"}.items():
        (state / f"liquidsoap_{key}.txt").write_text(value)
    name = f"subwave-liquidsoap-test-{uuid.uuid4().hex[:10]}"
    seen = set()
    progress = TrackProgress()
    actions = [(25, "say.txt", 'annotate:subwave_voice="smoke-say":/var/sub-wave/voice.wav'),
               (40, "intro.txt", 'annotate:subwave_voice="smoke-intro":/var/sub-wave/voice.wav'),
               (55, "jingle-now.txt", "/var/sub-wave/jingle.wav")]
    started_at = utc_now()
    started = time.monotonic()
    status = {"phase": "starting", "container": name, "image": args.image,
              "test_source_sha": args.test_source_sha,
              "image_source_sha": args.image_source_sha,
              "runner_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              "started_at": started_at.isoformat(),
              "deadline": (started_at + timedelta(seconds=args.seconds)).isoformat(),
              "seconds": args.seconds, "cpus": args.cpus, "memory": args.memory,
              "policy": {"startup_seconds": 30, "interval_seconds": 60,
                         "min_starts": 3, "max_marker_age_seconds": 30}}
    write_json(evidence / "status.json", status)
    previous_signal = signal.signal(signal.SIGTERM, interrupted)

    def collect_logs():
        result = subprocess.run(["docker", "logs", name], check=True,
                                capture_output=True, text=True, timeout=30)
        logs = result.stdout + result.stderr
        (evidence / "broadcast.log").write_text(logs)
        # Liquidsoap's file log contains diagnostics absent from Docker stdout.
        result = subprocess.run(["docker", "exec", name, "cat",
                                 "/var/log/liquidsoap/radio.log"],
                                capture_output=True, text=True, timeout=30)
        if result.returncode == 0:
            (evidence / "radio.log").write_text(result.stdout)
            logs += result.stdout
        elif time.monotonic() - started >= progress.startup_seconds:
            raise RuntimeError(f"Cannot read Liquidsoap diagnostics: {result.stderr}")
        status["startup_latency_warnings"] = check_latency(
            logs, started_at.timestamp(), progress.startup_seconds
        )

    try:
        # Resolve once and run the immutable ID, even if a tag moves during a soak.
        image_info = json.loads(command("docker", "image", "inspect", args.image))[0]
        status["image_id"] = image_info["Id"]
        write_json(evidence / "status.json", status)
        command("docker", "run", "-d", "--name", name,
                "--cpus", str(args.cpus), "--memory", args.memory,
                "--pids-limit", "128", "--log-opt", "max-size=10m",
                "--log-opt", "max-file=3",
                "-p", "127.0.0.1::7702", "-v", f"{state}:/var/sub-wave",
                "-e", "ICECAST_TRUSTED_PROXY_IPS=127.0.0.1",
                "-e", "TZ=UTC", status["image_id"])
        port = command("docker", "port", name, "7702/tcp").rsplit(":", 1)[1]
        base = f"http://127.0.0.1:{port}"
        status.update({"phase": "running", "base_url": base})
        next_sample = 0
        while time.monotonic() - started < args.seconds:
            elapsed = time.monotonic() - started
            if command("docker", "inspect", "-f", "{{.State.Running}}", name) != "true":
                raise RuntimeError("broadcast container exited")
            while actions and elapsed >= actions[0][0]:
                _, filename, uri = actions.pop(0)
                pending = state / f"{filename}.tmp"
                pending.write_text(uri + "\n")
                pending.replace(state / filename)
            interval = progress.observe(elapsed, time.time(), read_marker(state / "now-playing.json"))
            if interval:
                with (evidence / "intervals.jsonl").open("a") as out:
                    out.write(json.dumps(interval) + "\n")
            voice = read_marker(state / "voice-playing.json")
            if voice:
                seen.add(voice["voiceId"])
            if read_marker(state / "jingle-playing.json") is not None:
                seen.add("jingle")
            if elapsed >= next_sample:
                stats = command("docker", "stats", "--no-stream", "--format", "{{json .}}", name)
                with (evidence / "stats.jsonl").open("a") as out:
                    out.write(json.dumps({"elapsed": round(elapsed), "stats": json.loads(stats),
                                          **progress.snapshot(time.time())}) + "\n")
                status.update({"elapsed": elapsed, "updated_at": utc_now().isoformat(),
                               "markers": sorted(seen), **progress.snapshot(time.time())})
                write_json(evidence / "status.json", status)
                print(f"{elapsed:.0f}s: {len(progress.track_stamps)} track starts, "
                      f"markers={sorted(seen)}", flush=True)
                collect_logs()
                write_json(evidence / "status.json", status)
                next_sample += 60
            time.sleep(0.5)
        progress.observe(time.monotonic() - started, time.time(), read_marker(state / "now-playing.json"))
        assert len(progress.track_stamps) >= 8, f"Too few track changes: {len(progress.track_stamps)}"
        assert seen == {"smoke-say", "smoke-intro", "jingle"}, seen
        for codec in ["mp3", "opus", "aac", "flac"]:
            capture = evidence / f"capture.{codec}"
            with urllib.request.urlopen(f"{base}/stream.{codec}", timeout=15) as stream:
                capture.write_bytes(stream.read(65536))
            pcm = subprocess.check_output([
                "ffmpeg", "-v", "error", "-i", str(capture), "-t", "1",
                "-f", "s16le", "-ac", "1", "-ar", "44100", "-"
            ], timeout=30)
            samples = array.array("h", pcm)
            if sys.byteorder != "little":
                samples.byteswap()
            assert samples and max(map(abs, samples)) > 100, f"Silent {codec} output"
        collect_logs()
        status["phase"] = "passed"
        print(f"PASS: {len(progress.track_stamps)} track starts with continuing progress, "
              "both voice channels, jingle, four decoded mounts", flush=True)
    except BaseException as error:
        status.update({"phase": "failed", "error": str(error)})
        raise
    finally:
        diagnostic_failure = None
        try:
            collect_logs()
        except Exception as error:
            status.setdefault("diagnostic_error", str(error))
            if status["phase"] == "passed":
                status.update({"phase": "failed", "error": str(error)})
                diagnostic_failure = error
        try:
            result = subprocess.run(["docker", "rm", "-f", name], check=False,
                                    capture_output=True, text=True, timeout=30)
            status["container_removed"] = result.returncode == 0
            if result.returncode and status["phase"] == "passed":
                status.update({"phase": "failed", "error": "Container cleanup failed"})
                raise RuntimeError(status["error"])
        except subprocess.SubprocessError as error:
            status.update({"phase": "failed", "cleanup_error": str(error)})
            raise
        finally:
            status.update({"finished_at": utc_now().isoformat(),
                           "elapsed": time.monotonic() - started,
                           **progress.snapshot(time.time())})
            write_json(evidence / "status.json", status)
            signal.signal(signal.SIGTERM, previous_signal)
        if diagnostic_failure is not None:
            raise diagnostic_failure


if __name__ == "__main__":
    main()
