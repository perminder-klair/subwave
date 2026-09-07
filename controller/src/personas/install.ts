// Adding a persona to the roster — the ONE writer behind both arrivals.
//
// A community install (POST /personas/community/:slug/install) and a bundle
// import (POST /personas/import, #1620) differ only in where the persona object
// came from: the catalog's portable fields plus roster defaults, or a zip whose
// JSON has already been through personaSchema. Everything after that — the cap,
// the duplicate-name refusal, the settings.update() that mints the id and runs
// the strict validator, and finding the row that landed — is the same decision
// twice, and the pair drifting is exactly the "second writer" the issue asks us
// not to add.
//
// The two refusals are 409s rather than repairs on purpose. A roster at
// PERSONA_LIMIT has no room, and a second DJ with an existing name leaves the
// operator two indistinguishable rows in every picker that names a persona.
//
// personaSlotError is pure over the roster it is handed for the same reason
// validatePersonasStrict is callable directly: the bundle import has to ask
// BOTH questions before it writes any audio, and installPersona is reached only
// once nothing can still refuse. Asking twice is not redundant — this is the
// answer that counts, the import's is a dry run.
import * as settings from '../settings.js';

export type PersonaInstallFailure = { ok: false; status: number; error: string };
export type PersonaInstallSuccess = {
  ok: true;
  personas: any[];
  persona: any | null;
};
export type PersonaInstallResult = PersonaInstallSuccess | PersonaInstallFailure;

/** How a name is compared for the duplicate check — trimmed, case-folded. */
export function personaNameKey(name: unknown): string {
  return String(name ?? '').trim().toLowerCase();
}

/**
 * Is there room for one more persona called `name`?
 *
 * Pure over the roster it is handed, so an import can ask BEFORE it writes any
 * audio into the state dirs: the two failures below are the likely ones, and a
 * refused import that had already dropped a WAV in state/voices/ would leave
 * litter the operator never asked for.
 */
export function personaSlotError(
  personas: readonly any[],
  name: unknown,
): PersonaInstallFailure | null {
  if (personas.length >= settings.PERSONA_LIMIT) {
    return {
      ok: false,
      status: 409,
      error: `the roster is full (${settings.PERSONA_LIMIT} personas max) — remove one first`,
    };
  }
  const wanted = personaNameKey(name);
  if (personas.some(p => personaNameKey(p?.name) === wanted)) {
    return { ok: false, status: 409, error: `a persona named "${String(name).trim()}" is already in the roster` };
  }
  return null;
}

/**
 * Append `persona` to the roster and hand back the row that landed.
 *
 * The persona arrives WITHOUT an id — settings.update() mints one
 * (resolvePersonaIds) — and without touching activePersonaId, so it is off air
 * on arrival, the analogue of a community skill installing disabled. The row is
 * found back by name because minting happens inside update() and the caller has
 * no other handle on it.
 */
export async function installPersona(persona: Record<string, unknown>): Promise<PersonaInstallResult> {
  await settings.load();
  const personas = settings.get().personas || [];
  const slotError = personaSlotError(personas, persona.name);
  if (slotError) return slotError;

  try {
    await settings.update({ personas: [...personas, persona] });
  } catch (err: any) {
    return { ok: false, status: 400, error: err.message };
  }

  const next = settings.get().personas || [];
  const wanted = personaNameKey(persona.name);
  const installed = next.find((p: any) => personaNameKey(p.name) === wanted) || null;
  return { ok: true, personas: next, persona: installed };
}
