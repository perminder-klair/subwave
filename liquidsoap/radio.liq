# SUB/WAVE — Liquidsoap broadcast script
# Plays track URIs the controller drops into next.txt, crossfades them, ducks
# the DJ voice over them, and falls back to an autonomous playlist.

settings.log.level := 3
settings.log.file := true
settings.log.file.path := "/var/log/liquidsoap/radio.log"

# Telnet server — the controller's only channel into the mixer (restart, skip,
# stream/idle gates). Bound to all interfaces on the container's private
# network only; NOT exposed to the host.
settings.server.telnet := true
settings.server.telnet.bind_addr := "0.0.0.0"
settings.server.telnet.port := 1234

# Multi-station profiles: the ACTIVE station's dir, resolved and exported as
# SUBWAVE_STATE_DIR by the container entrypoint (docker/broadcast-entrypoint.sh
# / the AIO supervisor). Single-station installs and dev runs get the default.
state_dir = environment.get(default="/var/sub-wave", "SUBWAVE_STATE_DIR")

# Scratch dirs for the atomic marker writes below (#1240). Without a temp_dir on
# the state fs, file.write(atomic=true) stages under $TMPDIR — the container
# overlay, while the state dir is a bind mount — so the rename is cross-device
# and the stdlib silently degrades to a NON-atomic copy, i.e. the half-written
# JSON race atomic=true exists to prevent was never actually prevented.
# ONE DIR PER WRITER: the stdlib always names the temp file `atomic.write`
# inside the dir it is given, and the jingle write is synchronous=false.
# Created here rather than in the entrypoints so broadcast and the AIO can't
# drift. Returns null on failure (file.mkdir does NOT raise) — a bad temp_dir
# would ENOENT inside on_metadata, whereas null just restores the old $TMPDIR
# behaviour.
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
# Second dir for the SAME marker file, for the same reason the two voice
# channels get one each (see below): jingle-playing.json has two writers — the
# rotate's own on_metadata and jingle_now_queue's hook — and the stdlib always
# names its staging file `atomic.write` inside the dir it is given. The two
# clips can never be the same clip (music_meta is captured above the rotate), but
# their feeds can overlap inside one crossfade, and a shared dir makes that a
# torn write.
jingle_now_tmp_dir = ensure_tmp_dir("#{state_dir}/tmp/jingle-now")
bed_tmp_dir = ensure_tmp_dir("#{state_dir}/tmp/bed")
starve_tmp_dir = ensure_tmp_dir("#{state_dir}/tmp/starve")
# One per voice channel, not one for both: they write the SAME marker file, and
# the stdlib always names its staging file `atomic.write` inside the dir it is
# given, so a shared dir is a torn write waiting for the one tick where a
# heavy-duck segment and a talk-over link land together.
voice_tmp_dir = ensure_tmp_dir("#{state_dir}/tmp/voice")
intro_tmp_dir = ensure_tmp_dir("#{state_dir}/tmp/intro")

# MUSIC STARVE GUARD (#1300 bug 7) — the latch only; the tick that drives it is
# registered far below, after idle_mode exists. Declared up here because the
# jingles gate reads it from a thunk long before then (same lazy-thunk pattern
# as bed_on_air).
music_starved = ref(false)

# On-demand jingles and the automatic rotate share these live safety gates.
# Declared before the queue sources because the priority jingle source needs
# them; on_meta and voice_marker below update them at the live edge.
#
# BEDS ↔ JINGLES — bed_on_air is true from a bed's first metadata until the next
# real song's (both set in on_meta below). The jingle rotate counts every
# music-chain track and a bed IS a track, so without this gate a stinger can land
# BETWEEN the bed and the song it ramps into. While up, the jingle sources read
# as unavailable and both the rotate and a manual press defer to the next real
# boundary.
bed_on_air = ref(false)

# Voice-on-air deadline for the jingle gates. #997 solved one direction — a
# voice handoff waits out a jingle that is already feeding (jingle-playing.json
# + waitForJingleClear in the controller). The other direction was unguarded: the
# rotate could hand a stinger to the music chain WHILE a DJ clip is on air, and
# the jingle simply plays over the voice.
#
# A deadline, not a boolean. `source.is_ready(voice_queue)` looks like the
# obvious predicate and is a trap: on a request.queue it latches true forever
# after the first push (measured: still true 24s after a 6.4s clip finished,
# queue empty), which would starve the jingle rotate permanently. An instant in
# the future cannot latch — at worst it is already in the past.
voice_until = ref(0.)

# True from a manual (on-demand) jingle's first metadata until the next
# music-chain track resets it in on_meta. Keeps the automatic rotate from
# stacking a stinger on top of an announcement an operator fired by hand.
jingle_now_on_air = ref(false)

# ---------------------------------------------------------------------------
# RUNTIME SETTINGS — one tiny text file per value, written by the controller
# via settings.update() and read ONCE here at startup: changing any of them
# needs a mixer restart. Missing/garbage keeps the default.
# ---------------------------------------------------------------------------

jingle_ratio = ref(30)
crossfade_duration = ref(10.0)
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
# per-branch inside dj_transition below, on the OUTGOING track's source only, so
# idle playout passes through no effect operator and the incoming track always
# lands clean. Every envelope is a closure over source.elapsed() on its own
# branch — no threads, no shared state — so it holds in AUDIO time under any
# clock (wall-clock envelopes drift; caught by scripts/fx-render-test.sh).
#
# Engine constraints, all measured — do not "simplify" past them:
#   * v2.4.5 is the MINIMUM runtime. 2.4.4's O(n) clock scan made every effect
#     transition peg a core and stall the stream (see Dockerfile.broadcast).
#   * comb, NOT echo: native `echo` (incl. ping_pong) type-checks and then
#     passes audio through bit-for-bit on both 2.2.5 and 2.4.4 (identical md5
#     dry vs wet). `comb` is the working primitive with getter feedback.
#   * filter.rc, NOT the SVF `filter` (unstable near sr/4, collapses to
#     near-silence — hence the 9 kHz cap on every "open" cutoff) and NOT
#     iir_filter/HPF (the "Early computation of source content-type" crash).
#     filter.rc and comb both instantiate cleanly inside the cross callback;
#     re-run fx-render-test.sh before adding any OTHER operator class there.

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
# source 44.1 kHz (so only a true lossless tier when the source files are
# themselves lossless). ~800-900 kbps, hence off by default. External players
# only — the web player never auto-selects it.
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

log("settings loaded: jingle_ratio=#{jingle_ratio()} crossfade_duration=#{crossfade_duration()} archive_enabled=#{archive_enabled()} archive_bitrate=#{archive_bitrate()} stream_bitrate=#{stream_bitrate()} opus_enabled=#{opus_enabled()} opus_bitrate=#{opus_bitrate()} flac_enabled=#{flac_enabled()} aac_enabled=#{aac_enabled()} aac_bitrate=#{aac_bitrate()} ogg_icy_metadata=#{ogg_icy_metadata()} station_name=#{station_name()}")

