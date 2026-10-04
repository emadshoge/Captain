import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Nav } from '../components/nav';
import { SessionProvider } from '../components/session';
import './globals.css';

export const metadata: Metadata = {
  title: 'Captain Staff',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SessionProvider>
          <Nav />
          <main>{children}</main>
        </SessionProvider>
      </body>
    </html>
  );
}
