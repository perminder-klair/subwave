#!/usr/bin/env python3
"""Resume into another show must air the new show's fallback, on the real radio.liq.

Usage: python3 scripts/liquidsoap-resume-fallback.py IMAGE [--crossfade 4] [--case auto ...]

Runs the baked radio.liq against disposable tones in a throwaway container,
never live state. Telnet is published on 127.0.0.1 for that container only.

Every rewrite of auto.m3u follows the controller's timing: the file is written
and `auto.reload` sent at once (scheduler.ts), then the resume polls
`auto.ready` and skips (resume-show.ts). Its own round trips before the skip
(drop(), commitBeforeSkip) can place that skip anywhere after the first
`ready`, so `ready` must hold from then on: this test samples it every 50 ms
until READY_HOLD after the write, past the stdlib watch's 0.5 s settle, then
skips. The later shows' tracks are subhttp: URLs from a local origin that
answers after ORIGIN_DELAY, like a Navidrome download, so the first `ready`
comes before that settle and an emptied queue stays empty long enough to see.

  dj      the old show's fallback plays, a DJ pick takes over (the playlist now
          holds the old show's next track as its prepared request), the
          programme idle-pauses, then the controller's resume: idle_off, write
          auto.m3u for a new show, auto.reload, wait for auto.ready, skip. The
          next track must be the new show's.
  auto    the same, with only the fallback playing when the programme paused.
          The playlist is reloaded in place there, so a second reload of the
          same write would empty the queue auto.ready had just reported.
  kept    the dj case, but a pick committed in dj_queue before the skip (as
          commitBeforeSkip() does) airs after it, so nothing pulls the fallback;
          then auto.m3u is rewritten for a third show and reloaded. When the
          kept pick ends, the third show's track must air.
  onair   rewrites and reloads while the fallback is on air must not cut the
          track.

Every case also requires the dead-air guard (music_safety) to stay on the music
chain throughout: a switch means the chain went unready, which is dead air.

Exit 0 when every case run passes. Requires Docker and ffmpeg. No controller or
external services.
"""
import argparse
import array
import http.server
import json
import math
from pathlib import Path
import shutil
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import wave

ORIGIN_DELAY = 0.2
READY_HOLD = 1.5
HOST_ALIAS = "host.docker.internal"


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


def mp3_tone(path, frequency, seconds):
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
                    f"sine=frequency={frequency}:duration={seconds}:sample_rate=44100",
                    "-ac", "2", "-b:a", "128k", str(path)], check=True)


