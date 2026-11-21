CREATE TABLE IF NOT EXISTS sleeve_artist_research_overrides (
  artist_id TEXT PRIMARY KEY REFERENCES sleeve_artists(id), musicbrainz_id TEXT,
  wikipedia_url TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sleeve_library_verification (
  id INTEGER PRIMARY KEY CHECK(id=1), token TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('running','complete','cancelled')),
  started_at TEXT NOT NULL, last_step_at TEXT, next_step_at TEXT, skipped INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sleeve_artist_verification (
  artist_id TEXT PRIMARY KEY REFERENCES sleeve_artists(id), scan_token TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','running','retry-at','found','missing','failed','cancelled')), source_url TEXT, checked_at TEXT, last_error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, run_after TEXT
);
CREATE INDEX IF NOT EXISTS idx_sleeve_artist_verification_pending ON sleeve_artist_verification(state,run_after);
