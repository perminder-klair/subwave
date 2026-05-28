#!/usr/bin/env python3
"""Analyse the SUB/WAVE events.jsonl timeline and print a diagnostic digest.

The controller writes one JSON object per line to state/logs/events-YYYY-MM-DD.jsonl.
Event types: trace.start, trace.end, llm, tool, navidrome, track.play,
pick.rejected, session.start, session.end. Events made inside a withTrace() scope carry a
shared traceId, so a DJ decision and the Navidrome/tool calls it triggered can
be read back as one trace.

This script aggregates that stream into three lenses — Navidrome usage,
picker/DJ quality, and health anomalies — and prints a plain-text digest. It
reports numbers and patterns; interpretation and recommendations are the
caller's job (see SKILL.md).

Usage:
    python analyze_events.py [--state-dir DIR] [--since 24h] [--day YYYY-MM-DD]

    --state-dir  Path to the SUB/WAVE state dir (default: ./state, then
                 ../state — so it works from the repo root or controller/).
    --since      Only events newer than this window: e.g. 6h, 24h, 3d, 1w.
                 Omit to analyse everything in the loaded files.
    --day        Analyse only events-<day>.jsonl (default: every events-*.jsonl).
"""

import argparse
import glob
import json
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone


# --------------------------------------------------------------------------
# Loading
# --------------------------------------------------------------------------

def find_state_dir(explicit):
    """Locate the state dir. Explicit wins; otherwise probe the usual spots."""
    candidates = [explicit] if explicit else ["state", "../state", "subwave/state"]
    for c in candidates:
        if c and os.path.isdir(os.path.join(c, "logs")):
            return c
        if c and os.path.isdir(c) and glob.glob(os.path.join(c, "events-*.jsonl")):
            return c
    return explicit or "state"


def parse_since(spec):
    """'24h' / '3d' / '1w' -> a UTC cutoff datetime, or None."""
    if not spec:
        return None
    m = re.fullmatch(r"(\d+)\s*([hdw])", spec.strip().lower())
    if not m:
        sys.exit(f"--since: expected something like 24h, 3d, 1w (got {spec!r})")
    n, unit = int(m.group(1)), m.group(2)
    delta = {"h": timedelta(hours=n), "d": timedelta(days=n), "w": timedelta(weeks=n)}[unit]
    return datetime.now(timezone.utc) - delta


