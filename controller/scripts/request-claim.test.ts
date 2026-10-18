// A request line must describe the track that will actually air (#1918).
// Run: `npm test -- request-claim`.
//
// Live: "Michael Jackson please" → the request agent made one tracksLikeThis
// call on the queued Madonna track and returned a VALID candidate id (Madonna,
// "La Isla Bonita") under an ack and intro announcing Michael Jackson's "Billie
// Jean". The unknown-id re-pick never fired, so the lie aired. Two halves:
// util/request-claim.ts decides what a wrong name is (the pure table below),
// and runRequest's remedy — one corrective re-pick with the library lookup the
// agent skipped, else plain copy — is driven end to end further down.

import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTempDir } from './test-utils/temp-dir.js';
import { chatCompletionResponse } from './test-utils/llm.js';

process.env.STATE_DIR = createTempDir(join(tmpdir(), 'subwave-request-claim-'));

const {
  asksForTrack, claimEarnsRepick, claimLookupQuery, lineClaims, matchedRequestLookups, matchedRequestStandIn, misnamedClaims, misnamedRequestLines,
  plainRequestAck, plainRequestIntro, requestLookups, requestStandIn,
} = await import('../src/util/request-claim.js');
const settings = await import('../src/settings.js');
const session = await import('../src/broadcast/session.js');
const { queue } = await import('../src/broadcast/queue.js');
const { requestAgent } = await import('../src/broadcast/dj-agent/agents.js');
const { runRequest } = await import('../src/broadcast/dj-agent.js');

const ISLA = { id: 'madonna-isla', title: 'La Isla Bonita', artist: 'Madonna', album: 'True Blue', duration: 242 };
const HOLIDAY = { id: 'madonna-holiday', title: 'Holiday', artist: 'Madonna', album: 'Madonna', duration: 368 };
const GIRLS = { id: 'cyndi-girls', title: 'Girls Just Want to Have Fun', artist: 'Cyndi Lauper', album: "She's So Unusual", duration: 238 };
const BILLIE = { id: 'mj-billie', title: 'Billie Jean', artist: 'Michael Jackson', album: 'Thriller', duration: 294, isDir: false };

const INCIDENT_INTRO = "Alright Michael, here's Michael Jackson with 'Billie Jean' — keeping things smooth and steady for the afternoon.";
const INCIDENT_ACK = 'Got you, Michael — playing a Michael Jackson track now.';
const incident = { track: ISLA, requestText: 'Michael Jackson please', requester: 'Michael', others: [HOLIDAY, GIRLS] };

// --- the policy -----------------------------------------------------------------

test('the #1918 lines are caught: the asked-for artist and a quoted title, over a Madonna track', () => {
  assert.deepEqual(misnamedClaims(INCIDENT_INTRO, incident), [
    { source: 'request', text: 'Michael Jackson' },
    { source: 'quoted-title', text: 'Billie Jean' },
  ]);
  assert.deepEqual(misnamedClaims(INCIDENT_ACK, incident), [{ source: 'request', text: 'Michael Jackson' }]);
  assert.deepEqual(
    misnamedRequestLines({ intro: INCIDENT_INTRO, ack: INCIDENT_ACK }, incident).map((m) => m.field),
    ['intro', 'ack'],
  );
});

test('lines that name the queued track pass, including an owned substitution', () => {
  for (const line of [
    "Here's La Isla Bonita by Madonna, going out to Michael.",
    "No Michael Jackson in the crates tonight, Michael — so here's Madonna with 'La Isla Bonita'.",
    'Michael wanted the King of Pop; the closest we have is La Isla Bonita.',
    "Madonna's island classic, for Michael.",
  ]) assert.deepEqual(misnamedClaims(line, incident), [], line);
});

test('a line that names nothing at all is vague, not wrong', () => {
  for (const line of [
    'Got you, Michael — coming right up.',
    'Alright Michael, something smooth and steady for the afternoon.',
    'Smooth vibes for the afternoon, Michael.',
  ]) assert.deepEqual(misnamedClaims(line, incident), [], line);
});

test("the listener's own name is never a claim, even when it is half the artist", () => {
  assert.deepEqual(misnamedClaims('Got you, Michael!', incident), []);
  // …but the full asked-for name still is.
  assert.equal(misnamedClaims('Michael, here comes Michael Jackson.', incident)[0]?.text, 'Michael Jackson');
});

test("the station's own names are never a claim: host, guests, the station, a standalone DJ", () => {
  const ctx = { ...incident, requester: 'Jen', stationNames: ['Marlowe', 'Nova Reyes', 'SUB/WAVE'] };
  const greetings: Array<[string, string]> = [
    ['hey DJ play something chill', 'Your DJ has you covered, Jen — easing right in.'],
    ['hey DJ Marlowe, something chill', 'You got it — DJ Marlowe has you covered, Jen.'],
    ['nova reyes pick something for me', 'Okay Jen, Nova Reyes is on it.'],
    ['play something for everyone at SUB/WAVE', 'Big love to everyone listening to SUB/WAVE, Jen!'],
  ];
  for (const [requestText, line] of greetings) {
    assert.deepEqual(misnamedClaims(line, { ...ctx, requestText }), [], line);
  }
  // The names are the evidence: without them the host reads as a name.
  assert.deepEqual(
    misnamedClaims('You got it — DJ Marlowe has you covered, Jen.', { ...ctx, stationNames: [], requestText: 'hey DJ Marlowe, something chill' })
      .map((c) => c.text),
    ['DJ Marlowe'],
  );
  // An act with "DJ" in its name is still a name, and greeting the host
  // never hides the asked-for artist.
  assert.deepEqual(misnamedClaims("Here's DJ Shadow for you, Jen!", { ...ctx, requestText: 'some DJ Shadow please' }).map((c) => c.text), ['DJ Shadow']);
  assert.deepEqual(
    misnamedClaims('Marlowe here — Michael Jackson coming up, Jen!', { ...ctx, requestText: 'hey Marlowe, Michael Jackson please' }).map((c) => c.text),
    ['Michael Jackson'],
  );
});

test('a name inside a longer phrase the line repeats is still read', () => {
  // Judged whole, each shared run failed nameLike on a lowercase word ("upbeat",
  // the possessive "s") and the lie went to air unflagged.
  const ctx = { track: ISLA, requester: 'Jen', others: [] };
  assert.deepEqual(
    misnamedClaims('Some upbeat Michael Jackson coming right up!', { ...ctx, requestText: 'some upbeat Michael Jackson' }).map((c) => c.text),
    ['Michael Jackson'],
  );
  assert.deepEqual(
    misnamedClaims('Got it — some old school Michael Jackson for you!', { ...ctx, requestText: 'some old school Michael Jackson please' }).map((c) => c.text),
    ['Michael Jackson'],
  );
  assert.deepEqual(
    misnamedClaims("Here's Michael Jackson's Thriller, Jen!", { ...ctx, requestText: "play Michael Jackson's Thriller" }).map((c) => c.text),
    ['Michael Jackson', 'Thriller'],
  );
  // Still a name only where the line capitalises it.
  assert.deepEqual(misnamedClaims('some upbeat michael jackson coming up', { ...ctx, requestText: 'some upbeat Michael Jackson' }), []);
});

test("a word in the run's own genre tags is a genre, not a name", () => {
  // The commonest request is a genre, a language or a season, read back
  // capitalised in an ack that names no track.
  const myGirl = { title: 'My Girl', artist: 'The Temptations', genre: 'Soul, Motown' };
  const motown = { track: myGirl, requestText: 'some motown please', requester: 'Sam', others: [] };
  assert.deepEqual(misnamedClaims('You got it, Sam — a little Motown magic coming up!', motown), []);
  assert.deepEqual(misnamedClaims('Some classic Hip Hop for you, Dee!', {
    track: { title: 'N.Y. State of Mind', artist: 'Nas', genre: 'Hip-Hop' }, requestText: 'hip hop please', requester: 'Dee',
  }), []);
  assert.deepEqual(misnamedClaims('Smooth R&B coming your way, Kim.', {
    track: { title: 'Crazy in Love', artist: 'Beyoncé', genre: 'R&B' }, requestText: 'play some r&b', requester: 'Kim',
  }), []);
  // Any candidate's tags count, word by word.
  assert.deepEqual(misnamedClaims('Got it, Raj — some Punjabi heat coming your way!', {
    track: { title: 'Softly', artist: 'Karan Aujla', genre: null }, requestText: 'punjabi songs please', requester: 'Raj',
    others: [{ title: 'Lover', artist: 'Diljit Dosanjh', genre: 'Punjabi Pop' }],
  }), []);
  // The tags are the evidence: untagged, the same word still reads as a name.
  assert.deepEqual(
    misnamedClaims('You got it, Sam — a little Motown magic coming up!', { ...motown, track: { ...myGirl, genre: 'Soul' } }).map((c) => c.text),
    ['Motown'],
  );
  // …and a genre word never hides the asked-for artist.
  assert.deepEqual(misnamedClaims("Here's Michael Jackson for you, Jen!", {
    ...incident, requester: 'Jen', track: { ...ISLA, genre: 'Pop' }, others: [{ ...HOLIDAY, genre: 'Pop, Dance' }],
  }).map((c) => c.text), ['Michael Jackson']);
});

test('an honest substitution that declines the ask is not a claim (English cues)', () => {
  // What the frame prompt asks for when the library lacks the ask, often
  // without naming the stand-in.
  const ctx = { ...incident, requester: 'Jen' };
  for (const line of [
    'No Michael Jackson in the crates tonight, Jen — but I have something close!',
    "We don't have any Michael Jackson, Jen, but this one is in the same spirit.",
    "I couldn't find Michael Jackson tonight, Jen — here's something close.",
    "Sadly Michael Jackson isn't in the library, Jen, so here is a stand-in.",
    "Jen, Michael Jackson's not in the crates tonight — this one's close.",
    'Not Michael Jackson tonight, but this one brings the same energy, Jen!',
    'Something like Michael Jackson for you, Jen!',
    'If you like Michael Jackson, Jen, this one should land.',
  ]) assert.deepEqual(misnamedClaims(line, ctx), [], line);
  // The cue must sit right against the name, and "no" must decline it rather
  // than qualify a noun.
  for (const line of [
    "No Michael Jackson fan can resist this — here's Billie Jean, Jen!",
    "No problem, Jen — here's Michael Jackson!",
    'No doubt about it, Michael Jackson is the king — here he is, Jen!',
    "I didn't have to look far: Michael Jackson, coming up for Jen!",
  ]) assert.equal(misnamedClaims(line, ctx)[0]?.text, 'Michael Jackson', line);
  // Only the listener's own words are excused: a quoted title is still a claim.
  assert.deepEqual(misnamedClaims("No 'Billie Jean' tonight, Jen.", ctx), [{ source: 'quoted-title', text: 'Billie Jean' }]);
  // English only: another language's decline still reads as a claim.
  assert.equal(misnamedClaims('No tenemos a Michael Jackson esta noche, Jen.', ctx)[0]?.text, 'Michael Jackson');
});

