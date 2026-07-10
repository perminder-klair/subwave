// design-sync shim: next/link resolves here in the DS bundle (see
// tsconfig.dsync.json paths). Designs built in claude.ai/design render
// outside a Next.js runtime, where the real next/link throws on the missing
// app-router context. A plain anchor keeps AnimatedLink's real source
// (hover/underline effects are pure CSS) working everywhere.
import * as React from 'react';

type LinkProps = React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string | { pathname?: string };
  prefetch?: boolean;
  replace?: boolean;
  scroll?: boolean;
  shallow?: boolean;
  locale?: string | false;
  legacyBehavior?: boolean;
};

const Link = React.forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  { href, prefetch, replace, scroll, shallow, locale, legacyBehavior, children, ...rest },
  ref,
) {
  const resolved = typeof href === 'string' ? href : (href?.pathname ?? '#');
  return (
    <a ref={ref} href={resolved} {...rest}>
      {children}
    </a>
  );
});

export default Link;
