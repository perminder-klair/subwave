import { isIOSDevice } from './platform';

/** iOS pause workaround (#1776). This clip is attached but NEVER played.
 *  The caller owns the URL and must revoke it after detaching its source. */
export function createPausedMediaUrl(audio: HTMLAudioElement): string | null {
  if (!isIOSDevice() || !('mediaSession' in navigator)) return null;
  if (!audio.canPlayType('audio/wav') || typeof URL.createObjectURL !== 'function') return null;

  try {
    // Half a second of mono 16-bit PCM silence at 8 kHz, including a WAV header.
    const samples = 4000;
    const bytes = new ArrayBuffer(44 + samples * 2);
    const view = new DataView(bytes);
    const text = (offset: number, value: string) => {
      for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
    };
    text(0, 'RIFF');
    view.setUint32(4, bytes.byteLength - 8, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 8000, true);
    view.setUint32(28, 16000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, samples * 2, true);
    return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
  } catch {
    // A browser without usable local media still disconnects on pause.
    return null;
  }
}
