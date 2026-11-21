import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileBrainNetwork } from './brain-network';
import { toggleConnectionGroup } from './filters';
import type { ConnectionGraphData, ConnectionNode } from './types';

const artist = (id: string): ConnectionNode => ({ id, kind: 'artist', entityType: 'artist', entityId: id,
  title: id, subtitle: null, local: true, expandable: true, sourceUrl: null });
function fixture(): ConnectionGraphData {
  return { active: true, focusId: '', nodes: [artist('one'), artist('two')], edges: [{ id: 'sample',
    source: 'one', target: 'two', type: 'samples', label: 'samples tracks by', provider: 'genius',
    sourceUrl: null, evidence: 'A retained connection.', attribution: null }], truncated: false };
}

test('metadata refresh retains physics objects and positions without changing cached graph data', () => {
  const data = fixture();
  data.nodes.forEach(Object.freeze); data.edges.forEach(Object.freeze);
  const network = reconcileBrainNetwork(null, data, 'artists');
  network.nodes[0]!.x = 412; network.nodes[0]!.y = -79;
  network.links[0]!.source = network.nodes[0]!; network.links[0]!.target = network.nodes[1]!;
  const refreshed = { ...fixture(), nodes: [{ ...artist('one'), trackCount: 55 }, artist('two')],
    edges: [{ ...fixture().edges[0]!, count: 2 }] } as ConnectionGraphData;
  const updated = reconcileBrainNetwork(network, refreshed, 'artists');
  assert.equal(updated, network);
  assert.equal(updated.nodes[0]!.x, 412); assert.equal(updated.nodes[0]!.y, -79);
  assert.equal(updated.nodes[0]!.trackCount, 55); assert.equal(updated.links[0]!.count, 2);
  assert.equal(updated.links[0]!.source, updated.nodes[0]!);
  assert.equal('x' in data.nodes[0]!, false); assert.equal(data.edges[0]!.source, 'one');
});

test('new connections preserve explored positions and seed new nodes near an existing neighbour', () => {
  const data = fixture();
  const network = reconcileBrainNetwork(null, data, 'artists');
  network.nodes[0]!.x = 250; network.nodes[0]!.y = 500;
  const refreshed = { ...data, nodes: [...data.nodes, artist('three')],
    edges: [...data.edges, { ...data.edges[0]!, id: 'new', source: 'one', target: 'three' }] };
  const updated = reconcileBrainNetwork(network, refreshed, 'artists');
  assert.equal(updated.nodes[0]!, network.nodes[0]!);
  assert.equal(updated.nodes[0]!.fx, 250); assert.equal(updated.nodes[0]!.fy, 500);
  assert.ok(Math.hypot(updated.nodes[2]!.x! - 250, updated.nodes[2]!.y! - 500) < 26);
});

test('an explicit new focus starts a fresh layout even when entity IDs overlap', () => {
  const data = fixture(), previous = reconcileBrainNetwork(null, data, 'artists');
  previous.nodes[0]!.x = 900; previous.nodes[0]!.fx = 900;
  const next = reconcileBrainNetwork(previous, { ...data, focusId: 'one' }, 'one');
  assert.notEqual(next.nodes[0]!, previous.nodes[0]!);
  assert.notEqual(next.nodes[0]!.x, 900); assert.equal(next.nodes[0]!.fx, undefined);
});

test('reordered background data retains the layout instead of reshuffling the constellation', () => {
  const data = fixture(), previous = reconcileBrainNetwork(null, data, 'artists');
  assert.equal(reconcileBrainNetwork(previous, { ...data, nodes: [...data.nodes].reverse() }, 'artists'), previous);
});

test('the key hides a complete family including inverse connections, then restores it', () => {
  const selected = ['samples', 'sampled-in', 'cover-of', 'producer'] as const;
  const hidden = toggleConnectionGroup(selected, ['samples', 'sampled-in']);
  assert.deepEqual(hidden, ['cover-of', 'producer']);
  assert.deepEqual(toggleConnectionGroup(hidden, ['samples', 'sampled-in']), [...selected]);
  assert.deepEqual(toggleConnectionGroup(['sampled-in', 'writer'], ['samples', 'sampled-in']), ['writer']);
});
