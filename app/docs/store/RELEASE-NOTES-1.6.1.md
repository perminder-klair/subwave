# SUB/WAVE 1.6.1 — store release notes

Drafts for the three surfaces. Copy the block you need.

The iOS and Android notes differ on purpose: lock-screen song progress (#1880)
and the locked-phone metadata fix (#2012) are Android changes. iOS keeps its
LIVE lock-screen controls.

---

## App Store — "What's New" (iOS, public)

Lyrics on the Live page. When your station has lyrics for the song you're
hearing, they fill the screen under the track info, and the sung line lights up
word by word as it's sung. Songs with plain, untimed lyrics show them too, for
you to scroll through. A new Lyrics button beside the heart turns them on or
off, shows where they came from, and lets you nudge the timing if they run early
or late on your phone.

Also in this release:

• Requests tell you what actually happened. If the song played recently, is
  already playing or queued, or the DJ queued an alternative, the request card
  now says so instead of "Queued" every time.

---

## TestFlight — "What to Test"

New in this build: synced lyrics on the Live page.

• Play a song your station has synced lyrics for. Check the sung line keeps
  time with the vocal, and try the timing nudge in the Lyrics sheet if it
  drifts.
• Turn lyrics off in the Lyrics sheet. The Live page should go back to the full
  track card and stay that way after a restart.
• Lock the phone mid-song. The LIVE lock-screen controls, artwork and Live
  Activity should all still work, and the artwork shouldn't flicker as the
  track info refreshes.
• Request a song that played in the last little while. The card should say
  "Played recently".

---

## Play Store — "Release notes" (500 char limit)

Lyrics on the Live page. When your station has them for the song you're
hearing, the sung line lights up word by word. A Lyrics button beside the heart
hides them or nudges the timing.

Also: the notification, lock screen and car displays show how far into the song
you are, track info keeps updating while the phone is locked, and requests now
tell you when a song played recently, is already queued, or the DJ picked an
alternative.
