#!/usr/bin/env python3
"""What the analyzer writes into the shared state is open to the other services.

The analyzer image runs as an unprivileged user with the default umask 022, so
a plain makedirs/open leaves stems/<id>/ at 755 and its files at 644. The
controller deletes those folders (stem-cache eviction), and on a share where it
is not that user (a remote analyzer, or NFS squashing root to nobody) it cannot
delete inside a 755 folder. So shared folders are 777, the state bootstrap's
rule for its folders, and shared files 666 to match, whatever the process umask.
A refused chmod, on a folder or a file, never stops the write (the
entrypoint's rule too), and a failed write leaves no partial .tmp behind.
Pure stdlib: numpy and soundfile are stubbed.
"""

import atexit
import contextlib
import io
import json
import os
import shutil
import stat
import sys
import tempfile
import types
from unittest.mock import patch

sys.modules.setdefault("numpy", types.ModuleType("numpy"))
sf = types.ModuleType("soundfile")


def _sf_write(path, data, sr, subtype=None, format=None):  # noqa: A002 - soundfile's own name
    with open(path, "wb") as f:
        f.write(b"fLaC")


sf.write = _sf_write
sys.modules["soundfile"] = sf
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import analyze_worker as aw  # noqa: E402

failures = 0


def test(name, fn):
    global failures
    try:
        fn()
        print(f"  ✓ {name}")
    except Exception as err:  # noqa: BLE001 - a failed assert is a reported case
        failures += 1
        print(f"  ✗ {name}\n      {err}")


root = tempfile.mkdtemp(prefix="subwave-shared-modes-")
atexit.register(shutil.rmtree, root, ignore_errors=True)
os.umask(0o022)  # the analyzer image's default


def mode(path):
    return stat.S_IMODE(os.stat(path).st_mode)


class Stem:
    T = b""


def t_stems():
    d = os.path.join(root, "stems", "track-1")
    aw.write_stems({"drums": Stem(), "vocals": Stem()}, "tail", d)
    assert mode(d) == 0o777, oct(mode(d))
    for name in ("tail-drums.flac", "tail-vocals.flac"):
        p = os.path.join(d, name)
        assert mode(p) == 0o666, f"{name} {oct(mode(p))}"
    assert not [f for f in os.listdir(d) if f.endswith(".tmp")]


def t_tail_meta():
    d = os.path.join(root, "stems", "track-2")
    aw.write_stems({"drums": Stem()}, "tail", d)
    aw.write_tail_meta(d, 181.25, 200.0)
    p = os.path.join(d, "tail-meta.json")
    assert mode(p) == 0o666, oct(mode(p))
    with open(p) as f:
        assert json.load(f) == {"tail_start_sec": 181.25, "duration_sec": 200.0}


def t_existing_dir_reopened():
    # A folder an older analyzer left at 755 is opened up on the next write.
    d = os.path.join(root, "stems", "track-3")
    os.makedirs(d)
    os.chmod(d, 0o755)
    aw.write_stems({"bass": Stem()}, "head", d)
    assert mode(d) == 0o777, oct(mode(d))


def t_foreign_dir_tolerated():
    # chmod on a folder another user owns raises EPERM: the write still goes
    # ahead (the folder's own mode decides whether it can), never a crash.
    d = os.path.join(root, "stems", "track-4")
    real = os.chmod

    def deny(path, m, *a, **k):
        if os.path.normpath(path) == os.path.normpath(d):
            raise PermissionError(1, "Operation not permitted", path)
        return real(path, m, *a, **k)

    os.chmod = deny
    try:
        aw.write_stems({"other": Stem()}, "tail", d)
    finally:
        os.chmod = real
    assert mode(os.path.join(d, "tail-other.flac")) == 0o666


def t_file_chmod_refused():
    # A share that refuses SETATTR on a file the analyzer just created (ACL-only
    # NFS, some NAS exports, FUSE: EPERM / ENOTSUP / ENOSYS) still gets the
    # stem, at the mount's mode, with no .tmp left and one log line.
    d = os.path.join(root, "stems", "track-5")
    real = os.chmod

    def refuse(path, m, *a, **k):
        if str(path).endswith(".tmp"):
            raise OSError(95, "Operation not supported", path)
        return real(path, m, *a, **k)

    aw._shared_chmod_logged = False
    os.chmod = refuse
    err = io.StringIO()
    try:
        with contextlib.redirect_stderr(err):
            aw.write_stems({"drums": Stem(), "bass": Stem()}, "tail", d)
            aw.write_tail_meta(d, 10.0, 20.0)
    finally:
        os.chmod = real
    for name in ("tail-drums.flac", "tail-bass.flac", "tail-meta.json"):
        p = os.path.join(d, name)
        assert os.path.exists(p), f"{name} not published"
        assert mode(p) == 0o644, f"{name} {oct(mode(p))}: not the mount's mode"
    assert not [f for f in os.listdir(d) if f.endswith(".tmp")]
    lines = [ln for ln in err.getvalue().splitlines() if "could not set mode" in ln]
    assert len(lines) == 1, err.getvalue()
    # The name an operator can look up, not a temp file already renamed away.
    assert "track-5/tail-drums.flac " in lines[0] and ".tmp" not in lines[0], lines[0]


