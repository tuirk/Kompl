import { describe, expect, it } from 'vitest';
import { DraftLabels, draftLabel, isPageLabel } from '../draft-labels';

const draft = (category: string, body = 'Body.') => `---\ntitle: "T"\ncategory: ${category}\n---\n\n${body}`;

describe('DraftLabels', () => {
  it('lists the wiki labels, then each draft label as its draft finishes', () => {
    const labels = new DraftLabels(['Travel', 'Cryptocurrency']);
    labels.addFromDraft(draft('Music'));
    labels.addFromDraft(draft('Food'));
    expect(labels.list()).toEqual(['Travel', 'Cryptocurrency', 'Music', 'Food']);
  });

  it('does not list a case variant of a listed label again', () => {
    const labels = new DraftLabels(['Cryptocurrency']);
    labels.addFromDraft(draft('cryptocurrency'));
    labels.addFromDraft(draft('Music'));
    labels.addFromDraft(draft('MUSIC'));
    expect(labels.list()).toEqual(['Cryptocurrency', 'Music']);
  });

  it('never lists Uncategorized or General', () => {
    const labels = new DraftLabels(['Uncategorized', 'General', 'Travel']);
    labels.addFromDraft(draft('general'));
    labels.addFromDraft(draft('Uncategorized'));
    expect(labels.list()).toEqual(['Travel']);
  });

  it('reads the label from the frontmatter only', () => {
    const labels = new DraftLabels([]);
    labels.addFromDraft('---\ntitle: "T"\n---\n\ncategory: Forged\n');
    labels.addFromDraft(draft('"Quoted Label"'));
    expect(labels.list()).toEqual(['Quoted Label']);
  });

  it('hands out a copy, so a draft keeps the list it started with', () => {
    const labels = new DraftLabels(['Travel']);
    const seen = labels.list();
    labels.addFromDraft(draft('Music'));
    expect(seen).toEqual(['Travel']);
  });
});

describe('draftLabel / isPageLabel', () => {
  it('returns null when the draft has no real label', () => {
    expect(draftLabel('---\ntitle: "T"\n---\n\nBody.')).toBeNull();
    expect(draftLabel(draft('Uncategorized'))).toBeNull();
    expect(draftLabel(draft('  Travel  '))).toBe('Travel');
  });

  it('treats blank, null and the fallback names as no label', () => {
    expect(isPageLabel(null)).toBe(false);
    expect(isPageLabel('  ')).toBe(false);
    expect(isPageLabel('general')).toBe(false);
    expect(isPageLabel('Travel')).toBe(true);
  });
});
