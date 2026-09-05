import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { Nav } from '@/components/Nav';

import { Inter } from 'next/font/google';

import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });

export const metadata: Metadata = {
  title: 'AICA',
  description: 'API Integration & Code Intelligence Agent',
  // A local tool. Nothing here should be indexed, previewed, or archived.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        <div className="app-layout">
          <Nav />
          <main className="content">{children}</main>
        </div>
      </body>
    </html>
  );
}
