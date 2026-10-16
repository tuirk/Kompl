/**
 * The wiki article's "Connections" card in the right panel: the page's typed
 * relations, grouped by label ("Uses", "Part of", ... "Related to" last),
 * then the pages it only shares a plain link with ("Also linked"). Each
 * relation opens to the sentences that explain it and the sources they came
 * from. Server component; the data comes from one getPageConnections() call
 * per request in page.tsx (lib/relations.ts; Saved Links gets no card), the
 * display rules from lib/connections-view.ts. Colours and hover live in
 * globals.css (.wiki-rp-*).
 */

import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  ALSO_LINKED_VISIBLE,
  connectionsCount,
  moreSourcesNote,
  sourcesNote,
  splitRows,
  visibleRowCount,
} from '../../../lib/connections-view';
import type { ConnectionGroup, ConnectionItem, LinkedPage, PageConnections } from '../../../lib/relations';
import { NOTE, PageRow, PanelSection, ROW, TRUNCATE } from './RightPanel';

/** A row's title and its note side by side; the title gives way first. */
const ROW_LINE: CSSProperties = { ...ROW, display: 'flex', alignItems: 'baseline', gap: 6 };
const ROW_TITLE: CSSProperties = { ...TRUNCATE, minWidth: 0 };
const ROW_NOTE: CSSProperties = { flexShrink: 0, fontSize: 12, color: 'var(--fg-dim)' };
const GROUP_LABEL: CSSProperties = {
  margin: '0.6rem 0 0.1rem',
  padding: '0 8px',
  fontSize: 12,
  lineHeight: '17px',
  fontWeight: 500,
  color: 'var(--fg-dim)',
};
/**
 * The evidence toggle is as tall as the row (4px + 20px line + 4px), so it
 * stays above a 24px target under the site's html zoom of 0.9 (25.2px).
 */
const TOGGLE_SIZE = 28;
/** Room on the right of a row for its evidence toggle. */
const TOGGLE_ROOM = 32;

export default function ConnectionsPanel({ connections }: { connections: PageConnections }) {
  const count = connectionsCount(connections);
  return (
    <PanelSection label="Connections" count={count}>
      {count === 0 ? (
        <p style={{ ...NOTE, margin: 0, padding: '0 8px' }}>No connections yet.</p>
      ) : (
        <>
          {connections.groups.map((group) => (
            <RelationGroup key={group.label} group={group} />
          ))}
          {connections.linked_only.length > 0 && <AlsoLinked pages={connections.linked_only} />}
        </>
      )}
    </PanelSection>
  );
}

/** One label's rows; "Related to" shows its first few, the rest behind "Show all". */
function RelationGroup({ group }: { group: ConnectionGroup }) {
  const { shown, rest } = splitRows(group.items, visibleRowCount(group));
  const row = (item: ConnectionItem) => (
    <ConnectionRow key={`${item.page_id ?? `name:${item.title}`}\u0000${item.type}`} label={group.label} item={item} />
  );
  return (
    <div>
      <h3 style={GROUP_LABEL}>{group.label}</h3>
      {shown.map(row)}
      {rest.length > 0 && <MoreRows total={group.items.length}>{rest.map(row)}</MoreRows>}
    </div>
  );
}

/**
 * The other page (a link) or a name with no page yet, with its source count.
 * The chevron beside it opens the evidence; it sits outside the link so the
 * title stays one click away from its page.
 */
function ConnectionRow({ label, item }: { label: string; item: ConnectionItem }) {
  const note = sourcesNote(item);
  const toggle = item.evidence.length > 0;
  const lineStyle: CSSProperties = toggle ? { ...ROW_LINE, paddingRight: TOGGLE_ROOM } : ROW_LINE;
  const line = item.page_id ? (
    <Link href={`/wiki/${item.page_id}`} className="wiki-rp-item" title={item.title} style={lineStyle}>
      <span style={ROW_TITLE}>{item.title}</span>
      {note && <span style={ROW_NOTE}>{`· ${note}`}</span>}
    </Link>
  ) : (
    <div title={`${item.title}: no page yet`} style={{ ...lineStyle, color: 'var(--fg-dim)' }}>
      <span style={ROW_TITLE}>{item.title}</span>
      <span style={ROW_NOTE}>{note ? `· no page yet · ${note}` : '· no page yet'}</span>
    </div>
  );
  if (!toggle) return line;
  return (
    <div style={{ position: 'relative' }}>
      {line}
      <details className="wiki-rp-why">
        <summary
          className="wiki-rp-item"
          aria-label={`Why: ${label} ${item.title}`}
          title="Why they connect"
          style={{
            position: 'absolute',
            top: 0,
            right: 2,
            width: TOGGLE_SIZE,
            height: TOGGLE_SIZE,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 6,
          }}
        >
          <ChevronDown size={14} aria-hidden />
        </summary>
        <Evidence item={item} />
      </details>
    </div>
  );
}

/** The sentences behind a connection, each with the source it came from. */
function Evidence({ item }: { item: ConnectionItem }) {
  const more = moreSourcesNote(item);
  return (
    <ul
      style={{
        listStyle: 'none',
        margin: '0 8px 6px',
        padding: '0 0 0 10px',
        borderLeft: '2px solid var(--border-hover)',
      }}
    >
      {item.evidence.map((e) => (
        <li key={e.source_id} style={{ padding: '3px 0' }}>
          {e.sentence && (
            <span style={{ display: 'block', fontSize: 13, lineHeight: '18px', color: 'var(--fg-secondary)' }}>
              {e.sentence}
            </span>
          )}
          <span style={NOTE}>
            <Link href={`/source/${e.source_id}`}>{e.source_title}</Link>
            {e.source_archived && <span title="This source is archived">{' (archived)'}</span>}
          </span>
        </li>
      ))}
      {more && <li style={{ ...NOTE, padding: '3px 0' }}>{more}</li>}
    </ul>
  );
}

/** Pages linked either way with no typed relation: the first few, the rest behind "Show all". */
function AlsoLinked({ pages }: { pages: ReadonlyArray<LinkedPage> }) {
  const { shown, rest } = splitRows(pages, ALSO_LINKED_VISIBLE);
  const row = (p: LinkedPage) => <PageRow key={p.page_id} href={`/wiki/${p.page_id}`} title={p.title} />;
  return (
    <div>
      <h3 style={GROUP_LABEL}>Also linked</h3>
      {shown.map(row)}
      {rest.length > 0 && <MoreRows total={pages.length}>{rest.map(row)}</MoreRows>}
    </div>
  );
}

/** The panel's "Show all N" / "Show fewer" disclosure. */
function MoreRows({ total, children }: { total: number; children: ReactNode }) {
  return (
    <details className="wiki-rp-more">
      <summary className="wiki-rp-item" style={{ ...ROW, fontSize: 13, color: 'var(--accent)' }}>
        <span className="wiki-rp-all">Show all {total}</span>
        <span className="wiki-rp-less">Show fewer</span>
      </summary>
      {children}
    </details>
  );
}
