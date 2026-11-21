import assert from 'node:assert/strict';
import test from 'node:test';
import { addValidatedShortWordings, screenResearchCandidates, validateAndRepairFullCandidates, validateResearchCandidates, type ResearchJob, type Researcher } from '../src/sleeve-notes/researcher.js';
import { candidatesFromResearchResult, researchOutcomeDebug } from '../src/sleeve-notes/llm-researcher.js';

const job: ResearchJob = {
  id: 'research-1',
  document: {
    id: 'source-1', entityId: 'artist-1', entityName: 'The Example Band', provider: 'wikipedia',
    sourceUrl: 'https://en.wikipedia.org/wiki/Example', revisionId: '123',
    text: "The Example Band formed after friends met in Liverpool in 1980. The Example Band's debut album arrived in 1982.",
  },
  categories: ['artist-stories', 'milestones'],
  maxCandidates: 3,
};

test('researcher output must be grounded in the supplied source document', () => {
  const result = validateResearchCandidates(job, [{
    category: 'artist-stories', topic: 'origin', wording: 'The Example Band formed after friends met in Liverpool in 1980.',
    evidence: 'The Example Band formed after friends met in Liverpool in 1980.',
  }, {
    category: 'artist-stories', topic: 'invented', wording: 'The band invented stadium rock.',
    evidence: 'The band invented stadium rock.',
  }]);
  assert.deepEqual(result.accepted.map((candidate) => candidate.topic), ['origin']);
  assert.deepEqual(result.rejected.map((candidate) => candidate.reason), ['unsupported']);
});

test('Wikipedia screening rejects a spark that adds claims beyond its matched sentence', () => {
  const evidence = 'Billed as "The Only Band That Matters", they are considered one of the most influential acts in the original wave of British punk rock, with their music fusing elements of reggae, dub, funk, ska and rockabilly.';
  const albumEvidence = 'Their third album London Calling, which was released in the UK in December 1979, earned them popularity in the United States, where it was released the following month.';
  const clashJob: ResearchJob = {
    ...job,
    document: { ...job.document, entityName: 'The Clash', text: `${evidence} ${albumEvidence}` },
    categories: ['artist-stories'],
  };
  const result = screenResearchCandidates(clashJob, [{
    category: 'artist-stories',
    topic: 'post-punk and new wave',
    wording: "The band's music fused elements of reggae, dub, funk, ska, and rockabilly, and they were also part of the post-punk and new wave movements that followed.",
    evidence,
  }, {
    category: 'artist-stories',
    topic: 'London Calling acclaim',
    wording: "The band's iconic album \"London Calling\" was released in 1979 and is widely considered one of the greatest rock albums of all time, blending punk, reggae, and rockabilly styles.",
    evidence: albumEvidence,
  }]);
  assert.deepEqual(result.accepted, []);
  assert.deepEqual(result.rejected.map(({ reason }) => reason), ['unsupported', 'unsupported']);
});

test('researcher output respects enabled categories, topic diversity and bounds', () => {
  const result = validateResearchCandidates(job, [{
    category: 'credits', topic: 'producer', wording: 'Produced by A Producer.',
    evidence: 'The Example Band formed in Liverpool in 1980.',
  }, {
    category: 'artist-stories', topic: 'origin', wording: 'The Example Band formed after friends met in Liverpool in 1980.',
    evidence: 'The Example Band formed after friends met in Liverpool in 1980.',
  }, {
    category: 'artist-stories', topic: 'ORIGIN', wording: 'They began after friends met in Liverpool in 1980.',
    evidence: 'The Example Band formed after friends met in Liverpool in 1980.',
  }, {
    category: 'milestones', topic: 'debut', wording: "The Example Band's debut album arrived in 1982.",
    evidence: "The Example Band's debut album arrived in 1982.",
  }]);
  assert.deepEqual(result.accepted.map((candidate) => [candidate.category, candidate.topic]), [
    ['artist-stories', 'origin'],
  ]);
  assert.deepEqual(result.rejected.map((candidate) => candidate.reason), ['category', 'incomplete', 'bare-milestone']);
});

test('an empty research result is a valid no-claim outcome', () => {
  const result = validateResearchCandidates(job, []);
  assert.deepEqual(result, { accepted: [], rejected: [] });
});

