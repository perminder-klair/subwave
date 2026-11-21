import type { ResearchGapSnapshot } from '../../lib/schemas.generated';
import type {ConnectionNode} from './connections/types';

export function groupAiredStories<T extends {id:string;segmentId?:string|null;conversation?:{id:string}|null}>(items:readonly T[]) {
  const groups=new Map<string,T[]>();
  for(const item of items) {
    const key=item.conversation?.id??item.segmentId??item.id;
    groups.set(key,[...(groups.get(key)??[]),item]);
  }
  return groups;
}

export function storiesHref(node:Pick<ConnectionNode,'id'|'entityType'|'entityId'|'title'>,query:string):string {
  const params=new URLSearchParams(query);
  params.set('tab','stories');params.set('from','brain');params.set('brainSelected',node.id);
  if(['artist','recording','release','release-group'].includes(node.entityType)) {
    params.delete('q');params.set('storyType',node.entityType);params.set('storyId',node.entityId);params.set('storyName',node.title);
  } else {
    params.delete('storyType');params.delete('storyId');params.set('q',node.title);
  }
  return `/admin/notes?${params}`;
}


export function formatNotesDate(value: string | null | undefined, timezone?: string): string {
  if (!value || !Number.isFinite(new Date(value).getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }).format(new Date(value));
}


/** Queue defaults follow the visible layer; a selected child narrows its scope. */
export function brainQueueChoice(overview:boolean,root:ConnectionNode|null|undefined,selected:ConnectionNode|null) {
  const local=(node:ConnectionNode|null|undefined)=>node?.local?node:null;
  if (overview) return {node:selected?.kind==='artist'?local(selected):null,label:'Choose a Track and Queue'};
  if (root?.kind==='artist') {
    const album=selected?.kind==='release'?local(selected):null;
    return {node:album??local(root),label:album?'Choose Album Track and Queue':'Choose Artist Track and Queue'};
  }
  if (root?.kind==='release') {
    const track=selected?.kind==='recording'?local(selected):null;
    return {node:track??local(root),label:track?'Queue This Track':'Choose Any Album Track and Queue'};
  }
  return {node:selected&&['artist','release','recording'].includes(selected.kind)?local(selected):null,label:'Queue This Track'};
}

/** Choose a biography editor target, never merge or authorise artist identities. */
export function artistResearchSource(item: Pick<ResearchGapSnapshot['items'][number], 'name'|'identities'>) {
  const key=(name:string)=>name.normalize('NFKC').replace(/[‘’]/gu,"'").trim().replace(/\s+/gu,' ').toLocaleLowerCase();
  const named=item.identities.filter(identity=>key(identity.name)===key(item.name));
  const matched=named.filter(identity=>identity.matchedTracks>0);
  if (matched.length) return matched.length===1?matched[0]:null;
  const canonical=named.filter(identity=>identity.mbid);
  if (canonical.length) return canonical.length===1?canonical[0]:null;
  return named.length===1?named[0]:null;
}
