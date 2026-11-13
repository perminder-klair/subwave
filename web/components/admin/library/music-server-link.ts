// The Music server tile opens the server's own web UI, at the address saved in
// Settings → Navidrome. Only an absolute http(s) URL becomes a link: anything
// else (blank, a typo, another scheme) leaves the tile unlinked. The credentials
// in the address, if an operator typed them into it, never reach the link.
// An address only the controller can reach (a compose service name) still links:
// the browser fails to open it, which says the same as the Doctor would.
export function musicServerLink(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || url.trim() === '') return null;
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.username = '';
  u.password = '';
  u.search = '';
  u.hash = '';
  return u.toString();
}
