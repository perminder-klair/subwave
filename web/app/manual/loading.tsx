import BroadsheetPageSkeleton from '@/components/ui/page-skeleton';

// Streams instantly on navigation and, more importantly, gives Next something
// real to put in the <Link> prefetch for this force-dynamic route. See the note
// in components/ui/page-skeleton.tsx.
export default function Loading() {
  return <BroadsheetPageSkeleton variant="article" />;
}
