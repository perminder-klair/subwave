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

# DJ transition effects (filter sweep + echo washout + reverb dissolve + beat
# chop + exit loop) — see dj_transition
# below. The effects are built PER-BRANCH inside the transition callback, on
# the OUTGOING track's source only: idle playout never passes through an
# effect operator at all, and the incoming track always lands clean and dry —
# the way a DJ's filter/echo ride the channel that's leaving. The envelopes
# are pure functions of source.elapsed() on the transition branch (closures,
# no threads, no shared state): sample-accurate in AUDIO time, so they hold
# under any clock — the offline render harness (sync="none") exposed that
# wall-clock thread envelopes and audio time drift apart.
# Verified on liquidsoap v2.2.5, v2.4.4 AND v2.4.5 (scripts/fx-render-test.sh
# probe). NB: v2.4.5 is the MINIMUM runtime for these effects — on 2.4.4 the
# clock's O(n) source scan × multi-pull pass-through layers made every effect
# transition peg a core and stall the stream (see Dockerfile.broadcast).
# filter.rc and comb instantiate cleanly INSIDE the cross callback on a
# request.queue-backed source — the "Early computation of source content-type"
# crash is specific to iir_filter/HPF — and audibly alter the render.
# WHY comb, NOT echo: liquidsoap's native `echo` (incl. its ping_pong flag) is a
# verified NO-OP in BOTH the v2.2.5 and v2.4.4 savonet builds — it type-checks
# but passes audio through bit-for-bit unchanged (confirmed by render:
# identical md5 dry vs wet, re-confirmed on 2.4.4 with the dB-form feedback
# the 2.4 API demands). `comb` (a feedback delay line) is the working PCM primitive
# with a getter-controlled `feedback`. The tail is therefore centred, not a true
# L/R ping-pong; real stereo bounce would need the heavier ffmpeg.filter.aecho
# send path. Do NOT "simplify" this back to `echo`.
# NB: the SVF `filter` operator goes unstable near sr/4 (~11 kHz @ 44.1 k) and
# collapses the signal to near-silence — hence filter.rc with the "open" cutoff
# capped at 9 kHz (near-transparent on music).

if file.exists("/var/sub-wave/liquidsoap_jingle_ratio.txt") then
  raw = string.trim(file.contents("/var/sub-wave/liquidsoap_jingle_ratio.txt"))
  v = int_of_string(default=30, raw)
  # 0 is a valid value: jingles OFF (issue #997). Negative/garbage keeps the
  # default.
  if v >= 0 then jingle_ratio := v end
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

if file.exists("/var/sub-wave/liquidsoap_stream_bitrate.txt") then
  raw = string.trim(file.contents("/var/sub-wave/liquidsoap_stream_bitrate.txt"))
  v = int_of_string(default=192, raw)
  if v > 0 then stream_bitrate := v end
end

# Opt IN to the Ogg-Opus mount, which adds a continuous encoder (+ its
# 44.1->48k resample). Only Blink (Chrome/Edge) clients ever select Opus — see
# web/hooks/usePlayer.ts, which keeps Safari/iOS/Firefox on the MP3 mount — so
# it's off by default and operators who want the extra mount turn it on. The
# mandatory /stream.mp3 mount always serves everyone.
if file.exists("/var/sub-wave/liquidsoap_opus_enabled.txt") then
  raw = string.trim(file.contents("/var/sub-wave/liquidsoap_opus_enabled.txt"))
  opus_enabled := (raw == "true")
end

if file.exists("/var/sub-wave/liquidsoap_opus_bitrate.txt") then
  raw = string.trim(file.contents("/var/sub-wave/liquidsoap_opus_bitrate.txt"))
  v = int_of_string(default=96, raw)
  if v > 0 then opus_bitrate := v end
end

# Opt IN to the AAC-LC mount (raw ADTS, served as audio/aac). AAC's role here is
# device compatibility — players/hardware that decode AAC but not Opus — so it's
# off by default and aimed at external players, not the web/native UI (which
# never auto-select it). Stays at the source 44.1 kHz (no resample).
if file.exists("/var/sub-wave/liquidsoap_aac_enabled.txt") then
  raw = string.trim(file.contents("/var/sub-wave/liquidsoap_aac_enabled.txt"))
  aac_enabled := (raw == "true")
end

if file.exists("/var/sub-wave/liquidsoap_aac_bitrate.txt") then
  raw = string.trim(file.contents("/var/sub-wave/liquidsoap_aac_bitrate.txt"))
  v = int_of_string(default=192, raw)
  if v > 0 then aac_bitrate := v end
end

# Opt IN to the Ogg-FLAC mount — a lossless capture of the processed broadcast
# bus (no resample; stays at the source 44.1 kHz). Runs a third continuous
# encoder at ~800-900 kbps, so it's off by default. It's a true lossless tier
# only when the source files are themselves lossless; for lossy-source libraries
# it faithfully carries lossy audio at 4x the MP3 bandwidth. Intended for
# external players (VLC / foobar / network streamers) — the web player does not
# auto-select it. The mandatory /stream.mp3 mount always serves everyone.
if file.exists("/var/sub-wave/liquidsoap_flac_enabled.txt") then
  raw = string.trim(file.contents("/var/sub-wave/liquidsoap_flac_enabled.txt"))
  flac_enabled := (raw == "true")
end

# ICY (out-of-band) per-track titles on BOTH Ogg mounts (/stream.opus +
# /stream.flac). ON by default — only an explicit "false" disables it, the
# mirror image of the opt-in mount toggles above. See make_stream_outputs()
# for the client trade-off this switches between (issue #1052 vs foobar2000).
if file.exists("/var/sub-wave/liquidsoap_ogg_icy_metadata.txt") then
  raw = string.trim(file.contents("/var/sub-wave/liquidsoap_ogg_icy_metadata.txt"))
  ogg_icy_metadata := (raw != "false")
end

if file.exists("/var/sub-wave/liquidsoap_station_name.txt") then
  raw = string.trim(file.contents("/var/sub-wave/liquidsoap_station_name.txt"))
  if raw != "" then station_name := raw end
end

