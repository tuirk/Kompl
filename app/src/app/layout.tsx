import type { Metadata } from 'next';
import { Suspense } from 'react';
import { Space_Grotesk, Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import TopNav from '@/components/TopNav';
import WhatsNext from '@/components/WhatsNext';

// Obsidian Kinetic — font loading via next/font (zero layout shift, self-hosted)
const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-heading',  // headers, primary UI labels
  display: 'swap',
});

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-body',     // body text, markdown content
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',     // timestamps, IDs, paths
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Kompl',
  description: 'Stop saving. Start compiling.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${spaceGrotesk.variable} ${inter.variable} ${jetbrainsMono.variable}`}>
      <body style={{ paddingTop: 65 }}>
        <Suspense fallback={null}>
          <TopNav />
        </Suspense>
        {children}
        <footer style={{
          position: 'fixed',
          bottom: 0,
          right: 0,
          left: 0,
          height: 32,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingLeft: 4,
          paddingRight: 20,
          gap: 6,
          background: 'var(--bg)',
          borderTop: '1px solid var(--border)',
          zIndex: 50,
        }}>
          <WhatsNext />
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: 14 }}>🥞</span>
            <span style={{
              fontFamily: 'var(--font-heading)',
              fontSize: 12,
              color: 'var(--accent)',
              letterSpacing: '0.04em',
            }}>
              Tuirk &amp; Ahjinsolo
            </span>
          </span>
        </footer>
      </body>
    </html>
  );
}
