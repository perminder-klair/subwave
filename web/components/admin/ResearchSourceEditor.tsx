'use client';

import { useState } from 'react';
import { useZodForm } from '../../lib/form';
import { TextField } from '../../lib/form-fields';
import { researchOverrideSchema, type ResearchGapSnapshot, type ResearchOverride } from '../../lib/schemas.generated';
import { adminJson, useAdminMutation, type AdminFetch } from '../../lib/admin-query';
import { notify } from '../../lib/notify';
import { Btn } from './ui';

type Identity=ResearchGapSnapshot['items'][number]['identities'][number];
export default function ResearchSourceEditor({identity,adminFetch,onSaved,onEditingChange}: {identity:Identity;adminFetch:AdminFetch;onSaved:()=>Promise<unknown>;onEditingChange?:(editing:boolean)=>void}) {
  const [editing,setEditing]=useState(false);
  const setEditorOpen=(open:boolean)=>{setEditing(open);onEditingChange?.(open);};
  const form=useZodForm(researchOverrideSchema,{musicBrainzId:identity.override?.musicBrainzId??'',wikipediaUrl:identity.override?.wikipediaUrl??''});
  const save=useAdminMutation<{queued:boolean},ResearchOverride>({adminFetch,
    request:(value,fetcher)=>adminJson(fetcher,`/sleeve-notes/research-gaps/${encodeURIComponent(identity.id)}/override`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)}),
    onDone:async(data,value)=>{form.reset(value);setEditorOpen(false);notify.ok(data.queued?'Research source saved. Fresh research is queued.':'Automatic lookup restored. A confirmed artist identity is needed before research can run.');await onSaved();},
  });
  const rescan=useAdminMutation<unknown,void>({adminFetch,
    request:(_value,fetcher)=>adminJson(fetcher,`/sleeve-notes/research-gaps/${encodeURIComponent(identity.id)}/rescan`,{method:'POST'}),
    onDone:async()=>{notify.ok('Fresh biography research queued. Broadcast and source limits still apply.');await onSaved();},
  });
  // Subscribe to both flags before the button condition can short-circuit.
  // Otherwise a one-field edit can leave validity stale until another edit.
  const {isDirty,isValid}=form.formState;
  const busy=save.isPending||rescan.isPending;
  return <div className="space-y-3 pt-2">
    <div className="flex flex-wrap gap-3">
      <Btn sm disabled={busy} onClick={()=>{form.reset({musicBrainzId:identity.override?.musicBrainzId??'',wikipediaUrl:identity.override?.wikipediaUrl??''});setEditorOpen(!editing);}}>{editing?'Close editor':'Edit research source'}</Btn>
      <Btn sm disabled={busy||editing||!(identity.mbid||identity.override?.musicBrainzId||identity.override?.wikipediaUrl)} onClick={()=>rescan.mutate()}>{rescan.isPending?'Queueing…':'Rescan artist'}</Btn>
    </div>
    {editing&&<form className="max-w-2xl space-y-4 border border-border p-4" onSubmit={form.handleSubmit(value=>save.mutate(value))}>
      <p className="text-[13px]">Use a source you have checked belongs to {identity.name}. This changes biography research only; it does not correct recording matches or merge artists.</p>
      <TextField control={form.control} name="musicBrainzId" label="MusicBrainz artist override" description="Paste the artist page link or ID. Leave blank to use the matched identity." disabled={busy} />
      <TextField control={form.control} name="wikipediaUrl" label="English Wikipedia article override" description="Optional. A supplied article takes priority over the MusicBrainz links. Redirects are followed; disambiguation pages are rejected." disabled={busy} />
      <p className="text-xs text-muted">Saving queues fresh research. Changing a source takes automatic facts from the previous artist biography out of DJ use; approved facts and airing history are kept. Clear both fields to return to automatic source lookup.</p>
      <div className="flex flex-wrap gap-3"><Btn type="submit" sm disabled={busy||!isDirty||!isValid}>{save.isPending?'Saving…':'Save and rescan'}</Btn><Btn sm disabled={busy} onClick={()=>{form.reset();setEditorOpen(false);}}>Discard</Btn></div>
    </form>}
    {(save.error||rescan.error)&&<p role="alert" className="text-xs text-vermilion">{(save.error??rescan.error)?.message}</p>}
  </div>;
}