test('every known lie is still caught after the tightening', () => {
  // The verification probe's lies, each over a track it does not describe.
  const dreams = { title: 'Dreams', artist: 'Fleetwood Mac', genre: 'Rock' };
  const myGirl = { title: 'My Girl', artist: 'The Temptations', genre: 'Soul, Motown' };
  const stationNames = ['Marlowe', 'SUB/WAVE'];
  const lies: Array<[Record<string, unknown>, string]> = [
    [{ track: ISLA, requestText: 'Michael Jackson please', requester: 'Jen' }, "Here's Michael Jackson for you, Jen!"],
    [{ track: myGirl, requestText: 'some motown please', requester: 'Sam', others: [{ title: "Ain't No Mountain High Enough", artist: 'Marvin Gaye' }] }, "Here's Marvin Gaye for you, Sam!"],
    [{ track: dreams, requestText: 'play Wonderwall', requester: 'Liam' }, "Here's 'Wonderwall', Liam."],
    [{ track: dreams, requestText: 'play wonderwall by oasis', requester: 'Liam' }, 'Oasis coming right up with Wonderwall, Liam!'],
    [{ track: ISLA, requestText: 'some upbeat Michael Jackson', requester: 'Jen' }, 'Some upbeat Michael Jackson coming right up!'],
    [{ track: ISLA, requestText: 'some old school Michael Jackson please', requester: 'Jen' }, 'Got it — some old school Michael Jackson for you!'],
    [{ track: ISLA, requestText: "play Michael Jackson's Thriller", requester: 'Jen' }, "Here's Michael Jackson's Thriller, Jen!"],
    [{ track: ISLA, requestText: 'any Michael Jackson song', requester: 'Jen' }, "Here's a Michael Jackson song for you!"],
    [incident, INCIDENT_INTRO],
    [incident, INCIDENT_ACK],
    [{ track: ISLA, requestText: 'Michael Jackson please', requester: 'Jen' }, "Something like Michael Jackson? Here's Michael Jackson, Jen!"],
  ];
  for (const [ctx, line] of lies) {
    assert.notDeepEqual(misnamedClaims(line, { stationNames, ...ctx } as never), [], line);
  }
});

test('a dedication in the request is excused once the line names the track', () => {
  const ctx = { track: ISLA, requestText: 'Madonna for my friend Sarah Jones please', requester: 'Tom', others: [] };
  assert.deepEqual(misnamedClaims('This one is for Sarah Jones, with love from Madonna.', ctx), []);
  assert.deepEqual(misnamedClaims('This one is for Sarah Jones — La Isla Bonita.', ctx), []);
});

test('"The" prefixes, diacritics and featured credits all ground the line', () => {
  const beatles = { title: 'Hey Jude', artist: 'The Beatles' };
  assert.deepEqual(misnamedClaims("Here's the Beatles for you.", { track: beatles, requestText: 'beatles please' }), []);
  assert.deepEqual(misnamedClaims('Beatles, as asked — enjoy.', { track: beatles, requestText: 'the beatles' }), []);

  const halo = { title: 'Halo', artist: 'Beyoncé' };
  assert.deepEqual(misnamedClaims("Here's Beyonce for you, Sam.", { track: halo, requestText: 'beyonce', requester: 'Sam' }), []);

  const umbrella = { title: 'Umbrella (feat. JAY-Z)', artist: 'Rihanna feat. Jay-Z' };
  const ctx = { track: umbrella, requestText: 'some Jay-Z please' };
  assert.deepEqual(misnamedClaims('Jay-Z and Rihanna, keeping you dry.', ctx), []);
  assert.equal(lineClaims('Here is Umbrella for you.', ctx).titleNamed, true, 'the title without its credit tail grounds it');
});

test('a cover is not a mismatch: naming the song grounds a line that credits its writer', () => {
  const cover = { title: 'Hallelujah', artist: 'Jeff Buckley' };
  const ctx = { track: cover, requestText: 'Hallelujah by Leonard Cohen please' };
  assert.deepEqual(misnamedClaims("Here's Leonard Cohen's Hallelujah, the way Jeff Buckley sang it.", ctx), []);
  assert.deepEqual(misnamedClaims("Leonard Cohen's Hallelujah, coming right up.", ctx), []);
});

test('a title tail never hides the queued track', () => {
  const remaster = { title: 'La Isla Bonita (Remastered 2009)', artist: 'Madonna' };
  assert.deepEqual(misnamedClaims("Here's 'La Isla Bonita' for Michael.", { ...incident, track: remaster }), []);
  const dash = { title: 'Billie Jean - Single Version', artist: 'Michael Jackson' };
  assert.deepEqual(misnamedClaims("Michael Jackson with 'Billie Jean'.", { ...incident, track: dash }), []);
});

test('another candidate named instead of the queued one is caught (id mix-up)', () => {
  assert.deepEqual(misnamedClaims("Here's Cyndi Lauper for you!", incident), [{ source: 'candidate-artist', text: 'Cyndi Lauper' }]);
  assert.deepEqual(misnamedClaims('Here is Girls Just Want to Have Fun!', incident), [{ source: 'candidate-title', text: 'Girls Just Want to Have Fun' }]);
  // Naming the queued artist excuses a comparison with another one.
  assert.deepEqual(misnamedClaims('If Cyndi Lauper is your thing, Madonna will do.', incident), []);
  // A lowercase common word is never a candidate's title.
  assert.deepEqual(misnamedClaims('A holiday feeling for the afternoon.', incident), []);
});

test('the right artist with a wrong quoted title is still wrong', () => {
  assert.deepEqual(misnamedClaims("Here's Madonna with 'Like a Prayer'.", incident), [{ source: 'quoted-title', text: 'Like a Prayer' }]);
  assert.deepEqual(misnamedClaims('Here\'s Madonna with "Like a Prayer".', incident), [{ source: 'quoted-title', text: 'Like a Prayer' }]);
  // The album may be quoted; so may a listener's lowercase phrase; apostrophes never open a quote.
  assert.deepEqual(misnamedClaims("From Madonna's 'True Blue' album, here she is.", incident), []);
  assert.deepEqual(misnamedClaims("You wanted 'something to dance to' — here's Madonna.", incident), []);
  assert.deepEqual(misnamedClaims("Here's Madonna's 'Don't Stop' mood, from the '80s.", { ...incident, others: [] }).map((c) => c.text), ["Don't Stop"]);
});

test('caseless scripts and lowercase lines never raise a claim', () => {
  const punjabi = { title: 'Softly', artist: 'Karan Aujla' };
  assert.deepEqual(misnamedClaims('ਦਿਲਜੀਤ ਦੋਸਾਂਝ ਦਾ ਗੀਤ', { track: punjabi, requestText: 'ਦਿਲਜੀਤ ਦੋਸਾਂਝ' }), []);
  assert.deepEqual(misnamedClaims('here is michael jackson for you', incident), []);
});

test('the lookup the agent skipped: the longest request claim, only when nothing was searched', () => {
  const misnamed = misnamedRequestLines({ intro: INCIDENT_INTRO, ack: INCIDENT_ACK }, incident);
  assert.equal(claimLookupQuery(misnamed, [{ name: 'tracksLikeThis' }]), 'Michael Jackson');
  assert.equal(claimLookupQuery(misnamed, []), 'Michael Jackson');
  assert.equal(claimLookupQuery(misnamed, [{ name: 'tracksLikeThis' }, { name: 'searchLibrary' }]), null);
  assert.equal(claimLookupQuery(misnamed, [{ name: 'topSongsByArtist' }]), null);
  // A mix-up between candidates is not a missed search.
  const mixUp = misnamedRequestLines({ intro: "Here's Cyndi Lauper!" }, incident);
  assert.equal(claimLookupQuery(mixUp, []), null);
});

test('only a misnamed intro earns the corrective re-pick', () => {
  const both = misnamedRequestLines({ intro: INCIDENT_INTRO, ack: INCIDENT_ACK }, incident);
  assert.equal(claimEarnsRepick(both), true);
  assert.equal(claimEarnsRepick(both.filter((m) => m.field === 'ack')), false);
  assert.equal(claimEarnsRepick([]), false);
});

test('plain copy names the queued track from metadata, and the listener only by a real name', () => {
  assert.equal(plainRequestIntro(ISLA, 'Michael'), "Here's La Isla Bonita by Madonna, for Michael.");
  assert.equal(plainRequestIntro(ISLA, 'anon'), "Here's La Isla Bonita by Madonna.");
  assert.equal(plainRequestAck(ISLA, 'Michael'), 'Coming up for you, Michael: La Isla Bonita by Madonna.');
  assert.equal(plainRequestAck({ title: 'Untitled' }, ''), 'Coming up for you: Untitled.');
  // Plain copy can never fail its own check.
  assert.deepEqual(misnamedRequestLines({ intro: plainRequestIntro(ISLA, 'Michael'), ack: plainRequestAck(ISLA, 'Michael') }, incident), []);
});

test('the spoken plain intro is composed English, so it follows announceLine\'s gate', () => {
  // '' is the caller's signal to have the model write it instead.
  assert.equal(plainRequestIntro(ISLA, 'Michael', { language: 'Spanish' }), '');
  assert.equal(plainRequestIntro({ title: '稻香', artist: '周杰倫' }, 'Michael', { language: 'English' }), '');
  assert.equal(plainRequestIntro(ISLA, 'Michael', { language: 'english' }), "Here's La Isla Bonita by Madonna, for Michael.");
  // A name the English voice can't read is left out, not the line.
  assert.equal(plainRequestIntro(ISLA, '小明', null), "Here's La Isla Bonita by Madonna.");
});

// --- stand-ins (#1979) ------------------------------------------------------------
//
// A request is exempt from artist spacing; a STAND-IN for an ask the library
// could not meet is not. The evidence is the run's own lines; anything the
// request's words name is never a stand-in.