def load_events(state_dir, day, cutoff):
    """Read and time-filter every events line. Malformed lines are skipped."""
    logs = os.path.join(state_dir, "logs")
    if day:
        paths = [os.path.join(logs, f"events-{day}.jsonl")]
    else:
        paths = sorted(glob.glob(os.path.join(logs, "events-*.jsonl")))
    events, skipped, files_read = [], 0, []
    for p in paths:
        if not os.path.isfile(p):
            continue
        files_read.append(os.path.basename(p))
        with open(p, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    skipped += 1
                    continue
                if cutoff:
                    t = ev.get("t")
                    if t:
                        try:
                            when = datetime.fromisoformat(t.replace("Z", "+00:00"))
                            if when < cutoff:
                                continue
                        except ValueError:
                            pass
                events.append(ev)
    return events, skipped, files_read


# --------------------------------------------------------------------------
# Small stat helpers
# --------------------------------------------------------------------------

def pctl(values, p):
    """Nearest-rank percentile of a list of numbers."""
    if not values:
        return 0
    s = sorted(values)
    k = max(0, min(len(s) - 1, int(round((p / 100) * len(s) + 0.5)) - 1))
    return s[k]


def avg(values):
    return sum(values) / len(values) if values else 0


def bar(n, total, width=24):
    """A tiny text bar for at-a-glance proportions."""
    if total <= 0:
        return ""
    filled = int(round(width * n / total))
    return "█" * filled + "·" * (width - filled)


def section(title):
    print()
    print("=" * 70)
    print(title)
    print("=" * 70)


# --------------------------------------------------------------------------
# Analysis
# --------------------------------------------------------------------------

def build_traces(events):
    """Group events by traceId. Returns {traceId: {kind, ok, ms, events:[...]}}."""
    traces = defaultdict(lambda: {"kind": None, "ok": None, "ms": None, "events": [],
                                  "error": None, "start_t": None})
    for ev in events:
        tid = ev.get("traceId")
        if not tid:
            continue
        tr = traces[tid]
        tr["events"].append(ev)
        if ev.get("type") == "trace.start":
            tr["kind"] = ev.get("kind")
            tr["start_t"] = ev.get("t")
        elif ev.get("type") == "trace.end":
            tr["ok"] = ev.get("ok")
            tr["ms"] = ev.get("ms")
            tr["error"] = ev.get("error")
            if tr["kind"] is None:
                tr["kind"] = ev.get("kind")
    return traces


def report_overview(events, files_read, skipped):
    section("OVERVIEW")
    by_type = Counter(ev.get("type", "?") for ev in events)
    times = sorted(ev["t"] for ev in events if ev.get("t"))
    print(f"Files analysed : {', '.join(files_read) or '(none)'}")
    if skipped:
        print(f"Malformed lines: {skipped} skipped")
    if times:
        print(f"Time span      : {times[0]}  ->  {times[-1]}")
    print(f"Total events   : {len(events)}")
    for t in ("track.play", "trace.start", "llm", "tool", "navidrome",
              "pick.rejected", "session.start"):
        if by_type.get(t):
            print(f"  {t:<14}: {by_type[t]}")
    sessions = [ev for ev in events if ev.get("type") == "session.start"]
    if sessions:
        print(f"DJ sessions    : {len(sessions)}")
        for s in sessions[-5:]:
            print(f"  - {s.get('kind','?'):<5} {s.get('key','?')}")


def report_navidrome(events, traces):
    section("NAVIDROME / SUBSONIC USAGE")
    nav = [ev for ev in events if ev.get("type") == "navidrome"]
    if not nav:
        print("No Navidrome calls in this window.")
        return
    total = len(nav)
    errors = sum(1 for e in nav if not e.get("ok"))
    traced = sum(1 for e in nav if e.get("traceId"))
    print(f"Total calls    : {total}   errors: {errors}   "
          f"({100*errors/total:.0f}% error rate)")
    print(f"Inside a trace : {traced}/{total} "
          f"({100*traced/total:.0f}%)  — the rest are boot / context warm-up")

    # Per-endpoint breakdown.
    by_ep = defaultdict(list)
    ep_err = Counter()
    for e in nav:
        by_ep[e.get("endpoint", "?")].append(e.get("ms", 0) or 0)
        if not e.get("ok"):
            ep_err[e.get("endpoint", "?")] += 1
    print()
    print(f"{'endpoint':<22}{'calls':>7}{'err':>5}{'avg ms':>9}{'p95 ms':>9}{'max ms':>9}")
    print("-" * 70)
    for ep, ms in sorted(by_ep.items(), key=lambda kv: -len(kv[1])):
        print(f"{ep:<22}{len(ms):>7}{ep_err[ep]:>5}"
              f"{avg(ms):>9.0f}{pctl(ms,95):>9.0f}{max(ms):>9.0f}")

    # Pool breadth — how much of the library is actually surfacing.
    song_returns = Counter()
    song_name = {}
    for e in nav:
        for s in e.get("songIds", []) or []:
            sid = s.get("id")
            if sid:
                song_returns[sid] += 1
                song_name[sid] = f"{s.get('artist','?')} — {s.get('title','?')}"
    if song_returns:
        distinct = len(song_returns)
        total_returns = sum(song_returns.values())
        print()
        print(f"Pool breadth   : {distinct} distinct songs returned across "
              f"{total_returns} result slots")
        print("  Most-returned songs (a short head = the picker sees a narrow slice):")
        for sid, c in song_returns.most_common(10):
            print(f"    {c:>3}x  {song_name.get(sid,'?')}")

    # Redundant calls — identical endpoint+params hit repeatedly. The picker
    # memoises for 30 min, so genuine repeats here are cache misses worth noting.
    repeat = Counter()
    for e in nav:
        key = (e.get("endpoint"), json.dumps(e.get("params") or {}, sort_keys=True))
        repeat[key] += 1
    dups = [(k, c) for k, c in repeat.items() if c > 2]
    if dups:
        print()
        print("  Repeated identical calls (same endpoint + params, >2x):")
        for (ep, params), c in sorted(dups, key=lambda kv: -kv[1])[:8]:
            p = params if len(params) < 60 else params[:57] + "..."
            print(f"    {c:>3}x  {ep}  {p}")


def report_picker(events, traces):
    section("PICKER / DJ QUALITY")
    pick_traces = {tid: tr for tid, tr in traces.items()
                   if tr["kind"] == "track-event"}
    req_traces = {tid: tr for tid, tr in traces.items() if tr["kind"] == "request"}

    if pick_traces:
        nav_counts, tool_counts, durations = [], [], []
        agent_ok = agent_fallback = agent_off = agent_rejected = 0
        for tr in pick_traces.values():
            evs = tr["events"]
            nav_counts.append(sum(1 for e in evs if e.get("type") == "navidrome"))
            tool_counts.append(sum(1 for e in evs if e.get("type") == "tool"))
            if tr["ms"] is not None:
                durations.append(tr["ms"])
            # The agent's LLM call can succeed (ok:true) yet return a track id
            # that wasn't in the candidate set — dj-agent then rejects it and
            # falls back to the pool. That rejection is logged as a distinct
            # `pick.rejected` event; without checking for it, an invalid-id pick
            # counts as "agent succeeded" and the success rate is overstated.
            rejected = any(e.get("type") == "pick.rejected" for e in evs)
            llm_picks = [e for e in evs if e.get("type") == "llm"
                         and e.get("kind") == "djAgentPick"]
            if not llm_picks:
                agent_off += 1            # pickerAgent disabled — pool picker only
            elif rejected:
                agent_rejected += 1       # LLM ok, but returned an unknown id → pool
            elif all(p.get("ok") for p in llm_picks):
                agent_ok += 1
            else:
                agent_fallback += 1       # the LLM call itself errored → pool
        n = len(pick_traces)
        print(f"Track-pick decisions : {n}")
        print(f"  avg Navidrome calls / decision : {avg(nav_counts):.1f}  "
              f"(max {max(nav_counts) if nav_counts else 0})")
        print(f"  avg tool calls / decision      : {avg(tool_counts):.1f}  "
              f"(max {max(tool_counts) if tool_counts else 0})")
        if durations:
            print(f"  decision latency               : avg {avg(durations):.0f} ms, "
                  f"p95 {pctl(durations,95):.0f} ms, max {max(durations):.0f} ms")
        print(f"  agent succeeded   : {agent_ok}/{n}   {bar(agent_ok, n)}")
        if agent_rejected:
            print(f"  agent invalid id  : {agent_rejected}/{n}   {bar(agent_rejected, n)}  (returned an id not in its candidates → pool fallback)")
        print(f"  agent -> fallback : {agent_fallback}/{n}   {bar(agent_fallback, n)}  (LLM call errored)")
        if agent_off:
            print(f"  pool picker only  : {agent_off}/{n}  (pickerAgent disabled)")
    else:
        print("No track-pick decisions in this window.")

    if req_traces:
        req_ok = sum(1 for tr in req_traces.values() if tr["ok"])
        print(f"Listener requests    : {len(req_traces)}  "
              f"({req_ok} ok, {len(req_traces)-req_ok} failed)")

    # Tool usage mix — which discovery tools the agent actually leans on.
    tool_use = Counter(e.get("name") for e in events if e.get("type") == "tool")
    if tool_use:
        print()
        print("Discovery tools used:")
        tot = sum(tool_use.values())
        for name, c in tool_use.most_common():
            print(f"  {name:<20}{c:>5}  {bar(c, tot)}")

    # What actually went to air — repetition is the audible quality signal.
    plays = [e for e in events if e.get("type") == "track.play"]
    if plays:
        plays.sort(key=lambda e: e.get("t", ""))
        artists = [(e.get("artist") or "?") for e in plays]
        artist_count = Counter(artists)
        # An artist counts as "repeated" if it also appears in the previous 3 plays.
        repeated = 0
        for i, a in enumerate(artists):
            if a in artists[max(0, i-3):i]:
                repeated += 1
        print()
        print(f"Tracks aired   : {len(plays)}   distinct artists: {len(artist_count)}")
        print(f"  artist repeated within 3 plays : {repeated} "
              f"({100*repeated/len(plays):.0f}% of airings)")
        src = Counter(e.get("source") or "?" for e in plays)
        print("  source mix     : " +
              "  ".join(f"{k}={v}" for k, v in src.most_common()))
        top = artist_count.most_common(8)
        if top and top[0][1] > 1:
            print("  most-aired artists:")
            for a, c in top:
                if c > 1:
                    print(f"    {c:>3}x  {a}")


def report_health(events, traces):
    section("HEALTH & ANOMALIES")
    issues = 0

    failed_traces = [(tid, tr) for tid, tr in traces.items() if tr["ok"] is False]
    if failed_traces:
        issues += len(failed_traces)
        print(f"Failed traces ({len(failed_traces)}):")
        for tid, tr in failed_traces[:10]:
            print(f"  [{tr['kind']}] {tr.get('error') or 'no error message'} "
                  f"({tid[:8]})")

    bad_llm = [e for e in events if e.get("type") == "llm" and not e.get("ok")]
    if bad_llm:
        issues += len(bad_llm)
        print(f"Failed LLM calls ({len(bad_llm)}):")
        for e in bad_llm[:10]:
            print(f"  [{e.get('kind')}] {e.get('error') or 'no error message'}")

    recovery = [e for e in events if e.get("type") == "llm"
                and e.get("via") == "ai-sdk:recovery"]
    if recovery:
        print(f"Structured-output recoveries: {len(recovery)} "
              f"(model returned malformed JSON, the recovery path salvaged it)")

    bad_nav = [e for e in events if e.get("type") == "navidrome" and not e.get("ok")]
    if bad_nav:
        issues += len(bad_nav)
        ep = Counter(e.get("endpoint") for e in bad_nav)
        print(f"Failed Navidrome calls ({len(bad_nav)}): " +
              ", ".join(f"{k}×{v}" for k, v in ep.most_common()))
        for e in bad_nav[:5]:
            print(f"  [{e.get('endpoint')}] {e.get('error') or 'no error message'}")

    # Slowest traces and Navidrome calls — latency outliers worth a look.
    timed = [(tr["ms"], tr["kind"], tid) for tid, tr in traces.items()
             if tr["ms"] is not None]
    if timed:
        print("Slowest decisions:")
        for ms, kind, tid in sorted(timed, reverse=True)[:5]:
            print(f"  {ms:>7} ms  [{kind}]  ({tid[:8]})")

    slow_nav = sorted(((e.get("ms", 0) or 0, e.get("endpoint"))
                       for e in events if e.get("type") == "navidrome"),
                      reverse=True)[:5]
    if slow_nav and slow_nav[0][0] > 0:
        print("Slowest Navidrome calls:")
        for ms, ep in slow_nav:
            print(f"  {ms:>7} ms  {ep}")

    if issues == 0:
        print("No failed traces, LLM calls, or Navidrome calls in this window.")


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--state-dir", default=None,
                    help="SUB/WAVE state dir (default: auto-detect ./state or ../state)")
    ap.add_argument("--since", default=None,
                    help="only events newer than this window, e.g. 24h, 3d, 1w")
    ap.add_argument("--day", default=None,
                    help="analyse only events-<day>.jsonl (YYYY-MM-DD)")
    args = ap.parse_args()

    state_dir = find_state_dir(args.state_dir)
    cutoff = parse_since(args.since)
    events, skipped, files_read = load_events(state_dir, args.day, cutoff)

    if not files_read:
        print(f"No events-*.jsonl files found under {state_dir}/logs/.")
        print("The unified event log is written by the controller — confirm it is")
        print("running the build that includes observability/events.js, and that")
        print("--state-dir points at the right place.")
        sys.exit(0)
    if not events:
        print(f"Found {', '.join(files_read)} but no events match the filter "
              f"(--since {args.since})." if args.since else
              f"Found {', '.join(files_read)} but they contain no events yet.")
        sys.exit(0)

    traces = build_traces(events)
    report_overview(events, files_read, skipped)
    report_navidrome(events, traces)
    report_picker(events, traces)
    report_health(events, traces)
    print()


if __name__ == "__main__":
    main()
