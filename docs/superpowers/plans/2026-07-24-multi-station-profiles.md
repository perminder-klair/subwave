# Multi-Station Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Multiple fully independent stations under `state/stations/<id>/` with a `stations/active.json` pointer, switchable from a new `/admin/stations` page (one live at a time; switch = mixer restart + controller clean exit).

**Architecture:** Every process resolves the pointer once at boot. The controller resolves it inside `config.ts` (its single `STATE_DIR` chokepoint); liquidsoap gets a new `SUBWAVE_STATE_DIR` env read; the broadcast entrypoint and AIO supervisor resolve it in shell before rendering icecast and launching liquidsoap. Docker `restart: unless-stopped` re-runs both entrypoints after a switch, so the existing telnet `restart` + a controller `process.exit(0)` are the whole switch mechanism.

**Tech Stack:** Node ESM + TypeScript (controller), Liquidsoap 2.4, bash entrypoints, Next.js 15 App Router + Tailwind (web). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-24-multi-station-profiles-design.md` — read it first.

## Global Constraints

- Station id regex, exact: `^[a-z0-9][a-z0-9-]{0,40}$`.
- Pointer file: `state/stations/active.json`, controller-written shape exactly `{"activeId":"<id>"}` (compact, one line), written atomically (tmp + rename).
- Install-level root entries (never moved into a station): `stations`, `icecast-secrets.env`, `hf-cache`, `analyze-tmp`, `lost+found`.
- Env names: controller keeps `STATE_DIR` (always the ROOT); liquidsoap reads `SUBWAVE_STATE_DIR` (the RESOLVED station dir).
- Controller imports use ESM `.js` suffixes (`from '../stations/pure.js'`), matching the codebase.
- New modules under `controller/src/stations/` must NOT import `config.js` in `pure.ts`/`resolve.ts` (config imports resolve → cycle). `manager.ts` may not import config either — it takes `root` as a parameter (testability + no cycle).
- Tests: `node:assert/strict` scripts under `controller/scripts/*.test.ts`, auto-discovered by `npm test` (`run-tests.ts`); run one file with `npx tsx scripts/<file>.test.ts`.
- Lint gate: `npm run lint` (eslint + `tsc --noEmit`) in BOTH `controller/` and `web/`.
- **Commits: stage per task (`git add`), ONE commit at the end** (operator preference — do not commit per task). Branch `worktree-multi-station-profiles`, PR #1156 (draft, base `develop`), no AI attribution in commit/PR text.
- No compose-file or `.env.example` changes (so no `cli embed-assets` re-embed).

---

### Task 1: Pure station helpers

**Files:**
- Create: `controller/src/stations/pure.ts`
- Test: `controller/scripts/stations-pure.test.ts`

**Interfaces:**
- Produces: `STATION_ID_RE: RegExp`; `parseActivePointer(raw: string): string | null`; `slugifyStationName(name: string): string`; `duplicateAction(entry: string): 'copy' | 'backup' | 'skip'`; `conversionAction(entry: string): 'move' | 'keep'`.

- [ ] **Step 1: Write the failing test**

Create `controller/scripts/stations-pure.test.ts`:

```ts
// Unit pins for the pure multi-station helpers (spec:
// docs/superpowers/specs/2026-07-24-multi-station-profiles-design.md §2/§5/§6).
// Run: npx tsx scripts/stations-pure.test.ts — node:assert-via-tsx style of
// scripts/llm-pure.test.ts; auto-discovered by npm test.

import assert from 'node:assert/strict';
import {
  STATION_ID_RE,
  parseActivePointer,
  slugifyStationName,
  duplicateAction,
  conversionAction,
} from '../src/stations/pure.js';

// --- station id validation -------------------------------------------------
assert.ok(STATION_ID_RE.test('main'));
assert.ok(STATION_ID_RE.test('late-night-2'));
assert.ok(STATION_ID_RE.test('a'));
assert.ok(!STATION_ID_RE.test(''));
assert.ok(!STATION_ID_RE.test('Main'));
assert.ok(!STATION_ID_RE.test('-lead'));
assert.ok(!STATION_ID_RE.test('../evil'));
assert.ok(!STATION_ID_RE.test('a/b'));
assert.ok(!STATION_ID_RE.test('a'.repeat(42))); // 41 chars max

// --- active.json parsing ---------------------------------------------------
assert.equal(parseActivePointer('{"activeId":"main"}'), 'main');
assert.equal(parseActivePointer(' {"activeId": "late-night-2"} '), 'late-night-2');
assert.equal(parseActivePointer('{"activeId":"../evil"}'), null);
assert.equal(parseActivePointer('{"activeId":42}'), null);
assert.equal(parseActivePointer('{}'), null);
assert.equal(parseActivePointer('not json'), null);
assert.equal(parseActivePointer(''), null);

// --- slugify ----------------------------------------------------------------
assert.equal(slugifyStationName('Late Night FM'), 'late-night-fm');
assert.equal(slugifyStationName('SUB/WAVE'), 'sub-wave');
assert.equal(slugifyStationName('  ***  '), 'station'); // nothing usable → fallback
assert.equal(slugifyStationName('a'.repeat(60)), 'a'.repeat(41)); // capped to the RE max
assert.ok(STATION_ID_RE.test(slugifyStationName('Ünïcode Béats!!')));

// --- duplicate allowlist (spec §5) ------------------------------------------
// copy: station identity + derived config
for (const f of [
  'settings.json', 'setup-config.json', 'secrets.env', 'moods.json',
  'schedule.json', 'jingles.m3u', 'jingles.json', 'beds.json', 'bed.mp3',
  'voices', 'persona-avatars', 'jingles', 'beds', 'skills', 'sfx',
  'liquidsoap_crossfade.txt', 'liquidsoap_station_name.txt',
  'icecast_listener_auth.txt',
]) assert.equal(duplicateAction(f), 'copy', f);
// library.db goes through better-sqlite3 .backup(), not a file copy
assert.equal(duplicateAction('library.db'), 'backup');
// skip: runtime + listener history + everything unknown (allowlist default)
for (const f of [
  'session.json', 'sessions', 'logs', 'archive', 'queue.json',
  'recent-plays.json', 'now-playing.json', 'jingle-playing.json',
  'bed-playing.json', 'listeners.jsonl', 'audience.json', 'likes.json',
  'seen-curiosity.json', 'next.txt', 'say.txt', 'intro.txt', 'sfx.txt',
  'auto.m3u', 'library.db-wal', 'library.db-shm', 'station.json',
  'settings.json.bak-pre-ollama', 'some-future-file.xyz',
]) assert.equal(duplicateAction(f), 'skip', f);

// --- conversion classification (spec §6) --------------------------------------
for (const f of ['stations', 'icecast-secrets.env', 'hf-cache', 'analyze-tmp', 'lost+found'])
  assert.equal(conversionAction(f), 'keep', f);
for (const f of ['settings.json', 'library.db', 'jingles', 'logs', 'archive', 'session.json'])
  assert.equal(conversionAction(f), 'move', f);

console.log('stations-pure.test: OK');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd controller && npx tsx scripts/stations-pure.test.ts`
Expected: FAIL — `Cannot find module '../src/stations/pure.js'`

- [ ] **Step 3: Write the implementation**

Create `controller/src/stations/pure.ts`:

```ts
// Pure helpers for multi-station profiles — no fs, no config import (config.ts
// depends on stations/resolve.ts, which depends on this file; keep it leaf-level).
// Spec: docs/superpowers/specs/2026-07-24-multi-station-profiles-design.md

// Station id = directory name under state/stations/. Also the containment
// guard's first line of defence (no dots, no slashes, no uppercase).
export const STATION_ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

// stations/active.json is controller-written as {"activeId":"<id>"} but parsed
// defensively — a hand-edited or truncated file must never crash a boot path.
export function parseActivePointer(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw);
    const id = parsed?.activeId;
    if (typeof id === 'string' && STATION_ID_RE.test(id)) return id;
  } catch {}
  return null;
}

export function slugifyStationName(name: string): string {
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 41)
    .replace(/-+$/g, '');
  return STATION_ID_RE.test(slug) ? slug : 'station';
}

// Duplicate = new station inherits identity/config, starts fresh history.
// Allowlist (default 'skip') so a future state file must be classified
// deliberately before it rides along into a duplicate.
const DUPLICATE_COPY = new Set([
  'settings.json', 'setup-config.json', 'secrets.env', 'moods.json',
  'schedule.json', 'jingles.m3u', 'jingles.json', 'beds.json', 'bed.mp3',
  'voices', 'persona-avatars', 'jingles', 'beds', 'skills', 'sfx',
  'icecast_listener_auth.txt',
]);

export function duplicateAction(entry: string): 'copy' | 'backup' | 'skip' {
  if (entry === 'library.db') return 'backup'; // live WAL handle → .backup() snapshot
  if (DUPLICATE_COPY.has(entry)) return 'copy';
  // Derived-from-settings.json files: copying keeps the pair consistent
  // (skipping them would leave a drift window until the first settings save).
  if (/^liquidsoap_.*\.txt$/.test(entry)) return 'copy';
  return 'skip';
}

// Conversion moves the legacy root's contents into stations/main/. Only
// install-level entries stay at the root (spec §2).
const INSTALL_LEVEL = new Set([
  'stations', 'icecast-secrets.env', 'hf-cache', 'analyze-tmp', 'lost+found',
]);

export function conversionAction(entry: string): 'move' | 'keep' {
  return INSTALL_LEVEL.has(entry) ? 'keep' : 'move';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd controller && npx tsx scripts/stations-pure.test.ts`
Expected: PASS — prints `stations-pure.test: OK`

- [ ] **Step 5: Stage**

```bash
git add controller/src/stations/pure.ts controller/scripts/stations-pure.test.ts
```

---

### Task 2: Boot-time pointer resolution + config wiring

**Files:**
- Create: `controller/src/stations/resolve.ts`
- Modify: `controller/src/config.ts:6-12` and the `config` object head (~line 39)
- Test: `controller/scripts/stations-resolve.test.ts`

**Interfaces:**
- Consumes: `parseActivePointer` from Task 1.
- Produces: `activeStationId(root: string): string | null`; `resolveActiveStationDir(root: string): string`; config exports `STATE_ROOT: string` (the raw root) while the existing `STATE_DIR` export becomes the RESOLVED station dir (all existing consumers keep working unchanged); `config.stateRoot: string`.

- [ ] **Step 1: Write the failing test**

Create `controller/scripts/stations-resolve.test.ts`:

```ts
// Boot-time pointer resolution — the function config.ts calls at module load.
// Run: npx tsx scripts/stations-resolve.test.ts

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeStationId, resolveActiveStationDir } from '../src/stations/resolve.js';

const root = mkdtempSync(join(tmpdir(), 'subwave-stations-'));
try {
  // no stations/ dir → single-station mode, resolve to root
  assert.equal(resolveActiveStationDir(root), root);
  assert.equal(activeStationId(root), null);

  // valid pointer + existing dir → station dir
  mkdirSync(join(root, 'stations', 'alpha'), { recursive: true });
  writeFileSync(join(root, 'stations', 'active.json'), '{"activeId":"alpha"}');
  assert.equal(activeStationId(root), 'alpha');
  assert.equal(resolveActiveStationDir(root), join(root, 'stations', 'alpha'));

  // pointer at a missing dir → fall back to root (never boot into a void)
  writeFileSync(join(root, 'stations', 'active.json'), '{"activeId":"ghost"}');
  assert.equal(activeStationId(root), null);
  assert.equal(resolveActiveStationDir(root), root);

  // malformed pointer → root
  writeFileSync(join(root, 'stations', 'active.json'), 'nope');
  assert.equal(resolveActiveStationDir(root), root);

  // traversal attempt in the pointer → root
  writeFileSync(join(root, 'stations', 'active.json'), '{"activeId":"../../etc"}');
  assert.equal(resolveActiveStationDir(root), root);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log('stations-resolve.test: OK');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd controller && npx tsx scripts/stations-resolve.test.ts`
Expected: FAIL — `Cannot find module '../src/stations/resolve.js'`

- [ ] **Step 3: Write the implementation**

Create `controller/src/stations/resolve.ts`:

```ts
// Boot-time resolution of the active station dir. Imported by config.ts at
// module load — keep this file leaf-level (node:fs/path + pure.ts only).
// Spec §3: resolution happens ONCE per process start; a pointer change only
// takes effect through the switch sequence (mixer restart + controller exit).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseActivePointer } from './pure.js';

// The id from stations/active.json, but only if its directory actually
// exists — a dangling pointer must never boot the controller into a void.
export function activeStationId(root: string): string | null {
  try {
    const raw = readFileSync(join(root, 'stations', 'active.json'), 'utf8');
    const id = parseActivePointer(raw);
    if (id && existsSync(join(root, 'stations', id))) return id;
  } catch {}
  return null;
}

export function resolveActiveStationDir(root: string): string {
  const id = activeStationId(root);
  return id ? join(root, 'stations', id) : root;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd controller && npx tsx scripts/stations-resolve.test.ts`
Expected: PASS — prints `stations-resolve.test: OK`

- [ ] **Step 5: Wire into config.ts**

In `controller/src/config.ts`, replace lines 6-12 (the `STATE_DIR` export) with:

```ts
import { resolveActiveStationDir } from './stations/resolve.js';

// The shared state ROOT — the compose files mount <repo>/state → /var/sub-wave
// and pass STATE_DIR=/var/sub-wave. Native dev (`npm run dev` from controller/)
// has no such mount, so it falls back to the repo-local state/ dir resolved
// relative to this file (controller/src/config.js → ../../state).
export const STATE_ROOT = process.env.STATE_DIR
  || resolve(dirname(fileURLToPath(import.meta.url)), '../../state');

// The ACTIVE station's state dir — every file-based IPC channel lives under
// here. Multi-station installs (state/stations/active.json present) resolve to
// stations/<activeId>/; single-station installs resolve to the root itself, so
// every existing consumer of STATE_DIR keeps working unchanged. Resolution is
// once-per-boot by design: switching stations restarts this process.
export const STATE_DIR = resolveActiveStationDir(STATE_ROOT);
```

(The `import { resolveActiveStationDir }` line goes with the other imports at the top of the file — keep `node:url`/`node:path` imports as they are.)

Then in the `config` object (currently starting `stateDir: STATE_DIR,`), add the root alongside:

```ts
  // Absolute path to the ACTIVE station's state dir — modules build their own
  // file paths from this rather than hardcoding /var/sub-wave.
  stateDir: STATE_DIR,
  // The install-level state root (stations/, icecast-secrets.env live here).
  stateRoot: STATE_ROOT,
```

- [ ] **Step 6: Typecheck + full test sweep**

Run: `cd controller && npx tsc --noEmit && npm test`
Expected: tsc clean; all `scripts/*.test.ts` pass (the two new ones included).

- [ ] **Step 7: Stage**

```bash
git add controller/src/stations/resolve.ts controller/scripts/stations-resolve.test.ts controller/src/config.ts
```

---

### Task 3: radio.liq state-root parameterization

**Files:**
- Modify: `liquidsoap/radio.liq` (all 50 `/var/sub-wave` literals; new var after the telnet settings block, before line ~21)

**Interfaces:**
- Consumes: env `SUBWAVE_STATE_DIR` (exported by Task 4/5 entrypoints; absent in dev bind-mount runs → default keeps today's behavior).
- Produces: a `state_dir` liq variable used by every state path.

- [ ] **Step 1: Bulk-replace the literals**

```bash
sed -i 's|"/var/sub-wave/|"#{state_dir}/|g' liquidsoap/radio.liq
```

This rewrites every quoted path literal, including the archive getter at line ~1507, which becomes:

```
archive_path = {time.string("#{state_dir}/archive/%Y-%m-%d/%H-00.mp3")}
```

- [ ] **Step 2: Define `state_dir` (AFTER the sed so the default survives)**

Insert after the telnet settings block (after line 15, `settings.server.telnet.port := 1234`), before the first `ref(...)`:

```
# Multi-station profiles: the state dir is the ACTIVE station's dir, resolved
# by the container entrypoint (docker/broadcast-entrypoint.sh / the AIO
# supervisor) from state/stations/active.json and exported as
# SUBWAVE_STATE_DIR. Single-station installs and dev runs get the default.
state_dir = environment.get(default="/var/sub-wave", "SUBWAVE_STATE_DIR")
```

(Same `environment.get(default=..., "NAME")` idiom as the ICECAST_HOST reads at line ~1532.)

- [ ] **Step 3: Verify no stray literals**

Run: `grep -n '"/var/sub-wave' liquidsoap/radio.liq`
Expected: exactly ONE hit — the `environment.get` default. (Unquoted mentions in comments are fine.)

Run: `grep -c '#{state_dir}' liquidsoap/radio.liq`
Expected: 50.

- [ ] **Step 4: Parse-check with the real liquidsoap**

Run (same image pin as `scripts/fx-render-test.sh`):

```bash
docker run --rm -v "$PWD/liquidsoap:/liq:ro" savonet/liquidsoap:v2.4.5 liquidsoap --check /liq/radio.liq
```

Expected: exit 0. (`--check` parses + type-checks only; interpolation inside `time.string` is evaluated per closure call at runtime, which is what we want.)

- [ ] **Step 5: Stage**

```bash
git add liquidsoap/radio.liq
```

---

### Task 4: Broadcast entrypoint resolution (+ generate-jingles.sh)

**Files:**
- Modify: `docker/broadcast-entrypoint.sh:33` (constants), `:42-65` (mkdir/touch/.ndignore), `:152-165` (`read_state_num`), `:200` (listener-auth flag)
- Modify: `scripts/generate-jingles.sh:13-29`

**Interfaces:**
- Consumes: `state/stations/active.json` written by the controller (Task 6).
- Produces: `SUBWAVE_STATE_DIR` env for liquidsoap (Task 3); icecast rendered from the ACTIVE station's files.

- [ ] **Step 1: Add the resolver at the top of the entrypoint**

In `docker/broadcast-entrypoint.sh`, replace line 33 (`SECRETS=/var/sub-wave/icecast-secrets.env`) with:

```bash
# ---- Multi-station pointer resolution ---------------------------------------
# state/stations/active.json (controller-written, {"activeId":"<slug>"}) picks
# which station dir this boot serves. Everything below reads from $STATE_DIR;
# only install-level files (icecast secrets) stay at $STATE_ROOT. No jq in
# this image — the sed matches the controller's canonical output and the slug
# charset [a-z0-9-], so a hand-mangled file falls back to the root.
STATE_ROOT=/var/sub-wave
STATE_DIR="$STATE_ROOT"
ACTIVE_FILE="$STATE_ROOT/stations/active.json"
if [ -f "$ACTIVE_FILE" ]; then
    ACTIVE_ID=$(sed -n 's/.*"activeId"[[:space:]]*:[[:space:]]*"\([a-z0-9][a-z0-9-]*\)".*/\1/p' "$ACTIVE_FILE" | head -n1)
    if [ -n "$ACTIVE_ID" ] && [ -d "$STATE_ROOT/stations/$ACTIVE_ID" ]; then
        STATE_DIR="$STATE_ROOT/stations/$ACTIVE_ID"
        echo "broadcast: active station '$ACTIVE_ID' → $STATE_DIR" >&2
    else
        echo "broadcast: WARNING stations/active.json unresolvable (id='$ACTIVE_ID') — using root" >&2
    fi
