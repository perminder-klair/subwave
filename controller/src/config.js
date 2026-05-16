// Centralised config — reads from env, with sensible defaults

export const config = {
  navidrome: {
    url: process.env.NAVIDROME_URL || 'http://navidrome:4533',
    user: process.env.NAVIDROME_USER || '',
    password: process.env.NAVIDROME_PASS || '',
    apiVersion: '1.16.1',
    clientName: 'sub-wave',
  },
  ollama: {
    url: process.env.OLLAMA_URL || 'http://localhost:11434',
    model: process.env.OLLAMA_MODEL || 'qwen2.5:7b',
  },
  piper: {
    binary: process.env.PIPER_BIN || '/usr/local/bin/piper',
    voice: process.env.PIPER_VOICE || '/opt/piper/voices/en_GB-alan-medium.onnx',
    voiceConfig: process.env.PIPER_VOICE_CONFIG || '/opt/piper/voices/en_GB-alan-medium.onnx.json',
    outDir: process.env.PIPER_OUT || '/var/sub-wave/voice',
  },
  kokoro: {
    python: process.env.KOKORO_PYTHON || '/opt/kokoro/venv/bin/python',
    workerScript: process.env.KOKORO_WORKER || '/app/scripts/kokoro_worker.py',
    model: process.env.KOKORO_MODEL || '/opt/kokoro/models/kokoro-v1.0.onnx',
    voices: process.env.KOKORO_VOICES || '/opt/kokoro/models/voices-v1.0.bin',
    voice: process.env.KOKORO_VOICE || 'bf_isabella',   // British female, BBC-ish
    lang: process.env.KOKORO_LANG || 'en-gb',
    speed: parseFloat(process.env.KOKORO_SPEED || '1.0'),
  },
  liquidsoap: {
    queueFile: '/var/sub-wave/next.txt',
    sayFile: '/var/sub-wave/say.txt',
    // Separate channel for talk-over voice (auto-links, anything that should
    // play OVER a track that's already started with light ducking instead of
    // heavy ducking the music to 25%). Read by a second poll thread in radio.liq.
    introFile: '/var/sub-wave/intro.txt',
    autoPlaylist: '/var/sub-wave/auto.m3u',
    nowPlayingFile: '/var/sub-wave/now-playing.json',
  },
  weather: {
    // Wolverhampton — your home location
    lat: 52.5862,
    lng: -2.1288,
    locationName: 'Wolverhampton',
  },
  news: {
    feedUrl: process.env.NEWS_FEED_URL || 'http://feeds.bbci.co.uk/news/rss.xml',
    maxItems: parseInt(process.env.NEWS_MAX_ITEMS || '10', 10),
  },
  search: {
    // Tavily API key for the web-search skill. Blank → the skill stays inert.
    apiKey: process.env.SEARCH_API_KEY || '',
  },
  server: {
    port: parseInt(process.env.PORT || '7701', 10),
  },
  show: {
    autoQueueRefreshMinutes: parseInt(process.env.AUTO_QUEUE_REFRESH_MINUTES || '60', 10),
  },
};
