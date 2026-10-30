# Jingles: placement and audio imports

In **Admin → Imaging → Jingles**, choose an automatic placement, save, then
**restart the mixer** from Settings → Broadcast & mixer.

| Setting | Default | Effect |
| --- | --- | --- |
| `jinglePlacement` | `between` | `between`: full-level IDs between songs; `over`: light-ducked IDs over song openings; `both`: both placements |
| `jingleRatio` | `30` | Offer one automatic ID every N music tracks; `0` disables automatic IDs |
| `jingleRotate` | `mixer` | Who counts between-song IDs in `between` mode; `controller` lets the talk planner place them |

`over` and `both` always use the controller, sharing the existing library and
no-immediate-repeat draw. The saved `jingleRotate` preference is retained for
switching back to `between`. In `both`, **each placement** still gets one ID
per N tracks, and the two never land on the same song: the over-music ID comes
about halfway between two between-songs IDs. With `jingleRatio: 1` every song
already gets a between-songs ID, so `both` offers no overlays. Unsafe overlay
offers are skipped, with the next offer N tracks later; they are never banked
for mid-song playback.
The on-demand `POST /jingles/:filename/play` command always queues the full-level
ID at the next safe boundary, regardless of automatic placement or frequency.
The Imaging page's audio preview remains a local audition.

Every automatic draw, between songs or over music, avoids the ID that aired
last, read from the mixer's jingle marker, so a manual press counts, and so
does an ID the mixer drew itself before the controller took over. This also
changes `between` with `jingleRotate: controller`: that rotate used to avoid
only its own previous draw.

An overlay starts after the opening crossfade and the normal silent voice
lead-in, through the same light duck as a DJ link (`ducking.intro`, default
`0.30`). A song carrying a DJ link or solo intro is reserved for that voice
even after its handoff file has disappeared. Queued/aired speech, pending talk,
speech the DJ is still writing or rendering, manual jingles, beds,
pause-and-talk, idle/off-air and starvation all prevent an overlay. The mixer
checks again when it consumes the offer and throughout playback. A manual press
made while an ID is playing does not cut it: the press waits for the ID to
finish and then airs at the next safe boundary, as it always does. Entering idle
or going off air cancels an accepted ID and its silent lead-in; resuming never
restarts that ID alongside newly queued speech. A short song,
an ID that cannot finish before the outgoing crossfade or a measured vocal entry,
or an unmeasurable audio import is skipped. Unanalysed songs have no measured
vocal runway and pass the fit check, as DJ links do. A controller restart does
not insert an ID into an already-running song. An overlay ID gets a booth line
and session entry like any jingle, and, like any jingle, sends no `dj.say` or
`voice.*` webhook.

The mixer reads the ratio file only at startup. `over` and `both` write it as
`0`, disabling its independent between-song rotation; `both` runs that rotation
through the controller's talk planner instead. Overlays require the updated
broadcast image and a mixer restart: an old, unreachable or still-rotating mixer
cannot prove safety, so no overlays are sent. The default `between` mode keeps
the existing station behavior.

## Audio imports

With ffmpeg installed, Imaging uploads convert to 16-bit PCM WAV at 44.1 kHz
stereo, matching the Liquidsoap mixer. The loudness pass still targets -16 LUFS.
Without ffmpeg, the controller keeps the original bytes and file extension.

Before the fix for [#1688](https://github.com/perminder-klair/subwave/issues/1688),
the loudness filter made every converted jingle 192 kHz, even for 44.1 or 48 kHz
input. [FFmpeg's loudnorm documentation](https://ffmpeg.org/ffmpeg-filters.html#loudnorm)
explains why an explicit output sample rate is needed. The issue's playback
report remains unconfirmed; this change fixes the stored audio format.

Existing files are not rewritten on upgrade. Station backup restores copy the
audio verbatim, and `jingles.restoreMeta` validates the sidecar and rebuilds the
playlist without transcoding. Persona bundles also preserve their jingle bytes
through `jingles.adopt`. These paths can therefore retain older 192 kHz files.
They do not run the loudness filter or create its sample-rate defect.

To check an existing WAV, run:

```bash
ffprobe -v error -select_streams a:0 \
  -show_entries stream=codec_name,sample_rate,channels \
  -of default=noprint_wrappers=1 /path/to/jingles/jingle_example.wav
```

If you want to convert an older jingle, export a station backup and keep the
original audio first. Upload it again through Imaging with ffmpeg available,
audition the new entry, then remove the old entry once you are satisfied. The
new upload gets a new filename. Re-uploading already level-matched audio runs
the loudness pass again; use the original source when you still have it.
