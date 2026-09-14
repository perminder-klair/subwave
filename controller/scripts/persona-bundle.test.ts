// Persona bundles (#1620) — export a DJ as one zip, import it on another
// station and have it actually speak.
//
// Six properties carry the feature, and each is a way it can silently be
// wrong rather than visibly broken:
//
//  - A cloned voice must TRAVEL. chatterbox/pocket-tts read `tts.voice` as a
//    filename in the shared voice folder, so a bundle that carried only the
//    JSON would import a persona that fails its synth on every line — the
//    whole reason the issue exists.
//  - A collision is SUFFIXED, never an overwrite. The filename IS the handle
//    every persona has on a reference WAV, so writing over `nova.wav` would
//    swap the voice of whoever already pointed at it. The incoming persona
//    then has to be re-pointed at the name it actually got, or the suffix is
//    just an orphan.
//  - "A jingle naming this persona" is decided on a WORD boundary. Nothing on
//    disk links a jingle to a DJ; the sidecar carries only spoken text, so a
//    plain substring test hands every stinger to a persona called "Al".
//  - There is ONE create path. A bundle import and a community install both
//    go through personas/install.ts, so the roster cap and the duplicate-name
//    refusal cannot disagree between them.
//  - An adopted filename is pinned to a CHARACTER CLASS. A jingle filename
//    becomes a LINE of jingles.m3u, which Liquidsoap reloads on watch, so a
//    newline inside one adds a rotation entry nobody chose. A bundle is a file
//    from another operator; an extension test is not a filename check.
//  - A REFUSED import writes NOTHING — and "nothing" has to be checked against
//    the jingle dir, jingles.json and jingles.m3u, not just state/voices/.
//    A stray jingle is not litter, it is audio on air, so the earlier
//    voices-only assertion is precisely the gap that let a half-write through.
//
// STATE_DIR is redirected at a throwaway dir BEFORE the first import so
// config.ts derives its voice/jingle dirs there — hence the dynamic imports.
// Same style as scripts/voice-library.test.ts.
//
// Run: `npm test -- persona-bundle`.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-persona-bundle-'));
process.env.STATE_DIR = root;
// These would move the voice folder out from under the test.
delete process.env.TTS_VOICE_DIR;
delete process.env.CHATTERBOX_VOICE_DIR;
// chatterbox.ts starts a 30s /health probe loop at module load when this is
// set — it would hold the test process open forever.
delete process.env.TTS_HEAVY_URL;

const VOICES = join(root, 'voices');
const JINGLES = join(root, 'jingles');
mkdirSync(VOICES, { recursive: true });
mkdirSync(JINGLES, { recursive: true });

const NOVA_WAV = Buffer.from('the original nova reference clip');
writeFileSync(join(VOICES, 'nova.wav'), NOVA_WAV);

const NOVA_JINGLE = Buffer.from('nova stinger bytes');
writeFileSync(join(JINGLES, 'jingle_nova.wav'), NOVA_JINGLE);
writeFileSync(join(JINGLES, 'jingle_quinn.wav'), 'quinn stinger bytes');
writeFileSync(join(JINGLES, 'station_ident_default.wav'), 'builtin ident bytes');
writeFileSync(join(root, 'jingles.json'), JSON.stringify({
  items: {
    'jingle_nova.wav': { text: 'Nova Reyes, weeknights on SUB/WAVE.', createdAt: '2026-01-01T00:00:00Z' },
    'jingle_quinn.wav': { text: 'Quinn holds the late shift.', createdAt: '2026-01-01T00:00:00Z' },
    // Builtin, and it names her — station furniture must still never travel.
    'station_ident_default.wav': { text: 'Nova Reyes is on SUB/WAVE.', builtin: true, source: 'builtin' },
  },
}));

