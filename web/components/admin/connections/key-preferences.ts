'use client';

import { useCallback, useEffect, useState, type SetStateAction } from 'react';
import { ALL_EDGE_TYPES } from './filters';
import type { ConnectionEdgeType } from './types';

type KeySettings = {
  edgeTypes: ConnectionEdgeType[];
  includeExternal: boolean;
  includeUnresearchedArtists: boolean;
  pathLimit: number;
  layoutFolded: boolean;
  controlsFolded: boolean;
  keyFolded: boolean;
};
const DEFAULTS: KeySettings = {
  edgeTypes: ALL_EDGE_TYPES, includeExternal: true, includeUnresearchedArtists: true, pathLimit: 2400,
  layoutFolded: false, controlsFolded: false, keyFolded: false,
};
function validSetting<K extends keyof KeySettings>(name: K, value: unknown): value is KeySettings[K] {
  if (name === 'edgeTypes') return Array.isArray(value) && value.every(type => ALL_EDGE_TYPES.includes(type));
  if (name === 'pathLimit') return Number.isSafeInteger(value) && (value as number) >= 1;
  return typeof value === 'boolean';
}

// Read after mount so the server and first client render agree. Write only on
// user changes: mounting another layer must not overwrite a saved preference.
export function useBrainKeySetting<K extends keyof KeySettings>(name: K): [KeySettings[K], (next: SetStateAction<KeySettings[K]>) => void] {
  const [value, setValue] = useState(DEFAULTS[name]);
  const key = `subwave-station-brain-key:${name}`;
  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(window.localStorage.getItem(key) ?? 'null');
      if (validSetting(name, saved)) setValue(saved);
    } catch { /* Storage may be blocked or contain an old/malformed value. */ }
  }, [key, name]);
  const update = useCallback((next: SetStateAction<KeySettings[K]>) => {
    const resolved = typeof next === 'function' ? next(value) : next;
    setValue(resolved);
    try { window.localStorage.setItem(key, JSON.stringify(resolved)); }
    catch { /* Keep controls usable when browser storage is unavailable. */ }
  }, [key, value]);
  return [value, update];
}
