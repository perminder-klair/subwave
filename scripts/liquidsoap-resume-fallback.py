#!/usr/bin/env python3
"""Resume into another show must air the new show's fallback, on the real radio.liq.

Usage: python3 scripts/liquidsoap-resume-fallback.py IMAGE [--crossfade 4]

Runs the baked radio.liq against disposable tones in a throwaway container,
never live state. Telnet is published on 127.0.0.1 for that container only.

  dj      the old show's fallback plays, a DJ pick takes over (the playlist now
          holds the old show's next track as its prepared request), the
          programme idle-pauses, auto.m3u is rewritten for a new show, then the
          controller's resume: idle_off, auto.reload, skip. The next track must
          be the new show's.
  auto    the same, with only the fallback playing when the programme paused.
  onair   auto.reload while the fallback is on air must not cut the track.

The controller waits for `auto.ready` before the skip, and so does this test.

Exit 0 when all three pass. Requires Docker. No controller or external services.
"""
import argparse
import array
import json
import math
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import uuid
import wave


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


def entry(name):
    return f'annotate:title="{name}",artist="test",subsonic_id="{name}":/var/sub-wave/{name}.wav'


def write_auto(state, names):
    # Atomic, as the scheduler writes it.
    tmp = state / "auto.m3u.tmp"
    tmp.write_text("".join(entry(n) + "\n" for n in names))
    tmp.replace(state / "auto.m3u")


class Station:
    def __init__(self, image, crossfade):
        self.state = Path(tempfile.mkdtemp(prefix="subwave-resume-")) / "state"
        self.state.mkdir(mode=0o777)
        self.state.chmod(0o777)
        for name, freq, secs in [("old_a", 330, 10), ("old_b", 300, 10), ("dj", 440, 20),
                                 ("new_a", 660, 10), ("new_b", 700, 10)]:
            tone(self.state / f"{name}.wav", freq, secs)
        write_auto(self.state, ["old_a", "old_b"])
        for key, value in {"crossfade": str(crossfade), "jingle_ratio": "0", "archive_enabled": "false",
                           "opus_enabled": "false", "aac_enabled": "false", "flac_enabled": "false"}.items():
            (self.state / f"liquidsoap_{key}.txt").write_text(value)
        self.name = f"subwave-resume-test-{uuid.uuid4().hex[:10]}"
        subprocess.run(["docker", "run", "-d", "--name", self.name, "--memory", "512m",
                        "-p", "127.0.0.1::1234", "-v", f"{self.state}:/var/sub-wave",
                        "-e", "TZ=UTC", image], check=True, capture_output=True, timeout=60)
        out = subprocess.check_output(["docker", "port", self.name, "1234/tcp"], text=True)
        self.port = int(out.strip().splitlines()[0].rsplit(":", 1)[1])

    def telnet(self, command):
        deadline = time.monotonic() + 30
        while True:
            try:
                with socket.create_connection(("127.0.0.1", self.port), 2) as conn:
                    conn.sendall(f"{command}\nquit\n".encode())
                    data = b""
                    while chunk := conn.recv(4096):
                        data += chunk
                return data.decode().split("\nEND")[0].strip()
            except OSError:
                if time.monotonic() > deadline:
                    raise
                time.sleep(0.5)

    def on_air(self):
        try:
            return json.loads((self.state / "now-playing.json").read_text()).get("subsonic_id")
        except (FileNotFoundError, json.JSONDecodeError):
            return None

    def wait_for(self, predicate, what, timeout=60):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            current = self.on_air()
            if predicate(current):
                return current
            time.sleep(0.25)
        raise AssertionError(f"timed out waiting for {what}; on air: {self.on_air()}")

    def close(self):
        subprocess.run(["docker", "rm", "-f", self.name], capture_output=True)


def resume(station):
    station.telnet("idle_on")
    time.sleep(2)
    write_auto(station.state, ["new_a", "new_b"])
    time.sleep(1)
    station.telnet("idle_off")
    time.sleep(1)
    assert station.telnet("auto.reload") == "OK"
    # As the controller does: skip once the new fallback has a track ready.
    deadline = time.monotonic() + 20
    while station.telnet("auto.ready") != "ready":
        assert time.monotonic() < deadline, "the new fallback never got a track ready"
        time.sleep(0.25)
    station.telnet("skip")
    return station.wait_for(lambda c: c not in (None, "dj", "old_a"), "the track after the skip")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("image")
    parser.add_argument("--crossfade", type=int, default=4)
    args = parser.parse_args()
    results = {}

    station = Station(args.image, args.crossfade)
    try:
        station.wait_for(lambda c: c == "old_a", "old_a on air")
        station.telnet(f"dj_queue.push {entry('dj')}")
        station.wait_for(lambda c: c == "dj", "the DJ pick on air")
        time.sleep(1)
        results["dj"] = resume(station)
    finally:
        station.close()

    station = Station(args.image, args.crossfade)
    try:
        station.wait_for(lambda c: c == "old_a", "old_a on air")
        time.sleep(1)
        results["auto"] = resume(station)
    finally:
        station.close()

    station = Station(args.image, args.crossfade)
    try:
        station.wait_for(lambda c: c == "old_a", "old_a on air")
        time.sleep(1)
        for _ in range(3):
            assert station.telnet("auto.reload") == "OK"
            time.sleep(0.5)
        time.sleep(2)
        results["onair"] = station.on_air()
    finally:
        station.close()

    checks = {
        "dj: the new show's fallback follows a skipped DJ pick": results["dj"].startswith("new_"),
        "auto: the new show's fallback follows a skipped fallback track": results["auto"].startswith("new_"),
        "onair: a reload does not cut the fallback on air": results["onair"] == "old_a",
    }
    for label, ok in checks.items():
        print(("PASS " if ok else "FAIL ") + label + f" (got {results[label.split(':')[0]]})")
    sys.exit(0 if all(checks.values()) else 1)


if __name__ == "__main__":
    main()
