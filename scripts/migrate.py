#!/usr/bin/env python3
"""Database migration runner for Kompl (ISS-002)."""

import os
import sys
try:
    import sqlite3
except ImportError:
    print("ERROR: sqlite3 not available. Use full python3, not python3-minimal.", file=sys.stderr)
    sys.exit(1)

DB_PATH = os.environ.get("DB_PATH", os.path.join("data", "db", "kompl.db"))

SCHEMA_VERSION = 30

SCHEMA_SQL = """
-- Sources: raw ingested content metadata
CREATE TABLE IF NOT EXISTS sources (
  source_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_url TEXT,
  content_hash TEXT NOT NULL,
  file_path TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  date_ingested DATETIME DEFAULT CURRENT_TIMESTAMP,
  metadata JSON
);

-- Pages: compiled wiki pages
CREATE TABLE IF NOT EXISTS pages (
  page_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  page_type TEXT NOT NULL,
  category TEXT,
  summary TEXT,
  content_path TEXT NOT NULL,
  previous_content_path TEXT,
  last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
  source_count INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Provenance: source → page relationships
CREATE TABLE IF NOT EXISTS provenance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES sources(source_id),
  page_id TEXT NOT NULL REFERENCES pages(page_id),
  content_hash TEXT NOT NULL,
  date_compiled DATETIME DEFAULT CURRENT_TIMESTAMP,
  contribution_type TEXT NOT NULL
);

-- Drafts: pending wiki page changes
CREATE TABLE IF NOT EXISTS drafts (
  draft_id TEXT PRIMARY KEY,
  page_id TEXT,
  draft_content TEXT NOT NULL,
  draft_type TEXT NOT NULL,
  source_id TEXT,
  status TEXT DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Activity log: chronological event history
CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  action_type TEXT NOT NULL,
  source_id TEXT,
  details JSON
);

-- Aliases: entity name mappings for deduplication
CREATE TABLE IF NOT EXISTS aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alias TEXT NOT NULL,
  canonical_page_id TEXT NOT NULL REFERENCES pages(page_id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Settings: key-value store
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sources_status ON sources(status);
CREATE INDEX IF NOT EXISTS idx_sources_type ON sources(source_type);
CREATE INDEX IF NOT EXISTS idx_pages_type ON pages(page_type);
CREATE INDEX IF NOT EXISTS idx_pages_category ON pages(category);
CREATE INDEX IF NOT EXISTS idx_provenance_source ON provenance(source_id);
CREATE INDEX IF NOT EXISTS idx_provenance_page ON provenance(page_id);
CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status);
CREATE INDEX IF NOT EXISTS idx_drafts_page ON drafts(page_id);
CREATE INDEX IF NOT EXISTS idx_activity_action ON activity_log(action_type);
CREATE INDEX IF NOT EXISTS idx_activity_source ON activity_log(source_id);
CREATE INDEX IF NOT EXISTS idx_activity_timestamp ON activity_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_aliases_alias ON aliases(alias);
CREATE INDEX IF NOT EXISTS idx_aliases_page ON aliases(canonical_page_id);
"""

FTS_SQL = """
CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
  page_id,
  title,
  content
);
"""


MIGRATION_V2_SQL = """
ALTER TABLE sources ADD COLUMN compile_status TEXT DEFAULT 'pending';
ALTER TABLE sources ADD COLUMN compile_attempts INTEGER DEFAULT 0;
ALTER TABLE sources ADD COLUMN compile_next_eligible_at DATETIME;
"""

MIGRATION_V2_INDEXES_SQL = """
DROP INDEX IF EXISTS idx_sources_compile_status;
CREATE INDEX IF NOT EXISTS idx_sources_compile_status_date ON sources(compile_status, date_ingested);
"""

MIGRATION_V3_SQL = """
CREATE TABLE IF NOT EXISTS page_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_page_id TEXT NOT NULL REFERENCES pages(page_id),
  target_page_id TEXT NOT NULL REFERENCES pages(page_id),
  link_type TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
"""

MIGRATION_V3_INDEXES_SQL = """
CREATE INDEX IF NOT EXISTS idx_page_links_source ON page_links(source_page_id);
CREATE INDEX IF NOT EXISTS idx_page_links_target ON page_links(target_page_id);
"""

MIGRATION_V4_SQL = "ALTER TABLE sources ADD COLUMN onboarding_session_id TEXT"

MIGRATION_V4_INDEX_SQL = """
CREATE INDEX IF NOT EXISTS idx_sources_session ON sources(onboarding_session_id);
"""

MIGRATION_V5_SQL = """
CREATE TABLE IF NOT EXISTS extractions (
  source_id TEXT PRIMARY KEY REFERENCES sources(source_id),
  ner_output JSON NOT NULL,
  profile TEXT NOT NULL,
  keyphrase_output JSON,
  tfidf_output JSON,
  llm_output JSON NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
"""

MIGRATION_V5_INDEX_SQL = """
CREATE INDEX IF NOT EXISTS idx_extractions_source ON extractions(source_id);
"""

MIGRATION_V6_SQL = """
DROP TABLE IF EXISTS aliases;
CREATE TABLE aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alias TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  canonical_page_id TEXT REFERENCES pages(page_id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_aliases_alias ON aliases(alias);
CREATE INDEX IF NOT EXISTS idx_aliases_canonical ON aliases(canonical_name);
"""

MIGRATION_V7_SQL = """
CREATE TABLE IF NOT EXISTS page_plans (
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
CREATE INDEX IF NOT EXISTS idx_page_plans_session ON page_plans(session_id);
CREATE INDEX IF NOT EXISTS idx_page_plans_status ON page_plans(draft_status);
"""

