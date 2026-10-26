'use client';

/**
 * "Find a page" in the graph's header: a title field over the pages on the
 * map, the keyboard's way into it (the canvas takes no focus). Choosing a
 * title from the list, or Enter on a title or the start of one, selects that
 * page and moves the map to it; its panel opens with the keyboard in it, and
 * the panel's connections lead on to its neighbours. Typing alone never
 * moves the map. Titles as the path finder shows them (lib/graph-path.ts).
 */

import { useId, useMemo, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { Search } from 'lucide-react';
import type { ModelNode } from '../../../lib/graph-model';
import { findByTitle, pickerLabel } from '../../../lib/graph-path';

/** The page `text` names (any case); with `prefix`, else the first title, in list order, that starts with it. */
export function findPage(sorted: readonly ModelNode[], text: string, prefix: boolean): string | null {
  const exact = findByTitle(sorted, text);
  if (exact !== null || !prefix) return exact;
  const want = text.trim().toLowerCase();
  if (!want) return null;
  return sorted.find((n) => pickerLabel(n).toLowerCase().startsWith(want))?.id ?? null;
}

/** Typing or deleting; any other change (a choice from the list, a paste) may pick a page. */
const TYPING = /^(insertText|insertCompositionText|delete)/;

export default function FindPage({ pages, onFind }: { pages: readonly ModelNode[]; onFind(pageId: string): void }) {
  const listId = useId();
  const [text, setText] = useState('');
  const sorted = useMemo(
    () => [...pages].sort((x, y) => x.label.localeCompare(y.label) || (x.id < y.id ? -1 : 1)),
    [pages]
  );
  const go = (value: string, prefix: boolean) => {
    const id = findPage(sorted, value, prefix);
    if (id === null) return;
    setText('');
    onFind(id);
  };
  const change = (e: ChangeEvent<HTMLInputElement>) => {
    setText(e.target.value);
    if (!TYPING.test((e.nativeEvent as InputEvent).inputType ?? '')) go(e.target.value, false);
  };
  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    go(text, true);
  };

  return (
    <div role="search" style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
      <Search size={12} aria-hidden style={{ position: 'absolute', left: 10, color: 'var(--fg-muted)', pointerEvents: 'none' }} />
      <input
        type="text"
        list={listId}
        value={text}
        onChange={change}
        onKeyDown={key}
        aria-label="Find a page on the map"
        placeholder="Find a page"
        title="Type a title and press Enter, or choose one from the list"
        autoComplete="off"
        spellCheck={false}
        className="graph-header-btn"
        style={{
          height: 35, width: 180, padding: '0 10px 0 28px', border: '1px solid rgba(71,72,74,0.4)',
          background: 'var(--bg-card-hover)', color: 'var(--fg)', fontFamily: 'var(--font-body)', fontSize: 12,
        }}
      />
      <datalist id={listId}>
        {sorted.map((n) => (
          <option key={n.id} value={pickerLabel(n)} />
        ))}
      </datalist>
    </div>
  );
}