# ---------------------------------------------------------------------------
# subhttp:<full-url> — whole-file download via curl. The built-in
# http.get.stream returns spurious 522s on the Cloudflare-fronted Navidrome
# origin.
#
# INVARIANT: a download that curl reports as successful is NOT proof of audio.
# The Subsonic API carries its error code INSIDE the body — Navidrome answers a
# missing file with HTTP 200 and a JSON (or XML) `subsonic-response` blob — so
# the old "curl exited 0 and the file is non-empty" test handed an error page to
# the decoders, which logged the useless `Available decoders cannot decode
# "/tmp/liq-curl-….mp3"`. Request resolution then failed, Liquidsoap dropped the
# request, and the station fell through to the unfiltered auto playlist while the
# controller's queued pick sat `sent:true` for another three tracks (#1405).
# `--fail` alone does NOT cover this (the status is 200); what identifies it is
# the CONTENT TYPE, so ask curl what it actually fetched and refuse anything that
# is not audio — with a log line naming the real cause.
# ---------------------------------------------------------------------------

# Below this a "track" cannot be audio worth airing — a Subsonic error body is a
# few hundred bytes, while 4 KiB of MP3 is about a quarter of a second. Only a
# backstop for an origin that returns an error with no usable content type.
subhttp_min_bytes = 4096

# Per-handoff completion outcomes consumed by the controller over telnet. The
# probe token rides in a URL fragment (never sent to the origin), so a stale
# result for the same song id cannot satisfy a later push. Entries are removed
# when read; controller pushes are deduped and bounded, so this stays tiny.
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

# ---------------------------------------------------------------------------
# QUEUE — the controller writes one annotated track URI to next.txt; polled
# every 1s into request.queue so new tracks land without a restart.
# ---------------------------------------------------------------------------

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

# Measured clip length for a jingle marker, in seconds, or 0. when the file
# cannot be read. The controller can only parse a RIFF header (wavDurationMs),
# and a jingle imported on a host without ffmpeg keeps its ORIGINAL container
# (jingles.importAudio only transcodes when ffmpeg is present) — so an .mp3
# announcement would fall back to a 15s guess and let the DJ talk over the rest
# of it. Liquidsoap can measure anything it can decode, so measure it here and
# ship it in the marker; 0. means "unmeasured" and the controller degrades to
# its own fallback exactly as before.
#
# request.duration decodes a header and RAISES on an unreadable or empty
# filename, so every call is wrapped. Unlike voice_marker the duration cannot be
# computed AFTER the marker (it is part of the payload), which makes this
# try/catch the thing that keeps a raise from costing the marker entirely.
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

# ---------------------------------------------------------------------------
# AUTONOMOUS FALLBACK — the controller maintains auto.m3u with mood-
# appropriate tracks; reload_mode="watch" picks up its rewrites.
# ---------------------------------------------------------------------------

