-- Initial Extended Sleeve Notes schema. Experimental pre-release migrations
-- are intentionally not supported; existing testers must reset this sidecar.

CREATE TABLE claims (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL REFERENCES entities(id),
      provider_identity_id TEXT NOT NULL REFERENCES provider_identities(id),
      claim_type TEXT NOT NULL,
      wording TEXT NOT NULL,
      classification TEXT NOT NULL,
      fresh_until TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      corrected_wording TEXT,
      suppressed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

CREATE TABLE discoveries (
        entity_id TEXT NOT NULL REFERENCES entities(id),
        root_entity_id TEXT NOT NULL REFERENCES entities(id),
        origin TEXT NOT NULL CHECK (origin IN ('station', 'relationship')),
        depth INTEGER NOT NULL CHECK (depth IN (0, 1)),
        discovered_at TEXT NOT NULL,
        PRIMARY KEY(entity_id, root_entity_id, origin)
      );

CREATE TABLE entities (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('artist', 'release', 'track', 'external')),
      local_id TEXT,
      title TEXT NOT NULL,
      artist TEXT,
      release_title TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

CREATE TABLE evidence (
      id TEXT PRIMARY KEY,
      claim_id TEXT NOT NULL REFERENCES claims(id),
      provider TEXT NOT NULL,
      source_url TEXT NOT NULL,
      attribution TEXT NOT NULL,
      excerpt TEXT,
      structured_json TEXT,
      retrieved_at TEXT NOT NULL
    );

CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      entity_id TEXT NOT NULL REFERENCES entities(id),
      kind TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'retry-at', 'complete', 'failed', 'cancelled')),
      priority INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      run_after TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, depth INTEGER NOT NULL DEFAULT 0, root_entity_id TEXT REFERENCES entities(id),
      UNIQUE(provider, entity_id, kind)
    );

CREATE TABLE provider_coverage (
      provider TEXT NOT NULL,
      entity_id TEXT NOT NULL REFERENCES entities(id),
      state TEXT NOT NULL CHECK (state IN ('unknown', 'queued', 'fetching', 'ready', 'no-match', 'retry-at', 'stale')),
      checked_at TEXT,
      retry_at TEXT,
      PRIMARY KEY(provider, entity_id)
    );

CREATE TABLE provider_identities (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL REFERENCES entities(id),
      provider TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      canonical_url TEXT NOT NULL,
      match_confidence REAL,
      resolution_state TEXT NOT NULL CHECK (resolution_state IN ('unresolved', 'confident', 'ambiguous', 'unavailable', 'no-match')),
      retrieved_at TEXT NOT NULL,
      UNIQUE(provider, provider_id)
    );

CREATE TABLE provider_local_matches (
        provider_identity_id TEXT NOT NULL REFERENCES provider_identities(id),
        local_track_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('confident', 'ambiguous')),
        matched_at TEXT NOT NULL,
        PRIMARY KEY(provider_identity_id, local_track_id)
      );

CREATE TABLE relationships (
      id TEXT PRIMARY KEY,
      from_entity_id TEXT NOT NULL REFERENCES entities(id),
      to_entity_id TEXT NOT NULL REFERENCES entities(id),
      provider_identity_id TEXT NOT NULL REFERENCES provider_identities(id),
      relationship_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(from_entity_id, to_entity_id, provider_identity_id, relationship_type)
    );

CREATE TABLE sleeve_airing_reviews (
      id TEXT PRIMARY KEY, airing_key TEXT NOT NULL UNIQUE, use_id TEXT REFERENCES sleeve_claim_uses(id) ON DELETE SET NULL,
      state TEXT NOT NULL CHECK(state IN ('queued','running','ready','resolved','dismissed')),
      context_json TEXT NOT NULL, result_json TEXT, last_error TEXT, lease_token TEXT,
      guidance_approved INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );

CREATE TABLE sleeve_artists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        sort_name TEXT,
        musicbrainz_id TEXT UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

CREATE TABLE sleeve_brain_album_requests (
      local_album_id TEXT PRIMARY KEY, local_track_id TEXT NOT NULL, title TEXT NOT NULL,
      release_group_id TEXT, state TEXT NOT NULL, last_error TEXT, requested_at TEXT NOT NULL
    );

CREATE TABLE sleeve_brain_layers (
      entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, graph_json TEXT NOT NULL,
      PRIMARY KEY (entity_type, entity_id)
    );

CREATE TABLE sleeve_claim_history (
          id TEXT PRIMARY KEY,
          claim_id TEXT NOT NULL REFERENCES sleeve_claims(id),
          action TEXT NOT NULL,
          actor TEXT NOT NULL,
          before_json TEXT NOT NULL,
          after_json TEXT,
          created_at TEXT NOT NULL
        );

CREATE TABLE sleeve_claim_suppressions (
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          category TEXT NOT NULL,
          topic TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(entity_type, entity_id, category, topic)
        );

CREATE TABLE "sleeve_claim_uses" (
            id TEXT PRIMARY KEY,
            claim_id TEXT NOT NULL REFERENCES "sleeve_claims"(id),
            entity_type TEXT NOT NULL CHECK (entity_type IN ('artist', 'recording', 'release', 'release-group')),
            entity_id TEXT NOT NULL,
            category TEXT NOT NULL,
            topic TEXT NOT NULL,
            relationship_key TEXT,
            local_track_id TEXT,
            consumer TEXT NOT NULL DEFAULT 'generateLink',
            supplied_at TEXT NOT NULL,
            final_text TEXT,
            aired_at TEXT
          , offered_wording TEXT NOT NULL DEFAULT '', detection_status TEXT NOT NULL DEFAULT 'not-detected'
        CHECK (detection_status IN ('detected', 'not-detected')), tts_text TEXT, tts_requested_at TEXT, released_at TEXT, dj_quality_rejection_reason TEXT, dj_context_pass_reason TEXT, generated_signal TEXT, speech_signal TEXT, tts_rendered_at TEXT, tts_engine TEXT, track_artist TEXT, track_title TEXT, claim_wording_at_offer TEXT, segment_id TEXT);