fi
export SUBWAVE_STATE_DIR="$STATE_DIR"

SECRETS=$STATE_ROOT/icecast-secrets.env
```

- [ ] **Step 2: Point the state bootstrap at the station dir**

In the `:42-65` block, change every `/var/sub-wave` in the `mkdir -p`, `chmod 777`, `touch`/`chmod 666` (auto.m3u/jingles.m3u) and `.ndignore` lines to `"$STATE_DIR"` — e.g.:

```bash
mkdir -p "$STATE_ROOT" \
         "$STATE_DIR" \
         "$STATE_DIR/voice" \
         "$STATE_DIR/voices" \
         "$STATE_DIR/archive" \
         "$STATE_DIR/jingles" \
         "$STATE_DIR/logs" \
         "$STATE_DIR/sessions" \
         "$STATE_DIR/sfx"
```

(keep the parallel `chmod 777` list in sync; `touch "$STATE_DIR/auto.m3u" "$STATE_DIR/jingles.m3u"`, `chmod 666` same; `touch "$STATE_DIR/archive/.ndignore"`).

- [ ] **Step 3: Point the state reads at the station dir**

- `read_state_num()` at `:154`: change `_v=$(cat "/var/sub-wave/$1" ...)` to `_v=$(cat "$STATE_DIR/$1" ...)`.
- `:200`: `LISTENER_AUTH_FLAG=$STATE_DIR/icecast_listener_auth.txt`.

Do NOT touch `RADIO_LOG` (that's `/var/log/liquidsoap`, unrelated) or the `SECRETS` sourcing (root by design).

- [ ] **Step 4: Verify with shell syntax check + grep**

Run: `bash -n docker/broadcast-entrypoint.sh`
Expected: exit 0.

Run: `grep -n '/var/sub-wave' docker/broadcast-entrypoint.sh`
Expected: only the `STATE_ROOT=/var/sub-wave` assignment (plus comments).

- [ ] **Step 5: Same pointer resolution in generate-jingles.sh**

In `scripts/generate-jingles.sh`, after `STATE_DIR` is read from the root `.env` (line ~15) and before `JINGLE_DIR_HOST=` (line ~27), insert:

```bash
# Multi-station: jingles live in the ACTIVE station's dir, not the state root.
CTR_STATE=/var/sub-wave
if [ -f "$STATE_DIR/stations/active.json" ]; then
    ACTIVE_ID=$(sed -n 's/.*"activeId"[[:space:]]*:[[:space:]]*"\([a-z0-9][a-z0-9-]*\)".*/\1/p' "$STATE_DIR/stations/active.json" | head -n1)
    if [ -n "$ACTIVE_ID" ] && [ -d "$STATE_DIR/stations/$ACTIVE_ID" ]; then
        STATE_DIR="$STATE_DIR/stations/$ACTIVE_ID"
        CTR_STATE="/var/sub-wave/stations/$ACTIVE_ID"
    fi
