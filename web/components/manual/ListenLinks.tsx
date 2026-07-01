'use client';

import { useEffect, useState } from 'react';
import CodeBlock from '@/components/CodeBlock';

// Renders the station's one-tap tune-in playlist links (.pls / .m3u) in
// copyable code blocks. Like StreamUrl, the origin is resolved from the live
// browser location after mount, so the guide always shows the address of
// whatever host it is being read on. The pre-mount placeholder matches the
// server render, so there is no hydration mismatch.
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
