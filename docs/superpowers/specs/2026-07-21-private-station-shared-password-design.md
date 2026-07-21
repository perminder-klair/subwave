# Private station: one shared password, folded into Station settings

Revision of the private-station design (`2026-07-16-private-station-design.md`,
PR #1058) before it merges. Three changes, driven by operator feedback:

1. The Privacy settings section folds into **Station** — no separate tab.
2. Both locks (private player, stream password) share **one station password**.
3. The private-player gate asks for that password instead of linking to
   **admin sign-in**.

Everything not listed here carries over from the original design unchanged.

## Why

The original shipped two locks with asymmetric unlock stories: the stream had a
shared listener password, but the player screen was a dead end whose only exit
was signing into the admin console. That means an operator who wants to share a
private station with a friend has to either hand out admin credentials (bad) or
tell them to ignore the web player and paste a `user:pass@` URL into VLC
(worse). One password for both locks is the shape people actually want.

Folding the section into Station also fixes a real bug found while testing the
original: the `Private player` toggle sat in a card with no Save button, and the
only Save lived in a *different* card below it. Toggling it appeared to work and
silently did not persist. `StationSection` already uses `SaveBar`, so moving the
controls there fixes this by construction rather than by adding another button.

## The load-bearing detail: two endpoints, opposite failure modes

`POST /listener-auth` deliberately **fails open** when stream auth is off:

```js
if (!opts.enabled) return true;   // enabled = privacy.listenerAuth === true
```

This is correct and must stay. It covers the window where the operator has
switched stream auth off but the broadcast container has not restarted yet, so
`icecast.xml` still carries the `<authentication>` blocks and Icecast is still
calling on every connect. Failing closed there would lock out every listener
until the restart landed.

The UI gate needs the opposite. With **private player ON and stream password
OFF**, `enabled` is false, so reusing `/listener-auth` for the player prompt
would accept *any* password — a decorative lock. The player gate must fail
**closed**.

Same password, same module, different decision:

| | `listenerAuth` off, `privatePlayer` on | no password on file |
|---|---|---|
| `POST /listener-auth` (Icecast) | allow (restart grace) | deny |
| `POST /station-auth` (web UI) | **deny unless password matches** | deny |

So: a sibling endpoint `POST /station-auth`, backed by a sibling pure function
`stationAuthDecision()` in `controller/src/util/listener-auth.ts`. Both reuse
the existing constant-time `safeEqual`. Icecast's contract is untouched.

## Settings shape

```ts
privacy: {
  privatePlayer: boolean,   // gate the web player pages
  listenerAuth:  boolean,   // gate the Icecast stream mounts
  password:      string,    // renamed from listenerPassword — serves both
}
```

`listenerPassword` → `password` because it no longer gates only listeners.
PR #1058 is unmerged, so no migration or back-compat shim is needed. The
`'set'` redaction sentinel from `getRedacted()` is unchanged.

### Validation (`settings.ts`)

The existing rule — stream auth on requires a password — generalises:

```
(privatePlayer || listenerAuth) && !password  →  throw
```

The new half matters: enabling `privatePlayer` with no password would render a
prompt nobody can satisfy, locking the operator out of their own player with no
in-band recovery. Clearing the password while either toggle is on throws for
the same reason.

Restart semantics are unchanged: `listenerAuth` still rides `requiresRestart`
(it re-renders `icecast.xml`); `privatePlayer` and password changes still apply
live.

## Player gate

`PrivateStationScreen` and `StreamAuthOverlay` collapse into one
`StationPasswordGate`. One prompt, one validation path, one stored token. The
only difference is why it appeared and what it covers:

| State | Behaviour |
|---|---|
| `privatePlayer` on, no valid token | Gate **replaces** the player — no `<audio>`, no skin mounted |
| `listenerAuth` on only | Gate **overlays** the player, as today |
| Both on | One prompt; unlocking reveals the UI *and* supplies the stream token |
| Neither | No gate |

The replace-don't-overlay behaviour for `privatePlayer` is deliberate and
already verified in the current PR: the shell must not mount the audio element
or the skin, so a private station's public pages stop advertising it.

Token storage key renames `subwave-stream-auth` → `subwave-station-auth`, since
it now unlocks the UI too. `usePlayer` keeps appending it as `?auth=` on the
mount query — browsers still cannot attach basic auth to an `<audio>` element.
A stale token (rotated password) fails its check and re-prompts, unchanged.

## Settings UI

- Delete `web/components/admin/settings/PrivacySection.tsx`.
- Remove the `{ id: 'privacy' }` entry from `SECTIONS` and the now-unused `Lock`
  icon import in `SettingsPanel.tsx`.
- Add one **Privacy** card to `StationSection.tsx`, after Localization: both
  switches plus the shared password field, with the `restart required` pill
  staying on the stream-password switch only.
- Extend the Station section's header copy, which currently reads "How the DJ
  identifies this radio on air" — that no longer covers who is allowed to hear
  it.
- `form.privacy` already exists in `FormState`; it persists through Station's
  existing `SaveBar`.

## Testing

Add `controller/scripts/listener-auth.test.ts`, registered in the runner. It
pins both decision functions, and specifically the asymmetry above:

- `listener_remove` is never denied.
- Icecast path: auth disabled → allow (the restart-grace case).
- **UI path: stream auth disabled but private player on → deny a wrong
  password, allow the right one.** This is the case that would silently
  regress into a decorative lock.
- Either path with a toggle on and no password on file → deny (fail closed).
- Basic-auth `pass` field and `?auth=` mount token are accepted equivalently.
- Wrong password of a different length is denied (the digest compare).

`listener-auth.ts` already claims in its header comment to be kept pure "so it
can be pinned by a unit test"; no such test exists today. This closes that.

## Docs

`docs/private-station.md` needs the tune-in story rewritten: the web player now
asks for the station password rather than offering an admin sign-in link, and
"listener password" becomes "station password" throughout.

## Out of scope

Unchanged from the original design, and worth restating because the phrase "no
admin auth" could be misread:

- **The admin console keeps its own `ADMIN_USER` / `ADMIN_PASS` gate.** This
  change stops the *player* gate from using admin credentials; it does not
  remove protection from `/admin`.
- Per-user accounts / OIDC — an Icecast constraint, not a shortcut.
- Gating the public now-playing / state JSON endpoints.
- `/landing` stays ungated; a private install should leave
  `SUBWAVE_HOMEPAGE=player`.
- Native-app UI for entering the password (works today via `user:pass@` in the
  station URL).