fi
```

and change line ~28 `JINGLE_DIR_CTR="/var/sub-wave/jingles"` to `JINGLE_DIR_CTR="$CTR_STATE/jingles"`.

Run: `bash -n scripts/generate-jingles.sh` → exit 0.

- [ ] **Step 6: Stage**

```bash
git add docker/broadcast-entrypoint.sh scripts/generate-jingles.sh
```

---

### Task 5: AIO supervisor resolution

**Files:**
- Modify: `docker/aio/supervisor.sh` — `read_state_num` (`:139`), `render_icecast()` FLAG (`:186`), `run_broadcast()` (`:245`)

**Interfaces:**
- Consumes: same `active.json` + sed parse as Task 4.
- Produces: per-relaunch resolution (the supervisor's `supervise broadcast` loop re-runs `run_broadcast` after every mixer restart, so a switch picks up the new pointer without a container bounce). `run_controller()` stays UNCHANGED — it exports `STATE_DIR=/var/sub-wave` (the root) and the controller resolves in Node (Task 2). `HF_HOME=/var/sub-wave/hf-cache` (Dockerfile.aio:191) is already root-level — no change.

- [ ] **Step 1: Add a shared resolver function**

Near the top of `docker/aio/supervisor.sh` (after the constants at `:22-24`), add:

```bash
# Multi-station pointer (see docker/broadcast-entrypoint.sh — kept in lockstep).
# Called at the top of run_broadcast so every mixer relaunch re-resolves.
STATE_ROOT=/var/sub-wave
STATE_DIR="$STATE_ROOT"
resolve_state_dir() {
	STATE_DIR="$STATE_ROOT"
	local active="$STATE_ROOT/stations/active.json" id=""
	if [ -f "$active" ]; then
		id=$(sed -n 's/.*"activeId"[[:space:]]*:[[:space:]]*"\([a-z0-9][a-z0-9-]*\)".*/\1/p' "$active" | head -n1)
		if [ -n "$id" ] && [ -d "$STATE_ROOT/stations/$id" ]; then
			STATE_DIR="$STATE_ROOT/stations/$id"
			log "active station '$id' → $STATE_DIR"
		else
			log "WARNING stations/active.json unresolvable (id='$id') — using root"
		fi
	fi
	export SUBWAVE_STATE_DIR="$STATE_DIR"
}
```

(Match the file's existing indentation style — it uses tabs.)

- [ ] **Step 2: Use it**

- `read_state_num` (`:139`): `_v=$(cat "$STATE_DIR/$1" ...)`.
- `render_icecast()` (`:186`): `local FLAG=$STATE_DIR/icecast_listener_auth.txt`.
- Top of `run_broadcast()` (`:245`, before `render_icecast` is called): add `resolve_state_dir` as the first line, and make sure the station-dir subdirs exist (mirror the entrypoint's mkdir list against `"$STATE_DIR"`).
- Leave `init_state`, `warn_if_state_unmounted` (`/proc/mounts` grep), `run_controller`, and the SECRETS path on the ROOT.

- [ ] **Step 3: Verify**

Run: `bash -n docker/aio/supervisor.sh`
Expected: exit 0.

Run: `grep -n 'SUBWAVE_STATE_DIR\|resolve_state_dir' docker/aio/supervisor.sh`
Expected: the function definition, the export inside it, and one call at the top of `run_broadcast`.

- [ ] **Step 4: Stage**

```bash
git add docker/aio/supervisor.sh
```

---

### Task 6: Station manager (fs orchestration)

**Files:**
- Create: `controller/src/stations/manager.ts`
- Test: `controller/scripts/stations-manager.test.ts`

**Interfaces:**
- Consumes: Task 1 pure helpers. Every function takes `root` explicitly (no config import — testable with a tmp root, and reusable by routes with `STATE_ROOT`).
- Produces (exact signatures — Task 7 wires these):

```ts
interface StationInfo { id: string | null; name: string; configured: boolean; createdAt: string | null; active: boolean; }
isMultiStation(root: string): boolean
activeIdOnDisk(root: string): string | null          // raw pointer, no dir-exists check
listStations(root: string, fallbackName: string): StationInfo[]
createStation(root: string, opts: { name: string; mode: 'fresh' | 'duplicate'; currentName: string; backupLibraryDb?: (dest: string) => Promise<void> }): Promise<{ id: string; converted: boolean }>
renameStation(root: string, id: string, name: string): void
deleteStation(root: string, id: string): void        // throws on the active station
activateStation(root: string, id: string): void      // writes the pointer; throws if already live
convertToMultiStation(root: string, currentName: string): string
```

- [ ] **Step 1: Write the failing test**

Create `controller/scripts/stations-manager.test.ts`:

```ts
// fs-level pins for the station manager against a throwaway root.
// Run: npx tsx scripts/stations-manager.test.ts

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as manager from '../src/stations/manager.js';

