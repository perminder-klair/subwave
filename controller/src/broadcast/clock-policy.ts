// Station-wide clock switch — the enforcement policy.
//
// `settings.djSpeakClock: false` keeps the wall clock out of the DJ's mouth:
// no time of day in links, idents, hand-overs, ad-libs, banter or programme
// beats, and no automatic top-of-the-hour time check. Same split as
// broadcast/voice-policy.ts and broadcast/dj-budget.ts — call sites ask a
// question, this module answers it, and the policy lives in exactly one place
// rather than as inline `settings.get().djSpeakClock` reads scattered through
// the prompt and broadcast paths.
//
// Why one predicate rather than dropping `clock` from the context allowlists:
// the clock reaches a model by four separate routes, and the allowlist closes
// only the first of them.
//   1. The "Local time" context line (llm/internal/prompts/context.ts), shared
//      by every scripted generator, banter, programme and the segment skills.
//   2. generateStationId's "if you nod to the clock, keep it loose" nudge,
//      pushed whatever the context block holds. A model told to nod at a clock
//      it cannot see will invent one — the same trap issue #471 hit, where the
//      weather-pushing angles had to be trimmed alongside the weather line.
//   3. The pick agent's per-turn clock clause (broadcast/dj-agent.ts) and the
//      `say` schema description (dj-agent/schemas.ts). The agent path never
//      calls buildContextLines at all, so an allowlist has no reach there, and
//      with `llm.pickerAgent` on by default that is where most links come from.
//   4. The hourly time-check cron (gated in broadcast/dj-gate.ts).
// A generator that grows its own clock line later asks the same question here.
//
// What deliberately STAYS when the clock is off:
//   - Daypart colour. "after dark", "weekend" and "late night" ride the same
//     context line as the numerals, but they are atmosphere rather than a clock
//     reading, and isDark is what stops the DJ describing daylight two hours
//     past sunset. They keep airing under a relabelled heading; only the time
//     itself goes. `Period: evening (wind down)` was never a clock reading and
//     is untouched.
//   - Manual /dj/segment triggers, including the operator's own "Time check"
//     pad. An explicit operator action always fires — the same exemption those
//     runners already hold from the frequency gate, the LLM hard cap and the
//     voice switch. Off means "stop doing this unprompted", not "never again".
//     This is why the gate sits on the hourly CRON and never inside
//     generateHourlyTime: a time check the operator asked for must still be
//     able to say the time.
//
// Read live on every call, so the toggle applies to the next tick with no
// restart and no mixer bounce.

import * as settings from '../settings.js';

// The raw switch. Absent/non-boolean (any settings.json written before this key
// existed) reads as ON, so an upgrade is byte-identical.
export function clockEnabled(): boolean {
  return settings.get()?.djSpeakClock !== false;
}

// May a spoken line state the wall-clock time? The question every prompt
// builder asks before it puts a clock, or an instruction about one, in front of
// the model.
export function speakClockAllowed(): boolean {
  return clockEnabled();
}

// May the AUTOMATIC top-of-the-hour time check fire? Same predicate, named for
// the call site in broadcast/dj-gate.ts. Manual runners must NOT call this —
// they bypass the gate entirely, which is what preserves the operator's pad.
export function autoTimeCheckAllowed(): boolean {
  return clockEnabled();
}

// Snapshot for the admin /debug surface, alongside voiceStatus().
export function clockStatus() {
  return { enabled: clockEnabled() };
}
