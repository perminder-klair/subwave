---
name: subwave-news-dispatch
description: Write a news post for the SUB/WAVE "Dispatches" page, a short human-friendly tutorial about a feature, fix, or release. Use this skill whenever the user wants to "write a news post / dispatch / news article", "announce a feature on the news page", "add a changelog entry to the site", "post an update about <feature>", "write release notes for the site", or "tell people about <what shipped>" for SUB/WAVE. The skill knows where the markdown lives (web/content/news), the frontmatter schema, the what/how/why structure, and that every draft must be run through the `humanizer` skill before saving. It does NOT publish or deploy; it just writes the .md file, and the /news page picks it up on the next build.
---

# SUB/WAVE news dispatch

Write one news article for the **Dispatches** page (`/news`). Each dispatch is a short, plain-English mini-tutorial about something that shipped: what it is, how to use it, and why it helps. Not a changelog line.

## Why this skill exists

The news page reads markdown straight off disk (`web/lib/news.ts` reads `web/content/news/*.md`), so adding a post is just writing one file in the right shape. The easy-to-get-wrong parts are the frontmatter schema, keeping the tone human (short tutorial, not release-note jargon), and remembering to humanize the draft. This skill encodes all three.

## Where the file goes

```
web/content/news/YYYY-MM-DD-slug.md
```

- The `YYYY-MM-DD-` prefix is only for sorting files on disk; it's stripped from the URL. The page slug is the frontmatter `slug` if present, otherwise the filename minus that date prefix. So `2026-05-30-clone-a-voice.md` serves at `/news/clone-a-voice`.
- Pick the date from when the feature actually shipped. For a real commit: `git show -s --format=%cs <sha>`. Evergreen "this is what SUB/WAVE does" posts use the `Spotlight` category and any sensible recent date.
- The eight seed articles already in `web/content/news/` are the reference set. Match their length and voice.

## Frontmatter schema

```yaml
---
title: Make your DJ sound like anyone     # the headline; sentence case, no trailing period needed
date: 2026-05-30                          # ISO yyyy-mm-dd; drives ordering (newest first)
category: Feature                         # Release | Feature | Fix | Announcement | Spotlight
version: v0.2.0                           # optional, shows as a dateline tag
author: The SUB/WAVE desk                 # optional, byline on the article page
excerpt: One or two sentences shown on the index card and used as the meta description.
---
```

- `category` describes the nature of the post, not the raw conventional-commit type. A `fix(web)` commit that listeners will notice is usually a `Feature` or `Fix` dispatch; a `chore: release` is a `Release`; an evergreen feature explainer is a `Spotlight`.
- `excerpt` is required in practice. It's the deck on the index and the meta description / OG description. Keep it concrete.
- **Watch the YAML.** `title` and `excerpt` are parsed as YAML, so a colon-then-space inside the value (`a new bit: a moon phase`) makes the parser read it as a nested key and the build fails. Avoid raw `: ` in those values (reword, or use a comma), or wrap the whole value in double quotes. The same goes for a value that starts with a quote, `[`, `{`, `@`, or `` ` ``.

## Structure of the body

Aim for ~150-350 words. Three beats, in this order:

1. **What's new.** One or two lines. What shipped, in plain words.
2. **How to use it.** The concrete steps. Real commands, the exact filename/folder, where to click in admin. Use fenced code blocks for commands and paths. This is the part readers came for.
3. **Why it helps.** The benefit, in one short paragraph. What it lets them do now that they couldn't before.

Use `##` subheads (sentence case) to break those up. Look at the seed articles for the rhythm. The first paragraph gets an automatic vermilion drop cap, so open with prose, not a heading.

## Writing rules

- **No em-dashes.** Reword with a comma, a colon, parentheses, or a full stop instead. This is a hard rule for the wire.
- Short sentences. Vary the rhythm. First person ("we traced it to the Opus mount", "nothing for you to do") is fine and reads human.
- No changelog-speak, no inflated significance, no rule-of-three padding.
- Be specific: real paths, real commands, the real button name in admin. Pull the detail from `git log`, the PR, or the relevant manual page under `web/components/manual/`.
- Straight quotes, sentence-case headings, no decorative emoji.

## Required: humanize before saving

ALWAYS run the finished draft through the **`humanizer`** skill, apply its edits, then write the `.md` file. This is not optional. It's the step that keeps the wire from reading like AI release notes, and it's where the em-dash and rule-of-three habits get caught.

## Verify

```bash
cd web && npm run lint && npm run build
```

- Confirm the new slug appears under `● /news/[slug]` in the build output (it's statically prerendered). A frontmatter typo shows up here as "Failed to collect page data for /news/[slug]".
- The article shows on `/news` automatically, newest first, and the sitemap (`web/app/sitemap.ts`) picks it up via `getNewsSlugs()`. No other file to touch.
- Optional spot check: `cd web && npm run dev`, open `http://localhost:7700/news`, confirm the headline, dateline, and body render.

## Worked example (abridged)

File: `web/content/news/2026-05-30-clone-a-voice.md`

```markdown
---
title: Make your DJ sound like anyone
date: 2026-05-30
category: Feature
version: v0.2.0
author: The SUB/WAVE desk
excerpt: PocketTTS can now clone a voice from a single WAV. Drop a clip in the voices folder, point a persona at it, and that's the voice on air.
---

Voice cloning used to be a Chatterbox-only trick. PocketTTS can do it too now...

## What's new

PocketTTS does zero-shot cloning from one reference WAV...

## How to use it

Drop the `.wav` into the voices folder:

​```
state/voices/morning-host.wav
​```

Then open a DJ persona in admin and set its voice to that filename. Save.

## Why it helps

Your station gets a real on-air identity...
```