log("settings loaded: jingle_ratio=#{jingle_ratio()} crossfade_duration=#{crossfade_duration()} archive_enabled=#{archive_enabled()} archive_bitrate=#{archive_bitrate()} stream_bitrate=#{stream_bitrate()} opus_enabled=#{opus_enabled()} opus_bitrate=#{opus_bitrate()} flac_enabled=#{flac_enabled()} aac_enabled=#{aac_enabled()} aac_bitrate=#{aac_bitrate()} ogg_icy_metadata=#{ogg_icy_metadata()} station_name=#{station_name()}")

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
  outfile = file.temp("liq-curl-", ext)
  cmd = "curl -sS -L --max-time #{timeout} -o #{process.quote(outfile)} #{process.quote(uri)}"
  ret = process.run(timeout=float_of_int(timeout), cmd)
  if ret.status == "exit" and ret.status.code == 0 and file.size(outfile) > 0 then
    outfile
  else
    log(label="protocol.subhttp", level=3, "curl failed for #{uri}: status=#{ret.status} code=#{ret.status.code} stderr=#{ret.stderr}")
    file.remove(outfile)
    null
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
    contents = string.trim(file.contents("/var/sub-wave/next.txt"))
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
# HARD TRACK-LENGTH CAP — enforce max-track-length as a real ceiling (#447)
# ---------------------------------------------------------------------------
# The controller stamps `liq_cue_out="<seconds>"` (annotate:, via
# subsonic.getAnnotatedUri) on autonomous picks and auto.m3u fallback entries
# when a station/show max-track-length is set. `cue_cut` honours it and stops
# the track at that offset, so an over-length track NEVER airs in full — even
# the ones that slip past the controller's selection filter (unknown duration)
# or that were already on the way when the limit changed. This is the safety
# net that makes the admin setting a ceiling, not just a selection bias.
#
# Listener requests are deliberately left UN-stamped by the controller, so they
# carry no cue_out and play in full — an explicit ask for a long mix isn't cut.
# A cue_out past a shorter track's end is a no-op, so sub-cap tracks are
# untouched. Default out-metadata label is `liq_cue_out`. Placed BEFORE the
# music_meta capture so on_metadata still sees one clean event per cut track,
# and before `cross` so the cut track-end drives a normal crossfade out.
music = cue_cut(music)

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
# DJ TRANSITION EFFECTS live INSIDE this callback, per-branch on the outgoing
# source (see the state block near the top of this file). Instantiating
# operators here is safe for filter.rc and comb specifically — proven against
# the real v2.2.5 and v2.4.4 images by scripts/fx-render-test.sh probe. The historical
# `Early computation of source content-type detected for source iir_filter!`
# crash is specific to IIR filters (iir_filter/HPF) on a not-yet-typed
# `request.queue`-backed source; re-test with the probe before adding any OTHER
# operator class inside this callback.
# DJ-mode adaptive blend: the controller may stamp `liq_cross_duration` on a
# track (annotate:, via subsonic.getAnnotatedUri) to size its transition from
# tempo/harmonic compatibility. CRITICAL: `cross` reads `liq_cross_duration` to
# size its buffer from the OUTGOING track's metadata — the value registered when
# that track started controls the crossfade at its END (see liquidsoap docs).
# So the buffer for THIS transition equals `a`'s override (the outgoing track),
# NOT `b`'s. The fade therefore must read `a.metadata` too, or fade != buffer:
# a fade longer than the buffer gets truncated → the outgoing track is cut
# mid-fade and the incoming jumps to full (audible gaps / "no crossfade"); a
# fade shorter than the buffer sums to +6 dB (doubling). Reading `a` keeps
# fade == buffer — the invariant the whole section depends on.
# Absent / unparseable → crossfade_duration(), i.e. the global startup default.
def dj_transition(a, b) =
  d = float_of_string(default=crossfade_duration(), a.metadata["liq_cross_duration"])
  # Washout rides the ENDING track's own annotation — `a` IS the flagged track,
  # so there is no arming, no remaining() watcher, and no race against a
  # listener request jumping the queue. The controller stamps liq_washout_delay
  # (tempo-synced, dotted-eighth of the track's BPM) alongside the flag.
  washing = a.metadata["liq_washout"] == "true"
  # Exit loop rides the ENDING track's own annotation, exactly like the
  # washout — `a` IS the flagged track, its canvas and bar length were
  # stamped on it when it was queued. Washout wins when both ride one track
  # (it may carry the length-cap auto-arm; the queue avoids stacking them,
  # this is belt-and-braces).
  looping = a.metadata["liq_loop"] == "true" and not washing
  # Sweep rides the INCOMING pick's annotation ("sweep into my pick") but the
  # filter is applied to the OUTGOING branch: the track we're leaving sinks
  # under a closing lowpass while the pick rises clean underneath.
  # All three entry-side effects (sweep/dissolve/chop, flagged on the incoming
  # pick) yield to a loop already riding the outgoing track's exit: the loop
  # IS the transition, and garnishing it (filtering/washing/gating a loop)
  # chokes the gesture. The queue strips these upstream; enforced here too.
  sweeping = b.metadata["liq_sweep"] == "true" and not looping
  # Dissolve (reverb wash) rides the INCOMING pick like the sweep — "dissolve
  # the current track under my pick" — and is likewise applied to the OUTGOING
  # branch: the track we're leaving loses its transients and pulse to a
  # diffuse comb-cluster wash while the pick rises clean through it. The
  # SMOOTH way across a clash (the sweep is the dramatic way); the controller
  # only arms it between CLASHING tracks (mix.effectAllowedFor).
  # Precedence: a washout on the outgoing track's own annotation also shapes
  # this exit (echo tail vs ambient wash are mutually exclusive gestures) —
  # the washout wins because it may carry the length-cap auto-arm.
  dissolving = b.metadata["liq_dissolve"] == "true" and not washing and not looping
  # Chop (crossfader cut) rides the INCOMING pick like the sweep/dissolve —
  # "cut the current track out on the beat under my pick" — and is likewise
  # applied to the OUTGOING branch: the track we're leaving is gated
  # rhythmically at full level, stabs thinning and sparsening while the pick
  # rises clean through the gaps. The PERCUSSIVE way across a clash (sweep =
  # dramatic, dissolve = smooth); the controller only arms it between CLASHING
  # tracks (mix.effectAllowedFor) and stamps liq_chop_period (one beat of the
  # OUTGOING track's BPM) alongside the flag. Same washout precedence as the
  # dissolve: an echo tail and a beat gate fight over the same exit, and the
  # washout may carry the length-cap auto-arm.
  chopping = b.metadata["liq_chop"] == "true" and not washing and not looping
  # Washout drops the dry signal early (exp fade) so the tail reads as a
  # dissolve. An early drop sums BELOW unity mid-cross — a dip, which is the
  # effect; the +6 dB doubling hazard is only for fades that hold full level
  # early (see the fade == buffer invariant above).
  a_source =
    if washing then
      fade.out(duration=d, type="exp", initial_metadata=a.metadata, a.source)
    elsif sweeping then
      # A real filter-kill: the FILTER does the removal, not the fader. A log
      # fade holds the outgoing's level up longer so the closing filter is
      # heard choking a still-loud track — with the default fade the track was
      # already quiet by the time the cutoff got dramatic and the sweep felt
      # powerless (found on-air).
      fade.out(duration=d, type="log", initial_metadata=a.metadata, a.source)
    elsif chopping then
      # Same reasoning as the sweep: the GATE does the removal, not the fader.
      # A log fade keeps the stabs hot deep into the window — a DJ cutting the
      # crossfader cuts at full level; the gate envelope (duty shrink + beat
      # sparsening + master exit) is what takes the track out.
      fade.out(duration=d, type="log", initial_metadata=a.metadata, a.source)
    elsif looping then
      # The dry only plays through the capture pass (one bar) before the hard
      # gate cuts it — a log fade keeps that bar essentially at full level, so
      # the loop is seeded hot (a linear fade would seed it a couple of dB
      # down and every repeat inherits the loss).
      fade.out(duration=d, type="log", initial_metadata=a.metadata, a.source)
    else
      fade.out(duration=d, initial_metadata=a.metadata, a.source)
    end
  # SWEEP ENVELOPE — how a DJ rides the filter out of a track: a slow
  # smoothstep close over the first 70% of the blend, held at the floor while
  # the fade finishes. The cutoff moves in LOG-frequency space (pow) — linear
  # Hz ramps sound like nothing-then-everything; log space is how a filter
  # knob feels. No release phase: the outgoing branch ends with the cross, so
  # there is nothing to reopen. Pure function of the branch's own
  # source.elapsed(), evaluated per frame by the getter — audio-time-accurate
  # under any clock, no threads, no shared state.
  a_source =
    if sweeping then
      log("DJ sweep: closing the filter over the outgoing track (d=#{d}s)")
      sweep_src = a_source
      # Close FAST and DEEP — over the first 45% of the blend down to 600 Hz,
      # through three RC stages (18 dB/oct), so the choke arrives while the
      # outgoing is still loud (the log fade above holds its level up). A
      # slower/shallower close spread over 70% was inaudible under the fade.
      def sweep_cut() =
        e = source.elapsed(sweep_src)
        e = if e < 0. then 0. else e end
        t_close = 0.45 * d
        t_hold  = 0.55 * d
        t_back  = 0.85 * d
        # Dive to the floor, touch it briefly, then PARTIALLY re-open as the
        # incoming takes over: a sustained floor reads as "the track went
        # quiet"; a brief bottom with the outgoing re-emerging under the new
        # track reads as the gesture (second on-air 'goes quiet' report).
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
        9000.0 * pow(1100.0 / 9000.0, depth)       # 9 kHz open → 600 Hz floor
      end
      # Wet ramps 0→1 over the first ~15% of the blend: an RC at 9 kHz is NOT
      # transparent (−dB at the cutoff + roll-off), so engaging it full-wet at
      # the cross start lands as an instant dulling — the filter must fade IN,
      # then the closing cutoff does the work (found on-air).
      # Makeup on the choked branch: the filter guts the outgoing's energy
      # right when the incoming is only half-faded, and the mid-blend went
      # near-quiet (twice, by ear). Lift the choked residual +2.6 dB as the
      # cutoff bottoms out so the blend keeps its body — the choke stays
      # dramatic spectrally without a level hole.
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
      # PARALLEL DRY BLEED — the "never goes quiet" guarantee. Wetness on
      # cascaded stages multiplies the dry path (0.35 × 0.35 ≈ 12% ≈ −18 dB),
      # which is why every wetness-cap attempt still cratered the mid-band.
      # An explicit dry branch around a full-wet chain gives a HARD floor:
      # 30% of the untouched track always reaches the mix (≈ −10 dB, ≈ −8 dB
      # after makeup), no matter how deep the cutoff dives.
      swept = filter.rc(frequency=sweep_cut, mode="low", wetness=1.,
                filter.rc(frequency=sweep_cut, mode="low", wetness=1., a_source))
      amplify(sweep_gain, add(normalize=false,
        [amplify(0.30, a_source), amplify(0.75, swept)]))
    else
      a_source
    end
  # WASHOUT ENVELOPE — dub-style tail: the comb feedback swells over the first
  # quarter of the blend while the exp fade above drops the dry signal away
  # early, so the delay line SELF-SUSTAINS: the track dissolves into a pulsing,
  # decaying tail over the incoming track's opening instead of echo layered on
  # a still-full-level song. Feedback releases to silent by 0.95*d — the
  # transition source is truncated at d, so the tail must decay before the
  # window closes or it clicks off. Same closure pattern as the sweep.
  # BLEND (spectral handover) — the continuity move, the sweep's mirror: the
  # OUTGOING track hands its bass (by ~25%), then its mids (by ~65%), to the
  # incoming, keeping only its highs to the end; the incoming arrives
  # lows-first underneath (see the b-side block below). At every moment the
  # sum reads as ONE full-spectrum piece of music whose ingredients are
  # swapping — the club "EQ mixing" technique for seamless long blends. The
  # controller only arms it between COMPATIBLE tracks (mix.effectAllowedFor).
  # At e=0 the HPF sits at 30 Hz ≈ transparent, so the engage is seamless.
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
      # SUBTRACT-HPF: filter.rc mode="high" is BROKEN in the v2.2.5 build —
      # even a static 400 Hz high-pass collapses music to −115 dB (verified by
      # render; same defect family as the `echo` no-op) — and STILL broken on
      # v2.4.4 (re-verified: 40 Hz HPF on a 440 Hz tone renders −inf silence).
      # High-pass is built
      # from proven parts instead: dry − lowpass(dry). Polarity inversion and
      # twin-consumer frame alignment verified: src + amplify(-1., src)
      # renders exact silence.
      blend_low = filter.rc(frequency=blend_hp, mode="low", wetness=1., a_source)
      add(normalize=false, [a_source, amplify(-1., blend_low)])
    else
      a_source
    end
  a_source =
    if washing then
      wd = float_of_string(default=0.30, a.metadata["liq_washout_delay"])
      log("DJ washout: dissolving the outgoing track, tap=#{wd}s (d=#{d}s)")
      wash_src = a_source
      # The swell must beat the exp fade: feedback peaks within ~10% of the
      # blend, while the outgoing material is still hot, so the delay line
      # loads audible audio — swelling at 25% seeded the tail from an
      # already-faded signal and the wash was inaudible (found on-air). The
      # higher fb (−1.5 dB ≈ ×0.84/tap) sustains the tail across the blend;
      # buildup is bounded because the exp fade starves the input within a
      # couple of seconds, and the brick-wall limiter backs the bus anyway.
      def wash_fb() =
        e = source.elapsed(wash_src)
        e = if e < 0. then 0. else e end
        fb_max = -1.0            # peak feedback dB (nearer 0 = longer tail; <unity)
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
      # Late makeup gain (+3.5 dB) so the tail sits PRESENT over the incoming
      # track's fade-in instead of buried under it. It comes up only after the
      # exp fade has dropped the dry (0.3·d → 0.55·d), so it never bumps the
      # still-audible song — it lifts the echoes alone (found on-air: the
      # dissolve was correct but too quiet to register).
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
      # Darkening tail — a real dub/DJ delay feeds back through a filter, so
      # every repeat comes back darker. The comb's loop is fixed, so instead a
      # lowpass AFTER it closes across the window (9 kHz → 1.5 kHz, log space):
      # later repeats occur later in time, so they arrive darker — the tail
      # recedes into the dark instead of ringing at full brightness. Wet ramps
      # in over the first 20% (an RC at 9 kHz is not transparent — engaging it
      # full-wet would dull the still-audible dry, same lesson as the sweep).
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
  #      (43/61/79/101 ms) instead of one tempo-synced tap — the tails smear
  #      into diffuse ambience instead of a rhythmic pulse. No allpass exists
  #      in the proven kit (native echo is a no-op on both engine builds), so
  #      diffusion comes from the prime spread plus heavy damping; the wash
  #      also sits UNDER the rising pick, which hides the metallic edge a
  #      Schroeder cluster has when exposed.
  #   2. The damping lowpass closes deeper (7 kHz → 1.2 kHz) — the wash reads
  #      as the track receding into a large dark space, not echoing in place.
  # Feedback swells fast (within 15% of d, while the exp-faded dry is still
  # hot enough to seed the cluster — the washout's on-air lesson), holds, and
  # releases to silence by 0.93·d so the tail is dead before the transition
  # source truncates at d. Each comb's tail is isolated from its dry
  # pass-through (see pure_tail below) so the wash can run hot without
  # multiplying the dry path.
  a_source =
    if dissolving then
      log("DJ dissolve: reverb wash under the next track (d=#{d}s)")
      diss_src = a_source
      def diss_fb() =
        e = source.elapsed(diss_src)
        e = if e < 0. then 0. else e end
        # Per-tap dB. Tail decay = fb/delay per SECOND, so short taps need
        # near-unity feedback: -0.5 dB on 89–181 ms taps ≈ a 3–6 dB/s,
        # multi-second wash. The first cut (-2.5 dB on 43–101 ms taps)
        # decayed 25–58 dB/s — rendered indistinguishable from dry.
        fb_max = -0.5
        fb_off = -90.0
        # The swell must beat the exp fade (the washout's on-air lesson): the
        # loop only ever holds what it was fed while the dry was still hot.
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
      # Late makeup, same rationale as the washout: lift the wash alone after
      # the exp fade has dropped the dry, so the ambience sits present over
      # the incoming track instead of buried. Hotter than the washout's 1.95
      # in linear terms is NOT what this is — the wash's four 0.25-weighted
      # taps start ~12 dB below the washout's single unity tap, so 2.2 here
      # still lands the bed several dB under where the washout tail sits.
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
      # Darkening: later reflections arrive later in time, so a lowpass
      # closing across the window makes the wash recede into the dark. Wet
      # ramps in over the first 10% (an RC at 7 kHz is not transparent —
      # engaging it full-wet at cross start dulls the still-audible dry;
      # the sweep's on-air lesson).
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
      # PURE-TAIL isolation: comb passes its input, so summing four combs
      # directly forces a 0.25 weight to keep the dry at unity — which buries
      # the tails 12 dB down before they even start (first render: a −44 dB
      # mid-cross crater, wash inaudible). Subtracting the input from each
      # comb leaves ONLY the feedback tail (src + amplify(-1., src) nulls
      # exactly — the twin-consumer alignment the blend already relies on),
      # so the dry rides the faded path once and the tails run hot.
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
  # CHOP ENVELOPE — the crossfader cut: rhythmic amplitude gating of the
  # outgoing track, opening AT each beat start (the downbeat transient
  # survives) and closing for the rest of the beat. Pure `amplify` driven by a
  # pure function of the branch's own source.elapsed() — the same proven
  # closure pattern as sweep_gain/wash_gain, no new operator class, so no
  # fx-render-test re-probe needed. The gesture runs on its own compressed
  # clock dd = min(d, 10 s): a cut is a cut — stretched over a long operator
  # crossfade it read as slow pumping (heard on-air, #861), so the envelope
  # finishes in ≤10 s and leaves the rest of the buffer to the incoming ramp.
  # Four envelopes compose per frame:
  #   rate    — the gate ACCELERATES like a DJ transform cut: one cut per beat
  #             through 40% of dd, eighths to 72%, sixteenth stutter into the
  #             throw. p/2 and p/4 divide p, so every original beat start is
  #             still a gate-open and the downbeat transient survives; a zone
  #             switch mid-gate costs one irregular gap, inaudible at speed.
  #   duty    — how much of each gate stays open: 1.0 (transparent engage) →
  #             0.55 by 15% of dd → 0.30 by 72% (stabs tighten).
  #   floor   — gain UNDER the closed gate: 0.45 → 0 over the first 25% of dd:
  #             the first holes read as beat-synced pumping just long enough
  #             to establish the move, then harden into true cuts (full
  #             silence between the very first stabs read as dropouts).
  #   (the old every-other-beat sparsen is gone — the stutter accelerando IS
  #   the exit now; isolated late stabs read as slowing down, the wrong
  #   direction for a cut.)
  # Gate edges are ~12 ms smoothsteps (square edges click); a wet ramp over
  # the first 8% of dd makes the engage bit-transparent (at e=0 gain is
  # exactly 1 — any instant dip against the pre-cross signal is a step); a
  # master release kills the stutter by 0.92·dd so the branch is silent long
  # before the transition source truncates at d (amplify vanishes at the
  # boundary like every branch operator).
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
        ph = e / pp - float_of_int(beat)         # 0..1 within the gate
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
        # Master release: silent from 0.92·dd — the throw. The rest of the
        # buffer belongs to the incoming ramp.
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
  # LOOP ENVELOPE — the exit loop ("loop out"): the last bar of the OUTGOING
  # track is caught in a loop as the dry is hard-cut, riding in tempo under
  # the incoming pick, then filtered down and released.
  #
  # HOW THE LOOP IS BUILT — measured comb facts first (burst-probed on the
  # real v2.4.5 image; see the combprobe history in PR #863): this build's
  # `comb` is a ONE-SHOT feed-forward echo, NOT a recirculating feedback
  # comb — a single burst in yields exactly one delayed copy, then silence,
  # whatever the feedback value (getter or constant). So no single comb can
  # loop. Instead: a CASCADE OF DOUBLING DELAYS. K combs at bar, 2·bar,
  # 4·bar, 8·bar convolve to taps at EVERY multiple 0..(2^K−1) of bar (the
  # binary counter), so a one-bar capture tiles gaplessly — each bar-slot
  # holds exactly one copy, no overlap, no pileup, and the repetition
  # terminates by construction (nothing recirculates, so it cannot ring past
  # its last tap or run away). At feedback=0.0 the tap set measures FLAT at
  # a fixed −6 dB regardless of stage count (probed at 2, 3 and 4 stages) —
  # one constant ×2 makeup restores unity. Stages 4·bar / 8·bar are built
  # only when their delay < d: a tap at ≥ d is never heard, and 2^K·bar ≥ d
  # then guarantees repeats reach the end of every canvas.
  #
  # The gesture: unity through the CAPTURE PASS (the first bar), then a hard
  # 12 ms gate cut — the CUT is what reads as "caught in a loop" (the
  # washout's exp fade is what reads as echo). Known compromise, accepted:
  # the analyzer gives tempo, not beat PHASE — the loop starts where the
  # cross fires, not on a downbeat, so it lands as a tape-loop, not a
  # gridded serato loop, and the splice may tick once per pass. The tick
  # repeats in tempo (reads as vinyl) and the ride-out lowpass softens it.
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
      # over: the cutoff closes 9 kHz → 2.5 kHz (log space) over the back half.
      # Wet stays 0 through the capture pass (an RC at 9 kHz is not
      # transparent — the sweep's on-air lesson; the still-audible dry passes
      # through this chain too) and ramps in only after the cut.
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
      # Master release — the ONLY level release (a feed-forward cascade has
      # no feedback to ramp down): the loop rides flat, then fades out under
      # the incoming from 0.80·d, silent from 0.92·d — before the branch
      # truncates at d.
      def loop_master() =
        e = source.elapsed(loop_src)
        e = if e < 0. then 0. else e end
        if e < 0.80 * d then 1.0
        elsif e < 0.92 * d then
          x = (e - 0.80 * d) / (0.12 * d)
          1.0 - (3.0 * x * x - 2.0 * x * x * x)
        else 0.0 end
      end
      gated  = amplify(loop_dry, a_source)
      looped = comb(delay=bar, feedback=0.0, gated)
      looped = comb(delay=2.0 * bar, feedback=0.0, looped)
      looped = if 4.0 * bar < d then comb(delay=4.0 * bar, feedback=0.0, looped) else looped end
      looped = if 8.0 * bar < d then comb(delay=8.0 * bar, feedback=0.0, looped) else looped end
      # The cascade measures a fixed −6 dB whatever the stage count (see the
      # header comment) — one constant makeup restores the loop to unity.
      looped = amplify(2.0, looped)
      looped = filter.rc(frequency=loop_cut, mode="low", wetness=loop_wet,
                 filter.rc(frequency=loop_cut, mode="low", wetness=loop_wet, looped))
      amplify(loop_master, looped)
    else
      a_source
    end
  b_source = fade.in(duration=d, initial_metadata=b.metadata, b.source)
  # INCOMING side of a sweep — two real-DJ moves, both fully transparent well
  # before the outgoing track is gone (release = wetness → 0, because an RC
  # filter at its "open" cutoff still is not transparent):
  #   1. SURFACING — the pick materialises from far away: a lowpass opens
  #      500 Hz → 9 kHz over the first 35% of the blend and is fully OUT by
  #      40%, while the old track still dominates. (The v1 mistake was a
  #      muffle that outlived the transition; opening fast and early keeps
  #      the "approaching" feel without the broken-sounding landing.)
  #   2. BASS SWAP — a highpass holds the pick's low end back so two
  #      basslines never fight across the long blend, then releases at
  #      ~45–62% and the bass lands like a small drop — the most
  #      professional-sounding instant of the whole move. (Releases sit
  #      earlier than a club bass-swap so the incoming fills the middle of
  #      the blend — with both tracks processed, ~50% went near-silent.)
  # Net arc: mid-band → highs bloom (35%) → bass drops (65%) → standalone.
  # BLEND, incoming side: the pick arrives lows-first — a lowpass opens
  # 250 Hz → 9 kHz over the first 70% (log space) as the outgoing HPF climbs,
  # so the two trade the spectrum in complementary bands. Wetness releases to
  # 0 by 82% (release must be wet→0: an RC at its open cutoff is never fully
  # transparent, and the branch operators vanish at the d boundary — the
  # track must already be bit-clean before then).
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
      # Bass swap via SUBTRACT-HPF (mode="high" is broken — see the blend
      # block above; it was silencing the whole incoming track while its
      # wetness was up, the real culprit behind the mid-blend dropouts):
      # subtract `bass_amt` of the track's own <160 Hz content, releasing
      # amt 1 → 0 over 38–55% so the bass lands as the outgoing bows out.
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

