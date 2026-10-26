'use client';

/**
 * The graph's page panel: what a page is (type, category, sources, summary)
 * and how it connects, grouped by relation ("Uses", "Part of", ... "Related
 * to" last, then "Also linked"), each connection opening to its evidence.
 * Connections come from /api/wiki/[page_id]/connections, as on the page's
 * own Connections card. Clicking a connected page that is on the map moves
 * the map to it. A bridge page says which topics it joins; "Focus" shows the
 * page with its neighbours only.
 */

import Link from 'next/link';
import { useState, type ReactNode, type RefObject } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  ALSO_LINKED_VISIBLE, connectionsBreakdown, connectionsCount, hasConnections, sourcesNote, splitRows, visibleRowCount,
} from '../../../lib/connections-view';
import { topicList, type Bridge } from '../../../lib/graph-metrics';
import type { ModelNode } from '../../../lib/graph-model';
import { PAGE_TYPE_LABELS, PAGE_TYPE_VAR, type PageType } from '../../../lib/page-type-palette';
import type { ConnectionItem, LinkedPage, PageConnections } from '../../../lib/relations';
import {
  BADGE, BODY, DOT, EvidenceList, FooterButton, FooterLink, LINK_BUTTON, META, PanelNote, PanelSection, PanelShell,
} from './panel-parts';
import { useConnections } from './useConnections';
import ConnectionNotes from '../../../components/ConnectionNotes';

interface Props {
  node: ModelNode;
  /** True when the page is drawn on the map right now. */
  isShown(pageId: string): boolean;
  cache: Map<string, PageConnections>;
  onClose(): void;
  /** Select a page on the map and move to it. */
  onPick(pageId: string): void;
  returnFocusTo: RefObject<HTMLElement | null>;
  /** False when the panel comes back because a filter showed the page again (PanelShell). */
  takeFocus?: boolean;
  /** Set when the page is one of the map's bridges. */
  bridge?: Bridge | null;
  /** Show the page with its neighbours only; absent when the map is already focused on it. */
  onFocus?(pageId: string): void;
}

function typeBadge(pageType: string): { label: string; color: string } {
  const known = pageType in PAGE_TYPE_VAR;
  return {
    label: known ? PAGE_TYPE_LABELS[pageType as PageType] : pageType.replace(/-/g, ' '),
    color: known ? PAGE_TYPE_VAR[pageType as PageType] : 'var(--fg-dim)',
  };
}

export default function NodePanel({ node, isShown, cache, onClose, onPick, returnFocusTo, takeFocus, bridge = null, onFocus }: Props) {
  const state = useConnections(node.id, cache);
  const breakdown = state.status === 'ready' ? connectionsBreakdown(state.data) : null;
  const badge = typeBadge(node.pageType);
  const pageLink = (id: string, title: string, muted = false): ReactNode =>
    isShown(id) ? (
      <button type="button" onClick={() => onPick(id)} title="Show on the map" style={{ ...LINK_BUTTON, color: muted ? 'var(--fg-secondary)' : 'var(--fg)' }}>
        {title}
      </button>
    ) : (
      <Link href={`/wiki/${id}`} title="Open page" style={{ color: 'var(--fg-secondary)' }}>
        {title}
      </Link>
    );

  return (
    <PanelShell
      kicker={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: badge.color }}>
          <span style={DOT(badge.color)} />
          {badge.label}
          {node.archived && <span style={{ color: 'var(--fg-dim)' }}>· archived</span>}
        </span>
      }
      title={node.label}
      onClose={onClose}
      returnFocusTo={returnFocusTo}
      takeFocus={takeFocus}
      footer={
        <>
          {onFocus && (
            <FooterButton onClick={() => onFocus(node.id)} title="Show this page and its neighbours only">
              Focus
            </FooterButton>
          )}
          <FooterLink href={`/wiki/${node.id}`}>Open page →</FooterLink>
        </>
      }
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', ...META }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--fg-secondary)' }}>
          <span style={DOT(node.color)} />
          {node.category}
        </span>
        <span>·</span>
        <span>
          {node.sourceCount} source{node.sourceCount === 1 ? '' : 's'}
        </span>
      </div>
      {bridge && (
        <p style={{ ...META, margin: 0, color: 'var(--fg-secondary)' }}>
          <span style={BADGE}>Bridge</span> Joins {topicList(bridge.topics)}: many of the shortest ways between pages of different topics pass through it.
        </p>
      )}
      {node.summary && <p style={{ ...BODY, margin: 0 }}>{node.summary}</p>}

      {state.status === 'loading' && <PanelNote>Loading connections…</PanelNote>}
      {state.status === 'error' && <PanelNote>Could not load this page&apos;s connections.</PanelNote>}
      {state.status === 'ready' && (
        <PanelSection label="Connections" count={connectionsCount(state.data) || undefined}>
          {!hasConnections(state.data) && <PanelNote>No connections yet.</PanelNote>}
          {breakdown && <PanelNote>{breakdown}</PanelNote>}
          {state.data.groups.map((group) => {
            const { shown, rest } = splitRows(group.items, visibleRowCount(group));
            // Every row keeps its evidence here (the page's own card renders the rest compact).
            const row = (item: ConnectionItem) => (
              <ItemRow key={`${item.page_id ?? `name:${item.title}`}\u0000${item.type}`} item={item} pageId={node.id} pageLink={pageLink} />
            );
            return (
              <div key={group.label}>
                <div style={{ ...META, fontWeight: 600, color: 'var(--fg-muted)', margin: '4px 0 2px' }}>{group.label}</div>
                {shown.map(row)}
                {rest.length > 0 && <MoreRows total={group.items.length}>{rest.map(row)}</MoreRows>}
              </div>
            );
          })}
          {state.data.linked_only.length > 0 && <AlsoLinked pages={state.data.linked_only} pageLink={pageLink} />}
        </PanelSection>
      )}
    </PanelShell>
  );
}