CREATE TABLE "sleeve_claims" (
            id TEXT PRIMARY KEY,
            entity_type TEXT NOT NULL CHECK (entity_type IN ('artist', 'recording', 'release', 'release-group')),
            entity_id TEXT NOT NULL,
            category TEXT NOT NULL CHECK (category IN ('artist-stories', 'release-stories', 'track-stories', 'musical-connections', 'milestones', 'credits', 'recognition')),
            topic TEXT NOT NULL,
            wording TEXT NOT NULL,
            source_document_id TEXT NOT NULL REFERENCES "sleeve_source_documents"(id),
            evidence TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL, short_wording TEXT NOT NULL DEFAULT '', operator_state TEXT NOT NULL DEFAULT 'auto'
          CHECK (operator_state IN ('auto', 'approved', 'deleted')), airtime_scope TEXT NOT NULL DEFAULT 'general'
        CHECK (airtime_scope IN ('general', 'matching-release-only', 'matching-track-only')), matching_release_title TEXT, matching_track_title TEXT, extraction_rank INTEGER, extraction_section INTEGER, feedback_hold INTEGER NOT NULL DEFAULT 0,
            UNIQUE(entity_type, entity_id, category, topic, source_document_id)
          );

CREATE TABLE sleeve_connection_artist_population (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        completed_at TEXT NOT NULL
      );

CREATE TABLE sleeve_connection_edges (
        id TEXT PRIMARY KEY,
        claim_id TEXT NOT NULL REFERENCES sleeve_claims(id) ON DELETE CASCADE,
        claim_evidence TEXT NOT NULL,
        source_recording_id TEXT NOT NULL,
        source_local_track_id TEXT REFERENCES sleeve_connection_library_tracks(local_track_id) ON DELETE SET NULL,
        relationship_type TEXT NOT NULL CHECK (relationship_type IN
          ('samples', 'sampled_in', 'cover_of', 'covered_by', 'writer', 'producer')),
        target_kind TEXT NOT NULL CHECK (target_kind IN ('recording', 'contributor')),
        target_provider_id TEXT NOT NULL,
        target_title TEXT NOT NULL,
        target_artist TEXT,
        target_url TEXT,
        match_state TEXT NOT NULL CHECK (match_state IN ('unresolved', 'matched', 'ambiguous')),
        updated_at TEXT NOT NULL
      );

CREATE TABLE sleeve_connection_library_artists (
        local_artist_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        name_key TEXT NOT NULL
      );

CREATE TABLE sleeve_connection_library_matches (
        edge_id TEXT NOT NULL REFERENCES sleeve_connection_edges(id) ON DELETE CASCADE,
        local_track_id TEXT NOT NULL REFERENCES sleeve_connection_library_tracks(local_track_id) ON DELETE CASCADE,
        recording_id TEXT,
        match_basis TEXT NOT NULL,
        PRIMARY KEY(edge_id, local_track_id)
      );

CREATE TABLE sleeve_connection_library_scan (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        generation TEXT NOT NULL,
        album_offset INTEGER NOT NULL DEFAULT 0,
        run_after TEXT,
        completed_at TEXT
      );

CREATE TABLE sleeve_connection_library_tracks (
        local_track_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        album TEXT,
        musicbrainz_recording_id TEXT,
        title_key TEXT NOT NULL,
        artist_key TEXT NOT NULL,
        scan_generation TEXT NOT NULL
      );

CREATE TABLE sleeve_connection_revisions (
      id INTEGER PRIMARY KEY CHECK (id = 1), facts INTEGER NOT NULL DEFAULT 0,
      overview INTEGER NOT NULL DEFAULT 0
    );

CREATE TABLE sleeve_dj_quality_rejections (
        claim_id TEXT NOT NULL REFERENCES sleeve_claims(id),
        opportunity_id TEXT NOT NULL REFERENCES sleeve_claim_uses(id),
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (claim_id, opportunity_id)
      );

CREATE TABLE sleeve_encounters (
        id TEXT PRIMARY KEY,
        local_track_id TEXT NOT NULL REFERENCES sleeve_local_attachments(local_track_id),
        source TEXT NOT NULL CHECK (source IN ('queue', 'played')),
        encountered_at TEXT NOT NULL, host_id TEXT, host_name TEXT,
        UNIQUE(local_track_id, source, encountered_at)
      );

CREATE TABLE sleeve_expired_candidate_fingerprints (
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        expired_at TEXT NOT NULL,
        PRIMARY KEY (entity_type, entity_id, fingerprint)
      );

CREATE TABLE sleeve_genius_library_seeds (
      local_track_id TEXT PRIMARY KEY, recording_id TEXT NOT NULL REFERENCES sleeve_recordings(id),
      title_key TEXT NOT NULL, artist_key TEXT NOT NULL
    );

CREATE TABLE sleeve_genius_local_tracks (
      local_track_id TEXT PRIMARY KEY REFERENCES sleeve_local_attachments(local_track_id),
      recording_id TEXT NOT NULL REFERENCES sleeve_recordings(id)
    );

CREATE TABLE sleeve_genius_seed_cursor (
      id INTEGER PRIMARY KEY CHECK(id=1), artist_key TEXT NOT NULL
    );

