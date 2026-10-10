#!/usr/bin/env bash
# Transition-FX render harness: offline validation of the DJ sweep/washout
# against the real Liquidsoap image. `liquidsoap --check` does not catch runtime
# behaviour (native `echo` type-checks but is a no-op in this build), so the
# renders are the evidence and the WAVs are the deliverable.
#
# Usage:
#   scripts/fx-render-test.sh probe
#       Phase 0 — can filter.rc + comb be instantiated inside a cross transition
#       callback on a request.queue-backed source? Renders dry vs fx and compares
#       md5 so a silent no-op can't pass. Decides per-branch (A) vs global-bus (B).
#   scripts/fx-render-test.sh render <a-audio> <b-audio> [dry|sweep|washout|both|blend|dissolve|chop|loop]
#       Phase 1 — render the a→b transition with the production envelope logic
#       (mirrored from radio.liq) and print an RMS-over-time table. Default
#       renders every variant.
#   scripts/fx-render-test.sh xchain
#       Regression checks for distinct tracks, repeated files/jingles and
#       metadata replay; every transition must buffer its outgoing stamp.
#   scripts/fx-render-test.sh loopcheck
#       Regression check — fail if Loop's capture-pass level differs from the
#       plain transition by more than 1 dB on deterministic pink noise.
#   scripts/fx-render-test.sh loopgaps
#       Regression check — fail if Loop drops out at a repeat: any 5 ms window
#       more than 6 dB under its neighbours on a steady 1 kHz tone, for an
#       on-grid and an off-grid bar (a comb never keeps its first frame).
#   scripts/fx-render-test.sh jingleseam
#       Regression check — on A -> jingle -> B, B's entry gesture must stand
#       down on the jingle's seam yet still arm on a direct A -> B seam. Lifts
#       the arming lines, the jingle mark and the cross stamps from radio.liq.
#
# Output lands in .fx-render/ next to this script (gitignored).

set -euo pipefail

IMAGE="${LIQ_IMAGE:-savonet/liquidsoap:v2.4.5}"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$HERE/.fx-render"
mkdir -p "$WORK"

liq() { # liq <script.liq> [env FX=...]
  local script="$1"; shift
  docker run --rm --user "$(id -u):$(id -g)" -v "$WORK":/work "$@" \
    "$IMAGE" "/work/$script" 2>&1
}

gen_tones() {
  # Deterministic inputs: A = 440 Hz sine, B = 880 Hz sine, 12 s each, -12 dB.
  [ -f "$WORK/a.wav" ] || ffmpeg -v error -y -f lavfi -i "sine=frequency=440:duration=12" -af volume=-12dB -ar 44100 -ac 2 "$WORK/a.wav"
  [ -f "$WORK/b.wav" ] || ffmpeg -v error -y -f lavfi -i "sine=frequency=880:duration=12" -af volume=-12dB -ar 44100 -ac 2 "$WORK/b.wav"
}

