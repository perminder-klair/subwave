// Which face DJ Doc pulls, decided in one place for both places it stands: the
// doctor page and the admin top-bar badge. Pure, so the rules are pinned by
// doctor-mood.test.ts. Each surface gets one buddy, and the badge stands down on
// the doctor page, where the page's own buddy is the one DJ Doc.
//
// A verdict maps to the same face everywhere: healthy is happy, attention is
// worried, critical is spooked. The badge rests on `content` for a healthy last
// check rather than celebrating all day, and asks to be run (`curious`) when no
// check has ever run.

import type { BuddyMood } from '../BoothBuddy';
import type { DoctorReport, DoctorReview, DoctorSummary } from './doctor-queries';

export type DoctorOverall = NonNullable<DoctorReview['overall']>;

export const MOOD_BY_OVERALL: Record<DoctorOverall, BuddyMood> = {
  healthy: 'happy',
  attention: 'worried',
  critical: 'spooked',
};

/** A report's verdict from its counts alone, for when no review has run. The
 *  controller's `derivedOverall` (doctor/cache.ts) holds the same rule. */
export function countsOverall(counts: DoctorReport['counts']): DoctorOverall {
  if (counts.fail > 0) return 'critical';
  if (counts.warn > 0) return 'attention';
  return 'healthy';
}

export interface DoctorPageState {
  running: boolean;
  reviewing: boolean;
  /** A one-click fix is being applied. */
  fixing: boolean;
  /** The last run failed outright (no report came back). */
  failed: boolean;
  report: DoctorReport | null;
  review: DoctorReview | null;
}

/** The doctor page's one buddy: at work while the levels run or the review is
 *  written, then the review's verdict, or the report's own when no review is
 *  available. */
export function doctorPageMood(s: DoctorPageState): BuddyMood {
  if (s.running) return 'listening';
  if (s.reviewing || s.fixing) return 'thinking';
  if (s.failed) return 'dizzy';
  if (!s.report) return 'curious';
  if (s.review?.available && s.review.overall) return MOOD_BY_OVERALL[s.review.overall];
  return MOOD_BY_OVERALL[countsOverall(s.report.counts)];
}

export interface StationSignals {
  /** The mixer reports nothing to play (the emergency loop is on air). */
  musicStarved: boolean;
  navidromeOk: boolean;
  /** null until the feed's first poll resolves. */
  streamOnline: boolean | null;
  /** One of the DJ's lines is on air right now. */
  talking: boolean;
  summary: DoctorSummary | null;
}

export interface StationBuddy {
  mood: BuddyMood;
  /** What the face means, in words, for the badge's label. */
  note: string;
}

function checkNote(summary: DoctorSummary): string {
  const c = summary.counts;
  if (!c) return 'last check ran';
  if (c.fail > 0) return `last check: ${c.fail} fail`;
  if (c.warn > 0) return `last check: ${c.warn} warn`;
  return 'last check: all clear';
}

/** The top-bar badge: live trouble first, then the last check's verdict, with
 *  the DJ on the mic outranking everything short of a critical verdict. */
export function stationBuddy(s: StationSignals): StationBuddy {
  if (s.musicStarved) return { mood: 'spooked', note: 'no music to play' };
  if (!s.navidromeOk) return { mood: 'dizzy', note: 'can’t reach Navidrome' };
  if (s.streamOnline === false) return { mood: 'sleepy', note: 'off air' };
  const overall = s.summary?.overall ?? null;
  if (overall === 'critical' && s.summary) return { mood: 'spooked', note: checkNote(s.summary) };
  if (s.talking) return { mood: 'onair', note: 'the DJ is on the mic' };
  if (overall === 'attention' && s.summary) return { mood: 'worried', note: checkNote(s.summary) };
  if (overall === 'healthy' && s.summary) return { mood: 'content', note: checkNote(s.summary) };
  return { mood: 'curious', note: 'no check run yet' };
}
