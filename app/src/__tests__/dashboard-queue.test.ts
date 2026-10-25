/**
 * Dashboard "Recently processed" cards (app/_dashboard-queue.tsx): each card
 * is a real link to its source, shows the full title on hover, and a failed
 * source's Retry button sits outside the link.
 */

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QueueCard } from '../app/_dashboard-queue';

const source = {
  source_id: 'src-1',
  title: 'Vilnius vs Kaunas — planning a Lithuania trip',
  source_type: 'url',
  date_ingested: '2026-10-10 10:51:34',
  compile_status: 'active',
};

function render(compile_status: string) {
  return renderToString(
    createElement(QueueCard, { source: { ...source, compile_status }, retrying: false, onRetry: () => {} }),
  );
}

describe('QueueCard', () => {
  it('links to its source and carries the full title', () => {
    const html = render('active');
    expect(html).toMatch(/<a[^>]*href="\/source\/src-1"/);
    expect(html).toContain('title="Vilnius vs Kaunas — planning a Lithuania trip"');
    expect(html).not.toContain('<button');
  });

  it('keeps Retry outside the link for a failed source', () => {
    const html = render('failed');
    const link = html.slice(html.indexOf('<a'), html.indexOf('</a>'));
    expect(link).not.toContain('<button');
    expect(html.slice(html.indexOf('</a>'))).toContain('Retry');
  });
});
