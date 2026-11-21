// A conservative local wording check, not a semantic verifier of the whole link.
// Names identify the subject; a shared predicate and its detail establish use.
import { normalizeForSpeech } from '../audio/speech-text.js';

export interface ClaimSignal {
  version: number;
  method?: 'speech-review-v1';
  language?: string;
  status: 'detected' | 'not-detected';
  reason: string;
  clause: string | null;
  matchedTerms: string[];
}

const STOP = new Set(('a an and are as at be been being by for from has have he her him his in is it its of on or she that the their them they this to was were with ' +
  'about after again along also among because before between both came created during group groups into made more most other over record records there these those through under which while without would album albums band bands track tracks song songs music artist artists now here one great classic').split(' '));

const RELATIONS = [
  ['birth', /\b(?:born|birth|ne|nee|naquit|nacio|nacido|geboren|nasceu|nato|nata)\b/u],
  ['formation', /\b(?:formed|forming|founded|founding|founders|co founded|cofounded|started|forme|formee|formes|fonde|fondee|fundo|fundado|formo|gegrundet|grundete|fundou|formou|formaram|fondato)\b/u],
  ['influence', /\b(?:influence\w*|influenc\w*|inspir\w*|beeinfluss\w*|pragte)\b/u],
  ['recognition', /\b(?:rank\w*|includ\w*|list|lists|listed|listing|awarded|won|prize|named|topp\w*|chart\w*)\b/u],
  ['production', /\b(?:produc\w*|produit|produite|produjo|produziert|produzido|produsse)\b/u],
  ['recording', /\b(?:recorded|recording|recordings|enregistr\w*|grabo|grabado|aufgenommen|nahm|gravou|gravado|registrato)\b/u],
  ['writing', /\b(?:writ\w*|wrote|written|ecrit|ecrite|escribio|escrito|geschrieben|schrieb|escreveu|escrito|scritto)\b/u],
  ['sample', /\b(?:sampl\w*|echantillonn\w*)\b/u],
  ['cover', /\b(?:cover\w*|repris|reprise|reprises|version de)\b/u],
  ['collaboration', /\b(?:collaborat\w*|performed|performance|join\w*|toured|tour)\b/u],
  ['release', /\b(?:releas\w*|announc\w*|coming out|came out|paru|parue|sorti|sortie|publie|publiee|publicado|veroffentlicht|erschienen|lancado|pubblicato)\b/u],
  ['membership', /\b(?:consists|members|lineup|line up|vocalist|guitarist|drummer|bassist)\b/u],
  ['experiment', /\b(?:experiment\w*)\b/u],
  ['financial', /\b(?:bankrupt\w*|cost|sold|selling|raising|raised|faillite|bankrott|quiebra|falencia)\b/u],
] as const;

function clean(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[’']/gu, '').replace(/[-–—]/gu, ' ');
}

function words(value: string): string[] {
  return clean(value).match(/[\p{L}\p{N}]+/gu) ?? [];
}

function spokenOnly(text: string): string {
  return text.replace(/<think>[\s\S]*?(?:<\/think>|$)/giu, '')
    .replace(/\[[^\]]*\]/gu, '')
    .replace(/\([^)]*\)/gu, cue => /\b(?:laugh|chuckle|giggle|sigh|inhale|exhale|breath|throat|vocals begin|tags omitted)\b/iu.test(cue) ? '' : cue)
    .replace(/(?:^|\n)\s*(?:note|tags omitted|stage direction)\s*:[\s\S]*/giu, '');
}

