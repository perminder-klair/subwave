'use client';

import { useState } from 'react';
import type { ResearchGapSnapshot } from '../../lib/schemas.generated';
import type { AdminFetch } from '../../lib/admin-query';
import { artistResearchSource, formatNotesDate } from './sleeve-notes-view';
import ResearchSourceEditor from './ResearchSourceEditor';
import { Btn } from './ui';

type ResearchArtist=ResearchGapSnapshot['items'][number];
export default function ResearchArtistSource({artist,adminFetch,timezone,readOnly,onSaved}: {
  artist:ResearchArtist;adminFetch:AdminFetch;timezone?:string;readOnly:boolean;onSaved:()=>Promise<unknown>;
}) {
  const [selectedId,setSelectedId]=useState<string|null>(null),[editing,setEditing]=useState(false);
  const recommended=artistResearchSource(artist);
  const primary=artist.identities.find(identity=>identity.id===selectedId)??recommended;
  const biography=primary?.override?.wikipediaUrl||primary?.articleUrl;
  return <div className="space-y-3">
    {primary?<>
      <p className="text-[13px]">Biography:{' '}{biography?<a href={biography} target="_blank" rel="noreferrer" className="text-primary hover:underline">Wikipedia article ↗</a>:<span className="text-muted">Not collected yet</span>}
        {primary.override&&<span className="text-xs text-muted"> · Custom research source</span>}</p>
      {selectedId&&selectedId!==recommended?.id&&<p className="text-xs text-muted">Editing the source record selected below: {primary.name}. {primary.mbid?'Identified by MusicBrainz.':'No confirmed MusicBrainz identity.'}</p>}
      {!readOnly&&<ResearchSourceEditor key={`${primary.id}:${JSON.stringify(primary.override)}`} identity={primary} adminFetch={adminFetch} onSaved={onSaved} onEditingChange={setEditing} />}
    </>:<p className="text-[13px] text-muted">{artist.identities.length
      ?readOnly?'The artist match needs checking. Advanced source details show the saved records.':'The artist match needs checking. Some recordings may be matched to a different artist. Open Advanced source details and choose the record to edit.'
      :'No artist match is saved yet. Open this artist in Station Brain to request research.'}</p>}
    {!!artist.identities.length&&<details className="text-[13px]"><summary className="cursor-pointer">Advanced source details</summary>
      <p className="mt-3 text-xs text-muted">Subwave can keep separate records from different sources for the same artist. These records remain separate. Check the artist links and recording matches before choosing a different record to edit.</p>
      {editing&&<p className="mt-2 text-xs text-muted">Save or discard your source edit before choosing another record.</p>}
      <div className="mt-3 space-y-4">{artist.identities.map(identity=><div key={identity.id} className="space-y-2 border-l border-border pl-3">
        <p className="font-medium">{identity.name}{identity.id===primary?.id&&<span className="font-normal text-muted"> · Current research record</span>}</p>
        <p className="text-xs text-muted">{identity.matchedTracks} matched {identity.matchedTracks===1?'library recording':'library recordings'} · {identity.storyCount} saved story facts</p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
          {identity.mbid?<a href={`https://musicbrainz.org/artist/${encodeURIComponent(identity.mbid)}`} target="_blank" rel="noreferrer" className="text-primary hover:underline">MusicBrainz artist ↗</a>:<span className="text-muted">Provisional record · no MusicBrainz identity</span>}
          {identity.articleUrl?<a href={identity.articleUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">Saved Wikipedia source ↗</a>:<span className="text-muted">No saved artist biography</span>}
          {identity.override?.musicBrainzId&&<a href={`https://musicbrainz.org/artist/${encodeURIComponent(identity.override.musicBrainzId)}`} target="_blank" rel="noreferrer" className="text-primary hover:underline">Research MusicBrainz override ↗</a>}
          {identity.override?.wikipediaUrl&&<a href={identity.override.wikipediaUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">Research Wikipedia override ↗</a>}
        </div>
        {identity.verification&&<p className="text-xs text-muted">Last source check: {identity.verification.state==='found'?'Article found':identity.verification.state==='missing'?'No usable article found':identity.verification.state==='failed'?'Check failed':identity.verification.state==='cancelled'?'Cancelled':'Pending'}{identity.verification.checkedAt?` · ${formatNotesDate(identity.verification.checkedAt,timezone)}`:''}
          {identity.verification.sourceUrl&&<> · <a href={identity.verification.sourceUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">Checked article ↗</a></>}
          {identity.verification.lastError&&<> · {identity.verification.lastError}</>}</p>}
        {!readOnly&&identity.id!==primary?.id&&<Btn sm disabled={editing} onClick={()=>setSelectedId(identity.id)}>Use this record for editing</Btn>}
      </div>)}</div>
    </details>}
  </div>;
}
