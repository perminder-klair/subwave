# SUB/WAVE — Liquidsoap broadcast script
# Reads a JSON queue file written by the Node.js controller,
# crossfades, ducks DJ voice over song intros, falls back to autonomous playlist.

settings.log.level := 3
settings.log.file := true
settings.log.file.path := "/var/log/liquidsoap/radio.log"

# Telnet server — used by the controller to send a "restart" command after
# changing settings that this script reads at startup. Bound to all interfaces
# on the container's private network only; NOT exposed to the host.
settings.server.telnet := true
settings.server.telnet.bind_addr := "0.0.0.0"
settings.server.telnet.port := 1234

# ---------------------------------------------------------------------------
# RUNTIME SETTINGS — written by the controller at startup, read here.
# Two tiny text files: one int, one float. Falls back to defaults if missing.
# ---------------------------------------------------------------------------

jingle_ratio = ref(30)
crossfade_duration = ref(10.0)
archive_enabled = ref(true)
archive_bitrate = ref(128)
opus_enabled = ref(true)
station_name = ref("SUB/WAVE")

if file.exists("/var/sub-wave/liquidsoap_jingle_ratio.txt") then
  raw = string.trim(file.contents("/var/sub-wave/liquidsoap_jingle_ratio.txt"))
  v = int_of_string(default=30, raw)
  if v > 0 then jingle_ratio := v end
end

if file.exists("/var/sub-wave/liquidsoap_crossfade.txt") then
  raw = string.trim(file.contents("/var/sub-wave/liquidsoap_crossfade.txt"))
  v = float_of_string(default=10.0, raw)
  if v >= 0.0 then crossfade_duration := v end
end

if file.exists("/var/sub-wave/liquidsoap_archive_enabled.txt") then
  raw = string.trim(file.contents("/var/sub-wave/liquidsoap_archive_enabled.txt"))
  archive_enabled := (raw == "true")
end

if file.exists("/var/sub-wave/liquidsoap_archive_bitrate.txt") then
  raw = string.trim(file.contents("/var/sub-wave/liquidsoap_archive_bitrate.txt"))
  v = int_of_string(default=128, raw)
  if v > 0 then archive_bitrate := v end
end

# Opt out of the Ogg-Opus mount to drop a continuous encoder (+ its 44.1->48k
# resample). Only Blink (Chrome/Edge) clients ever select Opus — see
# web/hooks/usePlayer.ts, which keeps Safari/iOS/Firefox on the MP3 mount — so
# operators who don't want the extra encode can disable it. Default on.
if file.exists("/var/sub-wave/liquidsoap_opus_enabled.txt") then
  raw = string.trim(file.contents("/var/sub-wave/liquidsoap_opus_enabled.txt"))
  opus_enabled := (raw != "false")
end

if file.exists("/var/sub-wave/liquidsoap_station_name.txt") then
  raw = string.trim(file.contents("/var/sub-wave/liquidsoap_station_name.txt"))
  if raw != "" then station_name := raw end
end

log("settings loaded: jingle_ratio=#{jingle_ratio()} crossfade_duration=#{crossfade_duration()} archive_enabled=#{archive_enabled()} archive_bitrate=#{archive_bitrate()} opus_enabled=#{opus_enabled()} station_name=#{station_name()}")

# ---------------------------------------------------------------------------
# HTTP(S) FETCH OVERRIDE — Liquidsoap's built-in http.get.stream returns
# spurious 522s when fetching from Cloudflare-fronted origins. Shelling out
# to curl (installed via Dockerfile.liquidsoap) is reliable.
# ---------------------------------------------------------------------------

# subhttp:<full-url> — strips the prefix and shells to curl. Used because
# Liquidsoap's built-in http.get.stream returns spurious 522s when talking
# to the Cloudflare-fronted Navidrome origin.
def proto_subhttp(~rlog, ~maxtime, arg) =
  ignore(rlog)
  uri = arg
  raw_timeout = int_of_float(maxtime - time())
  timeout = if raw_timeout < 5 then 5 else raw_timeout end
  ext =
    if string.contains(substring=".mp3", arg) then ".mp3"
    elsif string.contains(substring=".ogg", arg) then ".ogg"
    elsif string.contains(substring=".flac", arg) then ".flac"
    else ".mp3" end
  output = file.temp("liq-curl-", ext)
  cmd = "curl -sS -L --max-time #{timeout} -o #{process.quote(output)} #{process.quote(uri)}"
  ret = process.run(timeout=float_of_int(timeout), cmd)
  if ret.status == "exit" and ret.status.code == 0 and file.size(output) > 0 then
    [output]
  else
    log(label="protocol.subhttp", level=3, "curl failed for #{uri}: status=#{ret.status} code=#{ret.status.code} stderr=#{ret.stderr}")
    file.remove(output)
    []
  end