// These checks reject concrete conflicting details; they do not establish
// semantic truth. Omitting a date/place is allowed, substituting one is not.
const SPOKEN_YEARS = Array.from({length: 300},(_,i)=>{
  const year=String(1800+i);return [clean(normalizeForSpeech(year)),year] as const;
}).sort((a,b)=>b[0].length-a[0].length);
const DISCOURSE_WORDS = new Set(('they their this that these those it its he she we our you your i the a an now well so yes no and but oh honestly exactly absolutely interestingly meanwhile ils elles il elle nous vous le la les ce cette ces un une das die der sie wir es el los las ellos ellas os as eles elas se').split(' '));
function withNumericYears(value:string):string {
  let normalized=clean(value);
  for(const [spoken,year] of SPOKEN_YEARS)normalized=normalized.replaceAll(spoken,year);
  return normalized;
}
export function claimDetailContradiction(text:string,wording:string,context:readonly unknown[]=[]):string|null {
  let speech=withNumericYears(spokenOnly(text));
  const fact=withNumericYears(wording);
  for(const year of fact.match(/\b(?:19|20)\d{2}\b/gu)??[]) {
    speech=speech.replace(new RegExp(`\\b(in|of|en|de|em|im) ${year.slice(-2)}\\b`,'gu'),`$1 ${year}`);
  }
  const expected=new Set(fact.match(/\b\d+(?:[.,]\d+)?\b/gu)??[]);
  const numeric=speech.match(/\b\d+(?:[.,]\d+)?\b/gu)??[];
  if(expected.size && numeric.some(number=>!expected.has(number)))return 'Spoken number or date conflicts with the supplied claim';
  const known=new Set(words([wording,...context.filter(x=>typeof x==='string')].join(' ')));
  const bare=spokenOnly(text).trim();
  const names=bare.matchAll(/(?<![\p{L}])[\p{Lu}][\p{Ll}]+(?:[’'][\p{L}]+)?/gu);
  for(const match of names){const name=match[0],key=clean(name.replace(/[’']s$/u,''));
    if(DISCOURSE_WORDS.has(clean(name.split(/[’']/u)[0])))continue;
    // Sentence-initial capitals alone cannot identify a proper name. A new
    // multi-word subject remains checkable; ordinary opening adverbs do not.
    if(match.index===0&&!/^\s+[\p{Lu}]/u.test(bare.slice(name.length)))continue;
    if(!known.has(key)&&!STOP.has(key)&&!DISCOURSE_WORDS.has(key))return 'Spoken named detail is absent from the supplied claim';
  }
  return null;
}

/** Count only a claim-bearing clause; a related name or album announcement is insufficient. */
export function detectClaimSignal(text: string, wording: string, context: readonly unknown[] = []): ClaimSignal {
  const result = (status: ClaimSignal['status'], reason: string, clause: string | null = null,
    matchedTerms: string[] = []): ClaimSignal => ({ version: 2, status, reason, clause, matchedTerms });
  const excluded = new Set(context.filter((x): x is string => typeof x === 'string').flatMap(words));
  // Quoted titles are identities, not evidence of the fact asserted about them.
  for (const title of wording.matchAll(/[“"]([^”"]+)[”"]/gu)) {
    for (const term of words(title[1])) excluded.add(term);
  }
  const claim = clean(wording);
  let factText = clean(wording.replace(/[“"]([^”"]+)[”"]/gu, ''));
  for (const identity of context) {
    if (typeof identity === 'string' && identity.trim()) factText = factText.replaceAll(clean(identity), ' ');
  }
  const relations: Array<readonly [string, RegExp]> = RELATIONS.filter(([, pattern]) => pattern.test(factText));
  if (!relations.length && /\b(?:is|are|was|were)\s+an?\b/u.test(factText)) {
    relations.push(['description', /\b(?:is|are|was|were)?\s*an?\b/u]);
  }
  if (!relations.length) return result('not-detected', 'No supported factual relation found');
  const terms = new Set(words(wording).filter(term => term.length >= 2 && !STOP.has(term)
    && !excluded.has(term) && !RELATIONS.some(([, pattern]) => pattern.test(term))));
  const clauses = spokenOnly(text).split(/(?<=[.!?;])\s+|\n+/u).filter(Boolean);
  for (const clause of clauses) {
    let normalized = clean(clause);
    // Compare a complete spoken year as one detail, not shared century words.
    for (const year of wording.match(/\b(?:18|19|20)\d{2}\b/gu) ?? []) {
      normalized = normalized.replaceAll(clean(normalizeForSpeech(year)), year);
    }
    const spoken = new Set(words(normalized));
    const overlap = [...terms].filter(term => spoken.has(term));
    for (const [relation, pattern] of relations) {
      const predicate = pattern.exec(normalized);
      if (!predicate || !overlap.length) continue;
      if (/\b(?:pas|jamais|nicht|nie|nao|non)\b/u.test(normalized)) continue;
      // Negation belongs to the predicate, not incidental "no less" or
      // "you might not be surprised" elsewhere in the sentence.
      if (/\b(?:not|never|didnt|wasnt|isnt|no)\s+(?:(?:an?|ever|really|actually|been|be|being|huge|primary)\s+){0,3}$/u
        .test(normalized.slice(0, predicate.index))) continue;
      if (relation === 'description' && (overlap.length < 2 || overlap.length < terms.size / 2)) continue;
      // A ranking must name its actual list/source, not just another award.
      if (relation === 'recognition') {
        const anchors = ['pitchfork', 'guardian', 'rolling stone', '1001', 'polaris', 'grammy', 'attitude'];
        const expected = anchors.filter(anchor => claim.includes(anchor));
        if (expected.length && !expected.some(anchor => normalized.includes(anchor))) continue;
      }
      // Preserve the direction of sample/cover statements when identities are explicit.
      if (relation === 'sample' || relation === 'cover' || relation === 'influence' || relation === 'writing' || relation === 'production') {
        const edge = /^(.*?)\s+(samples|is a cover version of|has been covered by|influenced|inspired|was influenced by|was inspired by|wrote|was written by|produced|was produced by)\s+(.+?)[.!]?$/u.exec(claim);
        if (edge) {
          const sentence = ` ${words(normalized).join(' ')} `;
          const subjectAt = sentence.indexOf(` ${words(edge[1]).join(' ')} `);
          const targetAt = sentence.indexOf(` ${words(edge[3]).join(' ')} `);
          const claimPassive = edge[2].endsWith(' by');
          const spokenPassive = /\b(?:sampled|covered|influenced|inspired|written|produced) by\b/u.test(normalized);
          if (subjectAt < 0 || targetAt < 0
            || (subjectAt < targetAt) !== (claimPassive === spokenPassive)) continue;
        }
      }
      const contradiction=claimDetailContradiction(clause,wording,context);
      if(contradiction)return result('not-detected',contradiction,clause.trim(),overlap);
      return result('detected', `Shared ${relation} relation and factual detail`, clause.trim(), overlap);
    }
  }
  return result('not-detected', 'No clause shares the offered relation and factual detail');
}
