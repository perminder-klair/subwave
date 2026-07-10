import * as React from 'react';
import { Toaster, toast } from 'sub-wave-web';

// Sonner toaster — sharp ink-bordered cream cards (.v3-toast). `toast` is
// re-exported from the bundle, so it writes to the SAME sonner store the bundled
// <Toaster/> subscribes to (a direct 'sonner' import is a separate instance).
// The sized, transformed wrapper is deliberate: sonner's list is position:fixed,
// and a transformed ancestor becomes its containing block — without one the
// toasts anchor off-card and render invisible. The app fires bare toast(...) /
// toast.success(...) / toast.error(...) calls.

export const Notices = () => {
  React.useEffect(() => {
    toast.success('Settings saved — mixer restarting');
    toast.error('Navidrome unreachable — coasting on the last playlist');
    toast('Tuned out while you were away — tap to keep listening.');
  }, []);
  return (
    <div style={{ position: 'relative', height: 320, transform: 'translate(0, 0)', overflow: 'hidden' }}>
      <Toaster />
    </div>
  );
};
