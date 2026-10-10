/** Response shapes of the Kompl app routes the MCP tools read. */

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

export interface PageData extends PageMeta {
  content: string;
  sources: PageSource[];
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
