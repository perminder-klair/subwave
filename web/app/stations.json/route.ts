// Runtime JSON view of the community stations directory. The /stations page
// renders this same data as HTML; the native app needs it as JSON so a fresh
// installer can browse and tune in without knowing any URL.
//
// NOTE: this lives at /stations.json, NOT under /api — on getsubwave.com the
// Caddyfile routes /api/* to the controller, so an /api/stations route would
// never reach this Next.js app. Everything outside /api + /stream.mp3 hits web.
import { NextResponse } from 'next/server';
import { getAllStations } from '@/lib/stations';

// The directory is sourced from the community catalog (ISR-revalidated in
// stations.ts), so this feed re-generates on that cadence rather than only at
// deploy time. force-static keeps it a cached static asset between revalidations.
export const dynamic = 'force-static';

export async function GET() {
  return NextResponse.json(await getAllStations(), {
    headers: {
      'Cache-Control': 'public, max-age=300',
      // RN fetch ignores CORS, but this lets a browser client reuse the feed too.
      'Access-Control-Allow-Origin': '*',
    },
  });
}
