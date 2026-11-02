# X release thread

The X branch of [`SKILL.md`](SKILL.md). Steps 1 to 3 there (pull, triage, size) come first; this file is Step 4 for X.

The audience is strangers scrolling past. Post 1 has to stand on its own: what SUB/WAVE is, which release, and why they should read on. Everything after it is for the people who stopped.

## The format

A three-post thread by default. A single post when the release is one or two changes, or when the user asks for one.

```
1/
SUB/WAVE vX.Y.Z is out 📻

[One sentence on what SUB/WAVE is: self-hosted radio for your own music library, one stream everyone hears together, an AI DJ that picks the tracks and talks between them.]

[Honest size from Step 3, leading into the thread] 👇

2/
[EMOJI] [Headline change, one or two lines.]

[EMOJI] [Next headline change.]

3/
🔧 Fixes you'll hear: [the felt fixes as one comma-separated run].

Notes: https://github.com/perminder-klair/subwave/releases/tag/vX.Y.Z
```

Notes on the parts:

- **The link goes only in the last post.** X shows posts with links to fewer people, so post 1 stays link-free.
- **Emoji carry meaning**, the same as on Discord: one per headline change, `🔧` for fixes.
- **Skip hashtags and @-mentions** unless the user asks for them. Let the words carry it.

## The length check

Every post must fit in **280 weighted characters**. X counts any `https://` URL as 23 and counts emoji and most symbols outside Latin (`•`, `→`, `📻`) as 2, so a character count from your head is wrong. Write each post to its own file in the scratchpad and run:

```bash
python3 -I .claude/skills/subwave-social-release/x-count.py 1.txt 2.txt 3.txt
```

Every post reads `OK` before you deliver. The counter errs slightly high on joined emoji sequences, which keeps it on the safe side. Write links with `https://` so it counts them as X does.

## Delivering on X

Give each post in its own fenced block, labelled `1/`, `2/`, `3/`, with its weighted count. Offer a single-post cut.
