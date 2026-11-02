#!/usr/bin/env python3
"""Weighted X length of each post file, following twitter-text v3.

Any http(s) URL counts 23. Code points in the light ranges below count 1,
everything else (emoji, most symbols outside Latin) counts 2. Emoji joined
with a ZWJ or a variation selector count a little high, which errs safe.

Usage: x-count.py POST_FILE [POST_FILE ...]   (exit 1 if any post is over)
"""
import re
import sys
import unicodedata

LIMIT = 280
URL_WEIGHT = 23
LIGHT = ((0x0000, 0x10FF), (0x2000, 0x200D), (0x2010, 0x201F), (0x2032, 0x2037))
URL = re.compile(r"https?://\S+")


def weighted_length(text):
    text = unicodedata.normalize("NFC", text.rstrip("\n"))
    urls = URL.findall(text)
    rest = URL.sub("", text)
    light = sum(1 for ch in rest if any(lo <= ord(ch) <= hi for lo, hi in LIGHT))
    return len(urls) * URL_WEIGHT + light + 2 * (len(rest) - light)


def main(paths):
    if not paths:
        sys.exit(__doc__)
    over = False
    for path in paths:
        with open(path, encoding="utf-8") as f:
            n = weighted_length(f.read())
        over |= n > LIMIT
        print(f"{path}: {n}/{LIMIT} {'OVER' if n > LIMIT else 'OK'}")
    sys.exit(1 if over else 0)


if __name__ == "__main__":
    main(sys.argv[1:])
