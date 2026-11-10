#!/usr/bin/env bash
# Optional #1729 integration runtime. Requires Linux, sudo, skopeo and Python 3.
# Use ONLY a new disposable directory: this extracts the actual shipped image,
# without Docker/namespaces. chroot runs its unmodified audio graph/entrypoint.
# Network configuration is narrowed to loopback; credentials are test-only.
set -euo pipefail
DIR=${1:?usage: prepare-playlist-mixer.sh NEW_DISPOSABLE_DIRECTORY}
[ ! -e "$DIR" ] || { echo 'Refusing to overwrite an existing directory' >&2; exit 1; }
mkdir -p "$DIR/image" "$DIR/rootfs"
IMAGE=ghcr.io/perminder-klair/subwave-broadcast@sha256:d08a424b024914b1dce1441584ecdae1fb2831ddacaed21208ce8888c75d36fb
skopeo copy --override-arch amd64 "docker://$IMAGE" "dir:$DIR/image"
python3 - "$DIR" <<'PY'
import json, pathlib, subprocess, sys, tarfile
base = pathlib.Path(sys.argv[1]).resolve()
root = base / 'rootfs'
for layer in json.loads((base / 'image/manifest.json').read_text())['layers']:
    archive = base / 'image' / layer['digest'].split(':')[1]
    # Apply OCI deletions before extracting each layer. Device files are created
    # explicitly below; /dev is not supplied by the image when using chroot.
    with tarfile.open(archive) as tar:
        for item in tar:
            p = pathlib.PurePosixPath(item.name)
            if p.name.startswith('.wh.'):
                target = root / p.parent / p.name[4:]
                if p.name == '.wh..wh..opq':
                    for child in (root / p.parent).glob('*'):
                        subprocess.run(['sudo', '-n', 'rm', '-rf', str(child)], check=True)
                else:
                    subprocess.run(['sudo', '-n', 'rm', '-rf', str(target)], check=True)
    subprocess.run(['sudo', '-n', 'tar', '-xf', str(archive), '-C', str(root),
                    '--exclude=dev/*', '--exclude=*/.wh.*'], check=True)
PY
ROOT=$(realpath "$DIR/rootfs")
sudo -n mkdir -p "$ROOT/dev"
for device in null urandom; do sudo -n rm -f "$ROOT/dev/$device"; done
sudo -n mknod -m 666 "$ROOT/dev/null" c 1 3
sudo -n mknod -m 666 "$ROOT/dev/urandom" c 1 9
printf '127.0.0.1 localhost %s\n' "$(hostname)" | sudo -n tee "$ROOT/etc/hosts" >/dev/null
sudo -n sed -i 's/bind_addr := "0.0.0.0"/bind_addr := "127.0.0.1"/' "$ROOT/etc/liquidsoap/radio.liq"
sudo -n sed -i '/<port>7702<\/port>/a\        <bind-address>127.0.0.1</bind-address>' "$ROOT/etc/icecast2/icecast.xml.template"
sudo -n touch "$ROOT/.subwave-1729-disposable"
sudo -n chroot "$ROOT" /usr/bin/liquidsoap --version
printf '\nRun from the controller directory (requires host ffmpeg):\nSUBWAVE_MIXER_ROOTFS=%q npx tsx scripts/auto-playlist-mixer.ts\n' "$ROOT"
