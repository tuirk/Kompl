/**
 * /onboarding — server shell.
 *
 * Gate: if any compile session is active (queued/running) and the visit is
 * NOT a same-session resume (?session_id=<active>), redirect the user to
 * the progress page of the active session. This closes the "second browser
 * tab" / URL-typing loophole that bypasses the dashboard button guard.
 *
 * Legitimate same-session navigation (review page → connector back-link
 * carries ?session_id=<active>&resume=1) is allowed through.
 */

import { redirect } from 'next/navigation';
import { getRunningCompileSession } from '@/lib/db';
import OnboardingClient from './OnboardingClient';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ session_id?: string; resume?: string; mode?: string }>;
}

export default async function OnboardingPage({ searchParams }: PageProps) {
  const { session_id } = await searchParams;
  const active = getRunningCompileSession();
  if (active && active.session_id !== session_id) {
    redirect(
      `/onboarding/progress?session_id=${encodeURIComponent(active.session_id)}` +
      `&queued=${active.source_count}`
    );
  }
  return <OnboardingClient />;
}