CREATE TABLE sleeve_genius_traversal (
      song_id TEXT PRIMARY KEY, recording_id TEXT NOT NULL REFERENCES sleeve_recordings(id),
      title_key TEXT NOT NULL, artist_key TEXT NOT NULL,
      source_document_id TEXT REFERENCES sleeve_source_documents(id),
      next_relationship INTEGER NOT NULL DEFAULT 0
    );

CREATE TABLE sleeve_library_source (id INTEGER PRIMARY KEY CHECK(id=1), fingerprint TEXT NOT NULL);

CREATE TABLE sleeve_local_attachments (
        local_track_id TEXT PRIMARY KEY,
        recording_id TEXT REFERENCES sleeve_recordings(id),
        title TEXT NOT NULL,
        artist TEXT,
        release_title TEXT,
        musicbrainz_recording_id TEXT,
        match_state TEXT NOT NULL CHECK (match_state IN ('unmatched', 'ambiguous', 'matched')),
        first_encountered_at TEXT NOT NULL,
        last_encountered_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

CREATE TABLE sleeve_moderation_candidates (
          id TEXT PRIMARY KEY,
          source_document_id TEXT NOT NULL REFERENCES sleeve_source_documents(id),
          fingerprint TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          category TEXT NOT NULL,
          topic TEXT NOT NULL,
          wording TEXT NOT NULL,
          short_wording TEXT NOT NULL DEFAULT '',
          evidence TEXT NOT NULL,
          original_json TEXT NOT NULL,
          rejection_reason TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'approved', 'deleted', 'retained')),
          claim_id TEXT REFERENCES sleeve_claims(id),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          reviewed_at TEXT,
          reviewed_by TEXT, bin_entered_at TEXT, rejection_origin TEXT NOT NULL DEFAULT 'legacy', reason_detail TEXT NOT NULL DEFAULT '', dj_rejection_count INTEGER NOT NULL DEFAULT 0,
          UNIQUE(source_document_id, fingerprint)
        );

