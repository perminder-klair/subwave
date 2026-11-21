import assert from 'node:assert/strict';
import test from 'node:test';
import { currentArtistOnOverview } from './current-artist';
import type { ConnectionGraphData, ConnectionNode, ConnectionSearchResult } from './types';
const artist = (id: string, title = 'New Order'): ConnectionNode => ({ id, entityId: id, entityType: 'artist', kind: 'artist', title, subtitle: null, local: true, expandable: true, sourceUrl: null });
const graph = (nodes: ConnectionNode[]): ConnectionGraphData => ({ active: true, focusId: '', nodes, edges: [], truncated: false });
const track: ConnectionSearchResult = { nodeId: 'recording:track', entityId: 'track', entityType: 'recording', kind: 'recording', title: 'Age of Consent', subtitle: 'New Order', artistNodeId: 'artist:canonical', localArtistId: 'local' };
test('confirmed identity targets the overview artist even when names are ambiguous', () => {
  const canonical = artist('artist:canonical');
  assert.equal(currentArtistOnOverview(graph([canonical, artist('another')]), track, 'New Order'), canonical);
});
test('local identity finds the overview node without a canonical overview match', () => {
  const local = { ...artist('library-artist:local'), localArtistId: 'local' };
  assert.equal(currentArtistOnOverview(graph([local]), track, 'Another artist credit'), local);
});
test('a freshly opened map can target an unencountered library artist before the track is matched', () => {
  const local = { ...artist('library-artist:local'), researched: false };
  assert.equal(currentArtistOnOverview(graph([local]), undefined, ' new   order '), local);
});
test('name fallback refuses ambiguous artists, external references and missing names', () => {
  assert.equal(currentArtistOnOverview(graph([artist('one'), artist('two')]), undefined, 'New Order'), null);
  assert.equal(currentArtistOnOverview(graph([{ ...artist('external'), local: false }]), undefined, 'New Order'), null);
  assert.equal(currentArtistOnOverview(graph([artist('one')]), undefined, undefined), null);
});