probe() {
  gen_tones
  cat > "$WORK/probe.liq" <<'LIQ'
# Phase-0 probe: instantiate filter.rc (x2) + comb on the outgoing branch inside
# a cross transition callback over a request.queue-backed source, the exact
# topology radio.liq's per-branch effects need. FX=on closes the filter and
# raises comb feedback statically so a dry-vs-fx md5 compare proves the operators
# touch the audio at all.
settings.log.stdout := true
settings.log.level := 3

fx_on = environment.get("FX") == "on"
fx_cut = ref(9000.)
fx_fb  = ref(-90.)
if fx_on then
  fx_cut := 500.
  fx_fb  := -3.
end

q = request.queue(id="q")
q.push(request.create("/work/a.wav"))
q.push(request.create("/work/b.wav"))

def t(a, b) =
  log("PROBE: transition fired")
  d = 4.
  a_src = fade.out(duration=d, a.source)
  a_src = filter.rc(frequency={fx_cut()}, mode="low", wetness=1.,
            filter.rc(frequency={fx_cut()}, mode="low", wetness=1., a_src))
  a_src = comb(delay=0.3, feedback={fx_fb()}, a_src)
  # INCOMING branch too: the bass-swap HPF + surfacing LPF live on b — prove
  # the same operator class instantiates on the incoming side of the callback.
  b_src = fade.in(duration=d, b.source)
  b_src = filter.rc(frequency={fx_cut()}, mode="high", wetness=1.,
            filter.rc(frequency={fx_cut()}, mode="low", wetness=1., b_src))
  add(normalize=false, [a_src, b_src])
end

music = cross(duration=4., t, q)
out = environment.get("OUT")
output.file(%wav, fallible=true, "/work/#{out}", music)
clock.assign_new(sync="none", [music])
thread.run(delay=25., fun() -> shutdown())
LIQ

  echo "== probe: dry render =="
  local log_dry log_fx
  log_dry=$(liq probe.liq -e FX=off -e OUT=probe-dry.wav) || { echo "$log_dry"; echo "PROBE FAILED (dry run crashed)"; return 1; }
  echo "== probe: fx render =="
  log_fx=$(liq probe.liq -e FX=on -e OUT=probe-fx.wav) || { echo "$log_fx"; echo "PROBE FAILED (fx run crashed)"; return 1; }

  local verdict=0
  for l in "$log_dry" "$log_fx"; do
    if grep -qi "early computation" <<<"$l"; then
      echo "VERDICT: FAIL — 'Early computation of source content-type' fired. Use Approach B (global-bus)."
      verdict=1
    fi
    if ! grep -q "PROBE: transition fired" <<<"$l"; then
      echo "VERDICT: FAIL — transition callback never fired."
      verdict=1
    fi
  done
  [ "$verdict" = 0 ] || { echo "--- dry log ---"; echo "$log_dry" | tail -30; return 1; }

  local m_dry m_fx
  m_dry=$(md5sum "$WORK/probe-dry.wav" | cut -d' ' -f1)
  m_fx=$(md5sum "$WORK/probe-fx.wav" | cut -d' ' -f1)
  if [ "$m_dry" = "$m_fx" ]; then
    echo "VERDICT: FAIL — fx render is bit-identical to dry (operators are no-ops in-callback)."
    return 1
  fi
  echo "VERDICT: PASS — filter.rc + comb instantiate inside the cross callback and audibly alter the render."
  echo "  dry: $m_dry"
  echo "  fx:  $m_fx"
}

rms_table() { # rms_table <wav> — RMS per 0.5 s window so envelope shape is visible
  ffprobe -v error -f lavfi "amovie=$1,astats=metadata=1:reset=22050,ametadata=print:key=lavfi.astats.Overall.RMS_level" -show_entries frame_tags=lavfi.astats.Overall.RMS_level -of csv=p=0 2>/dev/null \
    | awk '{printf "%5.1fs  %s dB\n", NR*0.5, $0}'
}

segment_rms() { # segment_rms <wav> <start-seconds> <duration-seconds>
  ffmpeg -hide_banner -nostats -ss "$2" -t "$3" -i "$1" \
    -af astats=metadata=0:reset=0 -f null - 2>&1 \
    | awk '/Overall/{overall=1} overall && /RMS level dB/{print $NF; exit}'
}

