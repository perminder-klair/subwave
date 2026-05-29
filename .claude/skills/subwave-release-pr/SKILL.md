---
name: subwave-release-pr
description: Open a release pull request from develop to main for SUB/WAVE, and keep develop from drifting behind main. Summarises the commits queued on develop, groups them by conventional-commit type, opens the PR via gh, and — once the release lands — back-merges main → develop so the release-please version bump and CHANGELOG come across. Trigger this skill whenever the user says "create a release PR", "open a release PR to main", "release to main", "cut a release", "ship to main from develop", "open a develop→main PR", "sync develop with main", "develop is behind main", "back-merge main into develop", or any equivalent phrasing where the goal is to open the develop→main merge that release-please will promote, or to reconcile develop with main afterward. The skill does NOT touch versions, changelogs, or tags directly — release-please workflows on main own all of that downstream.
---

# SUB/WAVE release PR

Open a pull request from `develop` → `main`. Everything after that — version bump, CHANGELOG, tag, GitHub release, image publishing — is handled by the release-please and `publish-images` workflows once the PR merges. This skill's job is just to surface a clean PR with a useful summary.

## Why this skill exists

A release PR for SUB/WAVE is mechanical but easy to get wrong by hand: forgetting to fetch first, listing merge commits in the body, picking up commits that are actually already on main via a back-merge. The skill encodes the right git plumbing and the body format that matches the project's recent PR history.

It also keeps `develop` from drifting behind `main`. After every release, release-please pushes a `chore(main): release X.Y.Z` version bump (and CHANGELOG entry) **directly to main**, and that commit — plus the merge-commit bubble from the release PR — never flows back to develop on its own. Left alone, develop steadily falls "N commits behind main" even though it carries every line of real source. This skill detects that gap up front and closes it with a back-merge after the release lands (Step 8).

## Workflow

### Step 0 — Sanity checks

Run these from the repo root (`/home/klair/Projects/subwave`). They're cheap, surface state, and let you decide whether to proceed:

```bash
git rev-parse --show-toplevel              # confirm we're in subwave (or any git repo)
git status --short                         # any uncommitted work?
git rev-parse --abbrev-ref HEAD            # current branch (informational — we work via remote refs)
git fetch origin main develop              # MUST run before computing the diff, otherwise stale
git rev-list --left-right --count origin/develop...origin/main   # "<ahead>	<behind>" — develop relative to main
```

What to do with the output:
- If `git status --short` shows uncommitted changes, surface them to the user and ask whether to proceed (the PR is built from `origin/develop`, so local edits won't be in it — but the user might want to commit them first).
- If `git fetch` fails (no network, no remote), stop and tell the user. Don't fall back to local refs — the PR base is `origin/main` and the head is `origin/develop`, so the comparison must be against fresh remotes.
- **If the second number ("behind") is > 0, develop is behind main.** Inspect those commits with `git log --oneline origin/develop..origin/main` before reacting. Almost always they're pure release bookkeeping — `chore(main): release …` version bumps + merge-commit bubbles from prior release PRs — in which case develop is *not* missing any real source and the release PR is unaffected (a merge commit does a 3-way merge, so main's version bump and CHANGELOG survive). Note the gap to the user, proceed with the PR, and plan to close it with the Step 8 back-merge once this release lands. **Only stop and flag it as a real problem** if those "behind" commits include `feat:` / `fix:` / `refactor:` work that *isn't* already on develop — that means a hotfix landed straight on main and should be back-merged into develop *before* you cut the release, so the release PR doesn't reintroduce or conflict with it.

### Step 1 — Check for an existing release PR

```bash
gh pr list --base main --head develop --json number,title,state,url
```

If a non-closed PR already exists, do **not** open a second one. Show the existing PR's URL to the user and ask whether they want to update it (re-push the develop branch is enough — GitHub auto-refreshes the PR), or close it and open a fresh one. Default to "leave it alone, here's the link" unless the user explicitly asks for a new PR.

### Step 2 — Gather the commits

```bash
git log --oneline --no-merges origin/main..origin/develop
git diff --stat origin/main..origin/develop
```

The `--no-merges` filter is important — merge commits like `Merge pull request #N from branch` are noise in the PR body. The stat tells you which files / how many lines change, useful for the user to sanity-check scope.

If `git log --no-merges origin/main..origin/develop` is empty: there is nothing to release. Tell the user, stop. Don't open an empty PR.

### Step 3 — Group commits by conventional-commit type

Parse the prefix of each commit subject:

| Prefix | Section header in PR body |
|---|---|
| `feat:` / `feat(scope):` | **Features** |
| `fix:` / `fix(scope):` | **Bug Fixes** |
| `perf:` | **Performance** |
| `refactor:` | **Refactors** |
| `docs:` | **Documentation** |
| `build:` | **Build** |
| `revert:` | **Reverts** |
| Anything else (`chore:`, `ci:`, `test:`, no prefix, …) | **Other** |

