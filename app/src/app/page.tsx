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
import { getSetting } from '@/lib/db';
import DashboardClient from './_dashboard-client';

export const dynamic = 'force-dynamic';

export default function RootPage() {
  const completed = getSetting('onboarding_completed');
  if (!completed) {
    redirect('/onboarding');
  }
  return <DashboardClient />;
}
