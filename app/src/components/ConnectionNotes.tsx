/**
 * The notes under a connection row, shared by the page's Connections card
 * and the graph's panels: "May be outdated — <newer source> says otherwise"
 * (lib/relation-outdated.ts) and "Sources disagree on direction: A says
 * “Part of”; B says “Includes”." (lib/relation-direction.ts). Each source
 * links to its page. No hooks, so it renders in server and client
 * components alike. Nothing when the connection has neither note.
 */

import Link from 'next/link';
import type { CSSProperties } from 'react';
import { hasConnectionNotes, namedSources } from '../lib/connections-view';
import type { ConnectionItem, DirectionSide } from '../lib/relations';

const LINE: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-body)',
  fontSize: 12,
  lineHeight: '17px',
  color: 'var(--fg-dim)',
  overflowWrap: 'anywhere',
};
const SOURCE_LINK: CSSProperties = { color: 'var(--accent)' };

export default function ConnectionNotes({
  item,
  style,
}: {
  item: Pick<ConnectionItem, 'direction_dispute' | 'outdated'>;
  style?: CSSProperties;
}) {
  if (!hasConnectionNotes(item)) return null;
  const { outdated, direction_dispute: dispute } = item;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, ...style }}>
      {outdated && (
        <p style={LINE} title={`Changed: ${outdated.topic}`}>
          <span style={{ color: 'var(--warning)' }}>May be outdated</span>
          {' — '}
          <Link href={`/source/${outdated.source_id}`} style={SOURCE_LINK}>
            {outdated.source_title}
          </Link>
          {' says otherwise'}
        </p>
      )}
      {dispute && (
        <p style={LINE}>
          {'Sources disagree on direction: '}
          <Side side={dispute.kept} />
          {'; '}
          <Side side={dispute.other} />
          {'.'}
        </p>
      )}
    </div>
  );
}

/** "A and B say “Part of”", each source a link. */
function Side({ side }: { side: DirectionSide }) {
  const { shown, more, verb } = namedSources(side.sources);
  if (shown.length === 0) return <>{`Some sources say “${side.label}”`}</>;
  return (
    <>
      {shown.map((s, i) => (
        <span key={s.source_id}>
          {i > 0 && (i === shown.length - 1 && more === 0 ? ' and ' : ', ')}
          <Link href={`/source/${s.source_id}`} style={SOURCE_LINK}>
            {s.source_title}
          </Link>
        </span>
      ))}
      {more > 0 && ` and ${more} more`}
      {` ${verb} “${side.label}”`}
    </>
  );
}