These mirror the sections release-please will render in CHANGELOG.md on the main side — keeping the PR body in sync makes review easier and the eventual changelog less surprising.

If a `feat!:` / `fix!:` / `BREAKING CHANGE:` commit is present, call it out in the PR body in a one-line **Breaking changes** note at the top so the reviewer doesn't miss it. (You don't compute a semver — release-please does — but flagging it manually saves the reviewer a scan.)

### Step 4 — Draft the title

Keep it under 70 characters. Use this shape:

```
release: <short theme of the batch>
```

Pick the theme from the dominant work in the diff. A few examples from this project's history:

- `release: mobile polish, landing fixes, player tactile transport`
- `release: admin library KPI tweaks + ollama provider swap`
- `release: controller hardening and onboarding wizard`

Don't put a version number in the title — release-please owns versioning and would have to either match or override yours. The title is just human signal.

### Step 5 — Draft the body

ALWAYS use this exact template:

```markdown
## Summary

<2–4 sentences describing what's queued on develop and why this is the moment to ship. Mention scope (web-only, controller-only, full stack, infra). Mention if there are migrations, env-var changes, or breaking changes.>

**Breaking changes** (only include this line if a `!`-marked or `BREAKING CHANGE:` commit exists)
- <sha short — one-line description of the break + the migration step>

**<Section header from Step 3>**
- `<sha short>` <commit subject with the prefix kept intact, optionally a one-line elaboration if a single commit is doing a lot>
- ...

(Repeat one section per type that has commits. Skip types with no commits — don't render empty headers.)

## Test plan
- [ ] <verifiable check — prefer behaviour over implementation>
- [ ] ...
```

Notes on the body:

