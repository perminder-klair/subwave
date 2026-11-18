// One console.warn per window for a fault that can repeat on every call (an
// analyzer outage fails every embed of a tagger run, a socket problem every
// request): the first line in a window prints, the rest are counted, and the
// next printed line says how many it held back. A held-back count is reported
// only when a later line prints, never on its own timer.

export interface WarnLimiter {
  /** Print `line` unless one printed within the window; true when it printed. */
  warn(line: string, now?: number): boolean;
  /** Test hook: forget the last line and the held-back count. */
  reset(): void;
}

export function warnLimiter(everyMs: number): WarnLimiter {
  let lastAt = -Infinity;
  let held = 0;
  return {
    warn(line, now = Date.now()) {
      if (now - lastAt < everyMs) {
        held++;
        return false;
      }
      const more = held ? ` (${held} more since the last warning)` : '';
      console.warn(`${line}${more}`);
      lastAt = now;
      held = 0;
      return true;
    },
    reset() {
      lastAt = -Infinity;
      held = 0;
    },
  };
}