test('researcher repairs a generic topic and context-dependent Full wording from fixed evidence', async () => {
  const evidence = 'The Example Band recorded Night Lines with producer Dana Smith after a late-night session.';
  let repairCalls = 0;
  const researcher: Researcher = {
    async extract() { return []; },
    async repairFullCandidates(_job, candidates) {
      repairCalls += 1;
      return candidates.map((candidate) => ({
        ...candidate,
        topic: 'Night Lines sessions',
        wording: evidence,
      }));
    },
  };
  const result = await validateAndRepairFullCandidates({
    ...job,
    document: { ...job.document, text: evidence },
  }, researcher, [{
    category: 'artist-stories', topic: 'The Example Band',
    wording: 'The band recorded Night Lines with producer Dana Smith after a late-night session.',
    evidence,
  }], new AbortController().signal);
  assert.equal(repairCalls, 1);
  assert.equal(result.accepted[0]?.topic, 'Night Lines sessions');
  assert.equal(result.accepted[0]?.wording, evidence);
  assert.deepEqual(result.rejected, []);
});

test('Full repair remains subject to factual evidence validation', async () => {
  const evidence = 'The Example Album was produced by Beta Jones.';
  const researcher: Researcher = {
    async extract() { return []; },
    async repairFullCandidates(_job, candidates) {
      return candidates.map((candidate) => ({
        ...candidate,
        topic: 'Example Album producer',
        wording: 'The Example Album was produced by Alpha Jones.',
      }));
    },
  };
  const result = await validateAndRepairFullCandidates({
    ...job,
    document: { ...job.document, entityName: 'The Example Album', text: evidence },
  }, researcher, [{
    category: 'artist-stories', topic: 'The Example Album',
    wording: 'It was produced by Alpha Jones.', evidence,
  }], new AbortController().signal);
  assert.deepEqual(result.accepted, []);
  assert.deepEqual(result.rejected.map(({ reason }) => reason), ['unsupported']);
});

test('grounding accepts a hyphenated proper name stated in the evidence', () => {
  const evidence = 'Snoop Dogg formed a funk duo with musician Dâm-Funk called 7 Days of Funk.';
  const evidenceJob = { ...job, document: { ...job.document, entityName: 'Snoop Dogg', text: evidence } };
  const result = validateResearchCandidates(evidenceJob, [{
    category: 'artist-stories', topic: '7 Days of Funk duo', wording: evidence, evidence,
  }]);
  assert.equal(result.accepted.length, 1);
});

test('researcher retains up to five distinct supported notes for a rich source', () => {
  const evidenceJob = { ...job, maxCandidates: 5, document: { ...job.document, text: [
    'The Example Band formed after its singer answered a newspaper advert.',
    "The Example Band's debut album was recorded with Producer Alpha after a late-night session.",
    'The Example Band wrote Song Journey during a train journey to Glasgow.',
    'Artist Three joined after meeting The Example Band at a festival.',
    "The Example Band's fourth album used a children's choir on Track Five.",
  ].join(' ') } };
  const result = validateResearchCandidates(evidenceJob, [
    { category: 'artist-stories', topic: 'advert', wording: 'The Example Band formed after its singer answered a newspaper advert.', evidence: 'The Example Band formed after its singer answered a newspaper advert.' },
    { category: 'milestones', topic: 'debut session', wording: "The Example Band's debut album was recorded with Producer Alpha after a late-night session.", evidence: "The Example Band's debut album was recorded with Producer Alpha after a late-night session." },
    { category: 'artist-stories', topic: 'train song', wording: 'The Example Band wrote Song Journey during a train journey to Glasgow.', evidence: 'The Example Band wrote Song Journey during a train journey to Glasgow.' },
    { category: 'artist-stories', topic: 'festival member', wording: 'Artist Three joined after meeting The Example Band at a festival.', evidence: 'Artist Three joined after meeting The Example Band at a festival.' },
    { category: 'milestones', topic: 'choir', wording: "The Example Band's fourth album used a children's choir on Track Five.", evidence: "The Example Band's fourth album used a children's choir on Track Five." },
  ]);
  assert.equal(result.accepted.length, 5);
});

test('researcher rejects evidence that appears in source but does not entail the wording', () => {
  const result = validateResearchCandidates(job, [{
    category: 'artist-stories', topic: 'hit', wording: 'She is best known for her biggest hit single.',
    evidence: 'Their debut album arrived in 1982.',
  }]);
  assert.deepEqual(result.accepted, []);
  assert.deepEqual(result.rejected.map((candidate) => candidate.reason), ['unsupported']);
});

test('researcher rejects evidence whose concrete detail is absent from the wording', () => {
  const evidenceJob = { ...job, document: { ...job.document, text: 'The single I Follow Rivers became their biggest international hit.' } };
  const result = validateResearchCandidates(evidenceJob, [{
    category: 'artist-stories', topic: 'hit', wording: 'It became their biggest international hit.',
    evidence: 'The single I Follow Rivers became their biggest international hit.',
  }]);
  assert.deepEqual(result.accepted, []);
  assert.deepEqual(result.rejected.map((candidate) => candidate.reason), ['incomplete']);
});