end

protocol.add(temporary=true, syntax="subhttp:<full url>", doc="Navidrome stream via curl", "subhttp", proto_subhttp)

# ---------------------------------------------------------------------------
# QUEUE — read tracks from the controller
# ---------------------------------------------------------------------------
# The controller writes track URIs to /var/sub-wave/queue.txt, one per line.
# request.queue lets us push tracks programmatically; we use a polling
# wrapper so the controller can drop new tracks in without a restart.

dj_queue = request.queue(id="dj_queue")

# Periodically drain the queue file into request.queue
def poll_queue() =
  if file.exists("/var/sub-wave/next.txt") then
    contents = file.contents("/var/sub-wave/next.txt")
    file.remove("/var/sub-wave/next.txt")
    if contents != "" then
      log("Queueing: #{contents}")
      ignore(dj_queue.push(request.create(contents)))
    end
  end
end
thread.run(every=1.0, poll_queue)

# ---------------------------------------------------------------------------
# AUTONOMOUS FALLBACK — when queue is empty
# ---------------------------------------------------------------------------
# The controller maintains /var/sub-wave/auto.m3u with mood-appropriate
# tracks for the current context. Refreshed every 10 minutes.

auto_playlist = playlist(
  id="auto",
  reload_mode="watch",
  mode="randomize",
  "/var/sub-wave/auto.m3u"
)

# ---------------------------------------------------------------------------
# MAIN MUSIC SOURCE — queue takes priority, falls back to autonomous
# ---------------------------------------------------------------------------

music = fallback(
  id="music",
  track_sensitive=true,
  [dj_queue, auto_playlist]
)

# ---------------------------------------------------------------------------
# CROSSFADE TRANSITION — equal-amplitude blend across the full cross window
# ---------------------------------------------------------------------------
# fade.out/fade.in span the ENTIRE cross() buffer so the two tracks curve
# past each other at ~-6 dB midpoint and sum to ~unity throughout. If the
# fade is shorter than the buffer, the outgoing track plays at full volume
# while the incoming is ramping in (and vice versa at the tail), summing
# to +6 dB and producing an audible "slap-back echo / doubling" feel on
# every transition. Earlier per-transition energy scaling (fade_d = d * 0.5
# for loud incoming, etc.) caused exactly that — see git log for context.
#
# If we ever want loudness-aware behaviour back, vary the cross BUFFER
# length (e.g. via `override_duration`) rather than shrinking the fade
# inside a fixed-width buffer.
#
# IMPORTANT: We use the low-level `cross` operator here, NOT the high-level
# `crossfade` wrapper. `crossfade(default=…)` with `smart=false` silently
# routes through an internal `simple_transition` and ignores the custom
# callback entirely. `cross` takes a positional transition function and
# always calls it.
#
# The function receives records `a` and `b` with fields `.source`,
# `.metadata`, `.db_level`. Reach into `.source` for the audio.
#
# WHY NO FILTER-KILL HERE: an earlier revision low-pass-filtered the
# outgoing track for a "DJ filter sweep" feel. That triggered a runtime
# error — `Early computation of source content-type detected for source
# iir_filter!` — because `cross` invokes the transition callback before
# the content-type is fully negotiated, and IIR filters on a not-yet-typed
# `request.queue`-backed source fail the same way that the HPF on the mic
# chain does (see comment above mic_chain). The fix would be to put a
# getter-controlled filter on the music source BEFORE `cross` and modulate
# its cutoff from a transition trigger. Parked until needed.
# DJ-mode adaptive blend: the controller may stamp `liq_cross_duration` on the
# incoming track (annotate:, via subsonic.getAnnotatedUri) to size THIS
# transition from the two tracks' tempo/harmonic compatibility. `cross` honours
# the same metadata to size its buffer, so reading it here for the fades keeps
# fade == buffer — the invariant that avoids the +6 dB doubling described above.
# Absent / unparseable → crossfade_duration(), i.e. the global startup default.
def dj_transition(a, b) =
  d = float_of_string(default=crossfade_duration(), b.metadata["liq_cross_duration"])
  a_source = fade.out(duration=d, initial_metadata=a.metadata, a.source)
  b_source = fade.in(duration=d, initial_metadata=b.metadata, b.source)
  add(normalize=false, [a_source, b_source])
