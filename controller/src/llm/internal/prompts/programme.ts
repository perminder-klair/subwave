// Programme prompts — the "producer" layer behind broadcast/programme.ts.
//
// A programme show airs as a produced episode: intro → music → feature →
// music → outro. One structured call at session start (generateProgrammePlan)
// turns the show's topic brief + the moment into an episode plan; the beat
// scripts below all reference that plan, which is what makes the hour read as
// one produced sequence instead of three unrelated talk breaks. When the plan
// call fails, the beats degrade to brief-only generation (the caller passes
// plan: null) — the arc still airs, it just loses the cross-references.

import { z } from 'zod';
import * as settings from '../../../settings.js';
import { soulBrief } from '../core/pure.js';
import { djText } from '../strategy/text.js';
import { djObject } from '../strategy/object.js';
import { djSystem, lengthPhrase } from './system.js';
import { buildContextLines, decoratePrompt, randomSeed } from './context.js';
import { clipText } from '../core/pure.js';

// Same field set as the free-text script generators (scripts.ts): ambient
// weather stays out (issue #471); the dedicated weather skill owns that beat.
const PROGRAMME_CONTEXT_FIELDS = ['date', 'clock', 'time', 'festival', 'listeners'];

// A plan is bounded: one feature per scheduled hour, capped so a marathon
// scheduling mistake can't make the producer write a 24-item rundown.
const MAX_FEATURES = 8;

// The grounding rule every programme beat carries (issue #1301).
//
// These beats talk about music while being shown none of it:
// PROGRAMME_CONTEXT_FIELDS deliberately carries no track fields, and the beats
// that need specifics — the feature above all — are told to be concrete. With
// a music topic and no music in the prompt, the only route to "concrete" is a
// record the model knows from training. Live incident: a straight-talk feature
// aired "Nirvana's Smells Like Teen Spirit from Nevermind blasts in, with
// Butch Vig's punchy production…" sixteen seconds into an Anika track.
//
// The failure was the FRAMING, not the fact — Butch Vig did produce Nevermind,
// and it is guitar-forward. What broke was present-tense on-air language
// ("blasts in") for a record that was never on the playout, which a listener
// parses as a cue for what they are hearing. So the rule bans the cue framing
// rather than the title: a feature on the birth of grunge that cannot name
// Nevermind is not a feature. Certainty is asked for as a SEPARATE half, and
// that half is what covers a genuinely invented credit or date — the two
// failure modes are independent and a rule for one does not cover the other.
//
// One constant, appended by all four beats, so the rule can't drift between
// them — the same "policy lives in exactly one place" split as
// broadcast/voice-policy.ts. Pinned by scripts/programme-grounding.test.ts.
export const PROGRAMME_GROUNDING_RULE =
  'You are talking ABOUT music, not introducing it: never describe a track as playing now, starting, coming up, or just heard. Nothing you name is on the station\'s playout — a listener is hearing something else while you speak, so any "here it comes" framing is simply wrong. Naming a record, artist or credit is fine when you are certain of it; when you are not, describe the sound, the scene or the era instead of reaching for a title.';

// ---------------------------------------------------------------------------
// PRODUCER PLAN — one djObject call per episode
// ---------------------------------------------------------------------------

// Character caps for the plan's free-text fields. Kept as data so the wire
// schema (the plain z.object below) and the pre-validation clip stay in sync.
// The producer writes at temperature 0.9, and a "one sentence" angle routinely
// lands a handful of chars over its cap — that overflow must NOT throw away the
// whole plan and drop the episode to brief-only fallback (a 207-char angle vs
// the 200 cap did exactly that). So the caps stay advertised to the model but
// are enforced by clipping, not rejection.
const ANGLE_MAX = 200;
const NOTE_MAX = 240;
const TOPIC_MAX = 240;