render() {
  local a_in="$1" b_in="$2" mode="${3:-all}"
  # Normalise inputs to WAV so the container needs no codecs beyond PCM.
  # A: a mid-song slice ending where the transition fires (its "outro" here);
  # B: the track's real opening (what rises under the effect).
  ffmpeg -v error -y -ss 45 -i "$a_in" -ar 44100 -ac 2 -t 50 "$WORK/ra.wav"
  ffmpeg -v error -y -i "$b_in" -ar 44100 -ac 2 -t 40 "$WORK/rb.wav"

  cat > "$WORK/render.liq" <<'LIQ'
# Phase-1 render: the a→b transition with the production envelope logic. Keep the
# closures in lockstep with liquidsoap/radio.liq's dj_transition. Envelopes must
# be pure functions of source.elapsed() (audio time) so they render correctly
# under sync="none"; wall-clock thread envelopes do not.
settings.log.stdout := true
settings.log.level := 3

mode = environment.get("MODE")   # dry | sweep | washout | both | blend | dissolve | chop | loop
sweep_on   = mode == "sweep"   or mode == "both"
washout_on = mode == "washout" or mode == "both"
blend_on   = mode == "blend"
dissolve_on = mode == "dissolve"
chop_on    = mode == "chop"
loop_on    = mode == "loop"
loop_bar   = float_of_string(default=2.0, environment.get(default="2.0", "BAR"))

q = request.queue(id="q")
q.push(request.create("/work/ra.wav"))
q.push(request.create("/work/rb.wav"))

def t(a, b) =
  d = 12.
  log("RENDER: transition fired mode=#{mode} d=#{d}")
  a_src =
    if washout_on then
      fade.out(duration=d, type="exp", a.source)
    elsif sweep_on or chop_on then
      fade.out(duration=d, type="log", a.source)
    elsif loop_on then
      a.source
    else
      fade.out(duration=d, a.source)
    end
  a_src =
    if sweep_on then
      sweep_src = a_src
      def sweep_cut() =
        e = source.elapsed(sweep_src)
        e = if e < 0. then 0. else e end
        t_close = 0.45 * d
        t_hold  = 0.55 * d
        t_back  = 0.85 * d
        # Dive to the floor, touch it briefly, then partially re-open as the
        # incoming takes over: a sustained floor reads as "the track went quiet".
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
        9000.0 * pow(1100.0 / 9000.0, depth)
      end
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
      # Parallel dry bleed, the "never goes quiet" guarantee. Wetness on cascaded
      # stages multiplies the dry path, so a wetness cap can't hold a floor; an
      # explicit dry branch around a full-wet chain keeps 30% of the untouched
      # track in the mix however deep the cutoff dives.
      swept = filter.rc(frequency=sweep_cut, mode="low", wetness=1.,
                filter.rc(frequency=sweep_cut, mode="low", wetness=1., a_src))
      amplify(sweep_gain, add(normalize=false,
        [amplify(0.30, a_src), amplify(0.75, swept)]))
    else a_src end
  a_src =
    if blend_on then
      ha_src = a_src
      def blend_hp() =
        e = source.elapsed(ha_src)
        e = if e < 0. then 0. else e end
        t_end = 0.65 * d
        x = if e >= t_end then 1.0 else e / t_end end
        sxx = 3.0 * x * x - 2.0 * x * x * x
        30.0 * pow(1800.0 / 30.0, sxx)
      end
      blend_low = filter.rc(frequency=blend_hp, mode="low", wetness=1., a_src)
      add(normalize=false, [a_src, amplify(-1., blend_low)])
    else a_src end
  a_src =
    if washout_on then
      wash_src = a_src
      def wash_fb() =
        e = source.elapsed(wash_src)
        e = if e < 0. then 0. else e end
        fb_max = -1.0
        fb_off = -90.0
        t_swell = 0.10 * d
        t_hold  = 0.85 * d
        t_rel   = 0.97 * d
        if e < t_swell then
          x = e / t_swell
          s = 3.0 * x * x - 2.0 * x * x * x
          fb_off + s * (fb_max - fb_off)
        elsif e < t_hold then fb_max
        elsif e < t_rel then fb_max + ((e - t_hold) / (t_rel - t_hold)) * (fb_off - fb_max)
        else fb_off end
      end
      def wash_gain() =
        e = source.elapsed(wash_src)
        e = if e < 0. then 0. else e end
        g_max = 1.95
        t_from = 0.30 * d
        t_to   = 0.55 * d
        if e <= t_from then 1.0
        elsif e >= t_to then g_max
        else
          x = (e - t_from) / (t_to - t_from)
          1.0 + (3.0 * x * x - 2.0 * x * x * x) * (g_max - 1.0)
        end
      end
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
      washed = comb(delay=0.30, feedback=wash_fb, a_src)   # radio.liq's default tap
      washed = filter.rc(frequency=tail_cut, mode="low", wetness=tail_wet,
                 filter.rc(frequency=tail_cut, mode="low", wetness=tail_wet, washed))
      amplify(wash_gain, washed)
    else a_src end
  # DISSOLVE — keep in lockstep with radio.liq's dissolve block: 4 parallel
  # combs at mutually prime delays, shared swell/hold/release feedback, ONE
  # -4x dry subtraction for the whole cluster (#1565), cascaded darkening
  # lowpass, late makeup.
  a_src =
    if dissolve_on then
      diss_src = a_src
      def diss_fb() =
        e = source.elapsed(diss_src)
        e = if e < 0. then 0. else e end
        fb_max = -0.5
        fb_off = -90.0
        t_swell = 0.10 * d
        t_hold  = 0.80 * d
        t_rel   = 0.93 * d
        if e < t_swell then
          x = e / t_swell
          s = 3.0 * x * x - 2.0 * x * x * x
          fb_off + s * (fb_max - fb_off)
        elsif e < t_hold then fb_max
        elsif e < t_rel then fb_max + ((e - t_hold) / (t_rel - t_hold)) * (fb_off - fb_max)
        else fb_off end
      end
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
      washed = add(normalize=false,
        [comb(delay=0.089, feedback=diss_fb, a_src),
         comb(delay=0.113, feedback=diss_fb, a_src),
         comb(delay=0.151, feedback=diss_fb, a_src),
         comb(delay=0.181, feedback=diss_fb, a_src),
         amplify(-4., a_src)])
      washed = amplify(0.7, washed)
      washed = filter.rc(frequency=diss_cut, mode="low", wetness=diss_wet,
                 filter.rc(frequency=diss_cut, mode="low", wetness=diss_wet, washed))
      add(normalize=false, [a_src, amplify(diss_gain, washed)])
    else a_src end
  # CHOP — keep in lockstep with radio.liq's chop block: compressed clock
  # dd=min(d,10) shared with the incoming fade, accelerating gate (beat →
  # eighths → sixteenth stutter), duty shrink, floor decay, smoothstep edges
  # (frame-stepped on air), engage ramp, master release. Fixed p=0.5 here (the
  # harness has no BPM). d=12 here, so the render exercises the d > 10 case.
  chop_dd = if d > 10. then 10. else d end
  a_src =
    if chop_on then
      p = 0.5
      dd = chop_dd
      chop_src = a_src
      def chop_gain() =
        e = source.elapsed(chop_src)
        e = if e < 0. then 0. else e end
        pp =
          if e < 0.40 * dd then p
          elsif e < 0.72 * dd then 0.5 * p
          else 0.25 * p
          end
        beat = int_of_float(e / pp)
        ph = e / pp - float_of_int(beat)
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
        eps = 0.012 / pp
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
        t_eng = 0.08 * dd
        wet =
          if e >= t_eng then 1.0
          else
            x = e / t_eng
            3.0 * x * x - 2.0 * x * x * x
          end
        g = 1.0 - wet * (1.0 - g_gate)
        master =
          if e < 0.82 * dd then 1.0
          elsif e < 0.92 * dd then
            x = (e - 0.82 * dd) / (0.10 * dd)
            1.0 - (3.0 * x * x - 2.0 * x * x * x)
          else 0.0
          end
        g * master
      end
      amplify(chop_gain, a_src)
    else a_src end
  # LOOP — keep in lockstep with radio.liq's loop block: comb is a one-shot
  # feed-forward echo, so the loop is a cascade of doubling delays (taps at every
  # bar multiple), a hard dry gate after the capture pass, ride-out darkening
  # lowpass, and a complementary output ride leaving headroom for the incoming
  # fade. feedback=0.0 makes each delayed copy unity; the non-overlapping bar
  # slots need no global makeup. The bar is snapped to the frame grid and the
  # dry gate held one extra frame, because a comb never keeps its first frame
  # (radio.liq FRAME RULES). BAR defaults to 2.0 (no BPM stamp here).
  a_src =
    if loop_on then
      bar = loop_bar
      fd = frame.duration()
      bar = fd * float_of_int(int_of_float(bar / fd + 0.5))
      log("RENDER: loop bar=#{bar}")
      loop_src = a_src
      def loop_dry() =
        e = source.elapsed(loop_src)
        e = if e < 0. then 0. else e end
        if e < bar + 0.5 * fd then 1.0 else 0.0 end
      end
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
      def loop_gain() =
        e = source.elapsed(loop_src)
        e = if e < 0. then 0. else e end
        if e >= d then 0.0 else 1.0 - e / d end
      end
      gated  = amplify(loop_dry, a_src)
      looped = comb(delay=bar, feedback=0.0, gated)
      looped = comb(delay=2.0 * bar, feedback=0.0, looped)
      looped = if 4.0 * bar < d then comb(delay=4.0 * bar, feedback=0.0, looped) else looped end
      looped = if 8.0 * bar < d then comb(delay=8.0 * bar, feedback=0.0, looped) else looped end
      looped = filter.rc(frequency=loop_cut, mode="low", wetness=loop_wet,
                 filter.rc(frequency=loop_cut, mode="low", wetness=loop_wet, looped))
      amplify(loop_gain, looped)
    else a_src end
  b_fade = if chop_on then chop_dd else d end
  b_src = fade.in(duration=b_fade, b.source)
  b_src =
    if blend_on then
      bin_src = b_src
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
    else b_src end
  b_src =
    if sweep_on then
      in_src = b_src
      def surf_cut() =
        e = source.elapsed(in_src)
        e = if e < 0. then 0. else e end
        t_open = 0.30 * d
        x = if e >= t_open then 1.0 else e / t_open end
        s = 3.0 * x * x - 2.0 * x * x * x
        500.0 * pow(9000.0 / 500.0, s)
      end
      def surf_wet() =
        e = source.elapsed(in_src)
        e = if e < 0. then 0. else e end
        t_from = 0.20 * d
        t_to   = 0.32 * d
        x = if e <= t_from then 0.0 elsif e >= t_to then 1.0 else (e - t_from) / (t_to - t_from) end
        1.0 - (3.0 * x * x - 2.0 * x * x * x)
      end
      def bass_amt() =
        e = source.elapsed(in_src)
        e = if e < 0. then 0. else e end
        t_from = 0.38 * d
        t_to   = 0.55 * d
        x = if e <= t_from then 0.0 elsif e >= t_to then 1.0 else (e - t_from) / (t_to - t_from) end
        0.0 - (1.0 - (3.0 * x * x - 2.0 * x * x * x))
      end
      bsf = filter.rc(frequency=surf_cut, mode="low", wetness=surf_wet,
              filter.rc(frequency=surf_cut, mode="low", wetness=surf_wet, in_src))
      bsf_low = filter.rc(frequency=160., mode="low", wetness=1., bsf)
      add(normalize=false, [bsf, amplify(bass_amt, bsf_low)])
    else b_src end
  add(normalize=false, [a_src, b_src])
end

music = cross(duration=12., t, (q:source))
out = environment.get("OUT")
output.file(%wav, fallible=true, "/work/#{out}", music)
clock.assign_new(sync="none", [music])
thread.run(delay=40., fun() -> shutdown())
LIQ

  local modes
  case "$mode" in
    all) modes="dry sweep washout both blend dissolve chop loop" ;;
    loopcheck) modes="dry loop" ;;
    *)   modes="$mode" ;;
  esac
  for m in $modes; do
    echo "== render: $m =="
    liq render.liq -e MODE="$m" -e BAR="${BAR:-2.0}" -e OUT="render-$m.wav" | grep -Ei "RENDER:|error|early computation" || true
    echo "--- RMS over time ($m) — transition region ---"
    rms_table "$WORK/render-$m.wav" 2>/dev/null | sed -n '90,140p' || true
    echo "wav: $WORK/render-$m.wav"
  done

  if [ "$mode" = loopcheck ]; then
    # ra.wav is 50s and cross() buffers its final 12s, so the transition starts
    # at 38s. The first 2s are Loop's capture pass (bar=2.0 in this harness).
    local dry_rms loop_rms delta
    dry_rms=$(segment_rms "$WORK/render-dry.wav" 38 2)
    loop_rms=$(segment_rms "$WORK/render-loop.wav" 38 2)
    [ -n "$dry_rms" ] && [ -n "$loop_rms" ] || { echo "LOOPCHECK FAIL — could not measure rendered RMS"; return 1; }
    delta=$(awk -v loop="$loop_rms" -v dry="$dry_rms" 'BEGIN { printf "%.2f", loop - dry }')
    printf 'Loop capture-pass RMS: dry=%s dB loop=%s dB delta=%s dB\n' "$dry_rms" "$loop_rms" "$delta"
    awk -v delta="$delta" 'BEGIN { if (delta < 0) delta = -delta; exit !(delta <= 1.0) }' \
      || { echo "LOOPCHECK FAIL — capture-pass level differs from plain crossfade by more than 1 dB"; return 1; }
    echo "LOOPCHECK PASS — capture-pass level is within 1 dB of plain crossfade"
  fi
}

