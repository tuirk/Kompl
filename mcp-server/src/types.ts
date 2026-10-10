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

export interface PageData extends PageMeta {
  content: string;
  sources: PageSource[];
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