// Clip every over-length text field on the raw payload BEFORE validation. This
// runs as a TOP-LEVEL preprocess over the plain object (see clipText's note):
// the inner z.object stays the untouched wire contract — every field intact in
// `required` under io:'input', maxLength still advertised — whereas a per-field
// clip would silently drop the field from `required` on the forced-tool path.
function clipPlanText(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const out = { ...(raw as Record<string, unknown>) };
  out.angle = clipText(out.angle, ANGLE_MAX);
  out.introNote = clipText(out.introNote, NOTE_MAX);
  out.outroNote = clipText(out.outroNote, NOTE_MAX);
  if (Array.isArray(out.features)) {
    out.features = out.features.map((f) =>
      f && typeof f === 'object' && !Array.isArray(f)
        ? { ...(f as Record<string, unknown>), topic: clipText((f as Record<string, unknown>).topic, TOPIC_MAX) }
        : f);
  }
  return out;
}

export const planSchema = (maxFeatures: number) => z.preprocess(clipPlanText, z.object({
  angle: z.string().min(1).max(ANGLE_MAX)
    .describe("today's editorial line for the episode — the specific take on the show's brief this airing runs with. One sentence."),
  introNote: z.string().min(1).max(NOTE_MAX)
    .describe('what the opening establishes and teases (including a nod to the feature) — a note to the host, not the spoken line itself'),
  features: z.array(z.object({
    topic: z.string().min(1).max(TOPIC_MAX)
      .describe('what this feature segment covers — concrete and specific, not a category'),
    kind: z.string().nullable()
      .describe('the segment capability kind to build it with, from the kinds offered in the prompt — or null to let the host talk it straight'),
  })).min(1).max(maxFeatures)
    .describe('one feature segment per scheduled hour of the show, in air order'),
  outroNote: z.string().min(1).max(NOTE_MAX)
    .describe('how the sign-off wraps the episode — call back to the angle or the feature; a note to the host'),
}));

// The producer only picks WHICH capability builds each feature; the full
// SKILL.md brief is applied by the segment director when the beat actually
// runs. Offering whole briefs here made the menu the bulk of the plan prompt
// (a dozen kinds × multi-sentence briefs), enough to sink small local models
// on the structured call — so each kind gets one line: its first sentence,
// word-capped.
const MENU_DESC_MAX = 160;
function menuDesc(text: string): string {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  const sentence = (flat.match(/^.*?[.!?](?=\s|$)/) || [flat])[0];
  if (sentence.length <= MENU_DESC_MAX) return sentence;
  return `${sentence.slice(0, MENU_DESC_MAX).replace(/\s+\S*$/, '')}…`;
}

// How the producer is told to fill each feature's `kind`. Exported pure so the
// grounding test can pin the null-choice guidance without a model call.
//
// `kind: null` is a legitimate plan choice (straight talk from the host), not
// an error state — but it is also the ONLY path with no data behind it, which
// is where #1301's fabricated cue came from. So the menu branch says what null
// is FOR: topics the host can carry from the brief alone. This lowers how often
// the ungrounded beat fires; PROGRAMME_GROUNDING_RULE is the actual guard when
// it does, since the beat is also reachable by a capability throwing at air
// time (broadcast/programme.ts runFeature), which no plan wording can prevent.
//
// The pinned and no-capability branches take no such advice: neither offers the
// producer a choice to steer.
export function featureKindsClause(skillKinds: { kind: string; desc: string }[] = [], pinnedKind: string | null = null): string {
  if (pinnedKind) {
    return `Every feature segment is built with the "${pinnedKind}" capability — write each feature topic as a brief for it.`;
  }
  if (!skillKinds.length) {
    return 'No data capabilities are available — set every feature "kind" to null (straight talk from the host).';
  }
  return `Feature segments may be built with one of these capabilities (set "kind", or null for straight talk):\n${
    skillKinds.map((k) => `- ${k.kind}: ${menuDesc(k.desc)}`).join('\n')
  }\nA feature whose topic needs specific facts — dates, credits, releases, news, anything the host would otherwise have to recall — must name a capability. Leave "kind" null only for a topic the host can honestly carry from the brief and the moment alone.`;
}