const root = mkdtempSync(join(tmpdir(), 'subwave-mgr-'));
try {
  // Seed a legacy single-station root.
  writeFileSync(join(root, 'settings.json'), '{"station":"Legacy FM"}');
  writeFileSync(join(root, 'setup-config.json'), '{}');
  writeFileSync(join(root, 'session.json'), '{}');
  writeFileSync(join(root, 'liquidsoap_crossfade.txt'), '4');
  writeFileSync(join(root, 'icecast-secrets.env'), 'SECRET=1');
  mkdirSync(join(root, 'jingles'));
  writeFileSync(join(root, 'jingles', 'a.wav'), 'x');

  // Single-station listing: one synthetic root entry.
  const single = manager.listStations(root, 'Legacy FM');
  assert.equal(single.length, 1);
  assert.equal(single[0].id, null);
  assert.equal(single[0].active, true);
  assert.equal(single[0].configured, true);

  // Conversion: everything moves except install-level entries.
  const mainId = manager.convertToMultiStation(root, 'Legacy FM');
  assert.equal(mainId, 'main');
  assert.ok(existsSync(join(root, 'stations', 'main', 'settings.json')));
  assert.ok(existsSync(join(root, 'stations', 'main', 'jingles', 'a.wav')));
  assert.ok(existsSync(join(root, 'icecast-secrets.env'))); // stayed
  assert.ok(!existsSync(join(root, 'settings.json')));      // moved
  assert.equal(manager.activeIdOnDisk(root), 'main');
  assert.equal(
    JSON.parse(readFileSync(join(root, 'stations', 'active.json'), 'utf8')).activeId,
    'main',
  );

  // Fresh create: identity card only, unconfigured.
  const fresh = await manager.createStation(root, {
    name: 'Night Shift', mode: 'fresh', currentName: 'Legacy FM',
  });
  assert.equal(fresh.id, 'night-shift');
  assert.equal(fresh.converted, false);
  const list = manager.listStations(root, 'x');
  const night = list.find((s) => s.id === 'night-shift');
  assert.equal(night?.configured, false);
  assert.equal(night?.name, 'Night Shift');

  // Duplicate: allowlist copies, runtime skipped, library.db via callback.
  writeFileSync(join(root, 'stations', 'main', 'library.db'), 'not-really-sqlite');
  const backups: string[] = [];
  const dup = await manager.createStation(root, {
    name: 'Night Shift', mode: 'duplicate', currentName: 'Legacy FM',
    backupLibraryDb: async (dest) => { backups.push(dest); },
  });
  assert.equal(dup.id, 'night-shift-2'); // slug collision → -2
  const dupDir = join(root, 'stations', 'night-shift-2');
  assert.ok(existsSync(join(dupDir, 'settings.json')));
  assert.ok(existsSync(join(dupDir, 'liquidsoap_crossfade.txt')));
  assert.ok(existsSync(join(dupDir, 'jingles', 'a.wav')));
  assert.ok(!existsSync(join(dupDir, 'session.json')));
  assert.deepEqual(backups, [join(dupDir, 'library.db')]);

  // Rename touches only the identity card.
  manager.renameStation(root, 'night-shift', 'Graveyard');
  assert.equal(
    JSON.parse(readFileSync(join(root, 'stations', 'night-shift', 'station.json'), 'utf8')).name,
    'Graveyard',
  );

  // Guards.
  assert.throws(() => manager.deleteStation(root, 'main'), /live/);
  assert.throws(() => manager.activateStation(root, 'main'), /already/);
  assert.throws(() => manager.activateStation(root, 'ghost'), /no such/i);
  assert.throws(() => manager.deleteStation(root, '../evil'), /invalid/);

  // Activate + delete the loser.
  manager.activateStation(root, 'night-shift');
  assert.equal(manager.activeIdOnDisk(root), 'night-shift');
  manager.deleteStation(root, 'night-shift-2');
  assert.ok(!existsSync(dupDir));
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log('stations-manager.test: OK');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd controller && npx tsx scripts/stations-manager.test.ts`
Expected: FAIL — `Cannot find module '../src/stations/manager.js'`

- [ ] **Step 3: Write the implementation**

Create `controller/src/stations/manager.ts`:

```ts
// Station-profile management: list/create/duplicate/rename/delete/activate and
// the one-time legacy-root conversion. All functions take the state ROOT
// explicitly — no config.js import (cycle-free, tmp-root testable). Routes
// pass config.stateRoot. Spec §5/§6.

import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync,
  rmSync, writeFileSync,
} from 'node:fs';
import { join, resolve as pathResolve, sep } from 'node:path';
import {
  STATION_ID_RE, conversionAction, duplicateAction, parseActivePointer,
  slugifyStationName,
} from './pure.js';

