/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output produces a self-contained build suitable for Docker.
  // See https://nextjs.org/docs/app/api-reference/config/next-config-js/output
  output: 'standalone',

  // better-sqlite3 is a native Node addon; Next.js must not try to bundle
  // it into the serverless runtime.
  experimental: {
    serverComponentsExternalPackages: ['better-sqlite3'],
  },
};

module.exports = nextConfig;