// `skillKinds` is the capability menu the plan may build features from
// (already filtered to enabled + host-owned + ready by the caller). When the
// show pins `segmentSkill`, the caller passes just that one and the plan is
// told every feature uses it.
export async function generateProgrammePlan({
  show, spanHours = 1, host = null, guests = [], context = null,
  previousAngle = null, skillKinds = [], pinnedKind = null,
}: any) {
  const featureCount = Math.max(1, Math.min(MAX_FEATURES, spanHours));
  const ctxLines = buildContextLines(context, { contextFields: PROGRAMME_CONTEXT_FIELDS });
  const cast = [
    `Host: ${host?.name || 'the DJ'}`,
    ...(guests || []).map((g: any) => `Guest co-host: ${g.name}`),
  ].join('\n');

  const kindsClause = featureKindsClause(skillKinds, pinnedKind);

  const system = `You are the producer of a radio programme on a personal internet radio station. Given the show's standing brief and the moment, write today's episode plan: the angle this airing takes, what the opening establishes, one feature segment per hour, and how the sign-off wraps. Notes are for the host — concrete, specific, grounded in the brief. Never invent listener messages, callers, or events. Vary the angle from episode to episode.`;

  const promptLines = [
    `The show: "${show.name}"${spanHours > 1 ? ` — ${spanHours} hours on air` : ' — one hour on air'}.`,
    show.topic ? `Standing brief: ${show.topic}` : 'Standing brief: (none — build the episode from the moment and the cast)',
    cast,
    previousAngle ? `Last episode's angle (take a DIFFERENT one today): ${previousAngle}` : null,
    kindsClause,
    ctxLines.length ? `\nThe moment:\n${ctxLines.join('\n')}` : null,
    `\nWrite the plan — exactly ${featureCount} feature${featureCount > 1 ? 's' : ''}, in air order.`,
  ].filter(Boolean);

  return djObject({
    system,
    prompt: promptLines.join('\n'),
    schema: planSchema(featureCount),
    temperature: 0.9,
    kind: 'generateProgrammePlan',
  });
}

// ---------------------------------------------------------------------------
// SOLO BEAT SCRIPTS — free text in the host's voice
// ---------------------------------------------------------------------------

function planClause(plan: any, note: string | null) {
  if (!plan?.angle) return '';
  return `\nToday's episode angle: ${plan.angle}${note ? `\nProducer's note for this beat: ${note}` : ''}`;
}

// The three solo beats' task lines are exported pure builders so the grounding
// test can assert the rule actually reaches each rendered prompt, rather than
// merely that the constant exists — a constant nothing appends is the exact
// regression this guards against.
export function introTask({ show, plan = null, speaker = null }: any): string {
  const brief = show?.topic ? ` The show's brief: ${show.topic}.` : '';
  return `Task: open your show "${show.name}" on air — this is the top of the programme.${brief}${planClause(plan, plan?.introNote)}\n` +
    `Welcome listeners in, set up what this hour is about, and tease what's coming without over-promising. ${lengthPhrase('link', speaker)}. Warm and in character — a host starting their show, not a announcer reading a rundown. You may nod to the time of day loosely, never exact minutes. ${PROGRAMME_GROUNDING_RULE}`;
}

export async function generateProgrammeIntro({ show, plan = null, persona = null, context = null, recap = null, recentOpeners = null }: any) {
  const speaker = persona || settings.getEffectivePersona();
  const ctxLines = buildContextLines(context, { contextFields: PROGRAMME_CONTEXT_FIELDS });
  ctxLines.push(introTask({ show, plan, speaker }));
  return djText({
    system: djSystem(speaker),
    prompt: decoratePrompt(ctxLines.join('\n'), { kind: 'programme-intro', recap, recentOpeners }),
    temperature: 0.95, topP: 0.92, repeatPenalty: 1.2, seed: randomSeed(),
    kind: 'generateProgrammeIntro',
  });
}