MIGRATION_V8_SQL = """
CREATE TABLE IF NOT EXISTS compile_progress (
  session_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'queued',
  current_step TEXT,
  steps JSON NOT NULL,
  error TEXT,
  started_at DATETIME,
  completed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
"""

MIGRATION_V9_SQL = """
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  citations JSON,
  pages_used JSON,
  chat_model TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_chat_session ON chat_messages(session_id);
"""


MIGRATION_V12_SQL = """
CREATE TABLE IF NOT EXISTS ingest_failures (
  failure_id TEXT PRIMARY KEY,
  source_url TEXT,
  title_hint TEXT,
  date_saved TEXT,
  date_attempted DATETIME DEFAULT CURRENT_TIMESTAMP,
  error TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'url',
  resolved_source_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_ingest_failures_url ON ingest_failures(source_url);
CREATE INDEX IF NOT EXISTS idx_ingest_failures_resolved ON ingest_failures(resolved_source_id);
"""

MIGRATION_V13_SQL = """
CREATE TABLE IF NOT EXISTS vector_backfill_queue (
  page_id TEXT PRIMARY KEY,
  queued_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
"""

# V14: outbox column for crash-safe file writes.
# pending_content IS NOT NULL means the DB row is committed but the .md.gz file
# on disk has not yet been written (or the write failed). The boot reconciler
# and each Phase 3a flush check this column and re-attempt the file write.
MIGRATION_V14_SQL = "ALTER TABLE pages ADD COLUMN pending_content TEXT"

MIGRATION_V14_INDEX_SQL = """
CREATE INDEX IF NOT EXISTS idx_pages_pending_flush ON pages(page_id)
  WHERE pending_content IS NOT NULL;
"""

# V15: page_links unique constraint.
# The original table had no UNIQUE constraint, so INSERT OR IGNORE was a no-op
# and every recompile re-inserted duplicate rows. Deduplicate existing data first
# (keep lowest id per triple), then add a unique index so INSERT OR IGNORE works.
MIGRATION_V15_SQL = """
DELETE FROM page_links
  WHERE id NOT IN (
    SELECT MIN(id)
      FROM page_links
     GROUP BY source_page_id, target_page_id, link_type
  );
CREATE UNIQUE INDEX IF NOT EXISTS idx_page_links_unique
  ON page_links(source_page_id, target_page_id, link_type);
"""

# V16: ingest_failures.metadata JSON column.
# Holds best-effort og:title / og:description / og:image captured at
# ingest-failure time so the Saved Links page shows real context, not a bare URL.
MIGRATION_V16_SQL = "ALTER TABLE ingest_failures ADD COLUMN metadata JSON"

# V17: wiki-wide mention indexes — entities, concepts, and relationships.
# Lets the plan step ask "how many distinct sources have ever mentioned X?"
# against the entire wiki, not just the current compile session. Required for
# Karpathy-style compounding — source #47 mentioning something first seen in
# source #12 should be able to promote it to a page.
#
# entity_mentions: one row per (canonical_name, source_id). Concepts live here
# too with entity_type='CONCEPT'. COLLATE NOCASE so "GPT-4" and "gpt-4" collide.
#
# relationship_mentions: one row per (from, to, type, source_id). Pairs are
# stored in canonical-sorted order (from_canonical <= to_canonical lowercase)
# for competes_with / contradicts which are direction-agnostic, so "A vs B"
# and "B vs A" collapse to one bucket.
#
# ON DELETE CASCADE keeps counts honest when a source is removed.
MIGRATION_V17_SQL = """
CREATE TABLE IF NOT EXISTS entity_mentions (
  canonical_name TEXT NOT NULL COLLATE NOCASE,
  source_id TEXT NOT NULL REFERENCES sources(source_id) ON DELETE CASCADE,
  entity_type TEXT,
  first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (canonical_name, source_id)
);
CREATE INDEX IF NOT EXISTS idx_entity_mentions_canonical
  ON entity_mentions(canonical_name);
CREATE INDEX IF NOT EXISTS idx_entity_mentions_source
  ON entity_mentions(source_id);

CREATE TABLE IF NOT EXISTS relationship_mentions (
  from_canonical TEXT NOT NULL COLLATE NOCASE,
  to_canonical TEXT NOT NULL COLLATE NOCASE,
  relationship_type TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES sources(source_id) ON DELETE CASCADE,
  first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (from_canonical, to_canonical, relationship_type, source_id)
);
CREATE INDEX IF NOT EXISTS idx_relationship_mentions_pair
  ON relationship_mentions(from_canonical, to_canonical, relationship_type);
CREATE INDEX IF NOT EXISTS idx_relationship_mentions_source
  ON relationship_mentions(source_id);
"""

# v18: collect_staging table — holds pre-ingestion intent from onboarding
# connectors. Connectors write rows at user click-time with no scraping;
# the compile pipeline's new prelude steps (ingest_files/ingest_urls/
# ingest_texts) consume them and promote to sources. status lifecycle:
# pending → ingesting → ingested (resolved_source_id set) | failed | discarded.
# Also adds session_id to ingest_failures so retry-failed can scope by session.
# Also backfills compile_progress.steps JSON so legacy rows don't trip the
# resetForRetry walk (prelude 'pending' would otherwise wipe done steps).
MIGRATION_V18_SQL = """
CREATE TABLE IF NOT EXISTS collect_staging (
  stage_id    TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  connector   TEXT NOT NULL,
  payload     TEXT NOT NULL,
  included    INTEGER NOT NULL DEFAULT 1,
  status      TEXT NOT NULL DEFAULT 'pending',
  resolved_source_id TEXT,
  error_code  TEXT,
  error_message TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  ingested_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_collect_staging_session
  ON collect_staging(session_id);
CREATE INDEX IF NOT EXISTS idx_collect_staging_session_status
  ON collect_staging(session_id, status);
"""

