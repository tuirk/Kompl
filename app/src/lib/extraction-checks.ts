/**
 * What the nlp-service checks found in one extraction (plan 3.2), counted
 * for the extraction_complete activity event, so a measured run can show how
 * often quotes are found in their source and how often a relation names
 * something outside the extraction's own entity and concept lists (before
 * anything is ever dropped for it). Extractions made before the checks
 * count zero throughout.
 */

export interface ExtractionCheckCounts {
  claims_quoted: number;
  claims_quote_verified: number;
  relations_quoted: number;
  relations_quote_verified: number;
  /** Relations with an end that is not one of the extraction's entity or concept names. */
  relations_unlisted_end: number;
}

function items(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object') : [];
}

const quoted = (item: Record<string, unknown>) => typeof item.quote === 'string' && item.quote.trim() !== '';

export function extractionCheckCounts(llmOutput: unknown): ExtractionCheckCounts {
  const llm = (llmOutput && typeof llmOutput === 'object' ? llmOutput : {}) as Record<string, unknown>;
  const claims = items(llm.claims);
  const relations = items(llm.relationships);
  return {
    claims_quoted: claims.filter(quoted).length,
    claims_quote_verified: claims.filter((c) => quoted(c) && c.quote_verified === true).length,
    relations_quoted: relations.filter(quoted).length,
    relations_quote_verified: relations.filter((r) => quoted(r) && r.quote_verified === true).length,
    relations_unlisted_end: relations.filter((r) => r.ends_listed === false).length,
  };
}
