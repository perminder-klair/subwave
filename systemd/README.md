# SUB/WAVE systemd units (native install)

These are **templates**, not installable units. They contain `${VAR}`
placeholders that `scripts/install-native.sh` substitutes via `envsubst`
when copying into `~/.config/systemd/user/`.

Don't run `systemctl enable` against these files directly — run the installer.

## Substituted variables

| Variable | Meaning |
|----------|---------|
| `${REPO}` | Absolute path to the cloned `subwave/web` checkout |
| `${STATE_DIR}` | Where the file-IPC tree lives (typically `${REPO}/state`) |
| `${SOUNDS_DIR}` | Where the bundled static audio lives (`${REPO}/sounds`) |
| `${ICECAST_BIN}` | `/usr/bin/icecast2` on Debian, `/usr/bin/icecast` on Arch/Fedora |
| `${LIQUIDSOAP_BIN}` | Distro-packaged Liquidsoap binary |
| `${NODE_BIN}` | Node.js 22 binary (`/usr/bin/node` typically) |
| `${TSX_BIN}` | `${REPO}/controller/node_modules/.bin/tsx` — runs `.ts` source directly |
| `${CADDY_BIN}` | Caddy binary (distro package or downloaded static) |
| `${PIPER_BIN}` | Piper binary, default `${STATE_DIR}/runtime/piper/piper` |
| `${PIPER_VOICE}` | `${STATE_DIR}/runtime/piper/en_GB-alan-medium.onnx` |
| `${PIPER_VOICE_CONFIG}` | `${PIPER_VOICE}.json` |
| `${KOKORO_PYTHON}` | `${STATE_DIR}/runtime/kokoro/venv/bin/python` (Linux only) |
| `${KOKORO_WORKER}` | `${REPO}/controller/scripts/kokoro_worker.py` |
| `${KOKORO_MODEL}` | `${STATE_DIR}/runtime/kokoro/models/kokoro-v1.0.onnx` |
| `${KOKORO_VOICES}` | `${STATE_DIR}/runtime/kokoro/models/voices-v1.0.bin` |

## Day-to-day

```sh
systemctl --user start subwave.target
systemctl --user status 'subwave-*'
journalctl --user -u subwave-controller -f
systemctl --user restart subwave-controller
```

## Why user units

No root needed for the daily lifecycle — listeners come in via Caddy on
`:4800` (any unprivileged port works). If you need `:80` / `:443`, either
`setcap CAP_NET_BIND_SERVICE+ep` on the Caddy binary or convert
`subwave-caddy.service` to a system unit. See `DEPLOY.md`.
