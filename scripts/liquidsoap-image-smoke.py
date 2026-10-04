#!/usr/bin/env python3
"""Run the baked radio.liq against disposable tones and Icecast, never live state.

Usage: python3 scripts/liquidsoap-image-smoke.py IMAGE [--seconds 180]
Use --seconds 86400 for a soak; the evidence directory is retained and printed.
Requires Docker and ffmpeg on the host. No controller or external services.
"""
import argparse
import array
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid
import wave


def command(*args):
    return subprocess.check_output(args, text=True).strip()


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
    args = parser.parse_args()
    if args.seconds < 120:
        parser.error("--seconds must be at least 120")
    evidence = Path(tempfile.mkdtemp(prefix="subwave-liquidsoap-smoke-"))
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
    track_stamps = set()
    actions = [(25, "say.txt", 'annotate:subwave_voice="smoke-say":/var/sub-wave/voice.wav'),
               (40, "intro.txt", 'annotate:subwave_voice="smoke-intro":/var/sub-wave/voice.wav'),
               (55, "jingle-now.txt", "/var/sub-wave/jingle.wav")]
    try:
        command("docker", "run", "-d", "--name", name,
                "-p", "127.0.0.1::7702", "-v", f"{state}:/var/sub-wave",
                "-e", "ICECAST_TRUSTED_PROXY_IPS=127.0.0.1", args.image)
        port = command("docker", "port", name, "7702/tcp").rsplit(":", 1)[1]
        base = f"http://127.0.0.1:{port}"
        started = time.monotonic()
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
            for marker in ["now-playing.json", "voice-playing.json", "jingle-playing.json"]:
                path = state / marker
                if path.exists():
                    data = json.loads(path.read_text())
                    if marker == "now-playing.json":
                        track_stamps.add(data["timestamp"])
                    elif marker == "voice-playing.json":
                        seen.add(data["voiceId"])
                    else:
                        seen.add("jingle")
            if elapsed >= next_sample:
                stats = command("docker", "stats", "--no-stream", "--format", "{{json .}}", name)
                with (evidence / "stats.jsonl").open("a") as out:
                    out.write(json.dumps({"elapsed": round(elapsed), "stats": json.loads(stats)}) + "\n")
                print(f"{elapsed:.0f}s: {len(track_stamps)} track starts, markers={sorted(seen)}", flush=True)
                next_sample += 60
            time.sleep(0.5)
        assert len(track_stamps) >= 8, f"Too few track changes: {len(track_stamps)}"
        assert seen == {"smoke-say", "smoke-intro", "jingle"}, seen
        for codec in ["mp3", "opus", "aac", "flac"]:
            capture = evidence / f"capture.{codec}"
            with urllib.request.urlopen(f"{base}/stream.{codec}", timeout=15) as stream:
                capture.write_bytes(stream.read(65536))
            pcm = subprocess.check_output([
                "ffmpeg", "-v", "error", "-i", str(capture), "-t", "1",
                "-f", "s16le", "-ac", "1", "-ar", "44100", "-"
            ])
            samples = array.array("h", pcm)
            if sys.byteorder != "little":
                samples.byteswap()
            assert samples and max(map(abs, samples)) > 100, f"Silent {codec} output"
        result = subprocess.run(["docker", "logs", name], check=True, capture_output=True, text=True)
        logs = result.stdout + result.stderr
        assert "Latency is too high" not in logs, "Stream clock fell behind"
        print(f"PASS: {len(track_stamps)} track starts, both voice channels, jingle, four decoded mounts", flush=True)
    finally:
        result = subprocess.run(["docker", "logs", name], capture_output=True, text=True)
        (evidence / "broadcast.log").write_text(result.stdout + result.stderr)
        subprocess.run(["docker", "rm", "-f", name], check=False, stdout=subprocess.DEVNULL)


if __name__ == "__main__":
    main()
