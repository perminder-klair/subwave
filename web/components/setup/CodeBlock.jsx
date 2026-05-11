'use client';

import { useState } from 'react';

export default function CodeBlock({ children, lang }) {
  const [copied, setCopied] = useState(false);
  const text = String(children).trim();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {}
  };

  return (
    <pre className="bs-code" data-lang={lang || 'sh'}>
      <button
        type="button"
        className="bs-copy"
        data-copied={copied ? 'true' : 'false'}
        onClick={copy}
        aria-label="Copy to clipboard"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <code>{text}</code>
    </pre>
  );
}
