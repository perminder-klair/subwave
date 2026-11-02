import type { FormState } from './shared';

// Reject blank numeric fields before saving: Number('') is zero, and JSON.stringify serializes NaN as null.
function numberFields() {
  const bad: Record<string, string> = {};
  const read = (path: string, raw: string, parse: (s: string) => number) => {
    const text = String(raw).trim();
    // Blank is checked before the parser, not by it: Number('') is a finite 0.
    const n = text ? parse(text) : NaN;
    if (Number.isFinite(n)) return n;
    bad[path] = 'enter a number';
    return 0;
  };
  return {
    bad,
    int: (path: string, raw: string) => read(path, raw, t => parseInt(t, 10)),
    float: (path: string, raw: string) => read(path, raw, t => parseFloat(t)),
    num: (path: string, raw: string) => read(path, raw, Number),
  };
}

export function archivesSavePayload(form: FormState) {
  const n = numberFields();
  const patch = {
    archive: {
      enabled: form.archive.enabled,
      bitrate: n.int('archive.bitrate', form.archive.bitrate),
      retentionDays: n.int('archive.retentionDays', form.archive.retentionDays),
    },
  };
  return { patch, fieldErrors: n.bad };
}

export function dangerSavePayload(form: FormState) {
  const n = numberFields();
  const patch = {
    crossfadeDuration: n.float('crossfadeDuration', form.crossfadeDuration),
    ducking: {
      voice: n.float('ducking.voice', form.ducking.voice),
      intro: n.float('ducking.intro', form.ducking.intro),
    },
    maxTrackLengthMode: form.maxTrackLengthMode,
    maxTrackSeconds: n.int('maxTrackSeconds', form.maxTrackSeconds),
    fadeAtShowEnd: form.fadeAtShowEnd,
    silenceTrim: {
      enabled: form.silenceTrim.enabled,
      minGapMs: n.int('silenceTrim.minGapMs', form.silenceTrim.minGapMs),
    },
    // The stem fields save from the Stems page (stemsSavePayload): posting
    // them here would commit an unsaved Stems edit under this button and mark
    // it clean.
    transitions: {
      equalPowerCrossfade: form.transitions.equalPowerCrossfade,
      effects: form.transitions.effects,
    },
    loudness: {
      targetLufs: n.float('loudness.targetLufs', form.loudness.targetLufs),
      maxBoostDb: n.float('loudness.maxBoostDb', form.loudness.maxBoostDb),
      source: form.loudness.source,
    },
    stream: {
      idleWhenEmpty: form.stream.idleWhenEmpty,
      idleAfterMinutes: n.int('stream.idleAfterMinutes', form.stream.idleAfterMinutes),
      opusEnabled: form.stream.opusEnabled,
      opusBitrate: n.int('stream.opusBitrate', form.stream.opusBitrate),
      flacEnabled: form.stream.flacEnabled,
      oggIcyMetadata: form.stream.oggIcyMetadata,
      aacEnabled: form.stream.aacEnabled,
      aacBitrate: n.int('stream.aacBitrate', form.stream.aacBitrate),
      bitrate: n.int('stream.bitrate', form.stream.bitrate),
      bufferSeconds: n.num('stream.bufferSeconds', form.stream.bufferSeconds),
      maxListeners: n.int('stream.maxListeners', form.stream.maxListeners),
      countryHeader: form.stream.countryHeader,
      geoipDbPath: form.stream.geoipDbPath,
    },
  };
  return { patch, fieldErrors: n.bad };
}

// The Stems page's save: only its own fields, so it neither commits nor marks
// clean an unsaved Broadcast & mixer edit (and that page's save doesn't post
// these). The form keeps the stem cache under `transitions`; it saves to `audio`.
export function stemsSavePayload(form: FormState) {
  const n = numberFields();
  const patch = {
    transitions: {
      pairDrain: form.transitions.pairDrain,
      stemBlends: form.transitions.stemBlends,
    },
    audio: {
      stemCache: form.transitions.stemCache,
      stemCacheGb: n.num('audio.stemCacheGb', form.transitions.stemCacheGb),
    },
  };
  return { patch, fieldErrors: n.bad };
}