# Keep a handle on the PRE-cross music source so the on_metadata hook
# (attached further down, where on_meta is defined) sees clean per-track
# metadata events. Hooking the post-cross source fires twice per
# transition — the custom dj_transition below builds fade.in/fade.out
# with initial_metadata=, and the outgoing track wins, stranding the UI
# one song behind until the next crossfade.
music_meta = music

# BEDS ↔ JINGLES — true from a bed's first metadata until the next real song's
# (both set in on_meta, defined further down). The jingle rotate below counts
# every music-chain track and a bed IS a track, so without a gate the rotate
# can insert a stinger BETWEEN the bed and the song it ramps into — the bed's
# exit cross then lands on a jingle, right after the DJ's closing words. While
# this flag is up the jingles source reads as unavailable, so the rotate skips
# it (exactly as it does for an empty jingles.m3u) and the jingle defers to
# the next real track boundary.
bed_on_air = ref(false)

# JINGLES & STATION ID — rotate a jingle in every N tracks.
#
# CRITICAL: this rotate MUST sit here, on the raw pre-cross / pre-duck music
# source, NOT at the top of the chain. `rotate` defaults to track_sensitive=true
# so it only advances to the next source at a *track boundary* of the source it
# is currently playing. Both `cross` (below) and the `smooth_add` ducking layers
# present their output as ONE continuous, never-ending track — they do not
# propagate the underlying per-track boundaries upward (the same reason
# on_metadata hooks `music_meta` here and not the post-cross source). If the
# rotate is placed above them it plays exactly one jingle at startup, switches to
# the music side, never sees a track end again, and is stuck on music forever —
# jingles "stop triggering" (issue: jingles only fire once per restart). Placing
# it on the raw playlist sources keeps the boundaries clean so it rotates
# indefinitely. An empty jingles.m3u is fine: rotate skips the unavailable
# source and plays music. music_meta is captured ABOVE this, so jingles never
# show up in now-playing.
# jingle_ratio 0 = jingles OFF (issue #997): the rotate isn't built at all, so
# the chain is byte-identical to a station with no jingles. Applied at startup
# like every other liquidsoap_*.txt setting — changing it needs a mixer restart.
music =
  if jingle_ratio() > 0 then
    jingles = playlist(
      id="jingles",
      mode="randomize",
      reload_mode="watch",
      "/var/sub-wave/jingles.m3u"
    )
    # Announce each jingle to the controller. Jingles are invisible to it (no
    # on_metadata — music_meta is captured above this rotate) and play outside
    # its airVoice voice serialiser, so a TTS segment aired at the incoming
    # track's boundary could talk over the stinger (issue #997). This marker is
    # written at FEED time — the jingle turns audible ~crossfade_duration later
    # (the cross buffer) — and the controller holds its voice chain until the
    # marker's window (start + crossfade + clip length) has passed.
    jingles.on_metadata(synchronous=false, fun (m) ->
      file.write(
        data=json.stringify(compact=true, {
          filename = m["filename"],
          startedAt = time()
        }),
        atomic=true,
        "/var/sub-wave/jingle-playing.json"
      )
    )
    # A bed on air makes jingles unavailable (see bed_on_air above) so the
    # rotate can't split a bed from the song it ramps into.
    jingles = source.available(jingles, {not bed_on_air()})
    rotate(
      weights=[1, jingle_ratio()],  # 1 jingle for every N music tracks (settings.json)
      [jingles, music]
    )
  else
    music
  end

