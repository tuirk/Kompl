/**
 * /onboarding/health — pre-stage health check.
 *
 * Inserted between the source-selector (/onboarding) and the first
 * connector page (/onboarding/[connector]). Renders a full-table view
 * of deterministic configuration checks (NLP reachability, selected
 * LLM provider key, ingest integration keys) and gates Next on red
 * failures.
 *
 * dynamic = 'force-dynamic' disables static generation — the response
 * to /api/health is per-deployment-config, not buildtime.
 */

import { Suspense } from 'react';
import HealthClient from './HealthClient';

export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <Suspense fallback={null}>
      <HealthClient />
    </Suspense>
  );
}
