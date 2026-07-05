#!/usr/bin/env bash
# Transition-FX render harness — offline validation of the DJ sweep/washout
# against the real Liquidsoap image (the one the broadcast container runs).
#
# Why this exists: `liquidsoap --check` lies about runtime behaviour — the
# native `echo` operator type-checks but is a verified NO-OP in this build,
# and the "Early computation of source content-type" crash only appears at
# runtime. Envelope tuning is by-ear work that will recur, so the renders are
# repeatable and the WAVs are the deliverable.
#
# Usage:
#   scripts/fx-render-test.sh probe
#       Phase 0 — can filter.rc + comb be instantiated INSIDE a cross
#       transition callback on a request.queue-backed source? (The historical
#       crash was with iir_filter/HPF; these two operators were unproven
#       either way.) Renders dry vs fx and compares md5 so a silent no-op
#       (like `echo`) can't pass. Decides per-branch (A) vs global-bus (B).
#   scripts/fx-render-test.sh render <a-audio> <b-audio> [dry|sweep|washout|both|blend|dissolve|chop]
#       Phase 1 — render the a→b transition with the production envelope
#       logic (mirrored from radio.liq) and print an RMS-over-time table.
#       Default renders every variant.
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
# Phase-0 probe: instantiate filter.rc (x2) + comb on the OUTGOING branch
# inside a cross transition callback, over a request.queue-backed source —
# the exact topology radio.liq's per-branch effects need. FX=on closes the
# filter and raises the comb feedback statically so a dry-vs-fx md5 compare
# proves the operators actually touch the audio (native `echo` taught us
# type-checking is not enough).
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