const CHATTERBOX_TTS = {
  engine: 'chatterbox', cloudProvider: 'openai', voice: 'nova.wav', gainDb: 0, speed: 1,
};
writeFileSync(join(root, 'settings.json'), JSON.stringify({
  activePersonaId: 'p_nova',
  personas: [
    {
      id: 'p_nova',
      name: 'Nova Reyes',
      tagline: 'after midnight',
      soul: 'Speaks slowly, never fills a silence she does not have to.',
      frequency: 'moderate',
      avatar: 'p_nova.png',
      tts: CHATTERBOX_TTS,
    },
    {
      id: 'p_quinn',
      name: 'Quinn',
      tagline: '',
      soul: 'Brisk, factual, allergic to a metaphor.',
      frequency: 'quiet',
      tts: { engine: 'piper', cloudProvider: 'openai', voice: 'bf_isabella', gainDb: 0, speed: 1 },
    },
  ],
}));

const AdmZip = (await import('adm-zip')).default;
const pure = await import('../src/personas/bundle-pure.js');
const settings = await import('../src/settings.js');
const { setCache } = await import('../src/settings/store.js');
const { buildPersonaBundle, applyPersonaBundle } = await import('../src/personas/bundle.js');

// ── The pure decisions ───────────────────────────────────────────────────────

test('uniqueFilename suffixes rather than overwrites, case-insensitively', () => {
  assert.equal(pure.uniqueFilename('nova.wav', []), 'nova.wav');
  assert.equal(pure.uniqueFilename('nova.wav', ['nova.wav']), 'nova-2.wav');
  assert.equal(pure.uniqueFilename('nova.wav', ['nova.wav', 'nova-2.wav']), 'nova-3.wav');
  // macOS and every Docker Desktop bind mount on it fold case, so a
  // case-SENSITIVE check would hand back a name that overwrites on write.
  assert.equal(pure.uniqueFilename('Nova.wav', ['nova.wav']), 'Nova-2.wav');
  // The stem is trimmed, never the suffix — the result must stay inside
  // TTS_CHATTERBOX_VOICE_RE's 80-char cap or the save that follows refuses it.
  const long = `${'n'.repeat(78)}.wav`;
  const got = pure.uniqueFilename(long, [long.slice(0, 76) + '.wav']);
  assert.ok(got.length <= pure.VOICE_NAME_MAX, `"${got}" is ${got.length} chars`);
  assert.ok(got.endsWith('.wav'));
});

test('a jingle names a persona on a WORD boundary, and builtins never travel', () => {
  const rows = [
    { filename: 'a.wav', text: 'Nova Reyes, weeknights.' },
    { filename: 'b.wav', text: 'Quinn holds the late shift.' },
    { filename: 'c.wav', text: 'Innovation radio, all night.' }, // contains "nova"
    { filename: 'd.wav', text: 'Nova Reyes is on air.', builtin: true },
  ];
  const got = pure.jinglesNamingPersona(rows, 'Nova Reyes').map(j => j.filename);
  assert.deepEqual(got, ['a.wav']);

  // The short-name case a substring test gets wrong.
  assert.equal(pure.textNamesPersona('Alan takes the desk', 'Al'), false);
  assert.equal(pure.textNamesPersona('Al takes the desk', 'Al'), true);
  // A name full of regex metacharacters is matched, not blown up.
  assert.equal(pure.textNamesPersona('now: R.E.M. hour with dj (k)', 'DJ (K)'), true);
  // One character is evidence of nothing.
  assert.equal(pure.textNamesPersona('a b c', 'a'), false);
});

test('only a clone engine names a reference WAV', () => {
  assert.equal(pure.personaCloneVoice({ engine: 'chatterbox', voice: 'nova.wav' }), 'nova.wav');
  assert.equal(pure.personaCloneVoice({ engine: 'pocket-tts', voice: 'nova.wav' }), 'nova.wav');
  // A pocket-tts built-in id is not a file.
  assert.equal(pure.personaCloneVoice({ engine: 'pocket-tts', voice: 'alba' }), null);
  // Piper's voice is an .onnx in the same folder, but it is not a clone sample.
  assert.equal(pure.personaCloneVoice({ engine: 'piper', voice: 'en_GB-alan.onnx' }), null);
  // An inherit slot has no voice of its own — the station's is not this
  // persona's to export.
  assert.equal(pure.personaCloneVoice({ engine: 'inherit', voice: 'nova.wav' }), null);
});

