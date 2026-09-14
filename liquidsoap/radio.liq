# SUB/WAVE — Liquidsoap broadcast script
# Plays track URIs the controller drops into next.txt, crossfades them, ducks
# the DJ voice over them, and falls back to an autonomous playlist.

settings.log.level := 3
settings.log.file := true
settings.log.file.path := "/var/log/liquidsoap/radio.log"

# Telnet server — the controller's only channel into the mixer (restart, skip,
# stream/idle gates). Container-private network only; not exposed to the host.
settings.server.telnet := true
settings.server.telnet.bind_addr := "0.0.0.0"
settings.server.telnet.port := 1234

# Active station's state dir, exported as SUBWAVE_STATE_DIR by the container
# entrypoint (docker/broadcast-entrypoint.sh / the AIO supervisor).
state_dir = environment.get(default="/var/sub-wave", "SUBWAVE_STATE_DIR")

# Scratch dirs for the atomic marker writes below (#1240). Without a temp_dir on
# the state fs, file.write(atomic=true) stages under $TMPDIR (container overlay)
# while the state dir is a bind mount, so the rename is cross-device and the
# stdlib silently degrades to a NON-atomic copy. ONE DIR PER WRITER: the stdlib
# always names the temp file `atomic.write` inside the dir it is given.
# Returns null on failure (file.mkdir does NOT raise) so a bad temp_dir restores
# the old $TMPDIR behaviour instead of raising inside on_metadata.
def ensure_tmp_dir(p) =
  file.mkdir(parents=true, p)
  probe = path.concat(p, "probe")
  try
    file.write(data="x", probe)
    file.remove(probe)
    p
  catch err do
    log(
      label="subwave",
      "temp dir #{p} unusable (#{err}); atomic marker writes fall back to $TMPDIR"
    )
    null
  end
end

np_tmp_dir = ensure_tmp_dir("#{state_dir}/tmp/now-playing")
jingle_tmp_dir = ensure_tmp_dir("#{state_dir}/tmp/jingle")
# Second dir for the SAME marker file: jingle-playing.json has two writers (the
# rotate's on_metadata and jingle_now_queue's hook) whose feeds can overlap
# inside one crossfade, and a shared dir would tear the write.
jingle_now_tmp_dir = ensure_tmp_dir("#{state_dir}/tmp/jingle-now")
bed_tmp_dir = ensure_tmp_dir("#{state_dir}/tmp/bed")
pause_talk_tmp_dir = ensure_tmp_dir("#{state_dir}/tmp/pause-talk")
pause_voice_accept_tmp_dir = ensure_tmp_dir("#{state_dir}/tmp/pause-voice-accept")
pause_voice_start_tmp_dir = ensure_tmp_dir("#{state_dir}/tmp/pause-voice-start")
starve_tmp_dir = ensure_tmp_dir("#{state_dir}/tmp/starve")
# One per voice channel, not one for both: they write the SAME marker file, so a
# shared dir tears when a heavy-duck segment and a talk-over link land together.
voice_tmp_dir = ensure_tmp_dir("#{state_dir}/tmp/voice")
intro_tmp_dir = ensure_tmp_dir("#{state_dir}/tmp/intro")

# MUSIC STARVE GUARD (#1300 bug 7) — the latch only; its tick is registered far
# below, after idle_mode exists. Declared here because the jingles gate reads it
# from a thunk (same lazy-thunk pattern as bed_on_air).
music_starved = ref(false)

# Live safety gates shared by on-demand jingles and the automatic rotate.
# Declared before the queue sources; on_meta and voice_marker update them.
#
# True from a bed's first metadata until the next real song's (both set in
# on_meta). The rotate counts every music-chain track and a bed IS a track, so
# without this gate a stinger lands BETWEEN the bed and the song it ramps into.
bed_on_air = ref(false)

# A pause-talk break is a silent item on the music timeline followed by speech
# on voice_queue. Keep jingles unavailable across BOTH halves; voice_until then
# carries the gate from the first spoken sample through its tail.
pause_talk_on_air = ref(false)

# Voice-on-air DEADLINE for the jingle gates, keeping the rotate from handing a
# stinger to the music chain while a DJ clip is on air (#997 covered only the
# other direction). Must stay a deadline, not a boolean:
# source.is_ready(voice_queue) latches true forever after the first push on a
# request.queue (measured: still true 24s after a 6.4s clip finished, queue
# empty), which would starve the rotate permanently.
voice_until = ref(0.)

# True from a manual (on-demand) jingle's first metadata until the next
# music-chain track resets it in on_meta. Keeps the automatic rotate from
# stacking a stinger on top of an announcement an operator fired by hand.
jingle_now_on_air = ref(false)

# RUNTIME SETTINGS — one text file per value, written by the controller via
# settings.update() and read ONCE at startup: a change needs a mixer restart.
# Missing/garbage keeps the default, so an upgrade is byte-identical.

jingle_ratio = ref(30)
crossfade_duration = ref(10.0)
# smooth_add's `p` on the two ducking layers (see the DUCKING block below).
duck_voice = ref(0.22)
duck_intro = ref(0.30)
archive_enabled = ref(false)
archive_bitrate = ref(128)
opus_enabled = ref(false)
opus_bitrate = ref(96)
flac_enabled = ref(false)
aac_enabled = ref(false)
aac_bitrate = ref(192)
stream_bitrate = ref(192)
ogg_icy_metadata = ref(true)
station_name = ref("SUB/WAVE")

# DJ TRANSITION EFFECTS (sweep / washout / dissolve / chop / exit loop) — built
# per-branch inside dj_transition below, on the OUTGOING track's source only.
# Every envelope is a closure over source.elapsed() on its own branch, so it
# holds in AUDIO time under any clock (wall-clock envelopes drift).
#
# Engine constraints, all measured — do not "simplify" past them:
#   * v2.4.5 is the MINIMUM runtime; 2.4.4's O(n) clock scan pegs a core on
#     every effect transition (see Dockerfile.broadcast).
#   * comb, NOT echo: native `echo` (incl. ping_pong) type-checks then passes
#     audio through bit-for-bit on 2.2.5 and 2.4.4.
#   * filter.rc, NOT the SVF `filter` (unstable near sr/4, collapses to
#     near-silence — hence the 9 kHz cap on every "open" cutoff) and NOT
#     iir_filter/HPF ("Early computation of source content-type" crash).
#     Re-run scripts/fx-render-test.sh before adding any other operator class
#     inside the cross callback.

if file.exists("#{state_dir}/liquidsoap_jingle_ratio.txt") then
  raw = string.trim(file.contents("#{state_dir}/liquidsoap_jingle_ratio.txt"))
  v = int_of_string(default=30, raw)
  # 0 is a valid value: jingles OFF (#997).
  if v >= 0 then jingle_ratio := v end
end

if file.exists("#{state_dir}/liquidsoap_crossfade.txt") then
  raw = string.trim(file.contents("#{state_dir}/liquidsoap_crossfade.txt"))
  v = float_of_string(default=10.0, raw)
  if v >= 0.0 then crossfade_duration := v end
end

# Duck depths. `p` is the fraction of the music LEFT UP under a voice channel:
# range [0, 1], smaller is deeper, 1.0 no duck, 0.0 a full mute under the voice.
# Out-of-range is refused, not clamped — the controller already bounds it on save
# and load, so a bad file here is a hand-edit.
if file.exists("#{state_dir}/liquidsoap_duck_voice.txt") then
  raw = string.trim(file.contents("#{state_dir}/liquidsoap_duck_voice.txt"))
  v = float_of_string(default=0.22, raw)
  if v >= 0.0 and v <= 1.0 then duck_voice := v end
end

if file.exists("#{state_dir}/liquidsoap_duck_intro.txt") then
  raw = string.trim(file.contents("#{state_dir}/liquidsoap_duck_intro.txt"))
  v = float_of_string(default=0.30, raw)
  if v >= 0.0 and v <= 1.0 then duck_intro := v end
end

if file.exists("#{state_dir}/liquidsoap_archive_enabled.txt") then
  raw = string.trim(file.contents("#{state_dir}/liquidsoap_archive_enabled.txt"))
  archive_enabled := (raw == "true")
end

if file.exists("#{state_dir}/liquidsoap_archive_bitrate.txt") then
  raw = string.trim(file.contents("#{state_dir}/liquidsoap_archive_bitrate.txt"))
  v = int_of_string(default=128, raw)
  if v > 0 then archive_bitrate := v end
end

if file.exists("#{state_dir}/liquidsoap_stream_bitrate.txt") then
  raw = string.trim(file.contents("#{state_dir}/liquidsoap_stream_bitrate.txt"))
  v = int_of_string(default=192, raw)
  if v > 0 then stream_bitrate := v end
end

# Opt IN to the Ogg-Opus mount (costs a continuous encoder + a 44.1->48k
# resample). Only Blink clients ever select it (web/hooks/usePlayer.ts).
if file.exists("#{state_dir}/liquidsoap_opus_enabled.txt") then
  raw = string.trim(file.contents("#{state_dir}/liquidsoap_opus_enabled.txt"))
  opus_enabled := (raw == "true")
end

if file.exists("#{state_dir}/liquidsoap_opus_bitrate.txt") then
  raw = string.trim(file.contents("#{state_dir}/liquidsoap_opus_bitrate.txt"))
  v = int_of_string(default=96, raw)
  if v > 0 then opus_bitrate := v end
end

# Opt IN to the AAC-LC mount — for external players that decode AAC but not
# Opus. No resample.
if file.exists("#{state_dir}/liquidsoap_aac_enabled.txt") then
  raw = string.trim(file.contents("#{state_dir}/liquidsoap_aac_enabled.txt"))
  aac_enabled := (raw == "true")
end

if file.exists("#{state_dir}/liquidsoap_aac_bitrate.txt") then
  raw = string.trim(file.contents("#{state_dir}/liquidsoap_aac_bitrate.txt"))
  v = int_of_string(default=192, raw)
  if v > 0 then aac_bitrate := v end
end

# Opt IN to the Ogg-FLAC mount — a lossless capture of the PROCESSED bus at the
# source 44.1 kHz. ~800-900 kbps, hence off by default; external players only.
if file.exists("#{state_dir}/liquidsoap_flac_enabled.txt") then
  raw = string.trim(file.contents("#{state_dir}/liquidsoap_flac_enabled.txt"))
  flac_enabled := (raw == "true")
end

