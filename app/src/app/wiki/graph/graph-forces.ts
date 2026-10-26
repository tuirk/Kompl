/**
 * Applies the topic-map layout (lib/graph-layout.ts LAYOUT) to the graph's
 * force simulation: pages pulled toward their category's anchor, charge
 * capped in range, short strong lines inside a category and long weak ones
 * across, no overlap. The accessors read node and line fields, plus the
 * visible degree through `degreeOf` and, in focus mode, the point every
 * page gathers at through `focusAnchor` (null: each page's own category
 * anchor), so force-graph re-reads them whenever the visible graph changes.
 * Client-only.
 */

import { forceCollide, forceX, forceY } from 'd3-force-3d';
import {
  chargeStrength, collideRadius, LAYOUT, linkDistance, linkStrength,
} from '../../../lib/graph-layout';
import type { ModelLink, ModelNode } from '../../../lib/graph-model';

/** The getter/setter both force-graph's d3Force() and a d3 simulation's force() offer. */
export interface ForceHost {
  // d3's forces are untyped chains (.strength().distanceMax()), as in force-graph's own types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  d3Force(name: string): any;
  d3Force(name: string, force: unknown): unknown;
}

const endOf = (end: string | ModelNode): ModelNode => end as ModelNode;

type Point = { x: number; y: number };

export function applyLayoutForces(
  host: ForceHost, degreeOf: (id: string) => number, focusAnchor: () => Point | null = () => null
): void {
  host.d3Force('center', null);
  host
    .d3Force('charge')
    .strength((n: ModelNode) => chargeStrength(n.radius))
    .distanceMax(LAYOUT.chargeDistanceMax);
  // By the time d3 reads these, the link force has swapped ids for nodes.
  host
    .d3Force('link')
    .distance((l: ModelLink) => linkDistance(l.sameCategory, endOf(l.source).radius, endOf(l.target).radius))
    .strength((l: ModelLink) => linkStrength(l.sameCategory, degreeOf(l.a), degreeOf(l.b)));
  host.d3Force('x', forceX<ModelNode>((n) => focusAnchor()?.x ?? n.anchorX).strength(LAYOUT.clusterStrength));
  host.d3Force('y', forceY<ModelNode>((n) => focusAnchor()?.y ?? n.anchorY).strength(LAYOUT.clusterStrength));
  // Full strength and two passes a tick, so circles never rest overlapping.
  host.d3Force(
    'collide',
    forceCollide<ModelNode>((n) => collideRadius(n.radius)).strength(LAYOUT.collideStrength).iterations(LAYOUT.collideIterations)
  );
}