MIGRATION_V18_INGEST_FAILURES_SQL = """
ALTER TABLE ingest_failures ADD COLUMN session_id TEXT;
"""

MIGRATION_V18_INGEST_FAILURES_INDEX_SQL = """
CREATE INDEX IF NOT EXISTS idx_ingest_failures_session
  ON ingest_failures(session_id);
"""

# Move any legacy sources stuck at compile_status='collected' into the new
# staging table as already-ingested, then flip the source to 'pending' so
# the compile pipeline picks it up on the next finalize/retry. Idempotent
# via OR IGNORE + status-guarded UPDATE.
MIGRATION_V18_LEGACY_COLLECTED_SQL = """
INSERT OR IGNORE INTO collect_staging
  (stage_id, session_id, connector, payload, status,
   resolved_source_id, created_at, ingested_at)
SELECT
  source_id,
  onboarding_session_id,
  CASE WHEN source_url IS NOT NULL THEN 'url'
       WHEN source_type IN ('note','tweet') THEN 'text'
       ELSE 'file-upload' END,
  json_object(
    'resumed_from_legacy', 1,
    'title', title,
    'source_url', source_url
  ),
  'ingested',
  source_id,
  date_ingested,
  date_ingested
FROM sources
WHERE compile_status = 'collected'
  AND onboarding_session_id IS NOT NULL;

UPDATE sources
   SET compile_status = 'pending'
 WHERE compile_status = 'collected';
"""

# Backfill compile_progress.steps JSON for rows created before v18 so the
# new prelude step keys default to 'done' (not missing/pending). Critical
# for resetForRetry — it walks COMPILE_STEP_KEYS and resets from the first
# non-done step. Without this, any legacy retry would reset all 12 steps
# and force a full recompile of extract/draft/commit.
MIGRATION_V18_COMPILE_PROGRESS_BACKFILL_SQL = """
UPDATE compile_progress
   SET steps = json_set(
     json_set(
       json_set(
         json_set(
           steps,
           '$.health_check', json_object('status', 'done', 'detail', 'legacy')
         ),
         '$.ingest_files', json_object('status', 'done', 'detail', 'legacy')
       ),
       '$.ingest_urls',  json_object('status', 'done', 'detail', 'legacy')
     ),
     '$.ingest_texts', json_object('status', 'done', 'detail', 'legacy')
   )
 WHERE json_extract(steps, '$.health_check') IS NULL;
"""

MIGRATION_V19_SQL = """
ALTER TABLE chat_messages ADD COLUMN chat_model TEXT;
"""

# v20: per-session compile_model lock. Mirrors the v19 chat_model pattern —
# nullable column, stamped once when the compile_progress row is created,
# preserved through retries. getSessionCompileModel() reads it; compile
# steps prefer it over the current Settings value so a running pipeline
# stays on the same model even if the user flips the Settings dropdown
# mid-compile. No backfill — legacy sessions fall back to getCompileModel()
# at each step.
MIGRATION_V20_SQL = """
ALTER TABLE compile_progress ADD COLUMN compile_model TEXT;
"""

# V21: purge the deployment_mode settings row. The personal-device vs always-on
# toggle was removed in 2026-05-06 — Kompl now targets personal computers
# exclusively. Idempotent: DELETE on a non-existent row is a no-op.
MIGRATION_V21_SQL = """
DELETE FROM settings WHERE key = 'deployment_mode';
"""

# v30 (added after v30 shipped): match triage calls that gave no verdict.
# One row per (source, page) pair; a later compile checks it again
# (app/src/lib/triage-rechecks.ts). Retry state, not wiki content, so
# backups leave it out. Deleting the source or the page removes the pair.
#   reason              the last failure: llm_rate_limited,
#                       daily_cost_ceiling or triage_error
#   attempts            failed checks, not counting daily cost ceiling
#                       refusals; the pair is dropped at the app's maximum
#   first_failed_at / last_failed_at, session_id (of the last failure)
#   verdict, verdict_reason, verdict_session_id
#                       a re-check's answer, kept until the compile session
#                       that planned it completes, so a retry that plans
#                       again still has it; NULL until then
TRIAGE_RECHECKS_SQL = """
CREATE TABLE IF NOT EXISTS triage_rechecks (
  source_id TEXT NOT NULL REFERENCES sources(source_id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  first_failed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_failed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  session_id TEXT NOT NULL,
  verdict TEXT,
  verdict_reason TEXT,
  verdict_session_id TEXT,
  PRIMARY KEY (source_id, page_id)
);
CREATE INDEX IF NOT EXISTS idx_triage_rechecks_page ON triage_rechecks(page_id);
CREATE INDEX IF NOT EXISTS idx_triage_rechecks_first_failed ON triage_rechecks(first_failed_at);
"""


def _ensure_triage_rechecks(conn: sqlite3.Connection) -> bool:
    """Create triage_rechecks when it is missing. Returns True when created."""
    exists = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'triage_rechecks'"
    ).fetchone()
    if exists:
        return False
    conn.executescript(TRIAGE_RECHECKS_SQL)
    return True


def _ensure_plan_used_source_ids(conn: sqlite3.Connection) -> bool:
    """Add page_plans.used_source_ids when missing. Returns True when added.

    used_source_ids  JSON list of the sources whose text or pre-extracted
                     data a draft's prompt carried; the commit records
                     provenance for these only (app/src/lib/plan-provenance.ts).
                     NULL for drafts made before it and for drafts that send
                     no prompt (original-source pages): those credit every
                     plan source, as before.
    Additive, no backfill. Older images never name the column.
    """
    cols = {row[1] for row in conn.execute("PRAGMA table_info(page_plans)").fetchall()}
    if not cols or "used_source_ids" in cols:
        return False
    conn.execute("ALTER TABLE page_plans ADD COLUMN used_source_ids TEXT")
    return True


