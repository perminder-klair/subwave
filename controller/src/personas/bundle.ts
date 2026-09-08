// Persona bundles (#1620) — one zip that carries a DJ complete enough to speak
// on the station it lands in.
//
// Sharing a persona used to mean pasting its JSON and separately remembering to
// move whatever audio it depended on. A cloned voice is the case that breaks:
// chatterbox and pocket-tts read `tts.voice` as a FILENAME in the shared voice
// folder (#213), so the JSON alone arrives pointing at a WAV that isn't there
// and the persona fails its synth on every line.
//
// Packaging follows backup/zip.ts — an AdmZip the caller turns into a response
// body or a file, a manifest with a format + version checked before anything is
// touched, and member paths that mirror the state-dir layout. What it is NOT is
// a backup: no settings, no tag DB, nothing station-shaped. Whole-station export
// is explicitly out of scope; the backup export already is that.
//
// The write half is deliberately thin. It resolves names and bytes and then
// hands the persona to personas/install.ts, the same function the community
// install route calls — a second create path is how the cap, the duplicate-name
// refusal and the id minting start disagreeing.
//
// It is also strictly ordered: every refusal is asked before the first byte is
// written, INCLUDING the ones other modules own. That took reserving the
// filenames rather than discovering them at write time, because two of those
// refusals are downstream of the name — the voice library's own filename rule
// (which is the persona schema's, so a name it accepts saves) and the strict
// validator settings.update() runs. An import that half-wrote was not a
// cosmetic problem: jingles.adopt registers a stinger in jingles.m3u, which
// Liquidsoap reloads on watch, so a 400 could still put audio on air.
import AdmZip from 'adm-zip';
import * as settings from '../settings.js';
import * as jingles from '../broadcast/jingles.js';
import * as voiceLibrary from '../audio/voice-library.js';
import { appVersion } from '../backup/zip.js';
import { personaSchema } from '../schemas/persona.js';
import { validatePersonasStrict } from '../settings/validate.js';
import { installPersona, personaSlotError, type PersonaInstallResult } from './install.js';
import {
  BUNDLE_JINGLE_DIR,
  BUNDLE_MANIFEST_ENTRY,
  BUNDLE_PERSONA_ENTRY,
  BUNDLE_VOICE_DIR,
  JINGLE_TEXT_MAX,
  MAX_BUNDLE_JINGLES,
  PERSONA_BUNDLE_FORMAT,
  PERSONA_BUNDLE_VERSION,
  bundleMemberName,
  isSafeBundleEntry,
  jinglesNamingPersona,
  personaCloneVoice,
} from './bundle-pure.js';

/** Hard cap on a member we will write to disk. A stinger or a 20s clone clip is orders below this. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export type BuildBundleResult =
  | { ok: true; zip: AdmZip; persona: any }
  | { ok: false; status: number; error: string };

/**
 * Build the bundle for one persona.
 *
 * The persona travels WITHOUT its id (the receiving station mints its own) and
 * without its avatar: an avatar is a file the browser produced for a persona
 * that had already been created, keyed on the id this bundle is dropping, and
 * the issue scopes the payload to the JSON, the voice sample and the jingles.
 *
 * A persona that clones from a sample this station no longer HAS is refused
 * rather than exported. The bundle would be well-formed — `manifest.voice:
 * null` beside a persona JSON still naming the file — and would import 200 on
 * the far side into a DJ that fails its synth on every line, which is the exact
 * failure this module exists to prevent. Refusing here is the only place the
 * operator can still do something about it: they have the sample, or they know
 * it is gone.
 */
