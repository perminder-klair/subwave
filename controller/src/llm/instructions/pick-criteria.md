# Pick criteria and transition-effect coaching

Editorial guidance shared by BOTH pick strategies — the session agent
(`broadcast/dj-agent/schemas.ts` → `pickSystem`) and the stateless pool picker
(`llm/internal/prompts/picker.ts`). One wording so the two can't drift on how a
track is chosen, which is the whole reason `PICKER_CRITERIA` was shared in code
before it lived here.

**effects** renders only when transition effects are active (the on-air persona's
`djMode` — `settings.effectsActive`), so a non-DJ persona never sees it and
leaves the `transition` field null. Keep it compact: it rides on EVERY DJ-mode
pick on both paths, and the agent path pays for it alongside the schema
description. The station validates every ask against the audio analysis
(`queue.applyMixTransition`) and silently drops one that doesn't land, so this
only needs to teach WHEN to reach for each effect — trigger and
counter-indication — never how the audio works.

## criteria

Selection criteria, in order:
1. FLOW — does it transition naturally from the track this pick is expected to follow? Match energy, mood and tempo, or step them deliberately for the daypart. Some candidates carry MEASURED acoustic facts — treat these as tie-breakers, never hard rules (many tracks won't have them):
   - "bpm" and Camelot "key": prefer a tempo near that predecessor's tempo and a harmonically-close key for a smooth segue.
   - "pace" (0–1 perceptual energy, decoupled from tempo): shape build/release arcs — don't stack two peaks back-to-back, ease down for wind-down dayparts, lift for workout/drive.
   - "sections": higher = a busier, evolving intro.
   - "instrumental" (true = no vocals): avoid stacking instrumentals back-to-back; an instrumental opener leaves room to talk over.
2. CONTEXT — does it fit the time of day, weather, and dominant mood? When a candidate carries its own "moods" tags and an "energy" band (low/medium/high), weigh those against the room's mood and the daypart — match a calm room with calm tracks, lift the energy for a workout slot.
3. VARIETY — avoid the same artist back-to-back; rotate energy. Favour the library's depth: a candidate marked "unaired" has never been on this station — prefer it over a familiar staple when both fit the moment, and reach for deepCuts when the rotation feels samey. When present, "play_count"/"last_played_days_ago" (song) and "artist_play_count"/"artist_last_played_days_ago" (artist) tell you how played-out a candidate actually is — a high play_count or a small days-ago is a staple in heavy rotation, not a new discovery, even when it isn't flagged "unaired". Weigh both the song's own numbers and its artist's: a song aired once ages ago from an artist played constantly is still an overplayed lane. Variety over cleverness — never pick a track because its title literally matches the time of day, the weather, or anything else literal.
4. INTEREST — prefer something that creates a moment, not the most generic option.

## effects

TRANSITION EFFECTS ("transition") — part of your craft: a working DJ fires one every few songs when the moment earns it. Flag the moment when you see it — the station validates each choice against the audio analysis and silently drops one that doesn't land, so a bold call is safe. Pacing is yours: let a few plain crossfades breathe between effects, and VARY them — if your recent picks leaned on one, reach for another.
Exit moves (how YOUR PICK will end):
- "washout": the pick dissolves into a tempo-synced echo tail as it ends — the workhorse exit; fire on any natural ending (last of a themed run, a big/dreamy/atmospheric closer, a direction change coming next).
- "loop": the pick's final bar repeats hypnotically under the next track — the groove exit for a great riff or locked drum pattern; needs the track's measured tempo, never out of ambient.
Clash moves (carry the PREVIOUS track into your pick; these only fire when the tracks measurably clash):
- "sweep": previous sinks under a closing filter while yours rises clean — the DRAMATIC gear-change.
- "dissolve": previous melts into a beatless ambient wash — the SMOOTH way, when the jump should be hidden (late night, easing out of a talk break).
- "chop": previous is cut on its own beat, stabs thinning as yours rises — the PERCUSSIVE way to jump energy UP; only out of beat-driven material.
Pair move:
- "blend": spectral handover — the two tracks read as ONE continuous piece; only for an exceptionally locked pair (near-identical tempo, close key), roughly one pick in five at most.
Use "normal" or null when nothing above applies — an ordinary same-lane pick needs no effect.
