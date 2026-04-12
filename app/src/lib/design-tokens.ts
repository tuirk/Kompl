/**
 * Obsidian Kinetic — Design Tokens (JS/TS layer)
 *
 * CSS variables handle colors that the browser consumes (see globals.css).
 * This file handles values that JS code needs directly — canvas renderers
 * (ForceGraph2D), inline style objects, and anywhere var(--token) can't reach.
 *
 * SINGLE SOURCE OF TRUTH: Import from here, never hardcode hex values in components.
 */

// -----------------------------------------------------------------------------
// Type badge colors — used in WikiSidebar, wiki page headers, and graph legend.
// Spec: Concept=blue, Entity=orange, Topic/Overview=green
// -----------------------------------------------------------------------------
export const BADGE_COLORS: Record<string, string> = {
  concept:          '#3b82f6',   // blue-500
  entity:           '#f59e0b',   // amber-400
  topic:            '#10b981',   // emerald-500
  overview:         '#10b981',   // same as topic
  comparison:       '#8b5cf6',   // violet-500
  'source-summary': '#6b7280',   // gray-500 (muted, not a primary type)
};

// -----------------------------------------------------------------------------
// Graph node colors — used by the ForceGraph2D canvas renderer (wiki/graph).
// Must be hex; canvas cannot read CSS variables.
// Mirrors BADGE_COLORS for semantic consistency.
// -----------------------------------------------------------------------------
export const GRAPH_NODE_COLORS: Record<string, string> = {
  concept:          '#3b82f6',
  entity:           '#f59e0b',
  topic:            '#10b981',
  overview:         '#10b981',
  comparison:       '#8b5cf6',
  'source-summary': '#6b7280',
};

export const GRAPH_NODE_COLOR_DEFAULT = '#52525b'; // --fg-dim equivalent

// Graph edge and label colors (canvas, not CSS)
export const GRAPH_LINK_COLOR   = '#2a2d31';  // --border-hover equivalent
export const GRAPH_LABEL_COLOR  = '#e2e2e5';  // --fg-secondary equivalent

// -----------------------------------------------------------------------------
// Status badge colors — used in dashboard activity, compile status indicators
// -----------------------------------------------------------------------------
export const STATUS_COLORS = {
  running:   '#f59e0b',   // warning amber — with pulse animation
  done:      '#10b981',   // success green
  failed:    '#ef4444',   // danger red
  pending:   '#52525b',   // dim gray
  collected: '#3b82f6',   // blue (queued)
} as const;

// -----------------------------------------------------------------------------
// Compile status → display label mapping (co-located with colors for easy reference)
// -----------------------------------------------------------------------------
export const COMPILE_STATUS_LABELS: Record<string, string> = {
  collected:   'Collected',
  pending:     'Pending',
  in_progress: 'Compiling',
  extracted:   'Extracted',
  compiled:    'Compiled',
  failed:      'Failed',
};
