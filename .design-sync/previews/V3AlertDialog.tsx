import * as React from 'react';
import { V3AlertDialog } from 'sub-wave-web';

// Sharp ink-bordered confirmation modal. Controlled — render the OPEN state
// with a no-op onOpenChange. Mirrors ShowsPanel's delete/clear confirms.
// `danger` paints the confirm button red for destructive actions.

export const EndShow = () => (
  <V3AlertDialog
    open
    onOpenChange={() => {}}
    title="End this show?"
    description={
      <>
        Take <b>Midnight Drift</b> off air now? The auto-DJ picks up the next
        track and the schedule keeps rolling. Nothing is permanent until the
        next hour turns over.
      </>
    }
    confirmLabel="End show"
    cancelLabel="Keep airing"
    danger
    onConfirm={() => {}}
  />
);

export const RestartMixer = () => (
  <V3AlertDialog
    open
    onOpenChange={() => {}}
    title="Restart mixer"
    description={
      <>
        Reload Liquidsoap with the new encoder settings? Listeners hear a short
        gap while the stream reconnects — about 3 seconds.
      </>
    }
    confirmLabel="Restart"
    cancelLabel="Cancel"
    onConfirm={() => {}}
  />
);