test('bundle members must sit one level inside a known folder', () => {
  assert.equal(pure.bundleMemberName('voices/nova.wav', 'voices'), 'nova.wav');
  assert.equal(pure.bundleMemberName('voices/deep/nova.wav', 'voices'), null);
  assert.equal(pure.bundleMemberName('jingles/a.wav', 'voices'), null);
  assert.equal(pure.isSafeBundleEntry('voices/../../etc/passwd'), false);
  assert.equal(pure.isSafeBundleEntry('/etc/passwd'), false);
  assert.equal(pure.bundleFilename('Nova Reyes'), 'subwave-persona-nova-reyes.zip');
  assert.equal(pure.bundleFilename('  ***  '), 'subwave-persona-dj.zip');
});

// ── Export ───────────────────────────────────────────────────────────────────

let exported: Buffer;

test('the export carries the JSON, the clone sample and only this DJ jingles', async () => {
  const built = await buildPersonaBundle('p_nova');
  assert.equal(built.ok, true, (built as any).error);
  exported = (built as any).zip.toBuffer();

  const zip = new AdmZip(exported);
  const names = zip.getEntries().map(e => e.entryName).sort();
  assert.deepEqual(names, [
    'jingles/jingle_nova.wav', 'manifest.json', 'persona.json', 'voices/nova.wav',
  ], 'Quinn jingle and the builtin ident must both stay home');

  const manifest = JSON.parse(zip.getEntry('manifest.json')!.getData().toString('utf8'));
  assert.equal(manifest.format, 'subwave-persona');
  assert.equal(manifest.version, 1);
  assert.equal(manifest.voice, 'nova.wav');
  assert.deepEqual(manifest.jingles.map((j: any) => j.file), ['jingle_nova.wav']);
  // Listed before the manifest was added, so it never names itself.
  assert.equal(manifest.contents.includes('manifest.json'), false);

  // The sample is the real bytes, not a placeholder.
  assert.deepEqual(zip.getEntry('voices/nova.wav')!.getData(), NOVA_WAV);

  const persona = JSON.parse(zip.getEntry('persona.json')!.getData().toString('utf8'));
  assert.equal(persona.name, 'Nova Reyes');
  assert.equal(persona.tts.voice, 'nova.wav');
  // Station-local: the receiving station mints its own id, and an avatar file
  // is keyed on the id this bundle is dropping.
  assert.equal('id' in persona, false);
  assert.equal('avatar' in persona, false);
});

test('an unknown persona exports nothing rather than an empty zip', async () => {
  const built = await buildPersonaBundle('p_nobody');
  assert.equal(built.ok, false);
  assert.equal((built as any).status, 404);
});

test('a persona whose clone sample is GONE is refused, not shipped mute', async () => {
  // The bundle would be well-formed — manifest.voice null beside a persona JSON
  // still naming the file — and would import 200 into a DJ that fails its synth
  // on every line. This is the only end of the wire that can still fix it.
  const settingsPath = join(root, 'settings.json');
  const before = readFileSync(settingsPath, 'utf8');
  const cfg = JSON.parse(before);
  cfg.personas.push({
    id: 'p_ghost',
    name: 'Ghost',
    tagline: '',
    soul: 'Clones from a sample this station lost.',
    frequency: 'quiet',
    tts: { engine: 'chatterbox', cloudProvider: 'openai', voice: 'not-here.wav', gainDb: 0, speed: 1 },
  });
  writeFileSync(settingsPath, JSON.stringify(cfg));
  setCache(null);

  const built = await buildPersonaBundle('p_ghost');
  assert.equal(built.ok, false);
  assert.equal((built as any).status, 409);
  assert.match((built as any).error, /not in the voice library/);

  writeFileSync(settingsPath, before);
  setCache(null);
  await settings.load();
});

// ── Import ───────────────────────────────────────────────────────────────────

test('re-importing the same DJ is refused by the SHARED duplicate-name rule', async () => {
  const outcome = await applyPersonaBundle(exported);
  assert.equal(outcome.ok, false);
  assert.equal((outcome as any).status, 409);
  assert.match((outcome as any).error, /already in the roster/);
  // Refused BEFORE any audio landed — a refused import must not litter the
  // state dirs with files the operator cannot see.
  assert.deepEqual(readdirSync(VOICES).sort(), ['nova.wav']);
});

