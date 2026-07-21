// Multi-voice banter — a short scripted exchange between the show's host and
// guest co-hosts, aired between tracks. One structured-output call writes the
// WHOLE exchange (a per-line call would multiply latency and lose the
// back-and-forth); each line is then rendered in its speaker's own TTS voice
// and aired back-to-back through the serialized voice chain
// (queue.announceExchange). Speaker ids ride a per-call Zod enum, so the model
// can't invent a voice we can't render.

import { z } from 'zod';
import { soulBrief } from '../core/pure.js';
import { djObject } from '../strategy/object.js';
import { buildContextLines } from './context.js';

// Same field set as the free-text script generators (scripts.ts): ambient
// weather stays out (issue #471 — it dominated every segment); the dedicated
// weather skill owns that beat.
const BANTER_CONTEXT_FIELDS = ['date', 'clock', 'time', 'festival', 'show', 'listeners'];

// The exchange stays short by construction: radio banter that runs past ~6
// lines stops being a break and starts being a podcast.
const MIN_LINES = 3;
const MAX_LINES = 6;

// Souls ride as briefs, not in full: this block repeats once per cast member
// (host + up to GUESTS_PER_SHOW guests), and it exists to tell the model who
// is in the room, not to hand each one their whole character document.
function castBlock(host: any, guests: any[]): string {
  const entry = (p: any, role: string) =>
    `- ${p.id} — ${p.name} (${role}): ${soulBrief(p.soul) || 'no notes'}`;
  return [entry(host, 'HOST'), ...guests.map((g: any) => entry(g, 'GUEST'))].join('\n');
}

// Returns air-ready lines [{ persona, text }] in order, or null when the model
// couldn't produce a usable exchange (fewer than two lines or a single voice
// throughout — a monologue should go through the normal segment paths, not
// masquerade as banter).
export async function generateBanter({
  host, guests, show = null, current = null,
  context = null, recap = null, recentOpeners = null,
}: any) {
  const cast = [host, ...guests];
  const ids = cast.map((p: any) => p.id);
  const schema = z.object({
    lines: z.array(z.object({
      speaker: z.enum(ids as [string, ...string[]]).describe('the persona id of who says this line, from the cast list'),
      text: z.string().min(1).max(400).describe('the spoken line — one or two short conversational sentences, plain speech, no stage directions or sound effects'),
    })).min(MIN_LINES).max(MAX_LINES).describe('the exchange, in air order'),
  });

  // The host's on-air language governs the room — co-hosts on one show share
  // a broadcast language, same rule as the rest of the station.
  const lang = String(host?.language || '').trim();
  const langClause = lang ? ` Everyone speaks ${lang} on air; keep proper nouns (artist names, track titles, the station name) untranslated.` : '';

  const showClause = show?.name ? ` of "${show.name}"` : '';
  const system = `You write short on-air exchanges between the hosts${showClause} on a personal internet radio station, mid-show. This is people who know each other talking in one studio: quick, warm, a little loose — real speech, not sketch comedy or a scripted bit.

The cast (persona id — name (role): voice notes):
${castBlock(host, guests)}

Rules:
- ${MIN_LINES} to ${MAX_LINES} lines total, at least two different speakers. Let the turn-taking breathe — it doesn't have to alternate mechanically, but nobody monologues.
- Each speaker stays in THEIR OWN character per the voice notes. The host carries the room; guests chip in as themselves.
- Ground it in the moment you're given (the track playing, the hour, the show) — react, riff, disagree gently, tease. One thread, not a topic list.
- This is a conversation, NOT a link: do not introduce, back-announce, or name-drop the next track, do not read a station ident, do not announce the time.
- No greetings or sign-offs — the show is already rolling. No invented listener messages, callers, or events.
- Plain spoken words only: no stage directions, no asterisks, no emoji.${langClause}`;

  const ctxLines = buildContextLines(context, { contextFields: BANTER_CONTEXT_FIELDS });
  if (current?.title) ctxLines.push(`On air right now: "${current.title}" by ${current.artist || 'unknown'}`);
  if (recap) ctxLines.push(`Already said on air recently (do not repeat these topics or phrasing):\n${recap}`);
  if (recentOpeners?.length) ctxLines.push(`Recent opening words (start the first line differently): ${recentOpeners.join(' | ')}`);
  const prompt = `${ctxLines.join('\n')}\n\nWrite the exchange.`;

  const out = await djObject({
    system,
    prompt,
    schema,
    temperature: 0.95,
    kind: 'generateBanter',
  });

  const byId = new Map(cast.map((p: any) => [p.id, p]));
  const lines = (out?.lines || [])
    .map((l: any) => ({ persona: byId.get(l.speaker), text: String(l.text || '').trim() }))
    .filter((l: any) => l.persona && l.text);
  const speakers = new Set(lines.map((l: any) => l.persona.id));
  if (lines.length < 2 || speakers.size < 2) return null;
  return lines;
}