const ELVIS = { id: 'elvis-minds', title: 'Suspicious Minds', artist: 'Elvis Presley', album: 'From Elvis in Memphis' };
const SOMETHING = { id: 'beatles-something', title: 'Something', artist: 'The Beatles', album: 'Abbey Road' };
const standInFor = (track: any, requestText: string, ...lines: string[]) =>
  requestStandIn(lines, { track, requestText, requester: 'Michael', others: [ISLA, HOLIDAY, GIRLS, BILLIE].filter((c) => c.id !== track.id) });

test('a stand-in is told by its own lines: an owned substitution, or the #1918 lie', () => {
  assert.equal(standInFor(ISLA, 'Michael Jackson please', INCIDENT_INTRO, INCIDENT_ACK), true, 'the lie names the ask over Madonna');
  assert.equal(standInFor(ISLA, 'Michael Jackson please', "No Michael Jackson in the crates tonight, Michael — here's Madonna with 'La Isla Bonita'."), true);
  assert.equal(standInFor(HOLIDAY, 'Michael Jackson please', "Couldn't find Michael Jackson, Michael — closest I have!"), true);
  // A listener who typed in lower case is read through the model's capitals.
  assert.equal(standInFor(ISLA, 'michael jackson pls', "No Michael Jackson tonight, Michael — here's La Isla Bonita."), true);
  // A plain-copy line names nothing; the replaced lie is still evidence.
  assert.equal(standInFor(HOLIDAY, 'Michael Jackson please', "Here's Holiday by Madonna, for Michael.", INCIDENT_INTRO), true);
  // "Something like X" is a reference, and a track by someone else stands in.
  assert.equal(standInFor(GIRLS, 'something like Madonna', "If you like Madonna, here's Cyndi Lauper."), true);
});

test("what the listener asked for is never a stand-in, however it is spelled or found", () => {
  // The re-pick landed the ask: the lie written for Madonna names this track.
  assert.equal(standInFor(BILLIE, 'Michael Jackson please', INCIDENT_INTRO, INCIDENT_ACK), false);
  assert.equal(standInFor(HOLIDAY, 'Madonna please', "Here's more Madonna — Holiday, for Michael."), false);
  assert.equal(standInFor(HOLIDAY, 'madonna please', 'More Madonna coming up!'), false);
  // Two asks, one met: declining the other does not make this one a stand-in.
  assert.equal(standInFor(HOLIDAY, 'madonna or michael jackson', "No Michael Jackson tonight — here's Madonna with Holiday."), false);
  // A nickname the line reads back over the track it names is excused.
  assert.equal(standInFor(BILLIE, 'more MJ please', "Here's MJ with Billie Jean."), false);
  // One word of the credit is the artist.
  assert.equal(standInFor(ELVIS, 'some Elvis please', "Here's some Elvis for you, Michael."), false);
  // The album, and a title, asked for in the listener's words.
  assert.equal(standInFor(BILLIE, 'something off thriller', 'No Thriller deep cuts tonight, but…'), false);
});

test('a request that names nothing is never a stand-in', () => {
  assert.equal(standInFor(HOLIDAY, 'more of this please', "More of the same, Michael — here's Holiday."), false);
  assert.equal(standInFor(HOLIDAY, 'something chill', "Can't do chill, but here's Holiday."), false);
  // A substitution owned without a name is an accepted miss.
  assert.equal(standInFor(ISLA, 'Michael Jackson please', "Can't do that one, Michael — here's La Isla Bonita."), false);
});

test('who a request is for, and the feel or the day it asks for, are never the ask', () => {
  // Each line reads a capitalised word of the listener's back over a track it
  // does not name — the #1918 lie's shape — but the word names no music.
  for (const [text, line] of [
    ['more of this for Sarah please', "This one's for Sarah, Michael!"],
    ['something upbeat for my friend Sarah Jones', 'Something upbeat for your friend Sarah Jones!'],
    ['can you dedicate this to Priya', 'Dedicated to Priya, with love!'],
    ['shout out to the Night Shift crew', 'Big shout out to the Night Shift crew!'],
    ['happy birthday Sarah!', 'A very happy birthday to Sarah from all of us!'],
    ["it's Sarah's birthday, something fun", "Something fun for Sarah's big day!"],
    ['some Friday vibes please', 'Here are your Friday vibes, Michael!'],
    ['some Bollywood vibes please', 'Here are your Bollywood vibes, Michael!'],
    ['happy friday! keep it going', 'Happy Friday to you too, Michael — keep it going!'],
    ["it's friday, more of this", "It's Friday, Michael — more coming up."],
  ]) {
    assert.equal(standInFor(HOLIDAY, text, line), false, text);
  }
  // The ask beside a dedication is still the ask.
  assert.equal(standInFor(ISLA, 'Michael Jackson for Sarah please', "No Michael Jackson tonight, but this one's for Sarah!"), true);
  assert.equal(standInFor(ISLA, 'for Sarah, some Michael Jackson', "Here's Michael Jackson for Sarah!"), true);
  assert.equal(standInFor(ISLA, 'dedicate some Michael Jackson to Sarah', "Couldn't find Michael Jackson — this one's for Sarah."), true);
});

test("an ask's own \"for\" names what it wants; a dedication's names who it is for", () => {
  // The incident through the "for" of a verb that cannot introduce a person:
  // still a stand-in, under the lie and under an honest decline alike.
  for (const text of [
    'looking for Michael Jackson please',
    'in the mood for Michael Jackson',
    'craving for Michael Jackson',
    'hoping for Michael Jackson tonight',
  ]) {
    assert.equal(standInFor(ISLA, text, INCIDENT_INTRO, INCIDENT_ACK), true, text);
    assert.equal(standInFor(ISLA, text, "No Michael Jackson tonight — here's Madonna."), true, `${text}, declined`);
  }
  // A dedication's "for" stays exempt, including one after an ask's.
  for (const [text, line] of [
    ['something upbeat for Sarah', 'Something upbeat for Sarah!'],
    ['a song for Sarah please', 'A song for Sarah, coming up!'],
    ['looking for something fun for Sarah', 'Something fun for Sarah, Michael!'],
    ['asking for a tune for my friend Sarah Jones', 'A tune for your friend Sarah Jones!'],
  ]) {
    assert.equal(standInFor(HOLIDAY, text, line), false, text);
  }
  // "Asking for" and "a request for" name a person as often as an artist, so
  // their "for" stays a dedication: the person read back is no ask.
  for (const text of [
    'a request for my wife Sarah please',
    'asking for my friend Sarah, something upbeat please',
    'asking for Sarah, something upbeat',
    'a request for Sarah, something upbeat',
    'requesting for Sarah, she loves upbeat stuff',
    'something upbeat for Sarah',
  ]) {
    assert.equal(standInFor(HOLIDAY, text, "This one's for Sarah!"), false, text);
  }
});

test('an ask that points at what is playing names the on-air artist, whatever else the line reads back', () => {
  const DANCETERIA_ON_AIR = { title: 'Danceteria', artist: 'Madonna', album: 'Iconic By Mistake' };
  const pointed = (track: any, requestText: string, line: string, onAir: any = DANCETERIA_ON_AIR, requester: string | null = 'Jen') =>
    requestStandIn([line], { track, requestText, requester, onAir, others: [ISLA, HOLIDAY, GIRLS].filter((c) => c.id !== track.id) });
  // A greeting, a place, a self-introduction, a chant, an occasion: each line
  // reads a capitalised word of the listener's back over a track it does not
  // name, which the line reading alone takes for the #1918 lie.
  for (const [text, line, requester] of [
    ['greetings from Leeds, more of this please', 'Greetings back to Leeds, Jen!'],
    ['hello from Toronto! more of this', 'Hello Toronto — more coming up!'],
    ['love from London, more like this', 'Love back to London, Jen!'],
    ["hey it's Jen, more of this please", 'You got it, Jen!', null],
    ['more of this please, Go Arsenal!', 'Up the Arsenal, Jen — more coming!'],
    ['Merry Christmas everyone! more of this', 'Merry Christmas to you too, Jen!'],
    ['same again please, big love from Leeds', 'Big love to Leeds, Jen!'],
    ['another one like this, big up Leeds!', 'Big up Leeds, Jen!'],
    ["keep 'em coming! Hi from Glasgow", 'Hi Glasgow!'],
  ] as Array<[string, string, (string | null)?]>) {
    const who = requester === undefined ? 'Jen' : requester;
    assert.equal(pointed(HOLIDAY, text, line, null, who), true, `${text}: the line reading alone spaces it`);
    assert.equal(pointed(HOLIDAY, text, line, DANCETERIA_ON_AIR, who), false, text);
  }
  // Only the on-air credit is excused: another artist's track still answers
  // to its lines.
  assert.equal(pointed(GIRLS, 'greetings from Leeds, more of this please', 'Greetings back to Leeds, Jen!'), true);
  // Before a capital, "that" is a determiner and the name is the ask; "no more
  // of this" points away. Both stay the incident.
  const declineMJ = "No Michael Jackson tonight — here's Madonna.";
  assert.equal(pointed(ISLA, 'more of that Michael Jackson please', declineMJ), true);
  assert.equal(pointed(ISLA, 'no more of this, Michael Jackson please', declineMJ), true);
  assert.equal(pointed(ISLA, 'Michael Jackson please', declineMJ), true);
  // A line that declines a name of the listener's says they asked for someone
  // else, so the on-air artist stays a stand-in beside a pointing cue.
  for (const text of [
    'keep it going with some Michael Jackson',
    'more of this, Michael Jackson please',
    'something like that by Michael Jackson',
  ]) {
    assert.equal(pointed(ISLA, text, declineMJ, null), true, `${text}: the line reading alone spaces it`);
    assert.equal(pointed(ISLA, text, declineMJ), true, text);
  }
  // A lone "I" is no name.
  assert.equal(pointed(HOLIDAY, 'more of this I love it, greetings from Leeds', 'Greetings back to Leeds, Jen!'), false);
});

test("asksForTrack: the request's words name the track, case-blind", () => {
  assert.equal(asksForTrack('play billie jean', BILLIE), true, 'title');
  assert.equal(asksForTrack('anything from Thriller', BILLIE), true, 'album');
  assert.equal(asksForTrack('some jackson please', BILLIE), true, 'one word of the credit');
  assert.equal(asksForTrack('Beatles please', SOMETHING), true, '"The"-less credit');
  assert.equal(asksForTrack('Michael Jackson please', ISLA), false);
  assert.equal(asksForTrack('play something by Michael Jackson', SOMETHING), false, 'a lone request word is not a title');
  assert.equal(asksForTrack('', BILLIE), false);
});

