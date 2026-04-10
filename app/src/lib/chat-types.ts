/**
 * Shared TypeScript types for the chat agent (commit 7).
 */

export interface RetrievedPage {
  page_id: string;
  title: string;
  page_type: string;
  content: string;
  score: number;
  retrieval_method: 'index' | 'fts' | 'vector' | 'hybrid';
}

export interface Citation {
  page_id: string;
  page_title: string;
}

export interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  citations: Citation[];
  created_at: string;
}
