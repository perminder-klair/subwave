import * as React from 'react';
import { EditorDialog, Label, Input, Textarea, Button } from 'sub-wave-web';

// NOTE (capture-harness limitation — see .design-sync/learnings/wave-overlays.md):
// EditorDialog's content fades in via a motion JS animation (opacity 0 → 1 over
// ~0.22s). On the single-story capture route it mounts a hair late and the
// screenshot fires before the fade settles, so it can shoot blank. This is NOT
// a preview-composition problem — the component renders perfectly given either a
// small post-settle wait or a `reducedMotion: 'reduce'` browser context (both
// proven). Sheet dodges it only because its content uses `initial={false}`.
// A preview cannot fix it: motion reads prefers-reduced-motion once, when
// `_ds_bundle.js` evaluates — before any `_preview/*.js` script runs — so a
// matchMedia override lands too late. Escalated to the orchestrator.

// Full-screen, edge-to-edge editor for shows / personas / skills. Header
// (title + sub + close), full-width scrollable body separated by hairline
// dividers, and a footer transport bar where ALL actions live. Uses m.* motion
// (MotionProvider auto-wraps). Render the OPEN state.

export const EditPersona = () => (
  <EditorDialog
    open
    onOpenChange={() => {}}
    title={
      <div className="eyebrow" style={{ letterSpacing: '0.3em', textTransform: 'uppercase', fontSize: 13 }}>
        Edit persona · Vera
      </div>
    }
    sub={<span style={{ fontSize: 11, letterSpacing: '0.15em', textTransform: 'uppercase', opacity: 0.6 }}>late-night host</span>}
    footer={
      <div style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <Button variant="destructive" size="sm">Delete persona</Button>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button size="sm">Cancel</Button>
          <Button variant="accent" size="sm">Save persona</Button>
        </div>
      </div>
    }
  >
    <div style={{ display: 'grid', gap: 20, maxWidth: 720 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div style={{ display: 'grid', gap: 6 }}>
          <Label>Name</Label>
          <Input defaultValue="Vera" />
        </div>
        <div style={{ display: 'grid', gap: 6 }}>
          <Label>Voice</Label>
          <Input defaultValue="kokoro · af_sky" />
        </div>
      </div>
      <div style={{ display: 'grid', gap: 6 }}>
        <Label>Soul</Label>
        <Textarea
          rows={5}
          defaultValue={
            'Warm, unhurried, a little conspiratorial. Speaks like the last friend awake at 3am — dry wit, no hard sell. Names the track, sets a scene, gets out of the way of the music.'
          }
        />
      </div>
      <div style={{ display: 'grid', gap: 6 }}>
        <Label>Narrative angles</Label>
        <Textarea
          rows={3}
          defaultValue={'Where you first heard it · a scene it soundtracks · one odd fact about the artist'}
        />
      </div>
    </div>
  </EditorDialog>
);
