/**
 * Citation parsing and conversion (lib/citations.ts).
 *
 * Fixtures are the legacy shapes found in real compiled pages, plus the
 * stored [^id] tokens and [S1] drafting labels of the current format.
 */

import { describe, it, expect } from 'vitest';
import {
  assignCitationLabels,
  citationsToLabels,
  citationsToText,
  labelsToStoredCitations,
  relabelDossier,
  renderCitationMarkers,
  scanCitations,
  stripCitationPlaceholders,
} from '../lib/citations';

const A = '5624ad54-e682-4a62-a039-1265ed5694fd';
const B = 'fa237b2f-a116-4471-a16a-5f3631a6e582';
const C = 'e3815aa4-38d0-4115-a895-99c169b21e90';

const knownTitles = new Set(['python intro', 'ethereum overview', 'bitcoin basics', 'stage 14 canary']);
const isKnownTitle = (t: string) => knownTitles.has(t.toLowerCase());

function text(md: string): string {
  return citationsToText(md, isKnownTitle).markdown;
}

describe('legacy citation shapes render as numbers', () => {
  it.each([
    [`Bitcoin was created (${A}).`, 'Bitcoin was created[1].'],
    [`Created (${A}, ${B}) in 2009.`, 'Created[1][2] in 2009.'],
    [`Created [${A}] in 2009.`, 'Created[1] in 2009.'],
    [`Created [${A}, ${B}].`, 'Created[1][2].'],
    [`Created (Source ${A}).`, 'Created[1].'],
    [`Created (From source ${A}, From source ${B}, [[Bitcoin Basics]]).`, 'Created[1][2].'],
    [`Created (Pre-extracted data from source ${A}, [[Ethereum Overview]]).`, 'Created[1].'],
    [`Created (${A}, Source A).`, 'Created[1].'],
    [`Created [Python Intro, ${A}].`, 'Created[1].'],
    [`Created (From source ${B}, Bitcoin Basics, Stage 14 canary).`, 'Created[1].'],
  ])('%s', (input, expected) => {
    expect(text(input)).toBe(expected);
  });

  it('numbers sources in order of first citation and reuses numbers', () => {
    const r = citationsToText(`One (${B}). Two (${A}). Three (${B}, ${C}).`);
    expect(r.markdown).toBe('One[1]. Two[2]. Three[1][3].');
    expect(r.order).toEqual([B, A, C]);
  });

  it('keeps prose that shares a paren group with an id', () => {
    expect(text(`It grew (according to the 2019 audit, ${A}).`)).toBe(
      'It grew (according to the 2019 audit,[1]).',
    );
  });

  it('leaves markdown link targets, code blocks and frontmatter alone', () => {
    const md = [
      '---',
      `sources:`,
      `  - source_id: ${A}`,
      '---',
      `See [the source](/source/${A}).`,
      '```',
      `(${A})`,
      '```',
    ].join('\n');
    expect(text(md)).toBe(md);
  });
});

describe('stored tokens', () => {
  it('render as merged superscript links', () => {
    const scan = scanCitations(`Claim [^${A}][^${B}] here.`);
    const html = renderCitationMarkers(`<p>${scan.markdown}</p>`, (n) => `Source ${n}`);
    expect(html).toBe(
      '<p>Claim<sup class="cite"><a href="#src-1" title="Source 1">1</a><span aria-hidden="true">,</span><a href="#src-2" title="Source 2">2</a></sup> here.</p>',
    );
  });

  it('escape hover titles', () => {
    const scan = scanCitations(`Claim [^${A}].`);
    expect(renderCitationMarkers(scan.markdown, () => 'A "quoted" <title>')).toContain(
      'title="A &quot;quoted&quot; &lt;title&gt;"',
    );
  });

  it('can be stripped from heading text', () => {
    const scan = scanCitations(`## Mining [^${A}]`);
    expect(stripCitationPlaceholders(scan.markdown)).toBe('## Mining');
  });
});

describe('drafting round trip', () => {
  it('labels are assigned once per source, in order', () => {
    const labels = assignCitationLabels([A, B, A.toUpperCase()]);
    expect([...labels.entries()]).toEqual([[A, 'S1'], [B, 'S2']]);
  });

  it('existing content goes to labels; unknown ids get the next free label', () => {
    const labels = assignCitationLabels([A]);
    const r = citationsToLabels(`Old [^${A}] and (${C}).`, labels, isKnownTitle);
    expect(r.markdown).toBe('Old [S1] and [S2].');
    expect(r.added).toEqual([C]);
    expect(labels.get(C)).toBe('S2');
  });

  it('drafted labels become stored tokens; unknown labels and parens are not converted', () => {
    const labels = assignCitationLabels([A, B]);
    const md = '---\ntitle: X [S1]\n---\nFact [S1]. Both [S1, S2]. Also [S2][S1]. Galaxy (S2). Bad [S9]. [S1](http://x)';
    expect(labelsToStoredCitations(md, labels)).toBe(
      `---\ntitle: X [S1]\n---\nFact[^${A}]. Both[^${A}][^${B}]. Also[^${B}][^${A}]. Galaxy (S2). Bad. [S1](http://x)`,
    );
  });

  it('dossier headers are relabelled with titles', () => {
    const labels = assignCitationLabels([A]);
    const out = relabelDossier(
      `From source ${A}:\n  Claim: x\nFrom source ${B}:\n  Claim: y`,
      labels,
      (id) => (id === A ? 'Bitcoin "Basics"' : 'Ethereum Overview'),
    );
    expect(out).toBe(`From [S1] "Bitcoin 'Basics'":\n  Claim: x\nFrom [S2] "Ethereum Overview":\n  Claim: y`);
  });
});