test('asksForTrack reads the listener\'s spelling: initials and a letter off, never a near-miss filler word', () => {
  assert.equal(asksForTrack('more MJ please', BILLIE), true, 'initials');
  assert.equal(asksForTrack('M.J. please', BILLIE), true, 'initials spelled out');
  assert.equal(asksForTrack('RHCP please', { title: 'Otherside', artist: 'Red Hot Chili Peppers' }), true);
  assert.equal(asksForTrack('some EWF', { title: 'September', artist: 'Earth, Wind & Fire' }), true, 'connectives skipped');
  assert.equal(asksForTrack('some Madona please', HOLIDAY), true, 'a letter dropped');
  assert.equal(asksForTrack('Micheal Jakson please', BILLIE), true, 'a swapped pair, a letter dropped');
  assert.equal(asksForTrack('play bilie jean', BILLIE), true, 'a title a letter off');
  assert.equal(asksForTrack('more Moosewala please', { title: 'So High', artist: 'Sidhu Moose Wala' }), true, 'a credit written as one word');
  assert.equal(asksForTrack('some fleetwoodmac', { title: 'Dreams', artist: 'Fleetwood Mac' }), true, 'the whole credit, joined');
  // Still no: what the incident asked for is not Madonna, by any spelling rule.
  assert.equal(asksForTrack('Michael Jackson please', ISLA), false);
  assert.equal(asksForTrack('MJ please', ISLA), false);
  assert.equal(asksForTrack('play anything', { title: 'Plays', artist: 'Nobody' }), false, 'a filler word is not a misspelling');
});

test("the run's own named lookups excuse a nickname no spelling rule reaches", () => {
  const ctx = { track: ELVIS, requestText: 'more of the King please', requester: 'Jen', others: [ISLA] };
  const lines = ['More of the King, coming right up!'];
  assert.equal(requestStandIn(lines, ctx), true, 'without a lookup the line reads as a claim');
  assert.equal(requestStandIn(lines, { ...ctx, lookups: ['Elvis Presley'] }), false);
  // A lookup that names someone else excuses nothing.
  assert.equal(requestStandIn(["No Michael Jackson tonight, here's Madonna."], { ...incident, lookups: ['Michael Jackson'] }), true);
});

test('requestLookups: searches, catalogue walks, and what identifyRequestedTrack resolved', () => {
  assert.deepEqual(requestLookups([
    { name: 'searchLibrary', args: { query: 'Elvis Presley' } },
    { name: 'topSongsByArtist', args: { artist: 'Madonna' } },
    { name: 'recentByArtist', args: { artist: 'Prince' } },
    { name: 'tracksLikeThis', args: { id: 'x' } },
    { name: 'identifyRequestedTrack', args: { reference: 'that dune song' }, result: { candidates: [{ title: 'Paul\'s Dream', artist: 'Hans Zimmer' }] } },
    { name: 'toString', args: {} },
    null,
  ]), ['Elvis Presley', 'Madonna', 'Prince', "Hans Zimmer Paul's Dream"]);
  assert.deepEqual(requestLookups(undefined), []);
});

test("requestLookups: what a lookup of the listener's own words found, never its vibe neighbours", () => {
  const SO_HIGH = { id: 'smw-sohigh', title: 'So High', artist: 'Sidhu Moose Wala' };
  const CALI = { id: '2pac-cali', title: 'California Love', artist: '2Pac' };
  // The listener's spelling, resolved by the library: the credits it found.
  assert.deepEqual(requestLookups([
    { name: 'searchLibrary', args: { query: 'Moosewala' }, result: [SO_HIGH] },
    { name: 'topSongsByArtist', args: { artist: 'tupac' }, result: [CALI] },
  ], 'more Moosewala and Tupac please'), ['Moosewala', 'Sidhu Moose Wala', 'tupac', '2Pac']);
  // A filtered literal hit still names the library's spelling.
  assert.deepEqual(requestLookups([
    { name: 'recentByArtist', args: { artist: 'Moosewala' }, result: { tracks: [SO_HIGH], note: 'n' } },
  ], 'more Moosewala please'), ['Moosewala', 'Sidhu Moose Wala']);
  // searchLibrary's vibe fallback found lookalikes, not the ask: the #1918
  // shape, an absent artist whose neighbours include the one on air.
  assert.deepEqual(requestLookups([
    { name: 'searchLibrary', args: { query: 'Michael Jackson' }, result: { tracks: [ISLA, HOLIDAY], via: 'vibe' } },
  ], 'Michael Jackson please'), ['Michael Jackson']);
  // A query the listener never wrote finds nothing of theirs.
  assert.deepEqual(requestLookups([
    { name: 'searchLibrary', args: { query: 'dance pop' }, result: [ISLA, GIRLS] },
  ], 'Michael Jackson please'), ['dance pop']);
  // Without the request text, only the queries.
  assert.deepEqual(requestLookups([{ name: 'searchLibrary', args: { query: 'Moosewala' }, result: [SO_HIGH] }]), ['Moosewala']);
});

test('a stand-in the run found by a lookup of other words, or by feel, is still a stand-in', () => {
  const honest = ["No Michael Jackson in the crates tonight — here's Madonna with 'La Isla Bonita'."];
  for (const toolCalls of [
    [{ name: 'searchLibrary', args: { query: 'Michael Jackson' }, result: { tracks: [ISLA, HOLIDAY], via: 'vibe' } }],
    [{ name: 'searchLibrary', args: { query: 'dance pop' }, result: [ISLA, GIRLS] }],
  ]) {
    assert.equal(requestStandIn(honest, { ...incident, lookups: requestLookups(toolCalls, incident.requestText) }), true);
  }
});

// --- the stateless cascade's stand-ins (#1993) -----------------------------------
//
// routes/request.ts draws from a pool before any line is written, so its
// evidence is the matcher's reading: the artist and the names it searched for.
// Driven through POST /request in scripts/request-cascade-spacing.test.ts.

const JANET = { id: 'janet-nasty', title: 'Nasty', artist: 'Janet Jackson', album: 'Control' };
const matchedFor = (track: any, requestText: string, ...named: Array<string | null>) =>
  matchedRequestStandIn(named, { requestText })(track);

test('the cascade: a pool track for a name the library cannot meet is a stand-in', () => {
  // The incident through the cascade: the matcher read Michael Jackson, the
  // library has none, and the pool offers someone else.
  assert.equal(matchedFor(ISLA, 'Michael Jackson please', 'Michael Jackson', 'Michael Jackson'), true);
  assert.equal(matchedFor(GIRLS, 'something like Michael Jackson', 'Michael Jackson', 'Michael Jackson'), true);
  // A title the library lacks, read without an artist.
  assert.equal(matchedFor(ISLA, 'play Billie Jean', null, 'Billie Jean'), true);
  // The ask beside a dedication is still the ask.
  assert.equal(matchedFor(ISLA, 'Michael Jackson for Sarah please', 'Michael Jackson', 'Michael Jackson'), true);
  // "Keep it going" beside a name: the matcher, handed the on-air track, read
  // the name, so the on-air artist stands in for it.
  assert.equal(matchedFor(HOLIDAY, 'keep it going with some Michael Jackson', 'Michael Jackson', 'Michael Jackson'), true);
  // A term the matcher copied with the listener's filler still names the ask.
  // (Past the token cap the route reads no names at all: the whole request is
  // the one term there, and no dedication slot can hold it.)
  assert.equal(matchedFor(ISLA, 'Michael Jackson please', null, 'Michael Jackson please'), true);
});

test('the cascade: what the matcher or the listener named is never a stand-in', () => {
  assert.equal(matchedFor(BILLIE, 'Michael Jackson please', 'Michael Jackson', 'Michael Jackson'), false);
  assert.equal(matchedFor(BILLIE, 'play Billie Jean', null, 'Billie Jean'), false);
  // A nickname the matcher resolved with the world knowledge this module lacks…
  assert.equal(matchedFor(ELVIS, 'more of the King please', 'Elvis Presley', 'Elvis Presley'), false);
  // …and one it read back as written, met through the listener's words.
  assert.equal(matchedFor(BILLIE, 'more MJ please', 'MJ', 'MJ'), false);
  assert.equal(matchedFor(HOLIDAY, 'some Madona please', 'Madona', 'Madona'), false);
  // "More of this", which the matcher reads as the on-air artist.
  assert.equal(matchedFor(HOLIDAY, 'more of this please', 'Madonna', 'Madonna'), false);
  // A wide excusal, the safe direction: one credit word shared by chance.
  assert.equal(matchedFor(JANET, 'Michael Jackson please', 'Michael Jackson', 'Michael Jackson'), false);
});

test('the cascade: an ask naming no music has nothing to stand in for', () => {
  for (const text of ['something chill', 'more of this please', 'some punjabi please', 'anything in Turkish']) {
    assert.equal(matchedFor(HOLIDAY, text, null), false, text);
    assert.equal(matchedFor(HOLIDAY, text), false, `${text}, nothing named`);
  }
  // A name the matcher read out of a dedication, a feel or a day is no ask.
  assert.equal(matchedFor(HOLIDAY, 'something upbeat for Sarah', 'Sarah', 'Sarah'), false);
  assert.equal(matchedFor(HOLIDAY, 'happy birthday Sarah Jones!', null, 'Sarah Jones'), false);
  assert.equal(matchedFor(HOLIDAY, 'some Friday vibes please', null, 'Friday'), false);
  assert.equal(matchedFor(HOLIDAY, "it's friday, more of this", null, 'Friday'), false);
});

