import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { AuthProvider } from '@/components/auth-provider';
import './globals.css';

const inter = Inter({ subsets: ['latin'], display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'ClipBR AI', template: '%s · ClipBR AI' },
  description: 'Crie cortes curtos de alto impacto com inteligência artificial.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="pt-BR"><body className={inter.className}><AuthProvider>{children}</AuthProvider></body></html>;
}