- **Include short SHAs** so the reviewer can `git show <sha>` to dig into anything they're unsure about. Keep them in monospace.
- **Keep commit subjects literal** — don't paraphrase. The reviewer is going to cross-check against `git log`, and paraphrasing breaks that.
- **Write the test plan from the user's perspective** — what *behaviour* should they verify, not what the code does. "Mobile landing no longer scrolls horizontally" beats "overflow-x: clip applied to body". 3–6 items, max.
- If a single commit is doing a lot (a `feat:` that's actually a multi-component shipment), add one indented sentence below it explaining the shape. Don't replicate the whole commit body.

### Step 6 — Open the PR

Prepend this banner to the PR body before opening, so the reviewer can't miss the merge-strategy requirement:

```markdown
> [!IMPORTANT]
> **Merge with "Create a merge commit"** — not "Squash and merge". Squash collapses the individual `feat:` / `fix:` / `chore:` commits into one `release: …` commit, and release-please then sees no conventional-commit signal and skips the version bump. See [Step 7](#step-7--how-to-merge-this-pr) for the why.
```

Then create the PR:

```bash
gh pr create --base main --head develop --title "release: <theme>" --body "$(cat <<'EOF'
<banner above>

<body from Step 5>
EOF
)"
```

Capture the returned URL and report it to the user. Along with the URL, tell them in plain text: **"Merge this with a merge commit, not squash — release-please needs the individual conventional commits on main to bump the version."**

### Step 7 — How to merge this PR

Release-please runs on `main` push events and walks the commits added since the last release tag. To bump the version it needs to see at least one conventional commit (`feat:`, `fix:`, `perf:`, `refactor:`, …) on main.

- **"Create a merge commit"** — preserves every commit from develop on main with its original `feat:` / `fix:` / `chore:` prefix. Release-please sees them and opens its version-bump PR. **This is the correct option.**
- **"Squash and merge"** — collapses all develop commits into one squash commit whose subject is the PR title (`release: …`). `release:` is not a recognized conventional type, so release-please considers the commit non-user-facing and skips. **Do not use this.** This is exactly what happened with PR #118 — release-please ran, found 1 commit, classified it as non-user-facing, and skipped the version bump.
- **"Rebase and merge"** — also fine in principle (individual commits preserved on main) but breaks the historical pattern (previous successful release PRs like #112, #95, #93 were all merge commits). Stick with merge commit for consistency.

If the operator accidentally squash-merges anyway, the recovery is:

```bash
git checkout main && git pull
git commit --allow-empty -m "feat: <one-line description of the dominant work>

Re-trigger release-please after squash-merge of #<N> lost conventional-commit prefixes."
git push origin main
```

Then re-run the release-please workflow (Actions tab → release-please → Run workflow on main).

### Step 8 — Back-merge main → develop (keep develop from falling behind)

This is the step that keeps develop in sync. It runs **after** the release fully lands, not when the release PR is opened.

**Timing — wait for the version bump.** Two things must be on main before you back-merge:
1. The release PR (#207-style develop→main) has been merged.
2. release-please's follow-up `chore(main): release X.Y.Z` PR has *also* merged — that's the commit carrying the new version + CHANGELOG.

Back-merging before (2) lands just copies develop's own commits back onto develop and leaves it behind again the moment the bump merges. Confirm both are in with `git fetch origin main && git log --oneline -3 origin/main` — you want to see the `chore(main): release …` commit at or near the tip.

**Check whether a back-merge is even needed:**

```bash
git fetch origin main develop
git rev-list --count origin/develop..origin/main   # commits on main not on develop
```

If that count is `0`, develop is already up to date — skip the rest of this step. If it's > 0, those are the release-bookkeeping commits; sync them across.

**Preferred path — sync PR (no local working tree, mirrors the project's PR-driven flow):**

```bash
gh pr create --base develop --head main \
  --title "chore: back-merge main → develop (vX.Y.Z release bookkeeping)" \
  --body "Sync develop with the release-please version bump + CHANGELOG that landed on main after vX.Y.Z. No source changes — keeps develop from drifting behind main."
```

Merge that PR with **"Create a merge commit"** (same reasoning as Step 7 — preserve the `chore(main): release …` commit verbatim; never squash). Report the URL to the user. There is normally no conflict — develop never touched the version line or the CHANGELOG entries main added.

**Local path (only if the user explicitly wants it done from the working tree — needs confirmation, touches the checkout):**

```bash
git checkout develop
git pull origin develop
git merge --no-ff origin/main -m "chore: back-merge main → develop (vX.Y.Z release bookkeeping)"
git push origin develop
```

If the merge reports a conflict, stop and surface it — do not resolve release bookkeeping conflicts blind. A conflict here usually means real work landed on main directly (a hotfix), which is exactly the case Step 0 told you to flag.

**Offer, don't force.** When you open the release PR in Step 6, tell the user the back-merge is the natural follow-up once the release lands, and that they can re-invoke this skill (or just ask) to run Step 8 then. If the user invokes the skill specifically to "sync develop with main" or "develop is behind main," jump straight to this step.

## Edge cases

- **Not on develop**: doesn't matter — this skill works against `origin/develop`, not the local checkout. The local branch could be anywhere. Don't switch branches.
- **Local develop is behind origin/develop**: also doesn't matter for the PR (we use origin/develop). Mention it to the user as an FYI in case they're surprised by what's in the PR.
- **Local develop is *ahead* of origin/develop**: the unpushed commits will NOT be in the PR. Ask whether to push first; if yes, push then re-run from Step 2 (the commit list will change).
- **gh not authenticated**: `gh pr create` will fail with a clear error. Surface it and tell the user to run `gh auth login` — don't try workarounds.
- **A draft release-please PR exists on main** (the version-bump PR release-please opens after a release lands): unrelated to opening the release PR, ignore it for Steps 1–6. But it *is* the gate for Step 8 — the back-merge should wait until that version-bump PR has merged, so the new version/CHANGELOG come across with it.
- **Previous release PR was squash-merged and release-please skipped the version bump**: follow the recovery block in Step 7 (push an empty `feat:` commit to main, re-run the release-please workflow).
- **develop is behind main by release bookkeeping only** (`chore(main): release …` + merge bubbles, no unmerged `feat:`/`fix:`): expected and harmless for the release PR — a merge commit 3-way-merges, so main's version bump survives. Close the gap with the Step 8 back-merge after the release lands; it's hygiene, not a blocker.
- **develop is behind main by real work** (a `feat:`/`fix:` hotfix committed straight onto main, not present on develop): stop before opening the release PR. Back-merge main → develop first (Step 8's procedure, run *now* rather than after), then re-run from Step 2 — otherwise the release PR's diff fights the hotfix.

## Allowed without confirmation

- `git fetch origin main develop`
- `git log` / `git diff` / `git status` / `git rev-list` reads
- `gh pr list`, `gh pr view`
- `gh pr create` — the user invoked the skill specifically to open a PR. This covers both the release PR (Step 6) and the Step 8 back-merge sync PR (`--base develop --head main`); both are PR-open operations, not working-tree changes.

## Confirm before running

- `gh pr close` (only if the user explicitly chose to replace an existing PR)
- `git push` of the local develop branch (only if the user opted into Step 6's edge case)
- The **local** back-merge path in Step 8 (`git checkout` / `git merge` / `git push origin develop`) — it mutates the working tree. Prefer the sync-PR path, which needs no confirmation. Only run the local path if the user explicitly asks for it.
- Anything else touching the local working tree (commits, stashes, branch switches) — the PR-driven paths in this skill don't need any of that
