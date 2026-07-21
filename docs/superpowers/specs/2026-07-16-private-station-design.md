# Private Station Mode — Design (issue #478)

## Problem

Operators who don't want their station exposed to the open web have no option
today: the web player is public, and anyone who guesses the trivially guessable
mount URL (`/stream.mp3`) can listen. Issue #478 asks for (a) a way to keep the
station private and (b) clarity on idle usage (answered in the issue — no code
change; `llm.pauseWhenEmpty` already stops the expensive part).

Per the discussion (cedhuf), the deliberate scope is **one shared station
password**, not per-user accounts: Icecast can only do basic auth, native radio
clients all support `user:pass@host` URLs, and OIDC/session auth is not viable
for a live audio stream.

## Solution overview

Two independent toggles in a new `settings.privacy` section:

1. **`privatePlayer`** — hide the public web pages. `/`, `/listen`, `/landing`
   render a minimal "this station is private" screen with a link to `/admin`.
   Applies live (no restart). UI-level privacy only: the public JSON endpoints
   (`/state`, `/now-playing`) keep working — the player needs them to know the
   station is private, and the admin dash reads them unauthenticated. Documented
   limitation, not a security boundary. The security boundary is (2).

2. **`listenerAuth` + `listenerPassword`** — Icecast listener authentication on
   every stream mount, enforced via Icecast's **URL auth** (`<authentication
   type="url">`) calling back into the controller. The controller is the single
   source of truth for the password: password changes apply instantly (no
   Icecast restart); only flipping `listenerAuth` itself re-renders icecast.xml
   and therefore rides the existing **restart-mixer** flow (same UX as the
   Opus/AAC toggles — `requiresRestart` in the save response, restart button in
   the admin UI).

Why URL auth instead of htpasswd: htpasswd's file format is undocumented
(MD5-managed via Icecast's admin web UI), needs a re-render+restart on every
password change, and splits the source of truth. URL auth is documented
(Icecast 2.4 docs), POSTs the listener's `user`/`pass` **and the mount path
including its query string** (verified: `mount=/stream.mp3?auth=tok`), and the
auth server allows a listener by answering `icecast-auth-user: 1`.

Two credential paths, one endpoint:

- **Native/external clients** (VLC, Sonos apps, radio apps, the SUB/WAVE native
  app): `https://anything:PASSWORD@station.example/stream.mp3` — basic auth.
  Icecast forwards `user`/`pass` form fields; we compare `pass` only (any
  username accepted — one shared password, no user list). The native app
  already splits `user:pass@` station URLs into stream Authorization headers
  (#764, `app/src/lib/api.ts:197`), so it works with zero app changes.
- **Web player**: browsers can't attach basic auth to `<audio>` (verified —
  `PlayerShell.tsx` audio element, src set imperatively in `usePlayer.ts`), so
  the player appends `?auth=PASSWORD` to the stream URL and the controller
  accepts the token from the mount's query string.

Failure mode when enabled: if the controller is down, Icecast rejects **new**
listener connects (already-connected listeners are unaffected). Failing closed
is correct for a private station; noted in admin copy.

## Components

### 1. Controller — settings (`controller/src/settings.ts`)

- `DEFAULTS.privacy = { privatePlayer: false, listenerAuth: false, listenerPassword: '' }`.
- `load()` normalization: typeof-guard each field against DEFAULTS (existing
  pattern, e.g. `stream` at ~1824).
- `update()` validation:
  - booleans coerced with `!!`;
  - `listenerPassword`: string, trimmed, max 128 chars, no whitespace/newlines
    (it travels in URLs and basic auth); the `'set'` redaction sentinel is
    ignored (keeps the stored value, same as `applyApiKey`);
  - enabling `listenerAuth` with an empty stored password throws a validation
    error;
  - flipping `listenerAuth` sets `restart = true` (rides `requiresRestart`);
    password / `privatePlayer` changes do not.
- `getRedacted()` masks `privacy.listenerPassword` → `'set'` sentinel.
- `writeLiquidsoapSettings()` additionally writes
  `${STATE_DIR}/icecast_listener_auth.txt` (`'true'`/`'false'`), seeded by
  `ensureLiquidsoapSettingsFile()`. Read by the **broadcast entrypoint** (not
  liquidsoap) at container boot; missing file = disabled.

### 2. Controller — `POST /listener-auth` (`controller/src/routes/public.ts`)

Icecast-compatible listener auth endpoint. Form-encoded body
(`express.urlencoded` scoped to this route). No admin gate, **no per-IP rate
limiting** — the caller is Icecast (the broadcast container), so per-IP
limiting would put every listener in one bucket. Timing-safe compares.

Logic (pure decision function `listenerAuthDecision()` for clarity):

- `action=listener_remove` → 200 (bookkeeping only).
- `listenerAuth` disabled in settings → allow. (Covers the "disabled in
  settings but broadcast not yet restarted" window — disabling never strands
  listeners.)
- Allow if `pass` matches `listenerPassword`, OR the `mount`'s query string
  carries `auth=<password>`.
- Allow → `icecast-auth-user: 1` header + 200. Deny → 401 (no header). The 401
  status lets the web player reuse this endpoint to validate a typed password
  (`res.ok`).

Never log the submitted password. Brute-force via direct endpoint hits is
possible but bounded by the timing-safe compare and the single shared secret;
per-listener-IP lockout (keyed on the `ip` form field) is a possible follow-up.

