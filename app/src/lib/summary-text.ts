/**
 * A page summary as readers see it. Drafting cites sources with labels such
 * as "[S1]", which become stored "[^source_id]" tokens in the page body; the
 * converter skips frontmatter, so a label the model left in the summary
 * stayed raw (lib/draft-cleanup.ts now drops them when a page is drafted).
 * Older pages still carry them, so every place that shows a summary drops
 * them too. Pure and client-safe.
 */

/**
 * Citation labels ("[S1]", "[S1][S2]", "[S1, S2]") and stored citation
 * tokens ("[^id]"), with the space before them; never a markdown link
 * "[S1](…)".
 */
export const SUMMARY_CITATION = /\s*\[\s*(?:S\d+(?:\s*[,;]\s*S\d+)*|\^[^\]\s]+)\s*\](?!\()/gi;

/** The summary without citation labels: "…parks [S1][S2]." → "…parks." */
export function dropCitationLabels(summary: string): string {
  return summary.replace(SUMMARY_CITATION, '');
}