end

# Keep a handle on the PRE-cross music source so the on_metadata hook
# (attached further down, where on_meta is defined) sees clean per-track
# metadata events. Hooking the post-cross source fires twice per
# transition — the custom dj_transition below builds fade.in/fade.out
# with initial_metadata=, and the outgoing track wins, stranding the UI
# one song behind until the next crossfade.
music_meta = music

music = cross(
  duration=crossfade_duration(),
  dj_transition,
  music
)

# ---------------------------------------------------------------------------
# DJ VOICE — TTS intros that duck the music
# ---------------------------------------------------------------------------
# Piper writes WAVs to /var/sub-wave/voice/, controller drops the path
# into /var/sub-wave/say.txt to trigger playback.

# Two voice channels:
#   voice_queue — solo voice (station ID, hourly time, weather, listener-
#                 request back-announce). Heavy duck so music drops out.
#   intro_queue — talk-over voice (auto DJ links between tracks). Light duck
#                 so the song you just queued stays audibly underneath.
voice_queue = request.queue(id="voice_queue")
intro_queue = request.queue(id="intro_queue")

# Sound-effects channel — short pre-rendered stingers the DJ agent plays
# UNDER its voice. The controller writes a clip path into /var/sub-wave/sfx.txt
# (see broadcast/sfx.js + queue.playSfx). Not mic-chained — the audio is
# already produced — and mixed in below (its own light `smooth_add` layer).
sfx_queue = request.queue(id="sfx_queue")

# Silent lead-in clip. Pushed into a voice channel immediately before the
# actual speech file so smooth_add starts ducking the music while this silence
# plays — the dip completes BEFORE the DJ's first word, then ramps back up
# once the speech finishes. request.queue plays the two pushes back to back
# with no gap, so the duck holds continuously across the join. Engine-agnostic:
# the speech file itself may be a WAV (Piper/Kokoro) or an mp3 (ElevenLabs).
leadin_path = "/sounds/leadin.wav"
has_leadin = file.exists(leadin_path)
if has_leadin then
  log("Voice lead-in enabled: #{leadin_path}")
else
  log("No #{leadin_path} — DJ voice will duck without a pre-roll lead-in")
end

def poll_voice() =
  if file.exists("/var/sub-wave/say.txt") then
    contents = file.contents("/var/sub-wave/say.txt")
    file.remove("/var/sub-wave/say.txt")
    if contents != "" then
      log("DJ says: #{contents}")
      if has_leadin then
        ignore(voice_queue.push(request.create(leadin_path)))
      end
      ignore(voice_queue.push(request.create(contents)))
    end
  end
end
thread.run(every=0.5, poll_voice)

def poll_intro() =
  if file.exists("/var/sub-wave/intro.txt") then
    contents = file.contents("/var/sub-wave/intro.txt")
    file.remove("/var/sub-wave/intro.txt")
    if contents != "" then
      log("DJ talk-over: #{contents}")
      if has_leadin then
        ignore(intro_queue.push(request.create(leadin_path)))
      end
      ignore(intro_queue.push(request.create(contents)))
    end
  end
end
thread.run(every=0.5, poll_intro)

def poll_sfx() =
  if file.exists("/var/sub-wave/sfx.txt") then
    contents = file.contents("/var/sub-wave/sfx.txt")
    file.remove("/var/sub-wave/sfx.txt")
    if contents != "" then
      log("DJ sound effect: #{contents}")
      # No lead-in: an SFX clip is already-rendered audio, and it is meant to
      # start promptly so it lands under the voice.
      ignore(sfx_queue.push(request.create(contents)))
    end
  end
end
thread.run(every=0.5, poll_sfx)

