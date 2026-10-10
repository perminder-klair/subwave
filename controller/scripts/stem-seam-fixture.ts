// Offline render fixture using the same annotation writers as the queue drain.
import { getAnnotatedUri, getClipUri } from '../src/music/subsonic.js';
import { CLIP_SEAM_CROSS_SEC, clipSeamCues } from '../src/broadcast/stem-seam.js';

const [mode, station, blend, incoming] = process.argv.slice(2);
const stationSec = Number(station);
const render = { blendStartSec: Number(blend), inCueSec: Number(incoming) };
if (!['controller', 'verbatim'].includes(mode) || !Number.isFinite(stationSec)
  || !Number.isFinite(render.blendStartSec) || !Number.isFinite(render.inCueSec)) {
  throw new Error('Expected mode, station crossfade, worker blend start and worker cue-in');
}
const cues = mode === 'controller' ? clipSeamCues(render)
  : { outCueSec: render.blendStartSec, inCueSec: render.inCueSec };
const track = (title: string, path: string, crossSec: number) =>
  ({ id: title, title, artist: 'Seam fixture', path, crossSec });
const y = track('Y', 'y.flac', stationSec);
console.log(JSON.stringify({
  ...cues,
  crossSec: CLIP_SEAM_CROSS_SEC,
  libraryPath: process.env.MUSIC_LIBRARY_PATH,
  uris: [
    getAnnotatedUri(track('P', 'p.flac', stationSec)),
    getAnnotatedUri(track('X', 'x.flac', CLIP_SEAM_CROSS_SEC), { cueOutSec: cues.outCueSec }),
    getClipUri(y, `${process.env.MUSIC_LIBRARY_PATH}/clip.wav`, CLIP_SEAM_CROSS_SEC),
    getAnnotatedUri(y, { cueInSec: cues.inCueSec }),
  ],
}));