test('researcher completes an unfinished verbatim wording fragment from its evidence', () => {
  const evidenceJob = { ...job, document: { ...job.document, entityName: 'The Beautiful South', text: [
    'In 1990, the Beautiful South released their second album, Choke.',
    'The Beautiful South album Choke featured a Hemingway/Corrigan duet called "A Little Time".',
    'They broke up in January 2007, saying the split was due to "musical similarities", having sold around 15 million records.',
  ].join(' ') } };
  const result = validateResearchCandidates(evidenceJob, [{
    category: 'milestones', topic: 'duet',
    wording: 'The Beautiful South album Choke featured a Hemingway/Corrigan duet called',
    evidence: 'The Beautiful South album Choke featured a Hemingway/Corrigan duet called "A Little Time".',
  }, {
    category: 'artist-stories', topic: 'split',
    wording: 'They broke up in January 2007, saying the split was due to',
    evidence: 'They broke up in January 2007, saying the split was due to "musical similarities", having sold around 15 million records.',
  }]);
  assert.deepEqual(result.accepted.map((candidate) => candidate.wording), [
    'The Beautiful South album Choke featured a Hemingway/Corrigan duet called "A Little Time".',
  ]);
  assert.deepEqual(result.rejected.map((candidate) => candidate.reason), ['incomplete']);
});

test('researcher does not replace a complete paraphrase with its evidence', () => {
  const evidenceJob = { ...job, document: { ...job.document, text: 'The Example Band formed after friends met in Liverpool in 1980, before touring Europe.' } };
  const result = validateResearchCandidates(evidenceJob, [{
    category: 'artist-stories', topic: 'origin', wording: 'The Example Band formed after friends met in Liverpool in 1980.',
    evidence: 'The Example Band formed after friends met in Liverpool in 1980, before touring Europe.',
  }]);
  assert.equal(result.accepted[0]?.wording, 'The Example Band formed after friends met in Liverpool in 1980.');
});

test('researcher rejects generic biography metadata but keeps a specific story', () => {
  const evidenceJob = { ...job, document: { ...job.document, text: [
    'The Example Band formed in Liverpool in 1980.',
    'The American heavy metal band Saviours was formed in Oakland, California, in 2004.',
    'The Example Band have released 3 studio albums.',
    'The Example Band have had 7 top five hits in Ireland.',
    'They were inducted into the Rock and Roll Hall of Fame in 2022.',
    'The Example Band formed after its singer answered a newspaper advert in Liverpool in 1980.',
  ].join(' ') } };
  const result = validateResearchCandidates(evidenceJob, [{
    category: 'artist-stories', topic: 'formation', wording: 'The Example Band formed in Liverpool in 1980.',
    evidence: 'The Example Band formed in Liverpool in 1980.',
  }, {
    category: 'artist-stories', topic: 'metal formation', wording: 'The American heavy metal band Saviours was formed in Oakland, California, in 2004.',
    evidence: 'The American heavy metal band Saviours was formed in Oakland, California, in 2004.',
  }, {
    category: 'milestones', topic: 'discography', wording: 'The Example Band have released 3 studio albums.',
    evidence: 'The Example Band have released 3 studio albums.',
  }, {
    category: 'milestones', topic: 'chart tally', wording: 'The Example Band have had 7 top five hits in Ireland.',
    evidence: 'The Example Band have had 7 top five hits in Ireland.',
  }, {
    category: 'milestones', topic: 'recognition', wording: 'They were inducted into the Rock and Roll Hall of Fame in 2022.',
    evidence: 'They were inducted into the Rock and Roll Hall of Fame in 2022.',
  }, {
    category: 'artist-stories', topic: 'advert', wording: 'The Example Band formed after its singer answered a newspaper advert in Liverpool in 1980.',
    evidence: 'The Example Band formed after its singer answered a newspaper advert in Liverpool in 1980.',
  }]);
  assert.deepEqual(result.accepted.map((candidate) => candidate.topic), ['advert']);
  assert.deepEqual(result.rejected.map((candidate) => candidate.reason), ['editorial', 'editorial', 'topic', 'editorial', 'topic']);
});