# Every disagreement Kompl knows about on a page, whoever found it (plan
# 3.4; app/src/lib/disagreements.ts):
#   found_by     page_text    a "Disputed:"/"Changed:" section of the page's
#                             committed text, synced in every commit's
#                             transaction
#                triage       a new source the match triage judged to
#                             contradict the page
#                claim_check  two claims the claim check judged (plan 3.3)
#                wiki_check   the on-demand whole-wiki check (plan 3.6)
#   kind         disputed | changed | contradiction (not classified yet) |
#                scope | opinion
#   status       possible | confirmed | dismissed: possible until the owner
#                says otherwise
#   owner_verdict, owner_verdict_at
#                the owner's confirm/dismiss; no compile or check writes
#                them, and status follows them
#   topic, reason, anchor (page_text: the section heading's anchor)
#   source_a, quote_a, source_b, quote_b
#                the two sides of a paired finding, each with its exact
#                quote when known (triage: source_b is the new source, the
#                page is side a); NULL for page text, whose sources are in
#                source_ids, until a claim-check verdict on two of them
#                lends it its sides and quotes. Deleting either side's
#                source removes the finding.
#   source_ids   JSON list of every source involved
#   match_key    one finding per (page, found_by, match_key): finding it
#                again updates it
#   session_id   the compile that found it
#   created_at, updated_at, cleared_at (page_text: when the page's text
#                stopped recording it; it comes back if the text does)
# Wiki content: backups carry it, owner verdicts included. Deleting the
# page removes its rows. Additive: older images ignore the table, and its
# cascades never block their deletes.
DISAGREEMENTS_SQL = """
CREATE TABLE IF NOT EXISTS disagreements (
  disagreement_id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,
  found_by TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'possible',
  owner_verdict TEXT,
  owner_verdict_at DATETIME,
  topic TEXT NOT NULL DEFAULT '',
  reason TEXT,
  anchor TEXT,
  source_a TEXT REFERENCES sources(source_id) ON DELETE CASCADE,
  quote_a TEXT,
  source_b TEXT REFERENCES sources(source_id) ON DELETE CASCADE,
  quote_b TEXT,
  source_ids TEXT NOT NULL DEFAULT '[]',
  match_key TEXT NOT NULL,
  session_id TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cleared_at DATETIME
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_disagreements_key ON disagreements(page_id, found_by, match_key);
CREATE INDEX IF NOT EXISTS idx_disagreements_created ON disagreements(created_at);
CREATE INDEX IF NOT EXISTS idx_disagreements_source_a ON disagreements(source_a);
CREATE INDEX IF NOT EXISTS idx_disagreements_source_b ON disagreements(source_b);
"""


def _ensure_disagreements(conn: sqlite3.Connection) -> bool:
    """Create disagreements when it is missing. Returns True when created."""
    exists = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'disagreements'"
    ).fetchone()
    if exists:
        return False
    conn.executescript(DISAGREEMENTS_SQL)
    return True


def _ensure_relation_quotes(conn: sqlite3.Connection) -> bool:
    """Add relationship_mentions.quote and quote_verified when missing.
    Returns True when either was added.

    quote           the source's sentence for the relation, as the extract
                    route stored it (plan 3.2): when the nlp-service check
                    found it in the source, the source's own text
    quote_verified  1 found in the source, 0 not found (kept, never shown as
                    quoted), NULL without a quote
    Additive, no backfill: relations extracted before keep NULL and are
    shown as Kompl's summary. Older images never name the columns.
    """
    cols = {row[1] for row in conn.execute("PRAGMA table_info(relationship_mentions)").fetchall()}
    if not cols:
        return False
    added = False
    for col, ddl in (("quote", "quote TEXT"), ("quote_verified", "quote_verified INTEGER")):
        if col not in cols:
            conn.execute(f"ALTER TABLE relationship_mentions ADD COLUMN {ddl}")
            added = True
    return added


def _ensure_source_dates(conn: sqlite3.Connection) -> bool:
    """Add sources.published_at and published_at_source when missing.
    Returns True when either was added.

    published_at         the source's publication date, YYYY-MM-DD (plan
                         3.2, D5: an outdated claim is told from a disputed
                         one by the sources' dates)
    published_at_source  where it came from: page_published, page_modified,
                         file_metadata, youtube, github_push, tweet,
                         source_text or ingested (app/src/lib/source-dates.ts)
    Additive, no backfill: sources added before keep NULL and read as the
    day they were added. Older images never name the columns.
    """
    cols = {row[1] for row in conn.execute("PRAGMA table_info(sources)").fetchall()}
    if not cols:
        return False
    added = False
    for col in ("published_at", "published_at_source"):
        if col not in cols:
            conn.execute(f"ALTER TABLE sources ADD COLUMN {col} TEXT")
            added = True
    return added


def _ensure_page_hold(conn: sqlite3.Connection) -> bool:
    """Add pages.restore_page_type and archive_reason when missing.
    Returns True when either was added.

    A page that could not be rewritten after one of its sources was deleted
    is archived (page_type 'archived') until a rewrite succeeds, so the
    deleted source's material leaves the wiki (app/src/lib/page-hold.ts):
    restore_page_type  the type the page returns as once it is rewritten
    archive_reason     why it was archived, in plain words, for the page
    Both are read only while page_type is 'archived'. Additive, no backfill.
    Older images never name the columns and show such a page as archived.
    """
    cols = {row[1] for row in conn.execute("PRAGMA table_info(pages)").fetchall()}
    if not cols:
        return False
    added = False
    for col in ("restore_page_type", "archive_reason"):
        if col not in cols:
            conn.execute(f"ALTER TABLE pages ADD COLUMN {col} TEXT")
            added = True
    return added


