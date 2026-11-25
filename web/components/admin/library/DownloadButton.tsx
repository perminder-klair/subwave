'use client';

// The Library download, one look in every place (download-policy.ts has the
// rules): the shared selection bar downloads the ticked rows on every tab
// (SelectionDownload), and a list's card header downloads the whole list where
// that makes sense (ListDownload: Liked, a narrowed Browse list), else shows a
// short hint. One track saves as its original file, several as one zip that the
// controller builds as it streams. The POST answers a short-lived signed link
// and the browser navigates to it, so a many-GB body goes straight to disk
// instead of through fetch() into memory (controller: routes/library/download.ts).

import { useState, type ReactNode } from 'react';
import { Download } from 'lucide-react';
import { Btn } from '../ui';
import { V3AlertDialog } from '../../ui/alert-dialog';
import { ADMIN_API_URL } from '../../../lib/adminAuth';
import { adminJson, useAdminMutation } from '../../../lib/admin-query';
import { notify } from '../../../lib/notify';
import { useLibrary } from './LibraryContext';
import {
  confirmText, downloadLabel, listBody, listOffer, listTitle, needsConfirm, selectionBody, selectionTitle, sizeText,
  type DownloadBody, type DownloadLink, type ListOffer, type ListSource,
} from './download-policy';

// The one button, apart from the hooks so its states render in a test: the
// small bordered button of a card's action row and of the selection bar, never
// the accent (that is the bar's primary action's).
export function DownloadControl({ count, pending, onClick, title }: {
  count: number | null;
  pending: boolean;
  onClick: () => void;
  title: string;
}) {
  return (
    <Btn sm onClick={onClick} disabled={pending || !count} title={title}>
      <Download size={11} /> {downloadLabel(count, pending)}
    </Btn>
  );
}

// A list header's slot: the button, or the hint saying why there is none.
export function ListDownloadView({ offer, kind, pending, onClick }: {
  offer: ListOffer;
  kind: ListSource['kind'];
  pending: boolean;
  onClick: () => void;
}) {
  if (offer.kind === 'none') return null;
  if (offer.kind === 'hint') return <span className="text-[11px] text-muted">{offer.text}</span>;
  return <DownloadControl count={offer.count} pending={pending} onClick={onClick} title={listTitle(kind)} />;
}

// Starts the browser's own download of the signed link. The answer is an
// attachment, so the page stays where it is.
function startDownload(link: DownloadLink) {
  const a = document.createElement('a');
  a.href = `${ADMIN_API_URL}${link.path}`;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  notify.ok(`download started · ${link.count} track${link.count === 1 ? '' : 's'}`
    + (link.single ? '' : ' in one zip') + ` · ${sizeText(link)}`);
}

// The POST (its own answer is the link), then the confirm above 50 tracks or
// 2 GB, then the browser's download. `dialog` renders beside the button.
function useDownload(): { start: (body: DownloadBody) => void; pending: boolean; dialog: ReactNode } {
  const { adminFetch } = useLibrary();
  const [confirm, setConfirm] = useState<DownloadLink | null>(null);
  const mutation = useAdminMutation<DownloadLink, DownloadBody>({
    adminFetch,
    request: (body, fetcher) => adminJson<DownloadLink>(fetcher, '/library/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  });
  const start = async (body: DownloadBody) => {
    let link: DownloadLink;
    try {
      link = await mutation.mutateAsync(body);
    } catch {
      return; // useAdminMutation has toasted it
    }
    if (needsConfirm(link)) setConfirm(link);
    else startDownload(link);
  };
  const dialog = (
    <V3AlertDialog
      open={confirm !== null}
      onOpenChange={open => { if (!open) setConfirm(null); }}
      title="Download"
      description={confirm ? confirmText(confirm) : ''}
      confirmLabel={confirm ? downloadLabel(confirm.count, false) : 'download'}
      onConfirm={() => { if (confirm) startDownload(confirm); }}
    />
  );
  return { start: body => { void start(body); }, pending: mutation.isPending, dialog };
}

// The ticked rows, from the shared selection bar.
export function SelectionDownload({ ids }: { ids: readonly string[] }) {
  const { start, pending, dialog } = useDownload();
  return (
    <>
      <DownloadControl
        count={ids.length} pending={pending} title={selectionTitle(ids.length)}
        onClick={() => start(selectionBody(ids))}
      />
      {dialog}
    </>
  );
}

// The whole list, from its card header: `total` counts every page (null until
// the list has answered).
export function ListDownload({ source, total }: { source: ListSource; total: number | null }) {
  const { start, pending, dialog } = useDownload();
  return (
    <>
      <ListDownloadView
        offer={listOffer(source, total)} kind={source.kind} pending={pending}
        onClick={() => start(listBody(source))}
      />
      {dialog}
    </>
  );
}