# ICY (out-of-band) per-track titles on BOTH Ogg mounts. ON by default — only an
# explicit "false" disables. See make_stream_outputs() for the client trade-off.
if file.exists("#{state_dir}/liquidsoap_ogg_icy_metadata.txt") then
  raw = string.trim(file.contents("#{state_dir}/liquidsoap_ogg_icy_metadata.txt"))
  ogg_icy_metadata := (raw != "false")
end

if file.exists("#{state_dir}/liquidsoap_station_name.txt") then
  raw = string.trim(file.contents("#{state_dir}/liquidsoap_station_name.txt"))
  if raw != "" then station_name := raw end
end

log("settings loaded: jingle_ratio=#{jingle_ratio()} crossfade_duration=#{crossfade_duration()} duck_voice=#{duck_voice()} duck_intro=#{duck_intro()} archive_enabled=#{archive_enabled()} archive_bitrate=#{archive_bitrate()} stream_bitrate=#{stream_bitrate()} opus_enabled=#{opus_enabled()} opus_bitrate=#{opus_bitrate()} flac_enabled=#{flac_enabled()} aac_enabled=#{aac_enabled()} aac_bitrate=#{aac_bitrate()} ogg_icy_metadata=#{ogg_icy_metadata()} station_name=#{station_name()}")

# subhttp:<full-url> — whole-file download via curl (http.get.stream returns
# spurious 522s on the Cloudflare-fronted Navidrome origin).
#
# INVARIANT (#1405): curl exiting 0 is NOT proof of audio. Subsonic carries its
# error code INSIDE the body, so Navidrome answers a missing file with HTTP 200
# and a JSON/XML blob that `--fail` cannot see. The CONTENT TYPE is what
# identifies it, so refuse json/xml/text bodies, sub-4 KiB files and non-2xx.

# Below this a "track" cannot be audio worth airing: a Subsonic error body is a
# few hundred bytes, 4 KiB of MP3 is about a quarter of a second. Backstop for an
# origin that errors with no usable content type.
subhttp_min_bytes = 4096

# Per-handoff completion outcomes consumed by the controller over telnet. The
# probe token rides in a URL fragment (never sent to the origin), so a stale
# result for the same song id cannot satisfy a later push. Entries are removed
# when read.
subhttp_probe_outcomes = ref([])

def subhttp_probe_id(uri) =
  matches = string.extract(pattern="#subwave_probe=([^&#]+)", uri)
  list.assoc(default="", 1, matches)
end

def remember_subhttp_outcome(uri, outcome) =
  probe_id = subhttp_probe_id(uri)
  if probe_id != "" then
    kept = list.filter(fun(p) -> fst(p) != probe_id, subhttp_probe_outcomes())
    subhttp_probe_outcomes.set([(probe_id, outcome), ...kept])
  end
end

def take_subhttp_outcome(probe_id) =
  matches = list.filter(fun(p) -> fst(p) == probe_id, subhttp_probe_outcomes())
  if list.length(matches) == 0 then
    "pending"
  else
    subhttp_probe_outcomes.set(
      list.filter(fun(p) -> fst(p) != probe_id, subhttp_probe_outcomes())
    )
    snd(list.hd(matches))
  end
end

# Stream URLs carry Subsonic u/t/s query credentials. Keep operator-facing
# context without persisting replayable auth material or the internal probe id.
def redact_subhttp_uri(uri) =
  no_query = string.replace(pattern="\\?[^#]*", fun(_) -> "?[redacted]", uri)
  string.replace(pattern="#.*$", fun(_) -> "", no_query)
end

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
  outfile = file.temp("liq-curl-", ext)
  # `-w` reports the FINAL response (after -L), status first so the content type
  # — which may itself contain a space, e.g. `application/json; charset=utf-8` —
  # can keep the rest of the line.
  cmd = "curl -sS -L --fail --max-time #{timeout} -w '%{http_code} %{content_type}' -o #{process.quote(outfile)} #{process.quote(uri)}"
  ret = process.run(timeout=float_of_int(timeout), cmd)
  info = string.trim(ret.stdout)
  http_code = list.hd(default="", string.split(separator=" ", info))
  ctype = string.case(lower=true, info)
  size = file.size(outfile)
  # An API error body, whatever the status: JSON and XML are the two Subsonic
  # error dialects, and text/* covers a proxy's HTML error page.
  error_body =
    string.contains(substring="json", ctype)
    or string.contains(substring="xml", ctype)
    or string.contains(substring="text/", ctype)
  safe_uri = redact_subhttp_uri(uri)
  safe_stderr = redact_subhttp_uri(ret.stderr)
  if not (ret.status == "exit" and ret.status.code == 0) then
    remember_subhttp_outcome(uri, "failed")
    log(label="protocol.subhttp", level=3, "curl failed for #{safe_uri}: status=#{ret.status} code=#{ret.status.code} http=#{http_code} stderr=#{safe_stderr}")
    file.remove(outfile)
    null
  elsif error_body then
    remember_subhttp_outcome(uri, "failed")
    log(label="protocol.subhttp", level=2, "music source returned an ERROR BODY, not audio, for #{safe_uri} (http=#{http_code}, content-type=#{info}, #{size} bytes) — the track is missing or unreadable at the origin; check the music server's own log")
    file.remove(outfile)
    null
  elsif size < subhttp_min_bytes then
    remember_subhttp_outcome(uri, "failed")
    log(label="protocol.subhttp", level=2, "music source returned only #{size} bytes for #{safe_uri} (http=#{http_code}, content-type=#{info}) — too small to be audio, treating as an error response")
    file.remove(outfile)
    null
  else
    remember_subhttp_outcome(uri, "ready")
    outfile
  end
end

protocol.add(temporary=true, syntax="subhttp:<full url>", doc="Navidrome stream via curl", "subhttp", proto_subhttp)

# QUEUE — the controller writes one annotated track URI to next.txt; polled
# every 1s into request.queue.

dj_queue = request.queue(id="dj_queue")
jingle_now_queue = request.queue(id="jingle_now_queue")

def poll_queue() =
  if file.exists("#{state_dir}/next.txt") then
    contents = string.trim(file.contents("#{state_dir}/next.txt"))
    file.remove("#{state_dir}/next.txt")
    if contents != "" then
      log("Queueing: #{redact_subhttp_uri(contents)}")
      ignore(dj_queue.push(request.create(contents)))
    end
  end
end
thread.run(every=1.0, poll_queue)

def poll_jingle_now() =
  if file.exists("#{state_dir}/jingle-now.txt") then
    contents = string.trim(file.contents("#{state_dir}/jingle-now.txt"))
    file.remove("#{state_dir}/jingle-now.txt")
    if contents != "" then
      log("Queueing on-demand jingle: #{contents}")
      ignore(jingle_now_queue.push(request.create(contents)))
    end
  end
end
thread.run(every=0.5, poll_jingle_now)

# Measured clip length for a jingle marker, in seconds; 0. means "unmeasured"
# and the controller falls back to its own 15s guess. The controller can only
# parse a RIFF header, and a jingle imported without ffmpeg keeps its original
# container, so only Liquidsoap can answer for an .mp3. request.duration decodes
# a header and RAISES on an unreadable/empty filename, so wrap every call — the
# duration is part of the payload, so a raise would cost the marker entirely.
def jingle_duration(fname) =
  try
    null.get(default=0., request.duration(fname))
  catch err do
    log(label="subwave", "jingle duration unavailable for #{fname} (#{err})")
    0.
  end
end

# Mark a manual jingle from its own source. It is deliberately outside
# music_meta: uploaded clips can retain ID3 tags, and no such tag may become the
# station's now-playing row or ICY title.
jingle_now_queue.on_metadata(synchronous=false, fun (m) -> begin
  jingle_now_on_air := true
  fname = m["filename"]
  file.write(
    data=json.stringify(compact=true, {
      filename = fname,
      durationSec = jingle_duration(fname),
      startedAt = time()
    }),
    atomic=true,
    temp_dir=jingle_now_tmp_dir,
    "#{state_dir}/jingle-playing.json"
  )
end)

# AUTONOMOUS FALLBACK — the controller maintains auto.m3u with mood-appropriate
# tracks; reload_mode="watch" picks up its rewrites.

auto_playlist = playlist(
  id="auto",
  reload_mode="watch",
  mode="randomize",
  "#{state_dir}/auto.m3u"
)

# MAIN MUSIC SOURCE — queue takes priority, falls back to autonomous.
music = fallback(
  id="music",
  track_sensitive=true,
  [dj_queue, auto_playlist]
)

# HARD TRACK-LENGTH CAP (#447) — the controller stamps liq_cue_out on autonomous
# picks and auto.m3u entries when a max-track-length is set; listener requests
# are deliberately UN-stamped. Must sit BEFORE the music_meta capture (one clean
# on_metadata per cut track) and before `cross` (the cut end drives a normal
# crossfade out).
music = cue_cut(music)

