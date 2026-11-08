import assert from 'node:assert/strict';
import test from 'node:test';
import { detectClaimSignal } from '../src/sleeve-notes/claim-signal.js';

const detected = (speech: string, claim: string, context: string[] = []) =>
  detectClaimSignal(speech, claim, context).status === 'detected';

test('artist and album announcements are not use of the offered fact', () => {
  assert.equal(detected('Richard Hawley with The World Looks Down.',
    'Richard Hawley was born on 17 January 1967.', ['Richard Hawley', 'The World Looks Down']), false);
  assert.equal(detected('Down a Different River by Super Furry Animals.',
    'Super Furry Animals formed in Cardiff in 1993.', ['Super Furry Animals']), false);
  assert.equal(detected('Messiah Ward from Abattoir Blues / The Lyre of Orpheus.',
    '“Abattoir Blues / The Lyre of Orpheus” was included in the 2005 edition of 1001 Albums You Must Hear Before You Die.'), false);
  assert.equal(detected('Toby Marks timeless classic gets another spin.',
    'Toby Marks was born in 1964 in South London, England.'), false);
  assert.equal(detected('Bobby Gillespie has a haunting vocal delivery.',
    'Primal Scream formed in Glasgow in 1982 by Bobby Gillespie and Jim Beattie.'), false);
});

test('recognition needs its actual publication or list', () => {
  const claim = '“Five Leaves Left” was included in the 2005 edition of 1001 Albums You Must Hear Before You Die.';
  assert.equal(detected('Five Leaves Left made it onto Rolling Stone\'s 500 Greatest Albums list.', claim), false);
  assert.equal(detected('Five Leaves Left was included in 1001 Albums You Must Hear Before You Die.', claim), true);
  assert.equal(detected('Their album was ranked number 60 in The Guardian\'s 100 Best Albums Ever.',
    '“Led Zeppelin II” was ranked number 60 in The Guardian 100 Best Albums Ever.'), true);
});

test('short factual details and modest paraphrases survive', () => {
  assert.equal(detected('They were founded in Cardiff.', 'Super Furry Animals formed in Cardiff in 1993.', ['Super Furry Animals']), true);
  assert.equal(detected('They formed in nineteen ninety-three.', 'Super Furry Animals formed in 1993.', ['Super Furry Animals']), true);
  assert.equal(detected('They formed in nineteen ninety-four.', 'Super Furry Animals formed in 1993.', ['Super Furry Animals']), false);
  assert.equal(detected('Kraftwerk were a huge influence on these guys.', 'Kraftwerk served as OMD\'s primary musical influence.'), true);
  assert.equal(detected('The song was written by Eno.', 'The song is credited to Eno for writer.'), true);
  assert.equal(detected('The album bankrupted Factory Records.', 'The album bankrupted Factory Records.'), true);
  assert.equal(detected('Patti Smith is an American poet and author.', 'Patti Smith is an American singer, songwriter, poet, and author.', ['Patti Smith']), true);
});

test('unrelated sentences, negation and unspoken cues do not establish use', () => {
  const claim = 'They formed in Cardiff in 1993.';
  assert.equal(detected('They formed a great partnership. Now Cardiff gets the weather.', claim), false);
  assert.equal(detected('They never formed in Cardiff.', claim), false);
  assert.equal(detected('[They formed in Cardiff in 1993] Here comes the music.', claim), false);
  assert.equal(detected('Here comes the music.\nNote: They formed in Cardiff in 1993.', claim), false);
});

test('sample and cover signals retain direction, including passive speech', () => {
  const sample = 'Alpha by A samples Beta by B.';
  assert.equal(detected('Alpha by A samples Beta by B.', sample), true);
  assert.equal(detected('Beta by B was sampled by Alpha by A.', sample), true);
  assert.equal(detected('Beta by B samples Alpha by A.', sample), false);
  const cover = 'Alpha by A is a cover version of Beta by B.';
  assert.equal(detected('Alpha by A is a cover version of Beta by B.', cover), true);
  assert.equal(detected('Beta by B was covered by Alpha by A.', cover), true);
  assert.equal(detected('Beta by B is a cover version of Alpha by A.', cover), false);
});

test('diagnostics retain the algorithm, reason and matching sentence', () => {
  const signal = detectClaimSignal('Now the music. They formed in Cardiff.', 'They formed in Cardiff in 1993.');
  assert.equal(signal.version, 2);
  assert.equal(signal.clause, 'They formed in Cardiff.');
  assert.deepEqual(signal.matchedTerms, ['cardiff']);
  assert.match(signal.reason, /formation/);
});

