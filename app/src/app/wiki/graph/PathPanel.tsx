'use client';

/**
 * "Connect two pages": two title pickers over the pages on the map (type a
 * title, or click pages on the map), then the cheapest chain of lines
 * between them (lib/graph-path.ts) as a list of steps, each with its
 * relation, read from the page before it, and the first sentence behind it.
 * Says so when no chain joins the two, and offers the line types that are
 * hidden. Report-only.
 */

import Link from 'next/link';
import { useId, useMemo, useState, type CSSProperties, type RefObject } from 'react';
import { ArrowUpDown } from 'lucide-react';
import { relationsBetween } from '../../../lib/graph-focus';
import type { GraphModel, ModelNode } from '../../../lib/graph-model';
import {
  findByTitle, pathSteps, pickerLabel, pickerLabels, type GraphPath, type PathQuery, type PathStep,
} from '../../../lib/graph-path';
import type { PageConnections } from '../../../lib/relations';
import { BODY, DOT, KICKER, LINK_BUTTON, META, PanelNote, PanelShell } from './panel-parts';
import { useConnections } from './useConnections';

interface Props {
  /** Pages the pickers offer: the pages on the map, by title. */
  pages: readonly ModelNode[];
  model: GraphModel;
  query: PathQuery;
  onQuery(next: PathQuery): void;
  /** The chain for a full query; null when none joins the two pages. */
  path: GraphPath | null;
  /** Turns on the line types the legend hides; absent when all show. */
  onShowAllLines?: () => void;
  cache: Map<string, PageConnections>;
  onClose(): void;
  /** Select a page on the map and move to it. */
  onPick(pageId: string): void;
  returnFocusTo: RefObject<HTMLElement | null>;
}

const SMALL_BUTTON: CSSProperties = {
  ...LINK_BUTTON, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 8px',
  border: '1px solid rgba(71,72,74,0.4)', background: 'rgba(36,38,41,0.7)', color: 'var(--fg-secondary)', fontSize: 12,
};
/** The rail down the left of the steps. */
const RAIL: CSSProperties = { margin: '0 0 0 3px', padding: '4px 0 6px 14px', borderLeft: '2px solid rgba(71,72,74,0.5)' };

export default function PathPanel(props: Props) {
  const { pages, model, query, onQuery, path, onShowAllLines, cache, onClose, onPick, returnFocusTo } = props;
  const listId = useId();
  const labels = useMemo(() => pickerLabels(pages), [pages]);
  const title = (id: string | null) => (id ? (model.byId.get(id)?.label ?? id) : '');
  const complete = query.from !== null && query.to !== null;
  const steps = complete && path ? pathSteps(path) : [];

  return (
    <PanelShell
      kicker={path && complete ? `Path · ${steps.length} step${steps.length === 1 ? '' : 's'}` : 'Connect two pages'}
      title={complete ? `${title(query.from)} → ${title(query.to)}` : 'How do two pages connect?'}
      onClose={onClose}
      returnFocusTo={returnFocusTo}
    >
      <datalist id={listId}>
        {pages.map((n) => (
          <option key={n.id} value={labels.get(n.id)} />
        ))}
      </datalist>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
          <Picker label="From" listId={listId} pages={pages} labels={labels} model={model} value={query.from} onChange={(from) => onQuery({ ...query, from })} />
          <Picker label="To" listId={listId} pages={pages} labels={labels} model={model} value={query.to} onChange={(to) => onQuery({ ...query, to })} />
        </div>
        <button
          type="button"
          className="graph-header-btn"
          onClick={() => onQuery({ from: query.to, to: query.from })}
          aria-label="Swap the two pages"
          title="Swap"
          style={{ ...SMALL_BUTTON, height: 36, padding: '0 10px', marginBottom: 2 }}
        >
          <ArrowUpDown size={14} aria-hidden />
        </button>
      </div>

      <div aria-live="polite" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {!complete && (
          <PanelNote>
            {query.from === null && query.to === null
              ? 'Type a title in each box, or click two pages on the map.'
              : 'Now pick the second page.'}{' '}
            The path prefers typed relations over plain links and “related to”.
          </PanelNote>
        )}
        {complete && query.from === query.to && <PanelNote>Pick two different pages.</PanelNote>}
        {complete && query.from !== query.to && path === null && (
          <>
            <p style={{ ...BODY, margin: 0, color: 'var(--fg)' }}>No connection between these pages on the map.</p>
            {onShowAllLines && (
              <div>
                <button type="button" className="graph-header-btn" onClick={onShowAllLines} style={SMALL_BUTTON}>
                  Show plain links and “related to” too
                </button>
              </div>
            )}
          </>
        )}
        {path && query.from !== query.to && (
          <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {steps.map((step) => (
              <li key={`${step.from}\u0000${step.to}`}>
                <PageStop node={model.byId.get(step.from)} onPick={onPick} />
                <StepRow step={step} cache={cache} />
              </li>
            ))}
            <li>
              <PageStop node={model.byId.get(path.nodes[path.nodes.length - 1])} onPick={onPick} />
            </li>
          </ol>
        )}
      </div>
    </PanelShell>
  );
}