render() {
  local a_in="$1" b_in="$2" mode="${3:-all}"
  # Normalise inputs to WAV so the container needs no codecs beyond PCM.
  # A: a mid-song slice ending where the transition fires (its "outro" here);
  # B: the track's real opening (what rises under the effect).
  ffmpeg -v error -y -ss 45 -i "$a_in" -ar 44100 -ac 2 -t 50 "$WORK/ra.wav"
  ffmpeg -v error -y -i "$b_in" -ar 44100 -ac 2 -t 40 "$WORK/rb.wav"

  cat > "$WORK/render.liq" <<'LIQ'
# Phase-1 render: the a→b transition with the PRODUCTION envelope logic —
# keep the closures in lockstep with liquidsoap/radio.liq's dj_transition.
# Envelopes are pure functions of source.elapsed() on the transition branch
# (audio time), so they render correctly under sync="none" — wall-clock
# thread envelopes do NOT (found while building this harness).
settings.log.stdout := true
settings.log.level := 3

mode = environment.get("MODE")   # dry | sweep | washout | both | blend | dissolve | chop
sweep_on   = mode == "sweep"   or mode == "both"
washout_on = mode == "washout" or mode == "both"
blend_on   = mode == "blend"
dissolve_on = mode == "dissolve"
chop_on    = mode == "chop"

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
    else
      fade.out(duration=d, a.source)
    end
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
    if sweep_on then
      sweep_src = a_src
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
      # PARALLEL DRY BLEED — the "never goes quiet" guarantee. Wetness on
      # cascaded stages multiplies the dry path (0.35 × 0.35 ≈ 12% ≈ −18 dB),
      # which is why every wetness-cap attempt still cratered the mid-band.
      # An explicit dry branch around a full-wet chain gives a HARD floor:
      # 30% of the untouched track always reaches the mix (≈ −10 dB, ≈ −8 dB
      # after makeup), no matter how deep the cutoff dives.
      swept = filter.rc(frequency=sweep_cut, mode="low", wetness=1.,
                filter.rc(frequency=sweep_cut, mode="low", wetness=1., a_src))
      amplify(sweep_gain, add(normalize=false,
        [amplify(0.30, a_src), amplify(0.75, swept)]))
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
      washed = comb(delay=0.28, feedback=wash_fb, a_src)
      washed = filter.rc(frequency=tail_cut, mode="low", wetness=tail_wet,
                 filter.rc(frequency=tail_cut, mode="low", wetness=tail_wet, washed))
      amplify(wash_gain, washed)
    else a_src end
  # DISSOLVE — keep in lockstep with radio.liq's dissolve block: 4 parallel
  # combs at mutually prime delays, shared swell/hold/release feedback,
  # cascaded darkening lowpass, late makeup.
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
      def pure_tail(tap) =
        add(normalize=false,
          [comb(delay=tap, feedback=diss_fb, a_src), amplify(-1., a_src)])
      end
      washed = add(normalize=false,
        [amplify(0.7, pure_tail(0.089)), amplify(0.7, pure_tail(0.113)),
         amplify(0.7, pure_tail(0.151)), amplify(0.7, pure_tail(0.181))])
      washed = filter.rc(frequency=diss_cut, mode="low", wetness=diss_wet,
                 filter.rc(frequency=diss_cut, mode="low", wetness=diss_wet, washed))
      add(normalize=false, [a_src, amplify(diss_gain, washed)])
    else a_src end
  # CHOP — keep in lockstep with radio.liq's chop block: beat-synced gate
  # (duty shrink → floor decay → exit sparsening), 12 ms smoothstep edges,
  # engage ramp, master release. Fixed p=0.5 here (the harness has no BPM).
  a_src =
    if chop_on then
      p = 0.5
      chop_src = a_src
      def chop_gain() =
        e = source.elapsed(chop_src)
        e = if e < 0. then 0. else e end
        beat = int_of_float(e / p)
        ph = e / p - float_of_int(beat)
        t1 = 0.25 * d
        t2 = 0.70 * d
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
        f_end = 0.40 * d
        floor_g =
          if e >= f_end then 0.0
          else
            x = e / f_end
            0.45 * (1.0 - (3.0 * x * x - 2.0 * x * x * x))
          end
        odd = beat - 2 * (beat / 2) == 1
        gate_on = not (e >= t2 and odd)
        eps = 0.012 / p
        shape =
          if not gate_on then 0.0
          elsif ph < eps then
            x = ph / eps
            3.0 * x * x - 2.0 * x * x * x
          elsif ph < duty then 1.0
          elsif ph < duty + eps then
            x = (ph - duty) / eps
            1.0 - (3.0 * x * x - 2.0 * x * x * x)
          else 0.0
          end
        g_gate = floor_g + (1.0 - floor_g) * shape
        t_eng = 0.08 * d
        wet =
          if e >= t_eng then 1.0
          else
            x = e / t_eng
            3.0 * x * x - 2.0 * x * x * x
          end
        g = 1.0 - wet * (1.0 - g_gate)
        master =
          if e < 0.85 * d then 1.0
          elsif e < 0.92 * d then
            x = (e - 0.85 * d) / (0.07 * d)
            1.0 - (3.0 * x * x - 2.0 * x * x * x)
          else 0.0
          end
        g * master
      end
      amplify(chop_gain, a_src)
    else a_src end
  b_src = fade.in(duration=d, b.source)
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
    all) modes="dry sweep washout both blend dissolve chop" ;;
    *)   modes="$mode" ;;
  esac
  for m in $modes; do
    echo "== render: $m =="
    liq render.liq -e MODE="$m" -e OUT="render-$m.wav" | grep -Ei "RENDER:|error|early computation" || true
    echo "--- RMS over time ($m) — transition region ---"
    rms_table "$WORK/render-$m.wav" 2>/dev/null | sed -n '90,140p' || true
    echo "wav: $WORK/render-$m.wav"
  done
}

xdur() {
  # Which track's liq_cross_duration governs a transition? Stamp 12s on the
  # OUTGOING track against a cross default of 4s: if the callback logs d=12
  # for a→b and the output is 78s (50 − 12 + 40 — a 12s buffer at a's end),
  # a track's stamp governs its OWN end. This is the assumption the washout
  # canvas stands on, and the proof of the feature-1 off-by-one (the queue
  # computes prev→item compatibility but the stamp rules item→next).
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
music = cross(duration=4., t, q)
output.file(%wav, fallible=true, "/work/xdur.wav", music)
clock.assign_new(sync="none", [music])
thread.run(delay=30., fun() -> shutdown())
LIQ
  liq xdur.liq | grep -E "XDUR|rror" || true
  echo "output duration (78 = buffer followed a's stamp; 86 = it didn't):"
  ffprobe -v error -show_entries format=duration -of csv=p=0 "$WORK/xdur.wav"
}

case "${1:-}" in
  probe)  probe ;;
  render) shift; render "$@" ;;
  xdur)   xdur ;;
  *) echo "usage: $0 probe | render <a-audio> <b-audio> [dry|sweep|washout|both|blend|dissolve|chop|all] | xdur"; exit 2 ;;
esac