# Per-track loudness normalisation. The controller stamps `liq_amplify` (in the
# "<n> dB" form, via subsonic.getAnnotatedUri) on any track with a measured LUFS;
# `amplify` reads it per track — exactly the ReplayGain mechanism. Base factor
# 1.0 = unity, so a track without the metadata (un-analysed library, or no
# pyloudnorm) plays untouched. Applied BEFORE the cross so each track carries its
# own gain into the crossfade, and AFTER the music_meta capture so the
# on_metadata hook still sees clean pre-cross metadata. No master-bus normaliser
# is involved — the broadcast bus stays the brick-wall limiter only.
music = amplify(override="liq_amplify", 1., music)

# NB: no effect operators on the bus here — the DJ transition effects (sweep /
# washout) are built per-transition on the outgoing branch inside dj_transition,
# so idle playout has no effect operators in its path at all, and jingles can
# never be caught inside a ramp.
# persist_override=true (2.4): with the new default (false) the
# liq_cross_duration override is reset before it ever sizes the stamped
# track's own end-of-track buffer (verified by scripts/fx-render-test.sh
# xdur: stamped 12 rendered an 86s output — static buffer — without persist,
# 78s — stamp honoured — with it). Persist restores the 2.2.5 sizing. The
# flip side of persist is that a stamp would linger over later unstamped
# tracks, so the controller now stamps EVERY track it annotates
# (subsonic.getAnnotatedUri falls back to the operator's crossfade setting),
# making the lingering value always the intended one.
music = cross(
  duration=crossfade_duration(),
  persist_override=true,
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
    contents = string.trim(file.contents("/var/sub-wave/say.txt"))
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
    contents = string.trim(file.contents("/var/sub-wave/intro.txt"))
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
    contents = string.trim(file.contents("/var/sub-wave/sfx.txt"))
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

# Per-segment voice level trim. The controller stamps `liq_amplify` (in the
# "<n> dB" form) onto the say.txt/intro.txt URI per spoken clip — a per-engine +
# per-persona gain that levels the loudness gap between TTS engines (see
# settings.tts.gainDb + audio/tts.ts:voiceGainDb). `amplify` reads it per
# request — the same ReplayGain mechanism the music bus uses (line 214). Applied
# BEFORE mic_chain so the fixed-threshold compressor sees a levelled input. The
# un-annotated silent lead-in carries no `liq_amplify`, so it plays at the base
# factor 1. (unity). Un-trimmed clips (gainDb 0) write a bare path → also unity.
# Micro edge fade-IN on each spoken clip. Some TTS engines cut the WAV hard at
# the file boundary; once the mic-chain compressor's makeup gain lifts the
# clip, that hard edge lands as an audible click/tick. 40 ms is short enough
# not to soften the first word (speech onsets are slower than that) but long
# enough to zero out the boundary discontinuity. Applied per track, so the
# silent lead-in clip is faded too (harmless — it's silence). Placed BEFORE
# amplify/mic_chain so the compressor never sees the raw edge.
# fade.in ONLY — no fade.out. On a request.queue source this Liquidsoap build
# doesn't know the track's remaining time, so fade.out treats the whole clip
# as inside the fade zone and multiplies it to silence (every voice segment
# aired as dead air under the duck). Verified empirically against the
# broadcast image. Tail clicks must be faded at WAV-render time instead.
def edge_fade(s) =
  fade.in(duration=0.04, s)
end

voice = mic_chain(amplify(override="liq_amplify", 1., edge_fade(voice_queue)))
intro = mic_chain(amplify(override="liq_amplify", 1., edge_fade(intro_queue)))

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
#                            music drops well underneath to ~22%.
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
  p={0.22},         # music drops to 22% (~-13 dB) while voice plays
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

# NOTE: jingles are NOT rotated in here. The rotate lives up on the raw pre-cross
# music source (see the "JINGLES & STATION ID" block above music_meta) because a
# track_sensitive rotate placed above `cross` + `smooth_add` only ever fires one
# jingle at startup and then stalls — those operators hide the per-track
# boundaries it needs to switch on.

# ---------------------------------------------------------------------------
# SAFETY — fallback to the emergency loop when the source dies
# ---------------------------------------------------------------------------

# If the source dies, play a static "technical difficulties" loop. This is the
# real dead-air guard: `emergency` is an always-ready, non-silent single, so the
# broadcast never has nothing to pull.
emergency = single("/sounds/emergency.mp3")
radio = fallback(track_sensitive=false, [radio, emergency])

# ---------------------------------------------------------------------------
# IDLE GATE — silence the programme while nobody is listening
# ---------------------------------------------------------------------------
# When the controller has seen zero Icecast listeners for a while it flips
# idle_mode on (telnet idle_on / idle_off, registered below): the switch
# selects blank() and the whole chain above — dj_queue, the auto playlist,
# the cross buffer, the subhttp downloads from Navidrome — stops being
# pulled, frozen mid-track. The Icecast mounts STAY UP serving silence, so
# any client (VLC, Sonos, a browser) connects normally; the controller sees
# the new listener on its next poll, flips idle_mode off, and playback
# resumes exactly where it froze. Contrast stream_off (further down), which
# tears the mounts down and 404s new listeners.
# A plain blank() branch is safe here — the #660 CPU spin was specific to
# the blank.skip operator, not a blank source.
# Not persisted: a mixer restart always comes back live (mirrors stream_on);
# the controller re-asserts idle over telnet if the room is still empty.
idle_mode = ref(false)
radio = switch(
  id="idle_gate",
  track_sensitive=false,
  [({idle_mode()}, blank(id="idle_silence")), ({true}, radio)]
)

# NOTE: a `blank.skip(max_blank=5.0, radio)` used to sit here to skip >5s of
# digital silence. It was REMOVED (#660). With no music in the chain — a fresh
# install pre-onboarding, Navidrome down, or the auto playlist exhausted —
# blank.skip busy-loops at ~100% CPU: it pegs a core and stops feeding Icecast,
# so /stream.mp3 starts returning 404. The spin happens in ANY position (before
# OR after this fallback — both were measured at ~100% CPU on an empty-library
# broadcast; removing the operator drops it to ~5%), so reordering does not help.
# The emergency single above already covers the only case blank.skip protected
# against in practice (a dead source), so the silence-skip is not worth a
# fresh-install-breaking CPU spin.

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
  # BEDS — an instrumental bed the controller pushed into dj_queue for the DJ to
  # talk over between two songs (broadcast/beds.ts). It rides the music chain
  # like any other request, but it is NOT a song: it must never reach
  # now-playing.json (the UI would announce it) and must never push an ICY title
  # (hardware radios would show it). It carries no title/artist, so the gate
  # below would drop it silently anyway — and that silence is the problem, since
  # the controller learns "the bed is on air, air the link now" only from this
  # marker. So branch BEFORE the gate and announce it on its own channel.
  #
  # Same shape and rationale as jingle-playing.json (#997): liquidsoap telling
  # the controller that a non-track thing started.
  if m["subwave_kind"] == "bed" then
    log("on_meta: bed started (#{filename})")
    bed_on_air := true
    file.write(
      data=json.stringify(compact=true, {
        filename = filename,
        startedAt = time()
      }),
      atomic=true,
      "/var/sub-wave/bed-playing.json"
    )
  elsif title != "" or artist != "" then
    bed_on_air := false
    log("on_meta: title=#{title} | artist=#{artist} | album=#{album} | id=#{subsonic_id}")
    ts = int_of_float(time())
    # Build via json.stringify so values with embedded quotes/backslashes
    # (e.g. a title like Fall (From "Rabb Da Radio 3")) are properly escaped —
    # raw string interpolation here produced invalid JSON the UI couldn't parse.
    payload = json.stringify(compact=true, {
      title = title,
      artist = artist,
      album = album,
      subsonic_id = subsonic_id,
      filename = filename,
      timestamp = ts
    })
    # atomic=true (temp file + rename) — the controller re-reads this file
    # every 1.5s and per /now-playing request, and its reader treats ANY parse
    # failure as null; an in-place truncate-then-write here made it possible to
    # observe a half-written JSON and blank the now-playing data for a tick.
    file.write(data=payload, atomic=true, "/var/sub-wave/now-playing.json")
    # Push the same metadata onto the Icecast stream so the ICY title
    # tracks the current song instead of lagging a transition behind.
    radio.insert_metadata([
      ("title", title),
      ("artist", artist),
      ("album", album)
    ])
  else
    # Untitled, non-bed metadata (the emergency single, an untagged local
    # file). Nothing to publish — but it still marks the bed's end, and
    # without this reset bed_on_air would latch true and keep the jingle
    # rotate starved until the next tagged song.
    bed_on_air := false
  end
end

# Attach to the PRE-cross source (`music_meta`, captured above before the
# cross wrap). Hooking the post-cross source fires twice per transition —
# dj_transition's fade.in/fade.out both pass initial_metadata=, and the
# outgoing track usually wins, freezing the UI one song behind.
# on_metadata is used instead of on_track because on_track gets swallowed
# by source switches (request queue → auto playlist).
# synchronous=false (2.3+ mandatory arg): on_meta does file I/O — run it on
# the task queue, not the streaming thread.
music_meta.on_metadata(synchronous=false, on_meta)

# ---------------------------------------------------------------------------
# OUTPUT — broadcast to Icecast
# ---------------------------------------------------------------------------

# Stream on/off control. An Icecast output can't be paused, but it can be
# shut down and recreated on demand (Liquidsoap's dynamic-sources pattern).
# `stream_off` shuts all mounts down — /stream.mp3, /stream.opus (and any
# optional mounts) disconnect and the station goes genuinely off air, and the
# hourly archive output (also built here) stops recording with them; `stream_on`
# recreates them. force_start lets the recreated outputs start after init.
# The on/off state lives in refs and is read back over telnet by the
# controller. It is NOT persisted: a mixer restart always comes back on air.
#
# Two mounts in parallel:
#   /stream.mp3  — MP3, the universal compatibility floor
#                  (Sonos, hardware radios, car receivers, pre-iOS-17 Safari).
#                  Bitrate is operator-configurable (admin → Settings → Stream
#                  MP3 bitrate); 192 is the default. The default sits at 192,
#                  not 128, because dense, brick-walled masters (e.g. hot
#                  Punjabi/hip-hop catalogue pinned at 0 dBFS) produced audible
#                  encode grain ("swishy static") at 128 with no headroom — the
#                  extra ~50% bandwidth buys a clean re-encode of busy material.
#                  Dropping below 192 reintroduces that grain on hot masters.
#   /stream.opus — Ogg-Opus 96 kbps, ~equal-or-better quality at half the
#                  bandwidth for modern browsers (the web player auto-prefers
#                  it via canPlayType). Browsers / VLC / cliamp on a recent
#                  build all decode it; older clients keep using MP3.
# Per-listener bandwidth is per-mount, so the unused side costs nothing.
settings.init.force_start := true

# TEMPORARY (re-harden later): allow running as root. The broadcast entrypoint
# currently launches liquidsoap as root (not the privilege-dropped `liquidsoap`
# user) because the 2.4.4 base image changed that user's uid and made the
# persisted state files unwritable — see docker/broadcast-entrypoint.sh. Without
# this, liquidsoap refuses to start under a root euid. Revert together with the
# entrypoint once the state files are re-chowned to the liquidsoap uid.
settings.init.allow_root := true

# Hourly archive path. Wrap in `{time.string(...)}` so the path is a getter that
# re-runs strftime each time `output.file` reopens (every hour via reopen_when).
# Passing the bare string skips strftime entirely and writes everything to one
# literal "%Y-%m-%d/%H-00.mp3" file that gets truncated at the top of each hour.
# Defined here (before make_stream_outputs) because the archive output is built
# inside it, tied to the on-air lifecycle.
archive_path = {time.string("/var/sub-wave/archive/%Y-%m-%d/%H-00.mp3")}

def make_stream_outputs() =
  # Pick the encoder from a fixed set: %mp3(bitrate=…) needs a parse-time
  # literal int (can't pass a ref), same constraint as the archive output
  # below. Keep these branches in sync with MP3_BITRATES in settings.ts.
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
  # Opus mandates 48 kHz internally — Liquidsoap resamples from the 44.1 kHz
  # source bus. application="audio" is the right tuning for music (vs "voip"
  # or "lowdelay"). 96 kbps is the music-transparent default; the bitrate is
  # selectable from a fixed set because %opus(bitrate=…) needs a parse-time
  # literal (same constraint as %mp3). Keep these branches in sync with
  # OPUS_BITRATES in settings.ts. Gated on opus_enabled so operators can drop
  # the encoder + resample (no-op shutdown when off).
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
        # ICY metadata is an operator toggle (default ON). output.icecast leaves
        # send_icy_metadata null by default, which GUESSES it off for any
        # Ogg-container format and relies on in-band Ogg header re-emission (a new
        # chained logical stream per track) instead. Many radio clients — Ferrosonic,
        # Google Cast receivers, Symfonium — read the Ogg Vorbis comment only once at
        # connect and never re-parse on a chained boundary, so without ICY they
        # freeze on the first track's title (issue #1052). foobar2000 is the
        # opposite: it parses the in-band chained-Ogg tags correctly and the ICY
        # channel on top breaks its Ogg-FLAC metadata — no single value suits both
        # client camps, hence the toggle instead of a hardcoded true.
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
  # Ogg-wrapped FLAC (streamable over Icecast, unlike the file-oriented native
  # %flac). No resample — stays at the source 44.1 kHz. FLAC is lossless so
  # there's no bitrate; compression=5 is the FLAC default (CPU/size balance) and
  # bits_per_sample=16 is CD-quality and universally decodable. Gated on
  # flac_enabled so the encoder only runs when an operator opts in.
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
        # ICY metadata operator toggle — see the /stream.opus note above. Default ON
        # so Ogg-FLAC internet-radio clients (Ferrosonic etc.) get per-track titles
        # (#1052); off for stations with foobar2000 listeners, where the ICY channel
        # breaks fb2k's in-band Ogg-FLAC metadata.
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
  # AAC-LC over Icecast as raw ADTS (transmux="adts") — broadly decodable by
  # players/hardware that lack Opus. afterburner=true trades a little CPU for
  # better quality. No resample — stays at the source 44.1 kHz. Bitrate is a
  # parse-time literal (same constraint as %mp3/%opus); keep these branches in
  # sync with AAC_BITRATES in settings.ts. format="audio/aac" pins the mount's
  # advertised MIME so streaming clients recognise the ADTS stream.
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
  # Hourly archive to /var/sub-wave/archive/. A second MP3 encoder running 24/7
  # is the single biggest CPU cost in the broadcast container — guard the entire
  # output so operators who don't use the archives don't pay for the encoder.
  # Bitrate is selected from a fixed set because `%mp3(bitrate=…)` requires a
  # literal int at parse time (we can't pass a ref). Built here (not standalone)
  # so it lives inside the on-air lifecycle: taking the station off air stops the
  # recording too — otherwise it kept writing hourly files of the internal
  # fallback/emergency loop while off air.
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
    # Off air — drop now-playing.json so the UI stops advertising the last
    # track that played. on_meta rewrites it as soon as we're back on air and
    # the next track's metadata fires; the controller reads a missing file as
    # "nothing playing".
    if file.exists("/var/sub-wave/now-playing.json") then
      file.remove("/var/sub-wave/now-playing.json")
    end
  end
end

# On air at startup — this also starts the hourly archive (built inside
# make_stream_outputs, so it follows the on-air lifecycle).
stream_up()

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

# Take the station off air / back on air on demand. stream_off shuts the
# Icecast outputs down so /stream.mp3 and /stream.opus disconnect together (and
# stops the hourly archive recording); stream_on recreates them all.
# stream_status reports the current state for the
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

# Pause / resume the programme while keeping the mounts up (the idle gate
# above). idle_on swaps the broadcast to silence without disconnecting
# anyone; idle_off resumes mid-track. Driven by the controller's stream-idle
# monitor when "pause the programme when nobody is listening" is enabled.
# Both are idempotent and only log on an actual state change, so the
# controller can re-assert the desired state cheaply after a mixer restart.
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

# Skip the currently playing track. `radio` is the final broadcast source;
# .skip() propagates down through compress → fallback → rotate →
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

# Remove a PENDING request from dj_queue by request id (RID). Whatever is on
# air — or already pulled out of the queue as the next source — is no longer
# in .queue(), so it reports NOT_FOUND instead of half-removing; the caller
# treats that as "too late to cancel". Used by the controller's queue-cancel
# endpoint (DELETE /dj/queue/:trackId), which resolves the RID via
# dj_queue.queue + request.metadata first. Operator-only — listeners can't
# reach this.
server.register(
  "dj_queue_remove",
  description="Remove a pending request from dj_queue by request id",
  usage="dj_queue_remove <rid>",
  fun(arg) -> begin
    rid = string.trim(arg)
    q = dj_queue.queue()
    kept = list.filter(fun(r) -> "#{request.id(r)}" != rid, q)
    if list.length(kept) == list.length(q) then
      "NOT_FOUND"
    else
      dj_queue.set_queue(kept)
      # Destroy the dropped request so its file/URI is released now instead of
      # lingering until Liquidsoap flags it as leaked.
      list.iter(
        fun(r) -> if "#{request.id(r)}" == rid then request.destroy(r) end,
        q
      )
      log("Removed request #{rid} from dj_queue via server command")
      "OK"
    end
  end
)