test('valid audited links survive incidental negation, apposition and release paraphrases', () => {
  assert.equal(detected('The Frank and Walters, an alternative pop band from Cork city in Ireland.',
    'The Frank and Walters are an alternative pop band from Cork city in Ireland.', ['The Frank and Walters']), true);
  assert.equal(detected('You might not be surprised to hear Kraftwerk were a huge influence on these guys.',
    'Electronic band Kraftwerk served as OMD\'s primary musical influence.'), true);
  assert.equal(detected('That one was included in the 2005 edition of 1001 Albums You Must Hear Before You Die, no less.',
    '“Tonight’s the Night” was included in the 2005 edition of 1001 Albums You Must Hear Before You Die.'), true);
  assert.equal(detected('Wasted Lands will be coming out in January of 27; the band\'s fourteenth album.',
    'The band\'s fourteenth album, Wasted Lands, will be released on January 22, 2027.'), true);
  assert.equal(detected('Their fourth album topped the UK albums chart.',
    'The release of their fourth album marked a return to prominence, topping the UK albums chart.'), true);
});

test('covered-by claims accept the same relationship in active speech but reject its inverse', () => {
  const claim = 'Hello by Lionel Richie has been covered by Hello by Anita Carter.';
  assert.equal(detected('Hello by Anita Carter is a cover version of Hello by Lionel Richie.', claim), true);
  assert.equal(detected('Hello by Lionel Richie is a cover version of Hello by Anita Carter.', claim), false);
  assert.equal(detected('Hello by Anita Carter is not a cover version of Hello by Lionel Richie.', claim), false);
});

test('an event word inside the artist or album name is not a factual predicate', () => {
  assert.equal(detected('You must hear Born Ruffians next.',
    'Born Ruffians were included in a festival lineup.', ['Born Ruffians']), false);
  assert.equal(detected('You must hear Born in the USA again.',
    '“Born in the USA” was included in the 2005 edition of 1001 Albums You Must Hear Before You Die.'), false);
});

test('the same contributor name cannot substitute a writing credit for production', () => {
  assert.equal(detected('The song was written by Eno.', 'The song is credited to Eno for producer.'), false);
  assert.equal(detected('The song was produced by Eno.', 'The song is credited to Eno for writer.'), false);
  assert.equal(detected('The song was produced by Eno.', 'The song is credited to Eno for producer.'), true);
});

test('overlapping dates and places cannot hide a contradictory factual detail',()=>{
 const claim='Example Band formed in Cardiff in 1993.';
 for(const speech of ['They formed in Cardiff in 1994.','They formed in London in 1993.',
  'They formed in Cardiff in nineteen ninety-four.','Another Band formed in Cardiff in 1993.']) {
  assert.equal(detected(speech,claim,['Example Band']),false,speech);
 }
 assert.equal(detected('They formed in Cardiff.',claim,['Example Band']),true);
 assert.equal(detected('They formed in 1993.',claim,['Example Band']),true);
});

test('non-English predicates can express the same anchored fact without an English relation word',()=>{
 const claim='Example Band formed in Cardiff in 1993.';
 for(const speech of ['Ils se sont formés à Cardiff en 1993.','Sie wurden 1993 in Cardiff gegründet.',
  'Se formó en Cardiff en 1993.','Eles se formaram em Cardiff em 1993.']) {
  assert.equal(detected(speech,claim,['Example Band']),true,speech);
 }
 assert.equal(detected('Ils se sont formés à Londres en 1993.',claim,['Example Band']),false);
 assert.equal(detected('Ils ne se sont pas formés à Cardiff en 1993.',claim,['Example Band']),false);
 assert.equal(detected('Sie wurden nicht 1993 in Cardiff gegründet.',claim,['Example Band']),false);
});

test('explicit influence, writing and production relationships retain their subject direction',()=>{
 for(const [claim,reversed,passive] of [
  ['Alpha influenced Beta.','Beta influenced Alpha.','Beta was influenced by Alpha.'],
  ['Eno produced Album.','Album produced Eno.','Album was produced by Eno.'],
  ['Eno wrote Song.','Song wrote Eno.','Song was written by Eno.'],
 ]) {
  assert.equal(detected(claim,claim),true);
  assert.equal(detected(reversed,claim),false);
  assert.equal(detected(passive,claim),true);
 }
});
