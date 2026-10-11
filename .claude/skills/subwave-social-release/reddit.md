# Reddit release post

The Reddit branch of [`SKILL.md`](SKILL.md). Steps 1 to 3 there (pull, triage, size) come first; this file is Step 4 for Reddit.

The audience is a self-hosting subreddit: people who have never heard of SUB/WAVE, read release posts skeptically, and upvote concrete detail. On Discord, personality earns attention; on Reddit, **specifics** do. The operational detail Discord folds away (the image to pull, the env var, the GPU model, the command) is what earns trust here.

## The format

Two parts: a title and a body.

**Title** (one line): `SUB/WAVE vX.Y.Z: <what SUB/WAVE is, in a few words>, <the headline change>`. Most readers don't know the project, so the title says what it is before what changed.

**Body:**

```
For anyone who hasn't come across it: [two or three sentences on what SUB/WAVE is: their own library turned into one internet radio stream everyone hears at the same time, with an AI DJ that picks the tracks and talks between them, plus how it runs.]

vX.Y.Z is [honest size, from Step 3]. Here's what's most likely to matter if you self-host it:

**[Area of the stack, e.g. Analyzer]**
- [Change, concrete: the version, the card, the env var, the command, the number.]
- [Any action it needs (pull the new image, re-upload, a migration) stated in the bullet itself.]

**[Next area, e.g. On air]**
- ...

Release notes: https://github.com/perminder-klair/subwave/releases/tag/vX.Y.Z
Repo: https://github.com/perminder-klair/subwave
Docs and setup: https://www.getsubwave.com

[One plain line inviting questions.]
```

Notes on the parts:

- **The "what it is" paragraph** comes from `README.md`'s opening and the repo itself. Every claim in it (music servers, Docker, local LLM via Ollama, the license) must be one you can point at in the repo.
- **Group by area of the stack**, not by feat/fix: a self-hoster scans for the part they run. Analyzer, On air, App, Other is a typical split; use whatever areas this release touched.
- **Headings and bullets only.** Reddit renders bold and lists. No emoji, no radio-booth sign-off, no `@everyone`.
- **Plain and direct**, written as the developer posting their own project. Let the details carry it.

## Delivering on Reddit

Give the title in a plain ``` block and the body in a ```markdown block, so each pastes into its own field. Say which subreddit you wrote it for (r/selfhosted and r/navidrome are the natural fits; the user picks) and remind them to check its flair and self-promotion rules. Offer an alternate title.
