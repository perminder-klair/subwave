// Version-pin helpers shared by `subwave init` (writes the pin) and
// `subwave update` (moves it).
//
// Why pin at all: the compose files embedded in the CLI binary are frozen at
// its build tag, but every image ref in them resolves `${SUBWAVE_VERSION:-latest}`
// — so an un-pinned install floats on `:latest`, which can drift ahead of the
// frozen compose files the binary carries. Pinning SUBWAVE_VERSION to the
// CLI's own release keeps the images and the compose files in lockstep.

import { CLI_VERSION } from './assets.ts';

// The GHCR image tag published for this CLI's release, or null for a dev build.
//
// publish-images.yml tags images via docker/metadata-action `{{version}}`,
// which is semver WITHOUT the leading `v` (git tag `v0.35.0` → image tag
// `0.35.0`). CLI_VERSION is baked from cli/package.json#version by
// embed-assets, which is already that bare semver — so it maps 1:1.
//
// Dev/placeholder guard: a source build without a release-please bump can
// carry `0.0.0` (or some non-semver string). We must never pin to a tag that
// was never published, so anything that doesn't look like a real release
// returns null and callers fall back to the historical `:latest` behaviour.
export function cliImageTag(): string | null {
  const v = CLI_VERSION.trim().replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+/.test(v)) return null;
  if (v === '0.0.0' || v.startsWith('0.0.0-')) return null;
  return v;
}

// Rewrite an uncommented `SUBWAVE_VERSION=` pin to `target`, editing ONLY that
// one line and leaving the rest of the file byte-for-byte intact. Returns the
// new text + the previous value on a move, or null when there's nothing to do:
//   - no uncommented SUBWAVE_VERSION line (fresh pre-pin install → stays on :latest)
//   - the pin already equals `target`
//   - the pin follows a non-version tag (`latest`, `sha-…`, empty) — a
//     deliberate follow mode we must not silently convert into a fixed pin.
export function movePinInEnv(
  envText: string,
  target: string,
): { text: string; from: string } | null {
  const lines = envText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = (lines[i] as string).match(/^SUBWAVE_VERSION\s*=\s*(.*)$/);
    if (!m) continue;
    let current = (m[1] ?? '').trim();
    if (
      (current.startsWith('"') && current.endsWith('"')) ||
      (current.startsWith("'") && current.endsWith("'"))
    ) {
      current = current.slice(1, -1);
    }
    // Only migrate a concrete version pin (`0.35.0`, `0.35`, `v0.35.0`).
    if (!/^v?\d+\.\d+/.test(current)) return null;
    if (current === target) return null;
    lines[i] = `SUBWAVE_VERSION=${target}`;
    return { text: lines.join('\n'), from: current };
  }
  return null;
}
