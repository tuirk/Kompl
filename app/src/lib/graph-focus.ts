/**
 * What the knowledge graph lights up for a hovered or selected page or line,
 * and how a line reads as a sentence ("Bitcoin — Uses → Proof of work").
 * Pure and client-safe, on top of graph-model.ts.
 */

import { isSymmetricRelation, relationLabel } from './relation-labels';
import { isMissingLink, isMissingNode, missingDetail } from './graph-missing';
import type { ModelLink, ModelNode, VisibleGraph } from './graph-model';
import type { ConnectionItem, PageConnections } from './relations';

/** What stays lit while a page or line is hovered or selected. */
export interface Highlight {
  nodes: Set<string>;
  links: Set<ModelLink>;
}

export function nodeHighlight(visible: VisibleGraph, id: string): Highlight {
  const nodes = new Set<string>([id, ...(visible.neighbours.get(id) ?? [])]);
  return { nodes, links: new Set(visible.linksOf.get(id) ?? []) };
}

export function linkHighlight(link: ModelLink): Highlight {
  return { nodes: new Set([link.a, link.b]), links: new Set([link]) };
}

/** A hovered or selected page or line. */
export type GraphFocus = { kind: 'node'; id: string } | { kind: 'link'; link: ModelLink };

/** The hover wins over the selection; a focus that is no longer shown lights nothing. */
export function focusHighlight(visible: VisibleGraph, hovered: GraphFocus | null, selected: GraphFocus | null): Highlight | null {
  for (const focus of [hovered, selected]) {
    if (focus?.kind === 'node' && visible.neighbours.has(focus.id)) return nodeHighlight(visible, focus.id);
    if (focus?.kind === 'link' && visible.linksOf.get(focus.link.a)?.includes(focus.link)) return linkHighlight(focus.link);
  }
  return null;
}

/**
 * The page ids [from, to] to read a line as "A — Uses → B": the `from` end
 * of its strongest one-way relation, so the label reads forwards; for a line
 * with only two-way relations, `prefer` when it is one of the ends.
 */
export function readingOrder(link: Pick<ModelLink, 'a' | 'b' | 'relations'>, prefer?: string | null): [string, string] {
  const oneWay = link.relations.find((r) => !isSymmetricRelation(r.type));
  if (oneWay) return oneWay.direction === 'out' ? [link.a, link.b] : [link.b, link.a];
  return prefer === link.b ? [link.b, link.a] : [link.a, link.b];
}

/** The relation a line is coloured and named by: its strongest specific one, else its first; undefined for a plain link. */
export function namedRelation(link: Pick<ModelLink, 'relations' | 'colorType'>): ModelLink['relations'][number] | undefined {
  return link.relations.find((r) => r.type === link.colorType) ?? link.relations[0];
}

/** One line of text for a hovered line: "Bitcoin — Uses → Proof of work (+1 more)". */
export function linkSummary(link: ModelLink, byId: ReadonlyMap<string, ModelNode>): string {
  const [from, to] = readingOrder(link);
  const title = (id: string) => byId.get(id)?.label ?? id;
  const first = namedRelation(link);
  if (!first) return `Plain link: ${title(from)} — ${title(to)}`;
  const direction = from === link.a ? first.direction : first.direction === 'out' ? 'in' : 'out';
  const more = link.relations.length > 1 ? ` (+${link.relations.length - 1} more)` : '';
  return `${title(from)} — ${relationLabel(first.type, direction)} → ${title(to)}${more}`;
}

/** A line's relations with their evidence: the connections of its `from` page whose other end is `toId`. */
export function relationsBetween(connections: PageConnections, toId: string): Array<{ label: string; item: ConnectionItem }> {
  return connections.groups.flatMap((g) => g.items.filter((i) => i.page_id === toId).map((item) => ({ label: g.label, item })));
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The hover card's two lines. A page: its title, then category, type and
 * sources. A missing name: the name, then how many sources name it. A line:
 * its summary, then a prompt with the source count of the relation the
 * summary names (not the line's weight, which may come from another
 * relation). Null when nothing is hovered.
 */
export function hoverCardText(
  hovered: GraphFocus | null, byId: ReadonlyMap<string, ModelNode>
): { title: string; detail: string } | null {
  if (hovered?.kind === 'node') {
    const n = byId.get(hovered.id);
    if (!n) return null;
    if (isMissingNode(n)) return { title: n.label, detail: missingDetail(n.sourceCount) };
    return { title: n.label, detail: `${n.category} · ${n.pageType.replace(/-/g, ' ')} · ${plural(n.sourceCount, 'source')}` };
  }
  if (hovered?.kind === 'link' && !isMissingLink(hovered.link)) {
    const named = namedRelation(hovered.link);
    const sources = named ? ` · ${plural(named.source_count, 'source')}` : '';
    return { title: linkSummary(hovered.link, byId), detail: `Click for the evidence${sources}` };
  }
  return null;
}

/**
 * Above this many visible lines only typed lines answer the pointer.
 * force-graph repaints every pointer-aware line on a hidden hit-test canvas
 * after each redraw; with thousands of plain and "related to" lines that
 * repaint stalls hover and zoom for most of a second.
 */
export const POINTER_LINES_MAX = 3000;

export function limitsLinePointer(visibleLines: number): boolean {
  return visibleLines > POINTER_LINES_MAX;
}

/** Whether a line can be hovered and clicked: never a missing name's line, and only typed ones when limited. */
export function takesPointer(link: ModelLink, limited: boolean): boolean {
  return !isMissingLink(link) && (!limited || link.kind === 'typed');
}

/**
 * The hover to show: what force-graph reports, only while the pointer is
 * over the canvas. force-graph keeps testing its last pointer position after
 * the pointer leaves (onto a panel, the legend or a zoom button), so the map
 * gliding under that point would otherwise light pages nobody points at.
 */
export function acceptHover<T>(overCanvas: boolean, hovered: T | null): T | null {
  return overCanvas ? hovered : null;
}

/** The bits of a keyboard event the Escape rule reads (a KeyboardEvent fits). */
export interface EscapeKeyEvent {
  key: string;
  defaultPrevented: boolean;
  target: unknown;
}

/**
 * Whether Escape should close the graph's panel: not when typing in a field
 * (input, textarea, select, contenteditable, e.g. the top bar's search) and
 * not when something else already handled the key.
 */
export function closesPanelOnEscape(e: EscapeKeyEvent): boolean {
  if (e.key !== 'Escape' || e.defaultPrevented) return false;
  const target = e.target as { tagName?: unknown; isContentEditable?: unknown } | null;
  if (target && typeof target === 'object') {
    const tag = typeof target.tagName === 'string' ? target.tagName.toUpperCase() : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true) return false;
  }
  return true;
}
