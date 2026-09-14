# SUB/WAVE 1.5.0 — store release notes

Drafts for the three surfaces. Copy the block you need.

---

## App Store — "What's New" (iOS, public)

Password-protected stations are now first-class. Add a station that sits behind a
login and SUB/WAVE keeps the username and password in the iOS keychain, separate
from the saved address, so your station list never carries a secret in it. A
station that rejects your login now says so plainly instead of failing silently.

Also in this release:

• Like the track that's on air. One tap from the player, straight to the station.
• Pick your stream quality. Choose MP3 or AAC per station from the SIGNAL row in
  the back panel, and SUB/WAVE remembers the choice for each one.
• Remove a saved station without hunting for the gesture. There's a button now.
• Steadier playback on patchy signal. The player buffers deeper before it starts
  and reloads the stream cleanly when the connection stutters, instead of
  stalling in place.
• Now-playing matches what you're hearing. The track and artwork used to run a
  little ahead of the audio; they're aligned to your actual position in the
  stream now.
• Playback pauses when your headphones or car stereo disconnect, rather than
  jumping to the speaker.

---

## TestFlight — "What to Test"

New in this build: station credentials, track likes, and stream format choice.

Worth putting through its paces:

• Add a station behind HTTP Basic Auth. Check it connects, survives a restart,
  and that removing the station clears the stored login. Try a wrong password
  and confirm you get a clear message.
• If you had a credentialed station saved in 1.4.0, confirm it still works after
  upgrading. The login is migrated into the keychain on first launch.
• Tap the like button on an on-air track and confirm it registers at the station.
• Back panel > SIGNAL: switch between MP3 and AAC. Confirm the choice sticks per
  station. (Opus and FLAC are Android only. iOS cannot demux the Ogg container,
  so they're hidden here by design.)
• Play on cellular in a weak-signal spot and see whether it rides through a
  dropout instead of stalling.
• Disconnect headphones or leave CarPlay mid-track and confirm it pauses rather
  than switching to the phone speaker.

---

## Play Store — "Release notes" (500 char limit)

Stations that need a login are now first-class: credentials are stored in Android
keystore, kept out of your saved station list, and a rejected login says so.

Also: like the on-air track, pick your stream format per station (MP3, AAC, Opus
or FLAC where the station offers it), remove saved stations with a real button,
steadier playback on weak signal, and now-playing that matches what you're
actually hearing.