export function outroTask({ show, plan = null, speaker = null, nextShowName = null }: any): string {
  const teaseClause = nextShowName ? ` "${nextShowName}" is up next — give it a quick nod.` : '';
  return `Task: your show "${show.name}" is wrapping up in the next few minutes — sign the episode off.${planClause(plan, plan?.outroNote)}\n` +
    `Wrap the hour like a host who was actually here for it — a callback to what the episode was about lands better than a generic goodbye.${teaseClause} ${lengthPhrase('link', speaker)}. Music keeps playing after you — you're closing the show, not the station. ${PROGRAMME_GROUNDING_RULE}`;
}

export async function generateProgrammeOutro({ show, plan = null, persona = null, context = null, recap = null, recentOpeners = null, nextShowName = null }: any) {
  const speaker = persona || settings.getEffectivePersona();
  const ctxLines = buildContextLines(context, { contextFields: PROGRAMME_CONTEXT_FIELDS });
  ctxLines.push(outroTask({ show, plan, speaker, nextShowName }));
  return djText({
    system: djSystem(speaker),
    prompt: decoratePrompt(ctxLines.join('\n'), { kind: 'programme-outro', recap, recentOpeners }),
    temperature: 0.95, topP: 0.92, repeatPenalty: 1.2, seed: randomSeed(),
    kind: 'generateProgrammeOutro',
  });
}

// Straight-talk feature — the floor when the beat has no data capability
// behind it (plan said kind: null, the pinned/planned kind is stale or
// unready, or the forced director path failed). No tools: the host just talks
// the topic in character, so the beat still airs.
//
// This is the beat #1301 fired on: the only one told to be "concrete and
// specific" with no data block behind it. Its own no-invented-data clause stays
// — it covers dates/quotes/statistics — and the grounding rule lands after it,
// covering the on-air framing that clause never spoke to.
export function featureTask({ show, topic, plan = null, speaker = null }: any): string {
  return `Task: the feature segment of your show "${show.name}". Today's feature: ${topic}.${plan?.angle ? ` The episode's angle: ${plan.angle}.` : ''}\n` +
    `Talk it through in character — concrete and specific, something a listener leaves knowing or feeling. ${lengthPhrase('segment', speaker)}. Only what you actually know: no invented dates, quotes, statistics, listener messages, or events. ${PROGRAMME_GROUNDING_RULE}`;
}

export async function generateProgrammeFeature({ show, topic, plan = null, persona = null, context = null, recap = null, recentOpeners = null }: any) {
  const speaker = persona || settings.getEffectivePersona();
  const ctxLines = buildContextLines(context, { contextFields: PROGRAMME_CONTEXT_FIELDS });
  if (recap) ctxLines.push(`Already said on air recently (do not repeat these topics or phrasing):\n${recap}`);
  ctxLines.push(featureTask({ show, topic, plan, speaker }));
  return djText({
    system: djSystem(speaker),
    prompt: decoratePrompt(ctxLines.join('\n'), { kind: 'programme-feature', recap, recentOpeners }),
    temperature: 0.95, topP: 0.92, repeatPenalty: 1.2, seed: randomSeed(),
    kind: 'generateProgrammeFeature',
  });
}

// ---------------------------------------------------------------------------
// GUEST-SHOW BEAT EXCHANGES — multi-voice intro/outro
// Same construction as generateBanter (per-call persona-id enum, whole
// exchange in one structured call, air-ready [{persona, text}] lines), but the
// framing is a show open / close rather than mid-show chat.
// ---------------------------------------------------------------------------

const MIN_EXCHANGE_LINES = 2;
const MAX_EXCHANGE_LINES = 5;

