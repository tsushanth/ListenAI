import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'ReadAloud AI - Turn Any Text Into Natural Speech',
  description: 'Transform articles, PDFs, emails, and documents into natural-sounding audio. Listen to your content anywhere with AI-powered text-to-speech and voice cloning.',
  keywords: ['text to speech', 'TTS', 'audio articles', 'voice cloning', 'AI voice', 'read aloud', 'accessibility'],
  authors: [{ name: 'ReadAloud AI' }],
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
      { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
    ],
    apple: [
      { url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    ],
  },
  manifest: '/site.webmanifest',
  openGraph: {
    title: 'ReadAloud AI - Turn Any Text Into Natural Speech',
    description: 'Transform articles, PDFs, emails, and documents into natural-sounding audio.',
    url: 'https://readaloudai.org',
    siteName: 'ReadAloud AI',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'ReadAloud AI - Turn Any Text Into Natural Speech',
    description: 'Transform articles, PDFs, emails, and documents into natural-sounding audio.',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className={inter.className}>{children}</body>
    </html>
  )
}