test('researcher rejects a sentence that adds names or facts from elsewhere in the article', () => {
  const evidenceJob = { ...job, document: { ...job.document, text: [
    'Duke Erikson and Butch Vig had been in several bands together, including Spooner and Fire Town.',
    'In 1990, the band explored jazz fusion, punk rock and Delta blues on its second album.',
  ].join(' ') } };
  const result = validateResearchCandidates(evidenceJob, [{
    category: 'artist-stories', topic: 'line-up',
    wording: 'Shirley Manson, Duke Erikson, Steve Marker and Butch Vig have remained in the band since its inception.',
    evidence: 'Duke Erikson and Butch Vig had been in several bands together, including Spooner and Fire Town.',
  }, {
    category: 'milestones', topic: 'awards',
    wording: 'The Example Band won a Grammy Award for Best Hard Rock Performance in 1990.',
    evidence: 'In 1990, the band explored jazz fusion, punk rock and Delta blues on its second album.',
  }]);
  assert.deepEqual(result.accepted, []);
  assert.deepEqual(result.rejected.map((candidate) => candidate.reason), ['incomplete', 'unsupported']);
});

test('researcher requires each sentence of a compound note to be evidenced', () => {
  const evidenceJob = { ...job, document: { ...job.document, text: [
    'The band were created by German record producer Frank Farian, who was the group\'s primary songwriter.',
    'The four original members were Liz Mitchell, Marcia Barrett, Maizie Williams and Bobby Farrell.',
  ].join(' ') } };
  const result = validateResearchCandidates(evidenceJob, [{
    category: 'artist-stories', topic: 'formation',
    wording: 'The Example Band was created by German record producer Frank Farian. The Example Band original line-up included Liz Mitchell, Marcia Barrett, Maizie Williams and Bobby Farrell.',
    evidence: 'The Example Band was created by German record producer Frank Farian, who was the group\'s primary songwriter.',
  }]);
  assert.deepEqual(result.accepted, []);
  assert.deepEqual(result.rejected.map((candidate) => candidate.reason), ['unsupported']);
});

test('researcher refuses a bare name or date as evidence for a larger claim', () => {
  const result = validateResearchCandidates(job, [{
    category: 'artist-stories', topic: 'label', wording: "They were originally signed to Tony Wilson's Factory Records label.",
    evidence: 'Tony Wilson',
  }, {
    category: 'artist-stories', topic: 'member', wording: 'Rowetta performed with the band until December 2024.',
    evidence: 'December 2024',
  }]);
  assert.deepEqual(result.accepted, []);
  assert.deepEqual(result.rejected.map((candidate) => candidate.reason), ['shape', 'shape']);
});

test('researcher rejects a bare release-date milestone but keeps an evidenced release story', () => {
  const richerJob = { ...job, document: { ...job.document, text: "The Example Band's debut album arrived in 1982. The Example Band's debut album was produced by A Producer after the band signed to Example Records." } };
  const result = validateResearchCandidates(richerJob, [{
    category: 'milestones', topic: 'debut date', wording: "The Example Band's debut album arrived in 1982.",
    evidence: "The Example Band's debut album arrived in 1982.",
  }, {
    category: 'milestones', topic: 'debut production', wording: "The Example Band's debut album was produced by A Producer after the band signed to Example Records.",
    evidence: "The Example Band's debut album was produced by A Producer after the band signed to Example Records.",
  }]);
  assert.deepEqual(result.accepted.map((candidate) => candidate.topic), ['debut production']);
  assert.deepEqual(result.rejected.map((candidate) => candidate.reason), ['bare-milestone']);
});

test('researcher blocks category bypasses and sensitive personal facts', () => {
  const evidenceJob = { ...job, document: { ...job.document, text: [
    'The album Letter to Self was released by the Example Band in January 2024 to widespread critical acclaim.',
    'Idina Menzel\'s parents divorced when she was a toddler.',
    'Graeme Kelling died from pancreatic cancer in 2004.',
  ].join(' ') } };
  const result = validateResearchCandidates(evidenceJob, [{
    category: 'artist-stories', topic: 'debut',
    wording: 'The album Letter to Self was released by the Example Band in January 2024 to widespread critical acclaim.',
    evidence: 'The album Letter to Self was released by the Example Band in January 2024 to widespread critical acclaim.',
  }, {
    category: 'artist-stories', topic: 'family',
    wording: 'Idina Menzel\'s parents divorced when she was a toddler.',
    evidence: 'Idina Menzel\'s parents divorced when she was a toddler.',
  }, {
    category: 'artist-stories', topic: 'death',
    wording: 'Graeme Kelling died from pancreatic cancer in 2004.',
    evidence: 'Graeme Kelling died from pancreatic cancer in 2004.',
  }]);
  assert.deepEqual(result.accepted, []);
  assert.deepEqual(result.rejected.map((candidate) => candidate.reason), ['bare-milestone', 'editorial', 'editorial']);
});

