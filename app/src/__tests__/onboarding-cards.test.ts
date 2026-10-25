/**
 * Onboarding source cards work by keyboard: each card is a checkbox button
 * (Tab reaches it, Space or Enter toggles it) named by its title.
 */

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  usePathname: () => '/onboarding',
  useRouter: () => ({ push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

import OnboardingClient from '../app/onboarding/OnboardingClient';

describe('onboarding source cards', () => {
  it('are checkbox buttons, unchecked at the start', () => {
    const html = renderToString(createElement(OnboardingClient, { wikiEmpty: false }));
    const cards = html.match(/<button[^>]*role="checkbox"[^>]*>/g) ?? [];
    expect(cards).toHaveLength(7);
    for (const card of cards) {
      expect(card).toContain('type="button"');
      expect(card).toContain('aria-checked="false"');
      expect(card).not.toContain('tabindex="-1"');
    }
    // Named by their visible title.
    expect(html).toMatch(/role="checkbox"[^>]*>(?:(?!<\/button>)[\s\S])*Paste Text/);
  });
});