loopcheck() {
  ffmpeg -v error -y -f lavfi -i "anoisesrc=color=pink:amplitude=0.1:duration=100:seed=1407" \
    -ar 44100 -ac 2 "$WORK/loopcheck-a.wav"
  ffmpeg -v error -y -f lavfi -i "anoisesrc=color=pink:amplitude=0.1:duration=45:seed=1408" \
    -ar 44100 -ac 2 "$WORK/loopcheck-b.wav"
  render "$WORK/loopcheck-a.wav" "$WORK/loopcheck-b.wav" loopcheck
}

xdur() {
  # Which track's liq_cross_duration governs a transition? Stamp 12s on the
  # outgoing track against a cross default of 4s: a callback logging d=12 for a→b
  # with a 78s output proves a track's stamp governs its OWN end. The washout
  # canvas stands on this (the queue computes prev→item compatibility, but the
  # stamp rules item→next).
  gen_tones
  ffmpeg -v error -y -i "$WORK/a.wav" -t 50 -af apad=whole_dur=50 "$WORK/ra.wav"
  ffmpeg -v error -y -i "$WORK/b.wav" -t 40 -af apad=whole_dur=40 "$WORK/rb.wav"
  cat > "$WORK/xdur.liq" <<'LIQ'
settings.log.stdout := true
settings.log.level := 3
q = request.queue(id="q")
q.push(request.create('annotate:liq_cross_duration="12":/work/ra.wav'))
q.push(request.create("/work/rb.wav"))
def t(a, b) =
  d = float_of_string(default=4., a.metadata["liq_cross_duration"])
  log("XDUR: transition d=#{d} (a stamped 12, default 4)")
  add(normalize=false, [fade.out(duration=d, a.source), fade.in(duration=d, b.source)])
end
music = cross(duration=4., persist_override=true, t, q)
output.file(%wav, fallible=true, "/work/xdur.wav", music)
clock.assign_new(sync="none", [music])
thread.run(delay=30., fun() -> shutdown())
LIQ
  local log duration
  log=$(liq xdur.liq)
  echo "$log" | grep -E "XDUR|rror" || true
  grep -q "XDUR: transition d=12.0" <<<"$log" \
    || { echo "XDUR FAIL — the outgoing track's duration stamp did not reach its transition"; return 1; }
  duration=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$WORK/xdur.wav")
  echo "output duration (78 = buffer followed a's stamp; 86 = it didn't):"
  echo "$duration"
  awk -v duration="$duration" 'BEGIN { exit !(duration >= 77.9 && duration <= 78.1) }' \
    || { echo "XDUR FAIL — output duration shows the stamped outgoing buffer was not retained"; return 1; }
  echo "XDUR PASS — the outgoing track owns its stamped end-of-track buffer"
}

