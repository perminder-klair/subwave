---
name: todoist
label: To-do nudge
cooldown: 90m
context: date, clock, time, listeners
# token / filter / maxTasks / owner are this skill's own knobs — set them in the
# edit sheet (/admin/skills → To-do nudge → Edit), not by hand. tool.mjs
# declares them, so they appear as form fields and the form writes them back
# here:
#   filter: today | overdue
#   maxTasks: 4
#   owner: Perminder
#
# The API token is better kept OUT of this file: put TODOIST_API_TOKEN in the
# root .env (the whole file is passed into the controller via env_file) and
# leave the token field blank. The field is only there for stations that would
# rather not restart the container to set a key.
#
# Want it as a fixed morning alarm rather than a random between-track pick? Add:
#   cron: 0 8 * * *
#   cronOnly: true
---
Pick ONE thing off the to-do list and dare somebody to go and do it — a quick,
grinning nudge between records, not a reading of the list. Name the task, keep
it to a sentence or two, and aim it at whoever is listening as much as at the
person who wrote it: the bit that lands is "go on then, one song's worth, see
if it's done before the next track ends". Lean on the record playing if it
helps ("this one runs four minutes, that's the whole washing-up").

An overdue task is worth a bit of theatre — mock outrage, a raised eyebrow,
never actual guilt-tripping, and never a lecture about productivity. Say how
many are left only if it's funny; otherwise let the number go. Never read out
more than one task, never spell out a due date as a date ("by Thursday" is
fine, "due 2026-08-27" is not), and never invent a task or a detail the data
didn't give you. If nothing came back, say nothing at all — a station that
nags about an empty list is worse than one that stays quiet.