# ---------------------------------------------------------------------------
# MIC CHAIN — make Piper TTS sound like it's in a broadcast studio
# ---------------------------------------------------------------------------
# Piper outputs flat, dry speech. Real radio voices go through a hardware mic
# chain: highpass → compressor → presence EQ → makeup gain. This mirrors that
# in Liquidsoap (HPF/EQ skipped, see note below) so the DJ stops sounding like
# a TTS robot.
#
# All numbers are tuned for an en_GB-alan-medium-ish voice; tweak in place
# and `docker compose up -d --build liquidsoap` to audition changes.

# Mic chain applied identically to both voice channels. Defining this as a
# function (rather than reusing a chain variable) avoids Liquidsoap's
# "Early computation of source content-type" error — each call instantiates
# fresh operator nodes for its argument.
#
# Skipped (this Liquidsoap build doesn't cooperate with them on a request.queue
# source — "Early computation" error): HPF at 80 Hz and a parallel 3 kHz
# presence shelf. Revisit when we upgrade Liquidsoap or wire in LADSPA.
def mic_chain(s) =
  # Broadcast-style compression — fast attack, gentle ratio. Tames Piper's
  # peaks and brings the body of the voice forward without pumping.
  s = compress(
    attack=5.0,
    release=120.0,
    threshold=-18.0,
    ratio=4.0,
    knee=2.0,
    gain=7.0,
    s
  )
  # Final makeup gain on top of the compressor. Lifts the voice another ~3 dB
  # over the broadcast bus so it sits clearly above the ducked music bed.
  s = amplify(1.4, s)
  # NB: a ~40 ms slap echo used to sit here for "studio room". It was removed —
  # combined with the compressor's makeup gain it lifted Piper's silent-passage
  # noise floor and smeared it into an audible ambient wash behind spoken
  # station IDs. The voice is intentionally dry now.
  s
end

voice = mic_chain(voice_queue)
intro = mic_chain(intro_queue)

# ---------------------------------------------------------------------------
# STUDIO BED — continuous low-level ambient room tone (Phase 2)
# ---------------------------------------------------------------------------
# Mixed into the music bus BEFORE voice ducking so that smooth_add ducks the
# bed along with the music when the DJ talks — otherwise the bed stays loud
# under the voice and competes with it. Tweak the bed weight if it's too
# present (lower) or inaudible under music (higher).
# Replace sounds/bed.mp3 with any ambient loop — the repo ships one, and
# scripts/setup.sh renders a warm pink-noise fallback if it's ever missing.

bed_path = "/sounds/bed.mp3"

# Studio bed disabled — the looping ambient bed was audible/annoying under the
# DJ's voice during links. Flip back to `true` to restore it.
bed_enabled = false

music_bus =
  if bed_enabled and file.exists(bed_path) then
    log("Loading studio bed from #{bed_path}")
    bed = mksafe(single(id="bed", bed_path))
    add(
      normalize=false,
      weights=[1.0, 0.02],   # bed sits ~34 dB below music — barely there
      [music, bed]
    )
  else
    log("Studio bed off (bed_enabled=#{bed_enabled}) — music plays without a bed")
    music
  end

# ---------------------------------------------------------------------------
# DUCKING — gated talkbax, like a broadcast desk
# ---------------------------------------------------------------------------
# `smooth_add` drops the music to a fixed ratio whenever a voice source has
# audio to play, then ramps back to unity when it doesn't. Two layers stacked
# because we have two voice channels with different duck depths:
#
#   voice_queue (say.txt)  → HEAVY duck. Request intros, station IDs, hourly
#                            time checks, weather. The voice is the focus;
#                            music drops well underneath to ~10%.
#   intro_queue (intro.txt) → LIGHT duck. Between-track auto-DJ links. The
#                            song that just started should still be audible
#                            under the voice, so we only dip to ~40%.
#
# Why gated and not RMS-keyed: an earlier RMS sidechain follower drove the
# music bus to -91 dB even with voice_queue empty (see git log f38a9af).
# `smooth_add` is what real radio talkbax buttons emulate — it doesn't care
# how loud the voice is, it cares whether the mic channel has signal. The
# only downside is that quiet TTS phrases get the same duck as loud ones,
# which on a single-tenant station is fine.
#
# Tuning: delay controls how long the duck "holds" between words so brief
# pauses don't make the music pump. p is the ratio while voice is active.