xchain() {
  # Do cross's buffers follow each track's OWN stamp along a chain? Two tracks
  # (xdur) cannot see it: the 2.4.5 lag only shows from the third transition on,
  # where each tail used to be sized by the stamp of the track two back. Five
  # tones with distinct stamps run through the OLD wiring (raw
  # liq_cross_duration) and the NEW one (cross_stamps + strip_cross_stamps,
  # lifted verbatim from radio.liq so the harness cannot drift from the mixer).
  # Repeated files are new airings, while injected metadata repeats within an
  # airing must retain its original incoming stamp. Unstamped jingles use the
  # station default. Expected durations come from the input, not the rewrite.
  local f
  for f in 1 2 3 4 5; do
    [ -f "$WORK/x$f.wav" ] || ffmpeg -v error -y -f lavfi -i "sine=frequency=$((220 + f * 110)):duration=30" -af volume=-12dB -ar 44100 -ac 2 "$WORK/x$f.wav"
  done
  awk '/^cross_prev_end = ref/{on=1} /^# BUFFER SIZING/{on=0} on' "$HERE/../liquidsoap/radio.liq" > "$WORK/xchain-stamps.liq"
  grep -q "def strip_cross_stamps" "$WORK/xchain-stamps.liq" \
    || { echo "XCHAIN FAIL — could not lift cross_stamps/strip_cross_stamps out of radio.liq"; return 1; }
  cat > "$WORK/xchain.liq" <<'LIQ'
settings.log.stdout := true
settings.log.level := 3
crossfade_duration = ref(5.0)
mode = environment.get(default="new", "MODE")
scenario = environment.get(default="distinct", "SCENARIO")
q = request.queue(id="q")
repeated = scenario == "repeated-file" or scenario == "repeated-jingle"
jingles = scenario == "repeated-jingle"
tracks = [
  ("x1", "/work/x1.wav", "4"),
  ("x2", "/work/x2.wav", if jingles then "" else "9" end),
  ("x3", if repeated then "/work/x2.wav" else "/work/x3.wav" end,
         if jingles then "" else "3" end),
  ("x4", "/work/x4.wav", "7"),
  ("x5", "/work/x5.wav", "6")
]
list.iter(fun ((title, fname, stamp)) -> begin
  expected = if stamp == "" then string(crossfade_duration()) else stamp end
  uri = 'annotate:title="#{title}",liq_cross_duration="#{stamp}",expected_cross="#{expected}":#{fname}'
  ignore(q.push(request.create(uri)))
end, tracks)
if scenario == "metadata-replay" then
  q.on_position(position=1., synchronous=true, fun (_, m) -> begin
    log("XCHAIN REPLAY: #{m['title']}")
    q.insert_metadata(new_track=false, m)
  end)
end
%include "/work/xchain-stamps.liq"
def t(a, b) =
  key = if mode == "new" then "liq_cross_end_duration" else "liq_cross_duration" end
  stamp = float_of_string(default=crossfade_duration(), a.metadata[key])
  expected = float_of_string(default=crossfade_duration(), a.metadata["expected_cross"])
  ra = source.remaining(a.source)
  rb = source.remaining(b.source)
  if b.metadata["title"] != "" then
    log("XCHAIN: #{a.metadata['title']} -> #{b.metadata['title']} expected=#{expected} stamp=#{stamp} a_buf=#{ra} b_buf=#{rb}")
  end
  d = if mode == "new" then min(ra, rb) else stamp end
  out = add(normalize=false, [fade.out(duration=d, initial_metadata=a.metadata, a.source),
                              fade.in(duration=d, initial_metadata=b.metadata, b.source)])
  if mode == "new" then strip_cross_stamps(out) else out end
end
music = if mode == "new" then metadata.map(update=true, strip=true, cross_stamps, q) else q end
music = cross(duration=crossfade_duration(), persist_override=true, t, music)
output.file(%wav, fallible=true, "/work/xchain-#{scenario}-#{mode}.wav", music)
clock.assign_new(sync="none", [music])
thread.run(delay=25., fun() -> shutdown())
LIQ
  local scenario m log bad=0
  for scenario in distinct repeated-file repeated-jingle metadata-replay; do
    for m in old new; do
      # The old distinct chain is the reference for the original buffer lag.
      [ "$m" = new ] || [ "$scenario" = distinct ] || continue
      echo "== $scenario ($m)"
      log=$(liq xchain.liq -e MODE=$m -e SCENARIO=$scenario) || { echo "$log"; return 1; }
      echo "$log" | grep -E "XCHAIN:|XCHAIN REPLAY:|rror" || true
      if [ "$m" = new ]; then
        # Buffers sit one 0.02 s frame under the stamp at most.
        echo "$log" | grep "XCHAIN:" | awk '{
          for (i = 1; i <= NF; i++) { split($i, kv, "="); v[kv[1]] = kv[2] }
          if (v["stamp"] != v["expected"] || v["a_buf"] < v["expected"] - 0.05 || v["a_buf"] > v["expected"] + 0.05 || v["b_buf"] < v["expected"] - 0.05 || v["b_buf"] > v["expected"] + 0.05) bad++
          n++
        } END { exit !(n == 4 && bad == 0) }' || bad=1
        if [ "$scenario" = metadata-replay ]; then
          [ "$(echo "$log" | grep -c 'XCHAIN REPLAY:')" = 5 ] || bad=1
        fi
      fi
    done
  done
  [ "$bad" = 0 ] || { echo "XCHAIN FAIL — a transition did not buffer its outgoing track's own stamp"; return 1; }
  echo "XCHAIN PASS — every transition buffers its outgoing stamp on both sides"
}