test('the LLM researcher reads candidates from djObject\'s decoded result', () => {
  const candidates = [{
    category: 'artist-stories', topic: 'origin', wording: 'The Example Band formed in Liverpool in 1980.',
    evidence: 'The Example Band formed in Liverpool in 1980.',
  }] as const;
  assert.deepEqual(candidatesFromResearchResult({ candidates }), candidates);
  assert.deepEqual(candidatesFromResearchResult({ value: { candidates } }), []);
  assert.deepEqual(candidatesFromResearchResult(undefined), []);
});

test('research debug outcome separates retained claims from rejected candidates', () => {
  const candidate = {
    category: 'artist-stories' as const, topic: 'origin', wording: 'The Example Band formed in Liverpool in 1980.',
    evidence: 'The Example Band formed in Liverpool in 1980.',
  };
  assert.deepEqual(researchOutcomeDebug({
    accepted: [candidate], rejected: [{ candidate, reason: 'duplicate' }],
  }), {
    status: 'complete', retained: [candidate], rejected: [{ ...candidate, reason: 'duplicate' }],
  });
});

test('researcher rejects source fragments and unresolved Full subjects', () => {
  const evidence = 'This Is the Kit recorded the album Bashed Out in Bristol after touring with The National.';
  const evidenceJob = { ...job, document: { ...job.document, entityName: 'This Is the Kit', text: evidence } };
  const result = validateResearchCandidates(evidenceJob, [{
    category: 'artist-stories', topic: 'recording', wording: 'recorded the album Bashed Out in Bristol...', evidence,
  }, {
    category: 'artist-stories', topic: 'tour recording', wording: 'After their tour, the album Bashed Out was recorded in Bristol.', evidence,
  }, {
    category: 'artist-stories', topic: 'Bristol recording', wording: 'This Is the Kit recorded the album Bashed Out in Bristol after touring with The National.', evidence,
  }]);
  assert.deepEqual(result.accepted.map(({ topic }) => topic), ['Bristol recording']);
  assert.deepEqual(result.rejected.map(({ reason }) => reason), ['incomplete', 'incomplete']);
});

test('a Records label does not make a bare release announcement a story', () => {
  const evidence = 'The album Example One was released by Food Records in 1999.';
  const evidenceJob = { ...job, document: { ...job.document, text: evidence } };
  const result = validateResearchCandidates(evidenceJob, [{
    category: 'milestones', topic: 'Food Records release', wording: evidence, evidence,
  }]);
  assert.deepEqual(result.accepted, []);
  assert.deepEqual(result.rejected.map(({ reason }) => reason), ['bare-milestone']);
});

test('Short anchors require a named subject and cannot strengthen qualifiers', () => {
  const evidence = "Coil influenced Autechre's approach to electronic music.";
  const shortJob = {
    ...job,
    categories: ['musical-connections'] as const,
    requireShortWording: true,
    document: { ...job.document, entityName: 'Autechre', text: evidence },
  };
  const base = {
    category: 'musical-connections' as const,
    topic: 'Coil influence',
    wording: "Coil influenced Autechre's approach to electronic music.",
    evidence,
  };
  assert.equal(validateResearchCandidates(shortJob, [{ ...base, shortWording: 'Coil influenced Autechre' }]).accepted.length, 1);
  assert.deepEqual(validateResearchCandidates(shortJob, [{ ...base, shortWording: 'Influenced Autechre through Coil' }]).rejected.map(({ reason }) => reason), ['short-unsupported']);
  assert.deepEqual(validateResearchCandidates(shortJob, [{ ...base, shortWording: 'Coil best influenced Autechre' }]).rejected.map(({ reason }) => reason), ['short-unsupported']);
});

test('credits requires an actual contributor role', () => {
  const evidence = 'David Bowie called Low his favourite album by the artist.';
  const evidenceJob = { ...job, categories: ['credits'] as const, document: { ...job.document, text: evidence } };
  const result = validateResearchCandidates(evidenceJob, [{
    category: 'credits', topic: 'favourite album', wording: evidence, evidence,
  }]);
  assert.deepEqual(result.rejected.map(({ reason }) => reason), ['category']);
});

test('Short generation retries a bad anchor without changing its accepted Full claim', async () => {
  const evidence = "Craig Potter produced Elbow's album Asleep in the Back.";
  const full = {
    category: 'credits' as const,
    topic: 'Craig Potter production',
    wording: evidence,
    evidence,
  };
  let calls = 0;
  const researcher: Researcher = {
    async extract() { return []; },
    async addShortWordings(_job, candidates) {
      calls += 1;
      return candidates.map((candidate) => ({
        ...candidate,
        shortWording: calls === 1
          ? 'Produced and mixed by Craig Potter'
          : "Craig Potter produced Elbow's Asleep in the Back",
      }));
    },
  };
  const result = await addValidatedShortWordings({
    ...job,
    categories: ['credits'],
    document: { ...job.document, entityName: 'Elbow', text: evidence },
  }, researcher, [full], new AbortController().signal);
  assert.equal(calls, 2);
  assert.equal(result.accepted[0]?.wording, full.wording);
  assert.equal(result.accepted[0]?.shortWording, "Craig Potter produced Elbow's Asleep in the Back");
  assert.deepEqual(result.rejected, []);
});