class Origin:
    """Serves the later shows' tracks after ORIGIN_DELAY, reachable from the container."""

    def __init__(self, root):
        class Handler(http.server.SimpleHTTPRequestHandler):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, directory=str(root), **kwargs)

            def guess_type(self, path):
                return "audio/mpeg"

            def do_GET(self):
                time.sleep(ORIGIN_DELAY)
                super().do_GET()

            def log_message(self, *args):
                pass

        class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
            daemon_threads = True

            def handle_error(self, request, client_address):
                # A download cut short when its container is removed.
                if not isinstance(sys.exc_info()[1], (BrokenPipeError, ConnectionResetError)):
                    super().handle_error(request, client_address)

        self.server = Server(("0.0.0.0", 0), Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()


LOCAL = {"old_a": 330, "old_b": 300, "dj": 440, "kept": 500}
REMOTE = {"new_a": 660, "new_b": 700, "third_a": 880, "third_b": 940}


class Station:
    def __init__(self, image, crossfade):
        base = Path(tempfile.mkdtemp(prefix="subwave-resume-"))
        self.state = base / "state"
        self.state.mkdir(mode=0o777)
        self.state.chmod(0o777)
        media = base / "media"
        media.mkdir()
        for name, freq in LOCAL.items():
            tone(self.state / f"{name}.wav", freq, 20 if name == "dj" else 10)
        for name, freq in REMOTE.items():
            mp3_tone(media / f"{name}.mp3", freq, 10)
        self.origin = Origin(media)
        self.write_auto(["old_a", "old_b"])
        for key, value in {"crossfade": str(crossfade), "jingle_ratio": "0", "archive_enabled": "false",
                           "opus_enabled": "false", "aac_enabled": "false", "flac_enabled": "false"}.items():
            (self.state / f"liquidsoap_{key}.txt").write_text(value)
        self.name = f"subwave-resume-test-{uuid.uuid4().hex[:10]}"
        subprocess.run(["docker", "run", "-d", "--name", self.name, "--memory", "512m",
                        "--add-host", f"{HOST_ALIAS}:host-gateway",
                        "-p", "127.0.0.1::1234", "-v", f"{self.state}:/var/sub-wave",
                        "-e", "TZ=UTC", image], check=True, capture_output=True, timeout=60)
        out = subprocess.check_output(["docker", "port", self.name, "1234/tcp"], text=True)
        self.port = int(out.strip().splitlines()[0].rsplit(":", 1)[1])

    def entry(self, name):
        if name in REMOTE:
            uri = f"subhttp:http://{HOST_ALIAS}:{self.origin.port}/{name}.mp3"
        else:
            uri = f"/var/sub-wave/{name}.wav"
        return f'annotate:title="{name}",artist="test",subsonic_id="{name}":{uri}'

    def write_auto(self, names):
        # Atomic, as the scheduler writes it.
        tmp = self.state / "auto.m3u.tmp"
        tmp.write_text("".join(self.entry(n) + "\n" for n in names))
        tmp.replace(self.state / "auto.m3u")

    def rebuild(self, names):
        """The scheduler's write, then its reload at once. Returns the write time."""
        written = time.monotonic()
        self.write_auto(names)
        assert self.telnet("auto.reload") == "OK"
        return written

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

    def guard_switches(self):
        # The dead-air guard logs every switch at level 3.
        log = subprocess.run(["docker", "exec", self.name, "cat", "/var/log/liquidsoap/radio.log"],
                             capture_output=True, text=True, check=True).stdout
        return [line for line in log.splitlines() if "[music_safety:" in line and "Switch to" in line]

    def close(self):
        subprocess.run(["docker", "rm", "-f", self.name], capture_output=True)
        self.origin.close()


def skip_when_ready(station, written):
    # As the controller does: wait for auto.ready, then skip.
    deadline = time.monotonic() + 20
    while station.telnet("auto.ready") != "ready":
        assert time.monotonic() < deadline, "the new fallback never got a track ready"
        time.sleep(0.05)
    while time.monotonic() < written + READY_HOLD:
        late = round(time.monotonic() - written, 2)
        assert station.telnet("auto.ready") == "ready", f"auto.ready fell back to pending {late}s after the write"
        time.sleep(0.05)
    station.telnet("skip")


def resume(station, kept=False):
    station.telnet("idle_on")
    time.sleep(2)
    station.telnet("idle_off")
    time.sleep(1)
    if kept:  # committed in dj_queue before the skip, as commitBeforeSkip() does
        station.telnet(f"dj_queue.push {station.entry('kept')}")
        time.sleep(1)
    skip_when_ready(station, station.rebuild(["new_a", "new_b"]))
    return station.wait_for(lambda c: c not in (None, "dj", "old_a"), "the track after the skip")


def kept_then_third_show(station):
    assert resume(station, kept=True) == "kept", "the kept pick airs after the skip"
    station.rebuild(["third_a", "third_b"])
    return station.wait_for(lambda c: c not in (None, "kept"), "the track after the kept pick", timeout=30)


def run(image, crossfade, case):
    station = Station(image, crossfade)
    try:
        station.wait_for(lambda c: c == "old_a", "old_a on air")
        if case in ("dj", "kept"):
            station.telnet(f"dj_queue.push {station.entry('dj')}")
            station.wait_for(lambda c: c == "dj", "the DJ pick on air")
        time.sleep(1)
        before = len(station.guard_switches())
        if case == "kept":
            result = kept_then_third_show(station)
        elif case == "onair":
            for names in (["new_a", "new_b"], ["third_a", "third_b"], ["new_a", "new_b"]):
                station.rebuild(names)
                time.sleep(0.5)
            time.sleep(2)
            result = station.on_air()
        else:
            result = resume(station)
        time.sleep(3)
        return result, station.guard_switches()[before:]
    finally:
        station.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("image")
    parser.add_argument("--crossfade", type=int, default=4)
    parser.add_argument("--case", action="append", choices=["dj", "auto", "kept", "onair"],
                        help="run only this case (repeatable); all four by default")
    args = parser.parse_args()
    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg is required to render the later shows' tracks")
    expected = {
        "dj": ("the new show's fallback follows a skipped DJ pick", lambda r: r.startswith("new_")),
        "auto": ("the new show's fallback follows a skipped fallback track", lambda r: r.startswith("new_")),
        "kept": ("the latest show's fallback follows a kept pick", lambda r: r.startswith("third_")),
        "onair": ("a reload does not cut the fallback on air", lambda r: r == "old_a"),
    }
    failed = False
    for case, (label, check) in expected.items():
        if args.case and case not in args.case:
            continue
        try:
            result, switches = run(args.image, args.crossfade, case)
        except AssertionError as err:
            result, switches = str(err), []
        ok = check(result) and not switches
        failed |= not ok
        detail = f"got {result}" + (f"; dead-air guard switched: {switches}" if switches else "")
        print(("PASS " if ok else "FAIL ") + f"{case}: {label}, no dead air ({detail})")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