# Heavy duck for request intros / station IDs / hourly / weather.
# duration = fade time into/out of the duck. p is a getter (curly braces).
ducked = smooth_add(
  duration=0.8,     # gentle fade; each voice channel gets a silent lead-in
                    # clip pushed ahead of the speech (see poll_voice /
                    # poll_intro) so this dip completes BEFORE the DJ starts
                    # talking, and ramps back up after.
  p={0.15},         # music drops to 15% (~-16 dB) while voice plays
  normal=music_bus,
  special=voice
)

# Light duck on top for talk-over links — leaves the song you just queued
# audible under the DJ's voice.
radio = smooth_add(
  duration=0.8,     # see note on the heavy-duck layer above — same lead-in
  p={0.30},         # music drops to 30% (~-10 dB) while intro plays
  normal=ducked,
  special=intro
)

# SFX layer on top — short stingers the DJ agent plays under its voice.
# Same gated `smooth_add` pattern as the two voice layers, but only a slight
# duck: the effect is meant to ride BENEATH the DJ (and the music), not
# replace either. `amplify` sets the stinger's level under the voice — both
# the duck depth (p) and this gain are tuning knobs.
sfx_bed = amplify(0.7, sfx_queue)
radio = smooth_add(
  duration=0.3,     # snappier than voice — stingers are short, no lead-in clip
  p={0.7},          # music dips only to 70% (~-3 dB) while an effect plays
  normal=radio,
  special=sfx_bed
)

# ---------------------------------------------------------------------------
# JINGLES & STATION ID — every 30 mins, rotate a jingle in
# ---------------------------------------------------------------------------

jingles = playlist(
  id="jingles",
  mode="randomize",
  reload_mode="watch",
  "/var/sub-wave/jingles.m3u"
)

radio = rotate(
  weights=[1, jingle_ratio()],  # 1 jingle for every N music tracks (settings.json)
  [jingles, radio]
)

# ---------------------------------------------------------------------------
# SAFETY — blank detection, fallback to silence-killer playlist
# ---------------------------------------------------------------------------

# If the source dies, play a static "technical difficulties" loop
emergency = single("/sounds/emergency.mp3")
radio = fallback(track_sensitive=false, [radio, emergency])

# Blank detection — skip if more than 5s of silence
radio = blank.skip(max_blank=5.0, radio)

# ---------------------------------------------------------------------------
# BROADCAST BUS — masters preserved, brick-wall as the only safety
# ---------------------------------------------------------------------------
# Goal: deliver the original masters as untouched as a streaming pipeline
# allows. Earlier revisions had a -14 LUFS normaliser, a stereo widener, and
# a bus compressor stacked here. All three reshaped the audio — the
# normaliser pumped on dynamic material, the widener altered the stereo
# image the engineers chose, and the bus comp was tickling dynamics on every
# loud section. They're gone.
#
# The brick-wall limiter stays. MP3 encoding generates inter-sample peaks
# that can exceed the source's peak by ~0.5–1 dB in the decoded waveform,
# so without a -1 dBFS ceiling, modern masters (which peak at ~-0.3 dBFS TP)
# can cause audible clipping in listeners' decoders. The limiter typically
# does 0 dB of gain reduction on catalogue audio — it's a safety net, not a
# tone tool.

radio = compress(
  attack=1.0,
  release=80.0,
  threshold=-1.0,
  ratio=20.0,
  knee=0.5,
  gain=0.0,
  radio
)

# ---------------------------------------------------------------------------
# METADATA — write current track info for the web UI
# ---------------------------------------------------------------------------

# Drive the Icecast stream title explicitly from the pre-cross on_metadata
# hook (on_meta, below) so it matches now-playing.json and the web UI.
#
# Two operators, and BOTH are load-bearing:
#
#  1. metadata.map(...strip...) — kill ALL metadata still flowing through the
#     broadcast chain. dj_transition's fade.out passes initial_metadata=a.metadata,
#     so ~crossfade_duration seconds after on_meta fires for a new track, the
#     cross transition re-emits the OUTGOING track's metadata downstream. That
#     packet would reach output.icecast and clobber the title back to the
#     previous track (the symptom: Icecast frozen one track behind). Stripping
#     here means nothing from the cross can overwrite what we inject.
#  2. insert_metadata — gives us a handle to push the correct title in from
#     on_meta. After the strip above, this is the ONLY source of stream
#     metadata, so the ICY title can no longer lag.
radio = metadata.map(update=false, strip=true, fun(_) -> [], radio)
radio = insert_metadata(radio)

