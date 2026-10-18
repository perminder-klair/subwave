# Jingle audio imports

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