test('a station backup is named as such rather than refused generically', async () => {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({ format: 'subwave-backup', version: 1 })));
  const outcome = await applyPersonaBundle(zip.toBuffer());
  assert.equal(outcome.ok, false);
  assert.match((outcome as any).error, /station backup/);
});

test('an import suffixes the clashing audio and re-points the persona at it', async () => {
  // Same bundle, renamed so it clears the duplicate-name rule — which is the
  // real sharing case: the DJ lands on a station that already has a nova.wav.
  const zip = new AdmZip(exported);
  const persona = JSON.parse(zip.getEntry('persona.json')!.getData().toString('utf8'));
  persona.name = 'Nova Reyes (guest)';
  zip.deleteFile('persona.json');
  zip.addFile('persona.json', Buffer.from(JSON.stringify(persona)));

  const outcome = await applyPersonaBundle(zip.toBuffer());
  assert.equal(outcome.ok, true, (outcome as any).error);
  const ok = outcome as Extract<typeof outcome, { ok: true }>;

  // The sample landed beside the original, and the original is untouched.
  assert.equal(ok.voice, 'nova-2.wav');
  assert.deepEqual(readdirSync(VOICES).sort(), ['nova-2.wav', 'nova.wav']);
  assert.deepEqual(readFileSync(join(VOICES, 'nova.wav')), NOVA_WAV);
  assert.deepEqual(readFileSync(join(VOICES, 'nova-2.wav')), NOVA_WAV);

  // ...and the incoming persona points at the name it ACTUALLY got. Without
  // this the suffix is just an orphan and the DJ is mute.
  assert.equal(ok.persona.tts.voice, 'nova-2.wav');
  assert.equal(ok.persona.tts.engine, 'chatterbox');

  // Off air with a minted id and no avatar, like a community install.
  assert.equal(ok.persona.name, 'Nova Reyes (guest)');
  assert.notEqual(ok.persona.id, 'p_nova');
  assert.match(ok.persona.id, /^p_/);
  assert.equal(ok.persona.avatar, '');
  assert.equal(settings.get().activePersonaId, 'p_nova');
  assert.equal(ok.personas.length, 3);

  // The jingle too: suffixed, registered in the sidecar, and in the playlist
  // Liquidsoap watches.
  assert.deepEqual(ok.jingles, ['jingle_nova-2.wav']);
  assert.deepEqual(readFileSync(join(JINGLES, 'jingle_nova.wav')), NOVA_JINGLE);
  assert.deepEqual(readFileSync(join(JINGLES, 'jingle_nova-2.wav')), NOVA_JINGLE);
  const sidecar = JSON.parse(readFileSync(join(root, 'jingles.json'), 'utf8'));
  assert.equal(sidecar.items['jingle_nova-2.wav'].text, 'Nova Reyes, weeknights on SUB/WAVE.');
  assert.equal(sidecar.items['jingle_nova-2.wav'].builtin, false);
  const m3u = readFileSync(join(root, 'jingles.m3u'), 'utf8');
  assert.ok(m3u.includes('jingle_nova-2.wav'));
  assert.ok(m3u.includes('jingle_nova.wav'));
});

test('a persona.json the schema refuses is a 400, not a half-written import', async () => {
  const zip = new AdmZip(exported);
  zip.deleteFile('persona.json');
  zip.addFile('persona.json', Buffer.from(JSON.stringify({ name: 'No Soul', frequency: 'moderate' })));
  const before = readdirSync(VOICES).sort();
  const outcome = await applyPersonaBundle(zip.toBuffer());
  assert.equal(outcome.ok, false);
  assert.equal((outcome as any).status, 400);
  assert.match((outcome as any).error, /not a valid persona/);
  assert.deepEqual(readdirSync(VOICES).sort(), before);
});

