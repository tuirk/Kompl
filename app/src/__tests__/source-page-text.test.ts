/**
 * A source page's text comes from the stored source; the model writes only
 * the frontmatter and the sections after it (owner decision 2026-10-25).
 */

import { describe, expect, it } from 'vitest';

import { withSourceText } from '../lib/source-page-text';

const FRONT = '---\ntitle: "Roads and Bridges"\npage_type: source-summary\ncategory: Open Source\nsummary: "A report."\n---\n';
const SECTIONS = '## Key Facts\n\n- One.\n\n## Entities Mentioned\n\n- Ford Foundation\n\n## Concepts\n\n- Maintenance\n';

describe('withSourceText', () => {
  it('puts the whole source between the frontmatter and the sections, however long', () => {
    const source = '# Roads and Bridges\n\n' + 'Open source is infrastructure. '.repeat(20_000);
    const page = withSourceText(`${FRONT}\n${SECTIONS}`, source);
    expect(page.startsWith(FRONT)).toBe(true);
    expect(page).toContain(source.trim());
    expect(page.indexOf(source.trim())).toBeLessThan(page.indexOf('## Key Facts'));
    expect(page.trimEnd().endsWith('- Maintenance')).toBe(true);
  });

  it('drops any copy the model still wrote before its first section', () => {
    const page = withSourceText(`${FRONT}\nA paraphrase of the report.\n\n${SECTIONS}`, 'The report itself.');
    expect(page).not.toContain('A paraphrase');
    expect(page).toContain('The report itself.\n\n## Key Facts');
  });

  it('keeps the source text when the model wrote no sections', () => {
    expect(withSourceText(FRONT, 'The report itself.')).toBe(`${FRONT.trimEnd()}\n\nThe report itself.\n`);
  });
});
