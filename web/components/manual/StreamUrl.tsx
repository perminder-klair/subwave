'use client';

import { useEffect, useState } from 'react';
import CodeBlock from "@/components/CodeBlock";

// Resolve the browser origin after mount; the placeholder keeps SSR and hydration consistent.
export default function StreamUrl({ prefix = '' }) {
  const [url, setUrl] = useState('https://your-station.example/stream.mp3');

  useEffect(() => {
    setUrl(`${window.location.origin}/stream.mp3`);
  }, []);

  return <CodeBlock>{`${prefix}${url}`}</CodeBlock>;
}
