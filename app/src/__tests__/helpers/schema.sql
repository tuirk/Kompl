-- Final schema for unit tests. Mirrors scripts/migrate.py at SCHEMA_VERSION=15.
-- If migrate.py changes, update this file. Tests will fail loudly on drift.

CREATE TABLE sources (
  source_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_url TEXT,
  content_hash TEXT NOT NULL,
  file_path TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  date_ingested DATETIME DEFAULT CURRENT_TIMESTAMP,
  metadata JSON,
  compile_status TEXT DEFAULT 'pending',
  compile_attempts INTEGER DEFAULT 0,
  compile_next_eligible_at DATETIME,
  onboarding_session_id TEXT
);

CREATE TABLE pages (
  page_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  page_type TEXT NOT NULL,
  category TEXT,
  summary TEXT,
  content_path TEXT NOT NULL,
  previous_content_path TEXT,
  last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
  source_count INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  pending_content TEXT
);

CREATE TABLE provenance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES sources(source_id),
  page_id TEXT NOT NULL REFERENCES pages(page_id),
  content_hash TEXT NOT NULL,
  date_compiled DATETIME DEFAULT CURRENT_TIMESTAMP,
  contribution_type TEXT NOT NULL
);

CREATE TABLE drafts (
  draft_id TEXT PRIMARY KEY,
  page_id TEXT,
  draft_content TEXT NOT NULL,
  draft_type TEXT NOT NULL,
  source_id TEXT,
  status TEXT DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  action_type TEXT NOT NULL,
  source_id TEXT,
  details JSON
);

CREATE TABLE aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alias TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  canonical_page_id TEXT REFERENCES pages(page_id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE page_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_page_id TEXT NOT NULL REFERENCES pages(page_id),
  target_page_id TEXT NOT NULL REFERENCES pages(page_id),
  link_type TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE extractions (
  source_id TEXT PRIMARY KEY REFERENCES sources(source_id),
  ner_output JSON NOT NULL,
  profile TEXT NOT NULL,
  keyphrase_output JSON,
  tfidf_output JSON,
  llm_output JSON NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE page_plans (
  plan_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  title TEXT NOT NULL,
  page_type TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'create',
  source_ids JSON NOT NULL,
  existing_page_id TEXT,
  related_plan_ids JSON,
  draft_content TEXT,
  draft_status TEXT DEFAULT 'planned',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE compile_progress (
  session_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'queued',
  current_step TEXT,
  steps JSON NOT NULL,
  error TEXT,
  started_at DATETIME,
  completed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  source_count INTEGER DEFAULT 0
);

CREATE TABLE chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  citations JSON,
  pages_used JSON,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE ingest_failures (
  failure_id TEXT PRIMARY KEY,
  source_url TEXT,
  title_hint TEXT,
  date_saved TEXT,
  date_attempted DATETIME DEFAULT CURRENT_TIMESTAMP,
  error TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'url',
  resolved_source_id TEXT,
  metadata JSON
);

CREATE TABLE vector_backfill_queue (
  page_id TEXT PRIMARY KEY,
  queued_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE VIRTUAL TABLE pages_fts USING fts5(
  page_id,
  title,
  content
);

-- Indexes
CREATE INDEX idx_sources_status ON sources(status);
CREATE INDEX idx_sources_type ON sources(source_type);
CREATE INDEX idx_sources_compile_status_date ON sources(compile_status, date_ingested);
CREATE INDEX idx_sources_session ON sources(onboarding_session_id);
CREATE INDEX idx_pages_type ON pages(page_type);
CREATE INDEX idx_pages_category ON pages(category);
CREATE INDEX idx_pages_pending_flush ON pages(page_id) WHERE pending_content IS NOT NULL;
CREATE INDEX idx_provenance_source ON provenance(source_id);
CREATE INDEX idx_provenance_page ON provenance(page_id);
CREATE INDEX idx_drafts_status ON drafts(status);
CREATE INDEX idx_drafts_page ON drafts(page_id);
CREATE INDEX idx_activity_action ON activity_log(action_type);
CREATE INDEX idx_activity_source ON activity_log(source_id);
CREATE INDEX idx_activity_timestamp ON activity_log(timestamp);
CREATE INDEX idx_aliases_alias ON aliases(alias);
CREATE INDEX idx_aliases_canonical ON aliases(canonical_name);
CREATE INDEX idx_page_links_source ON page_links(source_page_id);
CREATE INDEX idx_page_links_target ON page_links(target_page_id);
CREATE UNIQUE INDEX idx_page_links_unique ON page_links(source_page_id, target_page_id, link_type);
CREATE INDEX idx_extractions_source ON extractions(source_id);
CREATE INDEX idx_page_plans_session ON page_plans(session_id);
CREATE INDEX idx_page_plans_status ON page_plans(draft_status);
CREATE INDEX idx_chat_session ON chat_messages(session_id);
CREATE INDEX idx_ingest_failures_url ON ingest_failures(source_url);
CREATE INDEX idx_ingest_failures_resolved ON ingest_failures(resolved_source_id);

INSERT INTO settings (key, value) VALUES ('schema_version', '16');
