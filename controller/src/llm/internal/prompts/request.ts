// Request matching — structured output, Zod-validated. Turns a free-text
// listener request into search parameters the server resolves into tracks.

import { z } from 'zod';
import * as settings from '../../../settings.js';
import { djObject } from '../strategy/object.js';

const REQUEST_SYSTEM = `You are the music librarian for a personal Navidrome library that runs an AI radio station. A listener sends a request; you turn it into structured search parameters.

Vibe-to-mood mapping (use these when the request describes a feeling, weather, or moment rather than naming an artist/song):
- overcast, cloudy, grey day, drizzly → calm or reflective
- rainy day, downpour → rainy + calm
- sunny, golden hour → sunny
- cosy, comfy, blanket, fireside → calm
- late night, midnight, after hours → night
- morning coffee, breakfast, sunrise → morning
- evening, golden hour, sundown → evening
- working out, gym, run → workout
- focus, deep work, study → focus
- driving, road trip, motorway → driving
- party, celebrating, friends → celebratory
- heartbreak, melancholy, longing → reflective
- love, romance, slow dance → romantic
- diwali, vaisakhi, holi → festival + cultural
- shabad, kirtan, devotional → spiritual

Worked examples (these show how the fields map — values only; the response format is handled for you):

"<artist> latest album"
{"search_terms":["<artist>"],"artist":"<artist>","genre":null,"language":null,"sort":"latest","scope":"album","mood":null,"intent":"Wants a track from the newest album.","ack":"Pulling their latest for you now."}

"old <artist> track"
{"search_terms":["<artist>"],"artist":"<artist>","genre":null,"language":null,"sort":"oldest","scope":"song","mood":null,"intent":"Wants an early track.","ack":"Going back in the catalogue for you."}

"play some punjabi music"
{"search_terms":[],"artist":null,"genre":"punjabi","language":null,"sort":null,"scope":"song","mood":null,"intent":"Wants Punjabi-genre music.","ack":"Some Punjabi heat coming your way."}

"play something turkish"
{"search_terms":[],"artist":null,"genre":null,"language":"Turkish","sort":null,"scope":"song","mood":null,"intent":"Wants Turkish-language music.","ack":"Spinning something Turkish for you."}

"something romantic"
{"search_terms":[],"artist":null,"genre":null,"language":null,"sort":null,"scope":"song","mood":"romantic","intent":"Wants a romantic track.","ack":"Slowing things down for you."}

"overcast mood"
{"search_terms":[],"artist":null,"genre":null,"language":null,"sort":null,"scope":"song","mood":"calm","intent":"Wants something to match an overcast feel.","ack":"Something to sit under the grey with."}

"rainy day"
{"search_terms":[],"artist":null,"genre":null,"language":null,"sort":null,"scope":"song","mood":"rainy","intent":"Wants weather-appropriate calm music.","ack":"Soundtrack for the rain, coming up."}

"late-night driving"
{"search_terms":[],"artist":null,"genre":null,"language":null,"sort":null,"scope":"song","mood":"driving","intent":"Wants night-drive music.","ack":"Keep the road quiet — this one's for you."}

"play <title> by <artist>"
{"search_terms":["<title>","<artist>"],"artist":"<artist>","genre":null,"language":null,"sort":null,"scope":"song","mood":null,"intent":"Wants a specific song by a specific artist.","ack":"Coming right up."}`;

// Lenient schema — it enforces the SHAPE; the prompt + per-field .describe()
// strings carry the SEMANTICS. `mood`/`sort` stay free strings (not enums) so a
// near-miss from a weaker model doesn't 500 a listener request — server.js
// tolerates unknown moods by falling through to its other pick sources. The AI
// SDK feeds these descriptions to the model alongside the schema, so they don't
// need to be restated in REQUEST_SYSTEM.
const REQUEST_SCHEMA = z.object({
  search_terms: z.array(z.string()).describe('1-3 strings to look up in the library — ARTIST NAMES or SONG TITLES only. NEVER genres, and NEVER mood/vibe words like "calm", "rainy", "overcast". Genres go in "genre"; vibes go in "mood".'),
  artist: z.string().nullable().describe(`the artist's common name if the listener named one (e.g. "Diljit Dosanjh"), else null`),
  genre: z.string().nullable().describe('a real music genre if the listener asked for one (e.g. "punjabi", "hip hop", "jazz", "lofi", "rock", "bhangra"), else null. A genre is a kind of music — not a mood and not a feeling.'),
  language: z.string().nullable().describe('set when the listener asked for music in a language or from a country/culture (e.g. "play something Turkish" → "Turkish", "French music" → "French") — always in English, even if the listener wrote in another language; null otherwise. NOT for genres ("jazz") or moods.'),
  sort: z.string().nullable().describe('"latest" for latest/new/newest/recent, "oldest" for old/classic, "popular" for popular/best/top, else null'),
  scope: z.enum(['album', 'song']).describe('what the listener wants; default "song"'),
  mood: z.string().nullable().describe('one of energetic|calm|reflective|celebratory|romantic|spiritual|focus|workout|driving|cooking|rainy|sunny|night|morning|evening|festival|cultural — or null. ALWAYS set this for vibe/feeling requests ("overcast mood" → calm or reflective, "cosy" → calm, "pumped up" → energetic, "late night drive" → night — pick the strongest single match).'),
  intent: z.string().describe('one short sentence describing what the listener wants'),
  ack: z.string().describe(`short on-air acknowledgment the DJ reads aloud, max 20 words, sounds like a real radio DJ — no "thank you for listening" or self-intros`),
});

