import type { Metadata } from 'next';
import { DECK_FONTS_HREF, DECK_SLIDES } from '@/lib/deck/slides';
import DeckViewer from './DeckViewer';

export const metadata: Metadata = {
  title: 'ReadAloud AI deck',
  robots: { index: false, follow: false },
};

// Public, link-only page for outreach emails.
export default function DeckPage() {
  return (
    <main style={{ background: '#E0E4EE', minHeight: '100vh' }}>
      <link rel="stylesheet" href={DECK_FONTS_HREF} />
      <style>{`.deck-slide > section{position:relative;width:1920px;height:1080px;box-sizing:border-box;overflow:hidden}`}</style>
      <DeckViewer slides={DECK_SLIDES} />
    </main>
  );
}
