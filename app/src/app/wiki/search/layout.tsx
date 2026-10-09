import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// The page itself is a client component, so its tab title lives here.
export const metadata: Metadata = { title: 'Search' };

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
