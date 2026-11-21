import { Btn } from './ui';

/** The same sticky pending-changes layout used by SettingsPanel. */
export default function NotesSettingsSaveBar({count,section,busy,invalid,onSave,onDiscard}: {
  count:number; section:string; busy:boolean; invalid?:boolean; onSave:()=>void; onDiscard:()=>void;
}) {
  if (!count) return null;
  return <div className="sticky top-[3.25rem] z-30 grid gap-2.5 border border-vermilion bg-bg p-3 shadow-drawer">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="size-2 shrink-0 bg-vermilion" aria-hidden />
      <span role="status" className="text-[11px] font-bold tracking-[0.2em] uppercase">{count} unsaved change{count===1?'':'s'} in {section}</span>
      <Btn sm className="ml-auto" onClick={onDiscard} disabled={busy}>Discard</Btn>
    </div>
    <div className="flex flex-wrap items-center gap-3">
      <span className="min-w-0 flex-1 text-[12px] leading-[1.5] break-words text-muted">Changes apply after saving. Discard restores your saved settings.</span>
      <Btn tone="accent" onClick={onSave} disabled={busy||invalid} className="w-full sm:ml-auto sm:w-auto">{busy?'Saving…':`Save ${section} settings`}</Btn>
    </div>
  </div>;
}