# CROSSFADE TRANSITION — equal-amplitude blend across the full cross window.
#
# INVARIANT: fade.out/fade.in span the ENTIRE cross() buffer so the tracks curve
# past each other at ~-6 dB midpoint and sum to ~unity. A shorter fade leaves the
# outgoing at full level while the incoming ramps: +6 dB, audible doubling. To
# vary the blend, vary the cross BUFFER, never the fade inside it.
#
# Low-level `cross`, NOT the `crossfade` wrapper: crossfade(smart=false) routes
# through its internal simple_transition and ignores a custom callback. `a`/`b`
# are records with .source/.metadata/.db_level.
#
# `cross` sizes this transition's buffer from the OUTGOING track's
# liq_cross_duration stamp, so the fade must read `a.metadata` too or fade !=
# buffer (longer is truncated into a gap, shorter sums to +6 dB).
def dj_transition(a, b) =
  d = float_of_string(default=crossfade_duration(), a.metadata["liq_cross_duration"])
  # EFFECT ARMING. Every effect is APPLIED to the outgoing branch, but which
  # track carries the FLAG differs, which is why there is no arming state and no
  # remaining() watcher:
  #   * washout + loop ride the ENDING track (`a`) — flag, delay tap and bar
  #     length were stamped on it when it was queued.
  #   * sweep / dissolve / chop ride the INCOMING pick (`b`) — chosen from the
  #     PAIR, armed only between clashing tracks (mix.effectAllowedFor).
  # Precedence: loop beats everything, then washout (which may carry the
  # length-cap auto-arm). The queue strips the losers upstream; enforced here too.
  #
  # SHOW-BOUNDARY FADE (#1574) — liq_show_fade means the controller CUT this
  # track at a show change, so EVERY gesture stands down on both sides and the
  # seam is the plain fade.out(duration=d) below. All six reshape `a_source`
  # (the loop applies no fader at all, sweep/chop hold it hot on the log fade),
  # and over a mid-record cut there is no ending for any of that to describe.
  # They cannot merely be left alone: forcing washing/looping false would ARM
  # the `b` gestures on seams where the outgoing one used to suppress them.
  boundary_fading = a.metadata["liq_show_fade"] == "true"
  washing = a.metadata["liq_washout"] == "true" and not boundary_fading
  looping = a.metadata["liq_loop"] == "true" and not washing and not boundary_fading
  sweeping = b.metadata["liq_sweep"] == "true" and not looping and not boundary_fading
  dissolving = b.metadata["liq_dissolve"] == "true" and not washing and not looping and not boundary_fading
  chopping = b.metadata["liq_chop"] == "true" and not washing and not looping and not boundary_fading
  # FADE SHAPE per effect. exp drops the dry EARLY so the washout's tail reads
  # as a dissolve (it dips below unity mid-cross, which is the effect; the +6 dB
  # hazard is only for fades that hold full level early). log does the opposite,
  # holding the outgoing hot so the EFFECT rather than the fader does the
  # removal — a sweep over an already-quiet track is inaudible and a chop must
  # stab at full level. Loop takes NO fader here: it captures the raw outgoing
  # bar and applies its own complementary ride after the cascade; the hot fade
  # made every loop transition jump in level at its start.
  a_source =
    if washing then
      fade.out(duration=d, type="exp", initial_metadata=a.metadata, a.source)
    elsif sweeping or chopping then
      fade.out(duration=d, type="log", initial_metadata=a.metadata, a.source)
    elsif looping then
      a.source
    else
      fade.out(duration=d, initial_metadata=a.metadata, a.source)
    end
  # SWEEP ENVELOPE — riding the filter out of a track. Cutoffs move in
  # LOG-frequency space (pow) throughout; linear Hz ramps read as
  # nothing-then-everything.
  a_source =
    if sweeping then
      log("DJ sweep: closing the filter over the outgoing track (d=#{d}s)")
      sweep_src = a_source
      # Close FAST and DEEP — 9 kHz to 1.1 kHz over the first 45% of the blend —
      # so the choke arrives while the outgoing is still loud. A shallower close
      # over 70% was inaudible under the fade.
      def sweep_cut() =
        e = source.elapsed(sweep_src)
        e = if e < 0. then 0. else e end
        t_close = 0.45 * d
        t_hold  = 0.55 * d
        t_back  = 0.85 * d
        # Dive, touch the floor briefly, then PARTIALLY re-open as the incoming
        # takes over — a sustained floor reads as "the track went quiet".
        depth =
          if e < t_close then
            x = e / t_close
            3.0 * x * x - 2.0 * x * x * x
          elsif e < t_hold then
            1.0
          elsif e < t_back then
            x = (e - t_hold) / (t_back - t_hold)
            1.0 - 0.6 * (3.0 * x * x - 2.0 * x * x * x)
          else
            0.4
          end
        9000.0 * pow(1100.0 / 9000.0, depth)      # 9 kHz open → 1.1 kHz floor
      end
      # Makeup on the choked branch: the filter guts the outgoing's energy while
      # the incoming is only half-faded, so lift the residual +2.6 dB as the
      # cutoff bottoms out. Without it the mid-blend goes near-quiet.
      def sweep_gain() =
        e = source.elapsed(sweep_src)
        e = if e < 0. then 0. else e end
        g_max = 1.35
        t_from = 0.30 * d
        t_to   = 0.50 * d
        if e <= t_from then 1.0
        elsif e >= t_to then g_max
        else
          x = (e - t_from) / (t_to - t_from)
          1.0 + (3.0 * x * x - 2.0 * x * x * x) * (g_max - 1.0)
        end
      end
      # PARALLEL DRY BLEED — why the stages run full-wet. Wetness on cascaded
      # stages MULTIPLIES the dry path (0.35 x 0.35 ~= 12% ~= -18 dB), so a
      # wetness cap craters the mid-band. An explicit dry branch around a
      # full-wet chain gives a hard floor: 30% of the untouched track reaches
      # the mix (~-10 dB, ~-8 dB after makeup) however deep the cutoff dives.
      swept = filter.rc(frequency=sweep_cut, mode="low", wetness=1.,
                filter.rc(frequency=sweep_cut, mode="low", wetness=1., a_source))
      amplify(sweep_gain, add(normalize=false,
        [amplify(0.30, a_source), amplify(0.75, swept)]))
    else
      a_source
    end
  # BLEND (spectral handover) — the OUTGOING track hands its lows then its mids
  # (by ~65% of the blend) to the incoming, keeping only its highs, while the
  # incoming arrives lows-first (b-side block further down). Armed only between
  # COMPATIBLE tracks (mix.effectAllowedFor). At e=0 the HPF sits at 30 Hz, i.e.
  # transparent, so the engage is seamless.
  blending = b.metadata["liq_blend"] == "true" and not looping and not boundary_fading
  a_source =
    if blending then
      log("DJ blend: spectral handover into the next track (d=#{d}s)")
      ha_src = a_source
      def blend_hp() =
        e = source.elapsed(ha_src)
        e = if e < 0. then 0. else e end
        t_end = 0.65 * d
        x = if e >= t_end then 1.0 else e / t_end end
        sxx = 3.0 * x * x - 2.0 * x * x * x
        30.0 * pow(1800.0 / 30.0, sxx)            # 30 Hz → 1.8 kHz (log space)
      end
      # SUBTRACT-HPF: filter.rc mode="high" is BROKEN (a static 400 Hz HPF
      # collapses music to -115 dB on 2.2.5; a 40 Hz HPF on a 440 Hz tone
      # renders -inf on 2.4.4). Build the high-pass as dry - lowpass(dry).
      blend_low = filter.rc(frequency=blend_hp, mode="low", wetness=1., a_source)
      add(normalize=false, [a_source, amplify(-1., blend_low)])
    else
      a_source
    end
  # WASHOUT ENVELOPE — dub-style tail. The comb feedback swells while the exp
  # fade pulls the dry away, so the delay line self-sustains over the incoming
  # track's opening. The tail must be dead before the transition source
  # truncates at d, or it clicks off. Tap length (liq_washout_delay) is stamped
  # by the controller, tempo-synced to a dotted eighth of the track's BPM.
  a_source =
    if washing then
      wd = float_of_string(default=0.30, a.metadata["liq_washout_delay"])
      log("DJ washout: dissolving the outgoing track, tap=#{wd}s (d=#{d}s)")
      wash_src = a_source
      # The swell must beat the exp fade: swelling at 25% seeds the tail from an
      # already-faded signal and the wash is inaudible. Buildup is bounded by the
      # exp fade starving the input, plus the bus limiter.
      def wash_fb() =
        e = source.elapsed(wash_src)
        e = if e < 0. then 0. else e end
        fb_max = -1.0            # peak feedback dB — nearer 0 = longer tail
        fb_off = -90.0           # idle/silent
        t_swell = 0.10 * d
        t_hold  = 0.85 * d
        t_rel   = 0.97 * d
        if e < t_swell then
          x = e / t_swell
          s = 3.0 * x * x - 2.0 * x * x * x       # smoothstep swell
          fb_off + s * (fb_max - fb_off)
        elsif e < t_hold then
          fb_max
        elsif e < t_rel then
          fb_max + ((e - t_hold) / (t_rel - t_hold)) * (fb_off - fb_max)
        else
          fb_off
        end
      end
      # Late makeup so the tail sits PRESENT over the incoming fade-in. It comes
      # up only after the exp fade has dropped the dry, so it lifts the echoes
      # alone and never bumps the still-audible song.
      def wash_gain() =
        e = source.elapsed(wash_src)
        e = if e < 0. then 0. else e end
        g_max = 1.95             # ≈ +5.8 dB — the tail must sit OVER a dense incoming mix
        t_from = 0.30 * d
        t_to   = 0.55 * d
        if e <= t_from then 1.0
        elsif e >= t_to then g_max
        else
          x = (e - t_from) / (t_to - t_from)
          1.0 + (3.0 * x * x - 2.0 * x * x * x) * (g_max - 1.0)
        end
      end
      # Darkening tail. The comb's loop is fixed, so a lowpass AFTER it closes
      # across the window instead (9 kHz -> 3 kHz) and later repeats arrive
      # darker. Wet must ramp in: an RC at 9 kHz is not transparent, and
      # engaging it full-wet would dull the still-audible dry.
      def tail_cut() =
        e = source.elapsed(wash_src)
        e = if e < 0. then 0. else e end
        t_from = 0.35 * d
        t_to   = 0.90 * d
        x = if e <= t_from then 0.0 elsif e >= t_to then 1.0 else (e - t_from) / (t_to - t_from) end
        s = 3.0 * x * x - 2.0 * x * x * x
        9000.0 * pow(3000.0 / 9000.0, s)
      end
      def tail_wet() =
        e = source.elapsed(wash_src)
        e = if e < 0. then 0. else e end
        t_on = 0.20 * d
        x = if e >= t_on then 1.0 else e / t_on end
        3.0 * x * x - 2.0 * x * x * x
      end
      washed = comb(delay=wd, feedback=wash_fb, a_source)
      washed = filter.rc(frequency=tail_cut, mode="low", wetness=tail_wet,
                 filter.rc(frequency=tail_cut, mode="low", wetness=tail_wet, washed))
      amplify(wash_gain, washed)
    else
      a_source
    end
  # DISSOLVE ENVELOPE — reverb wash. Same topology as the washout (comb ->
  # cascaded damped lowpass -> late makeup) with two differences:
  #   1. FOUR parallel combs at mutually prime, tempo-UNRELATED delays
  #      (89/113/151/181 ms) instead of one tempo-synced tap, so the tails smear
  #      into diffuse ambience instead of a rhythmic pulse. No allpass exists in
  #      the proven kit, so diffusion comes from the prime spread plus damping.
  #   2. The damping lowpass closes deeper (7 kHz -> 1.2 kHz).
  # Each comb's tail is isolated from its dry pass-through (the -4x subtraction
  # below) so the wash can run hot without multiplying the dry path.
  a_source =
    if dissolving then
      log("DJ dissolve: reverb wash under the next track (d=#{d}s)")
      diss_src = a_source
      def diss_fb() =
        e = source.elapsed(diss_src)
        e = if e < 0. then 0. else e end
        # Per-tap dB. Tail decay is fb/delay per SECOND, so short taps need
        # near-unity feedback: -0.5 dB on 89-181 ms taps ~= 3-6 dB/s, a
        # multi-second wash. -2.5 dB on 43-101 ms taps decays 25-58 dB/s and
        # renders indistinguishable from dry.
        fb_max = -0.5
        fb_off = -90.0
        # Swell must beat the exp fade, as in the washout.
        t_swell = 0.10 * d
        t_hold  = 0.80 * d
        t_rel   = 0.93 * d
        if e < t_swell then
          x = e / t_swell
          s = 3.0 * x * x - 2.0 * x * x * x
          fb_off + s * (fb_max - fb_off)
        elsif e < t_hold then
          fb_max
        elsif e < t_rel then
          fb_max + ((e - t_hold) / (t_rel - t_hold)) * (fb_off - fb_max)
        else
          fb_off
        end
      end
      # Late makeup, same rationale as the washout. Lower than its figure
      # because these taps start well below its single unity tap.
      def diss_gain() =
        e = source.elapsed(diss_src)
        e = if e < 0. then 0. else e end
        g_max = 1.3
        t_from = 0.25 * d
        t_to   = 0.50 * d
        if e <= t_from then 1.0
        elsif e >= t_to then g_max
        else
          x = (e - t_from) / (t_to - t_from)
          1.0 + (3.0 * x * x - 2.0 * x * x * x) * (g_max - 1.0)
        end
      end
      # Darkening: a lowpass closing across the window makes the wash recede.
      # Wet ramps in rather than engaging at cross start, as in the washout.
      def diss_cut() =
        e = source.elapsed(diss_src)
        e = if e < 0. then 0. else e end
        t_from = 0.30 * d
        t_to   = 0.90 * d
        x = if e <= t_from then 0.0 elsif e >= t_to then 1.0 else (e - t_from) / (t_to - t_from) end
        s = 3.0 * x * x - 2.0 * x * x * x
        7000.0 * pow(1200.0 / 7000.0, s)
      end
      def diss_wet() =
        e = source.elapsed(diss_src)
        e = if e < 0. then 0. else e end
        t_on = 0.10 * d
        x = if e >= t_on then 1.0 else e / t_on end
        3.0 * x * x - 2.0 * x * x * x
      end
      # PURE-TAIL isolation: comb passes its input through, so summing four
      # combs directly would force a 0.25 weight to keep the dry at unity and
      # bury the tails 12 dB down (measured: a -44 dB mid-cross crater).
      # Subtracting the dry leaves ONLY the feedback tails.
      #
      # ONE subtraction for all four taps, never one per tap (#1565). The
      # per-tap form is algebraically identical (bit-identical over 60s) but
      # adds twelve full-frame operators on Liquidsoap's SINGLE streaming
      # thread: offline throughput ~345 vs ~645 audio-seconds per 10s of CPU
      # (1.87x), and on air it stalled the clock on ~1 dissolve in 5
      # ("Latency is too high: we must catchup 0.20-0.46 seconds").
      # Two measured non-savings, so nobody re-derives them: removing the second
      # darkening lowpass is inside run-to-run noise (754 vs 762), and dropping
      # to two combs buys ~15%. A host that still cannot afford the dissolve
      # turns it off (`transitions.effects.dissolve`) rather than thinning it.
      # scripts/fx-render-test.sh mirrors this shape; keep them in lockstep.
      washed = add(normalize=false,
        [comb(delay=0.089, feedback=diss_fb, a_source),
         comb(delay=0.113, feedback=diss_fb, a_source),
         comb(delay=0.151, feedback=diss_fb, a_source),
         comb(delay=0.181, feedback=diss_fb, a_source),
         amplify(-4., a_source)])
      washed = amplify(0.7, washed)
      washed = filter.rc(frequency=diss_cut, mode="low", wetness=diss_wet,
                 filter.rc(frequency=diss_cut, mode="low", wetness=diss_wet, washed))
      # Dry (faded) + wash: the track walks out through its own ambience.
      add(normalize=false, [a_source, amplify(diss_gain, washed)])
    else
      a_source
    end
  # CHOP ENVELOPE — crossfader cut: rhythmic gating of the outgoing track,
  # opening AT each beat start so the downbeat transient survives. Pure
  # `amplify` over source.elapsed(). Runs on its own compressed clock
  # dd = min(d, 10s) — stretched over a long crossfade the cut reads as slow
  # pumping (#861). Four envelopes ride that clock:
  #   * RATE accelerates, quarters -> eighths -> sixteenth stutter. Divisions
  #     are p/2 and p/4, so every beat start stays a gate-open.
  #   * DUTY tightens, and the FLOOR under the closed gate drops to silence only
  #     after the first quarter (full silence between the first stabs reads as
  #     dropouts).
  #   * WET ramps the gesture in, so gain is exactly 1 at e=0.
  #   * MASTER silences the branch before the transition source truncates at d.
  # Gate edges are ~12 ms smoothsteps; square edges click.
  a_source =
    if chopping then
      p = float_of_string(default=0.5, b.metadata["liq_chop_period"])
      p = if p <= 0.05 then 0.5 else p end
      dd = if d > 10. then 10. else d end
      log("DJ chop: cutting the outgoing track on the beat (p=#{p}s, dd=#{dd}s, d=#{d}s)")
      chop_src = a_source
      def chop_gain() =
        e = source.elapsed(chop_src)
        e = if e < 0. then 0. else e end
        # Accelerating clock: quarters → eighths → sixteenth stutter.
        pp =
          if e < 0.40 * dd then p
          elsif e < 0.72 * dd then 0.5 * p
          else 0.25 * p
          end
        beat = int_of_float(e / pp)
        ph = e / pp - float_of_int(beat)         # phase within the gate
        t1 = 0.15 * dd
        t2 = 0.72 * dd
        duty =
          if e < t1 then
            x = e / t1
            1.0 - (3.0 * x * x - 2.0 * x * x * x) * 0.45
          elsif e < t2 then
            x = (e - t1) / (t2 - t1)
            0.55 - (3.0 * x * x - 2.0 * x * x * x) * 0.25
          else
            0.30
          end
        f_end = 0.25 * dd
        floor_g =
          if e >= f_end then 0.0
          else
            x = e / f_end
            0.45 * (1.0 - (3.0 * x * x - 2.0 * x * x * x))
          end
        eps = 0.012 / pp                         # ~12 ms edges, in phase units
        shape =
          if ph < eps then
            x = ph / eps
            3.0 * x * x - 2.0 * x * x * x
          elsif ph < duty then 1.0
          elsif ph < duty + eps then
            x = (ph - duty) / eps
            1.0 - (3.0 * x * x - 2.0 * x * x * x)
          else 0.0
          end
        g_gate = floor_g + (1.0 - floor_g) * shape
        # Engage ramp: gain 1.0 at e=0, gate fully in by 8% of the gesture.
        t_eng = 0.08 * dd
        wet =
          if e >= t_eng then 1.0
          else
            x = e / t_eng
            3.0 * x * x - 2.0 * x * x * x
          end
        g = 1.0 - wet * (1.0 - g_gate)
        # Master release: the rest of the buffer belongs to the incoming ramp.
        master =
          if e < 0.82 * dd then 1.0
          elsif e < 0.92 * dd then
            x = (e - 0.82 * dd) / (0.10 * dd)
            1.0 - (3.0 * x * x - 2.0 * x * x * x)
          else 0.0
          end
        g * master
      end
      amplify(chop_gain, a_source)
    else
      a_source
    end
  # LOOP ENVELOPE — exit loop: the last bar of the OUTGOING track is caught in a
  # loop as the dry is hard-cut, rides in tempo under the pick, then filters down
  # and releases.
  #
  # Measured on the v2.4.5 image (#863): this build's `comb` is a ONE-SHOT
  # feed-forward echo, NOT recirculating — one burst in yields exactly one
  # delayed copy whatever the feedback, so no single comb can loop. Hence a
  # CASCADE OF DOUBLING DELAYS: K combs at bar, 2*bar, 4*bar, 8*bar convolve to
  # taps at every multiple 0..(2^K-1) of bar, so a one-bar capture tiles
  # gaplessly and terminates by construction. At feedback=0.0 the tap set is
  # flat at -6 dB whatever the stage count. Later stages are built only when
  # their delay < d, since a tap at >= d is never heard.
  #
  # Known compromise: the analyzer gives tempo, not beat PHASE, so this is a
  # tape-loop, not a gridded loop; the ride-out lowpass softens the splice tick.
  a_source =
    if looping then
      bar = float_of_string(default=2.0, a.metadata["liq_loop_bar"])
      bar = if bar <= 0.2 then 2.0 else bar end
      log("DJ loop: catching the last bar of the outgoing track (bar=#{bar}s, d=#{d}s)")
      loop_src = a_source
      # Dry gate: unity through the capture pass, then the hard cut. Everything
      # after is the cascade re-emitting that one bar.
      def loop_dry() =
        e = source.elapsed(loop_src)
        e = if e < 0. then 0. else e end
        edge = 0.012
        if e < bar - edge then 1.0
        elsif e < bar then
          x = (e - (bar - edge)) / edge
          1.0 - (3.0 * x * x - 2.0 * x * x * x)
        else 0.0 end
      end
      # Ride-out darkening: the cutoff closes 9 kHz -> 2.5 kHz over the back
      # half. Wet stays 0 through the capture pass and ramps in only after the
      # cut, because the still-audible dry passes through this chain too.
      def loop_cut() =
        e = source.elapsed(loop_src)
        e = if e < 0. then 0. else e end
        t_from = 0.45 * d
        t_to   = 0.90 * d
        x = if e <= t_from then 0.0 elsif e >= t_to then 1.0 else (e - t_from) / (t_to - t_from) end
        s = 3.0 * x * x - 2.0 * x * x * x
        9000.0 * pow(2500.0 / 9000.0, s)
      end
      def loop_wet() =
        e = source.elapsed(loop_src)
        e = if e < 0. then 0. else e end
        t_on = bar + 0.15 * d
        x = if e >= t_on then 1.0 elsif e <= bar then 0.0 else (e - bar) / (0.15 * d) end
        3.0 * x * x - 2.0 * x * x * x
      end
      # Complementary ride: the loop is built from the raw capture so every
      # repeated bar has a stable internal level, and this outer envelope gives
      # back headroom as the incoming rises. A log-faded outgoing here stays hot
      # through the capture pass and produces an audible level jump.
      def loop_gain() =
        e = source.elapsed(loop_src)
        e = if e < 0. then 0. else e end
        if e >= d then 0.0 else 1.0 - e / d end
      end
      gated  = amplify(loop_dry, a_source)
      looped = comb(delay=bar, feedback=0.0, gated)
      looped = comb(delay=2.0 * bar, feedback=0.0, looped)
      looped = if 4.0 * bar < d then comb(delay=4.0 * bar, feedback=0.0, looped) else looped end
      looped = if 8.0 * bar < d then comb(delay=8.0 * bar, feedback=0.0, looped) else looped end
      # feedback=0.0 emits each delayed copy at 0 dB, and because the dry gate
      # keeps exactly one bar and the delays double, the copies occupy
      # non-overlapping bar slots at unity. NEVER apply global makeup to the
      # cascade: it doubles the direct capture pass before any delayed copy
      # exists, recreating the ~+6 dB transition-entry jump.
      looped = filter.rc(frequency=loop_cut, mode="low", wetness=loop_wet,
                 filter.rc(frequency=loop_cut, mode="low", wetness=loop_wet, looped))
      amplify(loop_gain, looped)
    else
      a_source
    end
  b_source = fade.in(duration=d, initial_metadata=b.metadata, b.source)
  # INCOMING SIDE. Every effect here releases by driving WETNESS to 0, never by
  # parking the cutoff open: an RC filter at its open cutoff is still not
  # transparent, and the branch operators vanish at the d boundary, so the track
  # must be bit-clean before then.
  #
  # BLEND, incoming side: the pick arrives lows-first, a lowpass opening
  # 250 Hz -> 9 kHz as the outgoing HPF climbs.
  b_source =
    if blending then
      bin_src = b_source
      def blend_lp() =
        e = source.elapsed(bin_src)
        e = if e < 0. then 0. else e end
        t_open = 0.70 * d
        x = if e >= t_open then 1.0 else e / t_open end
        sxx = 3.0 * x * x - 2.0 * x * x * x
        250.0 * pow(9000.0 / 250.0, sxx)
      end
      def blend_lp_wet() =
        e = source.elapsed(bin_src)
        e = if e < 0. then 0. else e end
        t_from = 0.70 * d
        t_to   = 0.82 * d
        x = if e <= t_from then 0.0 elsif e >= t_to then 1.0 else (e - t_from) / (t_to - t_from) end
        1.0 - (3.0 * x * x - 2.0 * x * x * x)
      end
      filter.rc(frequency=blend_lp, mode="low", wetness=blend_lp_wet,
        filter.rc(frequency=blend_lp, mode="low", wetness=blend_lp_wet, bin_src))
    else
      b_source
    end
  # SWEEP, incoming side — two moves, both fully out well before the outgoing
  # track is gone. SURFACING: a lowpass opens 500 Hz -> 9 kHz while the old
  # track still dominates; it must open fast and early, or the muffle outlives
  # the transition. Then the BASS SWAP below.
  b_source =
    if sweeping then
      in_src = b_source
      def surf_cut() =
        e = source.elapsed(in_src)
        e = if e < 0. then 0. else e end
        t_open = 0.30 * d
        x = if e >= t_open then 1.0 else e / t_open end
        s = 3.0 * x * x - 2.0 * x * x * x
        500.0 * pow(9000.0 / 500.0, s)            # 500 Hz → open, log space
      end
      def surf_wet() =
        e = source.elapsed(in_src)
        e = if e < 0. then 0. else e end
        t_from = 0.20 * d
        t_to   = 0.32 * d
        x = if e <= t_from then 0.0 elsif e >= t_to then 1.0 else (e - t_from) / (t_to - t_from) end
        1.0 - (3.0 * x * x - 2.0 * x * x * x)     # wet 1 → 0 (fully dry by 40%)
      end
      # BASS SWAP — hold the pick's low end back so two basslines never fight
      # across the long blend, then release. It releases earlier than a club
      # bass-swap would: with both tracks processed the middle of the blend goes
      # near-silent. Built as a SUBTRACT-HPF (mode "high" is broken, see the
      # blend block): subtract the track's own <160 Hz content, then ease that
      # subtraction to zero.
      def bass_amt() =
        e = source.elapsed(in_src)
        e = if e < 0. then 0. else e end
        t_from = 0.38 * d
        t_to   = 0.55 * d
        x = if e <= t_from then 0.0 elsif e >= t_to then 1.0 else (e - t_from) / (t_to - t_from) end
        0.0 - (1.0 - (3.0 * x * x - 2.0 * x * x * x))
      end
      bs = filter.rc(frequency=surf_cut, mode="low", wetness=surf_wet,
             filter.rc(frequency=surf_cut, mode="low", wetness=surf_wet, in_src))
      bs_low = filter.rc(frequency=160., mode="low", wetness=1., bs)
      add(normalize=false, [bs, amplify(bass_amt, bs_low)])
    else
      b_source
    end
  add(normalize=false, [a_source, b_source])