def on_meta(m) =
  title = m["title"]
  artist = m["artist"]
  album = m["album"]
  filename = m["filename"]
  subsonic_id = m["subsonic_id"]
  if title != "" or artist != "" then
    log("on_meta: title=#{title} | artist=#{artist} | album=#{album} | id=#{subsonic_id}")
    ts = int_of_float(time())
    # Build via json.stringify so values with embedded quotes/backslashes
    # (e.g. a title like Fall (From "Rabb Da Radio 3")) are properly escaped —
    # raw string interpolation here produced invalid JSON the UI couldn't parse.
    json = json.stringify(compact=true, {
      title = title,
      artist = artist,
      album = album,
      subsonic_id = subsonic_id,
      filename = filename,
      timestamp = ts
    })
    file.write(data=json, "/var/sub-wave/now-playing.json")
    # Push the same metadata onto the Icecast stream so the ICY title
    # tracks the current song instead of lagging a transition behind.
    radio.insert_metadata([
      ("title", title),
      ("artist", artist),
      ("album", album)
    ])
  end
end

# Attach to the PRE-cross source (`music_meta`, captured above before the
# cross wrap). Hooking the post-cross source fires twice per transition —
# dj_transition's fade.in/fade.out both pass initial_metadata=, and the
# outgoing track usually wins, freezing the UI one song behind.
# on_metadata is used instead of on_track because on_track gets swallowed
# by source switches (request queue → auto playlist).
music_meta.on_metadata(on_meta)

# ---------------------------------------------------------------------------
# OUTPUT — broadcast to Icecast
# ---------------------------------------------------------------------------

# Stream on/off control. An Icecast output can't be paused, but it can be
# shut down and recreated on demand (Liquidsoap's dynamic-sources pattern).
# `stream_off` shuts both mounts down — the /stream.mp3 and /stream.opus
# mounts disconnect and the station goes genuinely off air; `stream_on`
# recreates them. force_start lets the recreated outputs start after init.
# The on/off state lives in refs and is read back over telnet by the
# controller. It is NOT persisted: a mixer restart always comes back on air.
#
# Two mounts in parallel:
#   /stream.mp3  — MP3 192 kbps, the universal compatibility floor
#                  (Sonos, hardware radios, car receivers, pre-iOS-17 Safari).
#   /stream.opus — Ogg-Opus 96 kbps, ~equal-or-better quality at half the
#                  bandwidth for modern browsers (the web player auto-prefers
#                  it via canPlayType). Browsers / VLC / cliamp on a recent
#                  build all decode it; older clients keep using MP3.
# Per-listener bandwidth is per-mount, so the unused side costs nothing.
settings.init.force_start := true

def make_stream_outputs() =
  mp3_out = output.icecast(
    %mp3(bitrate=192, samplerate=44100, stereo=true),
    id="stream_mp3",
    fallible=true,
    host=environment.get(default="icecast", "ICECAST_HOST"),
    port=7702,
    password=environment.get("ICECAST_SOURCE_PASSWORD"),
    mount="/stream.mp3",
    name=station_name(),
    description="Personal frequency from the homelab",
    genre="Various",
    url="http://localhost:7700",
    radio
  )
  # Opus mandates 48 kHz internally — Liquidsoap resamples from the 44.1 kHz
  # source bus. application="audio" is the right tuning for music (vs "voip"
  # or "lowdelay"). 96 kbps is the music-transparent sweet spot. Gated on
  # opus_enabled so operators can drop the encoder + resample (no-op shutdown
  # when off).
  opus_shutdown =
    if opus_enabled() then
      opus_out = output.icecast(
        %opus(
          bitrate=96,
          samplerate=48000,
          channels=2,
          application="audio",
          vbr="constrained"
        ),
        id="stream_opus",
        fallible=true,
        host=environment.get(default="icecast", "ICECAST_HOST"),
        port=7702,
        password=environment.get("ICECAST_SOURCE_PASSWORD"),
        mount="/stream.opus",
        name=station_name(),
        description="Personal frequency from the homelab",
        genre="Various",
        url="http://localhost:7700",
        radio
      )
      opus_out.shutdown
    else
      fun () -> ()
    end
  fun () -> begin
    mp3_out.shutdown()
    opus_shutdown()
  end
