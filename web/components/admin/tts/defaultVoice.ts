// Mirror the controller's default-voice fallback order for preview and correction tests.

export interface DefaultVoiceSource {
  kokoro?: { voice?: string };
  chatterbox?: { referenceVoice?: string };
  pocketTts?: { voice?: string };
  cloud?: { voice?: string };
}

// Piper resolves its voice inside the engine and `remote` carries none, so both
// answer '' — same as an engine we don't recognize.
export function defaultEngineVoice(engine: string, tts: DefaultVoiceSource): string {
  if (engine === 'kokoro') return tts.kokoro?.voice || '';
  if (engine === 'chatterbox') return tts.chatterbox?.referenceVoice || '';
  if (engine === 'pocket-tts') return tts.pocketTts?.voice || '';
  if (engine === 'cloud') return tts.cloud?.voice || '';
  return '';
}
