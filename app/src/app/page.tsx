/**
 * Root route — redirects based on first-time vs returning user.
 *
 * First time (onboarding_completed not set in settings):
 *   → /onboarding
 *
 * Returning user:
 *   → /feed
 *
 * This is a server component so the redirect happens before any HTML is sent
 * to the browser (no flash of the wrong page).
 */

import { redirect } from 'next/navigation';
import { getRunningCompileSession, getSetting } from '@/lib/db';
import DashboardClient from './_dashboard-client';

export const dynamic = 'force-dynamic';

export default function RootPage() {
  const completed = getSetting('onboarding_completed');
  if (!completed) {
    redirect('/onboarding');
  }
  // Read the active compile session server-side so the "Add Sources" button
  // can be visually disabled during an in-progress session. No client poll —
  // the dashboard is force-dynamic and re-renders on each visit.
  const activeSession = getRunningCompileSession();
  return <DashboardClient activeSession={activeSession} />;
}
