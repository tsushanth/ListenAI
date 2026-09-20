import type { Metadata } from 'next'
import { Inter, Bricolage_Grotesque, Instrument_Sans, JetBrains_Mono } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'] })
const display = Bricolage_Grotesque({ subsets: ['latin'], variable: '--font-display', display: 'swap' })
const body = Instrument_Sans({ subsets: ['latin'], variable: '--font-body', display: 'swap' })
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono', display: 'swap' })

export const metadata: Metadata = {
  title: 'ReadAloud AI - Realtime text-to-speech API',
  description: 'A streaming text-to-speech API for voice agents and apps: about 170 ms to first audio, from $4 per million characters. Also available as the ReadAloud AI reader for Android and web.',
  keywords: ['text to speech API', 'realtime TTS', 'voice agent', 'streaming TTS', 'text to speech', 'TTS', 'audio articles', 'voice cloning', 'AI voice', 'read aloud', 'accessibility'],
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
    title: 'ReadAloud AI - Realtime text-to-speech API',
    description: 'Streaming text-to-speech for voice agents and apps. About 170 ms to first audio, from $4 per million characters.',
    url: 'https://readaloudai.org',
    siteName: 'ReadAloud AI',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'ReadAloud AI - Realtime text-to-speech API',
    description: 'Streaming text-to-speech for voice agents and apps. About 170 ms to first audio, from $4 per million characters.',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className={`${inter.className} ${display.variable} ${body.variable} ${mono.variable}`}>{children}</body>
    </html>
  )
}
