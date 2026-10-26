/**
 * The Twitter / X connector numbers its steps once each (it showed two
 * "Step 2" headings).
 */

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  usePathname: () => '/onboarding/twitter',
  useRouter: () => ({ push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

import TwitterConnector from '../app/onboarding/[connector]/twitter-connector';

describe('Twitter / X connector steps', () => {
  it('numbers each step once', () => {
    const html = renderToString(
      createElement(TwitterConnector, { sessionId: 's', connectors: ['twitter'], connectorIdx: 0, showToast: () => {} }),
    );
    const steps = [...html.matchAll(/Step (\d) —/g)].map((m) => m[1]);
    expect(steps).toEqual(['1', '2', '3']);
  });
});
