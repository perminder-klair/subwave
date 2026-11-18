import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createTempDir } from './test-utils/temp-dir.js';

const root = createTempDir(join(tmpdir(), 'subwave-jingle-import-'));
process.env.STATE_DIR = root;
delete process.env.TTS_HEAVY_URL;

const run = promisify(execFile);
const haveCodecs = ['ffmpeg', 'ffprobe'].every(
  (command) => spawnSync(command, ['-version'], { stdio: 'ignore' }).status === 0,
);
const codecSkip = haveCodecs ? false : 'ffmpeg and ffprobe are required';

async function syntheticWav(sampleRate: number, channels: number): Promise<Buffer> {
  const path = join(root, `input-${sampleRate}-${channels}.wav`);
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', `sine=frequency=440:sample_rate=${sampleRate}:duration=3`,
    '-ac', String(channels), '-c:a', 'pcm_s16le', '-y', path,
  ]);
  return readFile(path);
}

for (const sampleRate of [192_000, 48_000, 44_100]) {
  for (const channels of [1, 2]) {
    test(`jingle upload converts ${sampleRate} Hz ${channels}-channel WAV to mixer format`, {
      skip: codecSkip,
    }, async () => {
      // Config must read the temporary STATE_DIR before jingles imports TTS.
      const jingles = await import('../src/broadcast/jingles.js');
      const input = await syntheticWav(sampleRate, channels);
      const label = `${sampleRate} Hz ${channels}-channel test`;
      const imported = await jingles.importAudio(input, { label, originalName: 'test.wav' });
      const path = await jingles.getPath(imported.filename);
      assert.ok(path);

      const { stdout } = await run('ffprobe', [
        '-v', 'error', '-select_streams', 'a:0',
        '-show_entries', 'stream=codec_name,sample_rate,channels',
        '-of', 'default=noprint_wrappers=1', path,
      ]);
      assert.match(stdout, /^codec_name=pcm_s16le$/m);
      assert.match(stdout, /^sample_rate=44100$/m);
      assert.match(stdout, /^channels=2$/m);
      assert.equal(imported.text, label);
      assert.ok((await jingles.list()).some((jingle) => jingle.filename === imported.filename));
      const playlist = await readFile(join(root, 'jingles.m3u'), 'utf8');
      assert.ok(playlist.split('\n').includes(path));
    });
  }
}