test('the cascade: what a search in the listener\'s own spelling found is the ask (#1993 review)', () => {
  const CHANGES = { id: '2pac-changes', title: 'Changes', artist: '2Pac', album: 'Greatest Hits' };
  const SO_WHAT = { id: 'pink-so-what', title: 'So What', artist: 'P!nk', album: 'Funhouse' };
  // The matcher copied the listener's spelling and the library answered in its
  // own, which no spelling rule reaches: alone, these read as stand-ins.
  assert.equal(matchedFor(CHANGES, 'play some Tupac', 'Tupac', 'Tupac'), true);
  assert.equal(matchedFor(SO_WHAT, 'play pink please', 'Pink', 'Pink'), true);
  // What 2c's search for those words returned names the ask in the library's
  // spelling, as a lookup in the listener's words does on the agent path.
  const tupac = matchedRequestLookups([{ term: 'Tupac', hits: [CHANGES] }], 'play some Tupac');
  assert.deepEqual(tupac, ['2Pac']);
  assert.equal(matchedRequestStandIn(['Tupac', 'Tupac'], { requestText: 'play some Tupac', lookups: tupac })(CHANGES), false);
  const pink = matchedRequestLookups([{ term: 'Pink', hits: [SO_WHAT, null] }, { term: 'Funhouse', hits: null }], 'play pink please');
  assert.deepEqual(pink, ['P!nk']);
  assert.equal(matchedRequestStandIn(['Pink', 'Pink'], { requestText: 'play pink please', lookups: pink })(SO_WHAT), false);
  // A term in the matcher's own words is not the listener's spelling, so what
  // its search found names only itself.
  assert.deepEqual(matchedRequestLookups([{ term: 'Billie Jean', hits: [ISLA] }], 'that MJ one about the kid'), []);
  // A lookup only ever excuses: a search for a dedication's name found an
  // artist, and the ask still names no music.
  assert.equal(
    matchedRequestStandIn([null, 'Sarah'], { requestText: 'something upbeat for Sarah', lookups: ['Sarah McLachlan'] })(HOLIDAY),
    false,
  );
});

test('the cascade: "more of this" the matcher read as the on-air track names its credit (#1993 review)', () => {
  const reading = (requestText: string, ...named: Array<string | null>) =>
    matchedRequestStandIn(named, { requestText, onAir: HOLIDAY });
  // The on-air title as the only term: the on-air artist is the ask.
  assert.equal(reading('more like this please', null, 'Holiday')(ISLA), false);
  // The request copied whole by a weak matcher points at the on-air track and
  // names nothing else — the token cap's shape, from the live matcher.
  assert.equal(reading('something like this for Sarah', null, 'something like this for Sarah')(ISLA), false);
  assert.equal(matchedFor(ISLA, 'more of this please', null, 'more of this please'), false);
  // A name beside the cue asked for someone else, so the on-air artist still
  // stands in for it…
  assert.equal(reading('keep it going with some Michael Jackson', 'Michael Jackson', 'Michael Jackson')(ISLA), true);
  assert.equal(reading('more like this, but Michael Jackson', null, 'Holiday', 'Michael Jackson')(ISLA), true);
  // …and the on-air title asked for without a cue is that one song.
  assert.equal(reading('play Holiday please', null, 'Holiday')(ISLA), true);
});

test('the cascade: the reading is built once per request, then asked of each track (#1993 review)', () => {
  let reads = 0;
  const named = { *[Symbol.iterator]() { reads++; yield 'Michael Jackson'; } };
  const isStandIn = matchedRequestStandIn(named, { requestText: 'Michael Jackson please' });
  assert.deepEqual([ISLA, BILLIE, GIRLS, HOLIDAY].map(isStandIn), [true, false, true, true]);
  assert.equal(reads, 1, 'the names are read when the reading is built, not per track');
});

// --- the remedy, through runRequest ---------------------------------------------

// `text` answers a plain-text call (no tools offered: generateIntro) without
// spending a scripted object reply.
type Scripted = { llm: Array<unknown | Error>; search?: any[]; text?: string };
type Calls = { llm: any[]; search: string[] };

// Routes every fetch: the corrective re-pick's model call (openai-compatible
// fixture, answered in order from `llm`) and the music server's search3.
async function withNetwork<T>(script: Scripted, fn: (calls: Calls) => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  const calls: Calls = { llm: [], search: [] };
  const replies = [...script.llm];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // searchLibrary's vibe fallback asks the same base for an embedding on an
    // empty search3; only chat completions are scripted.
    if (url.startsWith('http://127.0.0.1:9/') && !url.includes('/chat/completions')) {
      return new Response('no embeddings here', { status: 404 });
    }
    if (url.startsWith('http://127.0.0.1:9/')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      calls.llm.push(body);
      if (script.text !== undefined && !(Array.isArray(body?.tools) && body.tools.length)) {
        return chatCompletionResponse({ message: { role: 'assistant', content: script.text } });
      }
      const reply = replies.shift();
      if (reply === undefined || reply instanceof Error) return new Response('model down', { status: 400 });
      const tools = Array.isArray(body?.tools) ? body.tools : [];
      return chatCompletionResponse({
        message: tools.length
          ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: tools[0].function.name, arguments: JSON.stringify(reply) } }] }
          : { role: 'assistant', content: JSON.stringify(reply) },
      });
    }
    if (url.includes('/rest/search3')) {
      calls.search.push(new URL(url).searchParams.get('query') ?? '');
      return Response.json({ 'subsonic-response': { status: 'ok', version: '1.16.1', searchResult3: { song: script.search ?? [] } } });
    }
    return Response.json({ 'subsonic-response': { status: 'ok', version: '1.16.1' } });
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = realFetch;
  }
}

const realRequestRun = requestAgent.run;

function agentAnswers(object: Record<string, unknown>, seen: any[], toolCalls: any[] = [{ name: 'tracksLikeThis', args: {}, result: [], round: 1 }]) {
  requestAgent.run = (async () => ({
    object, steps: 1, toolCalls, extras: { seen: new Map(seen.map((s) => [s.id, s])) },
  })) as any;
}

await settings.load();

beforeEach(async () => {
  requestAgent.run = realRequestRun;
  queue.senderBusy = true;
  queue.upcoming = [];
  queue.current = null;
  queue.history = [];
  queue.djLog = [];
  await settings.update({
    llm: {
      pickerAgent: true, requestMatching: 'agentic',
      provider: 'openai-compatible', model: 'fixture-model', compatibleMode: 'local',
      baseUrl: 'http://127.0.0.1:9/v1', fallback: { enabled: false },
    },
    tts: { enabled: true },
  } as never);
  session.start({
    at: new Date().toISOString(), time: { period: 'day', vibe: 'day', mood: 'calm' },
    weather: null, festival: null, dominantMood: 'calm', activeShow: null,
  } as any);
});

after(async () => {
  requestAgent.run = realRequestRun;
  queue.senderBusy = false;
  await new Promise((resolve) => setTimeout(resolve, 1_100));
});

test('#1918 end to end: the skipped lookup finds the artist, and the re-pick queues them with honest lines', async () => {
  agentAnswers({ kind: 'track', id: ISLA.id, ack: INCIDENT_ACK, intro: INCIDENT_INTRO }, [ISLA, HOLIDAY, GIRLS]);
  const result = await withNetwork({
    search: [BILLIE],
    llm: [{ id: BILLIE.id, ack: 'Got you, Michael — Billie Jean it is.', intro: "Michael, here's Michael Jackson with Billie Jean." }],
  }, async (calls) => {
    const out = await runRequest(queue, { requester: 'Michael', text: 'Michael Jackson please' });
    // searchLibrary may re-ask page 0 after a short random deep page; every
    // search3 is still the one lookup, for the name the lines claimed.
    assert.ok(calls.search.length >= 1);
    assert.ok(calls.search.every((q) => q === 'Michael Jackson'), calls.search.join(' | '));
    assert.equal(calls.llm.length, 1, 'exactly one corrective call');
    const prompt = JSON.stringify(calls.llm[0].messages);
    assert.match(prompt, /mj-billie/, 'the lookup hit is offered as a candidate');
    assert.match(prompt, /You chose \\"La Isla Bonita\\" by Madonna/);
    return out;
  });
  assert.equal(result?.track?.id, BILLIE.id);
  assert.equal(result?.guard, 'claim-repicked');
  assert.equal(queue.upcoming.length, 1);
  assert.equal(queue.upcoming[0].track.id, BILLIE.id);
  assert.equal(queue.upcoming[0].introScript, "Michael, here's Michael Jackson with Billie Jean.");
  assert.equal(result?.ack, 'Got you, Michael — Billie Jean it is.');
});

