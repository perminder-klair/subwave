/** Remove the current language stats accelerator before simulating a schema
 * version that predates the language columns. SQLite will not drop a column
 * referenced by an index, so old-version fixtures must remove the dependent
 * object first. The real migration recreates it on open. */
export function dropLanguageStatsIndex(database: { exec(sql: string): unknown }): void {
  database.exec('DROP INDEX IF EXISTS idx_tracks_language_stats');
}