end

stream_shutdown = ref(fun () -> ())
stream_on = ref(false)

def stream_up() =
  if not stream_on() then
    stream_shutdown := make_stream_outputs()
    stream_on := true
  end
end

def stream_down() =
  if stream_on() then
    fn = stream_shutdown()
    fn()
    stream_on := false
  end
end

# On air at startup.
stream_up()

# Optional: hourly archive to /var/sub-wave/archive/. A second MP3 encoder
# running 24/7 is the single biggest CPU cost in the broadcast container —
# guard the entire output so operators who don't use the archives don't pay
# for the encoder. Bitrate is selected from a fixed set because `%mp3(bitrate=…)`
# requires a literal int at parse time (we can't pass a ref).
# Wrap in `{time.string(...)}` so the path is a getter that re-runs strftime
# each time `output.file` reopens (every hour via reopen_when). Passing the
# bare string skips strftime entirely and writes everything to one literal
# "%Y-%m-%d/%H-00.mp3" file that gets truncated at the top of each hour.
archive_path = {time.string("/var/sub-wave/archive/%Y-%m-%d/%H-00.mp3")}
if archive_enabled() then
  br = archive_bitrate()
  if br <= 64 then
    output.file(%mp3(bitrate=64), fallible=true, reopen_when={0m0s}, archive_path, radio)
  elsif br <= 96 then
    output.file(%mp3(bitrate=96), fallible=true, reopen_when={0m0s}, archive_path, radio)
  elsif br <= 128 then
    output.file(%mp3(bitrate=128), fallible=true, reopen_when={0m0s}, archive_path, radio)
  elsif br <= 160 then
    output.file(%mp3(bitrate=160), fallible=true, reopen_when={0m0s}, archive_path, radio)
  elsif br <= 192 then
    output.file(%mp3(bitrate=192), fallible=true, reopen_when={0m0s}, archive_path, radio)
  else
    output.file(%mp3(bitrate=320), fallible=true, reopen_when={0m0s}, archive_path, radio)
  end
else
  log("Hourly archive disabled — set archive.enabled=true in settings to re-enable")
end

# ---------------------------------------------------------------------------
# CONTROL — custom telnet command for the controller to trigger a restart
# after writing new settings. Container restart-policy brings us back ~3s later
# with the new values applied at the top of this script.
# ---------------------------------------------------------------------------
server.register(
  "restart",
  description="Shut down so the container restarts with new settings",
  usage="restart",
  fun(_) -> begin
    log("Restart requested via server command")
    shutdown()
    "OK"
  end
)

# Take the station off air / back on air on demand. stream_off shuts both
# Icecast outputs down so /stream.mp3 and /stream.opus disconnect together;
# stream_on recreates them. stream_status reports the current state for the
# admin UI and the listener-facing player. Operator-only — listeners can't
# reach this.
server.register(
  "stream_off",
  description="Take the station off air (disconnect the Icecast mount)",
  usage="stream_off",
  fun(_) -> begin
    log("Stream taken off air via server command")
    stream_down()
    "OK"
  end
)

server.register(
  "stream_on",
  description="Bring the station back on air",
  usage="stream_on",
  fun(_) -> begin
    log("Stream brought back on air via server command")
    stream_up()
    "OK"
  end
)

server.register(
  "stream_status",
  description="Report whether the station is on air (on/off)",
  usage="stream_status",
  fun(_) -> if stream_on() then "on" else "off" end
)

# Skip the currently playing track. `radio` is the final broadcast source;
# .skip() propagates down through compress → blank.skip → fallback → rotate →
# smooth_add → cross → music, force-ending the current track. `cross` then
# runs the normal dj_transition crossfade into the next track (next dj_queue
# item, else auto_playlist). Operator-only — listeners can't reach this.
server.register(
  "skip",
  description="Skip the currently playing track",
  usage="skip",
  fun(_) -> begin
    log("Skip requested via server command")
    radio.skip()
    "OK"
  end
)
