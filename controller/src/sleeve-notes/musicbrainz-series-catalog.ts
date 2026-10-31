import type { MusicBrainzSeriesEntityType } from '../music/musicbrainz.js';

/**
 * Curated MusicBrainz Series used by Extended Sleeve Notes. Keep recording
 * lists ahead of release-group lists so track-level recognition is collected
 * first. Runtime definitions and operator controls live in series-catalog-store.ts.
 */
export interface DefaultMusicBrainzSeries {
  id: string;
  label: string;
  entityType: MusicBrainzSeriesEntityType;
  ranked: boolean;
  order: number;
  editionGroup?: '1001-albums';
  editionYear?: number;
}

export const DEFAULT_MUSICBRAINZ_SERIES: readonly DefaultMusicBrainzSeries[] = [
  {
    id: 'b8d22d6d-cd22-4eee-add5-2e2249130054',
    label: "Pitchfork's 200 Best Songs of the 2010s",
    entityType: 'recording', ranked: true, order: 0,
  },
  {
    id: '2b266ad9-15f9-4cb4-9172-519c5cb0e0cc',
    label: "Pitchfork's 100 Best Songs of the 2020s So Far",
    entityType: 'recording', ranked: true, order: 1,
  },
  {
    id: '4bc2a338-e1d8-4546-8a61-640da8aaf888',
    label: '1001 Albums You Must Hear Before You Die',
    entityType: 'release-group', ranked: false, order: 2,
    editionGroup: '1001-albums', editionYear: 2005,
  },
  {
    id: '48acb3cb-7daa-42b0-9af7-12a06cad0bbe',
    label: '1001 Albums You Must Hear Before You Die',
    entityType: 'release-group', ranked: false, order: 3,
    editionGroup: '1001-albums', editionYear: 2008,
  },
  {
    id: '45dcf1d4-4b03-4afb-a57c-dfe6c03bcab1',
    label: '1001 Albums You Must Hear Before You Die',
    entityType: 'release-group', ranked: false, order: 4,
    editionGroup: '1001-albums', editionYear: 2013,
  },
  {
    id: '0d8822f8-0da9-4a00-8b97-fa7f8683aae4',
    label: '1001 Albums You Must Hear Before You Die',
    entityType: 'release-group', ranked: false, order: 5,
    editionGroup: '1001-albums', editionYear: 2021,
  },
  {
    id: 'd624997d-f585-47cb-ab27-e4254c08bf1a',
    label: '1001 Albums You Must Hear Before You Die',
    entityType: 'release-group', ranked: false, order: 6,
    editionGroup: '1001-albums', editionYear: 2023,
  },
  {
    id: 'bb3d9d84-75b8-4e67-8ad7-dcc38f764bf3',
    label: "Rolling Stone's 500 Greatest Albums of All Time (2023 edition)",
    entityType: 'release-group', ranked: true, order: 7,
  },
  {
    id: 'efbe4c84-5f83-470f-be53-ef4089ef3010',
    label: "Pitchfork's 200 Best Albums of the 1960s",
    entityType: 'release-group', ranked: true, order: 8,
  },
  {
    id: 'f2e5e744-d9a7-41f5-bc95-6ee787122bc1',
    label: "Pitchfork's 200 Best Albums of the 1970s",
    entityType: 'release-group', ranked: true, order: 9,
  },
  {
    id: '2d7fadbe-6e29-471c-adb9-1d5f78c26b63',
    label: "Pitchfork's 200 Best Albums of the 1980s",
    entityType: 'release-group', ranked: true, order: 10,
  },
  {
    id: '4d544556-8519-4a20-b854-af57256d9717',
    label: "Pitchfork's 150 Best Albums of the 1990s",
    entityType: 'release-group', ranked: true, order: 11,
  },
  {
    id: 'd9bc7eab-1e3c-468f-836d-5dc231299d65',
    label: "Rolling Stone's 100 Best Albums of the 2000s",
    entityType: 'release-group', ranked: true, order: 12,
  },
  {
    id: 'ecae5db8-a33e-45d3-a345-9acab6d5c559',
    label: "Pitchfork's 200 Best Albums of the 2010s",
    entityType: 'release-group', ranked: true, order: 13,
  },
  {
    id: 'e546b910-b88f-4c92-b928-29943a68dca8',
    label: "Pitchfork's 100 Best Albums of the 2020s So Far",
    entityType: 'release-group', ranked: true, order: 14,
  },
  {
    id: 'acf170fe-b358-4140-9e32-93a9c7afa544',
    label: 'The Guardian 100 Best Albums Ever',
    entityType: 'release-group', ranked: true, order: 15,
  },
];
