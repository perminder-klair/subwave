// MPEG Layer III frame headers: enough to tell real mp3 audio from junk and to
// measure a clip without decoding it. Layer III only; that is what the cloud
// TTS providers that send mp3 produce.

export type Mp3Frame = { length: number; seconds: number };

// The frame whose 4-byte header starts at `offset`, or null when those bytes
// are not a usable Layer III header.
export function mpegLayer3Frame(header: Buffer, offset: number): Mp3Frame | null {
  if (offset + 4 > header.length) return null;
  const b0 = header[offset];
  const b1 = header[offset + 1];
  const b2 = header[offset + 2];
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const versionBits = (b1 >> 3) & 0x03;
  const layerBits = (b1 >> 1) & 0x03;
  const bitrateIndex = (b2 >> 4) & 0x0f;
  const sampleRateIndex = (b2 >> 2) & 0x03;
  const padding = (b2 >> 1) & 0x01;
  // Reserved MPEG version/layer/sample-rate values and free/bad bitrates are
  // not sufficient evidence of playable MP3 data.
  if (versionBits === 1 || layerBits !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) {
    return null;
  }
  const mpeg1 = versionBits === 3;
  const bitrateKbps = (mpeg1
    ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
    : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160])[bitrateIndex];
  const sampleRates = versionBits === 3
    ? [44100, 48000, 32000]
    : versionBits === 2
      ? [22050, 24000, 16000]
      : [11025, 12000, 8000];
  const sampleRate = sampleRates[sampleRateIndex];
  return {
    length: Math.floor(((mpeg1 ? 144 : 72) * bitrateKbps * 1000) / sampleRate) + padding,
    seconds: (mpeg1 ? 1152 : 576) / sampleRate,
  };
}

export function mpegLayer3FrameLength(header: Buffer, offset: number): number | null {
  return mpegLayer3Frame(header, offset)?.length ?? null;
}

// Where the audio starts: past an ID3v2 tag when there is one.
export function mp3FrameOffset(probe: Buffer): number | null {
  if (probe.length >= 3 && probe.subarray(0, 3).toString('ascii') === 'ID3') {
    if (probe.length < 10) return null;
    const sizeBytes = probe.subarray(6, 10);
    if ([...sizeBytes].some(v => (v & 0x80) !== 0)) return null;
    const tagSize = ((sizeBytes[0] << 21) | (sizeBytes[1] << 14) | (sizeBytes[2] << 7) | sizeBytes[3]) >>> 0;
    const footerSize = probe[3] === 4 && (probe[5] & 0x10) !== 0 ? 10 : 0;
    return 10 + tagSize + footerSize;
  }
  return 0;
}