end

# The PRE-cross handle for the on_metadata hook attached further down. Hooking
# the post-cross source fires TWICE per transition (dj_transition's fades both
# pass initial_metadata= and the outgoing track wins), stranding the UI one song
# behind. Also what the starve guard samples.
music_meta = music

# Hard ceiling on how far ahead voice_marker may push voice_until. The gate
# fails toward SERVING jingles: a duration that measures wrong (corrupt header,
# a filename resolving to other media) would otherwise silence the rotate for
# that long, with nothing in the log to say why.
VOICE_GATE_MAX_SEC = 120.

# The gate arms at the clip's on_metadata, so a jingle handed to the rotate
# inside the ~1s say.txt poll seam is covered by neither this nor the
# controller's waitForJingleClear. intro_queue arms it too, not just
# voice_queue, so a link can't talk over a stinger; the cost is that a chatty
# persona skips some jingles and runs slightly under the configured ratio.

# JINGLES & STATION ID — rotate a jingle in every N tracks.
#
# CRITICAL: this rotate MUST sit here, on the raw pre-cross / pre-duck music
# source. `rotate` is track_sensitive and only advances at a track boundary of
# the source it is playing, and `cross` and the `smooth_add` layers present
# their output as ONE never-ending track, so a rotate above them plays a single
# jingle at startup and is stuck on music forever. music_meta is captured ABOVE
# this, so jingles never reach now-playing. An empty jingles.m3u is fine (rotate
# skips an unavailable source); jingle_ratio 0 = jingles OFF (#997), the rotate
# is not built at all.
music =
  if jingle_ratio() > 0 then
    jingles = playlist(
      id="jingles",
      mode="randomize",
      reload_mode="watch",
      "#{state_dir}/jingles.m3u"
    )
    # Announce each jingle to the controller (#997): jingles are otherwise
    # invisible to it and play outside its airVoice serialiser. Written at FEED
    # time — the jingle turns audible ~crossfade_duration later — and the
    # controller holds its voice chain until start + crossfade + clip length.
    jingles.on_metadata(synchronous=false, fun (m) ->
      file.write(
        data=json.stringify(compact=true, {
          filename = m["filename"],
          durationSec = jingle_duration(m["filename"]),
          startedAt = time()
        }),
        atomic=true,
        temp_dir=jingle_tmp_dir,
        "#{state_dir}/jingle-playing.json"
      )
    )
    # Unavailable while a bed is on air (can't split a bed from its song), while
    # a voice clip is on air (can't hand a stinger over the DJ), and while the
    # music chain is starved (can't serve stingers forever over dead air).
    jingles = source.available(jingles, {
      not bed_on_air() and not pause_talk_on_air() and not jingle_now_on_air() and
      time() > voice_until() and not music_starved()
    })
    rotate(weights=[1, jingle_ratio()], [jingles, music])
  else
    music
  end

