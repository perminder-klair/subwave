import { basename, dirname } from 'node:path';
import type { Response } from 'express';
import { audioContentType } from '../audio/audio-import.js';

// Call only with a path resolved by an imaging/voice library. A root keeps an
// operator's hidden parent directory (such as ~/.config) outside sendFile's
// dotfile check while retaining the check on the actual filename.
export function sendAudioFile(res: Response, filePath: string): void {
  res.type(audioContentType(filePath)).sendFile(basename(filePath), { root: dirname(filePath) });
}
