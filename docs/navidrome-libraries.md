# Choosing which Navidrome libraries are on air

Navidrome (v0.58 and later) supports **multiple libraries** — separate
collections like *Music*, *Audiobooks*, *Christmas*, *Kids* — with per-user
access control. SUB/WAVE doesn't need its own library picker to take advantage
of this: **the Subsonic API is scoped server-side by the user you connect
with**, so a dedicated Navidrome user is all it takes.

This is the recommended way to keep audiobooks, seasonal collections, or
anyone else's music off the stream (issue #704).

## Set it up

1. **Split your collection into libraries** in Navidrome
   (*Admin → Libraries*): e.g. `Music`, `Audiobooks`, `Christmas`.
   See the [Navidrome multi-library docs](https://www.navidrome.org/docs/usage/features/multi-library/).
2. **Create a dedicated user** for the station (*Admin → Users*), e.g.
   `subwave`. Not an admin — admin users always see every library.
3. **Grant it only the libraries you want on air** (just `Music`, say).
4. **Point SUB/WAVE at that user** — in `/onboarding`, `subwave setup`, or
   admin → Settings. That's it: every pick source (search, random, similar
   artists, playlists, genres) now draws only from the granted libraries.

## Seasonal libraries

To bring the Christmas library on air in December, tick it on the `subwave`
user in Navidrome's admin UI; untick it in January. No SUB/WAVE restart
needed — the next Subsonic call sees the new scope.

## After shrinking the scope

SUB/WAVE's local tagging index (`library.db`) may still hold tracks the
station account can no longer see. Run **admin → Library → Maintenance →
Reconcile** once after changing library access: it walks the (now scoped)
catalogue and prunes entries that no longer resolve, so moods/stats reflect
what's actually on air.

## Why not an in-app library picker?

The Subsonic API only accepts a library filter (`musicFolderId`) on *some*
endpoints — several that SUB/WAVE's picker relies on (similar songs, top
songs) don't take it, so client-side filtering would leak excluded tracks.
Per-user access is enforced by Navidrome on **every** endpoint, which makes it
the more robust mechanism. An in-app selector may still come later for
convenience.