# Manual presses wrap the automatic rotate so they win the next SAFE boundary,
# even when dj_queue already holds tracks or the rotate is due. While speech or
# a bed is live the source is unavailable but the request remains queued.
jingle_now = source.available(jingle_now_queue, {
  not bed_on_air() and not pause_talk_on_air() and time() > voice_until()
})
music = fallback(
  id="music_with_jingle_now",
  track_sensitive=true,
  [jingle_now, music]
)

# Per-track loudness normalisation: the controller stamps `liq_amplify`
# ("<n> dB") on any track with a measured LUFS. BEFORE the cross so each track
# carries its own gain into the crossfade, and AFTER the music_meta capture.
music = amplify(override="liq_amplify", 1., music)

# persist_override=true (2.4): with the new default the liq_cross_duration
# override is reset before it sizes the stamped track's own end-of-track buffer
# (fx-render-test.sh xdur: a stamped 12 renders 86s without persist, 78s with).
# The flip side is that a stamp lingers over later UNstamped tracks, so the
# controller stamps every track it annotates.
music = cross(
  duration=crossfade_duration(),
  persist_override=true,
  dj_transition,
  music
)

# DJ VOICE — TTS clips dropped as paths into say.txt / intro.txt.
# voice_queue = solo voice (heavy duck: station IDs, hourly, request
# back-announce); intro_queue = talk-over links (light duck).
voice_queue = request.queue(id="voice_queue")
intro_queue = request.queue(id="intro_queue")

def pause_voice_delivery_id(uri) =
  matches = string.extract(pattern="subwave_pause_delivery=\\\"([^\\\"]+)\\\"", uri)
  list.assoc(default="", 1, matches)
end

# The acceptance marker closes the controller-restart interval between removing
# say.txt and the voice's on_metadata. It is written only AFTER voice_queue.push
# returns, so "accepted" means this live mixer owns the stable delivery id.
# One writer (poll_voice), one temp dir. A failure is logged and degrades to the
# older mixer's stable-id/start-marker compatibility path.
def write_pause_voice_accepted(uri) =
  delivery_id = pause_voice_delivery_id(uri)
  if delivery_id != "" then
    try
      file.write(
        data=json.stringify(compact=true, {
          deliveryId = delivery_id,
          acceptedAt = time()
        }),
        atomic=true,
        temp_dir=pause_voice_accept_tmp_dir,
        "#{state_dir}/pause-talk-voice-accepted.json"
      )
    catch err do
      log(label="subwave", "pause voice acceptance marker failed (#{err})")
    end
  end
