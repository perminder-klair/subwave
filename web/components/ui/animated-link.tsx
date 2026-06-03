'use client';

import Link from 'next/link';
import React from 'react';

import { cn } from '@/lib/cn';

type AnimatedLinkVariant = 'underline' | 'arrow' | 'highlight';

export interface AnimatedLinkProps
  extends Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  href: string;
  children: React.ReactNode;
  /**
   * underline — sliding underline on hover (origin flips right→left).
   * arrow     — external-style underline + arrow that lifts in on hover.
   * highlight — block-fill sweep behind the text (mix-blend-difference).
   */
  variant?: AnimatedLinkVariant;
  className?: string;
}

/** Detect links that should leave the SPA / open externally. */
function isExternal(href: string): boolean {
  return /^(https?:|mailto:|tel:)/.test(href);
}

const ArrowGlyph = ({ className }: { className?: string }) => (
  <svg
    className={className}
    fill="none"
    viewBox="0 0 10 10"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <path
      d="M1.004 9.166 9.337.833m0 0v8.333m0-8.333H1.004"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const VARIANT_CLASSES: Record<AnimatedLinkVariant, string> = {
  underline: cn(
    'group relative inline-flex items-center',
    "before:pointer-events-none before:absolute before:bottom-0 before:left-0 before:h-[0.05em] before:w-full before:bg-current before:content-['']",
    'before:origin-right before:scale-x-0 before:transition-transform before:duration-300 before:ease-[cubic-bezier(0.4,0,0.2,1)]',
    'hover:before:origin-left hover:before:scale-x-100',
  ),
  arrow: cn(
    'group relative inline-flex items-center',
    "before:pointer-events-none before:absolute before:bottom-0 before:left-0 before:h-[0.05em] before:w-full before:bg-current before:content-['']",
    'before:origin-right before:scale-x-0 before:transition-transform before:duration-300 before:ease-[cubic-bezier(0.4,0,0.2,1)]',
    'hover:before:origin-left hover:before:scale-x-100',
  ),
  highlight: cn(
    'group relative inline-flex items-center px-1',
    "before:pointer-events-none before:absolute before:top-0 before:left-0 before:h-full before:w-full before:bg-current before:content-['']",
    'before:z-0 before:origin-left before:scale-x-0 before:mix-blend-difference before:transition-transform before:duration-300 before:ease-[cubic-bezier(0.4,0,0.2,1)]',
    'hover:before:scale-x-100',
  ),
};

/**
 * Animated text link. Renders a Next.js <Link> for internal routes and a plain
 * <a> (with safe rel) for external/mailto/tel targets, so client-side routing
 * still works where it should.
 *
 * Adapted from Skiper UI's Skiper40 (https://gxuri.in) — an inspired rebuild.
 */
export function AnimatedLink({
  href,
  children,
  variant = 'underline',
  className,
  ...rest
}: AnimatedLinkProps) {
  const external = isExternal(href);
  const showArrow = variant === 'arrow';

  const content = (
    <>
      <span className="relative z-10">{children}</span>
      {showArrow && (
        <ArrowGlyph className="relative z-10 ml-[0.3em] size-[0.55em] translate-y-1 opacity-0 transition-all duration-300 group-hover:translate-y-0 group-hover:opacity-100 motion-reduce:transition-none" />
      )}
    </>
  );

  const classes = cn(VARIANT_CLASSES[variant], className);

  if (external) {
    const isHttp = /^https?:/.test(href);
    return (
      <a
        href={href}
        className={classes}
        {...(isHttp ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
        {...rest}
      >
        {content}
      </a>
    );
  }

  return (
    <Link href={href} className={classes} {...rest}>
      {content}
    </Link>
  );
}

export default AnimatedLink;
