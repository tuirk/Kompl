import { Lexend } from 'next/font/google';

const lexend = Lexend({
  subsets: ['latin'],
  variable: '--font-wiki',
  display: 'swap',
});

export default function WikiLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div
      className={`${lexend.variable} wiki-lexend`}
      style={{ fontFamily: 'var(--font-wiki)' }}
    >
      {children}
    </div>
  );
}
