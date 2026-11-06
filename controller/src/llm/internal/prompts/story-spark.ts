// One canonical researched claim, offered as optional material for a DJ link.
// Research wording is not the spoken script; the presenter integrates a supported detail.
import { z } from 'zod';
import type { ExtendedSleeveNote } from '../../../sleeve-notes/link-selection.js';
import { connectionDirectionGuidance } from '../../../sleeve-notes/library-connections.js';
import { firstVocalMsFor, introMsFor, introWordBudget } from './intro-budget.js';
import { speechPaceScale } from '../../../audio/tts.js';

export const sparkLinkSchema = z.object({
  speech: z.string().describe('A complete, natural radio introduction in the presenter’s voice, identifying the supplied artist and track. Weave in an optional supported Spark detail wherever it fits; preserve its factual subject and meaning. Never deliver just the research fact or include your private decision or reason.'),
  sparkDecision: z.enum(['use', 'pass', 'quality-concern']).describe('use: expressed the supplied fact; pass: the Spark does not fit a natural introduction or leaves insufficient room for artist and track identification; quality-concern: a specific ambiguity or conflict in the supplied evidence, never disagreement from memory.'),
  reason: z.string().max(240).nullable().describe('A brief private explanation for pass or quality-concern; null for use. Never part of speech.'),
}).refine(value => value.sparkDecision === 'use' || !!value.reason?.trim(), {
  message: 'A private pass or quality concern needs a specific reason', path: ['reason'],
});

export function sparkSpeechWordBudget(current: unknown, persona: unknown, includeIntroBudget = true): number | null {
  if (!includeIntroBudget) return null;
  return introWordBudget(introMsFor(current), speechPaceScale('link', persona), firstVocalMsFor(current));
}

export function storySparkPacket(note: ExtendedSleeveNote, wordBudget: number | null, oneLiner = false, current?: { artist?: unknown; title?: unknown }): string {
  const artist = typeof current?.artist === 'string' ? current.artist.trim() : '';
  const title = typeof current?.title === 'string' ? current.title.trim() : '';
  const scope = note.airtimeScope;
  const about = scope === 'matching-track-only' && note.matchingTrackTitle
    ? `the recording ${note.matchingTrackTitle}`
    : scope === 'matching-release-only' && note.matchingReleaseTitle
      ? `the album ${note.matchingReleaseTitle}`
      : note.entityType === 'artist' ? 'the artist of the recording now playing; this is artist history, not necessarily a fact about this recording'
        : note.entityType === 'recording' ? 'the recording now playing'
          : 'the album associated with the recording now playing';
  const space = wordBudget != null
    ? `Speech space: at most approximately ${wordBudget} spoken words for the WHOLE link, including track identification. Spoken dates and names also spend this space.`
    : oneLiner ? 'Speech space: one short sentence for the whole link.'
      : 'Speech space: follow the presenter length guidance for the whole link.';
  const lines = [
    'Story Spark — optional research material for this link:',
    ...(artist || title ? [`Track identification: Artist: ${artist ? JSON.stringify(artist) : 'not supplied'}; title: ${title ? JSON.stringify(title) : 'not supplied'}. These identities identify the current track; they are not evidence for the research fact.`] : []),
    `About: ${about}.`,
    `Supported fact: ${note.wording.trim()}`,
    space,
    'Use: Write a natural radio link in the presenter’s voice, not a research readout. Treat the Spark as optional material: weave a complete supported detail into the introduction wherever it flows naturally, rather than reading the supplied wording and attaching a stock bridge. Preserve its meaning, named relationships, attribution and important qualifiers, including the edition or year of a ranked list. Never invent a cause linking the fact to this track or use a bridge such as "a fact that brings us the track". Track identification alone is not use of the Spark.',
    'Space priority: Reserve room for the supplied artist and track title before fitting a Spark, greeting, station name or other framing. If a supported detail and track identification cannot both fit naturally, pass on the Spark and give a concise track introduction. Never spend the whole link on the fact alone.',
    'Identity and subject: Keep artist and track names in their supplied roles; a track title is not a band name. Keep artist biography about the artist, album facts about the album, and recording facts about that recording. An artist starting to perform as a teenager does not establish that they performed this particular song then. Do not attach an artist fact to the song with a misleading relative clause.',
    ...(oneLiner ? ['One-liner: Combine identification and an optional supported detail in one natural sentence only if both fit; otherwise introduce the track and pass on the Spark.'] : []),
    `Source: ${note.attribution || note.provider || 'researched source'} — background grounding; need not be spoken. This is a source-backed claim, not independent station verification.`,
  ];
  if (note.connection) lines.push('Connection grounding: ' + connectionDirectionGuidance(note.connection.type)
    + ' Preserve that direction. Do not infer which musical or lyrical passage was sampled, the sound of a cover, chronology, influence, permission or artist intent.'
    + ' Do not claim the linked track has played or will play on this station unless the supplied programme context explicitly says so.');
  return lines.join('\n');
}
