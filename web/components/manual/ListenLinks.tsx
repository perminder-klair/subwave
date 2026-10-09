'use client';

import { useEffect, useState } from 'react';
import CodeBlock from '@/components/CodeBlock';

// Resolve the browser origin after mount; the placeholder keeps SSR and hydration consistent.
export default function ListenLinks() {
  const [origin, setOrigin] = useState('https://your-station.example');

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  return (
    <>
      <CodeBlock>{`${origin}/api/listen.pls`}</CodeBlock>
      <CodeBlock>{`${origin}/api/listen.m3u`}</CodeBlock>
    </>
  );
}
