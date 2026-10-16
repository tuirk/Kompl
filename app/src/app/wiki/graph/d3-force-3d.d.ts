/**
 * The few d3-force-3d exports the graph page uses (graph-forces.ts). The
 * package ships no types. It is declared in package.json at the version
 * force-graph itself uses, and transpiled via next.config.js transpilePackages.
 */
declare module 'd3-force-3d' {
  type NodeNumber<N> = number | ((node: N, index: number, nodes: N[]) => number);

  interface Force<N> {
    (alpha: number): void;
    initialize(nodes: N[], ...args: unknown[]): void;
  }

  interface PositionForce<N> extends Force<N> {
    strength(strength: NodeNumber<N>): this;
  }

  interface CollideForce<N> extends Force<N> {
    radius(radius: NodeNumber<N>): this;
    strength(strength: number): this;
    iterations(iterations: number): this;
  }

  export function forceX<N>(x?: NodeNumber<N>): PositionForce<N>;
  export function forceY<N>(y?: NodeNumber<N>): PositionForce<N>;
  export function forceCollide<N>(radius?: NodeNumber<N>): CollideForce<N>;
}
