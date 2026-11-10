import type { GeneratedShowRecord } from '../schemas/show-preparation.js';

const generated = new Map<string, GeneratedShowRecord>();

export function restoreGeneratedShows(records: readonly GeneratedShowRecord[]): void {
  generated.clear();
  for (const record of records) generated.set(record.occurrence.id, record);
}

export function generatedShowAt(showId: string, at: number, source?: 'scheduled' | 'takeover', startsAt?: number): GeneratedShowRecord | null {
  for (const record of generated.values()) {
    if (record.occurrence.showId === showId
        && (!source || record.occurrence.source === source)
        && (startsAt == null || record.occurrence.startsAt === startsAt)
        && at >= record.occurrence.startsAt && at < record.occurrence.endsAt) return record;
  }
  return null;
}