export async function buildPersonaBundle(personaId: string): Promise<BuildBundleResult> {
  await settings.load();
  const current = settings.get();
  const persona = (current.personas || []).find((p: any) => p.id === personaId);
  if (!persona) return { ok: false, status: 404, error: `no such persona: ${personaId}` };

  const zip = new AdmZip();

  // `id` and `avatar` are station-local; everything else round-trips.
  const { id: _id, avatar: _avatar, ...portable } = persona as Record<string, unknown>;
  zip.addFile(BUNDLE_PERSONA_ENTRY, Buffer.from(JSON.stringify(portable, null, 2)));

  // The reference WAV, if this persona's own slot names one. resolve() covers
  // the legacy pre-#213 folder too, so a station that never migrated still
  // exports a working bundle.
  let voice: string | null = null;
  const wanted = personaCloneVoice(persona.tts);
  if (wanted) {
    const found = await voiceLibrary.resolve(wanted);
    if (!found) {
      return {
        ok: false,
        status: 409,
        error: `"${persona.name}" clones from "${wanted}", but that sample is not in the voice library`
          + ' — restore it under Imaging → Voices, or clear the voice slot, before exporting',
      };
    }
    zip.addLocalFile(found.path, BUNDLE_VOICE_DIR, found.file);
    voice = found.file;
  }

  // Jingles whose spoken text names this DJ. Nothing on disk links the two, so
  // the text is the only evidence there is — see bundle-pure.jinglesNamingPersona.
  const carried: { file: string; text: string }[] = [];
  const all = await jingles.list();
  for (const j of jinglesNamingPersona(all, String(persona.name || ''))) {
    const path = await jingles.getPath(j.filename);
    if (!path) continue;
    zip.addLocalFile(path, BUNDLE_JINGLE_DIR, j.filename);
    carried.push({ file: j.filename, text: String(j.text || '') });
  }

  // Listed before the manifest is added so `contents` never names itself —
  // same ordering rule as buildBackupZip.
  zip.addFile(
    BUNDLE_MANIFEST_ENTRY,
    Buffer.from(JSON.stringify({
      format: PERSONA_BUNDLE_FORMAT,
      version: PERSONA_BUNDLE_VERSION,
      appVersion,
      createdAt: new Date().toISOString(),
      persona: { name: persona.name, tagline: persona.tagline || '' },
      voice,
      jingles: carried,
      contents: zip.getEntries().map(e => e.entryName),
    }, null, 2)),
  );

  return { ok: true, zip, persona };
}

export type BundleImportResult =
  | { ok: true; status: 200; personas: any[]; persona: any | null; voice: string | null; jingles: string[] }
  | { ok: false; status: number; error: string };

function fail(status: number, error: string): BundleImportResult {
  return { ok: false, status, error };
}

// One import at a time. The write half RESERVES its filenames, validates the
// persona against them and only then writes; that is sound exactly as long as
// no other import claims a name in between. Imports are rare and operator-
// driven, so serialising them costs nothing and is cheaper than making every
// reservation defend itself.
let importChain: Promise<unknown> = Promise.resolve();

/**
 * Read a bundle and create the persona it describes.
 *
 * NOTHING is written until every refusal has been asked. That is the whole
 * shape of this function, and it is stricter than it looks, because the
 * refusals do not all live here: a filename the voice library will not store, a
 * jingle name the playlist cannot hold, and the strict persona validator inside
 * settings.update() are all owned elsewhere, and each of them used to fire
 * AFTER audio had landed. A jingle that lands behind a refusal is not merely
 * litter — jingles.adopt registers it in jingles.json and writes it into
 * jingles.m3u, which Liquidsoap reloads on watch, so a rejected import would
 * put a stinger for a DJ that was never created on air.
 *
 * So the order is: parse, validate the persona, check every member's NAME and
 * SIZE against the predicates the writers own (isAdoptableVoiceName /
 * jingles.isAdoptableName), ask the roster for room, RESERVE the filenames the
 * writers would use, put the reserved voice name on the persona, and run the
 * strict validator over the whole roster as a dry run. Only then does anything
 * touch the disk.
 *
 * Reserving before writing is what makes the re-point sound. `tts.voice` has to
 * name the file the sample ACTUALLY got — a collision is suffixed, never
 * overwritten — and settling that name first is the only way the persona can be
 * validated with it rather than after it. Rollback-on-failure was the other
 * candidate and is worse here: jingles.adopt's write is three files (the WAV,
 * the sidecar, the playlist), so unwinding a partial import means reversing
 * another module's multi-file write from the outside, which is exactly the kind
 * of second writer this feature is otherwise careful not to add.
 */
