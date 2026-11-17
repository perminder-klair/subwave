// Version-pin helpers, shared by `subwave init` (writes the pin) and
// `subwave update` (moves it). The binary's embedded compose files are frozen at
// its build tag while their image refs resolve `${SUBWAVE_VERSION:-latest}`, so
// pinning to the CLI's own release keeps the two in lockstep.

import { CLI_VERSION } from './assets.ts';
import { envValue } from './util.ts';

// publish-images.yml tags images with bare semver (git `v0.35.0` → image
// `0.35.0`), which is what CLI_VERSION holds. Anything that doesn't look like a
// published release returns null so the caller stays on :latest.
export function cliImageTag(): string | null {
  const v = CLI_VERSION.trim().replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+/.test(v)) return null;
  if (v === '0.0.0' || v.startsWith('0.0.0-')) return null;
  return v;
}

// Edits only the pin line, leaving the rest of the file byte-for-byte intact.
// null means nothing to do: no pin line, the pin already equals `target`, or the
// pin follows a non-version tag (`latest`, `sha-…`), which is a deliberate
// follow mode and must never become a fixed pin.
export function movePinInEnv(
  envText: string,
  target: string,
): { text: string; from: string } | null {
  const lines = envText.split('\n');
  // Last line first: with a duplicated pin, compose takes the last one, so that's
  // the only line whose move takes effect.
  for (let i = lines.length - 1; i >= 0; i--) {
    // Compose also reads an `export SUBWAVE_VERSION=` line and a CRLF one, so those
    // move too, keeping their prefix and line end.
    const m = (lines[i] as string).match(/^(\s*(?:export\s+)?)SUBWAVE_VERSION\s*=([^\r]*)(\r?)$/);
    if (!m) continue;
    // Read as compose reads it, comment and quotes gone: `from` is the version
    // compose was actually running, and it's what update.ts reports.
    const current = envValue(m[2] ?? '');
    // Only migrate a concrete version pin (`0.35.0`, `0.35`, `v0.35.0`).
    if (!/^v?\d+\.\d+/.test(current)) return null;
    if (current === target) return null;
    lines[i] = `${m[1] ?? ''}SUBWAVE_VERSION=${target}${m[3] ?? ''}`;
    return { text: lines.join('\n'), from: current };
  }
  return null;
}
