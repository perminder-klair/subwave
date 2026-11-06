'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useReducedMotion } from 'motion/react';
import ForceGraph2D, { type ForceGraphMethods, type LinkObject, type NodeObject } from 'react-force-graph-2d';
import { ChevronDown, ChevronUp, Expand, Focus, LayoutGrid, Maximize2, Network, Minus, Plus, RotateCcw, Shrink } from 'lucide-react';
import type { ConnectionEdge, ConnectionEdgeType, ConnectionGraphData, ConnectionNode } from './types';
import { LEGEND_GROUPS } from './filters';
import { reconcileBrainNetwork, type BrainNetwork } from './brain-network';
import { useBrainKeySetting } from './key-preferences';
import BrainPanel from './BrainPanel';
import { COVERAGE_LABELS } from './coverage';
import { createColorProbe, readThemeRgb, watchTheme } from '../../../lib/theme-rgb';
import { brainPalette, lightBrainTheme, LIGHT_MAP_LINK_OPACITY } from './palette';
import styles from './Brain.module.css';

export interface BrainCanvasProps {
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  data: ConnectionGraphData;
  visibleData?: ConnectionGraphData;
  edgeTypes: readonly ConnectionEdgeType[];
  includeExternal: boolean;
  includeUnresearchedArtists: boolean;
  onToggleUnresearchedArtists: () => void;
  onToggleGroup: (types: readonly ConnectionEdgeType[]) => void;
  onToggleExternal: () => void;
  selectedNode: string | null;
  selectedEdge: string | null;
  currentNodeId?: string | null;
  overview?: boolean;
  focusRequest?: number;
  zoomToSelection?: boolean;
  onSelectNode: (node: ConnectionNode) => void;
  onSelectEdge: (edge: ConnectionEdge) => void;
  onOpenNode: (node: ConnectionNode) => void;
  onClearSelection: () => void;
  canLayerUp: boolean;
  canLayerDown: boolean;
  onLayerUp: () => void;
  onLayerDown: () => void;
}
type LinkData = Omit<ConnectionEdge, 'source' | 'target'>;
type BrainNode = NodeObject<ConnectionNode>;
type BrainLink = LinkObject<ConnectionNode, LinkData>;
type LayoutMode = 'force' | 'grouped' | 'focus';
type Density = 'compact' | 'spread';
const LABEL_POPULATION_MIN_ZOOM = 0.55;
function radius(node: ConnectionNode, focus: string): number {
  if (node.id === focus) return 10;
  return 3 + Math.min(6, Math.log2(1 + (node.trackCount ?? node.connectionCount ?? 1))) * 0.75;
}
function tooltip(value: string): string {
  // force-graph's string tooltips are HTML. Provider titles are plain text.
  return value.replace(/[&<>"']/gu, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}

export default function BrainCanvas({ data, visibleData = data, edgeTypes, includeExternal, includeUnresearchedArtists, onToggleUnresearchedArtists, onToggleGroup, onToggleExternal,
  fullscreen, onToggleFullscreen, selectedNode, selectedEdge, currentNodeId, overview, focusRequest, zoomToSelection = false, onSelectNode, onSelectEdge, onOpenNode, onClearSelection, canLayerUp, canLayerDown, onLayerUp, onLayerDown }: BrainCanvasProps) {
  const container = useRef<HTMLDivElement>(null);
  const graph = useRef<ForceGraphMethods<ConnectionNode, LinkData> | undefined>(undefined);
  const [size, setSize] = useState({ width: 0, height: 544 });
  const [hovered, setHovered] = useState<string | null>(null);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>('force');
  const [density, setDensity] = useState<Density>('compact');
  const [pathLimit, setPathLimit] = useBrainKeySetting('pathLimit');
  const prefersReducedMotion = useReducedMotion();
  const [lite, setLite] = useState(false);
  const reducedMotion = prefersReducedMotion || lite;
  const [lightMap, setLightMap] = useState(false);
  const [palette, setPalette] = useState<Record<string, string>>({});
  const ink = palette.ink || 'transparent';
  const background = palette.bg || 'transparent';
  const muted = palette.muted || ink;
  useEffect(() => {
    const probe = createColorProbe();
    const update = () => {
      if (!container.current) return;
      if (probe) {
        const theme = readThemeRgb(container.current, probe);
        const colours = brainPalette(theme);
        setLightMap(lightBrainTheme(theme));
        for (const [name, value] of Object.entries(colours)) container.current.style.setProperty(`--${name}`, value);
      }
      const style = getComputedStyle(container.current);
      setPalette(Object.fromEntries(['bg', 'ink', 'muted',
        'brain-artist', 'brain-recording', 'brain-release', 'brain-contributor', 'brain-series', 'brain-external-recording',
        ...Object.keys(COVERAGE_LABELS).map(state => `brain-coverage-${state}`),
      ].map(name => [name, style.getPropertyValue(`--${name}`).trim()]).concat([['font', style.fontFamily]])));
      setLite(document.documentElement.classList.contains('lite'));
    };
    const stop = watchTheme(update);
    update();
    return stop;
  }, []);
  function linkColor(type: ConnectionEdge['type']): string {
    if (type === 'samples' || type === 'sampled-in') return palette['brain-artist'] || ink;
    if (type === 'cover-of' || type === 'covered-by') return palette['brain-recording'] || ink;
    if (type === 'writer' || type === 'producer') return palette['brain-contributor'] || ink;
    return muted;
  }
  const pendingFit = useRef(true);
  const fittedScope = useRef<string | null>(null);
  const networkRef = useRef<BrainNetwork | null>(null);
  const appliedFocusRequest = useRef<number | null>(null);
  const pendingReturnCenter = useRef<string | null>(null);
  const lastClick = useRef({ id: '', at: 0 });
  const labelBoxes = useRef<Array<{ left: number; right: number; top: number; bottom: number }>>([]);
  const viewport = useRef<{ left: number; right: number; top: number; bottom: number } | null>(null);
  const originalEdges = useMemo(() => new Map(data.edges.map((edge) => [edge.id, edge])), [data]);
  const scope = overview ? 'artists' : data.focusId;
  const ready = size.width > 0;
  const largeMap = data.nodes.length > 2000;
  // Preserve renderer-owned positions across metadata refreshes. Filtering is
  // visibility only, so neither physics nor the camera needs to restart.
  const network = useMemo(() => {
    const next = reconcileBrainNetwork(networkRef.current, data, scope);
    networkRef.current = next;
    return next;
  }, [data, scope]);
  const visibleNodes = useMemo(() => new Set(visibleData.nodes.map((node) => node.id)), [visibleData]);
  const visibleEdges = useMemo(() => new Set(visibleData.edges.map((edge) => edge.id)), [visibleData]);
  // An overview selection follows the whole connected component, in both
  // directions. Hover and focused layers retain their immediate neighbours.
  const followPathways = !!overview && !!selectedNode;
  const spotlight = followPathways ? selectedNode : hovered ?? selectedNode;
  const adjacency = useMemo(() => {
    const result = new Map<string, Array<{ node: string; edge: string }>>();
    for (const edge of visibleData.edges) {
      for (const [source, target] of [[edge.source, edge.target], [edge.target, edge.source]] as const) {
        let connections = result.get(source);
        if (!connections) { connections = []; result.set(source, connections); }
        connections.push({ node: target, edge: edge.id });
      }
    }
    return result;
  }, [visibleData]);
  const pathways = useMemo(() => {
    const nodes = new Set<string>();
    const edges = new Set<string>();
    const orderedEdges: string[] = [];
    if (!spotlight) return { nodes, edges, orderedEdges };
    const pending = [spotlight];
    nodes.add(spotlight);
    for (let index = 0; index < pending.length; index++) {
      for (const connection of adjacency.get(pending[index]!) ?? []) {
        if (!edges.has(connection.edge)) { edges.add(connection.edge); orderedEdges.push(connection.edge); }
        if (!nodes.has(connection.node)) {
          nodes.add(connection.node);
          if (followPathways) pending.push(connection.node);
        }
      }
    }
    return { nodes, edges, orderedEdges };
  }, [adjacency, spotlight, followPathways]);
  const highlightedPathways = useMemo(() => {
    if (!followPathways) return pathways;
    const edges = new Set(pathways.orderedEdges.slice(0, pathLimit));
    const nodes = new Set<string>(spotlight ? [spotlight] : []);
    for (const id of edges) {
      const edge = originalEdges.get(id);
      if (edge) { nodes.add(edge.source); nodes.add(edge.target); }
    }
    return { nodes, edges };
  }, [followPathways, pathways, pathLimit, spotlight, originalEdges]);
  const neighbours = highlightedPathways.nodes;
  // Keep every selected pathway highlighted, with animation limited to avoid
  // continuous particle work across a large connected component.
  const animatedEdges = useMemo(() => new Set(
    [...(selectedEdge ? [selectedEdge] : []), ...highlightedPathways.edges].slice(0, 64),
  ), [highlightedPathways, selectedEdge]);
  const labelled = useMemo(() => new Set([...visibleData.nodes].sort((a, b) =>
    (b.connectionCount ?? 0) - (a.connectionCount ?? 0) || (b.trackCount ?? 0) - (a.trackCount ?? 0))
    .slice(0, overview ? 14 : 8).map((node) => node.id)), [visibleData, overview]);

  const setForceSpacing = useCallback((nextDensity: Density) => {
    const charge = graph.current?.d3Force('charge') as { strength?: (value: number) => unknown } | undefined;
    const link = graph.current?.d3Force('link') as { distance?: (value: number) => unknown } | undefined;
    const strength = nextDensity === 'spread' ? (overview ? -105 : -220) : (overview ? -45 : -100);
    const distance = nextDensity === 'spread' ? (overview ? 95 : 130) : (overview ? 48 : 70);
    charge?.strength?.(strength);
    link?.distance?.(distance);
  }, [overview]);

  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setSize({ width: Math.floor(entry.contentRect.width), height: Math.floor(entry.contentRect.height) });
    });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!ready || !graph.current || fittedScope.current === scope) return;
    fittedScope.current = scope;
    pendingFit.current = true;
    setForceSpacing(density);
    graph.current.d3ReheatSimulation();
    graph.current.zoomToFit(0, 55);
  }, [scope, overview, ready, density, setForceSpacing]);
  useEffect(() => {
    const renderer = graph.current;
    const update = () => {
      if (document.hidden) renderer?.pauseAnimation();
      else renderer?.resumeAnimation();
    };
    document.addEventListener('visibilitychange', update);
    update();
    return () => { document.removeEventListener('visibilitychange', update); renderer?.pauseAnimation(); };
  }, [ready]);
  useEffect(() => {
    if (pendingReturnCenter.current !== selectedNode) pendingReturnCenter.current = null;
    // Keep a clicked node stationary so the second click can hit it.
    if (lastClick.current.id === selectedNode && performance.now() - lastClick.current.at < 400) return;
    const node = networkRef.current?.nodes.find((item) => item.id === selectedNode);
    if (node && graph.current) {
      pendingFit.current = false;
      graph.current.centerAt(node.x, node.y, reducedMotion ? 0 : 350);
    }
  }, [selectedNode, reducedMotion]);
  useEffect(() => {
    if (!focusRequest || !ready || !graph.current || appliedFocusRequest.current === focusRequest) return;
    const current = networkRef.current;
    const node = current?.nodes.find((item) => item.id === selectedNode)
      ?? current?.nodes.find((item) => item.id === current.scope);
    if (node) {
      appliedFocusRequest.current = focusRequest;
      pendingFit.current = false;
      graph.current.centerAt(node.x, node.y, reducedMotion ? 0 : 350);
      if (zoomToSelection) {
        pendingReturnCenter.current = node.id;
        graph.current.zoom(Math.max(graph.current.zoom(), 2), reducedMotion ? 0 : 350);
      }
    }
  }, [focusRequest, reducedMotion, ready, selectedNode, zoomToSelection]);

  function fit() {
    pendingReturnCenter.current = null;
    pendingFit.current = false;
    graph.current?.zoomToFit(reducedMotion ? 0 : 650, 55, (node) => visibleNodes.has(node.id));
  }
  function illuminated(link: BrainLink): boolean {
    return link.id === selectedEdge || highlightedPathways.edges.has(link.id);
  }
  function inViewport(node: BrainNode, margin: number): boolean {
    const bounds = viewport.current;
    if (!bounds) return true;
    const x = node.x ?? 0, y = node.y ?? 0;
    return x + margin >= bounds.left && x - margin <= bounds.right
      && y + margin >= bounds.top && y - margin <= bounds.bottom;
  }
  function drawNode(node: BrainNode, ctx: CanvasRenderingContext2D, scale: number) {
    const x = node.x ?? 0, y = node.y ?? 0;
    const isCurrent = node.id === currentNodeId;
    const edge = selectedEdge ? originalEdges.get(selectedEdge) : null;
    const active = neighbours.has(node.id) || node.id === selectedNode || node.id === data.focusId || isCurrent
      || edge?.source === node.id || edge?.target === node.id;
    const connected = adjacency.has(node.id);
    const unexplored = node.kind === 'artist' && node.researched === false && !connected;
    const r = Math.max(radius(node, data.focusId), (active ? 3 : connected ? 1.6 : 0) / scale);
    if (!inViewport(node, r * 6 + 16 / scale)) return;
    const dimmed = !!spotlight && !active;
    const color = unexplored && !active ? palette['brain-external-recording'] || muted : node.local || node.kind === 'contributor' ? palette[`brain-${node.kind}`] || ink : muted;
    ctx.save();
    ctx.globalAlpha = dimmed ? 0.18 : active || node.kind === 'contributor' ? 1
      : unexplored ? (lightMap ? 0.6 : 0.35) : lightMap ? 1 : node.local ? Math.min(1, (node.researched === false ? 0.35 : 0.65) + Math.log2(1 + (node.verifiedConnectionCount ?? 0)) * 0.08) : 0.55;
    if (!lightMap && (isCurrent || active || (node.verifiedConnectionCount ?? 0) > 0)) {
      const pulse = isCurrent && !reducedMotion && !largeMap ? 1 + Math.sin(performance.now() / 650) * 0.18 : 1;
      const glow = ctx.createRadialGradient(x, y, r, x, y, r * 4 * pulse);
      glow.addColorStop(0, color); glow.addColorStop(1, 'transparent');
      const alpha = ctx.globalAlpha; ctx.globalAlpha *= 0.4;
      ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(x, y, r * 4 * pulse, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = alpha;
    }
    ctx.beginPath();
    if (node.kind === 'contributor') {
      ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath();
    } else ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.strokeStyle = color; ctx.lineWidth = 1.3 / scale;
    ctx.fillStyle = node.local || node.kind === 'contributor' ? color : background;
    ctx.fill(); ctx.stroke();
    if (node.coverage && scale > LABEL_POPULATION_MIN_ZOOM) {
      ctx.strokeStyle = palette[`brain-coverage-${node.coverage.state}`] || ink;
      ctx.lineWidth = 2.8 / scale;
      ctx.beginPath(); ctx.arc(x, y, r + 2.5 / scale, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = color;
    }
    if (isCurrent) { ctx.beginPath(); ctx.arc(x, y, r + 3 / scale, 0, Math.PI * 2); ctx.stroke(); }
    const important = isCurrent || node.id === selectedNode || node.id === data.focusId
      || edge?.source === node.id || edge?.target === node.id;
    if (important || (!dimmed && (scale > 1.35 || (labelled.has(node.id) && scale > LABEL_POPULATION_MIN_ZOOM)))
      || (neighbours.has(node.id) && scale > 0.8)) {
      const label = node.title.length > 32 ? `${node.title.slice(0, 30)}…` : node.title;
      ctx.font = `${active ? 600 : 400} ${11 / scale}px ${palette.font || 'sans-serif'}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      const transform = ctx.getTransform();
      const halfWidth = ctx.measureText(label).width * transform.a / 2;
      const pixelX = Math.max(halfWidth + 8, Math.min(ctx.canvas.width - halfWidth - 8, x * transform.a + transform.e));
      const pixelY = (y + r + 4 / scale) * transform.d + transform.f;
      const box = { left: pixelX - halfWidth - 4, right: pixelX + halfWidth + 4,
        top: pixelY, bottom: pixelY + 14 * transform.a / scale };
      const overlaps = labelBoxes.current.some((other) => box.left < other.right && box.right > other.left
        && box.top < other.bottom && box.bottom > other.top);
      if (important || !overlaps) {
        labelBoxes.current.push(box);
        const labelX = (pixelX - transform.e) / transform.a;
        ctx.globalAlpha = 1;
        ctx.lineWidth = 3 / scale; ctx.strokeStyle = background; ctx.strokeText(label, labelX, y + r + 4 / scale);
        ctx.fillStyle = active || lightMap ? ink : muted; ctx.fillText(label, labelX, y + r + 4 / scale);
      }
    }
    ctx.restore();
  }



  function adjacencyForLayout() {
    const adjacency = new Map<string, string[]>();
    for (const node of network.nodes) adjacency.set(node.id, []);
    for (const edge of data.edges) {
      if (!adjacency.has(edge.source) || !adjacency.has(edge.target)) continue;
      adjacency.get(edge.source)!.push(edge.target);
      adjacency.get(edge.target)!.push(edge.source);
    }
    return adjacency;
  }

  function pinNode(node: BrainNetwork['nodes'][number], x: number, y: number) {
    node.x = x; node.y = y; node.vx = 0; node.vy = 0; node.fx = x; node.fy = y;
  }

  function applyLayout(mode: LayoutMode, resetPositions = false) {
    pendingReturnCenter.current = null;
    if (!network.nodes.length) return;
    setLayoutMode(mode);
    pendingFit.current = false;
    const adjacency = adjacencyForLayout();
    const positions = new Map<string, { x: number; y: number }>();
    if (mode === 'grouped') {
      const visited = new Set<string>();
      const components: string[][] = [];
      const isolated: string[] = [];
      for (const node of network.nodes) {
        if (visited.has(node.id)) continue;
        if ((adjacency.get(node.id)?.length ?? 0) === 0) { visited.add(node.id); isolated.push(node.id); continue; }
        const component: string[] = []; const pending = [node.id]; visited.add(node.id);
        for (let index = 0; index < pending.length; index++) {
          const id = pending[index]!; component.push(id);
          for (const neighbour of adjacency.get(id) ?? []) if (!visited.has(neighbour)) { visited.add(neighbour); pending.push(neighbour); }
        }
        components.push(component);
      }
      if (isolated.length) components.push(isolated);
      components.sort((a, b) => b.length - a.length);
      const columns = Math.max(1, Math.ceil(Math.sqrt(components.length)));
      const rows = Math.ceil(components.length / columns);
      components.forEach((component, componentIndex) => {
        const column = componentIndex % columns; const row = Math.floor(componentIndex / columns);
        const cx = (column - (columns - 1) / 2) * 360;
        const cy = (row - (rows - 1) / 2) * 320;
        component.sort((a, b) => (adjacency.get(b)?.length ?? 0) - (adjacency.get(a)?.length ?? 0) || a.localeCompare(b));
        component.forEach((id, index) => {
          const angle = index * 2.399963;
          const radius = component.length === 1 ? 0 : 28 + Math.sqrt(index) * 11;
          positions.set(id, { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius });
        });
      });
    } else {
      const rootId = selectedNode && adjacency.has(selectedNode) ? selectedNode : data.focusId;
      if (mode === 'focus' && adjacency.has(rootId)) {
        const distance = new Map<string, number>([[rootId, 0]]); const pending = [rootId];
        for (let index = 0; index < pending.length; index++) {
          const id = pending[index]!;
          for (const neighbour of adjacency.get(id) ?? []) if (!distance.has(neighbour)) { distance.set(neighbour, distance.get(id)! + 1); pending.push(neighbour); }
        }
        const maxDistance = Math.max(0, ...distance.values());
        const layers = new Map<number, string[]>();
        for (const node of network.nodes) {
          const layer = distance.get(node.id) ?? (maxDistance + 1);
          const members = layers.get(layer) ?? []; members.push(node.id); layers.set(layer, members);
        }
        for (const [layer, members] of layers) {
          if (layer === 0) { positions.set(rootId, { x: 0, y: 0 }); continue; }
          members.sort((a, b) => (adjacency.get(b)?.length ?? 0) - (adjacency.get(a)?.length ?? 0) || a.localeCompare(b));
          const ring = Math.max(layer * 190, Math.sqrt(members.length) * 13);
          members.forEach((id, index) => {
            const angle = (index / members.length) * Math.PI * 2 - Math.PI / 2;
            positions.set(id, { x: Math.cos(angle) * ring, y: Math.sin(angle) * ring });
          });
        }
      }
    }
    for (const [index, node] of network.nodes.entries()) {
      if (mode === 'force') {
        if (resetPositions) {
          const angle = index * 2.399963; const radius = Math.sqrt(index + 1) * 12;
          node.x = Math.cos(angle) * radius; node.y = Math.sin(angle) * radius;
        }
        node.fx = undefined; node.fy = undefined; node.vx = 0; node.vy = 0;
        continue;
      }
      const position = positions.get(node.id);
      if (position) pinNode(node, position.x, position.y);
    }
    setForceSpacing(density);
    graph.current?.d3ReheatSimulation();
    window.setTimeout(() => {
      if (mode !== 'force' || resetPositions) graph.current?.zoomToFit(reducedMotion ? 0 : 500, 64, (node) => visibleNodes.has(node.id));
    }, reducedMotion ? 0 : 100);
  }

  function relayout() {
    applyLayout('force', true);
  }


  return (
    <div ref={container} className={`relative overflow-hidden border border-border bg-bg focus-visible:outline-2 focus-visible:outline-offset-2 ${fullscreen?'h-full min-h-0 flex-1':'h-[clamp(24rem,65vh,44rem)] min-h-96'}`}
      onPointerDownCapture={() => { pendingFit.current = false; pendingReturnCenter.current = null; }}
      onWheelCapture={() => { pendingFit.current = false; pendingReturnCenter.current = null; }}
      tabIndex={0}
      onKeyDown={event=>{
        if(event.target!==event.currentTarget) return;
        if(event.key==='ArrowLeft'||event.key==='ArrowRight') {
          event.preventDefault();
          const nodes=visibleData.nodes;if(!nodes.length) return;
          const index=nodes.findIndex(node=>node.id===selectedNode);
          const next=index<0?(event.key==='ArrowRight'?0:nodes.length-1):(index+(event.key==='ArrowRight'?1:-1)+nodes.length)%nodes.length;
          const node=nodes[next];if(node) onSelectNode(node);
        } else if(event.key==='ArrowUp'||event.key==='ArrowDown') {
          event.preventDefault();
          const edges=visibleData.edges;if(!edges.length) return;
          const index=edges.findIndex(edge=>edge.id===selectedEdge);
          const next=index<0?(event.key==='ArrowDown'?0:edges.length-1):(index+(event.key==='ArrowDown'?1:-1)+edges.length)%edges.length;
          const edge=edges[next];if(edge) onSelectEdge(edge);
        } else if(event.key==='Enter') {
          const node=visibleData.nodes.find(node=>node.id===selectedNode);
          if(node?.expandable) {event.preventDefault();onOpenNode(node);}
        }
      }}
      role="group" aria-label={`Station Brain: ${visibleData.nodes.length} entities and ${visibleData.edges.length} connections. Use Left and Right to select an item, Up and Down to select a relationship, and Enter to open the selected item.`}>
      {size.width > 0 && <ForceGraph2D<ConnectionNode, LinkData>
        ref={graph} width={size.width} height={size.height} graphData={network} backgroundColor={background}
        warmupTicks={largeMap ? reducedMotion ? 32 : 0 : reducedMotion ? 160 : 60}
        cooldownTicks={reducedMotion ? 0 : 120} cooldownTime={3500}
        d3AlphaDecay={0.035} d3VelocityDecay={0.35} minZoom={largeMap ? 0.025 : 0.12} maxZoom={8}
        autoPauseRedraw={largeMap || reducedMotion || !visibleNodes.has(currentNodeId ?? '')}
        nodeVisibility={(node) => visibleNodes.has(node.id)}
        linkVisibility={(link) => visibleEdges.has(link.id)}
        nodeLabel={(node) => tooltip(`${node.title}${node.subtitle ? ` · ${node.subtitle}` : ''}${node.trackCount ? ` · ${node.trackCount} local tracks` : ''}${node.coverage ? ` · ${COVERAGE_LABELS[node.coverage.state]} · ${node.coverage.usableStories} usable stories` : ''}`)}
        nodeCanvasObject={drawNode}
        onRenderFramePre={(ctx) => {
          labelBoxes.current = [];
          const transform = ctx.getTransform();
          viewport.current = {
            left: -transform.e / transform.a, right: (ctx.canvas.width - transform.e) / transform.a,
            top: -transform.f / transform.d, bottom: (ctx.canvas.height - transform.f) / transform.d,
          };
        }}
        nodePointerAreaPaint={(node, color, ctx, scale) => {
          ctx.fillStyle = color; ctx.beginPath(); ctx.arc(node.x ?? 0, node.y ?? 0,
            Math.max(radius(node, data.focusId) + 2, 8 / scale), 0, Math.PI * 2); ctx.fill();
        }}
        linkLabel={(link) => { const edge = originalEdges.get(link.id); return tooltip(edge?.evidence ?? link.label); }}
        linkColor={(link) => `color-mix(in srgb, ${linkColor(link.type)} ${illuminated(link) ? (lightMap ? 100 : 87) : spotlight ? 8 : lightMap ? LIGHT_MAP_LINK_OPACITY * 100 : 25}%, transparent)`}
        linkWidth={(link) => illuminated(link) ? 2.2 : Math.min(1.4, (lightMap ? 0.7 : 0.35) + Math.log2(link.count ?? 1) * 0.15)}
        linkCurvature={0.12} linkHoverPrecision={5}
        linkDirectionalArrowLength={(link) => illuminated(link) ? 4 : 0}
        linkDirectionalArrowRelPos={0.85}
        linkDirectionalParticles={(link) => !reducedMotion && animatedEdges.has(link.id) ? 2 : 0}
        linkDirectionalParticleSpeed={0.0035} linkDirectionalParticleWidth={2}
        linkDirectionalParticleColor={(link) => linkColor(link.type)}
        onNodeHover={(node) => setHovered(node?.id ? String(node.id) : null)}
        onNodeClick={(node) => {
          pendingFit.current = false;
          const now = performance.now();
          const doubleClick = lastClick.current.id === node.id && now - lastClick.current.at < 350;
          lastClick.current = { id: doubleClick ? '' : node.id, at: now };
          onSelectNode(node);
          if (doubleClick && node.expandable && node.id !== data.focusId) onOpenNode(node);
        }}
        onBackgroundClick={() => { lastClick.current = { id: '', at: 0 }; onClearSelection(); }}
        onNodeDragEnd={(node) => { node.fx = node.x; node.fy = node.y; }}
        onLinkClick={(link) => { const edge = originalEdges.get(link.id); if (edge) onSelectEdge(edge); }}
        onEngineStop={() => {
          // A returning artist can move while the fresh layer settles. Finish
          // centring it once, unless the user has already moved the camera.
          const node = networkRef.current?.nodes.find((item) => item.id === pendingReturnCenter.current);
          pendingReturnCenter.current = null;
          if (node) graph.current?.centerAt(node.x, node.y, reducedMotion ? 0 : 350);
          else if (pendingFit.current) fit();
        }}
      />}
      <BrainPanel label="Layout" className={`${styles.glass} absolute top-3 left-3 max-w-[calc(100%-9rem)] p-1 text-ink`}>
        <div className="flex flex-wrap items-center gap-1">
        <button type="button" aria-label="Force layout" aria-pressed={layoutMode === 'force'} onClick={() => applyLayout('force')} title="Arrange by connected forces"
          className={`flex min-h-11 items-center gap-1 px-2 text-[11px] hover:bg-overlay md:min-h-8 ${layoutMode === 'force' ? 'bg-overlay' : ''}`}><Network className="size-3.5" />Force</button>
        <button type="button" aria-label="Group related nodes" aria-pressed={layoutMode === 'grouped'} onClick={() => applyLayout('grouped')} title="Place connected groups together"
          className={`flex min-h-11 items-center gap-1 px-2 text-[11px] hover:bg-overlay md:min-h-8 ${layoutMode === 'grouped' ? 'bg-overlay' : ''}`}><LayoutGrid className="size-3.5" />Grouped</button>
        <button type="button" aria-label="Focus selected node" aria-pressed={layoutMode === 'focus'} disabled={!selectedNode} onClick={() => applyLayout('focus')} title={selectedNode ? 'Place the selected node at the centre' : 'Select a node to focus the layout'}
          className={`flex min-h-11 items-center gap-1 px-2 text-[11px] hover:bg-overlay disabled:opacity-40 md:min-h-8 ${layoutMode === 'focus' ? 'bg-overlay' : ''}`}><Focus className="size-3.5" />Focus</button>
        <button type="button" aria-label="Re-layout graph" onClick={relayout} title="Release pinned nodes and arrange the graph again"
          className="flex min-h-11 items-center gap-1 px-2 text-[11px] hover:bg-overlay md:min-h-8"><RotateCcw className="size-3.5" />Re-layout</button>
        {layoutMode === 'force' && <button type="button" aria-label={density === 'compact' ? 'Spread graph' : 'Compact graph'} onClick={() => {
          const next = density === 'compact' ? 'spread' : 'compact'; setDensity(next); setForceSpacing(next); graph.current?.d3ReheatSimulation();
        }} title={density === 'compact' ? 'Increase spacing between nodes' : 'Reduce spacing between nodes'}
          className="flex min-h-11 items-center gap-1 px-2 text-[11px] hover:bg-overlay md:min-h-8">{density === 'compact' ? 'Spread' : 'Compact'}</button>}
        </div>
      </BrainPanel>
      <BrainPanel label="Map controls" className={`${styles.glass} absolute top-3 right-3 p-1 text-ink`}>
        <div className="flex justify-center gap-1">
          <button type="button" aria-label="Zoom in" className="flex size-11 items-center justify-center hover:bg-overlay md:size-8" onClick={() => { pendingFit.current = false; pendingReturnCenter.current = null; graph.current?.zoom((graph.current.zoom() ?? 1) * 1.35, reducedMotion ? 0 : 250); }}><Plus className="size-4" /></button>
          <button type="button" aria-label="Zoom out" className="flex size-11 items-center justify-center hover:bg-overlay md:size-8" onClick={() => { pendingFit.current = false; pendingReturnCenter.current = null; graph.current?.zoom((graph.current.zoom() ?? 1) / 1.35, reducedMotion ? 0 : 250); }}><Minus className="size-4" /></button>
          <button type="button" aria-label="Fit the whole map" className="flex size-11 items-center justify-center hover:bg-overlay md:size-8" onClick={fit}><Maximize2 className="size-4" /></button>
          <button type="button" aria-label={fullscreen ? "Close full-screen map" : "Open full-screen map"} title={fullscreen ? "Close full screen (Esc)" : "Open full screen"} className="flex size-11 items-center justify-center hover:bg-overlay md:size-8" onClick={onToggleFullscreen}>{fullscreen ? <Shrink className="size-4" /> : <Expand className="size-4" />}</button>
        </div>
        <div className="grid grid-cols-2 gap-1 border-t border-border/60 pt-1">
          <button type="button" disabled={!canLayerUp} onClick={onLayerUp} title="Return to the parent layer"
            className="flex min-h-11 items-center justify-center gap-1 px-1.5 text-[10px] hover:bg-overlay disabled:cursor-default disabled:opacity-40 md:min-h-8"><ChevronUp className="size-3" aria-hidden="true" />Layer Up</button>
          <button type="button" disabled={!canLayerDown} onClick={onLayerDown} title={canLayerDown ? 'Open the selected node' : 'Select an artist, album or matched track to open its layer'}
            className="flex min-h-11 items-center justify-center gap-1 px-1.5 text-[10px] hover:bg-overlay disabled:cursor-default disabled:opacity-40 md:min-h-8"><ChevronDown className="size-3" aria-hidden="true" />Layer Down</button>
        </div>
      </BrainPanel>
      <BrainPanel label="Key" className={`${styles.glass} absolute bottom-3 left-3 max-w-[calc(100%-1.5rem)] px-3 py-2 text-[10px] text-ink`}>
        {followPathways && pathways.orderedEdges.length > 0 && <div className="mb-2 flex max-w-72 min-w-48 flex-col gap-1 border-b border-border/60 pb-2">
          <span className="flex items-center justify-between gap-4"><span>Neural links highlighted</span>
            <output className="text-ink tabular-nums">{highlightedPathways.edges.size} / {pathways.orderedEdges.length}</output></span>
          <div className="flex items-center gap-2">
            <button type="button" aria-label="Highlight one fewer neural link" disabled={Math.min(pathLimit, pathways.orderedEdges.length) <= 1}
              onClick={() => setPathLimit(Math.max(1, Math.min(pathLimit, pathways.orderedEdges.length) - 1))}
              className="flex size-11 shrink-0 items-center justify-center hover:bg-overlay disabled:opacity-40 md:size-8"><Minus className="size-4" aria-hidden="true" /></button>
            <input type="range" min={1} max={pathways.orderedEdges.length} step={1} value={Math.min(pathLimit, pathways.orderedEdges.length)}
              aria-label="Maximum neural links highlighted from this artist"
              onChange={(event) => setPathLimit(Number(event.target.value))}
              className="h-4 min-w-0 flex-1 cursor-pointer accent-primary" />
            <button type="button" aria-label="Highlight one more neural link" disabled={pathLimit >= pathways.orderedEdges.length}
              onClick={() => setPathLimit(Math.min(pathways.orderedEdges.length, pathLimit + 1))}
              className="flex size-11 shrink-0 items-center justify-center hover:bg-overlay disabled:opacity-40 md:size-8"><Plus className="size-4" aria-hidden="true" /></button>
          </div>
        </div>}
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {LEGEND_GROUPS.filter((group) => !overview || group.overview).map((group) => {
            const shown = group.types.some((type) => edgeTypes.includes(type));
            return <button key={group.label} type="button" aria-pressed={shown}
              title={`${shown ? 'Hide' : 'Show'} ${group.label.toLowerCase()} connections`}
              onClick={() => onToggleGroup(group.types)}
              className={`px-1 py-1 hover:bg-overlay focus-visible:outline-2 focus-visible:outline-offset-2 ${shown ? '' : 'line-through opacity-50'}`}>
              <span aria-hidden="true" className={group.className}>{group.symbol}</span> {group.label}
            </button>;
          })}
          <button type="button" aria-pressed={includeExternal} onClick={onToggleExternal}
            title={`${includeExternal ? 'Hide' : 'Show'} external music`}
            className={`px-1 py-1 hover:bg-overlay focus-visible:outline-2 focus-visible:outline-offset-2 ${includeExternal ? '' : 'line-through opacity-50'}`}>○ External music</button>
          {overview && <button type="button" aria-pressed={includeUnresearchedArtists} onClick={onToggleUnresearchedArtists}
            title={`${includeUnresearchedArtists ? 'Hide' : 'Show'} library artists not encountered by Sleeve Notes`}
            className={`px-1 py-1 hover:bg-overlay focus-visible:outline-2 focus-visible:outline-offset-2 ${includeUnresearchedArtists ? '' : 'line-through opacity-50'}`}>○ Library artists not encountered</button>}
        </div>
        {data.nodes.some(node => node.coverage) && <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 border-t border-border/60 pt-2" aria-label="Artist research coverage key">
          <span className="w-full">Artist rings · research coverage</span>
          {(['ready', 'empty', 'unexplored', 'queued', 'incomplete'] as const).map(state => <span key={state} className="flex items-center gap-1">
            <span aria-hidden="true" className={state === 'ready' ? 'text-[var(--brain-coverage-ready)]' : state === 'empty' ? 'text-[var(--brain-coverage-empty)]' : state === 'queued' ? 'text-[var(--brain-coverage-queued)]' : state === 'incomplete' ? 'text-[var(--brain-coverage-incomplete)]' : 'text-muted'}>○</span>{state === 'queued' ? 'Queued / researching' : COVERAGE_LABELS[state]}
          </span>)}
        </div>}
        <p className="mt-1">{overview ? 'Click to highlight pathways · click empty space to clear · ' : ''}Double-click a node to open · click the key to filter · drag to explore · pinch or scroll to zoom</p>
      </BrainPanel>
    </div>
  );
}