/** A labelled title picker; the page is set once the text matches a label, or a title only one page has. */
function Picker(props: {
  label: string; listId: string; pages: readonly ModelNode[]; labels: ReadonlyMap<string, string>; model: GraphModel;
  value: string | null; onChange(id: string | null): void;
}) {
  const { label, listId, pages, labels, model, value, onChange } = props;
  const labelOf = (id: string | null) => {
    const node = id ? model.byId.get(id) : undefined;
    return node ? (labels.get(node.id) ?? pickerLabel(node)) : '';
  };
  const [text, setText] = useState(() => labelOf(value));
  const [seen, setSeen] = useState(value);
  // The page changed from outside (a click on the map, swap): show its title, unless the text already names it.
  if (value !== seen) {
    setSeen(value);
    if (findByTitle(pages, text, labels) !== value) setText(labelOf(value));
  }
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ ...KICKER, color: 'var(--fg-muted)' }}>{label}</span>
      <input
        type="text"
        list={listId}
        value={text}
        placeholder="Page title"
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          const id = findByTitle(pages, e.target.value, labels);
          if (id !== value) onChange(id);
        }}
        style={{ fontFamily: 'var(--font-body)', fontSize: 13, padding: '7px 10px', background: 'var(--bg-card-hover)', color: 'var(--fg)' }}
      />
    </label>
  );
}

/** A page on the path: its category colour and title; a click moves the map to it. */
function PageStop({ node, onPick }: { node: ModelNode | undefined; onPick(id: string): void }) {
  if (!node) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={DOT(node.color)} />
      <button type="button" onClick={() => onPick(node.id)} title="Show on the map" style={{ ...LINK_BUTTON, ...BODY, fontWeight: 600, color: 'var(--fg)' }}>
        {node.label}
      </button>
    </div>
  );
}

/** One step's relation, read from the page before it, and the first sentence behind it. */
function StepRow({ step, cache }: { step: PathStep; cache: Map<string, PageConnections> }) {
  const state = useConnections(step.from, cache);
  if (step.type === null) {
    return (
      <div style={RAIL}>
        <span style={{ ...META, fontWeight: 600, color: 'var(--fg-muted)' }}>Plain link</span>
        <span style={META}> · the pages link in their text, with no typed relation yet</span>
      </div>
    );
  }
  const found = state.status === 'ready' ? relationsBetween(state.data, step.to) : [];
  const item = (found.find((f) => f.item.type === step.type) ?? found[0])?.item;
  const evidence = item?.evidence.find((e) => e.sentence) ?? item?.evidence[0];
  return (
    <div style={RAIL}>
      <span style={{ ...META, fontWeight: 600, color: 'var(--fg)' }}>{step.label}</span>
      {item && item.source_count > 1 && <span style={META}>{` · ${item.source_count} sources`}</span>}
      {state.status === 'loading' && <div style={META}>Loading the evidence…</div>}
      {evidence?.sentence && <div style={{ ...BODY, fontSize: 12, lineHeight: '18px', marginTop: 2 }}>“{evidence.sentence}”</div>}
      {evidence && (
        <div style={META}>
          <Link href={`/source/${evidence.source_id}`} style={{ color: 'var(--accent)' }}>
            {evidence.source_title}
          </Link>
          {evidence.source_archived && ' (archived)'}
        </div>
      )}
    </div>
  );
}