test('a member outside the bundle folders is ignored, not fatal', async () => {
  // Forward compatibility: a bundle from a later station may carry a member
  // this build has never heard of, and dropping it is the same posture the
  // persona schema takes to an unknown field.
  //
  // The traversal guard itself (isSafeBundleEntry) is pinned in the pure block
  // above rather than here, because adm-zip NORMALISES '..' out of an entry
  // name as it writes — a traversing archive cannot be built with it, only
  // received.
  const zip = new AdmZip(exported);
  zip.addFile('extras/notes.txt', Buffer.from('hello from another version'));
  const persona = JSON.parse(zip.getEntry('persona.json')!.getData().toString('utf8'));
  persona.name = 'Nova Reyes (extras)';
  zip.deleteFile('persona.json');
  zip.addFile('persona.json', Buffer.from(JSON.stringify(persona)));

  const outcome = await applyPersonaBundle(zip.toBuffer());
  assert.equal(outcome.ok, true, (outcome as any).error);
  assert.equal(readdirSync(root).includes('extras'), false, 'an unknown member must not be written');
});

// ── Nothing is written behind a refusal ──────────────────────────────────────

/** Every state file the import can touch, as one comparable snapshot. */
function stateSnapshot() {
  const read = (p: string) => {
    try { return readFileSync(p, 'utf8'); } catch { return null; }
  };
  return JSON.stringify({
    voices: readdirSync(VOICES).sort(),
    jingles: readdirSync(JINGLES).sort(),
    sidecar: read(join(root, 'jingles.json')),
    m3u: read(join(root, 'jingles.m3u')),
    personas: (settings.get().personas || []).map((p: any) => p.name),
  });
}

/** A bundle built from parts, so a test can hand-shape a member name. */
function bundleOf(
  persona: Record<string, unknown>,
  members: [string, Buffer][] = [],
  manifestJingles: unknown[] = [],
) {
  const zip = new AdmZip();
  zip.addFile('persona.json', Buffer.from(JSON.stringify({
    tagline: '',
    soul: 'A soul long enough to clear the schema floor comfortably.',
    frequency: 'moderate',
    tts: { engine: 'piper', cloudProvider: 'openai', voice: 'bf_isabella', gainDb: 0, speed: 1 },
    ...persona,
  })));
  for (const [name, data] of members) zip.addFile(name, data);
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    format: 'subwave-persona', version: 1, voice: null, jingles: manifestJingles,
  })));
  return zip.toBuffer();
}

test('a NEWLINE in a jingle member name is refused and writes nothing', async () => {
  // rewritePlaylist joins DIR + filename with '\n', and Liquidsoap reloads
  // jingles.m3u on watch — so a name carrying its own newline used to append a
  // second, attacker-chosen line to the station's rotation. The bundle is a
  // file the operator was handed by someone else; this is untrusted input.
  const before = stateSnapshot();
  const outcome = await applyPersonaBundle(bundleOf(
    { name: 'Injector' },
    [['jingles/one.wav\nsomewhere-else.mp3\ntwo.wav', Buffer.from('bytes')]],
  ));
  assert.equal(outcome.ok, false);
  assert.equal((outcome as any).status, 400);
  assert.match((outcome as any).error, /not a usable jingle filename/);
  assert.equal(stateSnapshot(), before, 'a refused import must write nothing at all');

  // And the same rule at the pure layer, where the class is stated.
  assert.equal(pure.JINGLE_FILENAME_RE.test('one.wav\nevil.mp3'), false);
  assert.equal(pure.JINGLE_FILENAME_RE.test('jingle_nova.wav'), true);
  assert.equal(pure.JINGLE_FILENAME_RE.test('a b.wav'), false);
});

test('a voice filename the persona SCHEMA would refuse writes nothing', async () => {
  // adoptVoice used to take any *.wav, so the name was written to disk and then
  // put on tts.voice — where TTS_CHATTERBOX_VOICE_RE refused it and the save
  // 400'd, leaving the sample behind. The two rules are now one rule.
  const before = stateSnapshot();
  const outcome = await applyPersonaBundle(bundleOf(
    {
      name: 'Spacey',
      tts: { engine: 'chatterbox', cloudProvider: 'openai', voice: 'ok.wav', gainDb: 0, speed: 1 },
    },
    [
      ['voices/my voice.wav', Buffer.from('wav bytes')],
      ['jingles/spacey_ident.wav', Buffer.from('stinger bytes')],
    ],
  ));
  assert.equal(outcome.ok, false);
  assert.match((outcome as any).error, /not a usable reference-voice filename/);
  assert.equal(stateSnapshot(), before);
});