CREATE TABLE sleeve_moderation_history (
          id TEXT PRIMARY KEY,
          candidate_id TEXT NOT NULL REFERENCES sleeve_moderation_candidates(id),
          action TEXT NOT NULL,
          actor TEXT NOT NULL,
          detail_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

CREATE TABLE sleeve_musicbrainz_series (
            series_mbid TEXT PRIMARY KEY,
            series_name TEXT NOT NULL,
            entity_type TEXT NOT NULL CHECK (entity_type IN ('recording', 'release-group')),
            ranked INTEGER NOT NULL DEFAULT 0 CHECK (ranked IN (0, 1)),
            series_order INTEGER NOT NULL,
            edition_group TEXT,
            edition_year INTEGER,
            fetched_at TEXT,
            next_refresh_at TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            updated_at TEXT NOT NULL
          , enabled INTEGER NOT NULL DEFAULT 1, origin TEXT NOT NULL DEFAULT 'supplied', removed INTEGER NOT NULL DEFAULT 0);

CREATE TABLE sleeve_musicbrainz_series_members (
            series_mbid TEXT NOT NULL REFERENCES sleeve_musicbrainz_series(series_mbid) ON DELETE CASCADE,
            entity_mbid TEXT NOT NULL,
            entity_title TEXT NOT NULL,
            rank_value TEXT,
            PRIMARY KEY(series_mbid, entity_mbid)
          );

CREATE TABLE sleeve_operator_research (
      id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
      area TEXT NOT NULL, note TEXT NOT NULL, source_url TEXT NOT NULL, subject_label TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued', phase TEXT NOT NULL DEFAULT 'discovery',
      candidates_json TEXT NOT NULL DEFAULT '[]', source_index INTEGER NOT NULL DEFAULT 0,
      current_source_id TEXT, extracted_json TEXT, attempts INTEGER NOT NULL DEFAULT 0, run_after TEXT,
      search_calls INTEGER NOT NULL DEFAULT 0, pages_read INTEGER NOT NULL DEFAULT 0,
      llm_calls INTEGER NOT NULL DEFAULT 0, reported_tokens INTEGER NOT NULL DEFAULT 0,
      stories_added INTEGER NOT NULL DEFAULT 0, review_items INTEGER NOT NULL DEFAULT 0,
      last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );

CREATE TABLE sleeve_operator_research_sources (
      request_id TEXT NOT NULL REFERENCES sleeve_operator_research(id) ON DELETE CASCADE,
      url TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, detail TEXT,
      source_document_id TEXT, retrieved_at TEXT,
      PRIMARY KEY(request_id, url)
    );

CREATE TABLE sleeve_provider_requests (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        capability TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        completed_at TEXT,
        outcome TEXT NOT NULL CHECK (outcome IN ('started', 'ready', 'no-match', 'failed', 'rate-limited')),
        status_code INTEGER
      );

CREATE TABLE sleeve_queue_promotions (job_id TEXT PRIMARY KEY, requested_at TEXT NOT NULL);

CREATE TABLE sleeve_recording_releases (
        recording_id TEXT NOT NULL REFERENCES sleeve_recordings(id),
        release_id TEXT NOT NULL REFERENCES sleeve_releases(id),
        release_date TEXT,
        country TEXT,
        artist_credit TEXT,
        is_compilation INTEGER NOT NULL DEFAULT 0,
        is_first_official_non_compilation INTEGER NOT NULL DEFAULT 0,
        is_canonical_home INTEGER NOT NULL DEFAULT 0,
        selection_reason TEXT,
        PRIMARY KEY(recording_id, release_id)
      );

CREATE TABLE sleeve_recordings (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        artist_id TEXT REFERENCES sleeve_artists(id),
        musicbrainz_id TEXT UNIQUE,
        match_state TEXT NOT NULL CHECK (match_state IN ('unmatched', 'ambiguous', 'matched')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

CREATE TABLE sleeve_releases (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        musicbrainz_release_id TEXT UNIQUE,
        musicbrainz_release_group_id TEXT,
        primary_type TEXT,
        status TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

CREATE TABLE sleeve_research_jobs (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        subject_type TEXT NOT NULL CHECK (subject_type IN ('local-track', 'artist', 'recording', 'release')),
        subject_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'retry-at', 'complete', 'failed', 'cancelled')),
        priority INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        run_after TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, origin_local_track_id TEXT, completed_at TEXT, wikipedia_refresh_mode TEXT, wikipedia_refreshed_at TEXT, operator_requested INTEGER NOT NULL DEFAULT 0,
        UNIQUE(provider, subject_type, subject_id, capability)
      );

CREATE TABLE sleeve_research_pacing (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        next_pair_at TEXT NOT NULL
      , last_pair_at TEXT, pair_interval_ms INTEGER NOT NULL DEFAULT 120000, empty_station_interval_ms INTEGER NOT NULL DEFAULT 60000, last_slot_kind TEXT NOT NULL DEFAULT 'research' CHECK(last_slot_kind IN ('research','review')));

CREATE TABLE sleeve_research_progress (
        job_id TEXT PRIMARY KEY REFERENCES sleeve_research_jobs(id) ON DELETE CASCADE,
        source_document_id TEXT NOT NULL,
        next_section INTEGER NOT NULL DEFAULT 0,
        accepted_sections_json TEXT NOT NULL DEFAULT '[]',
        rejected_json TEXT NOT NULL DEFAULT '[]',
        pending_candidates_json TEXT,
        updated_at TEXT NOT NULL
      , candidate_sections_json TEXT NOT NULL DEFAULT '[]', check_cursor INTEGER NOT NULL DEFAULT 0, ranked_claim_ids_json TEXT, plays_consumed INTEGER NOT NULL DEFAULT 0);

CREATE TABLE sleeve_segment_lines (
      segment_id TEXT NOT NULL, line_index INTEGER NOT NULL CHECK(line_index BETWEEN 0 AND 11),
      line_count INTEGER NOT NULL CHECK(line_count BETWEEN 1 AND 12),
      speaker_id TEXT NOT NULL, speaker_name TEXT NOT NULL, text TEXT NOT NULL, aired_at TEXT NOT NULL,
      PRIMARY KEY(segment_id,line_index)
    );

CREATE TABLE sleeve_series_library_albums (
      local_album_id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      scan_generation TEXT,
      pending INTEGER NOT NULL DEFAULT 1
    );

CREATE TABLE sleeve_series_library_claims (
        local_track_id TEXT NOT NULL,
        local_album_id TEXT NOT NULL,
        claim_id TEXT NOT NULL REFERENCES sleeve_claims(id),
        series_mbid TEXT NOT NULL,
        member_mbid TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (local_track_id, claim_id)
      );

CREATE TABLE sleeve_series_library_scan (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        album_offset INTEGER NOT NULL DEFAULT 0,
        next_scan_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

CREATE TABLE sleeve_series_release_groups (
        release_mbid TEXT PRIMARY KEY,
        release_group_mbid TEXT,
        checked_at TEXT NOT NULL
      );

CREATE TABLE "sleeve_source_documents" (
            id TEXT PRIMARY KEY,
            entity_type TEXT NOT NULL CHECK (entity_type IN ('artist', 'recording', 'release', 'release-group')),
            entity_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            source_url TEXT NOT NULL,
            revision_id TEXT,
            content_hash TEXT NOT NULL,
            content_kind TEXT NOT NULL CHECK (content_kind IN ('bounded-text', 'structured-json')),
            content TEXT NOT NULL,
            attribution TEXT NOT NULL,
            retrieved_at TEXT NOT NULL, wikipedia_pruned_at TEXT, wikipedia_completed_at TEXT,
            UNIQUE(provider, entity_type, entity_id, source_url, revision_id, content_hash)
          );

CREATE TABLE sleeve_spark_feedback (
      use_id TEXT PRIMARY KEY REFERENCES sleeve_claim_uses(id) ON DELETE CASCADE,
      story TEXT CHECK (story IN ('good', 'routine', 'unclear', 'incorrect', 'wrong-subject')),
      delivery TEXT CHECK (delivery IN ('worked', 'forced', 'wrong-subject')),
      note TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      CHECK (story IS NOT NULL OR delivery IS NOT NULL)
    );

CREATE TABLE sleeve_wikipedia_chunk_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        source_document_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        input_characters INTEGER NOT NULL,
        elapsed_ms INTEGER NOT NULL,
        profile_hash TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('success', 'deadline', 'quiet', 'error')),
        created_at TEXT NOT NULL
      , input_tokens INTEGER, output_tokens INTEGER, target_characters INTEGER);

CREATE TABLE sleeve_wikipedia_refresh_plan (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      requested_at TEXT NOT NULL
    );

CREATE TABLE sleeve_wikipedia_rescan_requests (
        job_id TEXT PRIMARY KEY REFERENCES sleeve_research_jobs(id) ON DELETE CASCADE,
        encounter_count_at_request INTEGER NOT NULL,
        requested_at TEXT NOT NULL
      , refresh_mode TEXT NOT NULL DEFAULT 'replace'
        CHECK (refresh_mode IN ('clear', 'replace')));

CREATE TABLE sleeve_wikipedia_scan_chunks (
        job_id TEXT NOT NULL REFERENCES sleeve_research_jobs(id) ON DELETE CASCADE,
        source_document_id TEXT NOT NULL REFERENCES sleeve_source_documents(id),
        chunk_index INTEGER NOT NULL,
        section_path TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        raw_response TEXT NOT NULL,
        items_json TEXT NOT NULL DEFAULT '[]',
        elapsed_ms INTEGER NOT NULL,
        parsed_count INTEGER NOT NULL,
        retained_count INTEGER NOT NULL,
        created_at TEXT NOT NULL, accepted_candidates_json TEXT NOT NULL DEFAULT '[]', input_characters INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(job_id, source_document_id, chunk_index)
      );

CREATE TABLE sleeve_wikipedia_scan_history (
        job_id TEXT NOT NULL,
        source_document_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        section_path TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        raw_response TEXT NOT NULL,
        items_json TEXT NOT NULL,
        elapsed_ms INTEGER NOT NULL,
        parsed_count INTEGER NOT NULL,
        retained_count INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        archived_at TEXT NOT NULL
      );

CREATE TABLE sleeve_wikipedia_scan_progress (
        job_id TEXT PRIMARY KEY REFERENCES sleeve_research_jobs(id) ON DELETE CASCADE,
        source_document_id TEXT NOT NULL REFERENCES sleeve_source_documents(id),
        source_format_version INTEGER NOT NULL DEFAULT 2,
        chunk_count INTEGER NOT NULL,
        next_chunk INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      , chunk_characters INTEGER NOT NULL DEFAULT 20000, prompt_hash TEXT NOT NULL DEFAULT '');

CREATE TABLE uses (
      id TEXT PRIMARY KEY,
      claim_id TEXT NOT NULL REFERENCES claims(id),
      consumer TEXT NOT NULL,
      track_id TEXT,
      aired_at TEXT,
      final_text TEXT,
      created_at TEXT NOT NULL
    );

CREATE INDEX idx_sleeve_airing_review_queue ON sleeve_airing_reviews(state,created_at);

CREATE INDEX idx_sleeve_brain_album_track ON sleeve_brain_album_requests(local_track_id,state);

CREATE INDEX idx_sleeve_claim_uses_air ON sleeve_claim_uses(aired_at DESC, id DESC) WHERE aired_at IS NOT NULL;

CREATE INDEX idx_sleeve_claim_uses_claim
            ON sleeve_claim_uses(claim_id, supplied_at DESC);

CREATE INDEX idx_sleeve_claim_uses_entity
            ON sleeve_claim_uses(entity_type, entity_id, supplied_at DESC);

CREATE INDEX idx_sleeve_claim_uses_relationship
            ON sleeve_claim_uses(relationship_key, supplied_at DESC);

CREATE INDEX idx_sleeve_claim_uses_segment ON sleeve_claim_uses(segment_id) WHERE segment_id IS NOT NULL;

CREATE INDEX idx_sleeve_claim_uses_topic
            ON sleeve_claim_uses(entity_type, entity_id, topic, supplied_at DESC);

CREATE INDEX idx_sleeve_claim_uses_tts
        ON sleeve_claim_uses(tts_requested_at DESC);

CREATE INDEX idx_sleeve_claims_entity ON claims(entity_id, enabled);

CREATE INDEX idx_sleeve_claims_selection
            ON sleeve_claims(entity_type, entity_id, category, enabled);

CREATE INDEX idx_sleeve_claims_source ON sleeve_claims(source_document_id);

CREATE INDEX idx_sleeve_connection_edges_claim ON sleeve_connection_edges(claim_id);

CREATE INDEX idx_sleeve_connection_edges_source ON sleeve_connection_edges(source_recording_id);

CREATE INDEX idx_sleeve_connection_edges_target
        ON sleeve_connection_edges(target_kind, target_provider_id, relationship_type);

CREATE INDEX idx_sleeve_connection_library_artist_name
        ON sleeve_connection_library_artists(name_key);

CREATE INDEX idx_sleeve_connection_library_artist_tracks
      ON sleeve_connection_library_tracks(artist_key,title_key,local_track_id);

CREATE INDEX idx_sleeve_connection_library_identity
        ON sleeve_connection_library_tracks(title_key, artist_key);

CREATE INDEX idx_sleeve_connection_library_matches_recording
        ON sleeve_connection_library_matches(recording_id);

CREATE INDEX idx_sleeve_discoveries_root ON discoveries(root_entity_id, depth);

CREATE INDEX idx_sleeve_encounters_played_track
        ON sleeve_encounters(source, local_track_id, encountered_at);

CREATE INDEX idx_sleeve_encounters_recent ON sleeve_encounters(encountered_at DESC);

CREATE INDEX idx_sleeve_entities_local ON entities(kind, local_id);

CREATE INDEX idx_sleeve_genius_local_recording ON sleeve_genius_local_tracks(recording_id);

CREATE INDEX idx_sleeve_genius_seed_identity ON sleeve_genius_library_seeds(artist_key,title_key);

CREATE INDEX idx_sleeve_genius_seed_recording ON sleeve_genius_library_seeds(recording_id);

CREATE INDEX idx_sleeve_genius_traversal_name ON sleeve_genius_traversal(title_key,artist_key);

CREATE INDEX idx_sleeve_local_attachments_recording ON sleeve_local_attachments(recording_id);

CREATE INDEX idx_sleeve_mb_series_members_entity
            ON sleeve_musicbrainz_series_members(entity_mbid, series_mbid);

CREATE INDEX idx_sleeve_mb_series_refresh
            ON sleeve_musicbrainz_series(next_refresh_at, series_order);

CREATE INDEX idx_sleeve_moderation_bin_expiry
        ON sleeve_moderation_candidates(status, bin_entered_at);

CREATE INDEX idx_sleeve_moderation_queue
          ON sleeve_moderation_candidates(status, updated_at DESC);

CREATE UNIQUE INDEX idx_sleeve_operator_research_active ON sleeve_operator_research(fingerprint)
      WHERE state IN ('queued', 'running', 'deferred');

CREATE INDEX idx_sleeve_provider_local_matches_track
        ON provider_local_matches(local_track_id);

CREATE INDEX idx_sleeve_provider_requests_provider_time ON sleeve_provider_requests(provider, requested_at);

CREATE INDEX idx_sleeve_recording_releases_recording ON sleeve_recording_releases(recording_id, release_date);

CREATE INDEX idx_sleeve_recordings_artist ON sleeve_recordings(artist_id);

CREATE INDEX idx_sleeve_releases_group
        ON sleeve_releases(musicbrainz_release_group_id);

CREATE INDEX idx_sleeve_research_jobs_due ON sleeve_research_jobs(provider, state, run_after, priority DESC);

CREATE INDEX idx_sleeve_series_library_claims_album
        ON sleeve_series_library_claims(local_album_id);

CREATE INDEX idx_sleeve_series_pending_albums
      ON sleeve_series_library_albums(pending, local_album_id);

CREATE INDEX idx_sleeve_source_entity_provider
            ON sleeve_source_documents(entity_type, entity_id, provider, retrieved_at DESC);

CREATE INDEX idx_sleeve_uses_claim ON uses(claim_id, created_at DESC);

CREATE INDEX idx_sleeve_wikipedia_chunk_attempts_recent
        ON sleeve_wikipedia_chunk_attempts(created_at DESC);

CREATE INDEX idx_sleeve_wikipedia_chunks_source ON sleeve_wikipedia_scan_chunks(source_document_id);

CREATE INDEX idx_sleeve_wikipedia_scan_chunks_job
        ON sleeve_wikipedia_scan_chunks(job_id, source_document_id, chunk_index);

CREATE INDEX idx_sleeve_wikipedia_scan_history_job
        ON sleeve_wikipedia_scan_history(job_id, archived_at, chunk_index);

CREATE TRIGGER sleeve_connection_revision_sleeve_artists_delete
          AFTER DELETE ON sleeve_artists WHEN (1) AND (1) BEGIN UPDATE sleeve_connection_revisions SET overview = overview + 1, facts = facts + 1 WHERE id = 1; END;

CREATE TRIGGER sleeve_connection_revision_sleeve_artists_insert
          AFTER INSERT ON sleeve_artists WHEN (1) AND (1) BEGIN UPDATE sleeve_connection_revisions SET overview = overview + 1, facts = facts + 1 WHERE id = 1; END;

CREATE TRIGGER sleeve_connection_revision_sleeve_artists_update
          AFTER UPDATE ON sleeve_artists WHEN (1) AND (OLD.id IS NOT NEW.id OR OLD.name IS NOT NEW.name OR OLD.musicbrainz_id IS NOT NEW.musicbrainz_id) BEGIN UPDATE sleeve_connection_revisions SET overview = overview + 1, facts = facts + 1 WHERE id = 1; END;

CREATE TRIGGER sleeve_connection_revision_sleeve_claims_delete
          AFTER DELETE ON sleeve_claims WHEN ((OLD.entity_type = 'recording' AND OLD.category IN ('credits', 'musical-connections')
          AND EXISTS (SELECT 1 FROM sleeve_source_documents WHERE id = OLD.source_document_id AND provider = 'genius'))) AND (1) BEGIN UPDATE sleeve_connection_revisions SET overview = overview + 1, facts = facts + 1 WHERE id = 1; END;

CREATE TRIGGER sleeve_connection_revision_sleeve_claims_insert
          AFTER INSERT ON sleeve_claims WHEN ((NEW.entity_type = 'recording' AND NEW.category IN ('credits', 'musical-connections')
          AND EXISTS (SELECT 1 FROM sleeve_source_documents WHERE id = NEW.source_document_id AND provider = 'genius'))) AND (1) BEGIN UPDATE sleeve_connection_revisions SET overview = overview + 1, facts = facts + 1 WHERE id = 1; END;

CREATE TRIGGER sleeve_connection_revision_sleeve_claims_update
          AFTER UPDATE ON sleeve_claims WHEN (((OLD.entity_type = 'recording' AND OLD.category IN ('credits', 'musical-connections')
          AND EXISTS (SELECT 1 FROM sleeve_source_documents WHERE id = OLD.source_document_id AND provider = 'genius')) OR (NEW.entity_type = 'recording' AND NEW.category IN ('credits', 'musical-connections')
          AND EXISTS (SELECT 1 FROM sleeve_source_documents WHERE id = NEW.source_document_id AND provider = 'genius')))) AND (OLD.id IS NOT NEW.id OR OLD.entity_type IS NOT NEW.entity_type OR OLD.entity_id IS NOT NEW.entity_id OR OLD.category IS NOT NEW.category OR OLD.source_document_id IS NOT NEW.source_document_id OR OLD.evidence IS NOT NEW.evidence OR OLD.enabled IS NOT NEW.enabled) BEGIN UPDATE sleeve_connection_revisions SET overview = overview + 1, facts = facts + 1 WHERE id = 1; END;

CREATE TRIGGER sleeve_connection_revision_sleeve_connection_edges_delete
          AFTER DELETE ON sleeve_connection_edges WHEN (1) AND (1) BEGIN UPDATE sleeve_connection_revisions SET overview = overview + 1 WHERE id = 1; END;

CREATE TRIGGER sleeve_connection_revision_sleeve_connection_edges_insert
          AFTER INSERT ON sleeve_connection_edges WHEN (1) AND (1) BEGIN UPDATE sleeve_connection_revisions SET overview = overview + 1 WHERE id = 1; END;

CREATE TRIGGER sleeve_connection_revision_sleeve_connection_edges_update
          AFTER UPDATE ON sleeve_connection_edges WHEN (1) AND (OLD.id IS NOT NEW.id OR OLD.claim_id IS NOT NEW.claim_id OR OLD.claim_evidence IS NOT NEW.claim_evidence OR OLD.source_recording_id IS NOT NEW.source_recording_id OR OLD.relationship_type IS NOT NEW.relationship_type OR OLD.target_kind IS NOT NEW.target_kind OR OLD.target_provider_id IS NOT NEW.target_provider_id OR OLD.match_state IS NOT NEW.match_state OR OLD.target_title IS NOT NEW.target_title OR OLD.target_artist IS NOT NEW.target_artist OR OLD.target_url IS NOT NEW.target_url) BEGIN UPDATE sleeve_connection_revisions SET overview = overview + 1 WHERE id = 1; END;

CREATE TRIGGER sleeve_connection_revision_sleeve_connection_library_artists_delete
          AFTER DELETE ON sleeve_connection_library_artists WHEN (1) AND (1) BEGIN UPDATE sleeve_connection_revisions SET overview = overview + 1 WHERE id = 1; END;

CREATE TRIGGER sleeve_connection_revision_sleeve_connection_library_artists_insert
          AFTER INSERT ON sleeve_connection_library_artists WHEN (1) AND (1) BEGIN UPDATE sleeve_connection_revisions SET overview = overview + 1 WHERE id = 1; END;

CREATE TRIGGER sleeve_connection_revision_sleeve_connection_library_artists_update
          AFTER UPDATE ON sleeve_connection_library_artists WHEN (1) AND (OLD.local_artist_id IS NOT NEW.local_artist_id OR OLD.name IS NOT NEW.name OR OLD.name_key IS NOT NEW.name_key) BEGIN UPDATE sleeve_connection_revisions SET overview = overview + 1 WHERE id = 1; END;

CREATE TRIGGER sleeve_connection_revision_sleeve_connection_library_matches_delete
          AFTER DELETE ON sleeve_connection_library_matches WHEN (1) AND (1) BEGIN UPDATE sleeve_connection_revisions SET overview = overview + 1 WHERE id = 1; END;

CREATE TRIGGER sleeve_connection_revision_sleeve_connection_library_matches_insert
          AFTER INSERT ON sleeve_connection_library_matches WHEN (1) AND (1) BEGIN UPDATE sleeve_connection_revisions SET overview = overview + 1 WHERE id = 1; END;

CREATE TRIGGER sleeve_connection_revision_sleeve_connection_library_matches_update
          AFTER UPDATE ON sleeve_connection_library_matches WHEN (1) AND (OLD.edge_id IS NOT NEW.edge_id OR OLD.local_track_id IS NOT NEW.local_track_id OR OLD.recording_id IS NOT NEW.recording_id OR OLD.match_basis IS NOT NEW.match_basis) BEGIN UPDATE sleeve_connection_revisions SET overview = overview + 1 WHERE id = 1; END;

CREATE TRIGGER sleeve_connection_revision_sleeve_connection_library_scan_delete
          AFTER DELETE ON sleeve_connection_library_scan WHEN (1) AND (1) BEGIN UPDATE sleeve_connection_revisions SET overview = overview + 1 WHERE id = 1; END;

CREATE TRIGGER sleeve_connection_revision_sleeve_connection_library_scan_insert
          AFTER INSERT ON sleeve_connection_library_scan WHEN (1) AND (1) BEGIN UPDATE sleeve_connection_revisions SET overview = overview + 1 WHERE id = 1; END;

CREATE TRIGGER sleeve_connection_revision_sleeve_connection_library_scan_update
          AFTER UPDATE ON sleeve_connection_library_scan WHEN (1) AND (OLD.completed_at IS NOT NEW.completed_at) BEGIN UPDATE sleeve_connection_revisions SET overview = overview + 1 WHERE id = 1; END;

CREATE TRIGGER sleeve_connection_revision_sleeve_connection_library_tracks_delete
          AFTER DELETE ON sleeve_connection_library_tracks WHEN (1) AND (1) BEGIN UPDATE sleeve_connection_revisions SET overview = overview + 1, facts = facts + 1 WHERE id = 1; END;

CREATE TRIGGER sleeve_connection_revision_sleeve_connection_library_tracks_insert
          AFTER INSERT ON sleeve_connection_library_tracks WHEN (1) AND (1) BEGIN UPDATE sleeve_connection_revisions SET overview = overview + 1, facts = facts + 1 WHERE id = 1; END;

CREATE TRIGGER sleeve_connection_revision_sleeve_connection_library_tracks_update
          AFTER UPDATE ON sleeve_connection_library_tracks WHEN (1) AND (OLD.local_track_id IS NOT NEW.local_track_id OR OLD.title IS NOT NEW.title OR OLD.artist IS NOT NEW.artist OR OLD.album IS NOT NEW.album OR OLD.musicbrainz_recording_id IS NOT NEW.musicbrainz_recording_id OR OLD.title_key IS NOT NEW.title_key OR OLD.artist_key IS NOT NEW.artist_key) BEGIN UPDATE sleeve_connection_revisions SET overview = overview + 1, facts = facts + 1 WHERE id = 1; END;

CREATE TRIGGER sleeve_connection_revision_sleeve_local_attachments_delete
          AFTER DELETE ON sleeve_local_attachments WHEN (1) AND (1) BEGIN UPDATE sleeve_connection_revisions SET overview = overview + 1, facts = facts + 1 WHERE id = 1; END;

CREATE TRIGGER sleeve_connection_revision_sleeve_local_attachments_insert
          AFTER INSERT ON sleeve_local_attachments WHEN (1) AND (1) BEGIN UPDATE sleeve_connection_revisions SET overview = overview + 1, facts = facts + 1 WHERE id = 1; END;

CREATE TRIGGER sleeve_connection_revision_sleeve_local_attachments_update
          AFTER UPDATE ON sleeve_local_attachments WHEN (1) AND (OLD.local_track_id IS NOT NEW.local_track_id OR OLD.recording_id IS NOT NEW.recording_id OR OLD.match_state IS NOT NEW.match_state) BEGIN UPDATE sleeve_connection_revisions SET overview = overview + 1, facts = facts + 1 WHERE id = 1; END;

CREATE TRIGGER sleeve_connection_revision_sleeve_recordings_delete
          AFTER DELETE ON sleeve_recordings WHEN (1) AND (1) BEGIN UPDATE sleeve_connection_revisions SET overview = overview + 1, facts = facts + 1 WHERE id = 1; END;

CREATE TRIGGER sleeve_connection_revision_sleeve_recordings_insert
          AFTER INSERT ON sleeve_recordings WHEN (1) AND (1) BEGIN UPDATE sleeve_connection_revisions SET overview = overview + 1, facts = facts + 1 WHERE id = 1; END;

CREATE TRIGGER sleeve_connection_revision_sleeve_recordings_update
          AFTER UPDATE ON sleeve_recordings WHEN (1) AND (OLD.id IS NOT NEW.id OR OLD.title IS NOT NEW.title OR OLD.artist_id IS NOT NEW.artist_id OR OLD.musicbrainz_id IS NOT NEW.musicbrainz_id) BEGIN UPDATE sleeve_connection_revisions SET overview = overview + 1, facts = facts + 1 WHERE id = 1; END;

CREATE TRIGGER sleeve_connection_revision_sleeve_source_documents_delete
          AFTER DELETE ON sleeve_source_documents WHEN ((OLD.provider = 'genius' AND OLD.entity_type = 'recording')) AND (1) BEGIN UPDATE sleeve_connection_revisions SET overview = overview + 1, facts = facts + 1 WHERE id = 1; END;

CREATE TRIGGER sleeve_connection_revision_sleeve_source_documents_insert
          AFTER INSERT ON sleeve_source_documents WHEN ((NEW.provider = 'genius' AND NEW.entity_type = 'recording')) AND (1) BEGIN UPDATE sleeve_connection_revisions SET overview = overview + 1, facts = facts + 1 WHERE id = 1; END;

CREATE TRIGGER sleeve_connection_revision_sleeve_source_documents_update
          AFTER UPDATE ON sleeve_source_documents WHEN (((OLD.provider = 'genius' AND OLD.entity_type = 'recording') OR (NEW.provider = 'genius' AND NEW.entity_type = 'recording'))) AND (OLD.id IS NOT NEW.id OR OLD.entity_type IS NOT NEW.entity_type OR OLD.entity_id IS NOT NEW.entity_id OR OLD.provider IS NOT NEW.provider OR OLD.content IS NOT NEW.content OR OLD.source_url IS NOT NEW.source_url OR OLD.attribution IS NOT NEW.attribution) BEGIN UPDATE sleeve_connection_revisions SET overview = overview + 1, facts = facts + 1 WHERE id = 1; END;

CREATE TRIGGER sleeve_feedback_hold
      BEFORE UPDATE ON sleeve_claims
      WHEN NEW.enabled = 1 AND NEW.feedback_hold = 1
      BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER sleeve_genius_local_delete AFTER DELETE ON sleeve_genius_local_tracks BEGIN
      UPDATE sleeve_connection_revisions SET facts = facts + 1, overview = overview + 1 WHERE id = 1;
    END;

CREATE TRIGGER sleeve_genius_local_insert AFTER INSERT ON sleeve_genius_local_tracks BEGIN
      UPDATE sleeve_connection_revisions SET facts = facts + 1, overview = overview + 1 WHERE id = 1;
    END;

CREATE TRIGGER sleeve_genius_local_update AFTER UPDATE ON sleeve_genius_local_tracks BEGIN
      UPDATE sleeve_connection_revisions SET facts=facts+1,overview=overview+1 WHERE id=1;
    END;

CREATE TRIGGER sleeve_genius_seed_delete
      AFTER DELETE ON sleeve_genius_library_seeds BEGIN
      UPDATE sleeve_connection_revisions SET facts=facts+1,overview=overview+1 WHERE id=1; END;

CREATE TRIGGER sleeve_genius_seed_insert
      AFTER INSERT ON sleeve_genius_library_seeds BEGIN
      UPDATE sleeve_connection_revisions SET facts=facts+1,overview=overview+1 WHERE id=1; END;

CREATE TRIGGER sleeve_genius_seed_update
      AFTER UPDATE ON sleeve_genius_library_seeds BEGIN
      UPDATE sleeve_connection_revisions SET facts=facts+1,overview=overview+1 WHERE id=1; END;

INSERT INTO sleeve_connection_revisions(id, facts, overview) VALUES (1, 0, 0);

CREATE INDEX idx_sleeve_connection_source_local ON sleeve_connection_edges(source_local_track_id);