test('semantic review fails closed when an accepted claim ID is omitted', async () => {
  const evidence = "Craig Potter produced Elbow's album Asleep in the Back.";
  const researcher: Researcher = {
    async extract() { return []; },
    async addShortWordings(_job, candidates) {
      return candidates.map((candidate) => ({ ...candidate, shortWording: "Craig Potter produced Elbow's Asleep in the Back" }));
    },
    async semanticReview() { return []; },
  };
  const result = await addValidatedShortWordings({
    ...job,
    categories: ['credits'],
    document: { ...job.document, entityName: 'Elbow', text: evidence },
  }, researcher, [{
    category: 'credits', topic: 'Craig Potter production', wording: evidence, evidence,
  }], new AbortController().signal);
  assert.deepEqual(result.accepted, []);
  assert.deepEqual(result.rejected.map(({ reason }) => reason), ['semantic-review']);
});

test('Full wording cannot add a substantial clause absent from its evidence', () => {
  const evidence = 'Tankian released his debut solo album Elect the Dead in the autumn of 2007.';
  const evidenceJob = { ...job, document: { ...job.document, entityName: 'System of a Down', text: evidence } };
  const result = validateResearchCandidates(evidenceJob, [{
    category: 'artist-stories', topic: 'Elect the Dead recording',
    wording: 'Tankian released his debut solo album Elect the Dead in the autumn of 2007, which he recorded almost entirely by himself.',
    evidence,
  }]);
  assert.deepEqual(result.rejected.map(({ reason }) => reason), ['unsupported']);
});

test('Full wording preserves an opinion source attribution', () => {
  const evidence = "Chris Zaldua argued that Autechre's Chiastic Slide marked a turn towards a more textural and abstract approach.";
  const evidenceJob = { ...job, document: { ...job.document, entityName: 'Autechre', text: evidence } };
  const result = validateResearchCandidates(evidenceJob, [{
    category: 'artist-stories', topic: 'Chiastic Slide assessment',
    wording: "Autechre's Chiastic Slide marked a turn towards a more textural and abstract approach.", evidence,
  }, {
    category: 'artist-stories', topic: 'Zaldua assessment',
    wording: "Chris Zaldua argued that Autechre's Chiastic Slide marked a turn towards a more textural and abstract approach.", evidence,
  }]);
  assert.deepEqual(result.accepted.map(({ topic }) => topic), ['Zaldua assessment']);
  assert.deepEqual(result.rejected.map(({ reason }) => reason), ['unsupported']);
});

test('Full wording catches unresolved subjects after an opening phrase', () => {
  const evidence = 'In August 2010, it was revealed that he would collaborate with Shakira on Loca.';
  const evidenceJob = { ...job, document: { ...job.document, entityName: 'Dizzee Rascal', text: evidence } };
  const result = validateResearchCandidates(evidenceJob, [{
    category: 'artist-stories', topic: 'Shakira collaboration', wording: evidence, evidence,
  }]);
  assert.deepEqual(result.rejected.map(({ reason }) => reason), ['incomplete']);
});

test('Short wording stays compact and cannot add another evidenced fact', () => {
  const evidence = "Freddie Stone joined Larry Graham's group, Graham Central Station; he later became a pastor.";
  const shortJob = {
    ...job,
    requireShortWording: true,
    document: { ...job.document, entityName: 'Sly & the Family Stone', text: evidence },
  };
  const base = {
    category: 'artist-stories' as const, topic: 'Graham Central Station',
    wording: "Freddie Stone joined Larry Graham's group, Graham Central Station.", evidence,
  };
  const mismatched = validateResearchCandidates(shortJob, [{
    ...base, shortWording: 'Freddie Stone joined Graham Central Station and later became a pastor',
  }]);
  const tooLong = validateResearchCandidates(shortJob, [{
    ...base, shortWording: `Freddie Stone joined Graham Central Station ${'with musicians '.repeat(12)}`,
  }]);
  assert.deepEqual(mismatched.rejected.map(({ reason }) => reason), ['short-unsupported']);
  assert.deepEqual(tooLong.rejected.map(({ reason }) => reason), ['short-shape']);
});

