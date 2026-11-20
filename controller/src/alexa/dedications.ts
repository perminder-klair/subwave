import type { AlexaLocale } from './experience.js';
import { cleanDedicationTarget as cleanTarget } from '../util/request-guard.js';

export const cleanDedicationTarget = cleanTarget;

function normalizeSongPhrase(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const GENERIC_DEDICATION_SONGS = new Set([
  'a song',
  'any song',
  'some song',
  'one song',
  'the song',
  'a track',
  'any track',
  'some track',
  'one track',
  'the track',
  'this song',
  'this track',
  'a song for someone',
  'a track for someone',
  'dedicate this song',
  'make a dedication',
  'ek dedication karni hai',
  'एक गाना',
  'कोई गाना',
  'एक गाना dedicate करना है',
  'इस गाने को dedicate करो',
  'किसी के लिए गाना बजाओ',
  'एक song',
  'कोई song',
  'एक track',
  'कोई track',
].map(normalizeSongPhrase));

export function isGenericDedicationSong(value: string): boolean {
  return GENERIC_DEDICATION_SONGS.has(normalizeSongPhrase(value));
}

export function dedicationSpeech(target: string, locale: AlexaLocale): string {
  const spokenTarget = target.replace(/^(?:for|to)\s+/i, '').trim() || target;
  return locale === 'hi-IN'
    ? `यह गाना ${spokenTarget} के लिए समर्पित है।`
    : `This one is dedicated to ${spokenTarget}.`;
}
