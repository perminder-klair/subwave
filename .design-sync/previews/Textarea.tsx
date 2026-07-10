import * as React from 'react';
import { Textarea, Label } from 'sub-wave-web';

// Multi-line newsprint field, resize-y, 60px min. Mirrors the DJ system-prompt
// and skill-brief editors in admin SettingsPanel / SystemPromptModal.
export const Default = () => (
  <div style={{ maxWidth: 440 }}>
    <Textarea
      rows={4}
      defaultValue={
        'You are {name}, the late-night voice of SUB/WAVE. Keep links under ' +
        'twenty words, never read the whole tracklist, and let the music breathe.'
      }
    />
  </div>
);

export const WithLabel = () => (
  <div style={{ maxWidth: 440, display: 'grid', gap: 6 }}>
    <Label htmlFor="soul">DJ soul</Label>
    <Textarea
      id="soul"
      rows={3}
      defaultValue={
        'Dry, unhurried, a little conspiratorial — like a friend passing you a mix tape.'
      }
    />
  </div>
);

export const Placeholder = () => (
  <div style={{ maxWidth: 440, display: 'grid', gap: 6 }}>
    <Label htmlFor="news-brief">News segment brief</Label>
    <Textarea
      id="news-brief"
      rows={3}
      placeholder="Describe how the DJ should read the headlines…"
    />
  </div>
);

export const Disabled = () => (
  <div style={{ maxWidth: 440, display: 'grid', gap: 6 }}>
    <Label htmlFor="baked-prompt">Base prompt · read only</Label>
    <Textarea
      id="baked-prompt"
      rows={3}
      disabled
      defaultValue={'Station identity is baked from the operator template and cannot be edited here.'}
    />
  </div>
);
