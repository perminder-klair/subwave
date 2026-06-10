// Runs `fn` immediately and then every `intervalMs`, pausing entirely while
// the tab is hidden and firing again the moment it returns to the foreground.
// Keeps background tabs from burning network/CPU on polls nobody can see.
// Returns a cleanup function.
export function pollWhileVisible(fn: () => void, intervalMs: number): () => void {
  let id: ReturnType<typeof setInterval> | null = null;
  const start = () => {
    if (id != null) return;
    fn();
    id = setInterval(fn, intervalMs);
  };
  const stop = () => {
    if (id != null) {
      clearInterval(id);
      id = null;
    }
  };
  const onVisibility = () => {
    if (document.hidden) stop();
    else start();
  };
  document.addEventListener('visibilitychange', onVisibility);
  if (!document.hidden) start();
  return () => {
    stop();
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