type PageLink = (id: string, title: string, muted?: boolean) => ReactNode;

/** One connection: the other page (or a name with no page yet), its sources, and the evidence behind a toggle. */
function ItemRow({ item, pageId, pageLink }: { item: ConnectionItem; pageId: string; pageLink: PageLink }) {
  const [open, setOpen] = useState(false);
  const note = sourcesNote(item);
  return (
    <div style={{ padding: '3px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, ...BODY }}>
        <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
          {/* A connection a newer source superseded is dimmed; its note says why. */}
          <span style={item.outdated ? { opacity: 0.65 } : undefined}>
            {item.page_id ? pageLink(item.page_id, item.title) : <span style={{ color: 'var(--fg-dim)' }}>{item.title}</span>}
          </span>
          <span style={META}>
            {item.page_id ? '' : ' · no page yet'}
            {note ? ` · ${note}` : ''}
          </span>
        </span>
        {item.evidence.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={`Why: ${item.title}`}
            title="Why they connect"
            style={{
              width: 28, height: 28, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'none', border: 'none', cursor: 'pointer', color: 'var(--fg-dim)',
              transform: open ? 'rotate(180deg)' : undefined, transition: 'transform 150ms',
            }}
          >
            <ChevronDown size={14} aria-hidden />
          </button>
        )}
      </div>
      <ConnectionNotes item={item} style={{ margin: '0 0 2px' }} />
      {open && (
        <div style={{ margin: '2px 0 6px' }}>
          <EvidenceList item={item} pageId={pageId} />
        </div>
      )}
    </div>
  );
}

function AlsoLinked({ pages, pageLink }: { pages: LinkedPage[]; pageLink: PageLink }) {
  const { shown, rest } = splitRows(pages, ALSO_LINKED_VISIBLE);
  const row = (p: LinkedPage) => (
    <div key={p.page_id} style={{ ...BODY, padding: '2px 0' }}>
      {pageLink(p.page_id, p.title, true)}
    </div>
  );
  return (
    <div>
      <div style={{ ...META, fontWeight: 600, color: 'var(--fg-muted)', margin: '8px 0 2px' }}>
        Also linked <span style={{ fontWeight: 400, color: 'var(--fg-dim)' }}>{pages.length}</span>
      </div>
      {shown.map(row)}
      {rest.length > 0 && <MoreRows total={pages.length}>{rest.map(row)}</MoreRows>}
    </div>
  );
}

/** "Show all N" / "Show fewer" under a long list. */
function MoreRows({ total, children }: { total: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {open && children}
      <button type="button" onClick={() => setOpen((v) => !v)} style={{ ...LINK_BUTTON, ...META, color: 'var(--accent)', padding: '4px 0' }}>
        {open ? 'Show fewer' : `Show all ${total}`}
      </button>
    </>
  );
}