test('recognition does not accept an ordinary compilation appearance', () => {
  const evidence = 'Sly and the Family Stone appeared on the compilation album Red Hot + Dance.';
  const evidenceJob = { ...job, categories: ['recognition'] as const, document: { ...job.document, text: evidence } };
  const result = validateResearchCandidates(evidenceJob, [{
    category: 'recognition', topic: 'Red Hot + Dance', wording: evidence, evidence,
  }]);
  assert.deepEqual(result.rejected.map(({ reason }) => reason), ['category']);
});

test('researcher rejects truncated delimiters and list-like source evidence', () => {
  const truncated = 'Chef performed "Chocolate Salty Balls (P.S.';
  const list = '== Discography == === Soundtrack albums === Marty Supreme (2025, A24 Music) as Daniel Lopatin == References ==';
  const evidenceJob = { ...job, document: { ...job.document, text: `${truncated} ${list}` } };
  const result = validateResearchCandidates(evidenceJob, [{
    category: 'artist-stories', topic: 'Chef song', wording: `${truncated}.`, evidence: truncated,
  }, {
    category: 'artist-stories', topic: 'Marty Supreme soundtrack',
    wording: 'Marty Supreme is a soundtrack album by Daniel Lopatin.', evidence: list,
  }]);
  assert.deepEqual(result.rejected.map(({ reason }) => reason), ['unsupported', 'unsupported']);
});

test('researcher rejects unnamed work subjects and routine title releases', () => {
  const evidence = 'A nearly nine-hour live mix was streamed to coincide with its release. Bloc Party released "Octopus" that July.';
  const evidenceJob = { ...job, document: { ...job.document, text: evidence } };
  const result = validateResearchCandidates(evidenceJob, [{
    category: 'artist-stories', topic: 'release webcast',
    wording: 'A nearly nine-hour live mix was streamed to coincide with its release.',
    evidence: 'A nearly nine-hour live mix was streamed to coincide with its release.',
  }, {
    category: 'milestones', topic: 'Octopus release', wording: 'Bloc Party released "Octopus" that July.',
    evidence: 'Bloc Party released "Octopus" that July.',
  }]);
  assert.deepEqual(result.rejected.map(({ reason }) => reason), ['incomplete', 'bare-milestone']);
});

test('Short wording rejects stray closing delimiters', () => {
  const evidence = 'Little Sister used a drum machine in Somebody’s Watching You.';
  const shortJob = { ...job, requireShortWording: true, document: { ...job.document, text: evidence } };
  const result = validateResearchCandidates(shortJob, [{
    category: 'artist-stories', topic: 'drum machine', wording: evidence,
    shortWording: 'Little Sister used a drum machine}', evidence,
  }]);
  assert.deepEqual(result.rejected.map(({ reason }) => reason), ['short-shape']);
});

test('researcher rejects routine sales totals and unnamed numeric subjects', () => {
  const evidence = 'Bloc Party have sold over 3 million albums worldwide. Rizzle Kicks sold over one million singles in the UK. 18 new tracks were completed for a new album produced by Youth.';
  const evidenceJob = { ...job, categories: ['milestones', 'credits'] as const, document: { ...job.document, entityName: 'Bloc Party', text: evidence } };
  const result = validateResearchCandidates(evidenceJob, [{
    category: 'milestones', topic: 'sales total', wording: 'Bloc Party have sold over 3 million albums worldwide.',
    evidence: 'Bloc Party have sold over 3 million albums worldwide.',
  }, {
    category: 'milestones', topic: 'single sales', wording: 'Rizzle Kicks sold over one million singles in the UK.',
    evidence: 'Rizzle Kicks sold over one million singles in the UK.',
  }, {
    category: 'credits', topic: 'Youth production', wording: '18 new tracks were completed for a new album produced by Youth.',
    evidence: '18 new tracks were completed for a new album produced by Youth.',
  }]);
  assert.deepEqual(result.rejected.map(({ reason }) => reason), ['editorial', 'editorial', 'incomplete']);
});

test('researcher rejects the same fact repeated under another category', () => {
  const evidence = 'Petralli collaborated with guitarist Raze Regal on Raze Regal & White Denim Inc.';
  const evidenceJob = {
    ...job,
    categories: ['release-stories', 'credits'] as const,
    document: { ...job.document, entityName: 'White Denim', text: evidence },
  };
  const candidate = { topic: 'Raze Regal collaboration', wording: evidence, evidence };
  const result = validateResearchCandidates(evidenceJob, [
    { ...candidate, category: 'release-stories' },
    { ...candidate, category: 'credits' },
  ]);
  assert.equal(result.accepted.length, 1);
  assert.deepEqual(result.rejected.map(({ reason }) => reason), ['duplicate']);
});