end

# AIR-TIME MARKER (#1382). on_metadata fires as the clip starts feeding, so
# `startedAt` IS the live-edge moment the words begin (the clock
# now-playing.json is stamped on); handoff time runs 0.5s of poll plus the queue
# and duck ramp ahead of it. The controller matches it back via `subwave_voice`,
# the id stamped into the clip's annotate: URI, which also filters out the silent
# lead-in. Like jingle-playing.json, the file is never deleted and the controller
# dedupes on a value it carries, not on the file's existence.
def voice_marker(channel, tmp_dir) =
  fun (m) ->
    begin
      voice_id = m["subwave_voice"]
      if voice_id != "" then
        # ONE clock read for both jobs, taken before either: re-reading time()
        # after the work below would skew the live-edge stamp.
        now = time()
        fname = m["filename"]

        # The marker goes out FIRST. Arming the jingle gate needs
        # request.duration, which can raise on an unreadable/empty filename; if
        # that ran first a raise would cost the marker entirely, and since the
        # file is never deleted awaitVoiceAir would burn its full 20s timeout
        # against the PREVIOUS clip's voiceId instead of degrading at once.
        file.write(
          data=json.stringify(compact=true, {
            voiceId = voice_id,
            channel = channel,
            filename = fname,
            startedAt = now
          }),
          atomic=true,
          temp_dir=tmp_dir,
          "#{state_dir}/voice-playing.json"
        )

        # Dedicated durable start acknowledgement for a pause voice. The
        # generic marker above may be overwritten by later speech before a
        # controller restarts; this one changes only on the next pause delivery.
        pause_delivery_id = m["subwave_pause_delivery"]
        if pause_delivery_id != "" then
          try
            file.write(
              data=json.stringify(compact=true, {
                deliveryId = pause_delivery_id,
                startedAt = now
              }),
              atomic=true,
              temp_dir=pause_voice_start_tmp_dir,
              "#{state_dir}/pause-talk-voice-started.json"
            )
          catch err do
            log(label="subwave", "pause voice start marker failed (#{err})")
          end
        end

        # Arm the jingle gate (see voice_until above). request.duration is
        # expensive, but this hook is synchronous=false so it runs off the
        # streaming thread. Two bounds: the 30s fallback covers a clip that
        # cannot be measured, the 120s cap one that measures wrong. An over-long
        # deadline silently starves the rotate.
        dur =
          try
            null.get(default=30., request.duration(fname))
          catch err do
            log(
              label="subwave",
              "voice duration unavailable for #{fname} (#{err}); jingle gate falls back to 30s"
            )
            30.
          end
        voice_until := now + min(dur, VOICE_GATE_MAX_SEC) + 2.
      end
    end
end

# synchronous=false: this does file I/O and must not sit on the streaming thread.
voice_queue.on_metadata(synchronous=false, voice_marker("say", voice_tmp_dir))
intro_queue.on_metadata(synchronous=false, voice_marker("intro", intro_tmp_dir))

# Sound-effects channel — short pre-rendered stingers the DJ agent plays UNDER
# its voice, path written into sfx.txt (broadcast/sfx.js + queue.playSfx). Not
# mic-chained: the audio is already produced.
sfx_queue = request.queue(id="sfx_queue")

# Silent lead-in clip, pushed immediately before each speech file: smooth_add
# ducks over the silence so the dip completes BEFORE the DJ's first word.
# request.queue plays the two pushes gaplessly.
leadin_path = "/sounds/leadin.wav"
has_leadin = file.exists(leadin_path)
if has_leadin then
  log("Voice lead-in enabled: #{leadin_path}")
else
  log("No #{leadin_path} — DJ voice will duck without a pre-roll lead-in")
end

def poll_voice() =
  if file.exists("#{state_dir}/say.txt") then
    contents = string.trim(file.contents("#{state_dir}/say.txt"))
    file.remove("#{state_dir}/say.txt")
    if contents != "" then
      log("DJ says: #{contents}")
      if has_leadin then
        ignore(voice_queue.push(request.create(leadin_path)))
      end
      ignore(voice_queue.push(request.create(contents)))
      write_pause_voice_accepted(contents)
    end
  end
end
thread.run(every=0.5, poll_voice)

def poll_intro() =
  if file.exists("#{state_dir}/intro.txt") then
    contents = string.trim(file.contents("#{state_dir}/intro.txt"))
    file.remove("#{state_dir}/intro.txt")
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
  if file.exists("#{state_dir}/sfx.txt") then
    contents = string.trim(file.contents("#{state_dir}/sfx.txt"))
    file.remove("#{state_dir}/sfx.txt")
    if contents != "" then
      log("DJ sound effect: #{contents}")
      # No lead-in: a stinger must start promptly to land under the voice.
      ignore(sfx_queue.push(request.create(contents)))
    end
  end
end
thread.run(every=0.5, poll_sfx)

# MIC CHAIN — broadcast-style processing on both voice channels (numbers tuned
# for an en_GB-alan-medium-ish voice).
#
# A FUNCTION, not a shared chain variable, so each call instantiates fresh
# operator nodes; reuse hits "Early computation of source content-type". An
# 80 Hz HPF + 3 kHz presence shelf are missing for the same error on
# request.queue sources.
def mic_chain(s) =
  # Fast attack, gentle ratio: tames TTS peaks without pumping.
  s = compress(
    attack=5.0,
    release=120.0,
    threshold=-18.0,
    ratio=4.0,
    knee=2.0,
    gain=7.0,
    s
  )
  # Makeup so the voice sits clearly above the ducked music bed.
  s = amplify(1.4, s)
  # No slap echo here: with the compressor's makeup gain it lifted the TTS noise
  # floor into an audible wash behind station IDs. The voice stays dry.
  s
end

# Edge fade-IN per clip: some engines cut the audio hard at the boundary and the
# compressor's makeup gain turns that edge into a tick. Runs BEFORE
# amplify/mic_chain so the compressor never sees the raw edge.
#
# fade.in ONLY — on a request.queue source this build doesn't know the remaining
# time, so fade.out treats the WHOLE clip as inside the fade zone and multiplies
# it to silence. Tail clicks must be faded at WAV-render time instead.
def edge_fade(s) =
  fade.in(duration=0.04, s)
end

# Per-segment voice trim: the controller stamps `liq_amplify` per spoken clip
# (settings.tts.gainDb + audio/tts.ts:voiceGainDb), the same mechanism as the
# music bus. BEFORE mic_chain so the fixed-threshold compressor sees a levelled
# input; the un-annotated lead-in plays at unity.
voice = mic_chain(amplify(override="liq_amplify", 1., edge_fade(voice_queue)))
intro = mic_chain(amplify(override="liq_amplify", 1., edge_fade(intro_queue)))

# SAFETY — the dead-air guard. `emergency` is an always-ready, non-silent
# single, so the broadcast never has nothing to pull.
#
# POSITION IS LOAD-BEARING (#1300 bug 7). It MUST stay ABOVE the studio-bed
# `add` below AND the three `smooth_add` ducking layers below that. `add` is
# ready whenever ANY input is, so anything mixed into the music chain makes the
# chain look alive while the music is starved and a fallback below the mix can
# only ever select index 0:
#   * the bed is `mksafe(single(...))`, and `mksafe` makes it INFALLIBLE;
#   * the stdlib builds smooth_add as
#       add(normalize=false, [normal, fallback(track_sensitive=false, [special, blank()])])
#     whose inner fallback falls through to `blank()`, so the special leg is
#     always ready regardless of `normal`.
# Measured: -91.0 dB with the fallback below the ducking, -3.0 dB with it here.
# Do not add a second guard further down "for safety".
#
# It must also stay BELOW `music_meta` and the jingle rotate so now-playing
# metadata and jingle counting are untouched; being above the ducking is what
# lets the DJ talk over the emergency loop exactly as over music.
#
# The fade-in is NOT a debounce and must never become one. track_sensitive=false
# switches the instant `music` reports not-ready, including on brief real gaps
# (cold boot before auto.m3u resolves, a seam where dj_queue and auto_playlist
# are both momentarily unready). Delaying the switch is the wrong fix: fire
# immediately and ramp the LEVEL. The music branch keeps the stdlib identity
# transition because coming BACK must be instant.
#
# BOTH fades below are needed; don't delete either. `switch` applies NO
# transition to its FIRST selection (measured on 2.4.5: "Switch to emergency."
# at boot vs "…with transition." after), and boot IS that first selection, so
# `emergency` carries its own one-shot fade — whose default
# track_sensitive=false memoises the ramp to the source's first frame ever,
# right for boot and useless later. The `transitions=` entry covers every later
# switch.
#
# Measured (100 ms RMS): boot -38.5 -> -9.0 dB over 1.0s; mid-run starve
# -32.6 -> -9.0 dB over 1.0s; recovery a single-window step with no ramp.
EMERGENCY_FADE_SEC = 1.0
emergency = single("/sounds/emergency.mp3")
# The `: source` casts drop fade.in's extra methods, which otherwise refuse to
# unify with the plain source the identity transition and `music` child are.
emergency = (fade.in(duration=EMERGENCY_FADE_SEC, emergency) : source)
music =
  fallback(
    id="music_safety",
    track_sensitive=false,
    transitions=[
      fun (_, back_to_music) -> back_to_music,      # identity: instant recovery
      fun (_, to_emergency) ->
        (fade.in(duration=EMERGENCY_FADE_SEC, to_emergency) : source)
    ],
    [music, emergency]
  )

# STUDIO BED — low-level room tone, mixed in BEFORE voice ducking so smooth_add
# ducks it with the music (otherwise it competes with the voice).

bed_path = "/sounds/bed.mp3"

# Disabled: the looping ambient bed was audible under the DJ's voice during
# links. Flip back to `true` to restore it. That is safe for the dead-air guard
# ONLY because the guard sits ABOVE this block, on `music` — `mksafe` makes the
# bed infallible, so this `add` is permanently ready and a guard built from
# `music_bus` would be silently disarmed by this flag (#1300 bug 7).
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