loopgaps() {
  # A steady tone makes every repeat seam visible: a clean tape loop holds a
  # flat envelope (only the slow ride-out), a dropout reads as a hole. ra.wav
  # is 50s and cross() buffers its final 12s, so the transition starts at 38s;
  # the window stops at 80% of d, before the ride-out has taken the level down.
  ffmpeg -v error -y -f lavfi -i "sine=frequency=1000:duration=100" -af volume=-12dB \
    -ar 44100 -ac 2 "$WORK/loopgaps-a.wav"
  ffmpeg -v error -y -f lavfi -i "anullsrc=r=44100:cl=stereo" -t 45 "$WORK/loopgaps-b.wav"
  local bar holes bad=0
  for bar in 2.0 1.87; do
    BAR="$bar" render "$WORK/loopgaps-a.wav" "$WORK/loopgaps-b.wav" loop >/dev/null
    holes=$(ffprobe -v error -f lavfi \
      "amovie=$WORK/render-loop.wav,atrim=start=38:end=47.6,asetnsamples=n=220:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level" \
      -show_entries frame_tags=lavfi.astats.Overall.RMS_level -of csv=p=0 2>/dev/null \
      | awk '{ v[NR] = ($0 ~ /inf/) ? -200 : $0 + 0 }
             END {
               n = 0
               for (i = 11; i <= NR - 10; i++) {
                 m = -999
                 for (j = i - 10; j <= i + 10; j++) if (v[j] > m) m = v[j]
                 if (v[i] < m - 6) n++
               }
               print n
             }')
    printf 'Loop bar=%s: %s window(s) of 5 ms more than 6 dB under their neighbours\n' "$bar" "$holes"
    [ "$holes" = 0 ] || bad=1
  done
  [ "$bad" = 0 ] || { echo "LOOPGAPS FAIL — the loop drops out at a repeat seam"; return 1; }
  echo "LOOPGAPS PASS — every repeat seam is gapless"
}

jingleseam() {
  # A stinger sits upstream of cross, so on A -> J -> B the J -> B seam reads
  # B's entry flag. The arming lines, the jingle mark and the cross-stamp
  # rewrite are LIFTED from radio.liq so the harness cannot drift from the
  # mixer; each seam logs what it armed.
  gen_tones
  awk '/^cross_prev_end = ref/{on=1} /^# BUFFER SIZING/{on=0} on' "$HERE/../liquidsoap/radio.liq" > "$WORK/jseam-stamps.liq"
  grep -E '^  (boundary_fading|jingle_out|washing|looping|sweeping|dissolving|chopping|blending) = ' \
    "$HERE/../liquidsoap/radio.liq" > "$WORK/jseam-arming.liq"
  local mark
  mark=$(grep -m1 -oE 'metadata\.map\(update=true, fun \(_\) -> \[\("subwave_jingle", "true"\)\]' "$HERE/../liquidsoap/radio.liq")
  [ "$(wc -l < "$WORK/jseam-arming.liq")" = 8 ] && [ -n "$mark" ] && grep -q "def cross_stamps" "$WORK/jseam-stamps.liq" \
    || { echo "JINGLESEAM FAIL — could not lift the arming lines / jingle mark / cross stamps from radio.liq"; return 1; }
  {
    cat <<'LIQ'
settings.log.stdout := true
settings.log.level := 3
crossfade_duration = ref(3.0)
scenario = environment.get(default="jingle", "SCENARIO")
# single() resolves a static file before the clock starts; a request.queue
# resolves asynchronously and `sequence` skips one that is not ready yet,
# which reorders the seams from run to run.
sa = once(single('annotate:title="A":/work/a.wav'))
sb = once(single('annotate:title="B",liq_sweep="true":/work/b.wav'))
sj = once(single('annotate:title="J":/work/a.wav'))
LIQ
    echo "jingle = ${mark}, sj)"
    cat <<'LIQ'
music = if scenario == "jingle" then sequence([sa, jingle, sb]) else sequence([sa, sb]) end
%include "/work/jseam-stamps.liq"
def t(a, b) =
%include "/work/jseam-arming.liq"
  log("JSEAM: #{a.metadata['title']} -> #{b.metadata['title']} jingle_out=#{jingle_out} sweeping=#{sweeping} chopping=#{chopping} dissolving=#{dissolving} blending=#{blending}")
  d = min(source.remaining(a.source), source.remaining(b.source))
  add(normalize=false, [fade.out(duration=d, a.source), fade.in(duration=d, b.source)])
end
music = metadata.map(update=true, strip=true, cross_stamps, music)
music = cross(duration=crossfade_duration(), persist_override=true, t, music)
output.file(%wav, fallible=true, on_stop=shutdown, "/work/jseam.wav", music)
clock.assign_new(sync="none", [music])
LIQ
  } > "$WORK/jseam.liq"
  local log_j log_d
  log_j=$(liq jseam.liq -e SCENARIO=jingle) || { echo "$log_j"; return 1; }
  log_d=$(liq jseam.liq -e SCENARIO=direct) || { echo "$log_d"; return 1; }
  echo "$log_j" "$log_d" | grep -E "JSEAM:|rror" | grep -v "loading cache" || true
  grep -q "JSEAM: A -> J jingle_out=false sweeping=false" <<<"$log_j" \
    && grep -q "JSEAM: J -> B jingle_out=true sweeping=false chopping=false dissolving=false blending=false" <<<"$log_j" \
    && grep -q "JSEAM: A -> B jingle_out=false sweeping=true" <<<"$log_d" \
    || { echo "JINGLESEAM FAIL — an entry gesture fired on the jingle's seam, or stopped arming on a direct one"; return 1; }
  echo "JINGLESEAM PASS — the jingle's seam is a plain fade; the direct seam still arms B's sweep"
}

case "${1:-}" in
  probe)  probe ;;
  render) shift; render "$@" ;;
  loopcheck) loopcheck ;;
  loopgaps) loopgaps ;;
  jingleseam) jingleseam ;;
  xdur)   xdur ;;
  xchain) xchain ;;
  *) echo "usage: $0 probe | render <a-audio> <b-audio> [dry|sweep|washout|both|blend|dissolve|chop|loop|all] | loopcheck | loopgaps | jingleseam | xdur | xchain"; exit 2 ;;
esac