test('musical connections excludes an ordinary supporting tour', () => {
  const evidence = 'Rizzle Kicks toured the US supporting Ed Sheeran and Foy Vance.';
  const evidenceJob = {
    ...job,
    categories: ['musical-connections'] as const,
    document: { ...job.document, entityName: 'Rizzle Kicks', text: evidence },
  };
  const result = validateResearchCandidates(evidenceJob, [{
    category: 'musical-connections', topic: 'US tour', wording: evidence, evidence,
  }]);
  assert.deepEqual(result.rejected.map(({ reason }) => reason), ['category']);
});

test('Full wording treats unnamed tracks as context dependent', () => {
  const evidence = 'Bronski Beat began work on Out and About. The tracks were recorded with engineer Brian Pugsley.';
  const evidenceJob = { ...job, document: { ...job.document, entityName: 'Bronski Beat', text: evidence } };
  const result = validateResearchCandidates(evidenceJob, [{
    category: 'artist-stories', topic: 'Out and About sessions',
    wording: 'The tracks were recorded with engineer Brian Pugsley.', evidence,
  }]);
  assert.deepEqual(result.rejected.map(({ reason }) => reason), ['incomplete']);
});

test('a claim must connect its fact to the article subject in the displayed receipt', () => {
  const unrelatedEvidence = 'Genesis signed with Charisma Records and recorded the album Trespass.';
  const relatedEvidence = 'Phil Collins joined Genesis after the band recorded the album Trespass.';
  const evidenceJob = {
    ...job,
    document: { ...job.document, entityName: 'Phil Collins', text: `${unrelatedEvidence} ${relatedEvidence}` },
  };
  const result = validateResearchCandidates(evidenceJob, [{
    category: 'artist-stories', topic: 'Trespass sessions', wording: unrelatedEvidence, evidence: unrelatedEvidence,
  }, {
    category: 'artist-stories', topic: 'joining Genesis', wording: relatedEvidence, evidence: relatedEvidence,
  }]);
  assert.deepEqual(result.accepted.map(({ topic }) => topic), ['joining Genesis']);
  assert.deepEqual(result.rejected.map(({ reason }) => reason), ['unsupported']);
});

test('Full wording rejects unresolved object pronouns, unidentified works and prior events', () => {
  const evidence = [
    'Rolling Stone ranked them No. 2 on its list.',
    'The film was post-produced by The House of Curves.',
    'A further track from that gig appeared on A Meeting of the Times.',
  ].join(' ');
  const evidenceJob = { ...job, document: { ...job.document, entityName: 'The Example Band', text: evidence } };
  const result = validateResearchCandidates(evidenceJob, [
    { category: 'milestones', topic: 'Rolling Stone rank', wording: 'Rolling Stone ranked them No. 2 on its list.', evidence: 'Rolling Stone ranked them No. 2 on its list.' },
    { category: 'artist-stories', topic: 'film production', wording: 'The film was post-produced by The House of Curves.', evidence: 'The film was post-produced by The House of Curves.' },
    { category: 'artist-stories', topic: 'live recording', wording: 'A further track from that gig appeared on A Meeting of the Times.', evidence: 'A further track from that gig appeared on A Meeting of the Times.' },
  ]);
  assert.deepEqual(result.rejected.map(({ reason }) => reason), ['incomplete', 'incomplete', 'incomplete']);
});

test('Short wording retains named works and essential Full qualifiers', () => {
  const evidence = 'System of a Down released their first songs in 15 years, "Protect the Land" and "Genocidal Humanoidz", which speak of war in Artsakh and Armenia.';
  const shortJob = {
    ...job,
    categories: ['track-stories'] as const,
    requireShortWording: true,
    document: { ...job.document, entityName: 'System of a Down', text: evidence },
  };
  const base = {
    category: 'track-stories' as const, topic: 'Artsakh songs',
    wording: 'System of a Down released their first songs in 15 years, "Protect the Land" and "Genocidal Humanoidz", which speak of war in Artsakh and Armenia.',
    evidence,
  };
  const missingStory = validateResearchCandidates(shortJob, [{
    ...base, shortWording: 'System of a Down released Protect the Land and Genocidal Humanoidz',
  }]);
  const missingTitle = validateResearchCandidates(shortJob, [{
    ...base, shortWording: 'System of a Down released their first songs about war in Artsakh and Armenia',
  }]);
  assert.deepEqual(missingStory.rejected.map(({ reason }) => reason), ['short-unsupported']);
  assert.deepEqual(missingTitle.rejected.map(({ reason }) => reason), ['short-unsupported']);
});
