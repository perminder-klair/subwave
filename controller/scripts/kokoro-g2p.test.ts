// Regression coverage for native CJK Kokoro speech (#1437).
//
// The worker used to feed every advertised language through EspeakG2P. That
// can map kana, but it cannot resolve context-dependent kanji readings and
// falls back to spoken character descriptions. The dispatch itself is pure;
// exercise it with tiny constructor doubles so this contributor test needs no
// Kokoro model or Python TTS environment. Docker build smoke checks exercise
// the real Misaki Japanese and Chinese implementations.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const worker = fileURLToPath(new URL('./kokoro_worker.py', import.meta.url));
const probe = String.raw`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("kokoro_worker", sys.argv[1])
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

class Espeak:
    class EspeakG2P:
        def __init__(self, language):
            self.kind = f"espeak:{language}"

class Japanese:
    class JAG2P:
        def __init__(self, version):
            assert version == "pyopenjtalk"
            self.kind = "japanese"

        def __call__(self, text):
            return "kanajjjj", []

class Chinese:
    class ZHG2P:
        def __init__(self):
            self.kind = "chinese"

japanese = worker.build_g2p("ja", Espeak, Japanese, Chinese)
phonemes, _ = japanese("仮名")
assert phonemes == "kana"
assert worker.build_g2p("cmn", Espeak, Japanese, Chinese).kind == "chinese"
assert worker.build_g2p("en-gb", Espeak, Japanese, Chinese).kind == "espeak:en-gb"
`;

const out = spawnSync('python3', ['-c', probe, worker], { encoding: 'utf8' });
assert.equal(out.status, 0, out.stderr || out.stdout);

console.log('kokoro-g2p: native CJK dispatch passed');
