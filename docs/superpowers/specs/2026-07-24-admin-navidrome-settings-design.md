# Admin-panel Navidrome configuration — design

**Date:** 2026-07-24
**Status:** Draft for review

## Problem

Navidrome credentials (URL + user + password) can only be set through the
first-run wizard (`/onboarding`), the CLI (`subwave setup`), or root-`.env`
vars. Once a station is running there is no way to change them from the admin
panel — moving Navidrome to a new host, rotating its password, or fixing a typo
means re-running the wizard or editing files on the host. The always-on
`NavidromeBanner` even tells the operator to "check the URL / username /
password in setup" with nowhere in the admin UI to actually do that.

## Goal

A **Music source** section in `/admin/settings` where the operator can view,
test, and change the Navidrome connection — with the same live-apply behaviour
the wizard has (no restart needed), and honest handling of the env-always-wins
rule.

## Approaches considered

- **A (recommended): dedicated `/settings/navidrome` endpoints + a new
  Settings section.** Read state rides the existing `GET /settings` payload;
  save/test get small dedicated routes that share the wizard's logic via
  extracted helpers. Clean surface, no wizard semantics leaking in.
- **B: reuse the onboarding endpoints from a new admin section.**
  `POST /onboarding/save` + `POST /onboarding/test-navidrome` already do the
  work, but there is no GET that returns the saved URL/user for prefill (the
  wizard never needs one), and `/onboarding/save` stamps `setupCompletedAt` on
  every call. B needs a new GET anyway, at which point A costs the same and
  reads better.
- **C: link out to `/onboarding` from the admin shell.** Zero new code, but
  the wizard is a full multi-step first-run flow — terrible UX for "rotate one
  password", and it re-prompts for LLM/TTS/DJ choices.

Approach A is the design below.

## Persistence model (unchanged)

Navidrome creds stay in `state/setup-config.json` via `saveSetupConfig()` —
the same overlay the wizard and CLI write. `settings.json` is untouched; the
split documented in `controller/src/setup/config.ts` (settings = runtime admin
store, setup-config = env-var-shaped fields) is preserved. Env always wins:
`server.ts` only applies setup-config values where the matching
`NAVIDROME_*` env var is blank, and that rule is surfaced in the UI rather
than fought.

Because `setup-config.json` lives under the resolved `STATE_DIR`, multi-station
profiles get per-station Navidrome for free — the admin section edits the
active station's file, same as the wizard.

## Controller changes

### 1. Extract shared helpers

- **`setup/config.ts` — `applyNavidromeToLiveConfig(nv)`**: the three
  `config.navidrome.*` mutations currently inlined in `/onboarding/save`.
  Both save paths call it so live-apply behaviour can't drift.
- **`music/subsonic.ts` — `pingWith({ url, user, pass })`**: the one-off
  salt+token `/rest/ping` probe currently inlined in
  `/onboarding/test-navidrome` (5s timeout, returns
  `{ ok, serverVersion?, serverType?, error? }`). The onboarding route becomes
  a thin wrapper over it; the new test route reuses it. Client id stays
  distinguishable (`sub-wave-admin` vs `sub-wave-wizard`) via an optional
  `client` arg.

### 2. `GET /settings` — add a `navidrome` block

```jsonc
navidrome: {
  url: "https://music.example.com",   // current effective value (config.navidrome.url)
  user: "radio",
  passSet: true,                       // password on file (config), never the value
  env: { url: false, user: false, pass: false }  // per-field: is NAVIDROME_* set in env?
}
```

Per-field env flags (not one boolean) because `server.ts` applies setup-config
per-field — a station can have `NAVIDROME_URL` in env but user/pass from the
wizard. The password value itself never leaves the controller, matching the
`getRedacted()` convention everywhere else.

### 3. `POST /settings/navidrome` — save (admin-gated)

Body `{ url?, user?, pass? }`. Behaviour:

- Merge over the currently effective values: a blank `pass` with a password
  on file keeps the stored one (the `'set'`-sentinel pattern the LLM/embedding
  sections use, applied as "blank = keep").
- Validate the merged result is complete (url + user + pass all non-empty) —
  clearing creds to empty is not allowed, same threshold `needsSetup` gates
  on. URL is trimmed and stripped of trailing `/`, as in the wizard.
- Reject fields that are env-managed (`400` naming the env var) rather than
  silently persisting a value that env will shadow on next boot.
