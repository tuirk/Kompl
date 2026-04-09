/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output produces a self-contained build suitable for Docker.
  // See https://nextjs.org/docs/app/api-reference/config/next-config-js/output
  output: 'standalone',

  // react-force-graph-2d (2D-only variant) and its dep chain are pure ESM.
  // Using the 2D-only package avoids the barrel react-force-graph which pulls
  // in 3d-force-graph → aframe-forcegraph-component → AFRAME at module eval time.
  // 3d-force-graph and three are NOT listed here — they are no longer deps.
  transpilePackages: [
    'react-force-graph-2d',
    'force-graph',
    'd3-force-3d',
    'kapsule',
    'lodash-es',
  ],

  // better-sqlite3 is a native Node addon; Next.js must not bundle it.
  // Moved from experimental.serverComponentsExternalPackages in Next.js 15+.
  serverExternalPackages: ['better-sqlite3'],
};

module.exports = nextConfig;
