# Private station mode

SUB/WAVE is public by default: anyone with the address can open the player and
anyone who guesses `/stream.mp3` can listen. If you'd rather keep your station
to yourself (issue #478), **admin → Settings → Privacy** gives you two
independent locks.

## Private player (UI lock)

Swaps the public web pages (`/`, `/listen`) for a minimal "this station is
private" screen with a link to the admin sign-in. `/admin` and `/onboarding`
keep working. Applies live — no restart.

This only hides the interface. The now-playing JSON endpoints stay public
(the player and admin dash rely on them), and the stream URL still works —
for actual gating you want the stream password too.

## Stream password (the real boundary)

Turns on Icecast listener authentication for every mount (`/stream.mp3`,
`/stream.opus`, `/stream.flac`, `/stream.aac`). One shared password for all
listeners — Icecast only speaks HTTP basic auth, so there are no per-user
accounts (and no OIDC; that's not viable for a live audio stream).

How it works under the hood: the controller writes
`state/icecast_listener_auth.txt`, and on the next broadcast restart the
Icecast config gains per-mount `<authentication type="url">` blocks pointing
at the controller's `POST /listener-auth`. Icecast asks the controller on
every listener connect, so:

- **Enabling/disabling needs a mixer restart** (the admin UI tells you, same
  as the Opus/AAC toggles).
- **Password changes apply live** — the controller validates each connect
  against the current settings.
- **If the controller is down, new listeners can't connect** (fail closed);
  already-connected listeners keep playing.

### Tuning in with a password

- **Web player** — asks for the password once and remembers it in the
  browser. Under the hood it rides a `?auth=PASSWORD` token on the stream URL
  (browsers can't attach basic auth to an `<audio>` element).
- **Radio apps / VLC / Sonos / hardware** — use a credentialed URL:
  `https://listener:PASSWORD@your-station.example/stream.mp3`
  (any username works; only the password is checked).
- **Anything that can't do userinfo URLs** — append the token instead:
  `https://your-station.example/stream.mp3?auth=PASSWORD`.
- **Native app** — add the credentials to the station address
  (`https://listener:PASSWORD@your-station.example`); the app converts them
  into a stream `Authorization` header automatically.

While the password is on, `/listen.pls` and `/listen.m3u` return 403 — they
would otherwise hand out credential-less URLs that no longer play.

## Known limits

- One shared password; rotating it logs every listener out (web listeners get
  re-prompted automatically).
- Metadata endpoints (`/api/now-playing`, `/api/state`) stay public.
- The landing broadsheet (`/landing`) is not gated — it exists to market a
  station, which is at odds with private mode; leave `SUBWAVE_HOMEPAGE=player`
  (the default) on a private install.
- The `?auth=` token appears in Icecast's access log on your own box.