def _ensure_ingest_failure_attempts(conn: sqlite3.Connection) -> bool:
    """Add ingest_failures.attempts when missing. Returns True when added.

    attempts  how many times the link failed to import. Saved Links shows
              one row per link: a later failure of the same link (the same
              address as app/src/lib/url-key.ts spells it) updates that row
              and counts here instead of adding a row. Existing rows read 1,
              and older images insert rows that read 1.
    """
    cols = {row[1] for row in conn.execute("PRAGMA table_info(ingest_failures)").fetchall()}
    if not cols or "attempts" in cols:
        return False
    conn.execute("ALTER TABLE ingest_failures ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1")
    return True


# The claim check's saved verdicts (plan 3.3 and 3.6;
# app/src/lib/claim-check/verdicts.ts): each pair of claims from two
# different sources is judged once, and its verdict is kept so neither the
# compile's claim check nor the whole-wiki check asks again. A disputed or
# outdated verdict is also recorded as a possible disagreement on the
# subject's page (the disagreements table); the owner's verdict lives there.
#   pair_key     the two claims' keys, sorted and joined with "|" (a claim's
#                key: its source and its text, hashed)
#   source_a, claim_a, source_b, claim_b
#                the two claims as judged: side a the earlier or existing
#                one, side b the newer one or the new source's
#   subject      the shared subject the pair was found on
#   verdict      disputed | outdated | scope | opinion | none
#   topic, reason
#                the judge's few words and one sentence
#   newer        outdated only: the side whose source is provably later
#                ('a' | 'b'), from the sources' dates (D5)
#   found_by     claim_check (a compile) | wiki_check (the whole-wiki check)
#   model, session_id (the compile that judged it), judged_at
# Wiki content: backups carry it. Deleting either source removes the
# verdict. Additive: older images ignore the table, and its cascades never
# block their deletes.
CLAIM_VERDICTS_SQL = """
CREATE TABLE IF NOT EXISTS claim_verdicts (
  pair_key TEXT PRIMARY KEY,
  source_a TEXT NOT NULL REFERENCES sources(source_id) ON DELETE CASCADE,
  claim_a TEXT NOT NULL,
  source_b TEXT NOT NULL REFERENCES sources(source_id) ON DELETE CASCADE,
  claim_b TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  verdict TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  reason TEXT,
  newer TEXT,
  found_by TEXT NOT NULL,
  model TEXT,
  session_id TEXT,
  judged_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_claim_verdicts_source_a ON claim_verdicts(source_a);
CREATE INDEX IF NOT EXISTS idx_claim_verdicts_source_b ON claim_verdicts(source_b);
CREATE INDEX IF NOT EXISTS idx_claim_verdicts_judged ON claim_verdicts(found_by, judged_at);
"""


def _ensure_claim_verdicts(conn: sqlite3.Connection) -> bool:
    """Create claim_verdicts when it is missing. Returns True when created."""
    exists = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'claim_verdicts'"
    ).fetchone()
    if exists:
        return False
    conn.executescript(CLAIM_VERDICTS_SQL)
    return True


