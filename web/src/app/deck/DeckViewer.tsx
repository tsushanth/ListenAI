'use client';

import { useEffect, useRef, useState } from 'react';

const W = 1920;
const H = 1080;

export default function DeckViewer({ slides }: { slides: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setScale(Math.min(1, (el.clientWidth - 32) / W));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={ref} style={{ maxWidth: 1200, margin: '0 auto', padding: '24px 16px', display: 'flex', flexDirection: 'column', gap: 24 }}>
      {slides.map((html, i) => (
        <div key={i} style={{ width: W * scale, height: H * scale, overflow: 'hidden', borderRadius: 12 * scale, boxShadow: '0 2px 16px rgba(11,17,32,0.18)' }}>
          <div className="deck-slide" style={{ width: W, height: H, transform: `scale(${scale})`, transformOrigin: 'top left' }} dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      ))}
    </div>
  );
}