def t_writable_refusal_is_silent():
    # transitions/ is created root-owned 777, so it refuses the analyzer's chmod
    # on every render and works fine. The warning keys on writability, never on
    # chmod's exit status (the entrypoint's state_writable_by_others), and that
    # silence must not spend the one line a real refusal needs.
    healthy = os.path.join(root, "transitions-root-owned")
    stuck = os.path.join(root, "stems", "track-7")
    for path, m in ((healthy, 0o777), (stuck, 0o755)):
        os.makedirs(path)
        os.chmod(path, m)
    real = os.chmod

    def deny(path, m, *a, **k):
        if path in (healthy, stuck):
            raise PermissionError(1, "Operation not permitted", path)
        return real(path, m, *a, **k)

    err = io.StringIO()
    with patch.object(aw, "_shared_chmod_logged", False), patch("os.chmod", deny), \
            contextlib.redirect_stderr(err):
        aw.make_shared_dir(healthy)
        assert "could not set mode" not in err.getvalue(), err.getvalue()
        aw.make_shared_dir(stuck)
    lines = [ln for ln in err.getvalue().splitlines() if "could not set mode" in ln]
    assert len(lines) == 1 and stuck in lines[0], err.getvalue()


def t_failed_write_leaves_no_tmp():
    # A write that dies part-way (disk full, a decode error) removes its
    # partial file, so it never counts against the cache budget; the error
    # still reaches the caller, which degrades.
    d = os.path.join(root, "stems", "track-6")
    real = sf.write

    def broken(path, *a, **k):
        with open(path, "wb") as f:
            f.write(b"fLa")
        raise OSError(28, "No space left on device", path)

    sf.write = broken
    try:
        try:
            aw.write_stems({"drums": Stem()}, "tail", d)
            raise AssertionError("the failed write was swallowed")
        except OSError:
            pass
    finally:
        sf.write = real
    assert os.listdir(d) == [], os.listdir(d)


def t_planted_tmp_not_followed():
    # The folder is 777, so anyone on the share can plant a link at a predictable
    # temp name. The write never goes through it and never chmods its target.
    d = os.path.join(root, "stems", "track-8")
    target = os.path.join(root, "planted-target")
    with open(target, "w") as f:
        f.write("keep")
    os.chmod(target, 0o600)
    aw.make_shared_dir(d)
    os.symlink(target, os.path.join(d, "tail-drums.flac.tmp"))
    aw.write_stems({"drums": Stem()}, "tail", d)
    with open(target) as f:
        assert f.read() == "keep", "written through the link"
    assert mode(target) == 0o600, oct(mode(target))
    assert not os.path.islink(os.path.join(d, "tail-drums.flac"))
    assert mode(os.path.join(d, "tail-drums.flac")) == 0o666


def t_transition_output():
    # render_transition's clip lands through the same two helpers.
    out = os.path.join(root, "transitions")
    aw.make_shared_dir(out)
    path = os.path.join(out, "clip.wav")
    with aw.shared_output(path) as tmp:
        with open(tmp, "wb") as f:
            f.write(b"RIFF")
    assert mode(out) == 0o777, oct(mode(out))
    assert mode(path) == 0o666
    assert not os.path.exists(path + ".tmp")
    with open(aw.__file__) as f:
        src = f.read()
    body = src[src.index("def render_transition"):]
    body = body[:body.index("\ndef ")]
    assert "make_shared_dir(out_dir)" in body and "shared_output(out_path)" in body
    assert "os.makedirs(out_dir" not in body and "os.replace(" not in body


print("analyzer_shared_modes_test.py")
test("stems folder 777 and stem files 666 under umask 022", t_stems)
test("tail-meta.json 666", t_tail_meta)
test("a 755 folder from an older analyzer is opened up", t_existing_dir_reopened)
test("a folder it cannot chmod still gets its files written", t_foreign_dir_tolerated)
test("a file it cannot chmod is still published, logged once", t_file_chmod_refused)
test("a refused chmod on a writable folder is silent, a stuck one still logs", t_writable_refusal_is_silent)
test("a failed write leaves no partial .tmp", t_failed_write_leaves_no_tmp)
test("a link planted at the temp name is not followed", t_planted_tmp_not_followed)
test("render_transition writes its folder and clip shared", t_transition_output)
sys.exit(1 if failures else 0)