export async function matchRequest(
  userQuery: string,
  { listenerName = null, nowPlaying = null }: { listenerName?: string | null; nowPlaying?: any } = {},
) {
  const ctxLines: string[] = [];
  if (nowPlaying?.title) {
    ctxLines.push(`Currently playing: "${nowPlaying.title}"${nowPlaying.artist ? ` by ${nowPlaying.artist}` : ''}.`);
  }
  const userPrompt = [
    listenerName ? `Listener "${listenerName}" requests:` : `Anonymous request:`,
    userQuery,
    ctxLines.length ? `\n[Context for resolving references like "similar", "more like this", "match this vibe":\n${ctxLines.join('\n')}]` : '',
  ].filter(Boolean).join(' ');

  const persona = settings.getEffectivePersona();
  // The `ack` is the one field here that AIRS — without this clause it was
  // the only spoken line in the system written with no persona voice at all
  // (the librarian framing above owns every other field).
  const personaSuffix = persona?.name
    ? `\n\nThe "ack" line is read on air by ${persona.name}, the station's DJ${persona.soul ? ` — ${persona.soul}` : ''}. Write the ack in their voice; every other field stays plain and functional.`
    : '';
  // When the on-air persona speaks another language, only the spoken `ack`
  // follows it — every search-facing field must stay in English / canonical
  // names so it still matches an English-tagged library. Language comes LAST
  // (after the persona clause) — repeating it last is what makes it stick.
  const lang = String(persona?.language || '').trim();
  const langSuffix = lang
    ? `\n\nThe on-air DJ speaks ${lang}: write the "ack" field in ${lang}. Every OTHER field (search_terms, artist, genre, mood, sort, intent, language) stays in English / canonical names exactly as the library is tagged — translate nothing there, even when the listener wrote in ${lang}.`
    : '';

  return djObject({
    system: REQUEST_SYSTEM + personaSuffix + langSuffix,
    prompt: userPrompt,
    schema: REQUEST_SCHEMA,
    temperature: 0.4,
    kind: 'matchRequest',
  });
}

// Map a vague listener DESCRIPTION of a track ("the song from the new Dune
// movie", "the one all over TikTok") to a concrete {title, artist}, using web
// snippets as the only evidence. Returns null when the snippets don't pin down
// a single song — a wrong guess sends the library search confidently in the
// wrong direction, so we never guess. Backs the request-only
// `identifyRequestedTrack` tool (llm/internal/tools/picker-tools.ts), which then
// resolves the result against the LOCAL library — this never returns a track id.
const IDENTIFY_SCHEMA = z.object({
  title: z.string().nullable().describe('the one specific song title the description points to, or null if the web text does not pin down a single song'),
  artist: z.string().nullable().describe('the primary performing artist for that song, or null if the text does not make it clear'),
  keyword: z.string().nullable().describe('the shortest 1-2 word search keyword a music library would file this track under (e.g. "Sajde" not "Sajde Kiye Hai Lakho", "Espresso" not "Espresso by Sabrina Carpenter"), or null'),
});

export async function identifyTrackFromText(
  reference: string,
  webText: string,
): Promise<{ title: string; artist: string | null; keyword: string | null } | null> {
  const out = await djObject({
    system: 'You map a vague description of a song to the ONE specific track it refers to, using only the web snippets provided. Return the exact song title, primary performing artist, and the shortest 1-2 word keyword a personal music library would file the track under (often just the first word of the title). If the snippets do not clearly point to a single song, return nulls — never guess.',
    prompt: `Listener's description: "${reference}"\n\nWeb context:\n${webText}\n\nWhich single song does this most likely mean?`,
    schema: IDENTIFY_SCHEMA,
    temperature: 0.2,
    kind: 'identifyRequest',
  });
  return out?.title ? { title: String(out.title), artist: out.artist ? String(out.artist) : null, keyword: out.keyword ? String(out.keyword) : null } : null;
}
