import type { ConnectionEdge, ConnectionGraphData, ConnectionNode } from './types';

export type BrainNetworkNode = ConnectionNode & { x?: number; y?: number; vx?: number; vy?: number; fx?: number; fy?: number };
export type BrainNetworkLink = Omit<ConnectionEdge, 'source' | 'target'> & {
  source: string | BrainNetworkNode; target: string | BrainNetworkNode;
};
export interface BrainNetwork {
  scope: string;
  nodes: BrainNetworkNode[];
  links: BrainNetworkLink[];
}
function id(value: string | BrainNetworkNode): string { return typeof value === 'string' ? value : value.id; }

/** The canvas owns these mutable objects; query-cache objects never reach physics. */
export function reconcileBrainNetwork(previous: BrainNetwork | null, data: ConnectionGraphData, scope: string): BrainNetwork {
  const sameScope = previous?.scope === scope;
  const oldNodes = new Map(sameScope ? previous.nodes.map((node) => [node.id, node]) : []);
  const oldLinks = new Map(sameScope ? previous.links.map((link) => [link.id, link]) : []);
  const sameTopology = sameScope && previous.nodes.length === data.nodes.length && previous.links.length === data.edges.length
    && data.nodes.every((node) => oldNodes.has(node.id))
    && data.edges.every((edge) => {
      const saved = oldLinks.get(edge.id);
      return saved && id(saved.source) === edge.source && id(saved.target) === edge.target;
    });
  const nodes = data.nodes.map((node, index): BrainNetworkNode => {
    const saved = oldNodes.get(node.id);
    if (saved) {
      Object.assign(saved, node);
      // New relationships can reheat physics. Anchor the existing constellation
      // so only new nodes settle around it instead of moving explored artists.
      if (!sameTopology && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
        saved.fx = saved.x; saved.fy = saved.y;
      }
      return saved;
    }
    const neighbourEdge = sameScope ? data.edges.find((edge) => edge.source === node.id || edge.target === node.id) : null;
    const neighbour = neighbourEdge ? oldNodes.get(neighbourEdge.source === node.id ? neighbourEdge.target : neighbourEdge.source) : null;
    const angle = index * 2.399963;
    const distance = neighbour ? 25 : Math.sqrt(index + 1) * 12;
    return { ...node, x: (neighbour?.x ?? 0) + Math.cos(angle) * distance,
      y: (neighbour?.y ?? 0) + Math.sin(angle) * distance };
  });
  const links = data.edges.map((edge): BrainNetworkLink => {
    const saved = oldLinks.get(edge.id);
    if (saved && id(saved.source) === edge.source && id(saved.target) === edge.target) {
      const { source: _source, target: _target, ...metadata } = edge;
      Object.assign(saved, metadata);
      return saved;
    }
    return { ...edge };
  });
  return sameTopology ? previous : { scope, nodes, links };
}
