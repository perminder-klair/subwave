// Hotline request bodies (docs/plans/hotline.md). Pure zod: mirrored to
// web/lib/schemas.generated.ts by `npm run gen:schemas`.
import { z } from 'zod';

// A device's own random id, minted and kept by the client. It can be cleared or
// forged, so it is paired with the client IP wherever it gates (bans, the
// per-device limit), and a ban is best-effort.
export const HOTLINE_DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

// The two short fields a Dedication is captured as. The on-air line is written
// by the normal request-intro path from these, never read out as typed.
export const HOTLINE_DEDICATION_TO_MAX = 40;
export const HOTLINE_DEDICATION_NOTE_MAX = 120;

export const hotlineCallStartSchema = z.object({
  deviceId: z.string().regex(HOTLINE_DEVICE_ID_PATTERN, 'deviceId must be 8-64 letters, digits, - or _'),
  // The name the listener already uses for typed requests. Optional: with none,
  // the DJ asks who's calling.
  // Bounded like a typed request's name (REQUEST_NAME_MAX, 40); the route
  // cleans it with cleanRequesterName.
  name: z.string().max(40).optional().default(''),
});

// One relayed tool call. `arguments` is whatever the provider handed the client:
// a JSON string (OpenAI Realtime) or an object.
export const hotlineToolCallSchema = z.object({
  name: z.string().min(1).max(64),
  arguments: z.union([z.string().max(4000), z.record(z.string(), z.unknown())]).optional(),
});

// An operator's Hotline ban, made from a recent Call's row.
export const hotlineBanSchema = z.object({
  callId: z.string().min(1).max(64),
});
