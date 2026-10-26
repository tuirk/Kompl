/**
 * The page a page_plans row commits to. Single source of truth for the slug
 * algorithm: compile commit (app/api/compile/commit/route.ts), approval
 * (lib/approve-plan.ts) and the redo of a compile (lib/compile-redo/).
 *
 *   - an 'update' plan writes its existing page;
 *   - a 'create' plan with an existing_page_id rewrites that page from
 *     scratch: a redo of the compile that created it (lib/compile-redo/reset.ts);
 *   - any other 'create' plan gets a title slug + plan_id suffix.
 */
export function derivePlanPageId(plan: {
  plan_id: string;
  title: string;
  action: string;
  existing_page_id: string | null;
}): string {
  if ((plan.action === 'update' || plan.action === 'create') && plan.existing_page_id) return plan.existing_page_id;
  const suffix = plan.plan_id.replace(/-/g, '').slice(0, 8);
  const base = plan.title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 56)
    .replace(/^-+|-+$/g, '');
  return `${base || 'page'}-${suffix}`;
}