# DUCKING — gated talkbax. `smooth_add` drops the music to a fixed ratio
# whenever a voice source has signal; three stacked layers, one depth each.
#
# Gated, NOT RMS-keyed: an RMS sidechain follower drove the music bus to -91 dB
# even with voice_queue empty (git f38a9af). smooth_add cares only whether the
# channel has signal.
#
# `duration` is the fade into and out of the duck. It can be gentle on the voice
# layers because each gets a silent lead-in clip pushed ahead of the speech, so
# the dip completes BEFORE the DJ's first word.
#
# Both depths come from liquidsoap_duck_*.txt, read once at startup above, so a
# change needs a mixer restart.
ducked = smooth_add(
  duration=0.8,
  # heavy duck: 0.22 (the default) drops the music to ~-13 dB under solo voice
  p={duck_voice()},
  normal=music_bus,
  special=voice
)

# Light duck on top for talk-over links — leaves the song audible underneath.
radio = smooth_add(
  duration=0.8,
  p={duck_intro()},   # 0.30 default, ~-10 dB
  normal=ducked,
  special=intro
)

# SFX on top. A stinger rides BENEATH both the DJ and the music, so it barely
# ducks; its own level and p are the two knobs.
sfx_bed = amplify(0.7, sfx_queue)
radio = smooth_add(
  duration=0.3,     # snappier than voice — stingers are short, no lead-in clip
  p={0.7},          # ~-3 dB
  normal=radio,
  special=sfx_bed
)

# Neither the jingle rotate nor the emergency dead-air fallback can sit here —
# see the JINGLES and SAFETY blocks above (#1300 bug 7).

# IDLE GATE — silence the programme while nobody is listening. The controller
# flips idle_mode over telnet (idle_on/idle_off): the switch selects blank() and
# the chain above stops being pulled, frozen mid-track. Mounts STAY UP serving
# silence (contrast stream_off, which tears them down), so playback resumes
# where it froze. A plain blank() is safe; the #660 CPU spin was specific to
# blank.skip. Not persisted — a mixer restart comes back live and the controller
# re-asserts idle if the room is still empty.
idle_mode = ref(false)
radio = switch(
  id="idle_gate",
  track_sensitive=false,
  [({idle_mode()}, blank(id="idle_silence")), ({true}, radio)]
)

# blank.skip was REMOVED here (#660): with no music in the chain it busy-loops
# at ~100% CPU and starves Icecast, measured in ANY position. The emergency
# single already covers a dead source.

# MUSIC STARVE GUARD (#1300 bug 7). `rotate` skips unavailable sources, so with
# the music chain starved the jingle rotate serves stingers back to back forever
# and the `emergency` fallback cannot see it — `radio` is still available,
# because it is producing jingles (measured: music_ready=false,
# jingles_ready=true, radio_ready=true).
#
# So sample the PRE-rotate chain (music_meta) and, after a sustained window,
# make jingles unavailable: the rotate empties, `radio` goes unavailable, and
# the emergency single fires.
#
# The window IS the "a jingle may cover a brief hiccup" behaviour — the chain is
# legitimately not-ready while a request resolves at a boundary (bounded by the
# controller's SKIP_COMMIT_WAIT_MS = 20s). Recovery is unconditional: any tick
# that sees the source ready clears the latch. Suppressed while the idle gate
# holds the programme frozen, and entering idle clears the latch outright.
STARVE_GRACE_SEC = 30.0
STARVE_SAMPLE_SEC = 1.0

# The heartbeat refreshes `at` while the outage lasts, and deliberately does NOT
# run at the sample rate: the consumer only needs the marker younger than
# STARVE_MARKER_STALE_MS (60s, controller/src/broadcast/music-starve-pure.ts),
# and 1.0s would be ~3,600 atomic rewrites an hour on a state dir that is often
# an SD card or a spinning array. 10s keeps a 6x margin. EDGE writes (latch,
# recovery, startup) stay immediate.
STARVE_HEARTBEAT_SEC = 10.0

starved_for = ref(0.0)
starved_since = ref(0.0)
last_marker_write = ref(0.0)

# NEVER let this raise. An uncaught exception inside a thread.run callback kills
# that thread PERMANENTLY, freezing the guard at whatever it last latched —
# worst case the emergency loop forever with no path back (observed as an EACCES
# on an unwritable state mount). Reporting must not share a failure domain with
# the guard it reports on.
def write_starve_marker(starved, since) =
  # Stamped for EVERY write, edge or heartbeat, so an edge write restarts the
  # heartbeat window. Set before the write so a throwing write still spaces out
  # retries.
  last_marker_write := time()
  try
    file.write(
      data=json.stringify(compact=true, {
        starved = starved,
        since = since,
        at = time()
      }),
      atomic=true,
      temp_dir=starve_tmp_dir,
      "#{state_dir}/music-starved.json"
    )
  catch err do
    log(label="subwave", "music-starved.json write failed (#{err})")
  end
end

# Publish the healthy state at startup so a working station has the file.
write_starve_marker(false, 0.0)

thread.run(every=STARVE_SAMPLE_SEC, fun () -> begin
  if idle_mode() then
    starved_for := 0.0
    if music_starved() then
      music_starved := false
      write_starve_marker(false, 0.0)
    end
  elsif source.is_ready(music_meta) then
    starved_for := 0.0
    if music_starved() then
      music_starved := false
      log(label="subwave", "music source recovered - jingle rotate re-armed")
      write_starve_marker(false, 0.0)
    end
  else
    starved_for := starved_for() + STARVE_SAMPLE_SEC
    if music_starved() then
      # Refreshes `at` so the controller can tell a live outage from a marker
      # left by a mixer that died mid-outage.
      if time() - last_marker_write() >= STARVE_HEARTBEAT_SEC then
        write_starve_marker(true, starved_since())
      end
    elsif starved_for() >= STARVE_GRACE_SEC then
      music_starved := true
      starved_since := time()
      log(
        label="subwave",
        "MUSIC SOURCE STARVED for #{starved_for()}s - jingles gated off, emergency loop takes over"
      )
      write_starve_marker(true, starved_since())
    end
  end
end)

# BROADCAST BUS — masters preserved; the brick-wall limiter (20:1 at -1 dBFS) is
# the ONLY processing. A -14 LUFS normaliser, stereo widener and bus compressor
# were all removed for reshaping the masters. The limiter stays because MP3
# encoding generates inter-sample peaks ~0.5-1 dB over the source, so modern
# masters (~-0.3 dBFS TP) would clip decoders. Typically 0 dB of reduction.

radio = compress(
  attack=1.0,
  release=80.0,
  threshold=-1.0,
  ratio=20.0,
  knee=0.5,
  gain=0.0,
  radio
)

# METADATA — ICY title driven explicitly from the pre-cross on_meta hook so it
# matches now-playing.json. BOTH operators are load-bearing:
#  1. metadata.map strip kills ALL metadata still flowing through the chain.
#     dj_transition's fades pass initial_metadata=, so ~crossfade seconds after
#     on_meta fires the cross re-emits the OUTGOING track's metadata, which
#     would clobber the title back and freeze Icecast one track behind.
#  2. insert_metadata is then the ONLY source of stream metadata, pushed from
#     on_meta.
radio = metadata.map(update=false, strip=true, fun(_) -> [], radio)
radio = insert_metadata(radio)

def on_meta(m) =
  title = m["title"]
  artist = m["artist"]
  album = m["album"]
  filename = m["filename"]
  subsonic_id = m["subsonic_id"]
  # BEDS — an instrumental the controller pushed into dj_queue for the DJ to
  # talk over BETWEEN songs (broadcast/beds.ts). It rides the music chain but is
  # NOT a song: never reaches now-playing.json, never pushes an ICY title. It
  # carries no title/artist, so it must branch BEFORE the gate below, which
  # would drop it silently — this marker is the only way the controller learns
  # "bed on air, air the link now".
  if m["subwave_kind"] == "pause-talk" then
    jingle_now_on_air := false
    bed_on_air := false
    pause_talk_on_air := true
    log("on_meta: pause-talk silence started (#{filename})")
    file.write(
      data=json.stringify(compact=true, {
        filename = filename,
        pauseId = m["subwave_pause_id"],
        startedAt = time()
      }),
      atomic=true,
      temp_dir=pause_talk_tmp_dir,
      "#{state_dir}/pause-talk-playing.json"
    )
  elsif m["subwave_kind"] == "bed" then
    jingle_now_on_air := false
    pause_talk_on_air := false
    log("on_meta: bed started (#{filename})")
    bed_on_air := true
    file.write(
      data=json.stringify(compact=true, {
        filename = filename,
        startedAt = time()
      }),
      atomic=true,
      temp_dir=bed_tmp_dir,
      "#{state_dir}/bed-playing.json"
    )
  elsif title != "" or artist != "" then
    bed_on_air := false
    pause_talk_on_air := false
    jingle_now_on_air := false
    log("on_meta: title=#{title} | artist=#{artist} | album=#{album} | id=#{subsonic_id}")
    ts = int_of_float(time())
    # json.stringify, not interpolation: titles with embedded quotes or
    # backslashes produce invalid JSON.
    payload = json.stringify(compact=true, {
      title = title,
      artist = artist,
      album = album,
      subsonic_id = subsonic_id,
      filename = filename,
      timestamp = ts
    })
    # atomic=true — the controller re-reads this every 1.5s and treats ANY parse
    # failure as null, so an in-place write blanks now-playing for a tick.
    # temp_dir keeps the rename on the state fs (#1240, see ensure_tmp_dir).
    file.write(data=payload, atomic=true, temp_dir=np_tmp_dir, "#{state_dir}/now-playing.json")
    # Same metadata onto the Icecast stream, so the ICY title tracks the current
    # song instead of lagging a transition behind.
    radio.insert_metadata([
      ("title", title),
      ("artist", artist),
      ("album", album)
    ])
  else
    # Untitled, non-bed metadata (emergency single, untagged local file).
    # Nothing to publish, but it still marks the bed's end: without this reset
    # bed_on_air latches true and starves the jingle rotate until the next
    # tagged song.
    bed_on_air := false
    pause_talk_on_air := false
    jingle_now_on_air := false
  end
end

# Attached to `music_meta`, the PRE-cross handle (post-cross fires twice).
# on_metadata rather than on_track, because on_track gets swallowed by source
# switches (request queue -> auto playlist). synchronous=false: on_meta does
# file I/O, so it runs on the task queue, not the streaming thread.
music_meta.on_metadata(synchronous=false, on_meta)