// The same incident through the REAL request agent loop rather than a stubbed
// run: what claimLookupQuery reads is the agent's own tool-call summary, and
// what the guard reads is the slim projection the tools put in `seen`.
test('#1918 through the real request agent: a lookup-free run is caught and re-picked', async () => {
  const realFetch = globalThis.fetch;
  const bodies: any[] = [];
  const searches: string[] = [];
  const answer = { kind: 'track', id: ISLA.id, ack: INCIDENT_ACK, intro: INCIDENT_INTRO };
  const repick = { id: BILLIE.id, ack: 'Got you, Michael — Billie Jean it is.', intro: "Michael, here's Michael Jackson with Billie Jean." };
  const subsonic = (payload: Record<string, unknown>) => Response.json({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...payload } });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/rest/getRandomSongs')) return subsonic({ randomSongs: { song: [ISLA, HOLIDAY, GIRLS] } });
    if (url.includes('/rest/search3')) {
      searches.push(new URL(url).searchParams.get('query') ?? '');
      return subsonic({ searchResult3: { song: [BILLIE] } });
    }
    if (url.startsWith('http://127.0.0.1:9/') && url.includes('/chat/completions')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      bodies.push(body);
      const names: string[] = (body.tools ?? []).map((t: any) => t.function?.name);
      const forced = body.tool_choice?.function?.name ?? null;
      const explored = (body.messages ?? []).some((m: any) => m.role === 'tool');
      // A model that only browses (the incident's one similarity call), then
      // answers with the incident's lines; the corrective object call gets
      // the honest re-pick.
      const [name, args] = forced === 'done' || (names.includes('done') && explored) ? ['done', answer]
        : names.includes('randomSongs') ? ['randomSongs', {}]
          : [forced ?? names[0], repick];
      return chatCompletionResponse({
        message: name
          ? { role: 'assistant', content: null, tool_calls: [{ id: `call_${bodies.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
          : { role: 'assistant', content: JSON.stringify(repick) },
      });
    }
    if (url.startsWith('http://127.0.0.1:9/')) return new Response('not here', { status: 404 });
    return subsonic({});
  }) as typeof fetch;
  let result: any;
  try {
    result = await runRequest(queue, { requester: 'Michael', text: 'Michael Jackson please' });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(bodies.some((b) => (b.tools ?? []).some((t: any) => t.function?.name === 'randomSongs')), 'the real tool loop ran');
  assert.ok(searches.length >= 1 && searches.every((q) => q === 'Michael Jackson'), searches.join(' | '));
  assert.equal(result?.track?.id, BILLIE.id);
  assert.equal(result?.guard, 'claim-repicked');
  assert.equal(queue.upcoming[0].introScript, repick.intro);
});

test('a re-pick that still misnames its track airs plain copy for that track', async () => {
  agentAnswers({ kind: 'track', id: ISLA.id, ack: INCIDENT_ACK, intro: INCIDENT_INTRO }, [ISLA, HOLIDAY, GIRLS]);
  const result = await withNetwork({
    search: [],
    llm: [{ id: HOLIDAY.id, ack: 'Got you, Michael — this one is fine.', intro: "Here's Michael Jackson, Michael!" }],
  }, () => runRequest(queue, { requester: 'Michael', text: 'Michael Jackson please' }));
  assert.equal(result?.track?.id, HOLIDAY.id, 'the corrected choice is kept');
  assert.equal(result?.guard, 'claim-plain');
  assert.equal(queue.upcoming[0].introScript, "Here's Holiday by Madonna, for Michael.");
  assert.equal(result?.ack, 'Got you, Michael — this one is fine.', 'a clean line is not replaced');
});

test('when the corrective call fails, the original pick airs with plain copy', async () => {
  agentAnswers({ kind: 'track', id: ISLA.id, ack: INCIDENT_ACK, intro: INCIDENT_INTRO }, [ISLA, HOLIDAY]);
  const result = await withNetwork({ search: [], llm: [new Error('down')] },
    () => runRequest(queue, { requester: 'Michael', text: 'Michael Jackson please' }));
  assert.equal(result?.track?.id, ISLA.id);
  assert.equal(result?.guard, 'claim-plain');
  assert.equal(queue.upcoming[0].track.id, ISLA.id);
  assert.equal(queue.upcoming[0].introScript, "Here's La Isla Bonita by Madonna, for Michael.");
  assert.equal(result?.ack, 'Coming up for you, Michael: La Isla Bonita by Madonna.');
});

test('a persona that speaks another language never airs the English plain copy', async () => {
  const personas = settings.get().personas;
  await settings.update({ personas: personas.map((p: any, i: number) => (i === 0 ? { ...p, language: 'Spanish' } : p)) } as never);
  try {
    agentAnswers({ kind: 'track', id: ISLA.id, ack: INCIDENT_ACK, intro: INCIDENT_INTRO }, [ISLA, HOLIDAY]);
    const spanish = 'Para Michael, aquí está Madonna con La Isla Bonita.';
    const result = await withNetwork({ search: [], llm: [new Error('down')], text: spanish },
      () => runRequest(queue, { requester: 'Michael', text: 'Michael Jackson please' }));
    assert.equal(result?.guard, 'claim-plain');
    assert.equal(queue.upcoming[0].track.id, ISLA.id);
    assert.equal(queue.upcoming[0].introScript, spanish, 'the metadata-only intro, in the persona\'s language');
  } finally {
    await settings.update({ personas } as never);
  }
});

test('a run that already searched gets no second lookup', async () => {
  agentAnswers({ kind: 'track', id: ISLA.id, ack: 'Coming up.', intro: INCIDENT_INTRO }, [ISLA, HOLIDAY],
    [{ name: 'searchLibrary', args: { query: 'Michael Jackson' }, result: [], round: 1 }]);
  await withNetwork({ search: [BILLIE], llm: [new Error('down')] }, async (calls) => {
    const result = await runRequest(queue, { requester: 'Michael', text: 'Michael Jackson please' });
    assert.deepEqual(calls.search, []);
    assert.equal(result?.ack, 'Coming up.', 'only the misnamed line is replaced');
    assert.equal(queue.upcoming[0].introScript, "Here's La Isla Bonita by Madonna, for Michael.");
  });
});

test('honest lines cost nothing: no lookup, no extra model call, words untouched', async () => {
  const intro = "No Michael Jackson in the crates, Michael — here's Madonna with 'La Isla Bonita' instead.";
  agentAnswers({ kind: 'track', id: ISLA.id, ack: 'Closest I have, Michael!', intro }, [ISLA, HOLIDAY, GIRLS]);
  await withNetwork({ search: [BILLIE], llm: [] }, async (calls) => {
    const result = await runRequest(queue, { requester: 'Michael', text: 'Michael Jackson please' });
    assert.equal(calls.llm.length, 0);
    assert.deepEqual(calls.search, []);
    assert.equal(result?.guard, null);
    assert.equal(queue.upcoming[0].introScript, intro);
  });
});

test('an ack-only misname is replaced in place: no corrective call, no lookup', async () => {
  const intro = "Here's Madonna with La Isla Bonita, Michael.";
  agentAnswers({ kind: 'track', id: ISLA.id, ack: INCIDENT_ACK, intro }, [ISLA, HOLIDAY, GIRLS]);
  await withNetwork({ search: [BILLIE], llm: [] }, async (calls) => {
    const result = await runRequest(queue, { requester: 'Michael', text: 'Michael Jackson please' });
    assert.equal(calls.llm.length, 0);
    assert.deepEqual(calls.search, []);
    assert.equal(result?.guard, 'claim-plain');
    assert.equal(result?.track?.id, ISLA.id);
    assert.equal(result?.ack, 'Coming up for you, Michael: La Isla Bonita by Madonna.');
    assert.equal(queue.upcoming[0].introScript, intro, 'the intro was fine and airs as written');
  });
});

test('with the station voice off the ack is the whole answer: a misname gets the plain ack, no call', async () => {
  await settings.update({ tts: { enabled: false } } as never);
  agentAnswers({ kind: 'track', id: ISLA.id, ack: INCIDENT_ACK }, [ISLA, HOLIDAY, GIRLS]);
  await withNetwork({ search: [BILLIE], llm: [] }, async (calls) => {
    const result = await runRequest(queue, { requester: 'Michael', text: 'Michael Jackson please' });
    assert.equal(calls.llm.length, 0);
    assert.deepEqual(calls.search, []);
    assert.equal(result?.guard, 'claim-plain');
    assert.equal(result?.ack, 'Coming up for you, Michael: La Isla Bonita by Madonna.');
    assert.equal(queue.upcoming[0].introScript ?? null, null);
  });
});

test('an honest substitution that names no stand-in keeps its words', async () => {
  const intro = 'No Michael Jackson in the crates tonight, Michael — but this one is in the same spirit.';
  agentAnswers({ kind: 'track', id: ISLA.id, ack: "Couldn't find Michael Jackson, Michael — closest I have!", intro }, [ISLA, HOLIDAY, GIRLS]);
  await withNetwork({ search: [BILLIE], llm: [] }, async (calls) => {
    const result = await runRequest(queue, { requester: 'Michael', text: 'Michael Jackson please' });
    assert.equal(calls.llm.length, 0);
    assert.deepEqual(calls.search, []);
    assert.equal(result?.guard, null);
    assert.equal(queue.upcoming[0].introScript, intro);
  });
});

test("a genre ack over a track the run tagged with it costs nothing", async () => {
  const myGirl = { id: 'temptations-girl', title: 'My Girl', artist: 'The Temptations', genre: 'Soul, Motown', duration: 165 };
  const ack = 'You got it, Sam — a little Motown magic coming up!';
  agentAnswers({ kind: 'track', id: myGirl.id, ack, intro: 'Sunshine on a cloudy day, Sam.' }, [myGirl, HOLIDAY],
    [{ name: 'songsByGenre', args: { genre: 'motown' }, result: [], round: 1 }]);
  await withNetwork({ search: [], llm: [] }, async (calls) => {
    const result = await runRequest(queue, { requester: 'Sam', text: 'some motown please' });
    assert.equal(calls.llm.length, 0);
    assert.deepEqual(calls.search, []);
    assert.equal(result?.guard, null);
    assert.equal(result?.ack, ack);
  });
});

test("greeting the on-air host and the station costs nothing", async () => {
  const host = session.onAirPersona()?.name;
  assert.ok(host, 'a seeded persona is on air');
  const ack = `Nice one, Jen — ${host} and the ${settings.get().station} crew have you covered.`;
  agentAnswers({ kind: 'track', id: ISLA.id, ack, intro: "Here's Madonna with La Isla Bonita, Jen." }, [ISLA, HOLIDAY]);
  await withNetwork({ search: [], llm: [] }, async (calls) => {
    const result = await runRequest(queue, { requester: 'Jen', text: `hey ${host}, anything good on ${settings.get().station} tonight?` });
    assert.equal(calls.llm.length, 0);
    assert.deepEqual(calls.search, []);
    assert.equal(result?.guard, null);
    assert.equal(result?.ack, ack);
  });
});

test('an unknown-id salvage already spent the one corrective call: straight to plain copy', async () => {
  agentAnswers({ kind: 'track', id: 'made-up-id-xyz', ack: 'Here we go.', intro: 'Here we go.' }, [ISLA, HOLIDAY]);
  const result = await withNetwork({
    search: [BILLIE],
    llm: [{ id: ISLA.id, ack: INCIDENT_ACK, intro: INCIDENT_INTRO }],
  }, async (calls) => {
    const out = await runRequest(queue, { requester: 'Michael', text: 'Michael Jackson please' });
    assert.equal(calls.llm.length, 1, 'the salvage call only');
    assert.deepEqual(calls.search, []);
    return out;
  });
  assert.equal(result?.track?.id, ISLA.id);
  assert.equal(result?.guard, 'claim-plain');
  assert.equal(queue.upcoming[0].introScript, "Here's La Isla Bonita by Madonna, for Michael.");
});

// --- stand-in spacing, through runRequest (#1979) ----------------------------------
//
// Madonna's "Danceteria" on air, as in the #1918 incident. A stand-in by the
// on-air artist goes through the artist guard's spacing; the listener's own
// ask never does; and the request still makes at most ONE corrective call.

const DANCETERIA = { id: 'madonna-danceteria', title: 'Danceteria', artist: 'Madonna', album: 'Iconic By Mistake', duration: 230 };
const BEAT_IT = { id: 'mj-beat-it', title: 'Beat It', artist: 'Michael Jackson', album: 'Thriller', duration: 258 };
const HONEST_INTRO = "No Michael Jackson in the crates tonight, Michael — here's Madonna with 'La Isla Bonita'.";
const CYNDI = {
  id: GIRLS.id,
  ack: 'No Michael Jackson tonight, Michael — Cyndi Lauper it is!',
  intro: "No Michael Jackson in the crates, Michael — here's Cyndi Lauper with Girls Just Want to Have Fun.",
};
const offeredIds = (body: any) => {
  const prompt = JSON.stringify(body.messages);
  return [ISLA, HOLIDAY, GIRLS, BILLIE].map((s) => s.id).filter((id) => prompt.includes(id));
};

test('#1979: an honest stand-in by the on-air artist is re-picked to a fresh artist, in one call', async () => {
  queue.current = { track: DANCETERIA } as any;
  agentAnswers({ kind: 'track', id: ISLA.id, ack: 'Closest I have, Michael!', intro: HONEST_INTRO }, [ISLA, HOLIDAY, GIRLS]);
  const result = await withNetwork({ search: [BILLIE], llm: [CYNDI] }, async (calls) => {
    const out = await runRequest(queue, { requester: 'Michael', text: 'Michael Jackson please' });
    assert.equal(calls.llm.length, 1, 'exactly one corrective call');
    assert.deepEqual(calls.search, [], 'spacing never searches');
    assert.deepEqual(offeredIds(calls.llm[0]), [GIRLS.id], 'no Madonna is offered');
    assert.match(JSON.stringify(calls.llm[0].messages), /already played in the last few slots/);
    return out;
  });
  assert.equal(result?.track?.id, GIRLS.id);
  assert.equal(result?.guard, 'artist-spaced');
  assert.equal(queue.upcoming[0].track.id, GIRLS.id);
  assert.equal(queue.upcoming[0].introScript, CYNDI.intro);
  assert.equal(result?.ack, CYNDI.ack);
});

test('#1979: the incident with no Michael Jackson in the library — the one corrective call is offered no Madonna', async () => {
  queue.current = { track: DANCETERIA } as any;
  agentAnswers({ kind: 'track', id: ISLA.id, ack: INCIDENT_ACK, intro: INCIDENT_INTRO }, [ISLA, HOLIDAY, GIRLS]);
  const result = await withNetwork({ search: [], llm: [CYNDI, CYNDI] }, async (calls) => {
    const out = await runRequest(queue, { requester: 'Michael', text: 'Michael Jackson please' });
    assert.equal(calls.llm.length, 1, 'the claim re-pick is the only call');
    assert.deepEqual(offeredIds(calls.llm[0]), [GIRLS.id]);
    return out;
  });
  assert.equal(result?.track?.id, GIRLS.id);
  assert.equal(result?.guard, 'claim-repicked');
  assert.equal(queue.upcoming[0].introScript, CYNDI.intro);
});

test('#1979: what the listener asked for is offered however recently it played', async () => {
  // Michael Jackson on air, Madonna queued after him: the lookup's Billie Jean
  // stays on offer, the Madonna stand-ins do not.
  queue.current = { track: BEAT_IT } as any;
  queue.upcoming = [{ track: DANCETERIA }] as any;
  agentAnswers({ kind: 'track', id: ISLA.id, ack: INCIDENT_ACK, intro: INCIDENT_INTRO }, [ISLA, HOLIDAY, GIRLS]);
  const billie = { id: BILLIE.id, ack: 'More Michael Jackson, Michael — Billie Jean!', intro: "Michael, here's Michael Jackson with Billie Jean." };
  const result = await withNetwork({ search: [BILLIE], llm: [billie, billie] }, async (calls) => {
    const out = await runRequest(queue, { requester: 'Michael', text: 'Michael Jackson please' });
    assert.equal(calls.llm.length, 1);
    assert.deepEqual(offeredIds(calls.llm[0]), [GIRLS.id, BILLIE.id]);
    return out;
  });
  assert.equal(result?.track?.id, BILLIE.id);
  assert.equal(result?.guard, 'claim-repicked');
  assert.equal(queue.upcoming.at(-1)?.track.id, BILLIE.id);
});

test('#1979: a genuine request for the on-air artist is never spaced, and costs nothing', async () => {
  for (const [text, intro] of [
    ['madonna please', "Here's more Madonna — Holiday, for Jen."],
    ['more of this please', "More of the same, Jen — here's Holiday."],
  ]) {
    queue.current = { track: DANCETERIA } as any;
    queue.upcoming = [];
    agentAnswers({ kind: 'track', id: HOLIDAY.id, ack: 'Coming right up, Jen!', intro }, [ISLA, HOLIDAY, GIRLS]);
    await withNetwork({ search: [], llm: [] }, async (calls) => {
      const result = await runRequest(queue, { requester: 'Jen', text });
      assert.equal(calls.llm.length, 0, text);
      assert.equal(result?.guard, null, text);
      assert.equal(queue.upcoming[0].track.id, HOLIDAY.id, text);
      assert.equal(queue.upcoming[0].introScript, intro, text);
    });
  }
});

test('#1979: a stand-in with no fresher artist in the run stays, at no cost', async () => {
  queue.current = { track: DANCETERIA } as any;
  agentAnswers({ kind: 'track', id: ISLA.id, ack: 'Closest I have, Michael!', intro: HONEST_INTRO }, [ISLA, HOLIDAY]);
  await withNetwork({ search: [], llm: [] }, async (calls) => {
    const result = await runRequest(queue, { requester: 'Michael', text: 'Michael Jackson please' });
    assert.equal(calls.llm.length, 0);
    assert.equal(result?.guard, null);
    assert.equal(queue.upcoming[0].track.id, ISLA.id);
    assert.equal(queue.upcoming[0].introScript, HONEST_INTRO);
  });
});

// The pick path's least-recent swap (#1982) answers with no ack or intro. On
// a request that would replace the listener's lines, so this guard is never
// handed distances: here the only alternative (Cyndi Lauper, on air) was heard
// longer ago than the stand-in (Madonna, queued), which is exactly the window
// a pick would swap on.
test('#1979: a stand-in whose only alternative is also recent keeps its own lines, never the pick swap', async () => {
  queue.current = { track: { id: 'cyndi-time', title: 'Time After Time', artist: 'Cyndi Lauper', album: "She's So Unusual", duration: 241 } } as any;
  queue.upcoming = [{ track: DANCETERIA }] as any;
  agentAnswers({ kind: 'track', id: ISLA.id, ack: 'Closest I have, Michael!', intro: HONEST_INTRO }, [ISLA, GIRLS]);
  await withNetwork({ search: [], llm: [] }, async (calls) => {
    const result = await runRequest(queue, { requester: 'Michael', text: 'Michael Jackson please' });
    assert.equal(calls.llm.length, 0);
    assert.equal(result?.guard, null);
    assert.equal(result?.track?.id, ISLA.id);
    assert.equal(result?.ack, 'Closest I have, Michael!');
    assert.equal(queue.upcoming.at(-1)?.track.id, ISLA.id);
    assert.equal(queue.upcoming.at(-1)?.introScript, HONEST_INTRO);
  });
  assert.ok(queue.djLog.some((e: any) => /stand-in by recently-played artist "Madonna" allowed — no fresher artist/.test(e.message)));
});

test('#1979: a spent corrective call is never spent again for spacing', async () => {
  queue.current = { track: DANCETERIA } as any;
  agentAnswers({ kind: 'track', id: ISLA.id, ack: INCIDENT_ACK, intro: INCIDENT_INTRO }, [ISLA, HOLIDAY, GIRLS]);
  // Every reply fails. djObject may try the one call more than once over HTTP,
  // so the prompts tell the calls apart: all of them are the claim re-pick's.
  const result = await withNetwork({ search: [], llm: [new Error('down')] }, async (calls) => {
    const out = await runRequest(queue, { requester: 'Michael', text: 'Michael Jackson please' });
    assert.ok(calls.llm.length >= 1);
    for (const body of calls.llm) {
      const prompt = JSON.stringify(body.messages);
      assert.match(prompt, /You chose \\"La Isla Bonita\\" by Madonna/, 'the failed claim re-pick was the call');
      assert.doesNotMatch(prompt, /already played in the last few slots/, 'no spacing re-pick followed it');
    }
    return out;
  });
  assert.equal(result?.track?.id, ISLA.id, 'the stand-in airs, as a failed spacing re-pick leaves it');
  assert.equal(result?.guard, 'claim-plain');
  assert.equal(queue.upcoming[0].introScript, "Here's La Isla Bonita by Madonna, for Michael.");
  assert.ok(queue.djLog.some((e: any) => /one corrective call is spent/.test(e.message)), 'and the booth log says why');
});

test('#1979: a spacing re-pick that misnames its track gets plain copy, not another call', async () => {
  queue.current = { track: DANCETERIA } as any;
  agentAnswers({ kind: 'track', id: ISLA.id, ack: 'Closest I have, Michael!', intro: HONEST_INTRO }, [ISLA, HOLIDAY, GIRLS]);
  const lie = { id: GIRLS.id, ack: 'Here you go, Michael!', intro: "Here's Michael Jackson, Michael!" };
  const result = await withNetwork({ search: [BILLIE], llm: [lie, CYNDI] }, async (calls) => {
    const out = await runRequest(queue, { requester: 'Michael', text: 'Michael Jackson please' });
    assert.equal(calls.llm.length, 1);
    assert.deepEqual(calls.search, []);
    return out;
  });
  assert.equal(result?.track?.id, GIRLS.id);
  assert.equal(result?.guard, 'claim-plain+artist-spaced');
  assert.equal(queue.upcoming[0].introScript, "Here's Girls Just Want to Have Fun by Cyndi Lauper, for Michael.");
  assert.equal(result?.ack, 'Here you go, Michael!');
});

test('#1979: a spacing window of 0 turns stand-in spacing off, as it does for picks', async () => {
  await settings.update({ llm: { artistVarietyWindow: 0 } } as never);
  try {
    queue.current = { track: DANCETERIA } as any;
    agentAnswers({ kind: 'track', id: ISLA.id, ack: 'Closest I have, Michael!', intro: HONEST_INTRO }, [ISLA, HOLIDAY, GIRLS]);
    await withNetwork({ search: [], llm: [CYNDI] }, async (calls) => {
      const result = await runRequest(queue, { requester: 'Michael', text: 'Michael Jackson please' });
      assert.equal(calls.llm.length, 0);
      assert.equal(result?.guard, null);
      assert.equal(queue.upcoming[0].track.id, ISLA.id);
    });
  } finally {
    await settings.update({ llm: { artistVarietyWindow: 5 } } as never);
  }
});

// A genuine ask the model reads back in the LISTENER's spelling — a nickname,
// an abbreviation, a typo — names no track by its library name, so the line
// carries the very "request claim" the #1918 lie does. The ask must still be
// the ask: never spaced, never withheld from the corrective call.
const HOUND_DOG = { id: 'elvis-hound', title: 'Hound Dog', artist: 'Elvis Presley', album: 'Elvis', duration: 136 };

test('#1979: an ask read back as a nickname or a typo is never spaced away from its artist', async () => {
  const cases: Array<{ label: string; onAir: any; text: string; pick: any; ack: string; toolCalls?: any[] }> = [
    { label: 'abbreviation', onAir: BEAT_IT, text: 'more MJ please', pick: BILLIE, ack: 'More MJ coming right up, Jen!' },
    { label: 'typo', onAir: DANCETERIA, text: 'some Madona please', pick: HOLIDAY, ack: "Here's some Madona for you, Jen!" },
    {
      label: 'nickname the run looked up by name', onAir: HOUND_DOG, text: 'more of the King please', pick: ELVIS,
      ack: 'More of the King, coming right up!',
      toolCalls: [{ name: 'searchLibrary', args: { query: 'Elvis Presley' }, result: [], round: 1 }],
    },
  ];
  for (const c of cases) {
    queue.current = { track: c.onAir } as any;
    queue.upcoming = [];
    const intro = `Here's ${c.pick.title}, Jen.`;
    agentAnswers({ kind: 'track', id: c.pick.id, ack: c.ack, intro }, [c.pick, ISLA, GIRLS].filter((s, i, a) => a.indexOf(s) === i), c.toolCalls);
    await withNetwork({ search: [], llm: [CYNDI] }, async (calls) => {
      const result = await runRequest(queue, { requester: 'Jen', text: c.text });
      assert.equal(calls.llm.length, 0, `${c.label}: no spacing call`);
      assert.equal(queue.upcoming[0].track.id, c.pick.id, `${c.label}: the ask airs`);
      assert.doesNotMatch(String(result?.guard ?? ''), /artist-spaced/, c.label);
    });
  }
});

// An alias no spelling rule reaches, which the run looked up as the listener
// wrote it: what that lookup found is the library's spelling of the ask, so
// it is the ask too. Its vibe neighbours are not (the next case).
const SMW_295 = { id: 'smw-295', title: '295', artist: 'Sidhu Moose Wala', album: 'Moosetape', duration: 270 };
const SO_HIGH = { id: 'smw-sohigh', title: 'So High', artist: 'Sidhu Moose Wala', album: 'So High', duration: 230 };
const CHANGES = { id: '2pac-changes', title: 'Changes', artist: '2Pac', album: 'Greatest Hits', duration: 269 };
const CALI = { id: '2pac-cali', title: 'California Love', artist: '2Pac', album: 'All Eyez on Me', duration: 285 };

test('#1979: an alias the run looked up in the listener\'s spelling is never spaced away from what it found', async () => {
  const cases: Array<{ label: string; onAir: any; text: string; pick: any; ack: string; toolCalls: any[] }> = [
    {
      label: 'more Moosewala', onAir: SMW_295, text: 'more Moosewala please', pick: SO_HIGH,
      ack: 'More Moosewala coming right up, Jen!',
      toolCalls: [{ name: 'searchLibrary', args: { query: 'Moosewala' }, result: [SO_HIGH], round: 1 }],
    },
    {
      // A library search for "Moosewala" may meet "Sidhu Moose Wala" only by
      // feel; the spelling rule reads it without the lookup.
      label: 'more Moosewala, found only by feel', onAir: SMW_295, text: 'more Moosewala please', pick: SO_HIGH,
      ack: 'More Moosewala coming right up, Jen!',
      toolCalls: [{ name: 'searchLibrary', args: { query: 'Moosewala' }, result: { tracks: [SO_HIGH], via: 'vibe' }, round: 1 }],
    },
    {
      label: 'more Tupac', onAir: CHANGES, text: 'more Tupac please', pick: CALI,
      ack: 'You got it — more Tupac!',
      toolCalls: [{ name: 'topSongsByArtist', args: { artist: 'Tupac' }, result: [CALI], round: 1 }],
    },
  ];
  for (const c of cases) {
    queue.current = { track: c.onAir } as any;
    queue.upcoming = [];
    const intro = `Here's ${c.pick.title}, Jen.`;
    agentAnswers({ kind: 'track', id: c.pick.id, ack: c.ack, intro }, [c.pick, ISLA, GIRLS], c.toolCalls);
    await withNetwork({ search: [], llm: [CYNDI] }, async (calls) => {
      const result = await runRequest(queue, { requester: 'Jen', text: c.text });
      assert.equal(calls.llm.length, 0, `${c.label}: no spacing call`);
      assert.equal(queue.upcoming[0].track.id, c.pick.id, `${c.label}: the ask airs`);
      assert.equal(queue.upcoming[0].introScript, intro, c.label);
      // #1918's reading still replaces the ack-only misname with the plain
      // ack, at no cost; spacing adds nothing to it.
      assert.equal(result?.guard, 'claim-plain', c.label);
    });
  }
});

// An ask naming no music, with a dedication or an occasion read back in the
// ack: the word is the listener's and the line names no track, but nothing was
// asked for that the track could stand in for.
test('#1979: an ask naming no music, read back with its dedication or its day, is never spaced', async () => {
  for (const [text, ack] of [
    ['more of this for Sarah please', "This one's for Sarah, Jen!"],
    ['some Friday vibes please', 'Here are your Friday vibes, Jen!'],
    ['a request for my wife Sarah please', "This one's for Sarah, Jen!"],
    ['asking for my friend Sarah, something upbeat', "Something upbeat — this one's for Sarah!"],
  ]) {
    queue.current = { track: DANCETERIA } as any;
    queue.upcoming = [];
    const intro = "Here's Holiday, Jen.";
    agentAnswers({ kind: 'track', id: HOLIDAY.id, ack, intro }, [HOLIDAY, ISLA, GIRLS]);
    await withNetwork({ search: [], llm: [CYNDI] }, async (calls) => {
      const result = await runRequest(queue, { requester: 'Jen', text });
      assert.equal(calls.llm.length, 0, `${text}: no spacing call`);
      assert.equal(queue.upcoming[0].track.id, HOLIDAY.id, `${text}: the pick airs`);
      assert.equal(queue.upcoming[0].introScript, intro, text);
      // #1918's reading still swaps the ack-only misname for the plain ack.
      assert.equal(result?.guard, 'claim-plain', text);
    });
  }
});

// "More of this" is answered by the on-air artist, so the answer is always
// inside the spacing window, and the ack reads back a place the listener
// greeted from. Before the on-air credit was excused this aired Cyndi Lauper
// for a corrective call (the ack), or withheld every Madonna track from the
// claim re-pick (the intro).
test('#1979: "greetings from Leeds, more of this" is never spaced away from the on-air artist', async () => {
  const text = 'greetings from Leeds, more of this please';
  queue.current = { track: DANCETERIA } as any;
  agentAnswers({ kind: 'track', id: HOLIDAY.id, ack: 'Greetings back to Leeds, Jen!', intro: "Here's Holiday, Jen." }, [HOLIDAY, ISLA, GIRLS]);
  await withNetwork({ search: [], llm: [CYNDI] }, async (calls) => {
    const result = await runRequest(queue, { requester: 'Jen', text });
    assert.equal(calls.llm.length, 0, 'no spacing call');
    assert.equal(queue.upcoming[0].track.id, HOLIDAY.id, 'more of this airs');
    assert.equal(result?.guard, 'claim-plain', "#1918's reading still swaps the ack-only misname");
  });

  // The intro misnames by #1918's reading, so the claim re-pick runs, and the
  // on-air artist is the ask, not a stand-in: it stays on offer.
  queue.current = { track: DANCETERIA } as any;
  queue.upcoming = [];
  agentAnswers({ kind: 'track', id: HOLIDAY.id, ack: 'You got it, Jen!', intro: 'Big love to Leeds, Jen — more coming up.' }, [HOLIDAY, ISLA, GIRLS]);
  const holiday = { id: HOLIDAY.id, ack: 'You got it, Jen!', intro: "Here's Holiday by Madonna, Jen." };
  await withNetwork({ search: [], llm: [holiday] }, async (calls) => {
    const result = await runRequest(queue, { requester: 'Jen', text });
    assert.equal(calls.llm.length, 1, 'the claim re-pick is the only call');
    assert.deepEqual(offeredIds(calls.llm[0]), [ISLA.id, HOLIDAY.id, GIRLS.id], 'Madonna is offered');
    assert.equal(result?.guard, 'claim-repicked');
  });
  assert.equal(queue.upcoming[0].track.id, HOLIDAY.id);
});

test("#1979: the incident's lookup that found only vibe neighbours still spaces the stand-in", async () => {
  queue.current = { track: DANCETERIA } as any;
  agentAnswers({ kind: 'track', id: ISLA.id, ack: 'Closest I have, Michael!', intro: HONEST_INTRO }, [ISLA, HOLIDAY, GIRLS], [
    { name: 'searchLibrary', args: { query: 'Michael Jackson' }, result: { tracks: [ISLA, HOLIDAY], via: 'vibe' }, round: 1 },
  ]);
  const result = await withNetwork({ search: [], llm: [CYNDI] }, async (calls) => {
    const out = await runRequest(queue, { requester: 'Michael', text: 'Michael Jackson please' });
    assert.equal(calls.llm.length, 1, 'exactly one corrective call');
    assert.deepEqual(offeredIds(calls.llm[0]), [GIRLS.id], 'no Madonna is offered');
    return out;
  });
  assert.equal(result?.track?.id, GIRLS.id);
  assert.equal(result?.guard, 'artist-spaced');
});

test('#1979: a corrective call for an ask read back as an abbreviation still offers that artist', async () => {
  queue.current = { track: BEAT_IT } as any;
  // The intro misnames by #1918's reading, so the claim re-pick runs; the MJ
  // candidate is the ask, not a stand-in, and stays on offer.
  agentAnswers({ kind: 'track', id: BILLIE.id, ack: 'You got it, Jen!', intro: "Here's some more MJ for you, Jen." }, [BILLIE, ISLA, GIRLS]);
  const billie = { id: BILLIE.id, ack: 'You got it, Jen!', intro: "Here's Billie Jean by Michael Jackson, Jen." };
  await withNetwork({ search: [], llm: [billie] }, async (calls) => {
    await runRequest(queue, { requester: 'Jen', text: 'more MJ please' });
    assert.equal(calls.llm.length, 1);
    assert.ok(offeredIds(calls.llm[0]).includes(BILLIE.id), 'the asked-for artist is offered');
  });
  assert.equal(queue.upcoming[0].track.id, BILLIE.id);
});
