# SUB/WAVE — Liquidsoap broadcast script
# Reads a JSON queue file written by the Node.js controller,
# crossfades, ducks DJ voice over song intros, falls back to autonomous playlist.

settings.log.level := 4
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

log("settings loaded: jingle_ratio=#{jingle_ratio()} crossfade_duration=#{crossfade_duration()}")

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
def dj_transition(a, b) =
  d = crossfade_duration()
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

def poll_voice() =
  if file.exists("/var/sub-wave/say.txt") then
    contents = file.contents("/var/sub-wave/say.txt")
    file.remove("/var/sub-wave/say.txt")
    if contents != "" then
      log("DJ says: #{contents}")
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
      ignore(intro_queue.push(request.create(contents)))
    end
  end
end
thread.run(every=0.5, poll_intro)

# ---------------------------------------------------------------------------
# MIC CHAIN — make Piper TTS sound like it's in a broadcast studio
# ---------------------------------------------------------------------------
# Piper outputs flat, dry speech. Real radio voices go through a hardware mic
# chain: highpass → compressor → presence EQ → slap reverb → makeup gain.
# This mirrors that in Liquidsoap so the DJ stops sounding like a TTS robot.
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
  # Slap delay (~40ms, feedback in dB) — adds room so the voice doesn't sit
  # dry on top of the music. Series only; echo sums dry+delayed internally.
  s = echo(delay=0.04, feedback=-15.0, ping_pong=false, s)
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
# Replace state/bed.mp3 with any ambient loop — scripts/generate-bed.sh
# renders a default warm pink-noise hum.

bed_path = "/var/sub-wave/bed.mp3"

music_bus =
  if file.exists(bed_path) then
    log("Loading studio bed from #{bed_path}")
    bed = mksafe(single(id="bed", bed_path))
    add(
      normalize=false,
      weights=[1.0, 0.02],   # bed sits ~34 dB below music — barely there
      [music, bed]
    )
  else
    log("No bed.mp3 — skipping studio bed (run scripts/generate-bed.sh)")
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
  duration=0.5,
  p={0.25},         # music drops to 25% (~-12 dB) while voice plays
  normal=music_bus,
  special=voice
)

# Light duck on top for talk-over links — leaves the song you just queued
# audible under the DJ's voice.
radio = smooth_add(
  duration=0.5,
  p={0.40},         # music drops to 40% (~-8 dB) while intro plays
  normal=ducked,
  special=intro
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
emergency = single("/var/sub-wave/emergency.mp3")
radio = fallback(track_sensitive=false, [radio, emergency])

# Blank detection — skip if more than 5s of silence
radio = blank.skip(max_blank=5.0, radio)

# ---------------------------------------------------------------------------
# BROADCAST BUS — final glue so quiet and loud songs sit at the same level
# ---------------------------------------------------------------------------
# normalize → bus comp → ceiling limit.  This is what gives commercial radio
# its "stable signal" feel: a quiet acoustic track and a loud rock track
# arrive at the listener at the same perceived loudness, with peaks tamed
# just under 0 dBFS so the Icecast MP3 encoder never clips.

# 1. Long-term loudness normalisation (-14 LUFS-ish, matches streaming targets)
radio = normalize(target=-14.0, radio)

# 1b. Subtle stereo width enhancement — makes the broadcast feel "bigger"
# without breaking mono compatibility. Applied BEFORE the bus comp and limiter
# so any side-channel boost still gets caught by the ceiling. In Liquidsoap
# 2.2 the `w` argument is positional (not labeled) and 0 is the identity;
# positive values widen, negative narrow. 0.2 is a gentle nudge.
radio = stereo.width(0.2, radio)

# 2. Bus compressor — gentle glue, almost transparent
radio = compress(
  attack=15.0,
  release=250.0,
  threshold=-12.0,
  ratio=2.0,
  knee=2.0,
  gain=0.0,
  radio
)

# 3. Brick-wall limit at -1 dBFS — last line of defence before the encoder
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

def on_meta(m) =
  title = m["title"]
  artist = m["artist"]
  album = m["album"]
  filename = m["filename"]
  subsonic_id = m["subsonic_id"]
  if title != "" or artist != "" then
    log("on_meta: title=#{title} | artist=#{artist} | album=#{album} | id=#{subsonic_id}")
    ts = int_of_float(time())
    json = '{"title":"#{title}","artist":"#{artist}","album":"#{album}","subsonic_id":"#{subsonic_id}","filename":"#{filename}","timestamp":#{ts}}'
    file.write(data=json, "/var/sub-wave/now-playing.json")
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

output.icecast(
  %mp3(bitrate=192, samplerate=44100, stereo=true),
  host="icecast",
  port=7702,
  password=environment.get("ICECAST_SOURCE_PASSWORD"),
  mount="/stream.mp3",
  name="SUB/WAVE",
  description="Personal frequency from the homelab",
  genre="Various",
  url="http://ronin.tail.ts.net:7700",
  radio
)

# Optional: also output to local file for archiving / podcast generation
output.file(
  %mp3(bitrate=128),
  fallible=true,
  reopen_when={0m0s},
  "/var/sub-wave/archive/%Y-%m-%d/%H-00.mp3",
  radio
)

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
