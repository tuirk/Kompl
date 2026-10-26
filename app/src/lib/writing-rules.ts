/**
 * The writing rules Kompl drafts pages under, by version.
 *
 * The rules are the draft prompts (nlp-service/services/llm_client.py) plus
 * the draft clean-up passes (lib/draft-cleanup.ts, lib/page-sections.ts,
 * lib/citations.ts). Each page remembers the version its text was written
 * under (pages.draft_rules, lib/draft-rules.ts). Settings > Wiki health
 * offers every page written under any other version for an update
 * (lib/page-upgrade.ts), and a one-time notice points there after an upgrade.
 *
 * A release that changes the rules changes only this file:
 *   1. Set CURRENT_DRAFT_RULES to that release, e.g. 'v0.5'.
 *   2. Replace CURRENT_RULES_CHANGES with what changed, in the user's words.
 * Pages written under older rules are then offered for an update, the notice
 * shows once more, and pages an earlier update set aside are retried.
 * Never reuse a label: markers compare by equality.
 *
 * No imports, so client components (the Settings card, the notice) can use it.
 */

/** Rules this version drafts under. Stored in pages/page_plans.draft_rules. */
export const CURRENT_DRAFT_RULES = 'v0.4';

/** One change in the writing rules, as the Settings card lists it. */
export interface RulesChange {
  /** Short label, shown in bold. */
  title: string;
  /** One sentence on what it means for a page. */
  detail: string;
}

/** What changed in CURRENT_DRAFT_RULES, listed on the Settings card. */
export const CURRENT_RULES_CHANGES: readonly RulesChange[] = [
  {
    title: 'Grounded in sources',
    detail: "Every statement comes from the page's own sources; nothing is added from general knowledge.",
  },
  {
    title: 'Numbered citations',
    detail: 'Claims cite their sources as numbered footnotes that link to the source list.',
  },
  {
    title: 'Cleaner linking',
    detail: 'Each related page is linked once, and source notes are cited rather than linked.',
  },
  {
    title: 'Focused related pages',
    detail: 'The Related section lists at most five pages.',
  },
  {
    title: 'Accurate contradictions',
    detail: 'A Contradictions section appears only when sources genuinely disagree.',
  },
  {
    title: 'Consistent metadata',
    detail: 'Each page carries only a title, type, category and summary, with no invented fields.',
  },
];