async function applyPersonaBundleLocked(body: Buffer): Promise<BundleImportResult> {
  if (!Buffer.isBuffer(body) || body.length === 0) {
    return fail(400, 'expected a zip file body');
  }

  let zip: AdmZip;
  try {
    zip = new AdmZip(body);
  } catch {
    return fail(400, 'not a valid zip file');
  }

  const manifestEntry = zip.getEntry(BUNDLE_MANIFEST_ENTRY);
  if (!manifestEntry) {
    return fail(400, 'missing manifest.json — not a SUB/WAVE persona bundle');
  }
  let manifest: any;
  try {
    manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
  } catch {
    return fail(400, 'corrupt manifest.json');
  }
  if (manifest?.format !== PERSONA_BUNDLE_FORMAT) {
    // Naming the backup format is worth the sentence: a station backup is the
    // other zip an operator has lying around, and the two are one click apart.
    return fail(400, manifest?.format === 'subwave-backup'
      ? 'that is a station backup, not a persona bundle — restore it from Admin → Backup'
      : 'not a SUB/WAVE persona bundle');
  }
  if (manifest?.version !== PERSONA_BUNDLE_VERSION) {
    return fail(400, `unsupported persona bundle version: ${manifest?.version}`);
  }

  const personaEntry = zip.getEntry(BUNDLE_PERSONA_ENTRY);
  if (!personaEntry) return fail(400, 'missing persona.json');
  let raw: any;
  try {
    raw = JSON.parse(personaEntry.getData().toString('utf8'));
  } catch {
    return fail(400, 'corrupt persona.json');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail(400, 'persona.json must be a persona object');
  }

  // The same schema the /settings save runs. A bundle from a newer station can
  // carry a field this one has never heard of; the schema drops it, exactly as
  // it does for a restored backup.
  const parsed = personaSchema.safeParse({ ...raw, id: undefined, avatar: '' });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fail(400, `persona.json is not a valid persona: ${issue?.message || 'unknown error'}`);
  }
  const incoming: any = { ...parsed.data };
  delete incoming.id;

  // Collect the audio members up front, and check each one against the SAME
  // predicate the writer will apply. Deferring the name check to write time is
  // what let a refusal land after a file had already reached the rotation.
  const tooBig = (name: string) =>
    fail(400, `${name} is larger than ${Math.round(MAX_AUDIO_BYTES / (1024 * 1024))} MB`);
  let voiceMember: { name: string; data: Buffer } | null = null;
  const jingleMembers: { name: string; data: Buffer }[] = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const name = entry.entryName;
    if (name === BUNDLE_MANIFEST_ENTRY || name === BUNDLE_PERSONA_ENTRY) continue;
    if (!isSafeBundleEntry(name)) return fail(400, `unsafe entry in bundle: ${name}`);
    const voiceName = bundleMemberName(name, BUNDLE_VOICE_DIR);
    const jingleName = bundleMemberName(name, BUNDLE_JINGLE_DIR);
    if (!voiceName && !jingleName) continue; // an unknown member is ignored, not fatal

    // The DECLARED size, before getData() decompresses anything. A zip is free
    // to claim a small compressed member that expands to gigabytes, and the cap
    // is worth nothing if we have already materialised the member to apply it.
    if (Number(entry.header.size) > MAX_AUDIO_BYTES) return tooBig(name);

    if (voiceName) {
      // One voice per persona — `tts.voice` is a single field, so a second WAV
      // has nothing to be pointed at.
      if (voiceMember) return fail(400, 'bundle carries more than one reference voice');
      // The name the voice library will accept, which is the name the persona
      // schema will accept, because it is the same regex — see
      // voiceLibrary.isAdoptableVoiceName.
      if (!voiceLibrary.isAdoptableVoiceName(voiceName)) {
        return fail(400, `${name} is not a usable reference-voice filename`);
      }
      const data = entry.getData();
      if (data.length > MAX_AUDIO_BYTES) return tooBig(name);
      if (!data.length) return fail(400, `${name} is empty`);
      voiceMember = { name: voiceName, data };
    } else if (jingleName) {
      if (jingleMembers.length >= MAX_BUNDLE_JINGLES) {
        return fail(400, `a persona bundle may carry at most ${MAX_BUNDLE_JINGLES} jingles`);
      }
      // A jingle filename becomes a LINE of jingles.m3u, so this checks the
      // whole name and not just its extension — see JINGLE_FILENAME_RE.
      if (!jingles.isAdoptableName(jingleName)) {
        return fail(400, `${name} is not a usable jingle filename`);
      }
      const data = entry.getData();
      if (data.length > MAX_AUDIO_BYTES) return tooBig(name);
      if (!data.length) return fail(400, `${name} is empty`);
      jingleMembers.push({ name: jingleName, data });
    }
  }

  // A persona that clones from a WAV, in a bundle that carries none, is the
  // silent-200 the export refusal above is the other half of — the DJ installs
  // and then fails its synth on every line. A hand-built zip reaches this
  // without ever passing through our exporter, so the import says so too.
  // Unless this station ALREADY has that sample, in which case the persona
  // works exactly as its JSON asks and there is nothing to warn about.
  const clonesFrom = personaCloneVoice(incoming.tts);
  if (clonesFrom && !voiceMember && !(await voiceLibrary.resolve(clonesFrom))) {
    return fail(400, `persona.json clones from "${clonesFrom}", but the bundle carries no`
      + ` ${BUNDLE_VOICE_DIR}/ member and this station has no such sample`
      + ' — the DJ would fail its synth on every line');
  }

  // Room and a free name — the likeliest refusal of the lot, and still free to
  // ask, because nothing has been written yet and nothing will be until every
  // question below has also been answered.
  await settings.load();
  const rosterNow = settings.get().personas || [];
  const slotError = personaSlotError(rosterNow, incoming.name);
  if (slotError) return slotError;

  const jingleText = new Map<string, string>();
  if (Array.isArray(manifest?.jingles)) {
    for (const j of manifest.jingles) {
      // Manifest text is copied to disk without the persona schema ever seeing
      // it, so it is bounded here like every other operator-visible string.
      if (j && typeof j.file === 'string') {
        jingleText.set(j.file, String(j.text ?? '').slice(0, JINGLE_TEXT_MAX));
      }
    }
  }

  // Reserve the names the writers WOULD use. Nothing on disk changes; what we
  // get back is what `tts.voice` has to say, so the persona can be validated
  // holding it rather than after it.
  let reservedVoice: string | null = null;
  let reservedJingles: string[] = [];
  try {
    if (voiceMember) reservedVoice = await voiceLibrary.reserveVoiceName(voiceMember.name);
    reservedJingles = await jingles.reserveNames(jingleMembers.map(j => j.name));
  } catch (err: any) {
    return fail(400, `could not place the bundle's audio: ${err.message}`);
  }

  // Only re-point the persona when its engine actually reads the field as a
  // reference WAV. A bundle carrying a voice for a piper persona is a mixed
  // signal; the file is still adopted (it is audio the operator was sent) but
  // the slot keeps whatever the JSON said.
  if (reservedVoice && personaCloneVoice(incoming.tts)) {
    incoming.tts = { ...incoming.tts, voice: reservedVoice };
  }

  // The last refusal, run as a DRY RUN over the roster this import would
  // produce. installPersona() reaches the same validator through
  // settings.update(), but by then the audio is on disk — and `tts.voice` now
  // holds a name that was decided here, not one persona.json was parsed with.
  try {
    validatePersonasStrict([...rosterNow, incoming]);
  } catch (err: any) {
    return fail(400, `persona.json is not a valid persona: ${err.message}`);
  }

  let storedVoice: string | null = null;
  const storedJingles: string[] = [];
  try {
    if (voiceMember && reservedVoice) {
      const stored = await voiceLibrary.adoptVoice(voiceMember.data, {
        file: voiceMember.name, reserved: reservedVoice,
      });
      storedVoice = stored.file;
    }
    for (const [i, j] of jingleMembers.entries()) {
      const stored = await jingles.adopt(j.data, {
        filename: j.name,
        text: jingleText.get(j.name) || '',
        reserved: reservedJingles[i],
      });
      storedJingles.push(stored.filename);
    }
  } catch (err: any) {
    return fail(400, `could not store the bundle's audio: ${err.message}`);
  }

  const result: PersonaInstallResult = await installPersona(incoming);
  if (!result.ok) return result;
  return {
    ok: true,
    status: 200,
    personas: result.personas,
    persona: result.persona,
    voice: storedVoice,
    jingles: storedJingles,
  };
}

/**
 * The public import entry point: one bundle at a time.
 *
 * Reservations are settled a few awaits before the write that consumes them, so
 * two imports landing together could otherwise be handed the same free name and
 * the second would write over the first — the one outcome the suffix rule
 * exists to make impossible. A queue is the cheap fix; an operator uploading
 * two bundles at once waits milliseconds.
 */
export async function applyPersonaBundle(body: Buffer): Promise<BundleImportResult> {
  const run = importChain.then(
    () => applyPersonaBundleLocked(body),
    () => applyPersonaBundleLocked(body),
  );
  // Swallow on the CHAIN only — the caller still sees the real rejection.
  importChain = run.then(() => undefined, () => undefined);
  return run;
}
