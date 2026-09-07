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
import AdmZip from 'adm-zip';
import * as settings from '../settings.js';
import * as jingles from '../broadcast/jingles.js';
import * as voiceLibrary from '../audio/voice-library.js';
import { appVersion } from '../backup/zip.js';
import { personaSchema } from '../schemas/persona.js';
import { installPersona, personaSlotError, type PersonaInstallResult } from './install.js';
import {
  BUNDLE_JINGLE_DIR,
  BUNDLE_MANIFEST_ENTRY,
  BUNDLE_PERSONA_ENTRY,
  BUNDLE_VOICE_DIR,
  PERSONA_BUNDLE_FORMAT,
  PERSONA_BUNDLE_VERSION,
  bundleMemberName,
  isSafeBundleEntry,
  jinglesNamingPersona,
  personaCloneVoice,
} from './bundle-pure.js';

/** Hard cap on a member we will write to disk. A stinger or a 20s clone clip is orders below this. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export type BuiltBundle = { zip: AdmZip; persona: any };

/**
 * Build the bundle for one persona, or null when no such persona exists.
 *
 * The persona travels WITHOUT its id (the receiving station mints its own) and
 * without its avatar: an avatar is a file the browser produced for a persona
 * that had already been created, keyed on the id this bundle is dropping, and
 * the issue scopes the payload to the JSON, the voice sample and the jingles.
 */
export async function buildPersonaBundle(personaId: string): Promise<BuiltBundle | null> {
  await settings.load();
  const current = settings.get();
  const persona = (current.personas || []).find((p: any) => p.id === personaId);
  if (!persona) return null;

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
    if (found) {
      zip.addLocalFile(found.path, BUNDLE_VOICE_DIR, found.file);
      voice = found.file;
    }
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

  return { zip, persona };
}

export type BundleImportResult =
  | { ok: true; status: 200; personas: any[]; persona: any | null; voice: string | null; jingles: string[] }
  | { ok: false; status: number; error: string };

function fail(status: number, error: string): BundleImportResult {
  return { ok: false, status, error };
}

/**
 * Read a bundle and create the persona it describes.
 *
 * Order matters twice over. Everything that can refuse — the manifest, the
 * persona JSON, the shape of every member, and the roster's room for one more
 * name (personaSlotError) — is asked BEFORE a single byte is written, because a
 * refused import that had already dropped a WAV into state/voices/ leaves
 * litter the operator never asked for and cannot see. Then the audio is written
 * before the persona, because `tts.voice` has to name the file it ACTUALLY got:
 * a collision is suffixed, never overwritten, so the stored name is only
 * knowable after the write.
 */
export async function applyPersonaBundle(body: Buffer): Promise<BundleImportResult> {
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

  // Collect the audio members up front so a malformed one refuses the whole
  // import rather than half-writing it — and before the roster is asked for
  // room, so a bundle that is structurally wrong says so rather than reporting
  // whichever of the two failures happened to be checked first.
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
    const data = entry.getData();
    if (data.length > MAX_AUDIO_BYTES) {
      return fail(400, `${name} is larger than ${Math.round(MAX_AUDIO_BYTES / (1024 * 1024))} MB`);
    }
    if (voiceName) {
      // One voice per persona — `tts.voice` is a single field, so a second WAV
      // has nothing to be pointed at.
      if (voiceMember) return fail(400, 'bundle carries more than one reference voice');
      voiceMember = { name: voiceName, data };
    } else if (jingleName) {
      jingleMembers.push({ name: jingleName, data });
    }
  }

  // Room and a free name, asked BEFORE any audio lands: these are the likely
  // refusals, and one that had already dropped a WAV into state/voices/ would
  // leave litter the operator never asked for and cannot see.
  await settings.load();
  const slotError = personaSlotError(settings.get().personas || [], incoming.name);
  if (slotError) return slotError;

  const jingleText = new Map<string, string>();
  if (Array.isArray(manifest?.jingles)) {
    for (const j of manifest.jingles) {
      if (j && typeof j.file === 'string') jingleText.set(j.file, String(j.text ?? ''));
    }
  }

  let storedVoice: string | null = null;
  const storedJingles: string[] = [];
  try {
    // Only re-point the persona when its engine actually reads the field as a
    // reference WAV. A bundle carrying a voice for a piper persona is a mixed
    // signal; the file is still adopted (it is audio the operator was sent)
    // but the slot keeps whatever the JSON said.
    if (voiceMember) {
      const stored = await voiceLibrary.adoptVoice(voiceMember.data, { file: voiceMember.name });
      storedVoice = stored.file;
      if (personaCloneVoice(incoming.tts)) {
        incoming.tts = { ...incoming.tts, voice: stored.file };
      }
    }
    for (const j of jingleMembers) {
      const stored = await jingles.adopt(j.data, {
        filename: j.name,
        text: jingleText.get(j.name) || '',
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