def migrate():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")

    # Check current version
    try:
        row = conn.execute(
            "SELECT value FROM settings WHERE key = 'schema_version'"
        ).fetchone()
        current = int(row[0]) if row else 0
    except sqlite3.OperationalError as exc:
        # Only a database with no settings table yet is new. Any other error
        # (locked, a disk error, a damaged file) stops here: read as version 0
        # it would rerun every step, and v6 drops and recreates aliases.
        if not str(exc).startswith("no such table"):
            conn.close()
            print(f"ERROR: could not read the schema version from {DB_PATH}: {exc}", file=sys.stderr)
            raise
        current = 0

    if current >= SCHEMA_VERSION:
        # triage_rechecks joined the v30 step after v30 shipped: a database
        # already at v30 gets it here, whatever its stored version.
        if _ensure_triage_rechecks(conn):
            conn.commit()
            print("  added the triage_rechecks table (v30)")
        # page_plans.used_source_ids joined the v30 step the same way.
        if _ensure_plan_used_source_ids(conn):
            conn.commit()
            print("  added page_plans.used_source_ids (v30)")
        # The disagreements record joined the v30 step the same way.
        if _ensure_disagreements(conn):
            conn.commit()
            print("  added the disagreements table (v30)")
        # relationship_mentions.quote / quote_verified joined the same way.
        if _ensure_relation_quotes(conn):
            conn.commit()
            print("  added relationship_mentions.quote and quote_verified (v30)")
        # sources.published_at / published_at_source joined the same way.
        if _ensure_source_dates(conn):
            conn.commit()
            print("  added sources.published_at and published_at_source (v30)")
        # claim_verdicts joined the same way.
        if _ensure_claim_verdicts(conn):
            conn.commit()
            print("  added the claim_verdicts table (v30)")
        # pages.restore_page_type / archive_reason joined the same way.
        if _ensure_page_hold(conn):
            conn.commit()
            print("  added pages.restore_page_type and archive_reason (v30)")
        # ingest_failures.attempts joined the same way.
        if _ensure_ingest_failure_attempts(conn):
            conn.commit()
            print("  added ingest_failures.attempts (v30)")
        print(f"Database already at version {current}, nothing to do.")
        conn.close()
        return

    print(f"Migrating database to version {SCHEMA_VERSION}...")

    if current < 1:
        conn.executescript(SCHEMA_SQL)
        conn.executescript(FTS_SQL)

    if current < 2:
        print("  applying migration v2 (compile_status columns)...")
        # ALTER TABLE is not idempotent — check if columns already exist first.
        existing_cols = {
            row[1]
            for row in conn.execute("PRAGMA table_info(sources)").fetchall()
        }
        for stmt in MIGRATION_V2_SQL.strip().split(";"):
            stmt = stmt.strip()
            if not stmt:
                continue
            # Extract column name from "ALTER TABLE sources ADD COLUMN <name> ..."
            col_name = stmt.split("ADD COLUMN")[1].strip().split()[0]
            if col_name not in existing_cols:
                conn.execute(stmt)
        conn.executescript(MIGRATION_V2_INDEXES_SQL)

    if current < 3:
        print("  applying migration v3 (page_links table)...")
        conn.executescript(MIGRATION_V3_SQL)
        conn.executescript(MIGRATION_V3_INDEXES_SQL)

    if current < 4:
        print("  applying migration v4 (onboarding_session_id column)...")
        existing_cols = {
            row[1]
            for row in conn.execute("PRAGMA table_info(sources)").fetchall()
        }
        if "onboarding_session_id" not in existing_cols:
            conn.execute(MIGRATION_V4_SQL)
        conn.executescript(MIGRATION_V4_INDEX_SQL)

    if current < 5:
        print("  applying migration v5 (extractions table)...")
        conn.executescript(MIGRATION_V5_SQL)
        conn.executescript(MIGRATION_V5_INDEX_SQL)

    if current < 6:
        print("  applying migration v6 (rebuild aliases: add canonical_name, drop NOT NULL on canonical_page_id)...")
        conn.executescript(MIGRATION_V6_SQL)

    if current < 7:
        print("  applying migration v7 (page_plans table)...")
        conn.executescript(MIGRATION_V7_SQL)

    if current < 8:
        print("  applying migration v8 (compile_progress table)...")
        conn.executescript(MIGRATION_V8_SQL)

    if current < 9:
        print("  applying migration v9 (chat_messages table)...")
        conn.executescript(MIGRATION_V9_SQL)

    if current < 10:
        print("  applying migration v10 (ensure provenance source index)...")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_provenance_source ON provenance(source_id)")

    if current < 11:
        print("  applying migration v11 (compile_progress.source_count column)...")
        existing_cols = {
            row[1]
            for row in conn.execute("PRAGMA table_info(compile_progress)").fetchall()
        }
        if "source_count" not in existing_cols:
            conn.execute(
                "ALTER TABLE compile_progress ADD COLUMN source_count INTEGER DEFAULT 0"
            )

    if current < 12:
        print("  applying migration v12 (ingest_failures table)...")
        conn.executescript(MIGRATION_V12_SQL)

    if current < 13:
        print("  applying migration v13 (vector_backfill_queue table)...")
        conn.executescript(MIGRATION_V13_SQL)

    if current < 14:
        print("  applying migration v14 (pages.pending_content outbox column)...")
        existing_cols = {
            row[1]
            for row in conn.execute("PRAGMA table_info(pages)").fetchall()
        }
        if "pending_content" not in existing_cols:
            conn.execute(MIGRATION_V14_SQL)
        conn.executescript(MIGRATION_V14_INDEX_SQL)

    if current < 15:
        print("  applying migration v15 (page_links unique constraint + dedup)...")
        conn.executescript(MIGRATION_V15_SQL)

    if current < 16:
        print("  applying migration v16 (ingest_failures.metadata column)...")
        existing_cols = {
            row[1]
            for row in conn.execute("PRAGMA table_info(ingest_failures)").fetchall()
        }
        if "metadata" not in existing_cols:
            conn.execute(MIGRATION_V16_SQL)

    if current < 17:
        print("  applying migration v17 (entity_mentions table)...")
        conn.executescript(MIGRATION_V17_SQL)

    if current < 18:
        print("  applying migration v18 (collect_staging + ingest_failures.session_id + backfills)...")
        conn.executescript(MIGRATION_V18_SQL)
        # Only add session_id column if it's missing (PRAGMA-guarded for re-runs).
        existing_cols = {
            row[1]
            for row in conn.execute("PRAGMA table_info(ingest_failures)").fetchall()
        }
        if "session_id" not in existing_cols:
            conn.execute(MIGRATION_V18_INGEST_FAILURES_SQL)
        conn.executescript(MIGRATION_V18_INGEST_FAILURES_INDEX_SQL)
        conn.executescript(MIGRATION_V18_LEGACY_COLLECTED_SQL)
        conn.executescript(MIGRATION_V18_COMPILE_PROGRESS_BACKFILL_SQL)

    if current < 19:
        print("  applying migration v19 (chat_messages.chat_model column)...")
        existing_cols = {
            row[1]
            for row in conn.execute("PRAGMA table_info(chat_messages)").fetchall()
        }
        if "chat_model" not in existing_cols:
            conn.executescript(MIGRATION_V19_SQL)

    if current < 20:
        print("  applying migration v20 (compile_progress.compile_model column)...")
        existing_cols = {
            row[1]
            for row in conn.execute("PRAGMA table_info(compile_progress)").fetchall()
        }
        if "compile_model" not in existing_cols:
            conn.executescript(MIGRATION_V20_SQL)

    if current < 21:
        print("  applying migration v21 (purge deployment_mode settings row)...")
        conn.executescript(MIGRATION_V21_SQL)

    if current < 22:
        print("  applying migration v22 (drop retired thinking_budgets state)...")
        # Phase 8 retired the user-tunable per-call-site thinking_budget knob.
        # Per-call-site values stay hardcoded in nlp-service/services/llm_client.py;
        # the SQLite settings row + JSON-mirror key are dead weight. DELETE
        # is a no-op if the row never existed (idempotent).
        conn.execute("DELETE FROM settings WHERE key = 'thinking_budgets'")
        # Strip the thinking_budgets key from /data/llm-config.json if present.
        # Mirrors nlp-service/services/llm_client.py:120 path resolution exactly
        # so app-container migrate.py and nlp-service runtime see the same file
        # regardless of DATA_ROOT override.
        data_root = os.environ.get("DATA_ROOT", "/data")
        cfg_path = os.path.join(data_root, "llm-config.json")
        if os.path.exists(cfg_path):
            try:
                import json as _json
                with open(cfg_path, "r", encoding="utf-8") as fh:
                    cfg = _json.load(fh)
                if isinstance(cfg, dict) and "thinking_budgets" in cfg:
                    cfg.pop("thinking_budgets", None)
                    with open(cfg_path, "w", encoding="utf-8") as fh:
                        _json.dump(cfg, fh)
            except Exception as e:
                # Non-fatal: nlp-service no longer reads this key after Phase 8.
                print(f"  v22 cfg cleanup skipped (non-fatal): {e}")

    if current < 23:
        print("  applying migration v23 (scope activity_log by compile session + step)...")
        # Phase B.1: every activity_log row written from a compile pipeline route
        # gets tagged with its session_id + step_key, so /api/compile/progress/events
        # (Phase B.4) can return per-(session, step) audit trails for the
        # expand-to-reveal progress UI (Phase C). Pre-v23 rows stay NULL — no
        # backfill possible (we have no way to recover the original session/step
        # for events written before this column existed).
        activity_cols = {
            row[1]
            for row in conn.execute("PRAGMA table_info(activity_log)").fetchall()
        }
        if "session_id" not in activity_cols:
            conn.execute("ALTER TABLE activity_log ADD COLUMN session_id TEXT")
        if "step_key" not in activity_cols:
            conn.execute("ALTER TABLE activity_log ADD COLUMN step_key TEXT")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_activity_session ON activity_log(session_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_activity_session_step ON activity_log(session_id, step_key)")

    if current < 24:
        print("  applying migration v24 (page_plans.draft_error column)...")
        # Per-plan error capture for draft + commit failures. Before v24, a
        # failed page_plan recorded only draft_status='failed' with no
        # explanation — operators had to grep app logs to diagnose.
        # Session 29be62eb (15 source-summary HeadersTimeoutErrors) wasted
        # 30+ min of debugging because the actual error was swallowed by the
        # pLimit worker pool in /api/compile/draft. Nullable; pre-v24 rows
        # stay NULL — no backfill possible.
        plan_cols = {
            row[1]
            for row in conn.execute("PRAGMA table_info(page_plans)").fetchall()
        }
        if "draft_error" not in plan_cols:
            conn.execute("ALTER TABLE page_plans ADD COLUMN draft_error TEXT")

    if current < 25:
        print("  applying migration v25 (sources.title_source + title_rescued_at)...")
        # Phase-2 title-rescue infrastructure. title_source records which step
        # of the convert/ingest cascade produced the title — one of:
        #   markitdown | body_h1 | body_h2 | filename | stem
        #   firecrawl | firecrawl_url_fallback
        #   paste | text_first_line | saved_link
        # The rescue trigger in /api/compile/extract uses this field to decide
        # whether to overwrite the title with the LLM-derived one.
        #
        # title_rescued_at marks rows whose title was already LLM-rescued —
        # prevents recompile-loop title churn (every recompile would re-rescue,
        # re-rename the wiki page, and the user would see drift).
        #
        # Pre-v25 rows stay NULL on both; the extract route falls back to the
        # legacy isGarbageTitle heuristic for them, preserving today's
        # behaviour exactly.
        existing_cols = {
            row[1]
            for row in conn.execute("PRAGMA table_info(sources)").fetchall()
        }
        if "title_source" not in existing_cols:
            conn.execute("ALTER TABLE sources ADD COLUMN title_source TEXT")
        if "title_rescued_at" not in existing_cols:
            conn.execute("ALTER TABLE sources ADD COLUMN title_rescued_at TIMESTAMP")

    # One upgrade step from the last release (v0.3.2.1, schema v25) to v30.
    # The parts below were built as v26-v30 during development; every part
    # checks before it adds, so a database at any of those versions (a
    # development install) also converges here.
    if current < 30:
        print("  applying migration v26-v30 (compile model row, writing rules, relation sentences and quotes, alias records, approval checks, disagreements, claim verdicts, source dates)...")
        # v26: the default compile model moves from gemini-2.5-flash to
        # deepseek-flash (DeepSeek V4.1 Flash). Write the model each install
        # runs on as an explicit settings row so the new default only reaches
        # fresh installs:
        #   - existing install (current > 0) without an explicit choice has
        #     been compiling on gemini-2.5-flash, and Gemini may be its only
        #     configured provider -> pin gemini-2.5-flash.
        #   - fresh install (current == 0) -> seed the new default.
        # INSERT OR IGNORE keeps any model the user already picked. With a row
        # on every install, a later default change can't move anyone either.
        # Keep the fresh-install value equal to DEFAULT_COMPILE_MODEL in
        # app/src/lib/llm-models.ts.
        seeded_model = "gemini-2.5-flash" if current > 0 else "deepseek-flash"
        conn.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES ('compile_model', ?)",
            (seeded_model,),
        )

        # v27: writing-rules marker. v0.4 writes pages under stricter rules
        # (sources only, numbered citations, each page linked once, at most
        # 5 Related entries, no empty Contradictions sections, four
        # frontmatter keys). A compile only adds to an existing page, so a
        # page keeps its older text until the user updates it from
        # Settings > Wiki health (app/src/lib/draft-rules.ts):
        #   pages.draft_rules       'v0.4' when the page's text was written
        #                           from scratch under those rules; NULL for
        #                           every page written before v0.4, and for
        #                           original-source pages and Saved Links
        #   page_plans.draft_rules  the same marker on a compile draft, copied
        #                           to the page when a from-scratch plan
        #                           commits; NULL for drafts made before v0.4
        #                           (e.g. ones still waiting for approval)
        # Additive only, no backfill: NULL is exactly "written by an earlier
        # version", so existing pages and pending drafts need no rewrite here.
        page_cols = {
            row[1]
            for row in conn.execute("PRAGMA table_info(pages)").fetchall()
        }
        # Each part leaves alone a table the database doesn't have (empty
        # table_info): the merged step also runs on development databases.
        if page_cols and "draft_rules" not in page_cols:
            conn.execute("ALTER TABLE pages ADD COLUMN draft_rules TEXT")
        plan_cols = {
            row[1]
            for row in conn.execute("PRAGMA table_info(page_plans)").fetchall()
        }
        if plan_cols and "draft_rules" not in plan_cols:
            conn.execute("ALTER TABLE page_plans ADD COLUMN draft_rules TEXT")

        # v28: evidence for typed connections. The extract LLM returns a
        # one-sentence description with every relationship ("Bitcoin uses
        # proof-of-work consensus."); before v28 it was dropped at insert and
        # only survived in extractions.llm_output. The wiki's connections
        # card, graph and MCP tools show it next to the relation.
        #   description  the LLM's sentence, trimmed and clipped to 300 chars
        #                (app/src/lib/relation-rows.ts); NULL = not yet filled
        # Additive only. Existing rows stay NULL here and are filled once at
        # app boot from the stored extractions, with no LLM calls
        # (app/src/lib/relation-backfill.ts); new extractions write it
        # directly.
        rel_cols = {
            row[1]
            for row in conn.execute("PRAGMA table_info(relationship_mentions)").fetchall()
        }
        if rel_cols and "description" not in rel_cols:
            conn.execute("ALTER TABLE relationship_mentions ADD COLUMN description TEXT")

        # v29: alias records. Every stored alias binds later sources to its
        # canonical page without being judged again, so each row now says
        # how it was made and whether compiles may still use it:
        #   method         the resolver rule or layer that made it ("skeleton",
        #                  "existing_page_title", "llm", ...); NULL = made
        #                  before v29
        #   score          the similarity behind it, when the resolver knew one
        #   session_id     the compile session that made it
        #   status         'active' (used), 'suspended' (set aside until it is
        #                  confirmed; a new resolver match re-activates it) or
        #                  'retired' (judged wrong; never used again)
        #   status_reason  why the status last changed
        #   status_at      when it last changed
        # Additive only, no rewrite: existing rows read status 'active', and
        # an older image that ignores the columns still boots and inserts
        # active rows. The app screens rows made before v29 after boot
        # (app/src/lib/alias-screen.ts); migrate.py can't, as the screen
        # needs the embedding model.
        alias_cols = {
            row[1]
            for row in conn.execute("PRAGMA table_info(aliases)").fetchall()
        }
        for col, ddl in (
            ("method", "method TEXT"),
            ("score", "score REAL"),
            ("session_id", "session_id TEXT"),
            ("status", "status TEXT DEFAULT 'active'"),
            ("status_reason", "status_reason TEXT"),
            ("status_at", "status_at DATETIME"),
        ):
            if alias_cols and col not in alias_cols:
                conn.execute(f"ALTER TABLE aliases ADD COLUMN {ddl}")

        # v30: drafts waiting for approval (auto-approve off). Approving one that
        # updates a page must not overwrite what the page gained after the
        # draft was written:
        #   base_version  the page's version when the draft read it
        #                 (app/src/lib/page-rewrite.ts pageVersionToken);
        #                 NULL for new pages and for drafts made before v30
        # Additive only, no backfill: approving an older update draft
        # compares the page's last update with the plan's created_at instead
        # (app/src/lib/approve-plan.ts).
        plan_cols = {
            row[1]
            for row in conn.execute("PRAGMA table_info(page_plans)").fetchall()
        }
        if plan_cols and "base_version" not in plan_cols:
            conn.execute("ALTER TABLE page_plans ADD COLUMN base_version TEXT")
        # Match triage calls that gave no verdict, kept for a later compile to
        # check again (TRIAGE_RECHECKS_SQL above). Additive: older images
        # ignore the table, and its cascades never block their deletes.
        _ensure_triage_rechecks(conn)
        # The sources each draft's prompt actually carried.
        _ensure_plan_used_source_ids(conn)
        # The disagreements record (DISAGREEMENTS_SQL above).
        _ensure_disagreements(conn)
        # The source's sentence behind each relation, and its check.
        _ensure_relation_quotes(conn)
        # Each source's publication date and where it came from.
        _ensure_source_dates(conn)
        # The claim check's saved verdicts (CLAIM_VERDICTS_SQL above).
        _ensure_claim_verdicts(conn)
        # Pages archived until a failed rewrite succeeds.
        _ensure_page_hold(conn)
        # One Saved Links row per link, with its attempt count.
        _ensure_ingest_failure_attempts(conn)

    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
        ("schema_version", str(SCHEMA_VERSION)),
    )
    conn.commit()

    # Verify
    tables = [
        r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ).fetchall()
    ]
    print(f"Tables: {', '.join(tables)}")
    print(f"Migration to version {SCHEMA_VERSION} complete.")

    conn.close()


if __name__ == "__main__":
    migrate()
