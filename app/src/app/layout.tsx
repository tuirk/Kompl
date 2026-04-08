import type { Metadata } from 'next';

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
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