export interface StationInfo {
  id: string | null;          // null = unconverted single-station root
  name: string;
  configured: boolean;        // has setup-config.json (mirrors needsSetup)
  createdAt: string | null;
  active: boolean;
}

const stationsDir = (root: string) => join(root, 'stations');

// Slug-validate AND containment-check — both, always (defence in depth).
function stationPath(root: string, id: string): string {
  if (!STATION_ID_RE.test(id)) throw new Error(`invalid station id: ${id}`);
  const dir = pathResolve(stationsDir(root), id);
  if (!dir.startsWith(pathResolve(stationsDir(root)) + sep)) {
    throw new Error('station path escapes the stations dir');
  }
  return dir;
}

export function isMultiStation(root: string): boolean {
  return existsSync(stationsDir(root));
}

export function activeIdOnDisk(root: string): string | null {
  try {
    return parseActivePointer(readFileSync(join(stationsDir(root), 'active.json'), 'utf8'));
  } catch {
    return null;
  }
}

function readCard(dir: string): { name?: string; createdAt?: string } {
  try {
    return JSON.parse(readFileSync(join(dir, 'station.json'), 'utf8'));
  } catch {
    return {};
  }
}

export function listStations(root: string, fallbackName: string): StationInfo[] {
  if (!isMultiStation(root)) {
    return [{
      id: null,
      name: fallbackName,
      configured: existsSync(join(root, 'setup-config.json')),
      createdAt: null,
      active: true,
    }];
  }
  const active = activeIdOnDisk(root);
  return readdirSync(stationsDir(root), { withFileTypes: true })
    .filter((e) => e.isDirectory() && STATION_ID_RE.test(e.name))
    .map((e) => {
      const dir = join(stationsDir(root), e.name);
      const card = readCard(dir);
      return {
        id: e.name,
        name: typeof card.name === 'string' && card.name ? card.name : e.name,
        configured: existsSync(join(dir, 'setup-config.json')),
        createdAt: card.createdAt || null,
        active: e.name === active,
      };
    })
    .sort((a, b) => (a.name).localeCompare(b.name));
}

function writeActivePointer(root: string, id: string): void {
  stationPath(root, id);
  const file = join(stationsDir(root), 'active.json');
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ activeId: id }));
  renameSync(tmp, file); // atomic on the same fs — a reader never sees a torn file
}

function writeCard(dir: string, name: string): void {
  writeFileSync(
    join(dir, 'station.json'),
    JSON.stringify({ name, createdAt: new Date().toISOString() }, null, 2),
  );
}

export function convertToMultiStation(root: string, currentName: string): string {
  if (isMultiStation(root)) throw new Error('already multi-station');
  const id = 'main';
  const dest = join(stationsDir(root), id);
  mkdirSync(dest, { recursive: true });
  // fs.rename per entry — same filesystem, so this is fast and never copies.
  // The just-created stations/ dir classifies as 'keep' and skips itself.
  for (const entry of readdirSync(root)) {
    if (conversionAction(entry) === 'keep') continue;
    renameSync(join(root, entry), join(dest, entry));
  }
  writeCard(dest, currentName);
  writeActivePointer(root, id);
  return id;
}

function uniqueStationId(root: string, name: string): string {
  const base = slugifyStationName(name);
  let id = base;
  for (let n = 2; existsSync(join(stationsDir(root), id)); n++) {
    id = `${base.slice(0, 38)}-${n}`;
  }
  return id;
}

export async function createStation(root: string, opts: {
  name: string;
  mode: 'fresh' | 'duplicate';
  currentName: string;
  backupLibraryDb?: (dest: string) => Promise<void>;
}): Promise<{ id: string; converted: boolean }> {
  const name = String(opts.name || '').trim().slice(0, 80);
  if (!name) throw new Error('station name required');
  let converted = false;
  if (!isMultiStation(root)) {
    convertToMultiStation(root, opts.currentName);
    converted = true;
  }
  const sourceId = activeIdOnDisk(root);
  const id = uniqueStationId(root, name);
  const dest = stationPath(root, id);
  mkdirSync(dest, { recursive: true });
  writeCard(dest, name);
  if (opts.mode === 'duplicate' && sourceId) {
    const src = join(stationsDir(root), sourceId);
    for (const entry of readdirSync(src)) {
      const action = duplicateAction(entry);
      if (action === 'copy') {
        cpSync(join(src, entry), join(dest, entry), { recursive: true });
      } else if (action === 'backup' && opts.backupLibraryDb) {
        await opts.backupLibraryDb(join(dest, entry));
      }
    }
  }
  return { id, converted };
}

