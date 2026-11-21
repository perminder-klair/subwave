import type { ResearchCandidate, ResearchJob } from './researcher.js';

type Passage = { id: string; text: string };

function passagesFrom(text: string): Passage[] {
  const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  return [...segmenter.segment(text.normalize('NFKC').replace(/\s+/g, ' ').trim())]
    .map(({ segment }, index) => ({ id: `E${String(index + 1).padStart(3, '0')}`, text: segment.trim() }))
    .filter(({ text }) => !!text);
}

function albumArtist(opening: string): string | null {
  const patterns = [
    /\balbum by (?:the )?(?:rock band |band |group |artist |singer-songwriter )?([^,.]+?)(?:,|\.|$)/iu,
    /\bis ([\p{Lu}][\p{L}'’ -]+?)[’']s (?:\w+\s+)?album\b/u,
    /^([\p{Lu}][\p{L}'’ -]+?)[’']s \w+ (?:studio )?album\b/u,
  ];
  for (const pattern of patterns) {
    const match = opening.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function evidenceSpan(passages: readonly Passage[], targetIndex: number): string {
  let start = 0;
  let evidence = passages.slice(start, targetIndex + 1).map(({ text }) => text).join(' ');
  while (evidence.length > 900 && start < targetIndex) {
    start++;
    evidence = passages.slice(start, targetIndex + 1).map(({ text }) => text).join(' ');
  }
  return evidence;
}

function topicFor(sentence: string): string | null {
  if (/\b(?:album title|title came|misread)\w*/iu.test(sentence)) return 'album title origin';
  if (/\b(?:vocal|singer)\w*/iu.test(sentence)) return 'vocal collaboration';
  if (/\b(?:lyric|songwrit|writ|inspir)\w*/iu.test(sentence)) return 'songwriting inspiration';
  if (/\b(?:blend|dynamics|demo|poppier|electronic)\w*/iu.test(sentence)) return 'album sound and recording';
  if (/\b(?:produc|collaborat)\w*/iu.test(sentence)) return 'creative collaboration';
  if (/\b(?:recording|sound|structure)\w*/iu.test(sentence)) return 'album sound and recording';
  if (/\b(?:concept|soundtrack|cover|sample|dedicat)\w*/iu.test(sentence)) return 'album concept';
  return null;
}

function fullNameFor(name: string, context: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...context.matchAll(new RegExp(`\\b([\\p{Lu}][\\p{L}’'-]+\\s+${escaped})\\b`, 'gu'))];
  return matches.at(-1)?.[1] ?? null;
}

function fullFromPassage(passage: string, album: string, artist: string | null, context: string): string {
  let full = passage.trim();
  // A quote after a complete factual lead often breaks sentence segmentation.
  // Keep that lead, with its source attribution, rather than a clipped quote.
  full = full.replace(/:\s*(?:I\b|We\b|You\b|It\b|\[)/u, '.');
  if (full.includes('. ') && /:\s*(?:I\b|We\b|You\b|It\b|\[)/u.test(passage)) {
    full = full.slice(0, full.indexOf('. ') + 1);
  }
  full = full.replace(/^The album\b/u, album).replace(/^It\b/u, album);
  if (artist) {
    full = full.replace(/\bthe band\b/giu, artist);
    const first = artist.split(/\s+/)[0];
    if (first && artist.includes(' ')) {
      full = full.replace(new RegExp(`\\b${first}\\b(?!\\s+${artist.split(/\s+/).slice(1).join('\\s+')})`, 'gu'), artist);
    }
  }
  full = full.replace(/\bthe album title\b/giu, `the title of ${album}`);
  const leadingSurname = full.match(/^([\p{Lu}][\p{L}'’-]+)\b/u)?.[1];
  if (leadingSurname && leadingSurname !== album.split(/\s+/)[0]) {
    const fullName = fullNameFor(leadingSurname, context);
    if (fullName) full = fullName + full.slice(leadingSurname.length);
  }
  if (!full.toLocaleLowerCase().includes(album.toLocaleLowerCase())) {
    full = `On ${album}, ${/^The\b/u.test(full) ? `the${full.slice(3)}` : full}`;
  }
  return /[.!?]$/.test(full) ? full : `${full.replace(/[,:;\s]+$/u, '')}.`;
}

/** One grounded candidate per useful source sentence; no model selection. */
export function extractGeniusAlbumCandidates(job: ResearchJob): ResearchCandidate[] {
  const album = job.document.entityName?.trim();
  if (!album) return [];
  const passages = passagesFrom(job.document.text);
  if (!passages.length) return [];
  const artist = albumArtist(passages[0].text);
  const candidates: ResearchCandidate[] = [];
  for (const [index, passage] of passages.slice(0, 8).entries()) {
    const evidence = evidenceSpan(passages, index);
    if (evidence.length > 900) continue;
    let topic: string | null = null;
    let wording: string;
    if (index === 0) {
      if (!artist || !/\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d+(?:st|nd|rd|th))\b.{0,30}\balbum\b/iu.test(passage.text)) continue;
      topic = 'album identity';
      wording = passage.text.replace(/,\s*released\b.*$/iu, '.');
      if (!/[.!?]$/.test(wording)) wording += '.';
    } else {
      if (/\b(?:cancer|tumou?r|surgery|divorc|bipolar|treatment|died|death)\w*/iu.test(passage.text)
        || /\b(?:teas(?:ed|er)|announcement|billboards?|posters?|instagram|tracklist|pre-release)\b/iu.test(passage.text)
        || /^(?:I|We|You|It’s|It's|So I|Her|His|Their|She|He|They|This|That)\b/u.test(passage.text)) continue;
      topic = topicFor(passage.text);
      if (!topic) continue;
      wording = fullFromPassage(passage.text, album, artist,
        passages.slice(0, index).map(({ text }) => text).join(' '));
      if (/\b(?:commented|said|stated|explained|told)(?: in (?:a|the) [^.]+)?\.$/iu.test(wording)) continue;
    }
    if (wording.length < 8 || wording.length > 360) continue;
    candidates.push({ category: 'release-stories', topic, wording, evidence });
    if (candidates.length >= job.maxCandidates) break;
  }
  return candidates;
}