### 3. Controller — `/state` + tune-in files

- `/state` gains `privacy: { privatePlayer: boolean, listenerAuth: boolean }`
  (never the password).
- `/listen.pls` + `/listen.m3u` return 403 when `listenerAuth` is on (they
  would emit dead credential-less URLs; operators share credentialed URLs
  instead).

### 4. Broadcast — icecast.xml render (`docker/icecast.xml.template`,
`docker/broadcast-entrypoint.sh`, `docker/aio/supervisor.sh`)

- Template gains a placeholder line `<!--@LISTENER_AUTH_MOUNTS@-->`.
- Entrypoint: if `/var/sub-wave/icecast_listener_auth.txt` is exactly `true`,
  generate one `<mount type="normal">` block per mount (`/stream.mp3`,
  `/stream.opus`, `/stream.flac`, `/stream.aac` — a block for a never-sourced
  mount is harmless) with:

  ```xml
  <authentication type="url">
    <option name="listener_add" value="${LISTENER_AUTH_URL}"/>
    <option name="auth_header" value="icecast-auth-user: 1"/>
  </authentication>
  ```

  Substituted via `sed -e "/placeholder/r mounts-file" -e "/placeholder/d"`.
- `LISTENER_AUTH_URL` env, default `http://controller:7701/listener-auth`
  (the `controller` service name resolves from `broadcast` in all three
  composes — **no compose edits, no CLI asset re-embed**). The AIO supervisor
  duplicates the render (existing duplication) with a `http://localhost:7701`
  default.
- The existing `/restart-mixer` flow already bounces the whole broadcast
  container (liquidsoap `shutdown()` → supervisor exits → docker restart
  policy → entrypoint re-renders icecast.xml), so toggling applies through the
  established restart button. The AIO supervisor re-renders on pair relaunch.

### 5. Web — player auth (`web/lib/streamAuth.ts`, `usePlayer.ts`,
`PlayerShell.tsx`)

- `web/lib/streamAuth.ts`: `get/set/clearStreamAuthToken()` over
  `localStorage['subwave-stream-auth']` (mirrors the skin/theme override
  pattern).
- `usePlayer.ts`: the two `el.src = \`${streamUrl}?t=...\`` sites (tune +
  reconnect watchdog) go through one `srcFor()` helper that appends
  `&auth=<encodeURIComponent(token)>` when a token is stored. Harmless when
  auth is off.
- **Auth overlay** — a single skin-agnostic component mounted in
  `PlayerShell.tsx` (like the toaster, above the skin): when
  `state.privacy.listenerAuth` is true and no stored token, render a minimal
  password prompt. Submit → `POST /api/listener-auth`
  (`action=listener_add&pass=…` form) → `res.ok` ? store token + dismiss :
  inline error. On mount with a stored token, validate it once the same way;
  invalid (password rotated) → clear + re-prompt. Honors theme tokens; no
  per-skin work.

### 6. Web — private player gate + admin card

- `/`, `/listen`: `PlayerApp` renders a `PrivateStationScreen` (station name,
  "This is a private station.", link to `/admin`) when
  `state.privacy.privatePlayer` is true (feed already polls `/state`).
  `/landing` does a light client fetch of `/state` for the same gate. `/admin`,
  `/onboarding`, `/setup` unaffected. Showcase embeds unaffected (they never
  mount `PlayerPageEffects`; the gate lives in the page-level components).
- Admin: new **Privacy** section in `web/components/admin/settings/`
  (registered in `SettingsPanel.tsx` SECTIONS): `privatePlayer` toggle
  (applies live), `listenerAuth` toggle + password field (redaction sentinel
  aware), "restart required" pill + existing `pendingRestart` toast flow, and
  copy showing the two listener URL forms
  (`https://user:PASSWORD@…/stream.mp3` and `…/stream.mp3?auth=PASSWORD`)
  plus the controller-down fail-closed note.

### 7. Docs

- `docs/private-station.md`: what each toggle does, listener URL recipes
  (VLC/Sonos/native app), the fail-closed behavior, and the explicit
  limitations (metadata endpoints stay public; shared single password).
- CLAUDE.md: one short paragraph under Architecture (icecast secrets area)
  describing the URL-auth callback and the `icecast_listener_auth.txt` flag.

## Error handling

- Controller unreachable from Icecast → new connects 401 (fail closed).
- Stale token in web player after password rotation → validated on mount,
  cleared, re-prompted.
- Missing/garbled `icecast_listener_auth.txt` → auth disabled (only literal
  `true` enables, mirroring `archive_enabled`).
- Enabling auth without a password → settings validation error, nothing saved.

## Testing

No controller test harness beyond the pure-fn pins; `listenerAuthDecision()`
is written as a pure function for future pinning. Verification: `npm run lint`
in `controller/` and `web/` (the CI merge gate), plus a manual smoke of the
rendered icecast.xml generation path (entrypoint logic exercised with a temp
dir).

## Out of scope

- Per-user accounts / OIDC (Icecast constraint, per issue discussion).
- Gating the public JSON metadata endpoints.
- Native-app UI for entering the password (works today via `user:pass@` in the
  station URL; a dedicated field is a possible follow-up).
- Custom header support in the iOS app (HearthCore's request — separate issue).