- Persist **only the submitted fields** via `saveSetupConfig()` (it already
  deep-merges the `navidrome` block), so an env-shadowed value never gets
  copied into `setup-config.json`. Then
  `applyNavidromeToLiveConfig()` so Subsonic calls use the new creds
  immediately — no restart, same as the wizard.
- Post-save side effects:
  - `refreshAutoPlaylist()` fire-and-forget — `auto.m3u` entries carry
    annotated URIs with auth tokens derived from the old password, so the
    playlist must be rebuilt (same rationale as the post-onboarding kick).
  - Reset the doctor's 20s Navidrome ping cache (export a
    `clearNavidromeCache()` from `doctor.ts`) so the `NavidromeBanner` and
    DJ Doc reflect the new target on their next poll instead of up to 20s
    later.
  - During implementation, check `music/picker.js` / `music/subsonic.js` for
    a memo-invalidation hook and call it if one exists; the 30-min Subsonic
    memos hold song lists whose ids are junk if the operator pointed at a
    *different* server. If no hook exists, accept the staleness (bounded at
    30 min, self-heals) rather than building invalidation for this feature.
- Does **not** stamp `setupCompletedAt` — that stays a wizard concept.
  (`needsSetup` keys on cred presence, not the stamp, so a fresh install that
  configures Navidrome here still exits the onboarding redirect.)

### 4. `POST /settings/navidrome/test` — connection test (admin-gated)

Body `{ url?, user?, pass? }`, merged over effective values exactly like save
(so "Test" works with the stored password without the browser ever seeing it),
then `pingWith()`. Non-mutating. Returns the wizard shape:
`{ ok, serverVersion?, serverType?, error? }`.

The onboarding test route stays as-is for the wizard (it must test creds that
aren't saved anywhere yet and must not fall back to stored ones).

## Web UI changes

### New section in the Settings rail

`{ id: 'music', label: 'Music source', hint: 'navidrome · subsonic', icon: Music2 }`
inserted directly after `station`. The existing `?section=` deep-link effect
picks it up with no changes (`/admin/settings?section=music`).

### `web/components/admin/settings/NavidromeSection.tsx`

Follows the established section pattern (`SectionHeader`, `Card`, `SaveBar`
from `shared.tsx` / `admin/ui`), but holds **local state** instead of joining
the shared `FormState` — Navidrome isn't part of `settings.json` values, so it
prefills from the `navidrome` block of the `GET /settings` payload and saves
through its own endpoint. Needs only `data`, `adminFetch`, and `refresh` as
props.

- **Fields:** Server URL, Username, Password. Password input is write-only
  with placeholder `•••••• (on file)` when `passSet`; sent only when typed.
- **Env-managed fields** render disabled with a hint naming the var:
  "Set via `NAVIDROME_URL` in the root `.env` — env always wins on boot;
  remove it there to manage it here." If all three are env-managed, the
  SaveBar is hidden and the section is a read-only status view.
- **Test connection** button posts the current form values to
  `/settings/navidrome/test` and renders the result inline (green
  "✓ Connected — Navidrome 0.52 (subsonic 1.16.1)" / red error), mirroring
  the LibrarySection probe styling.
- **Save** posts to `/settings/navidrome`, toasts via `notify`, refreshes the
  settings payload. Note under the bar: "Applies immediately — the auto
  playlist is rebuilt with the new connection; no restart needed."

### `NavidromeBanner` copy fix

The banner's "Check the URL / username / password in setup" becomes a link to
`/admin/settings?section=music` ("check the connection in Settings → Music
source"). The DJ Doc link stays.

## Error handling

- Save with an unreachable server still saves (matching the wizard, where
  test is advisory) — the operator may be pre-configuring a server that isn't
  up yet. The banner + test button cover reachability; save covers intent.
- All new routes are `requireAdmin`-gated and return the standard
  `{ ok:false, error }` / 400 shapes.
- `settings.ts` (the store) is untouched, so no schema-validation changes.

## Testing

No test runner in the repo; `npm run lint` in `controller/` and `web/` is the
gate. Manual verification via the `verify` skill flow (isolated controller +
worktree Next dev server + Playwright against `/admin/settings?section=music`):
prefill, test-button success/failure, save round-trip, env-locked rendering,
banner link.

## Out of scope

- Moving Navidrome creds into `settings.json` (the setup-config split is
  deliberate and documented).
- Multiple music sources / non-Navidrome Subsonic server presets.
- Encrypting the password at rest (unchanged from today's setup-config
  behaviour).
- CLI changes — `subwave setup` keeps working against the same file.