auto_playlist = playlist(
  id="auto",
  reload_mode="watch",
  mode="randomize",
  "#{state_dir}/auto.m3u"
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
# HARD TRACK-LENGTH CAP (#447) — the controller stamps liq_cue_out on autonomous
# picks and auto.m3u entries when a max-track-length is set, so an over-length
# track never airs in full even if it slipped selection with unknown duration.
# Listener requests are deliberately UN-stamped: an explicit ask for a long mix
# isn't cut. Sits BEFORE the music_meta capture (one clean on_metadata event per
# cut track) and before `cross` (the cut end drives a normal crossfade out).
# ---------------------------------------------------------------------------
music = cue_cut(music)

# ---------------------------------------------------------------------------
# CROSSFADE TRANSITION — equal-amplitude blend across the full cross window
# ---------------------------------------------------------------------------
# INVARIANT: fade.out/fade.in span the ENTIRE cross() buffer so the tracks curve
# past each other at ~-6 dB midpoint and sum to ~unity. A fade shorter than the
# buffer leaves the outgoing at full level while the incoming ramps — +6 dB and
# an audible doubling on every transition (earlier per-transition energy scaling
# did exactly that). To vary the blend, vary the cross BUFFER, never the fade
# inside it.
#
# Low-level `cross`, NOT the `crossfade` wrapper: crossfade(smart=false)
# silently routes through its internal simple_transition and ignores a custom
# callback. `a`/`b` are records with .source/.metadata/.db_level.
#
# `cross` sizes this transition's buffer from the OUTGOING track's
# liq_cross_duration stamp (registered at its start, controls its END), so the
# fade must read `a.metadata` too or fade != buffer — a longer fade is truncated
# into an audible gap, a shorter one sums to +6 dB.
def dj_transition(a, b) =
  d = float_of_string(default=crossfade_duration(), a.metadata["liq_cross_duration"])
  # EFFECT ARMING. Every effect is APPLIED to the outgoing branch, but they are
  # flagged on different tracks, and which track carries the flag is the whole
  # reason there is no arming state, no remaining() watcher and no race against
  # a listener request jumping the queue:
  #   * washout + loop ride the ENDING track (`a`) — the flag, the delay tap and
  #     the bar length were stamped on it when it was queued.
  #   * sweep / dissolve / chop ride the INCOMING pick (`b`) — they are chosen
  #     from the PAIR, armed only between clashing tracks (mix.effectAllowedFor).
  # Precedence: a loop beats everything (the loop IS the transition; garnishing
  # it chokes the gesture), then the washout, which may carry the length-cap
  # auto-arm. The queue strips the losers upstream; enforced here too.
  washing = a.metadata["liq_washout"] == "true"
  looping = a.metadata["liq_loop"] == "true" and not washing
  sweeping = b.metadata["liq_sweep"] == "true" and not looping
  dissolving = b.metadata["liq_dissolve"] == "true" and not washing and not looping
  chopping = b.metadata["liq_chop"] == "true" and not washing and not looping
  # FADE SHAPE per effect. The exp fade drops the dry EARLY so the washout's
  # tail reads as a dissolve — that sums below unity mid-cross, a dip, which is
  # the effect (the +6 dB hazard is only for fades that hold full level early).
  # The log fades do the opposite, holding the outgoing hot so that the EFFECT,
  # not the fader, is heard doing the removal: with the default fade the sweep's
  # cutoff arrived over an already-quiet track and felt powerless (on-air), a
  # chopped track must stab at full level like a real crossfader cut. Loop is
  # the exception: it captures the raw outgoing bar, then applies its own
  # complementary ride after the delay cascade. Putting it on this hot fade
  # held the outgoing near unity while the incoming rose and made the start of
  # every loop transition jump in level.
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
  # SWEEP ENVELOPE — how a DJ rides the filter out of a track. Cutoffs move in
  # LOG-frequency space (pow) throughout: linear Hz ramps sound like
  # nothing-then-everything, log space is how a filter knob feels.
  a_source =
    if sweeping then
      log("DJ sweep: closing the filter over the outgoing track (d=#{d}s)")
      sweep_src = a_source
      # Close FAST and DEEP — 9 kHz down to 1.1 kHz over the first 45% of the
      # blend — so the choke arrives while the outgoing is still loud (the log
      # fade above holds its level up). A slower, shallower close spread over
      # 70% was inaudible under the fade.
      def sweep_cut() =
        e = source.elapsed(sweep_src)
        e = if e < 0. then 0. else e end
        t_close = 0.45 * d
        t_hold  = 0.55 * d
        t_back  = 0.85 * d
        # Dive, touch the floor briefly, then PARTIALLY re-open as the incoming
        # takes over: a sustained floor reads as "the track went quiet" (two
        # on-air reports); the outgoing re-emerging under the new one reads as
        # the gesture.
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
      # the incoming is only half-faded, and the mid-blend went near-quiet
      # (twice, by ear). Lift the residual +2.6 dB as the cutoff bottoms out —
      # the choke stays dramatic spectrally without a level hole.
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
      # PARALLEL DRY BLEED — the "never goes quiet" guarantee, and why the
      # stages run full-wet. Wetness on cascaded stages MULTIPLIES the dry path
      # (0.35 × 0.35 ≈ 12% ≈ −18 dB), so every wetness-cap attempt still
      # cratered the mid-band. An explicit dry branch around a full-wet chain
      # gives a hard floor instead: 30% of the untouched track reaches the mix
      # (≈ −10 dB, ≈ −8 dB after makeup) however deep the cutoff dives.
      swept = filter.rc(frequency=sweep_cut, mode="low", wetness=1.,
                filter.rc(frequency=sweep_cut, mode="low", wetness=1., a_source))
      amplify(sweep_gain, add(normalize=false,
        [amplify(0.30, a_source), amplify(0.75, swept)]))
    else
      a_source
    end
  # BLEND (spectral handover) — the continuity move, the sweep's mirror: the
  # OUTGOING track hands its lows and then its mids (by ~65% of the blend) to
  # the incoming, keeping only its highs, while the incoming arrives lows-first
  # underneath (b-side block further down). At every moment the sum reads as ONE
  # full-spectrum piece of music whose ingredients are swapping — club "EQ
  # mixing". Armed only between COMPATIBLE tracks (mix.effectAllowedFor). At
  # e=0 the HPF sits at 30 Hz ≈ transparent, so the engage is seamless.
  blending = b.metadata["liq_blend"] == "true" and not looping
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
      # SUBTRACT-HPF: filter.rc mode="high" is BROKEN — a static 400 Hz
      # high-pass collapses music to −115 dB on v2.2.5, and a 40 Hz HPF on a
      # 440 Hz tone renders −inf silence on v2.4.4 (same defect family as the
      # `echo` no-op). So the high-pass is built from proven parts:
      # dry − lowpass(dry). Polarity inversion and twin-consumer frame
      # alignment are verified — src + amplify(-1., src) renders exact silence.
      blend_low = filter.rc(frequency=blend_hp, mode="low", wetness=1., a_source)
      add(normalize=false, [a_source, amplify(-1., blend_low)])
    else
      a_source
    end
  # WASHOUT ENVELOPE — dub-style tail. The comb feedback swells while the exp
  # fade above pulls the dry away, so the delay line self-sustains and the track
  # dissolves into a pulsing, decaying tail over the incoming track's opening
  # rather than echo layered on a still-full-level song. The tail must be dead
  # before the transition source truncates at d, or it clicks off.
  # Tap length (liq_washout_delay) is stamped by the controller, tempo-synced to
  # a dotted eighth of the track's BPM.
  a_source =
    if washing then
      wd = float_of_string(default=0.30, a.metadata["liq_washout_delay"])
      log("DJ washout: dissolving the outgoing track, tap=#{wd}s (d=#{d}s)")
      wash_src = a_source
      # The swell must beat the exp fade — the loop only ever holds what it was
      # fed while the dry was still hot, and swelling at 25% seeded the tail
      # from an already-faded signal (on-air: the wash was inaudible). Buildup
      # is bounded anyway: the exp fade starves the input within a couple of
      # seconds, and the brick-wall limiter backs the bus.
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
      # Late makeup so the tail sits PRESENT over the incoming track's fade-in
      # instead of buried under it (on-air: the dissolve was correct but too
      # quiet to register). It comes up only after the exp fade has dropped the
      # dry, so it lifts the echoes alone and never bumps the still-audible song.
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
      # Darkening tail — a real dub delay feeds back through a filter so every
      # repeat returns darker. The comb's loop is fixed, so a lowpass AFTER it
      # closes across the window instead (9 kHz → 3 kHz): later repeats occur
      # later in time, so they arrive darker and the tail recedes rather than
      # ringing at full brightness. Wet has to ramp in — an RC at 9 kHz is not
      # transparent, and engaging it full-wet would dull the still-audible dry.
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
  # DISSOLVE ENVELOPE — the reverb wash. Same topology as the washout (comb →
  # cascaded damped lowpass → late makeup) with two deliberate differences:
  #   1. FOUR parallel combs at mutually prime, tempo-UNRELATED delays
  #      (89/113/151/181 ms) instead of one tempo-synced tap, so the tails smear
  #      into diffuse ambience instead of a rhythmic pulse. No allpass exists in
  #      the proven kit, so diffusion comes from the prime spread plus heavy
  #      damping; the wash also sits UNDER the rising pick, which hides the
  #      metallic edge an exposed Schroeder cluster has.
  #   2. The damping lowpass closes deeper (7 kHz → 1.2 kHz) — the wash reads as
  #      the track receding into a large dark space, not echoing in place.
  # Each comb's tail is isolated from its dry pass-through (pure_tail below) so
  # the wash can run hot without multiplying the dry path.
  a_source =
    if dissolving then
      log("DJ dissolve: reverb wash under the next track (d=#{d}s)")
      diss_src = a_source
      def diss_fb() =
        e = source.elapsed(diss_src)
        e = if e < 0. then 0. else e end
        # Per-tap dB. Tail decay is fb/delay per SECOND, so short taps need
        # near-unity feedback: -0.5 dB on 89–181 ms taps ≈ 3–6 dB/s, a
        # multi-second wash. The first cut (-2.5 dB on 43–101 ms taps) decayed
        # 25–58 dB/s and rendered indistinguishable from dry.
        fb_max = -0.5
        fb_off = -90.0
        # Swell must beat the exp fade — the washout's on-air lesson.
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
      # Late makeup, same rationale as the washout: lift the wash alone once the
      # exp fade has dropped the dry, so the ambience sits present over the
      # incoming track instead of buried. Reads lower than the washout's figure
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
      # Darkening: later reflections arrive later in time, so a lowpass closing
      # across the window makes the wash recede into the dark. Wet ramps in
      # rather than engaging at cross start, same reason as the washout's.
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
      # combs directly forces a 0.25 weight to keep the dry at unity — which
      # buries the tails 12 dB down before they start (first render: a −44 dB
      # mid-cross crater, wash inaudible). Subtracting the input from each comb
      # leaves ONLY the feedback tail, so the dry rides the faded path once and
      # the tails run hot.
      def pure_tail(tap) =
        add(normalize=false,
          [comb(delay=tap, feedback=diss_fb, a_source), amplify(-1., a_source)])
      end
      washed = add(normalize=false,
        [amplify(0.7, pure_tail(0.089)), amplify(0.7, pure_tail(0.113)),
         amplify(0.7, pure_tail(0.151)), amplify(0.7, pure_tail(0.181))])
      washed = filter.rc(frequency=diss_cut, mode="low", wetness=diss_wet,
                 filter.rc(frequency=diss_cut, mode="low", wetness=diss_wet, washed))
      # Dry (faded) + wash: the track walks out through its own ambience.
      add(normalize=false, [a_source, amplify(diss_gain, washed)])
    else
      a_source
    end
  # CHOP ENVELOPE — the crossfader cut: rhythmic gating of the outgoing track,
  # opening AT each beat start so the downbeat transient survives. Pure
  # `amplify` over source.elapsed(), so no new operator class and no
  # fx-render-test re-probe. Runs on its own compressed clock dd = min(d, 10 s):
  # stretched over a long crossfade the cut read as slow pumping (on-air, #861).
  # Four envelopes ride that clock:
  #   * RATE accelerates like a transform cut, quarters → eighths → sixteenth
  #     stutter. The divisions are p/2 and p/4, so every beat start stays a
  #     gate-open. The accelerando IS the exit — isolated late stabs read as
  #     slowing down, the wrong direction for a cut.
  #   * DUTY tightens, and the FLOOR under the closed gate drops to silence
  #     only after the first quarter: the opening holes read as beat-synced
  #     pumping and then harden, where full silence between the very first
  #     stabs read as dropouts.
  #   * WET ramps the whole gesture in, so gain is exactly 1 at e=0.
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
        # Master release — the throw. The rest of the buffer belongs to the
        # incoming ramp.
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
  # LOOP ENVELOPE — exit loop: the last bar of the OUTGOING track is caught
  # in a loop as the dry is hard-cut, rides in tempo under the pick, then
  # filters down and releases.
  #
  # Measured comb facts (burst-probed on the real v2.4.5 image, PR #863): this
  # build's `comb` is a ONE-SHOT feed-forward echo, NOT recirculating — one
  # burst in yields exactly one delayed copy whatever the feedback value, so no
  # single comb can loop. Hence a CASCADE OF DOUBLING DELAYS: K combs at bar,
  # 2·bar, 4·bar, 8·bar convolve to taps at every multiple 0..(2^K−1) of bar, so
  # a one-bar capture tiles gaplessly — no overlap, no pileup — and terminates
  # by construction. At feedback=0.0 the tap set measures flat at a fixed −6 dB
  # whatever the stage count, so one constant ×2 makeup restores unity. The
  # later stages are built only when their delay < d, since a tap at ≥ d is
  # never heard.
  #
  # Known compromise: the analyzer gives tempo, not beat PHASE, so this lands as
  # a tape-loop rather than a gridded serato loop. The splice tick repeats in
  # tempo (reads as vinyl) and the ride-out lowpass softens it.
  a_source =
    if looping then
      bar = float_of_string(default=2.0, a.metadata["liq_loop_bar"])
      bar = if bar <= 0.2 then 2.0 else bar end
      log("DJ loop: catching the last bar of the outgoing track (bar=#{bar}s, d=#{d}s)")
      loop_src = a_source
      # Dry gate: unity through the capture pass, then the hard cut.
      # Everything heard after is the cascade re-emitting that one bar.
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
      # Ride-out darkening — a DJ filters the loop down as the new track takes
      # over: the cutoff closes 9 kHz → 2.5 kHz over the back half. Wet stays 0
      # through the capture pass and ramps in only after the cut, because the
      # still-audible dry passes through this chain too.
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
      # Complementary ride — the loop is built from the raw capture so every
      # repeated bar has a stable internal level, then this outer envelope gives
      # back headroom as the incoming track rises. Previously the log-faded
      # outgoing stayed hot through the capture pass while the incoming rose
      # underneath it, producing the audible level jump unique to Loop.
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
      # feedback=0.0 emits each delayed copy at 0 dB. Because the dry gate keeps
      # exactly one bar and the delays double, those copies occupy non-overlapping
      # bar slots at unity. Global makeup would double the direct capture pass
      # before any delayed copy exists, recreating the transition-entry jump.
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
  # has to be bit-clean before then.
  #
  # BLEND, incoming side: the pick arrives lows-first — a lowpass opens
  # 250 Hz → 9 kHz as the outgoing HPF climbs, so the two trade the spectrum in
  # complementary bands.
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
  # SWEEP, incoming side — two real-DJ moves, both fully out well before the
  # outgoing track is gone. SURFACING: the pick materialises from far away as a
  # lowpass opens 500 Hz → 9 kHz while the old track still dominates (the v1
  # mistake was a muffle that outlived the transition — opening fast and early
  # keeps the "approaching" feel without the broken-sounding landing). Then the
  # BASS SWAP below.
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
      # across the long blend, then release it and the bass lands like a small
      # drop, the most professional-sounding instant of the move. It releases
      # earlier than a club bass-swap would: with both tracks processed, the
      # middle of the blend went near-silent. Built as a SUBTRACT-HPF (mode
      # "high" is broken — see the blend block; leaving it in was what silenced
      # the whole incoming track and caused the mid-blend dropouts): subtract
      # the track's own <160 Hz content, then ease that subtraction to zero.
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

# The PRE-cross handle, for the on_metadata hook attached further down (where
# on_meta is defined). Hooking the post-cross source fires TWICE per transition
# — dj_transition's fade.in/fade.out both pass initial_metadata= and the
# outgoing track wins, stranding the UI one song behind until the next
# crossfade. It is also what the starve guard samples.
music_meta = music

# Hard ceiling on how far ahead voice_marker may push voice_until (declared at
# the top of the file with the other live gates). The gate fails toward SERVING
# jingles, deliberately: a measured duration that comes back
# wrong (corrupt header, a filename that resolved to some other media) would
# otherwise silence the rotate for as long as that number says, and unlike the
# collision the gate fixes, that failure is inaudible — nothing in the log says
# why the stingers stopped.
VOICE_GATE_MAX_SEC = 120.

# Two things this gate deliberately does NOT do:
#
#   - It arms at the clip's on_metadata, i.e. after the 0.5s say.txt poll and the
#     silent lead-in. waitForJingleClear (voice-io.ts) covers a jingle already
#     handed out when the controller writes say.txt; a jingle handed to the rotate
#     inside that ~1s seam is covered by neither side. Arming optimistically at
#     handoff would close it, but the controller has no channel to Liquidsoap
#     other than the handoff files themselves — it would need a new one, for a
#     window narrower than the poll that creates it.
#   - intro_queue arms it too, not just voice_queue. A talk-over link is written
#     for the INCOMING song, so if the rotate served a stinger at that seam the
#     link would talk over the stinger instead — same collision, quieter. The
#     cost is that links land on the rotate's decision point by construction, so
#     a chatty persona (speech every 1-5 tracks) will skip some jingles and run
#     slightly under the configured ratio. Skipping a jingle is the cheaper miss.

# JINGLES & STATION ID — rotate a jingle in every N tracks.
#
# CRITICAL: this rotate MUST sit here, on the raw pre-cross / pre-duck music
# source. `rotate` is track_sensitive and only advances at a track boundary of
# the source it is playing, and `cross` and the `smooth_add` layers present
# their output as ONE never-ending track — so a rotate above them plays a single
# jingle at startup and is then stuck on music forever ("jingles only fire once
# per restart"). music_meta is captured ABOVE this, so jingles never show up in
# now-playing. An empty jingles.m3u is fine: rotate skips an unavailable source.
# jingle_ratio 0 = jingles OFF (#997) — the rotate isn't built at all.
music =
  if jingle_ratio() > 0 then
    jingles = playlist(
      id="jingles",
      mode="randomize",
      reload_mode="watch",
      "#{state_dir}/jingles.m3u"
    )
    # Announce each jingle to the controller. Jingles are otherwise invisible to
    # it (music_meta is captured above this rotate) and play outside its
    # airVoice serialiser, so a TTS segment aired at the incoming track's
    # boundary could talk over the stinger (#997). Written at FEED time — the
    # jingle turns audible ~crossfade_duration later — and the controller holds
    # its voice chain until start + crossfade + clip length has passed.
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
    # A bed on air makes jingles unavailable (bed_on_air above) so the rotate
    # can't split a bed from the song it ramps into; a voice clip on air does
    # the same so a stinger can't be handed over the DJ (voice_until above); and
    # a starved music chain does the same so the rotate can't serve stingers
    # forever over dead air (see the MUSIC STARVE GUARD below).
    jingles = source.available(jingles, {
      not bed_on_air() and not jingle_now_on_air() and
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
  not bed_on_air() and time() > voice_until()
})
music = fallback(
  id="music_with_jingle_now",
  track_sensitive=true,
  [jingle_now, music]
)

# Per-track loudness normalisation, the ReplayGain mechanism: the controller
# stamps `liq_amplify` ("<n> dB") on any track with a measured LUFS. BEFORE the
# cross, so each track carries its own gain into the crossfade, and AFTER the
# music_meta capture. The bus itself stays limiter-only.
music = amplify(override="liq_amplify", 1., music)

# persist_override=true (2.4): with the new default the liq_cross_duration
# override is reset before it ever sizes the stamped track's own end-of-track
# buffer (fx-render-test.sh xdur: a stamped 12 rendered 86s — the static buffer
# — without persist, 78s with it). Persist restores the 2.2.5 sizing. Its flip
# side is that a stamp lingers over later UNstamped tracks, so the controller
# stamps every track it annotates (subsonic.getAnnotatedUri falls back to the
# operator's crossfade setting) and the lingering value is always the intended
# one.
music = cross(
  duration=crossfade_duration(),
  persist_override=true,
  dj_transition,
  music
)

# ---------------------------------------------------------------------------
# DJ VOICE — TTS clips dropped as paths into say.txt / intro.txt.
# voice_queue = solo voice (heavy duck: station IDs, hourly, request
# back-announce); intro_queue = talk-over links (light duck, the song stays
# audible underneath).
# ---------------------------------------------------------------------------
voice_queue = request.queue(id="voice_queue")
intro_queue = request.queue(id="intro_queue")

# AIR-TIME MARKER (#1382) — the controller learns everything else about a
# spoken segment at HANDOFF time (it wrote the path into say.txt/intro.txt), and
# that is 0.5s of poll plus the queue and the duck ramp before a listener hears
# a word. Every signal keyed off that moment — the booth log, the dj.say/dj.link
# webhook, the player's own line — therefore ran ahead of the stream.
#
# on_metadata fires as the clip starts feeding, so `startedAt` here IS the
# live-edge moment the words begin (the same clock now-playing.json is stamped
# on). The controller matches it back to the segment via `subwave_voice`, the id
# it stamped into the clip's annotate: URI — which also filters out the silent
# lead-in, pushed as its own un-annotated request just before every clip.
#
# Same shape and rationale as jingle-playing.json (#997) and bed-playing.json:
# one marker file, never deleted, deduped by the controller on a value it
# carries rather than on the file's existence.
def voice_marker(channel, tmp_dir) =
  fun (m) ->
    begin
      voice_id = m["subwave_voice"]
      if voice_id != "" then
        # ONE clock read for both jobs, taken before either. `startedAt` is the
        # live-edge stamp the controller treats as the moment the words begin
        # (#1382) — re-reading time() after the work below would skew it by
        # however long that work took.
        now = time()
        fname = m["filename"]

        # The marker goes out FIRST. Arming the jingle gate needs request.duration,
        # which decodes a header and can raise on an unreadable/empty filename; if
        # that ran first, a raise would cost the marker entirely, and because the
        # file is never deleted awaitVoiceAir would not degrade instantly — it
        # would burn its full 20s timeout against the PREVIOUS clip's voiceId.
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

        # Arm the jingle gate (see voice_until above). request.duration is
        # documented as expensive, but this hook is synchronous=false and so runs
        # off the streaming thread. Two bounds, because an over-long deadline
        # silently starves the rotate with nothing in the log to explain it: the
        # 30s fallback covers a clip that cannot be measured at all, and the cap
        # covers one that measures WRONG (corrupt header, or a filename that
        # resolved to some other media). No script is a legitimate two minutes.
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

# synchronous=false: this does file I/O and must not sit on the streaming
# thread — the same reason on_meta is registered that way.
voice_queue.on_metadata(synchronous=false, voice_marker("say", voice_tmp_dir))
intro_queue.on_metadata(synchronous=false, voice_marker("intro", intro_tmp_dir))

# Sound-effects channel — short pre-rendered stingers the DJ agent plays UNDER
# its voice, path written into sfx.txt (broadcast/sfx.js + queue.playSfx). Not
# mic-chained: the audio is already produced.
sfx_queue = request.queue(id="sfx_queue")

# Silent lead-in clip, pushed immediately before each speech file: smooth_add
# ducks over the silence so the dip completes BEFORE the DJ's first word.
# request.queue plays the two pushes gaplessly, so the duck holds across the
# join.
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

# ---------------------------------------------------------------------------
# MIC CHAIN — broadcast-style processing on both voice channels (numbers
# tuned for an en_GB-alan-medium-ish voice).
# ---------------------------------------------------------------------------
# A FUNCTION, not a shared chain variable, so each call instantiates fresh
# operator nodes — reuse hits "Early computation of source content-type". An
# 80 Hz HPF + 3 kHz presence shelf are missing for the same error on
# request.queue sources; revisit on an engine upgrade or LADSPA.
def mic_chain(s) =
  # Fast attack, gentle ratio: tames the TTS peaks and brings the body of the
  # voice forward without pumping.
  s = compress(
    attack=5.0,
    release=120.0,
    threshold=-18.0,
    ratio=4.0,
    knee=2.0,
    gain=7.0,
    s
  )
  # Makeup on top of the compressor, so the voice sits clearly above the ducked
  # music bed.
  s = amplify(1.4, s)
  # NB: a ~40 ms slap echo for "studio room" used to sit here. Combined with the
  # compressor's makeup gain it lifted the TTS noise floor in silent passages
  # and smeared it into an audible wash behind spoken station IDs, so the voice
  # is intentionally dry now.
  s
end

# Edge fade-IN per clip: some engines cut the audio hard at the boundary and the
# compressor's makeup gain turns that edge into an audible tick. Runs BEFORE
# amplify/mic_chain so the compressor never sees the raw edge, and it is short
# enough not to soften the first word.
#
# fade.in ONLY — on a request.queue source this build doesn't know the remaining
# time, so fade.out treats the WHOLE clip as inside the fade zone and multiplies
# it to silence (verified: every segment aired as dead air). Tail clicks have to
# be faded at WAV-render time instead.
def edge_fade(s) =
  fade.in(duration=0.04, s)
end

# Per-segment voice trim: the controller stamps `liq_amplify` per spoken clip
# (settings.tts.gainDb + audio/tts.ts:voiceGainDb), the same mechanism as the
# music bus. BEFORE mic_chain so the fixed-threshold compressor sees a levelled
# input; the un-annotated lead-in plays at unity.
voice = mic_chain(amplify(override="liq_amplify", 1., edge_fade(voice_queue)))
intro = mic_chain(amplify(override="liq_amplify", 1., edge_fade(intro_queue)))

# ---------------------------------------------------------------------------
# SAFETY — fall back to the emergency loop when the music chain dies
# ---------------------------------------------------------------------------
# The real dead-air guard: `emergency` is an always-ready, non-silent single, so
# the broadcast never has nothing to pull.
#
# POSITION IS LOAD-BEARING (#1300 bug 7). It MUST stay ABOVE the studio-bed
# `add` below AND the three `smooth_add` ducking layers below that — the same
# trap wearing two hats. `add` is ready whenever ANY input is, so anything mixed
# into the music chain makes that chain look alive while the music is starved,
# and a fallback below the mix can only ever select index 0:
#   * the bed is `mksafe(single(...))`, and `mksafe` makes it INFALLIBLE;
#   * the stdlib builds smooth_add as
#       add(normalize=false, [normal, fallback(track_sensitive=false, [special, blank()])])
#     whose inner fallback falls through to `blank()`, so the special leg is
#     always ready regardless of `normal`.
# This guard sat at the bottom of the chain for its whole life and was dead code
# the entire time. Nobody noticed because the failure it guards also needs the
# jingle rotate silenced, and the rotate had been masking every starve — so when
# the starve guard started gating jingles off, "stingers forever" became digital
# silence forever. Measured on subwave-aio-heavy: -91.0 dB with the fallback
# down there, -3.0 dB with it up here, i.e. the loop actually airs.
#
# It also has to stay BELOW `music_meta` and the jingle rotate so now-playing
# metadata and jingle counting are untouched; being above the ducking is what
# lets the DJ talk over the emergency loop exactly as over music.
#
# The fade-in on the emergency branch is NOT a debounce and must never become
# one. `track_sensitive=false` switches the instant `music` reports not-ready,
# and now that it can actually fire it also fires on brief REAL gaps: a cold
# boot before auto.m3u resolves (a ~100-200ms stab of the loop at mixer start)
# and the odd track seam where dj_queue and auto_playlist are momentarily both
# unready (auto_playlist entries are whole-file `subhttp:` downloads, so a slow
# Navidrome widens that window). Delaying the switch is the WRONG fix — a
# dead-air guard that waits before firing is a guard that doesn't fire, exactly
# the bug class repaired above. Fire immediately and ramp the LEVEL instead: a
# sub-second stab stays inaudible, a genuine starve is at full level in about a
# second, and the timing is untouched. The music branch keeps the stdlib
# identity transition, because coming BACK must be instant — a recovered station
# fading up over its own first second of music is a second bug.
#
# It takes BOTH fades below to cover boot and every later switch; don't delete
# either. `transitions` fires only when switching FROM one child TO another, and
# `switch` applies NO transition to its FIRST selection — measured on 2.4.5, the
# log reads "Switch to emergency." at boot and "…with transition." every time
# after — and boot is precisely that first selection. So `emergency` carries a
# one-shot fade of its own, whose default track_sensitive=false memoises the
# ramp to the source's first frame EVER: right for the cold boot, useless later,
# since a looping single never reaches a fresh track boundary. The two compose —
# at boot the child's fade ramps; on every later switch the transition wraps a
# fresh ramp around an inner fade already sitting at unity.
#
# Measured after the fix (100 ms RMS windows): boot -38.5 -> -9.0 dB over 1.0s;
# mid-run starve -32.6 -> -9.0 dB over 1.0s; recovery a single-window step back
# to music with no ramp; unchanged after 43 switches in one process.
EMERGENCY_FADE_SEC = 1.0
emergency = single("/sounds/emergency.mp3")
# The `: source` casts drop fade.in's extra methods, which otherwise refuse to
# unify with the plain source the identity transition and the `music` child are
# — a type error, not a style choice.
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

# ---------------------------------------------------------------------------
# STUDIO BED — low-level room tone, mixed in BEFORE voice ducking so
# smooth_add ducks it with the music (otherwise it competes with the voice).
# ---------------------------------------------------------------------------

bed_path = "/sounds/bed.mp3"

# Disabled — the looping ambient bed was audible under the DJ's voice during
# links. Flip back to `true` to restore it.
#
# Flipping it is safe for the dead-air guard ONLY because the guard sits ABOVE
# this block, on `music`. `mksafe` below makes the bed infallible, so this `add`
# is permanently ready: build the guard from `music_bus` instead and turning
# this flag on silently disarms it (#1300 bug 7).
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
# signal; three stacked layers because each channel ducks to a different depth.
#
# Gated, NOT RMS-keyed: an earlier RMS sidechain follower drove the music bus to
# -91 dB even with voice_queue empty (git f38a9af). smooth_add cares only
# whether the channel has signal — the talkbax model. Quiet phrases get the same
# duck as loud ones, which is fine on a single-tenant station.
#
# `duration` is the fade into and out of the duck. It can be gentle on the voice
# layers because each gets a silent lead-in clip pushed ahead of the speech (see
# poll_voice / poll_intro), so the dip completes BEFORE the DJ's first word.

ducked = smooth_add(
  duration=0.8,
  p={0.22},         # heavy duck: music drops to ~-13 dB under solo voice
  normal=music_bus,
  special=voice
)

# Light duck on top for talk-over links — leaves the song audible underneath.
radio = smooth_add(
  duration=0.8,
  p={0.30},         # ~-10 dB
  normal=ducked,
  special=intro
)

# SFX on top. A stinger rides BENEATH both the DJ and the music rather than
# replacing either, so it barely ducks; its own level and p are the two knobs.
sfx_bed = amplify(0.7, sfx_queue)
radio = smooth_add(
  duration=0.3,     # snappier than voice — stingers are short, no lead-in clip
  p={0.7},          # ~-3 dB
  normal=radio,
  special=sfx_bed
)

# NOTE: neither the jingle rotate nor the emergency dead-air fallback can sit
# here, and both used to. See the JINGLES and SAFETY blocks above for why. Do
# not add a second fallback down here "for safety": one that LOOKS like a
# dead-air guard but structurally cannot fire is what caused #1300 bug 7.

# ---------------------------------------------------------------------------
# IDLE GATE — silence the programme while nobody is listening
# ---------------------------------------------------------------------------
# The controller flips idle_mode over telnet (idle_on/idle_off): the switch
# selects blank() and the whole chain above stops being pulled, frozen
# mid-track. Mounts STAY UP serving silence, so clients connect normally and
# playback resumes exactly where it froze once the controller's next poll sees a
# listener — contrast stream_off, which tears the mounts down. A plain blank()
# is safe; the #660 CPU spin was specific to blank.skip. Not persisted: a mixer
# restart always comes back live and the controller re-asserts idle if the room
# is still empty.
idle_mode = ref(false)
radio = switch(
  id="idle_gate",
  track_sensitive=false,
  [({idle_mode()}, blank(id="idle_silence")), ({true}, radio)]
)

# NOTE: blank.skip was REMOVED here (#660). With no music in the chain (fresh
# install, Navidrome down, playlist exhausted) it busy-loops at ~100% CPU and
# starves Icecast (/stream.mp3 404s) — measured in ANY position, so reordering
# doesn't help. The emergency single already covers a dead source.

# ---------------------------------------------------------------------------
# MUSIC STARVE GUARD (#1300 bug 7)
# ---------------------------------------------------------------------------
# `rotate` skips unavailable sources, so with the music chain starved (Navidrome
# unreachable, auto.m3u empty or exhausted) the jingle rotate above serves
# stingers back to back forever — and the `emergency` fallback CANNOT see it,
# because `radio` is still available: it is producing jingles. Measured on 2.4.5
# with an empty auto.m3u: music_ready=false, jingles_ready=true,
# radio_ready=true. That is the bug in one line.
#
# So sample the PRE-rotate chain (music_meta, the same handle on_metadata uses)
# and, once it has been starved for a sustained window, make jingles
# unavailable. The rotate empties, `radio` goes unavailable, and the emergency
# single fires as it was always meant to.
#
# The window is not just a false-positive guard, it IS the "a jingle may cover a
# brief hiccup" behaviour: the chain is legitimately not-ready at a track
# boundary while a request resolves (the controller bounds that at
# SKIP_COMMIT_WAIT_MS = 20s), so a blip is still papered over by a stinger and
# only a sustained outage escalates. Recovery is unconditional — any tick that
# sees the source ready clears the latch.
#
# Suppressed while the idle gate holds the programme frozen for an empty room:
# "the music source is starved" is not a meaningful claim about a station nobody
# is listening to. Entering idle clears the latch outright, so the first
# listener back gets a fresh window rather than a stale verdict.
STARVE_GRACE_SEC = 30.0
STARVE_SAMPLE_SEC = 1.0

# The heartbeat refreshes `at` while the outage lasts, and deliberately does NOT
# run at the sample rate: the consumer only asks that the marker be younger than
# STARVE_MARKER_STALE_MS (60s, controller/src/broadcast/music-starve-pure.ts).
# At 1.0s that would be ~3,600 atomic rewrites an hour — ~28,800 over an
# eight-hour overnight outage — on a state dir that is typically a bind mount
# and is sometimes an SD card or a spinning array. 10s keeps a 6x margin on the
# stale threshold. EDGE writes (latch, recovery, startup) stay immediate: they
# change the state, so the operator UI should see them on the next poll.
STARVE_HEARTBEAT_SEC = 10.0

starved_for = ref(0.0)
starved_since = ref(0.0)
last_marker_write = ref(0.0)

# NEVER let this raise. An uncaught exception inside a thread.run callback kills
# that thread PERMANENTLY, freezing the guard at whatever it last latched —
# worst case the emergency loop forever with no path back. Observed while
# developing this (an EACCES on the write killed the tick outright), and the
# realistic trigger is the same unwritable state mount ensure_tmp_dir already
# defends against. Reporting must not share a failure domain with the guard.
def write_starve_marker(starved, since) =
  # Stamped for EVERY write, edge or heartbeat, so an edge write restarts the
  # heartbeat window instead of being followed by a redundant one a second
  # later. Set before the write so a throwing write still spaces out retries.
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
      # left behind by a mixer that died mid-outage.
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

# ---------------------------------------------------------------------------
# BROADCAST BUS — masters preserved; the brick-wall limiter is the ONLY
# processing. A -14 LUFS normaliser, stereo widener and bus compressor were all
# removed, each having audibly reshaped the masters. The limiter stays because
# MP3 encoding generates inter-sample peaks ~0.5-1 dB over the source, so modern
# masters (~-0.3 dBFS TP) would clip listeners' decoders without a -1 dBFS
# ceiling. Typically 0 dB of reduction — a safety net, not a tone tool.
# ---------------------------------------------------------------------------

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
# METADATA — ICY title driven explicitly from the pre-cross on_meta hook so
# it matches now-playing.json. BOTH operators are load-bearing:
#  1. metadata.map strip — kills ALL metadata still flowing through the
#     chain. dj_transition's fades pass initial_metadata=, so ~crossfade
#     seconds after on_meta fires the cross re-emits the OUTGOING track's
#     metadata, which would reach output.icecast and clobber the title back
#     (Icecast frozen one track behind).
#  2. insert_metadata — after the strip, the ONLY source of stream metadata,
#     pushed from on_meta.
# ---------------------------------------------------------------------------
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
  # carries no title/artist, so the gate below would drop it silently — and that
  # silence is the problem, because the controller learns "bed on air, air the
  # link now" only from this marker. Hence the branch BEFORE the gate. Same
  # shape and rationale as jingle-playing.json (#997).
  if m["subwave_kind"] == "bed" then
    jingle_now_on_air := false
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
    jingle_now_on_air := false
    log("on_meta: title=#{title} | artist=#{artist} | album=#{album} | id=#{subsonic_id}")
    ts = int_of_float(time())
    # json.stringify, not interpolation: titles with embedded quotes or
    # backslashes produced invalid JSON the UI couldn't parse.
    payload = json.stringify(compact=true, {
      title = title,
      artist = artist,
      album = album,
      subsonic_id = subsonic_id,
      filename = filename,
      timestamp = ts
    })
    # atomic=true — the controller re-reads this file every 1.5s and per
    # /now-playing request, and its reader treats ANY parse failure as null, so
    # an in-place truncate-then-write let a half-written JSON blank the
    # now-playing data for a tick. temp_dir keeps the rename on the state fs
    # (#1240 — see ensure_tmp_dir).
    file.write(data=payload, atomic=true, temp_dir=np_tmp_dir, "#{state_dir}/now-playing.json")
    # Same metadata onto the Icecast stream, so the ICY title tracks the current
    # song instead of lagging a transition behind.
    radio.insert_metadata([
      ("title", title),
      ("artist", artist),
      ("album", album)
    ])
  else
    # Untitled, non-bed metadata (the emergency single, an untagged local
    # file). Nothing to publish, but it still marks the bed's end — without this
    # reset bed_on_air would latch true and keep the jingle rotate starved until
    # the next tagged song.
    bed_on_air := false
    jingle_now_on_air := false
  end
end

# Attached to `music_meta`, the PRE-cross handle captured before the cross wrap
# (see there for why post-cross fires twice). on_metadata rather than on_track,
# because on_track gets swallowed by source switches (request queue → auto
# playlist). synchronous=false: on_meta does file I/O, so run it on the task
# queue, not the streaming thread.
music_meta.on_metadata(synchronous=false, on_meta)

# ---------------------------------------------------------------------------
# OUTPUT — broadcast to Icecast
# ---------------------------------------------------------------------------

# Stream on/off control. Icecast outputs can't pause, but they can be shut down
# and recreated (the dynamic-sources pattern): stream_off disconnects every
# mount and stops the hourly archive, stream_on recreates them. force_start is
# what lets a recreated output start after init. State lives in refs, read back
# over telnet; NOT persisted — a mixer restart always comes back on air.
#
# /stream.mp3 is the universal floor and always serves. Its default bitrate is
# 192, not 128: dense brick-walled masters produced audible encode grain
# ("swishy static") at 128. The other mounts are opt-in (toggles at the top);
# per-listener bandwidth is per-mount, so an unused mount costs nothing.
settings.init.force_start := true

# TEMPORARY (re-harden later): allow running as root. The broadcast entrypoint
# currently launches liquidsoap as root (not the privilege-dropped `liquidsoap`
# user) because the 2.4.4 base image changed that user's uid and made the
# persisted state files unwritable — see docker/broadcast-entrypoint.sh. Without
# this, liquidsoap refuses to start under a root euid. Revert together with the
# entrypoint once the state files are re-chowned to the liquidsoap uid.
settings.init.allow_root := true

# Hourly archive path. The `{...}` wrapper makes it a GETTER, so strftime re-runs
# each time output.file reopens; a bare string skips strftime entirely and
# writes everything to one literal "%Y-%m-%d/%H-00.mp3" file that gets truncated
# at the top of each hour.
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
  # Opus mandates 48 kHz internally, so this mount also costs a resample from
  # the 44.1 kHz source bus. application="audio" is the music tuning (vs "voip"
  # / "lowdelay"), and 96 kbps is the music-transparent default. When off, the
  # encoder and resample are never built and the shutdown is a no-op.
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
        # guesses ICY off for Ogg containers and relies on in-band chained-Ogg
        # re-emission, but many radio clients (Ferrosonic, Cast, Symfonium) read
        # the Ogg comment once at connect and freeze on the first title (#1052)
        # — while foobar2000 parses the in-band tags correctly and the ICY
        # channel breaks its Ogg-FLAC metadata. No single value suits both
        # camps, hence the toggle.
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
  # %flac. No resample. Lossless, so no bitrate to pick: compression=5 is the
  # FLAC default (CPU/size balance) and 16-bit is CD-quality and universally
  # decodable.
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
  # AAC-LC over Icecast as raw ADTS — broadly decodable by players and hardware
  # that lack Opus. afterburner=true trades a little CPU for better quality; no
  # resample; format="audio/aac" pins the mount's advertised MIME so streaming
  # clients recognise the ADTS stream.
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
  # Hourly archive. A second MP3 encoder running 24/7 is the single biggest CPU
  # cost in the broadcast container, so the whole output is guarded and
  # operators who don't use the archives never pay for it. Built in here rather
  # than standalone so it follows the on-air lifecycle: off air stops the
  # recording too, where before it kept writing hourly files of the emergency
  # loop.
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
    # Drop now-playing.json so the UI stops advertising the last track that
    # played — the controller reads a missing file as "nothing playing".
    # on_meta rewrites it once we're back on air and the next track fires.
    if file.exists("#{state_dir}/now-playing.json") then
      file.remove("#{state_dir}/now-playing.json")
    end
  end
end

# On air at startup, hourly archive included.
stream_up()

# ---------------------------------------------------------------------------
# CONTROL — telnet commands, all operator-only, driven by the controller.
# ---------------------------------------------------------------------------
# `restart` is how every liquidsoap_*.txt setting takes effect: shut down, and
# the container restart-policy brings us back ~3s later with the new values
# applied at the top of this script.
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

# Pause / resume while keeping the mounts up (the idle gate above), driven by
# the controller's stream-idle monitor. Idempotent and logs only on a state
# change, so the controller can re-assert cheaply after a restart.
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
# waiting, so the fallback will pick it), "resolving" (pushed but still
# downloading, so a skip now falls through to auto.m3u), or "empty". The
# controller polls this before issuing `skip` so an operator skip airs the
# committed pick rather than a random auto.m3u fill (#1300 bug 6). A request
# already popped for boundary prefetch is in neither state — the same blind spot
# dj_queue_remove documents — and reads as "empty", which the caller treats as
# keep-waiting, never as proof of an idle queue.
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
      # Removal MUST go through the stdlib's remove(). The old filter +
      # set_queue(kept) rebuild looked equivalent, but set_queue() FLUSHES
      # request.dynamic's inner queue wholesale — and a request already popped
      # for prefetch at a track boundary is in NEITHER visible list while its
      # download runs, so the flush orphaned it (cancelling rids 32+33 silently
      # killed resolving rid 31; observed live, twice).
      list.iter(fun(r) -> dj_queue.remove(r), matches)
      # Release the dropped request's file/URI now, rather than leaving it until
      # Liquidsoap flags it as leaked.
      list.iter(fun(r) -> request.destroy(r), matches)
      log("Removed request #{rid} from dj_queue via server command")
      "OK"
    end
  end
)