// The exchange's system prompt. Exported pure for the same reason as the solo
// task builders — the grounding rule has to be provably ON this path too. A
// guest open/close is the beat most likely to reach for a record ("wait till
// you hear what we've got"), and it had only the listener-messages clause.
//
// The station house rules land here as well (#1420): this prompt goes through
// neither renderDjPrompt nor agentPersonaPreamble, so without the explicit
// append an operator's TTS-tag or number-spelling rules reached every solo
// beat of the show and were silently dropped from the open and the close.
export function exchangeSystem({ host = null, show, castBlock, beatTask }: any): string {
  const lang = String(host?.language || '').trim() || 'English';
  const langClause = ` Everyone speaks ${lang} on air. ${settings.spokenProperNounDirective(host)}`;
  return `You write short on-air exchanges between the hosts of "${show.name}" on a personal internet radio station.

The cast (persona id — name (role): voice notes):
${castBlock}

Rules:
- ${MIN_EXCHANGE_LINES} to ${MAX_EXCHANGE_LINES} lines total, at least two speakers; the host carries the room.
- Each speaker stays in THEIR OWN character per the voice notes.
- ${beatTask}
- Plain spoken words only: no stage directions, no asterisks, no emoji. No invented listener messages, callers, or events.
- ${PROGRAMME_GROUNDING_RULE}${langClause}${settings.castHouseRulesBlock()}`;
}

export async function generateProgrammeExchange({
  beat, show, plan = null, host, guests,
  context = null, recap = null, recentOpeners = null, nextShowName = null,
}: any) {
  const cast = [host, ...guests];
  const ids = cast.map((p: any) => p.id);
  const schema = z.object({
    lines: z.array(z.object({
      speaker: z.enum(ids as [string, ...string[]]).describe('the persona id of who says this line, from the cast list'),
      text: z.string().min(1).max(400).describe('the spoken line — one or two short conversational sentences, plain speech, no stage directions'),
    })).min(MIN_EXCHANGE_LINES).max(MAX_EXCHANGE_LINES).describe('the exchange, in air order — the host opens and closes it'),
  });

  // Briefs, not full souls — same reasoning as banter.ts castBlock: one entry
  // per cast member, and the block places people in the room rather than
  // handing each of them their whole character document.
  const castBlock = [
    `- ${host.id} — ${host.name} (HOST): ${soulBrief(host.soul) || 'no notes'}`,
    ...guests.map((g: any) => `- ${g.id} — ${g.name} (GUEST): ${soulBrief(g.soul) || 'no notes'}`),
  ].join('\n');

  const beatTask = beat === 'outro'
    ? `The show is wrapping up in the next few minutes: sign the episode off together — a callback to what the hour was about, quick thanks between hosts, done.${nextShowName ? ` "${nextShowName}" is up next; the host may give it a quick nod.` : ''} Music keeps playing after — you're closing the show, not the station.`
    : `This is the TOP of the show: the host welcomes listeners in and sets up what this episode is about; the guest(s) chip in as themselves. Tease what's coming without over-promising.`;

  const system = exchangeSystem({ host, show, castBlock, beatTask });

  const ctxLines = buildContextLines(context, { contextFields: PROGRAMME_CONTEXT_FIELDS });
  if (show?.topic) ctxLines.push(`The show's brief: ${show.topic}`);
  if (plan?.angle) ctxLines.push(`Today's episode angle: ${plan.angle}`);
  const note = beat === 'outro' ? plan?.outroNote : plan?.introNote;
  if (note) ctxLines.push(`Producer's note for this beat: ${note}`);
  if (recap) ctxLines.push(`Already said on air recently (do not repeat these topics or phrasing):\n${recap}`);
  if (recentOpeners?.length) ctxLines.push(`Recent opening words (start the first line differently): ${recentOpeners.join(' | ')}`);

  const out = await djObject({
    system,
    prompt: `${ctxLines.join('\n')}\n\nWrite the exchange.`,
    schema,
    temperature: 0.95,
    kind: beat === 'outro' ? 'generateProgrammeOutroExchange' : 'generateProgrammeIntroExchange',
  });

  const byId = new Map(cast.map((p: any) => [p.id, p]));
  const lines = (out?.lines || [])
    .map((l: any) => ({ persona: byId.get(l.speaker), text: String(l.text || '').trim() }))
    .filter((l: any) => l.persona && l.text);
  // Unlike banter, a single-voice result is still a usable open/close — it
  // just airs as the host alone. Only an empty exchange is a failure.
  if (!lines.length) return null;
  return lines;
}
