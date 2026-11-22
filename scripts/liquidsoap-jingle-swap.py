#!/usr/bin/env python3
"""A show's jingle list must reach the mixer's own rotate at the next stinger (#2367).

Usage: python3 scripts/liquidsoap-jingle-swap.py IMAGE [--case idle ...] [--radio-liq PATH]

Runs the baked radio.liq against disposable tones in a throwaway container,
never live state. Telnet is published on 127.0.0.1 for that container only.

The rotate runs at ratio 1 (a stinger after every song), and every rewrite of
jingles.m3u follows the controller's timing: the file is written atomically and
`jingles.reload` sent at once (broadcast/jingles.ts). The stingers of list A and
list B are told apart by the mixer's own jingle-playing.json marker.

  idle    a stinger from list A has aired, so the playlist holds its next clip
          prepared; the list is swapped to B while a song is on air. The next
          stinger must be B's: the stock reload kept A's prepared clip.
  onair   the list is swapped to B while a stinger from A is on air. That
          stinger must play to its end (the gap to the next stinger matches
          the gap before it), and the next one must be B's.
  empty   the list is emptied while a song is on air: no stinger airs, songs
          keep coming, and once list B returns its stinger airs at the next
          seam, within one song.
  watch   the file is rewritten to B with no reload, as a write whose telnet
          never arrived: radio.liq's watch reloads in place, so B airs by the
          second stinger.

Every case also requires the dead-air guard (music_safety) to stay on the music
chain throughout, counted from the first stinger (the guard switches once at
boot, before the coast has a song ready).

now-playing.json is not air order here: the coast's playlist starts its next
song as the current one ends, so a song's marker can precede the stinger that
airs before it. Only jingle-playing.json, written at feed, times anything.

--radio-liq mounts another radio.liq over the image's own, read-only, so one
image can run a script before and after a change.

Exit 0 when every case run passes. Requires Docker. No controller, ffmpeg or
external services.
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

CROSSFADE = 2
SONG_SECONDS = 8
JINGLE_SECONDS = 5
SONGS = {f"song_{i}": 220 + 30 * i for i in range(6)}
LIST_A = {"a1": 900, "a2": 950, "a3": 1000}
LIST_B = {"b1": 1200, "b2": 1250, "b3": 1300}


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


class Station:
    def __init__(self, image, radio_liq=None):
        base = Path(tempfile.mkdtemp(prefix="subwave-jingle-swap-"))
        self.state = base / "state"
        self.state.mkdir(mode=0o777)
        self.state.chmod(0o777)
        jingles = self.state / "jingles"
        jingles.mkdir(mode=0o777)
        jingles.chmod(0o777)
        for name, freq in SONGS.items():
            tone(self.state / f"{name}.wav", freq, SONG_SECONDS)
        for name, freq in {**LIST_A, **LIST_B}.items():
            tone(jingles / f"{name}.wav", freq, JINGLE_SECONDS)
        (self.state / "auto.m3u").write_text("".join(
            f'annotate:title="{n}",artist="test",subsonic_id="{n}":/var/sub-wave/{n}.wav\n' for n in SONGS))
        self.write_jingles(LIST_A)
        for key, value in {"crossfade": str(CROSSFADE), "jingle_ratio": "1", "archive_enabled": "false",
                           "opus_enabled": "false", "aac_enabled": "false", "flac_enabled": "false"}.items():
            (self.state / f"liquidsoap_{key}.txt").write_text(value)
        self.name = f"subwave-jingle-swap-test-{uuid.uuid4().hex[:10]}"
        mounts = ["-v", f"{self.state}:/var/sub-wave"]
        if radio_liq:
            mounts += ["-v", f"{Path(radio_liq).resolve()}:/etc/liquidsoap/radio.liq:ro"]
        subprocess.run(["docker", "run", "-d", "--name", self.name, "--memory", "512m",
                        "-p", "127.0.0.1::1234", *mounts, "-e", "TZ=UTC", image],
                       check=True, capture_output=True, timeout=60)
        out = subprocess.check_output(["docker", "port", self.name, "1234/tcp"], text=True)
        self.port = int(out.strip().splitlines()[0].rsplit(":", 1)[1])
        self.events = []  # (monotonic time, "song"|"jingle", name), in air order
        self._last_song = None
        self._last_jingle = None

    def write_jingles(self, names):
        # Atomic, as broadcast/jingles.ts writes it.
        tmp = self.state / "jingles.m3u.tmp"
        tmp.write_text("".join(f"/var/sub-wave/jingles/{n}.wav\n" for n in names))
        tmp.replace(self.state / "jingles.m3u")

    def swap(self, names):
        self.write_jingles(names)
        reply = self.telnet("jingles.reload")
        assert reply == "OK", f"jingles.reload answered {reply!r}"

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

    def _read(self, name):
        try:
            return json.loads((self.state / name).read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            return None

    def poll(self):
        """Record each new song or stinger. Polled every 50 ms by the cases."""
        now = time.monotonic()
        song = self._read("now-playing.json")
        key = song and (song.get("subsonic_id"), song.get("timestamp"))
        if key and key != self._last_song:
            self._last_song = key
            self.events.append((now, "song", key[0]))
        jingle = self._read("jingle-playing.json")
        key = jingle and (jingle.get("filename"), jingle.get("startedAt"))
        if key and key != self._last_jingle:
            self._last_jingle = key
            self.events.append((now, "jingle", Path(key[0]).stem))

    def wait_event(self, kind, what, timeout=60, after=None):
        """The first `kind` event recorded after index `after` (default: now)."""
        start = len(self.events) if after is None else after
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.poll()
            for i in range(start, len(self.events)):
                if self.events[i][1] == kind:
                    return i
            time.sleep(0.05)
        raise AssertionError(f"timed out waiting for {what}; aired: {self.aired()}")

    def watch(self, seconds):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.poll()
            time.sleep(0.05)

    def aired(self, start=0):
        return [f"{kind[0]}:{name}" for _, kind, name in self.events[start:]]

    def guard_switches(self):
        log = subprocess.run(["docker", "exec", self.name, "cat", "/var/log/liquidsoap/radio.log"],
                             capture_output=True, text=True, check=True).stdout
        return [line for line in log.splitlines() if "[music_safety:" in line and "Switch to" in line]

    def close(self):
        subprocess.run(["docker", "rm", "-f", self.name], capture_output=True)


def song_after_a_stinger(station):
    """Wait until a stinger from A has aired and a song follows it."""
    j = station.wait_event("jingle", "a stinger", timeout=90, after=0)
    return station.wait_event("song", "the song after it", after=j + 1)


def idle(station):
    song_after_a_stinger(station)
    time.sleep(1)
    station.swap(LIST_B)
    j = station.wait_event("jingle", "the stinger after the swap")
    return station.events[j][2]


def onair(station):
    first = station.wait_event("jingle", "a stinger", timeout=90, after=0)
    j = station.wait_event("jingle", "the next stinger on air", after=first + 1)
    station.swap(LIST_B)  # within one 50 ms poll of the marker
    nxt = station.wait_event("jingle", "the stinger after", after=j + 1)
    before = station.events[j][0] - station.events[first][0]
    after = station.events[nxt][0] - station.events[j][0]
    # A cut stinger brings the next one forward by what it lost.
    full = after >= before - 1
    return f"{station.events[nxt][2]}{'' if full else f' (stinger cut: {after:.1f}s to the next, {before:.1f}s before)'}"


def empty(station):
    song_after_a_stinger(station)
    time.sleep(1)
    station.swap([])
    mark = len(station.events)
    station.watch(3 * (SONG_SECONDS - CROSSFADE) + 2)
    quiet = station.aired(mark)
    if any(e.startswith("j:") for e in quiet):
        return f"a stinger aired over an empty list: {quiet}"
    if sum(e.startswith("s:") for e in quiet) < 2:
        return f"songs stopped while the list was empty: {quiet}"
    station.swap(LIST_B)
    swapped = time.monotonic()
    j = station.wait_event("jingle", "the stinger after the list returns")
    waited = station.events[j][0] - swapped
    return f"{station.events[j][2]} after {waited:.1f}s"


def watch(station):
    song_after_a_stinger(station)
    time.sleep(1)
    station.write_jingles(LIST_B)  # no reload
    first = station.wait_event("jingle", "the first stinger after the write")
    second = station.wait_event("jingle", "the second stinger after the write", after=first + 1)
    return f"{station.events[first][2]},{station.events[second][2]}"


CASES = {
    "idle": ("a swap between stingers airs the new list at the next stinger", idle,
             lambda r: r in LIST_B),
    "onair": ("a swap during a stinger plays it out, then draws from the new list", onair,
              lambda r: r in LIST_B),
    "empty": ("an empty list airs no stinger while songs flow, and the next list airs at the next seam", empty,
              lambda r: r.split(" ")[0] in LIST_B and float(r.rsplit(" ", 1)[1].rstrip("s")) < SONG_SECONDS),
    "watch": ("a write with no reload reaches the rotate by the second stinger", watch,
              lambda r: r.split(",")[1] in LIST_B),
}


def run(image, case, radio_liq=None):
    station = Station(image, radio_liq)
    try:
        station.wait_event("jingle", "the first stinger", timeout=90)
        before = len(station.guard_switches())
        result = CASES[case][1](station)
        return result, station.guard_switches()[before:], station.aired()
    finally:
        station.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("image")
    parser.add_argument("--case", action="append", choices=list(CASES),
                        help="run only this case (repeatable); every case by default")
    parser.add_argument("--radio-liq", help="mount this radio.liq over the image's own")
    parser.add_argument("--verbose", action="store_true", help="print each case's air order")
    args = parser.parse_args()
    failed = False
    for case, (label, _, check) in CASES.items():
        if args.case and case not in args.case:
            continue
        try:
            result, switches, aired = run(args.image, case, args.radio_liq)
        except AssertionError as err:
            result, switches, aired = str(err), [], []
        ok = check(result) and not switches
        failed |= not ok
        detail = f"got {result}" + (f"; dead-air guard switched: {switches}" if switches else "")
        print(("PASS " if ok else "FAIL ") + f"{case}: {label}, no dead air ({detail})")
        if args.verbose:
            print("     " + " ".join(aired))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
