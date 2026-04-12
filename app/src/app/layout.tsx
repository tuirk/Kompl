import type { Metadata } from 'next';
import { Space_Grotesk, Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import TopNav from '@/components/TopNav';

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
        <TopNav />
        {children}
      </body>
    </html>
  );
}
