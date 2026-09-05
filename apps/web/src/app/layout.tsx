import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { Nav } from '@/components/Nav';

import './globals.css';

export const metadata: Metadata = {
  title: 'AICA',
  description: 'API Integration & Code Intelligence Agent',
  // A local tool. Nothing here should be indexed, previewed, or archived.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Nav />
        <main>{children}</main>
      </body>
    </html>
  );
}
