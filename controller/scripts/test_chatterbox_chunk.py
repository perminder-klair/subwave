#!/usr/bin/env python3
"""Pure-logic tests for chatterbox_worker.chunk_text (issue #1130).

No torch / audio deps — importing chatterbox_worker only runs its module-level
setup (env reads + regex compiles), never main(), so this runs with a plain
stdlib python3:

    python3 controller/scripts/test_chatterbox_chunk.py

CI runs eslint + tsc only (no Python runner), so this is a manual/regression
harness for the chunker. Exits non-zero on the first failure.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from chatterbox_worker import chunk_text  # noqa: E402

FAILS = []


def check(name, cond):
    status = "PASS" if cond else "FAIL"
    print(f"[{status}] {name}")
    if not cond:
        FAILS.append(name)


def within(chunks, cap):
    return all(len(c) <= cap for c in chunks)


def reassembles(chunks, text):
    """Every non-whitespace char of the original survives, in order (chunking
    only drops the whitespace it splits on)."""
    return "".join(chunks).replace(" ", "") == text.replace(" ", "").strip()


# 1. Empty / whitespace -> no chunks.
check("empty string -> []", chunk_text("") == [])
check("whitespace -> []", chunk_text("   \n  ") == [])

# 2. Short line -> single unchanged chunk (the common case, no behaviour change).
short = "You're locked into the late show. Here's the next one."
check("short line is one chunk", chunk_text(short) == [short])
check("short line unchanged", chunk_text(short)[0] == short)

# 3. A line at exactly the cap stays one chunk; one over splits.
cap = 40
exactly = "a" * cap
check("exactly cap -> one chunk", chunk_text(exactly, max_chars=cap) == [exactly])

# 4. Long multi-sentence segment (weather-report shape) splits on sentence
#    boundaries, every chunk within the cap, nothing lost.
weather = (
    "Good evening across the valley. Right now it's sixteen degrees under a "
    "clear sky, with a light breeze coming in off the coast. Overnight we'll "
    "dip to around nine, so grab a jacket if you're heading out late. "
    "Tomorrow brings more of the same — bright spells, a chance of a shower "
    "after lunch, and highs near twenty-one degrees."
)
wc = chunk_text(weather)
check("weather splits into multiple chunks", len(wc) > 1)
check("weather chunks within cap", within(wc, 280))
check("weather loses no content", reassembles(wc, weather))
check("weather never starts a chunk mid-word", all(c == c.strip() for c in wc))

# 5. Packing: short adjacent sentences are combined up to the cap rather than
#    emitted one-per-chunk.
many = "One. Two. Three. Four. Five. Six. Seven. Eight."
mc = chunk_text(many, max_chars=20)
check("short sentences pack together (fewer chunks than sentences)", len(mc) < 8)
check("packed chunks within cap", within(mc, 20))

# 6. A single sentence longer than the cap falls back to clause boundaries.
long_sentence = (
    "It's a night for slow songs, dim lights, and long drives, "
    "the kind of evening that asks for nothing but a good tune and an open road."
)
lc = chunk_text(long_sentence, max_chars=50)
check("over-cap single sentence still splits", len(lc) > 1)
check("clause-split chunks within cap", within(lc, 50))
check("clause-split loses no content", reassembles(lc, long_sentence))

# 7. Pathological: one long unpunctuated run hard-wraps rather than exploding.
run = "word " * 60  # 300 chars, no sentence punctuation
rc = chunk_text(run, max_chars=50)
check("unpunctuated run hard-wraps within cap", within(rc, 50))
check("hard-wrap loses no content", reassembles(rc, run))

# 8. A single word longer than the cap is broken mid-word (never dropped, never
#    over-cap) — the true last resort.
giant = "supercalifragilisticexpialidocious"
gc = chunk_text(giant, max_chars=10)
check("giant word splits within cap", within(gc, 10))
check("giant word loses no content", reassembles(gc, giant))

print()
if FAILS:
    print(f"{len(FAILS)} FAILED: {', '.join(FAILS)}")
    sys.exit(1)
print("all chunk_text tests passed")