# OUTPUT — broadcast to Icecast.
#
# Stream on/off control. Icecast outputs can't pause, but they can be shut down
# and recreated: stream_off disconnects every mount and stops the hourly
# archive, stream_on recreates them. force_start is what lets a recreated output
# start after init. State lives in refs, read back over telnet; NOT persisted.
#
# /stream.mp3 is the universal floor and always serves. Its default bitrate is
# 192, not 128: dense brick-walled masters produce audible encode grain at 128.
# Other mounts are opt-in and an unused mount costs nothing.
settings.init.force_start := true

# TEMPORARY (re-harden later): the broadcast entrypoint launches liquidsoap as
# root because the 2.4.4 base image changed the `liquidsoap` user's uid and made
# the persisted state files unwritable. Without this, liquidsoap refuses to
# start under a root euid. Revert with docker/broadcast-entrypoint.sh once the
# state files are re-chowned.
settings.init.allow_root := true

# Hourly archive path. The `{...}` wrapper makes it a GETTER so strftime re-runs
# each time output.file reopens; a bare string skips strftime and writes
# everything to one literal "%Y-%m-%d/%H-00.mp3" truncated each hour.
archive_path = {time.string("#{state_dir}/archive/%Y-%m-%d/%H-00.mp3")}

def make_stream_outputs() =
  # Every encoder below picks its bitrate from a fixed set of branches because
  # %mp3/%opus/%fdkaac(bitrate=…) each need a parse-time literal int — a ref
  # won't do. Keep the branches in sync with MP3_BITRATES / OPUS_BITRATES /
  # AAC_BITRATES in settings.ts.
  br = stream_bitrate()
  mp3_enc =
    if br <= 64 then
      %mp3(bitrate=64, samplerate=44100, stereo=true)
    elsif br <= 96 then
      %mp3(bitrate=96, samplerate=44100, stereo=true)
    elsif br <= 128 then
      %mp3(bitrate=128, samplerate=44100, stereo=true)
    elsif br <= 160 then
      %mp3(bitrate=160, samplerate=44100, stereo=true)
    elsif br <= 192 then
      %mp3(bitrate=192, samplerate=44100, stereo=true)
    else
      %mp3(bitrate=320, samplerate=44100, stereo=true)
    end
  mp3_out = output.icecast(
    mp3_enc,
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
  # Opus mandates 48 kHz internally, so this mount also costs a 44.1->48k
  # resample. application="audio" is the music tuning; 96 kbps is the
  # music-transparent default. When off, neither is built.
  opus_shutdown =
    if opus_enabled() then
      obr = opus_bitrate()
      opus_enc =
        if obr <= 96 then
          %opus(bitrate=96, samplerate=48000, channels=2, application="audio", vbr="constrained")
        elsif obr <= 128 then
          %opus(bitrate=128, samplerate=48000, channels=2, application="audio", vbr="constrained")
        elsif obr <= 192 then
          %opus(bitrate=192, samplerate=48000, channels=2, application="audio", vbr="constrained")
        elsif obr <= 256 then
          %opus(bitrate=256, samplerate=48000, channels=2, application="audio", vbr="constrained")
        else
          %opus(bitrate=320, samplerate=48000, channels=2, application="audio", vbr="constrained")
        end
      opus_out = output.icecast(
        opus_enc,
        id="stream_opus",
        fallible=true,
        # ICY metadata toggle (default ON). output.icecast's null default
        # guesses ICY off for Ogg and relies on in-band chained-Ogg re-emission,
        # but many clients (Ferrosonic, Cast, Symfonium) read the Ogg comment
        # once at connect and freeze on the first title (#1052), while
        # foobar2000 wants the opposite. Hence a toggle.
        send_icy_metadata=ogg_icy_metadata(),
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
  # Ogg-wrapped FLAC — streamable over Icecast, unlike the file-oriented native
  # %flac. No resample, no bitrate to pick: compression=5 is the FLAC default
  # and 16-bit is universally decodable.
  flac_shutdown =
    if flac_enabled() then
      flac_out = output.icecast(
        %ogg(
          %flac(
            samplerate=44100,
            channels=2,
            compression=5,
            bits_per_sample=16
          )
        ),
        id="stream_flac",
        fallible=true,
        # ICY toggle — see the /stream.opus note above (#1052 vs foobar2000).
        send_icy_metadata=ogg_icy_metadata(),
        host=environment.get(default="icecast", "ICECAST_HOST"),
        port=7702,
        password=environment.get("ICECAST_SOURCE_PASSWORD"),
        mount="/stream.flac",
        name=station_name(),
        description="Personal frequency from the homelab — lossless",
        genre="Various",
        url="http://localhost:7700",
        radio
      )
      flac_out.shutdown
    else
      fun () -> ()
    end
  # AAC-LC over Icecast as raw ADTS, for players that lack Opus.
  # afterburner=true trades CPU for quality; no resample; format="audio/aac"
  # pins the mount's advertised MIME so clients recognise the ADTS stream.
  aac_shutdown =
    if aac_enabled() then
      abr = aac_bitrate()
      aac_enc =
        if abr <= 128 then
          %fdkaac(bitrate=128, aot="mpeg4_aac_lc", transmux="adts", afterburner=true, samplerate=44100, channels=2)
        elsif abr <= 192 then
          %fdkaac(bitrate=192, aot="mpeg4_aac_lc", transmux="adts", afterburner=true, samplerate=44100, channels=2)
        else
          %fdkaac(bitrate=256, aot="mpeg4_aac_lc", transmux="adts", afterburner=true, samplerate=44100, channels=2)
        end
      aac_out = output.icecast(
        aac_enc,
        id="stream_aac",
        format="audio/aac",
        fallible=true,
        host=environment.get(default="icecast", "ICECAST_HOST"),
        port=7702,
        password=environment.get("ICECAST_SOURCE_PASSWORD"),
        mount="/stream.aac",
        name=station_name(),
        description="Personal frequency from the homelab",
        genre="Various",
        url="http://localhost:7700",
        radio
      )
      aac_out.shutdown
    else
      fun () -> ()
    end
  # Hourly archive. A second MP3 encoder running 24/7 is the biggest CPU cost in
  # the broadcast container, so the whole output is guarded. Built in here so it
  # follows the on-air lifecycle — off air stops the recording, rather than
  # writing hourly files of the emergency loop.
  archive_shutdown =
    if archive_enabled() then
      br = archive_bitrate()
      arch_out =
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
      arch_out.shutdown
    else
      log("Hourly archive disabled — set archive.enabled=true in settings to re-enable")
      fun () -> ()
    end
  fun () -> begin
    mp3_out.shutdown()
    opus_shutdown()
    flac_shutdown()
    aac_shutdown()
    archive_shutdown()
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
    # Drop now-playing.json so the UI stops advertising the last track: the
    # controller reads a missing file as "nothing playing". on_meta rewrites it
    # on the next track once back on air.
    if file.exists("#{state_dir}/now-playing.json") then
      file.remove("#{state_dir}/now-playing.json")
    end
  end
end

# On air at startup, hourly archive included.
stream_up()

# CONTROL — telnet commands, all operator-only, driven by the controller.
#
# `restart` is how every liquidsoap_*.txt setting takes effect: shut down, and
# the container restart-policy brings us back ~3s later with the new values.
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

# Off air / back on air on demand — the mounts go away entirely. Contrast the
# idle gate below, which keeps them up.
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

# Pause / resume while keeping the mounts up (the idle gate above). Idempotent
# and logs only on a state change, so the controller can re-assert cheaply.
server.register(
  "idle_on",
  description="Silence the programme while nobody listens (mounts stay up)",
  usage="idle_on",
  fun(_) -> begin
    if not idle_mode() then
      log("Idle gate ON via server command — programme paused, mounts stay up")
    end
    idle_mode := true
    "OK"
  end
)

server.register(
  "idle_off",
  description="Resume the programme after an idle pause",
  usage="idle_off",
  fun(_) -> begin
    if idle_mode() then
      log("Idle gate OFF via server command — programme resumed")
    end
    idle_mode := false
    "OK"
  end
)

server.register(
  "idle_status",
  description="Report whether the idle gate is active (on/off)",
  usage="idle_status",
  fun(_) -> if idle_mode() then "on" else "off" end
)

# Skip the current track: .skip() on the final source propagates down the chain
# and force-ends the track, after which cross runs the normal dj_transition into
# the next one (dj_queue item, else auto).
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

server.register(
  "subhttp_probe_status",
  description="Consume a proto_subhttp completion outcome: ready / failed / pending",
  usage="subhttp_probe_status <probe-id>",
  fun(arg) -> take_subhttp_outcome(string.trim(arg))
)

# What a skip would air next from dj_queue: "ready" (a resolved request is
# waiting), "resolving" (pushed but still downloading, so a skip now falls
# through to auto.m3u), or "empty". The controller polls this before `skip` so
# an operator skip airs the committed pick (#1300 bug 6). A request already
# popped for boundary prefetch is in neither state and reads as "empty", which
# the caller treats as keep-waiting, never as proof of an idle queue.
server.register(
  "dj_queue_status",
  description="Report the pending dj_queue state: ready / resolving / empty",
  usage="dj_queue_status",
  fun(_) -> begin
    q = dj_queue.queue()
    if list.length(q) == 0 then
      "empty"
    else
      ready = list.filter(fun(r) -> request.status(r) == "ready", q)
      if list.length(ready) > 0 then "ready" else "resolving" end
    end
  end
)

# Remove a PENDING request from dj_queue by RID, for DELETE /dj/queue/:trackId.
# Anything on air or already pulled as the next source is no longer in .queue()
# and answers NOT_FOUND, which the caller treats as "too late to cancel".
server.register(
  "dj_queue_remove",
  description="Remove a pending request from dj_queue by request id",
  usage="dj_queue_remove <rid>",
  fun(arg) -> begin
    rid = string.trim(arg)
    q = dj_queue.queue()
    matches = list.filter(fun(r) -> "#{request.id(r)}" == rid, q)
    if list.length(matches) == 0 then
      "NOT_FOUND"
    else
      # Removal MUST go through the stdlib's remove(). A filter +
      # set_queue(kept) rebuild looks equivalent but set_queue() FLUSHES
      # request.dynamic's inner queue wholesale, and a request already popped
      # for prefetch is in NEITHER visible list while its download runs, so the
      # flush orphans it.
      list.iter(fun(r) -> dj_queue.remove(r), matches)
      # Release the dropped request's file/URI now, rather than waiting for
      # Liquidsoap to flag it as leaked.
      list.iter(fun(r) -> request.destroy(r), matches)
      log("Removed request #{rid} from dj_queue via server command")
      "OK"
    end
  end
)
