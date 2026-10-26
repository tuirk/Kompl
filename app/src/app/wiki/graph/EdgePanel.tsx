'use client';

/**
 * The graph's line panel: why two pages are joined. Each relation reads from
 * one page to the other ("Bitcoin network — Uses → proof-of-work consensus")
 * with its source count and the sentences behind it, each linking to its
 * source. The data is the first page's connections
 * (/api/wiki/[page_id]/connections) narrowed to the second page. A line with
 * no typed relation says it is a plain link.
 */

import type { CSSProperties, RefObject } from 'react';
import { readingOrder, relationsBetween } from '../../../lib/graph-focus';
import type { GraphModel, ModelLink } from '../../../lib/graph-model';
import { relationLabel } from '../../../lib/relation-labels';
import type { PageConnections } from '../../../lib/relations';
import { BODY, EvidenceList, FooterLink, LINK_BUTTON, META, PanelNote, PanelShell } from './panel-parts';
import { useConnections } from './useConnections';
import ConnectionNotes from '../../../components/ConnectionNotes';

interface Props {
  link: ModelLink;
  model: GraphModel;
  cache: Map<string, PageConnections>;
  onClose(): void;
  /** Select a page on the map and move to it. */
  onPick(pageId: string): void;
  returnFocusTo: RefObject<HTMLElement | null>;
  /** False when the panel comes back because a filter showed the line again (PanelShell). */
  takeFocus?: boolean;
}

const ELLIPSIS: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 };

export default function EdgePanel({ link, model, cache, onClose, onPick, returnFocusTo, takeFocus }: Props) {
  const [fromId, toId] = readingOrder(link);
  const from = model.byId.get(fromId)?.label ?? fromId;
  const to = model.byId.get(toId)?.label ?? toId;
  const state = useConnections(fromId, cache);
  const found = state.status === 'ready' ? relationsBetween(state.data, toId) : [];
  const name = (id: string, title: string) => (
    <button type="button" onClick={() => onPick(id)} title="Show on the map" style={{ ...LINK_BUTTON, fontWeight: 600 }}>
      {title}
    </button>
  );

  return (
    <PanelShell
      kicker="Connection"
      title={`${from} ↔ ${to}`}
      onClose={onClose}
      returnFocusTo={returnFocusTo}
      takeFocus={takeFocus}
      footer={
        <>
          <FooterLink href={`/wiki/${fromId}`}>
            <span style={ELLIPSIS}>Open {from}</span>
          </FooterLink>
          <FooterLink href={`/wiki/${toId}`}>
            <span style={ELLIPSIS}>Open {to}</span>
          </FooterLink>
        </>
      }
    >
      {link.kind === 'plain' && (
        <PanelNote>Plain link only: one page links to the other in its text, with no typed relation found in the sources yet.</PanelNote>
      )}
      {link.kind !== 'plain' && state.status === 'loading' && <PanelNote>Loading the evidence…</PanelNote>}
      {link.kind !== 'plain' && state.status === 'error' && <PanelNote>Could not load the evidence.</PanelNote>}

      {found.map(({ label, item }) => (
        <section key={`${item.type}\u0000${label}`} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ ...BODY, fontSize: 14, lineHeight: '21px', color: 'var(--fg)' }}>
            {name(fromId, from)}
            <span style={{ color: 'var(--fg-dim)' }}>{' — '}</span>
            <span style={{ color: 'var(--fg)', fontWeight: 600 }}>{label}</span>
            <span style={{ color: 'var(--fg-dim)' }}>{' → '}</span>
            {name(toId, to)}
          </div>
          <div style={META}>
            {item.source_count} source{item.source_count === 1 ? '' : 's'}
          </div>
          <ConnectionNotes item={item} />
          {item.evidence.length > 0 && <EvidenceList item={item} pageId={fromId} />}
        </section>
      ))}

      {/* No evidence for this pair (an archived page, which connections leave out, or a page
          renamed since the map loaded): show what the line itself knows. */}
      {state.status === 'ready' && found.length === 0 && link.relations.length > 0 &&
        link.relations.map((r) => {
          const direction = fromId === link.a ? r.direction : r.direction === 'out' ? 'in' : 'out';
          return (
            <div key={`${r.type}\u0000${r.direction}`} style={BODY}>
              <span style={{ color: 'var(--fg)', fontWeight: 600 }}>{relationLabel(r.type, direction)}</span>
              <span style={META}>{` · ${r.source_count} source${r.source_count === 1 ? '' : 's'}`}</span>
              {r.outdated && <span style={META}>{' · may be outdated'}</span>}
              {r.direction_disputed && <span style={META}>{' · sources disagree on direction'}</span>}
            </div>
          );
        })}

      {link.kind !== 'plain' && link.wikilink && <PanelNote>The two pages also link to each other in their text.</PanelNote>}
    </PanelShell>
  );
}