test('a bad audio member does not strand the GOOD ones written before it', async () => {
  // The members are collected and checked in archive order, so the empty one
  // below sits behind a perfectly good stinger. Under the old write-as-you-go
  // shape that first jingle was already in jingles.m3u by the time the second
  // threw — a stinger on air for a DJ that was never created.
  const before = stateSnapshot();
  const outcome = await applyPersonaBundle(bundleOf(
    { name: 'Half Written' },
    [
      ['jingles/good_one.wav', Buffer.from('good bytes')],
      ['jingles/empty_one.wav', Buffer.alloc(0)],
    ],
  ));
  assert.equal(outcome.ok, false);
  assert.match((outcome as any).error, /is empty/);
  assert.equal(stateSnapshot(), before);
});

test('a duplicate name refuses without writing the audio that came with it', async () => {
  // The roster check already came first, but it is the refusal an operator
  // actually hits, so it is worth pinning against the full snapshot.
  const before = stateSnapshot();
  const outcome = await applyPersonaBundle(bundleOf(
    { name: 'Nova Reyes' },
    [['jingles/dupe_ident.wav', Buffer.from('stinger bytes')]],
  ));
  assert.equal(outcome.ok, false);
  assert.equal((outcome as any).status, 409);
  assert.equal(stateSnapshot(), before);
});

test('a clone-voice persona with NO sample anywhere is refused, not a silent 200', async () => {
  // buildPersonaBundle refuses to PRODUCE this, but a hand-built zip never went
  // through it. Installing would give the operator a DJ that fails every line.
  const before = stateSnapshot();
  const outcome = await applyPersonaBundle(bundleOf({
    name: 'Ghost Voice',
    tts: { engine: 'chatterbox', cloudProvider: 'openai', voice: 'absent.wav', gainDb: 0, speed: 1 },
  }));
  assert.equal(outcome.ok, false);
  assert.match((outcome as any).error, /fail its synth on every line/);
  assert.equal(stateSnapshot(), before);
});

test('...but a sample this station ALREADY has is not a refusal', async () => {
  // nova.wav is in the library, so the persona works exactly as its JSON asks
  // and there is nothing to warn about. Refusing here would block the ordinary
  // "we both already have this voice" share.
  const outcome = await applyPersonaBundle(bundleOf({
    name: 'Borrows Nova',
    tts: { engine: 'chatterbox', cloudProvider: 'openai', voice: 'nova.wav', gainDb: 0, speed: 1 },
  }));
  assert.equal(outcome.ok, true, (outcome as any).error);
  assert.equal((outcome as any).persona.tts.voice, 'nova.wav');
  assert.equal((outcome as any).voice, null, 'nothing was adopted — the file was already here');
});

test('a bundle may not carry more jingles than a DJ plausibly has', async () => {
  const before = stateSnapshot();
  const many: [string, Buffer][] = [];
  for (let i = 0; i <= pure.MAX_BUNDLE_JINGLES; i += 1) {
    many.push([`jingles/many_${i}.wav`, Buffer.from(`stinger ${i}`)]);
  }
  const outcome = await applyPersonaBundle(bundleOf({ name: 'Too Many' }, many));
  assert.equal(outcome.ok, false);
  assert.match((outcome as any).error, /at most 24 jingles/);
  assert.equal(stateSnapshot(), before);
});

test('a jingle text from the manifest is bounded like every operator string', async () => {
  const outcome = await applyPersonaBundle(bundleOf(
    { name: 'Wordy' },
    [['jingles/wordy_ident.wav', Buffer.from('stinger bytes')]],
    [{ file: 'wordy_ident.wav', text: 'x'.repeat(5000) }],
  ));
  assert.equal(outcome.ok, true, (outcome as any).error);
  const sidecar = JSON.parse(readFileSync(join(root, 'jingles.json'), 'utf8'));
  const stored = (outcome as any).jingles[0];
  assert.equal(sidecar.items[stored].text.length, pure.JINGLE_TEXT_MAX);
});