export function renameStation(root: string, id: string, name: string): void {
  const dir = stationPath(root, id);
  if (!existsSync(dir)) throw new Error('no such station');
  const card = readCard(dir);
  writeFileSync(
    join(dir, 'station.json'),
    JSON.stringify(
      { ...card, name: String(name || '').trim().slice(0, 80) || id },
      null, 2,
    ),
  );
}

export function deleteStation(root: string, id: string): void {
  const dir = stationPath(root, id);
  if (id === activeIdOnDisk(root)) throw new Error('cannot delete the live station');
  if (!existsSync(dir)) throw new Error('no such station');
  rmSync(dir, { recursive: true, force: true });
}

export function activateStation(root: string, id: string): void {
  const dir = stationPath(root, id);
  if (!existsSync(dir)) throw new Error('no such station');
  if (id === activeIdOnDisk(root)) throw new Error('station is already live');
  writeActivePointer(root, id);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd controller && npx tsx scripts/stations-manager.test.ts`
Expected: PASS — prints `stations-manager.test: OK`

- [ ] **Step 5: Stage**

```bash
git add controller/src/stations/manager.ts controller/scripts/stations-manager.test.ts
```

---

### Task 7: Routes + switch sequence + /state field

**Files:**
- Create: `controller/src/routes/stations.ts`
- Modify: `controller/src/server.ts` (import + one `app.use` line in the block at `:107-134`)
- Modify: `controller/src/routes/public.ts` (`GET /state` handler at `:434-469`)

**Interfaces:**
- Consumes: Task 6 manager (exact signatures above); `STATE_ROOT` from `config.js` (Task 2); `restartLiquidsoap()` from `broadcast/liquidsoap-control.js` (no args, `Promise<void>`, confirms the telnet port went down); `libraryDb.backup(destPath)` from `music/library-db.ts:381`; `settings.get()`; `requireAdmin` from `middleware/auth.js`.
- Produces: `GET/POST /stations`, `PATCH/DELETE /stations/:id`, `POST /stations/:id/activate`; `/state` gains `station: { id: string | null, name: string, multiStation: boolean }` where `id`/`multiStation` are **boot-frozen** (see step 3 — the switching UI depends on this).

- [ ] **Step 1: Write the routes**

Create `controller/src/routes/stations.ts`:

```ts
// Multi-station profile management (spec §4/§5). Offline stations are inert:
// list / rename / delete / make-live only — editing one means switching to it.

import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { STATE_ROOT } from '../config.js';
import * as settings from '../settings.js';
import * as manager from '../stations/manager.js';
import * as libraryDb from '../music/library-db.js';
import { restartLiquidsoap } from '../broadcast/liquidsoap-control.js';

export const router = express.Router();

// The switch: pointer already written → bounce the mixer (its container
// entrypoint re-resolves + re-renders icecast on restart), then exit so the
// compose restart policy boots this process against the new station dir.
// setImmediate so the HTTP response flushes first.
function scheduleSwitchExit(): void {
  setImmediate(async () => {
    try {
      await restartLiquidsoap();
    } catch (err) {
      console.error('[stations] mixer restart failed:', (err as Error).message);
    }
    console.log('[stations] exiting for station switch — supervisor restarts us');
    process.exit(0);
  });
}

const currentName = () => settings.get()?.station || 'SUB/WAVE';

router.get('/stations', requireAdmin, (req, res) => {
  res.json({
    multiStation: manager.isMultiStation(STATE_ROOT),
    activeId: manager.activeIdOnDisk(STATE_ROOT),
    stations: manager.listStations(STATE_ROOT, currentName()),
  });
});

router.post('/stations', requireAdmin, async (req, res) => {
  try {
    const { name, mode } = req.body || {};
    const { id, converted } = await manager.createStation(STATE_ROOT, {
      name: String(name || ''),
      mode: mode === 'duplicate' ? 'duplicate' : 'fresh',
      currentName: currentName(),
      // Fresh installs may never have opened library.db — a duplicate without
      // the analysis cache is still a valid station, so tolerate failure.
      backupLibraryDb: async (dest) => {
        try {
          await libraryDb.backup(dest);
        } catch (err) {
          console.warn('[stations] library.db copy skipped:', (err as Error).message);
        }
      },
    });
    // Conversion moved the running station's files under stations/main — this
    // process is now reading a stale root and must restart (spec §6).
    res.status(converted ? 202 : 201).json({ ok: true, id, converted, switching: converted });
    if (converted) scheduleSwitchExit();
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.patch('/stations/:id', requireAdmin, (req, res) => {
  try {
    manager.renameStation(STATE_ROOT, String(req.params.id), String(req.body?.name || ''));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.delete('/stations/:id', requireAdmin, (req, res) => {
  try {
    manager.deleteStation(STATE_ROOT, String(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.post('/stations/:id/activate', requireAdmin, (req, res) => {
  try {
    const id = String(req.params.id);
    manager.activateStation(STATE_ROOT, id);
    res.status(202).json({ ok: true, switching: true, activeId: id });
    scheduleSwitchExit();
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});
```

- [ ] **Step 2: Mount in server.ts**

In `controller/src/server.ts`: add the import next to the other route imports (match their style, e.g. `import { router as stationsRoutes } from './routes/stations.js';` — copy the exact pattern used by the line importing `./routes/settings.js`), and add `app.use(stationsRoutes);` to the mounting block (after `app.use(backupRoutes);`).

- [ ] **Step 3: Add the boot-frozen station field to /state**

In `controller/src/routes/public.ts`, add near the top (module scope, after imports):

```ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_ROOT } from '../config.js';
import { activeStationId } from '../stations/resolve.js';

// Boot-frozen on purpose: /state must report the station this process is
// ACTUALLY running, not the pointer file's current value. During a switch the
// pointer flips first — the admin UI polls /state and treats "station.id ===
// target" as "the new controller is up", which only works if this snapshot
// is taken once at boot.
const BOOT_STATION_ID = activeStationId(STATE_ROOT);
const BOOT_MULTI_STATION = existsSync(join(STATE_ROOT, 'stations'));
```

(Merge with any existing `node:fs`/`node:path` imports in the file rather than duplicating them.)

Then inside the `GET /state` handler's `res.json({ ... })`, after the `privacy: {...}` entry, add:

```ts
    station: {
      id: BOOT_STATION_ID,
      name: s?.station || 'SUB/WAVE',
      multiStation: BOOT_MULTI_STATION,
    },
```

- [ ] **Step 4: Typecheck + tests + lint**

Run: `cd controller && npm run lint && npm test`
Expected: eslint + tsc clean; all tests pass.

- [ ] **Step 5: Smoke the routes against a scratch state dir**

```bash
cd controller && STATE_DIR=$(mktemp -d) ADMIN_USER=a ADMIN_PASS=b PORT=7799 npx tsx src/server.ts &
sleep 4
curl -su a:b http://localhost:7799/stations
curl -su a:b -X POST -H 'content-type: application/json' -d '{"name":"Second","mode":"fresh"}' http://localhost:7799/stations
kill %1
```

Expected: first call returns `{"multiStation":false,...,"stations":[{"id":null,...}]}`; the POST returns `{"ok":true,"id":"second","converted":true,"switching":true}` and the process exits itself moments later (the `kill` may report "no such job" — that's the switch exit working). Don't leave the scratch server running.

- [ ] **Step 6: Stage**

```bash
git add controller/src/routes/stations.ts controller/src/server.ts controller/src/routes/public.ts
```

---

### Task 8: Admin UI — /admin/stations

**Files:**
- Create: `web/app/admin/stations/page.tsx`
- Create: `web/components/admin/StationsPanel.tsx`
- Modify: `web/components/admin/AdminShell.tsx` (lucide import at `:9-41`; `NAV_SECTIONS` System section at `:187-190`)

**Interfaces:**
- Consumes: `useAdminAuth().adminFetch` (`web/lib/adminAuth.ts` — prepends API base + Basic auth); shared `SkeletonCards` / `EmptyState` / `ErrorState` (`@/components/ui/...`); `V3AlertDialog` (`@/components/ui/alert-dialog`, props `{ open, onOpenChange, title, description, confirmLabel, danger, onConfirm }`); Task 7's `/stations` API + `/state`'s boot-frozen `station.id`.
- Note: do NOT use `lib/stationClient.ts` (player client, no admin auth) and don't confuse with `lib/stations.ts` (community directory — unrelated).

- [ ] **Step 1: Page wrapper**

Create `web/app/admin/stations/page.tsx` (exact shape of `web/app/admin/moods/page.tsx`):

```tsx
import type { Metadata } from 'next';
import StationsPanel from '../../../components/admin/StationsPanel';

export const metadata: Metadata = {
  title: 'Stations',
};

export default function AdminStationsPage() {
  return <StationsPanel />;
}
```

- [ ] **Step 2: Sidebar entry**

In `web/components/admin/AdminShell.tsx`: add `RadioTower` to the existing `lucide-react` import list, and in `NAV_SECTIONS` → the `System` section's `items`, insert before the Settings row:

```ts
      { href: '/admin/stations', id: 'stations', label: 'Stations', icon: RadioTower },
```

(`resolveCrumb()` derives the breadcrumb from `NAV_SECTIONS` — no other wiring.)

- [ ] **Step 3: The panel**

Create `web/components/admin/StationsPanel.tsx`. Follow `MoodsPanel.tsx`'s load pattern (`useAdminAuth`, `load` callback, hydration guard). Full component:

```tsx
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { RadioTower } from 'lucide-react';
import { useAdminAuth } from '../../lib/adminAuth';
import { SkeletonCards } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/error-state';
import { EmptyState } from '@/components/ui/empty-state';
import { V3AlertDialog } from '../ui/alert-dialog';

interface StationRow {
  id: string | null;
  name: string;
  configured: boolean;
  createdAt: string | null;
  active: boolean;
}

interface StationsResponse {
  multiStation: boolean;
  activeId: string | null;
  stations: StationRow[];
}

export default function StationsPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [data, setData] = useState<StationsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState('');
  const [newMode, setNewMode] = useState<'fresh' | 'duplicate'>('fresh');
  const [confirmLive, setConfirmLive] = useState<StationRow | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<StationRow | null>(null);
  const [renaming, setRenaming] = useState<StationRow | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // Non-null while a switch is in flight: the station id (or '__convert__')
  // whose controller boot we're waiting for.
  const [switching, setSwitching] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await adminFetch('/stations');
      if (!r.ok) throw new Error(`failed (${r.status})`);
      setData((await r.json()) as StationsResponse);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [adminFetch]);

  useEffect(() => {
    if (hydrated && !needsAuth) void load();
  }, [hydrated, needsAuth, load]);

  // While switching, poll /state until the NEW controller answers (its
  // station.id is boot-frozen, so a response with the target id means the
  // restart completed), then hard-reload.
  useEffect(() => {
    if (!switching) return;
    pollRef.current = setInterval(async () => {
      try {
        const r = await adminFetch('/state');
        if (!r.ok) return;
        const j = await r.json();
        const arrived =
          switching === '__convert__'
            ? j?.station?.multiStation === true
            : j?.station?.id === switching;
        if (arrived) window.location.reload();
      } catch {
        /* controller still down — keep polling */
      }
    }, 2000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [switching, adminFetch]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await adminFetch('/stations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: newName, mode: newMode }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `failed (${r.status})`);
      setNewName('');
      if (j.switching) setSwitching('__convert__');
      else await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const activate = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await adminFetch(`/stations/${id}/activate`, { method: 'POST' });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `failed (${r.status})`);
      setSwitching(id);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      const r = await adminFetch(`/stations/${id}`, { method: 'DELETE' });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `failed (${r.status})`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const rename = async () => {
    if (!renaming?.id) return;
    setBusy(true);
    try {
      const r = await adminFetch(`/stations/${renaming.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: renameValue }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `failed (${r.status})`);
      setRenaming(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!hydrated || needsAuth) return null;

  if (switching) {
    return (
      <EmptyState
        icon={<RadioTower className="h-8 w-8 animate-pulse" />}
        title="Switching stations…"
        description="The mixer and controller are restarting against the new station. Listeners reconnect automatically — this page reloads when the switch completes."
      />
    );
  }

  if (loading) return <SkeletonCards cards={3} label="Loading stations" />;
  if (error && !data) return <ErrorState error={error} onRetry={() => { setLoading(true); void load(); }} />;
  if (!data) return null;

  return (
    <div className="space-y-6">
      {error ? <ErrorState title="Action failed" error={error} /> : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {data.stations.map((s) => (
          <div key={s.id ?? '__root__'} className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="truncate text-sm font-semibold">{s.name}</h3>
              {s.active ? (
                <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-400">
                  Live
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-xs text-white/50">
              {s.id ?? 'current install'}
              {!s.configured ? ' · unconfigured' : ''}
              {s.createdAt ? ` · ${new Date(s.createdAt).toLocaleDateString()}` : ''}
            </p>
            {s.id && !s.active ? (
              <div className="mt-3 flex gap-2 text-xs">
                <button type="button" disabled={busy} onClick={() => setConfirmLive(s)} className="rounded border border-white/15 px-2 py-1 hover:bg-white/10 disabled:opacity-50">
                  Make live
                </button>
                <button type="button" disabled={busy} onClick={() => { setRenaming(s); setRenameValue(s.name); }} className="rounded border border-white/15 px-2 py-1 hover:bg-white/10 disabled:opacity-50">
                  Rename
                </button>
                <button type="button" disabled={busy} onClick={() => setConfirmDelete(s)} className="rounded border border-white/15 px-2 py-1 text-red-400 hover:bg-red-500/10 disabled:opacity-50">
                  Delete
                </button>
              </div>
            ) : s.id ? (
              <div className="mt-3 flex gap-2 text-xs">
                <button type="button" disabled={busy} onClick={() => { setRenaming(s); setRenameValue(s.name); }} className="rounded border border-white/15 px-2 py-1 hover:bg-white/10 disabled:opacity-50">
                  Rename
                </button>
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <div className="max-w-md rounded-lg border border-white/10 bg-white/[0.03] p-4">
        <h3 className="text-sm font-semibold">New station</h3>
        <p className="mt-1 text-xs text-white/50">
          {data.multiStation
            ? 'Fresh stations start in the onboarding wizard after you make them live.'
            : 'Creating a second station converts this install to multi-station and restarts the controller (~10 seconds).'}
        </p>
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Station name"
          className="mt-3 w-full rounded border border-white/15 bg-transparent px-2 py-1.5 text-sm"
        />
        <div className="mt-2 flex gap-4 text-xs">
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={newMode === 'fresh'} onChange={() => setNewMode('fresh')} />
            Fresh (onboarding)
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={newMode === 'duplicate'} onChange={() => setNewMode('duplicate')} />
            Duplicate current
          </label>
        </div>
        <button
          type="button"
          disabled={busy || !newName.trim()}
          onClick={() => void create()}
          className="mt-3 rounded bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20 disabled:opacity-50"
        >
          Create
        </button>
      </div>

      {renaming ? (
        <div className="max-w-md rounded-lg border border-white/10 bg-white/[0.03] p-4">
          <h3 className="text-sm font-semibold">Rename “{renaming.name}”</h3>
          <input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            className="mt-3 w-full rounded border border-white/15 bg-transparent px-2 py-1.5 text-sm"
          />
          <div className="mt-3 flex gap-2">
            <button type="button" disabled={busy || !renameValue.trim()} onClick={() => void rename()} className="rounded bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20 disabled:opacity-50">
              Save
            </button>
            <button type="button" onClick={() => setRenaming(null)} className="rounded border border-white/15 px-3 py-1.5 text-sm hover:bg-white/10">
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <V3AlertDialog
        open={confirmLive !== null}
        onOpenChange={(o) => { if (!o) setConfirmLive(null); }}
        title="Switch the live station"
        description={`Make “${confirmLive?.name ?? ''}” the live station? Every listener is dropped for ~10 seconds while the mixer and controller restart.`}
        confirmLabel="Make live"
        danger
        onConfirm={() => {
          if (confirmLive?.id) void activate(confirmLive.id);
          setConfirmLive(null);
        }}
      />
      <V3AlertDialog
        open={confirmDelete !== null}
        onOpenChange={(o) => { if (!o) setConfirmDelete(null); }}
        title="Delete station"
        description={`Delete “${confirmDelete?.name ?? ''}” and everything in its state directory? This cannot be undone.`}
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          if (confirmDelete?.id) void remove(confirmDelete.id);
          setConfirmDelete(null);
        }}
      />
    </div>
  );
}
```

Adjust class names to match neighbouring panels if the house style differs (check `MoodsPanel.tsx` for the card/border token conventions used in this repo) — no inline styles (eslint-forbidden).

- [ ] **Step 4: Lint**

Run: `cd web && npm run lint`
Expected: clean (eslint + tsc).

- [ ] **Step 5: Stage**

```bash
git add web/app/admin/stations/page.tsx web/components/admin/StationsPanel.tsx web/components/admin/AdminShell.tsx
```

---

### Task 9: Docs, final sweep, commit + PR

**Files:**
- Create: `docs/multi-station.md`
- Modify: `CLAUDE.md` (short bullet in "Working on this codebase")

**Interfaces:** none — documentation + release mechanics.

- [ ] **Step 1: Write docs/multi-station.md**

Cover, in this order (a page, not a book — mirror the tone of `docs/private-station.md`):
1. What it is: multiple independent stations in one install, one live at a time; `state/stations/<id>/` layout + `active.json` pointer; single-station installs unaffected until a second station is created.
2. Switching: what happens (mixer restart + controller restart), the ~10 s listener drop, fresh stations landing in `/onboarding`.
3. Duplicate vs fresh, and what a duplicate copies (identity/config/analysis) vs resets (history/logs/archive).
4. Caveats: env-provided creds (`NAVIDROME_*`, keys in `controller/.env`) apply to EVERY station — use the wizard/admin so values persist per-station; `subwave setup` (CLI) targets single-station roots; backups of `state/` now include all stations; per-station `library.db` means per-station analysis storage.
5. Dev-mode note: under `docker-compose.dev.yml` the controller runs `tsx watch` — if a switch leaves it down, `docker compose -f docker-compose.dev.yml restart controller`. Native `npm run dev` needs a manual restart after switching.

- [ ] **Step 2: CLAUDE.md bullet**

Add one bullet to "Working on this codebase" (keep it tight, matching the neighbours):

```markdown
- **Multi-station profiles**: `state/stations/<id>/` + `stations/active.json` decide the ACTIVE station dir, resolved once per boot in four places — `config.ts` (`STATE_DIR` = resolved dir, `STATE_ROOT` = root), `radio.liq` (`SUBWAVE_STATE_DIR` env), `docker/broadcast-entrypoint.sh`, and the AIO supervisor (kept in lockstep). No `stations/` dir → single-station, everything at the root as before. Switching = pointer write + mixer restart + controller `process.exit` (docker restart policy reboots both against the new dir) — never hot-swap state paths in-process. Only `icecast-secrets.env`, `hf-cache`, `analyze-tmp` stay install-level at the root (`conversionAction` in `stations/pure.ts` is the classifier; new root-level state files must be classified there and in `duplicateAction`).
```

- [ ] **Step 3: Full verification sweep**

```bash
cd controller && npm run lint && npm test && cd ../web && npm run lint && cd ..
bash -n docker/broadcast-entrypoint.sh && bash -n docker/aio/supervisor.sh && bash -n scripts/generate-jingles.sh
docker run --rm -v "$PWD/liquidsoap:/liq:ro" savonet/liquidsoap:v2.4.5 liquidsoap --check /liq/radio.liq
```

Expected: all clean.

- [ ] **Step 4: Single commit + push + PR update**

```bash
git add docs/multi-station.md CLAUDE.md
git commit -m "feat: multi-station profiles — independent state dirs switchable from admin

- state/stations/<id>/ layout + stations/active.json pointer, resolved once
  per boot by config.ts, radio.liq (SUBWAVE_STATE_DIR), the broadcast
  entrypoint, and the AIO supervisor
- station manager: convert/create(fresh|duplicate)/rename/delete/activate,
  duplicate copies identity+library.db (sqlite .backup), skips history
- routes: /stations CRUD + activate (mixer restart + controller clean exit);
  /state gains a boot-frozen station{} field the switching UI polls
- admin: /admin/stations page (cards, make-live/rename/delete confirms,
  switching overlay)
- single-station installs untouched until a second station is created"
git push
gh pr edit 1156 --title "feat: multi-station profiles" --body "$(gh pr view 1156 --json body -q .body)

---
Implementation is now included (see the plan in docs/superpowers/plans/). Spec unchanged."
```

(Leave the PR as draft — the operator flips it ready after their own review.)

- [ ] **Step 5: Manual dev-stack verification (operator-visible checklist)**

Using the `subwave-worktree-dev` + `verify` skill flow (isolated controller + temp STATE_DIR):
1. Boot legacy-shaped state → `/admin/stations` shows one card ("current install", Live).
2. Create "Second" (fresh) → switching overlay → reload → converted: `stations/main` + `stations/second` on disk, `main` still live.
3. Make `second` live → mixer + controller restart → `/onboarding` (unconfigured station).
4. Switch back to `main` → station plays as before; check icecast re-rendered (different `liquidsoap_stream_bitrate.txt` per station shows per-mount burst differences in the rendered icecast.xml).
5. Duplicate `main` → new station has settings + jingles + library.db, empty session/logs.
6. Delete the duplicate (offline) → dir gone; deleting the live station → 400.
7. Verify `tsx watch` behavior on switch in dev compose; if it doesn't respawn, confirm the documented `docker compose restart controller` fallback and keep the docs note.
