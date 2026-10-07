'use client';

// This script is part of the server HTML: it must work when client chunks never load.
const BOOT_GUARD = `(() => {
  const root = document.getElementById('admin-starting');
  setTimeout(() => {
    if (!root || !root.isConnected) return;
    const loading = root.querySelector('[data-admin-loading]');
    const error = root.querySelector('[data-admin-load-error]');
    if (loading) loading.hidden = true;
    if (error) error.hidden = false;
  }, 15000);
})()`;

export function AdminLoading({ href }: { href: string }) {
  return (
    <div id="admin-starting" className="admin-root paper flex min-h-screen items-center justify-center p-7">
      <span data-admin-loading suppressHydrationWarning className="caption">loading…</span>
      <div data-admin-load-error hidden suppressHydrationWarning className="grid max-w-md gap-3">
        <p role="alert" className="text-destructive">The admin console could not start.</p>
        <p>Startup did not finish. Check your connection and reload this page.</p>
        <a href={href} className="underline">Reload page</a>
      </div>
      <noscript>This console needs JavaScript. Enable it and reload this page.</noscript>
      <script dangerouslySetInnerHTML={{ __html: BOOT_GUARD }} />
    </div>
  );
}
