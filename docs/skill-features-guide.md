# Conversations, guests and memory in DJ Skills

Skills can create conversations, invite another station persona for one segment,
tease later programmes and remember a discussion during a show. These features
work with regular shows as well as Sub/Shows unless stated otherwise.

## Before you start

Create or edit a skill in **Skills**. Enable it station-wide and assign it to the
DJs who should use it. For a Sub/Show, also allow it in that page's eligible
skills settings if the list is restricted. Inviting a guest does not bypass the
current host's skill eligibility or cooldown.

The skill brief describes what should happen. An optional `tool.mjs` supplies
data or selects participants. These capabilities require a controller version
that includes this update. Rescan Skills after changing files directly.

## Co-hosted conversations

Enable **Co-Hosted Discussion** to use the current show's host and guests. Each
participant speaks in their own persona and voice. A normal co-hosted skill
stands down on a solo show; the special-guest options below can supply another
participant.

Describe the exchange you want in the brief. There is no fixed four-line format:
conversations support up to 16 turns, with every selected participant speaking
at least once. Keep requests practical for the number of people involved.

For a precise sequence, use one numbered list whose steps start with **Host**,
**Special guest** or an unambiguous participant name. The controller checks the
speaker order and turn count. Without that list, the structure is flexible.
Do not ask the model to read speaker labels or stage directions aloud.

## Invite a special guest through the brief

Enable **Co-Hosted Discussion**, then place this standalone line in the brief:

```text
Special guest: <Full Persona Name>
```

Replace the placeholder with the full name of an existing station persona; an
exact persona ID also works. This adds them for this segment while keeping the
current host and scheduled guests. It does not change the show roster.
An ordinary mention of a persona in prose does not invite them.

For example, after the directive, add:

```text
Create one short, original dad-joke exchange. Keep it friendly and under 80 words.
1. The host asks for a joke.
2. The special guest gives the setup.
3. The host asks why.
4. The special guest gives the punchline.
5. The host reacts.
```

This five-turn example suits a solo host plus one special guest. If the show
already has guests, include their turns too, or use a tool-selected cast.
Names must resolve uniquely. Missing, ambiguous or host-identical guest names,
multiple guest directives and casts above four participants stand the skill down.
Put the directive in the actual brief, not inside a quoted or fenced example.

## Let a tool select the speakers

For custom skills that select a guest or occasionally use another presenter,
skill authors can add `cast: tool` to SKILL.md frontmatter. The tool returns
`speakerIds`: one to four distinct existing persona IDs. Only those people take
part; the current host is included only if requested. A one-person cast produces
a solo segment. Larger casts produce one conversation.

Tools can resolve identities with `services.personas.find(nameOrId)` and obtain
the current host with `services.personas.onAirHost()`. They can choose a random
guest from an operator-configured pool without asking the model to invent or
resolve a persona. A tool's explicit cast takes precedence over a prompt guest.
This advanced option has no dedicated editor switch. See
[the author contract](custom-skills.md#cast-tool--temporary-segment-guests).

## Look Ahead: tease later shows

Look Ahead is a supplied example, not an automatically enabled skill. Copy both
files from `docs/examples/skills/look-ahead` into your skill folder, rescan,
enable it and assign the DJs who should use it.

It selects up to two prepared shows later on the station's local day, excluding
the immediately following show. It uses supplied titles, start times and cast,
including accepted Sub/Show episodes. It does not generate future episodes.
With nothing suitable to tease, it stands down.

Normally the current DJ introduces the selected shows. Occasionally the host of
one upcoming show delivers a solo promo for that show instead. Set
`GUEST_PROMO_PERCENT` in `tool.mjs`: the default is 33; 0 uses current-DJ teases
only, and 100 uses an upcoming host whenever possible. There is no UI control
for this percentage. Changing the schedule can invalidate a queued tease before
playback so that outdated details are not announced. Audio already handed to
the mixer cannot be recalled.

## Sub/Show Talking Point

This bundled, editable skill is the Sub/Show counterpart to a short DJ banter
exchange. It ships **disabled by default**, including on upgrades. Enable it,
assign DJs and allow it in Sub/Shows' eligible skills if that list is restricted.
Existing enable choices and edited skill files are preserved.

The tool looks for the brief's explicit talking-point label and a connection to
the current track's genre metadata. Missing context or an unsupported connection
makes it stand down, including on manual runs. Solo shows also stand down.
When it runs, each presenter gets at most two turns.

The discussion can explore subjective taste, discovery, listening habits and
hypothetical associations as well as musical qualities. Presenters may gently
disagree when their persona-led views differ; neither conflict nor agreement is
required, and the exchange need not finish with a shared verdict. It does not
invent personal memories or use opinions as evidence about the current track.

The check is conservative text/genre matching, not audio analysis. A relevant
genre does not prove an instrument, lyric, influence or historical claim. The
brief tells the DJs to stand down if the question needs unsupported facts and
to avoid naming recordings other than the supplied current track.

## Remember a discussion during one airing

Add this field to SKILL.md frontmatter:

```yaml
notebook: show
```

The skill receives its own notebook for the current show airing. It survives
controller restarts and starts empty for the next airing. Separate skills do
not share it. Default programming without a scheduled show or takeover has no
show notebook and stands down. Resuming the same interrupted scheduled occurrence
resumes its notebook; a takeover has a separate one.

Useful brief wording:

> Keep one topic throughout this airing. When the notebook is empty, introduce
> a fresh topic. Build on the discussion so far without repeating earlier
> contributions. Record only new opinions actually voiced in this segment.

The controller requests structured memory separately from spoken dialogue in the
same generation call. The topic becomes fixed when its introducing turn airs;
contribution summaries commit only when their referenced turns air. Generating
a segment alone does not make its contents remembered as broadcast.

The notebook retains a bounded recent history. Its `notebook.json` sits beside
the skill files but is controller-owned: tools must not write it. Skill exports
omit this runtime memory; station backups include committed memory. Tools may
read a snapshot with `services.notebook.read()`.

Memory is generated text, not verified evidence: structurally valid summaries
can still be inaccurate. For topic and contribution limits, turn references,
inspection/reset and recovery behaviour, see
[the notebook author guide](custom-skills.md#show-skill-notebook).

## Sharing a skill

Use your own roster when configuring guests. A shared skill should use a
placeholder or operator setting rather than depend on one station's persona
names or IDs. Include its tool when required, and explain its eligibility and
stand-down conditions. These features do not automatically enable a skill or
add persona assignments.
