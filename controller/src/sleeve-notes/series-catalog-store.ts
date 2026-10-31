import type Database from 'better-sqlite3';
import { DEFAULT_MUSICBRAINZ_SERIES, type DefaultMusicBrainzSeries } from './musicbrainz-series-catalog.js';

export interface SeriesDefinition extends DefaultMusicBrainzSeries {
  enabled: boolean;
  origin: 'supplied' | 'custom';
  removed: boolean;
  fetchedAt: string | null;
  lastError: string | null;
  attempts: number;
}

/** Read legacy caches too; listing configuration never seeds or migrates a DB. */
export function seriesCatalogInDatabase(db: Database.Database, includeRemoved = false): SeriesDefinition[] {
  const rows = db.prepare('SELECT * FROM sleeve_musicbrainz_series ORDER BY series_order').all() as Array<Record<string, unknown>>;
  const saved = new Map(rows.map((row) => [String(row.series_mbid), row]));
  const defaults = new Map(DEFAULT_MUSICBRAINZ_SERIES.map((item) => [item.id, item]));
  const ids = new Set([...defaults.keys(), ...saved.keys()]);
  return [...ids].map((id): SeriesDefinition => {
    const row = saved.get(id);
    const fallback = defaults.get(id);
    return {
      id, label: String(row?.series_name ?? fallback?.label),
      entityType: (row?.entity_type ?? fallback?.entityType) as SeriesDefinition['entityType'],
      ranked: row ? Boolean(row.ranked) : fallback?.ranked === true,
      order: Number(row?.series_order ?? fallback?.order ?? 1000),
      editionGroup: (row?.edition_group ?? fallback?.editionGroup ?? undefined) as SeriesDefinition['editionGroup'],
      editionYear: row?.edition_year != null ? Number(row.edition_year) : fallback?.editionYear,
      enabled: row?.enabled === undefined || row.enabled === 1,
      origin: defaults.has(id) ? 'supplied' : 'custom', removed: row?.removed === 1,
      fetchedAt: row?.fetched_at ? String(row.fetched_at) : null,
      lastError: row?.last_error ? String(row.last_error) : null, attempts: Number(row?.attempts ?? 0),
    };
  }).filter((item) => includeRemoved || !item.removed).sort((a, b) => a.order - b.order);
}

export function activeSeriesMap(db: Database.Database): Map<string, SeriesDefinition> {
  return new Map(seriesCatalogInDatabase(db).filter((item) => item.enabled).map((item) => [item.id, item]));
}

export function seedSuppliedSeries(db: Database.Database, now = new Date()): void {
  const insert = db.prepare(`INSERT OR IGNORE INTO sleeve_musicbrainz_series
    (series_mbid, series_name, entity_type, ranked, series_order, edition_group, edition_year, next_refresh_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const item of DEFAULT_MUSICBRAINZ_SERIES) insert.run(item.id, item.label, item.entityType,
    item.ranked ? 1 : 0, item.order, item.editionGroup ?? null, item.editionYear ?? null, new Date(0).toISOString(), now.toISOString());
}

export function parseSeriesId(input: unknown): string {
  if (typeof input !== 'string') throw new Error('Paste a MusicBrainz Series URL or MBID');
  let id = input.trim();
  if (/^https?:/i.test(id)) {
    let url: URL;
    try { url = new URL(id); } catch { throw new Error('Enter a valid MusicBrainz Series URL'); }
    if (url.hostname !== 'musicbrainz.org' || url.username || url.password || url.port) throw new Error('Use a musicbrainz.org Series URL');
    const match = /^\/series\/([^/]+)\/?$/.exec(url.pathname);
    if (!match) throw new Error('Use a MusicBrainz Series page, not an artist, recording or album page');
    id = match[1];
  }
  id = id.toLowerCase();
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id)) throw new Error('Enter a valid Series MBID');
  return id;
}

export function updateSeriesInDatabase(db: Database.Database, ids: string[], patch: { enabled?: boolean; ranked?: boolean; removed?: boolean }): void {
  seedSuppliedSeries(db);
  const catalog = new Map(seriesCatalogInDatabase(db, true).map((item) => [item.id, item]));
  for (const id of ids) {
    const item = catalog.get(id);
    if (!item || item.removed) throw new Error('List not found');
    if (patch.removed && item.origin === 'supplied') throw new Error('Supplied lists can be disabled, not removed');
    db.prepare(`UPDATE sleeve_musicbrainz_series SET enabled = ?, ranked = ?, removed = ?, updated_at = ? WHERE series_mbid = ?`)
      .run(patch.removed ? 0 : Number(patch.enabled ?? item.enabled), Number(patch.ranked ?? item.ranked), Number(patch.removed ?? false), new Date().toISOString(), id);
    // Retain cache, links and use history; automatic facts are rebuilt only from enabled lists.
    db.prepare(`UPDATE sleeve_claims SET enabled = 0 WHERE operator_state = 'auto'
      AND source_document_id IN (SELECT id FROM sleeve_source_documents WHERE provider = 'musicbrainz-series' AND source_url = ?)`)
      .run(`https://musicbrainz.org/series/${id}`);
  }
  db.prepare(`UPDATE sleeve_series_library_scan SET album_offset = 0, next_scan_at = ?, updated_at = ? WHERE id = 1`)
    .run(new Date().toISOString(), new Date().toISOString());
}
