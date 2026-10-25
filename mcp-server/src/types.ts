/**
 * Response shapes of the Kompl app routes the MCP tools read. Keep
 * test/contract/app-responses.json in step: it is checked against these
 * types, and the app's contract test holds the real routes to it.
 */

export interface PageMeta {
  page_id: string;
  title: string;
  page_type: string;
  category: string | null;
  summary: string | null;
  source_count: number;
  last_updated: string;
}

export interface PageSource {
  /** Matches the [n] markers in the page content (older apps omit it). */
  n?: number;
  source_id: string;
  title: string;
  contribution_type: string;
  source_url?: string | null;
  date?: string | null;
}

export interface PageLink {
  page_id: string;
  title: string;
}

/** One source behind a connection; archived sources stay and are marked. */
export interface ConnectionEvidence {
  source_id: string;
  source_title: string;
  source_archived: boolean;
  /** The sentence the source gives for the relation, when one was kept. */
  sentence: string | null;
}

/** A typed relation of the page, read from the page's side ("Uses", "Used by"). */
export interface ConnectionItem {
  /** null: a name with no page yet. */
  page_id: string | null;
  title: string;
  type: string;
  direction: 'out' | 'in';
  source_count: number;
  /** At most 3, sentences first, newest first. */
  evidence: ConnectionEvidence[];
}

export interface PageConnections {
  /** Grouped by label in the app's display order; "Related to" last. */
  groups: Array<{ label: string; items: ConnectionItem[] }>;
  /** Pages linked either way with no typed relation. */
  linked_only: PageLink[];
}

export interface PageData extends PageMeta {
  content: string;
  sources: PageSource[];
  /** Typed connections with their evidence (older apps omit it). */
  connections?: PageConnections;
  /** Pages this page links to / pages linking here (older apps omit both). */
  links?: PageLink[];
  backlinks?: PageLink[];
}

export interface RelatedPages {
  items: Array<{ page_id: string; title: string; page_type: string }>;
  count: number;
  /** False while the wiki has too few sources for related pages. */
  enabled: boolean;
}

interface SourceMeta {
  source_id: string;
  title: string;
  source_type: string;
  source_url: string | null;
  status: string;
  date_ingested: string;
}

export interface SourceContent extends SourceMeta {
  total_chars: number;
  mode: 'passages' | 'text';
  /** mode 'passages' */
  query?: string;
  passages?: Array<{ text: string; heading: string | null; start: number }>;
  /** mode 'text' */
  offset?: number;
  text?: string;
  next_offset?: number | null;
}

export interface SourceListItem extends SourceMeta {
  page_count: number;
  compile_status: string;
}

export interface SourceList {
  sources: SourceListItem[];
  total: number;
  returned: number;
}

export interface WikiIndex {
  total_pages: number;
  categories: Record<string, string[]>;
  pages: PageMeta[];
}

export interface WikiStats {
  source_count: number;
  page_count: number;
  entity_count: number;
  concept_count: number;
  last_ingested: string | null;
  last_compiled: string | null;
}

/** A finding: how many, and the first few. */
export interface Summary<T> {
  count: number;
  top: T[];
}

export interface WikiStatus {
  stats: WikiStats;
  compile_running: { session_id: string; started_at: string | null; source_count: number } | null;
  pending_drafts: number;
  failed_links: Summary<{ url: string; title: string | null; error: string; date_attempted: string }>;
  vector_backlog: number;
  stale_sources: Summary<{ source_id: string; title: string; date_ingested: string }> & { threshold_days: number };
  gaps: {
    missing_pages: Summary<{ name: string; mentions: number }> & { capped?: boolean };
    thin_pages: Summary<{ page_id: string; title: string; page_type: string; backlinks: number }>;
    orphan_pages: Summary<{ page_id: string; title: string }>;
    dead_provenance: { count: number };
  };
  last_health_check: {
    at: string | null;
    contradictions: Summary<{ page_a: string; page_b: string; claim: string }>;
  } | null;
  /** Topics on the knowledge graph's default view, most pages first (older apps omit it). */
  clusters?: Summary<{ name: string; pages: number; connections: number }>;
  /** Pages on many shortest ways between others, joining 2+ topics (older apps omit it). */
  bridges?: Array<{ page_id: string; title: string; category: string; joins: string[] }>;
}

export interface ResearchPack {
  topic: string;
  detail: 'brief' | 'full';
  degraded: boolean;
  pages: Array<{
    page_id: string;
    title: string;
    page_type: string;
    category: string | null;
    summary: string | null;
    last_updated: string;
    key_lines: string[];
    disputes: string[];
    thin: boolean;
    /** App path, e.g. /wiki/<page_id>. */
    path: string;
  }>;
  sources: Array<{
    n: number;
    source_id: string;
    title: string;
    source_url: string | null;
    date_ingested: string | null;
    path: string;
  }>;
  missing_pages: Array<{ name: string; mentions: number }>;
  more_pages: Array<{ page_id: string; title: string; page_type: string }>;
  /** Typed relations touching the pack's pages, strongest first (older apps omit it). */
  connections?: ResearchConnection[];
}

export interface ResearchConnection {
  from: PageLink;
  to: PageLink;
  type: string;
  /** Read from `from`: "Uses", "Part of", "Created by". */
  label: string;
  source_count: number;
  /** Numbers in the pack's shared source list; the sentence's source first. */
  sources: number[];
  sentence: string | null;
}

/** A list cut at the caller's limit, with the full count. */
export interface Listed<T> {
  items: T[];
  total: number;
}

export interface ChangedPage {
  page_id: string;
  title: string;
  page_type: string;
  change: 'created' | 'updated';
  at: string;
  /** The first few sources behind the change, out of source_total. */
  sources: Array<{ source_id: string; title: string | null }>;
  source_total: number;
}

export interface AddedSource {
  source_id: string;
  title: string;
  source_type: string;
  source_url: string | null;
  date_ingested: string;
  page_count: number;
  onboarding_session_id: string | null;
}

export interface WikiEvent {
  at: string;
  kind: string;
  page_id: string | null;
  page_title: string | null;
  source_title: string | null;
  detail: string | null;
}

export type Changes =
  | {
      mode: 'since';
      since: string;
      sources_added: Listed<AddedSource>;
      pages: Listed<ChangedPage>;
      disputes: Listed<WikiEvent>;
      failures: Listed<WikiEvent>;
    }
  | {
      mode: 'session';
      session_id: string;
      status: string | null;
      current_step: string | null;
      error: string | null;
      started_at: string | null;
      completed_at: string | null;
      staged: Listed<{ item: string; status: string; error: string | null }>;
      sources_added: Listed<AddedSource>;
      pages: Listed<ChangedPage>;
      failures: Listed<WikiEvent>;
    }
  | {
      mode: 'page';
      page: { page_id: string; title: string; page_type: string; created_at: string; last_updated: string };
      compiles: Listed<{ source_id: string; source_title: string | null; contribution_type: string; at: string }>;
      events: Listed<{ at: string; kind: string; detail: string | null }>;
      previous_version: { sections_added: string[]; sections_removed: string[]; sections_changed: string[] } | null;
    };

/** POST /api/agent/sources (add_source). */
export interface AddSourceAnswer {
  session_id: string | null;
  added: number;
  already_in_wiki: Array<{ url: string; source_id: string }>;
  blocked: string[];
}
