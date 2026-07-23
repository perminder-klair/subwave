/* ============================================================================
   SUB/WAVE — Library Observatory · the galaxy (WebGL renderer)
   The single map renderer (it replaced the SVG + 2D-canvas pair). Every track
   is a glowing star drawn as a GPU point sprite (three.js), with an additive
   nebula underlay that follows track density, faint synapse filaments, and an
   UnrealBloom pass for the halo. The stage is always night — bloom needs a
   dark ground truth in both site themes — so `.cmap-galaxy` re-declares the
   theme vars locally and node colours get a legibility lift (see liftNight).

   Browsability comes from semantic zoom, not bigger dots: star screen-size
   grows sublinearly with zoom (∝ k^0.45, so zooming reads as flying closer),
   genre constellation names fade OUT as you dive, and track labels fade IN
   where the local density allows (grid-decluttered, recomputed when the view
   settles). Labels live in one CSS-transformed HTML layer so pan/zoom never
   re-lays-out the DOM; each label counter-scales via a single --inv var.

   Rendering is on-demand: a frame draws only when the view / data / selection
   changes (plus a ~1.1s GPU-side entrance), and an IntersectionObserver skips
   draws entirely while the map is offscreen — the landing-page embed costs no
   GPU when idle. DPR is capped at 2.

   Coordinate model is unchanged from the old renderers so the thin SVG
   highlight overlay (selection wiring, ripple, hover ring) is carried over
   verbatim: a 1000×1000 user space fit with `meet` letterboxing
   (S = min(W,H), centred), then the pan/zoom view {tx,ty,k} inside it.
   Screen px = origin + (t + user·k)·f, where f = S/1000.
   ============================================================================ */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import {
  buildSynapseLinks,
  nodeColor,
  nodeFilled,
  type ColorBy,
  type ObsTrack,
  type LibraryData,
} from './data';

interface Props {
  lib: LibraryData;
  matchSet: Set<number>;
  colorBy: ColorBy;
  selected: ObsTrack | null;
  neighbours: ObsTrack[];
  hovered: ObsTrack | null;
  // Fly-to request: animate the camera to centre this node. The nonce `n`
  // distinguishes repeat requests for the same track; map clicks never set it.
  focus?: { t: ObsTrack; n: number } | null;
  onHover: (t: ObsTrack | null, e?: React.MouseEvent) => void;
  onSelect: (t: ObsTrack | null) => void;
}

interface View {
  k: number;
  tx: number;
  ty: number;
}

const K_MIN = 0.65;
const K_MAX = 10; // deeper than the old 6 — flying in is the point now
const SIZE_EXP = 0.45; // star screen-size ∝ k^SIZE_EXP: closer, not fatter
const HALO = 1.9; // sprite is HALO× the node radius; the skirt glows
const NIGHT = '#0d0b09';

const ENTRANCE_SPREAD = 620; // ms of stagger from centre to rim
const ENTRANCE_FADE = 450; // ms each star takes to fade+grow in
const ENTRANCE_TOTAL = ENTRANCE_SPREAD + ENTRANCE_FADE;
const SETTLED = 1e8; // uElapsed value meaning "entrance long over"

const GENRE_LABEL_MAX_K = 4; // constellation names gone past this zoom
const TRACK_LABEL_MIN_K = 2; // track titles appear from this zoom
const TRACK_LABEL_CAP = 64;
const LABEL_CELL_W = 118; // css-px declutter grid
const LABEL_CELL_H = 24;

// meet-fit transform for a given stage size: how 0..1000 maps to CSS px.
function fit(w: number, h: number) {
  const S = Math.min(w, h);
  return { S, ox: (w - S) / 2, oy: (h - S) / 2, f: S / 1000 };
}

// parse 'rgb(r,g,b)' or '#rgb'/'#rrggbb' → [r,g,b]
function parseRGB(c: string): [number, number, number] {
  if (c[0] === '#') {
    const h = c.slice(1);
    const n = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
    const v = parseInt(n, 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }
  const m = c.match(/\d+/g);
  return m && m.length >= 3 ? [Number(m[0]), Number(m[1]), Number(m[2])] : [74, 68, 61];
}

// The ink→vermilion palette was tuned for paper; its dark end vanishes on the
// night stage. Lift any colour below a luminance floor toward warm paper —
// hue survives, the star becomes visible. Used for GPU colours AND the legend
// swatches so the key never lies about what's on the map.
export function liftNight(c: string): [number, number, number] {
  const [r, g, b] = parseRGB(c);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const FLOOR = 96;
  if (lum >= FLOOR) return [r, g, b];
  const t = ((FLOOR - lum) / FLOOR) * 0.75;
  return [r + (207 - r) * t, g + (200 - g) * t, b + (187 - b) * t];
}
function liftNightCss(c: string): string {
  const [r, g, b] = liftNight(c);
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
}

const STAR_VERT = /* glsl */ `
  attribute float aSize;
  attribute vec3 aColor;
  attribute float aAlpha;
  attribute float aDelay;
  attribute float aRing;
  uniform float uScale;   // device px per user-unit of node radius, halo incl.
  uniform float uElapsed; // ms since entrance start (SETTLED once done)
  varying vec3 vColor;
  varying float vAlpha;
  varying float vRing;
  void main() {
    float e = clamp((uElapsed - aDelay) / ${ENTRANCE_FADE.toFixed(1)}, 0.0, 1.0);
    float ease = 1.0 - pow(1.0 - e, 3.0);
    vColor = aColor;
    vAlpha = aAlpha * e;
    vRing = aRing;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uScale * ease;
  }
`;

const STAR_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  varying float vRing;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float d = length(p);
    if (d > 1.0) discard;
    float core = ${(1 / HALO).toFixed(4)}; // the node's true radius in the sprite
    float a;
    if (vRing > 0.5) {
      // hollow node → a thin luminous ring + faint skirt
      float band = 1.0 - smoothstep(0.035, 0.12, abs(d - core * 0.82));
      float halo = (1.0 - smoothstep(core, 1.0, d)) * 0.18;
      a = max(band, halo);
    } else {
      float body = 1.0 - smoothstep(core * 0.55, core, d);
      float halo = pow(max(0.0, 1.0 - d), 2.2) * 0.32;
      a = max(body, halo);
    }
    a *= vAlpha;
    if (a < 0.004) discard;
    gl_FragColor = vec4(vColor, a);
  }
`;

const NEBULA_VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aAlpha;
  attribute float aDelay;
  uniform float uScale; // nebula splat diameter in device px
  uniform float uElapsed;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float e = clamp((uElapsed - aDelay) / ${ENTRANCE_FADE.toFixed(1)}, 0.0, 1.0);
    vColor = aColor;
    vAlpha = aAlpha * e;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = uScale * e;
  }
`;

const NEBULA_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  uniform float uGain;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float d2 = dot(p, p);
    float g = exp(-d2 * 4.0);
    float a = g * vAlpha * uGain;
    if (a < 0.002) discard;
    gl_FragColor = vec4(vColor, a);
  }
`;

// Everything three-side, held in one ref so effects share it without state.
interface GlState {
  renderer: THREE.WebGLRenderer;
  composer: EffectComposer;
  bloom: UnrealBloomPass;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  starMat: THREE.ShaderMaterial;
  nebulaMat: THREE.ShaderMaterial;
  linkMat: THREE.LineBasicMaterial;
  geo: THREE.BufferGeometry | null;
  linkGeo: THREE.BufferGeometry | null;
  stars: THREE.Points | null;
  nebula: THREE.Points | null;
  links: THREE.LineSegments | null;
  pr: number;
}

export default function ConstellationGalaxy({
  lib,
  matchSet,
  colorBy,
  selected,
  neighbours,
  hovered,
  focus,
  onHover,
  onSelect,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const glCanvasRef = useRef<HTMLCanvasElement>(null);
  const labelInnerRef = useRef<HTMLDivElement>(null);
  const glRef = useRef<GlState | null>(null);
  const [failed, setFailed] = useState(false);

  const [view, setView] = useState<View>({ k: 1, tx: 0, ty: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [size, setSize] = useState({ w: 0, h: 0 });
  const sizeRef = useRef(size);
  sizeRef.current = size;

  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ sx: number; sy: number; tx: number; ty: number } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d0: number; k0: number; ux: number; uy: number } | null>(null);
  const pending = useRef<View | null>(null);
  const moveRaf = useRef<number | null>(null);
  const suppressClick = useRef(false);
  const downAt = useRef<{ x: number; y: number } | null>(null);

  const neighbourSet = useMemo(() => new Set((neighbours || []).map((t) => t.idx)), [neighbours]);
  const filtering = matchSet.size < lib.tracks.length;
  // live mirror so the entrance loop reads the current filter state without
  // being re-armed by filter changes
  const filteringRef = useRef(filtering);
  filteringRef.current = filtering;

  const reducedMotion = useMemo(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );

  // ---- visibility + on-demand rendering -----------------------------------
  const visibleRef = useRef(true);
  const staleWhileHidden = useRef(false);
  const frameReq = useRef<number | null>(null);
  const renderNow = useCallback(() => {
    const gl = glRef.current;
    if (!gl) return;
    gl.composer.render();
  }, []);
  const invalidate = useCallback(() => {
    if (!visibleRef.current) {
      staleWhileHidden.current = true;
      return;
    }
    if (frameReq.current != null) return;
    frameReq.current = requestAnimationFrame(() => {
      frameReq.current = null;
      renderNow();
    });
  }, [renderNow]);

  // ---- measure the stage ----------------------------------------------------
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.round(r.width), h: Math.round(r.height) });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    const io = new IntersectionObserver((entries) => {
      const vis = entries.some((e) => e.isIntersecting);
      visibleRef.current = vis;
      if (vis && staleWhileHidden.current) {
        staleWhileHidden.current = false;
        invalidate();
      }
    });
    io.observe(el);
    return () => {
      ro.disconnect();
      io.disconnect();
    };
  }, [invalidate]);

  // ---- three infrastructure (once) ------------------------------------------
  useEffect(() => {
    const canvas = glCanvasRef.current;
    if (!canvas) return;
    let gl: GlState;
    try {
      const renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        powerPreference: 'high-performance',
      });
      const pr = Math.min(window.devicePixelRatio || 1, 2);
      renderer.setPixelRatio(pr);
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(NIGHT);
      const camera = new THREE.OrthographicCamera(0, 1000, 0, 1000, -10, 10);
      const composer = new EffectComposer(renderer);
      composer.addPass(new RenderPass(scene, camera));
      const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.65, 0.5, 0.16);
      composer.addPass(bloom);
      composer.addPass(new OutputPass());

      const starMat = new THREE.ShaderMaterial({
        uniforms: { uScale: { value: 1 }, uElapsed: { value: reducedMotion ? SETTLED : 0 } },
        vertexShader: STAR_VERT,
        fragmentShader: STAR_FRAG,
        transparent: true,
        depthWrite: false,
        depthTest: false,
      });
      const nebulaMat = new THREE.ShaderMaterial({
        uniforms: {
          uScale: { value: 1 },
          uElapsed: { value: reducedMotion ? SETTLED : 0 },
          uGain: { value: 0.1 },
        },
        vertexShader: NEBULA_VERT,
        fragmentShader: NEBULA_FRAG,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      });
      const linkMat = new THREE.LineBasicMaterial({
        color: new THREE.Color(liftNightCss('#4a443d')),
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      gl = {
        renderer,
        composer,
        bloom,
        scene,
        camera,
        starMat,
        nebulaMat,
        linkMat,
        geo: null,
        linkGeo: null,
        stars: null,
        nebula: null,
        links: null,
        pr,
      };
    } catch {
      setFailed(true);
      return;
    }
    glRef.current = gl;
    const onRestored = () => invalidate();
    canvas.addEventListener('webglcontextrestored', onRestored);
    return () => {
      canvas.removeEventListener('webglcontextrestored', onRestored);
      glRef.current = null;
      gl.geo?.dispose();
      gl.linkGeo?.dispose();
      gl.starMat.dispose();
      gl.nebulaMat.dispose();
      gl.linkMat.dispose();
      gl.composer.dispose();
      gl.renderer.dispose();
    };
  }, [reducedMotion, invalidate]);

  // ---- geometry: rebuilt only when the dataset changes -----------------------
  const entranceStart = useRef(0);
  const entranceRaf = useRef<number | null>(null);
  useEffect(() => {
    const gl = glRef.current;
    if (!gl) return;
    const tracks = lib.tracks;
    const n = tracks.length;

    if (gl.stars) gl.scene.remove(gl.stars);
    if (gl.nebula) gl.scene.remove(gl.nebula);
    if (gl.links) gl.scene.remove(gl.links);
    gl.geo?.dispose();
    gl.linkGeo?.dispose();

    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 3);
    const delay = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = tracks[i]!;
      pos[i * 3] = t.x;
      pos[i * 3 + 1] = t.y;
      delay[i] = Math.min(ENTRANCE_SPREAD, Math.hypot(t.x - 500, t.y - 500) * 0.9);
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aDelay', new THREE.BufferAttribute(delay, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(n), 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(n), 1));
    geo.setAttribute('aRing', new THREE.BufferAttribute(new Float32Array(n), 1));
    // Points never move, so cull by the full 1000×1000 disc instead of
    // recomputing bounds (which would also miss gl_PointSize overhang).
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(500, 500, 0), 900);

    const linkPairs = buildSynapseLinks(tracks);
    const linkGeo = new THREE.BufferGeometry();
    const lpos = new Float32Array(linkPairs.length * 6);
    linkPairs.forEach(([a, b], i) => {
      const ta = tracks[a]!;
      const tb = tracks[b]!;
      lpos[i * 6] = ta.x;
      lpos[i * 6 + 1] = ta.y;
      lpos[i * 6 + 3] = tb.x;
      lpos[i * 6 + 4] = tb.y;
    });
    linkGeo.setAttribute('position', new THREE.BufferAttribute(lpos, 3));
    linkGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(500, 500, 0), 900);

    // nebula splats fade with library size so density, not count, sets the glow
    gl.nebulaMat.uniforms.uGain!.value = Math.min(0.2, Math.max(0.004, 140 / Math.max(1, n)));

    const nebula = new THREE.Points(geo, gl.nebulaMat);
    nebula.renderOrder = 0;
    const links = new THREE.LineSegments(linkGeo, gl.linkMat);
    links.renderOrder = 1;
    const stars = new THREE.Points(geo, gl.starMat);
    stars.renderOrder = 2;
    nebula.frustumCulled = false;
    links.frustumCulled = false;
    stars.frustumCulled = false;
    gl.scene.add(nebula, links, stars);
    Object.assign(gl, { geo, linkGeo, stars, nebula, links });

    // (re)play the entrance for a new dataset
    if (!reducedMotion) {
      entranceStart.current = performance.now();
      gl.starMat.uniforms.uElapsed!.value = 0;
      gl.nebulaMat.uniforms.uElapsed!.value = 0;
      gl.linkMat.opacity = 0;
      if (entranceRaf.current != null) cancelAnimationFrame(entranceRaf.current);
      const loop = () => {
        const g = glRef.current;
        if (!g) return;
        const e = performance.now() - entranceStart.current;
        const done = e >= ENTRANCE_TOTAL;
        const el = done ? SETTLED : e;
        g.starMat.uniforms.uElapsed!.value = el;
        g.nebulaMat.uniforms.uElapsed!.value = el;
        g.linkMat.opacity = (filteringRef.current ? 0.1 : 0.22) * Math.min(1, e / ENTRANCE_TOTAL);
        // respect the offscreen gate — an idle below-the-fold embed shouldn't
        // burn ~1.1s of bloom frames; the IO handler repaints on reveal
        if (visibleRef.current) renderNow();
        else staleWhileHidden.current = true;
        entranceRaf.current = done ? null : requestAnimationFrame(loop);
      };
      entranceRaf.current = requestAnimationFrame(loop);
    } else {
      gl.linkMat.opacity = filtering ? 0.1 : 0.22;
      invalidate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lib, reducedMotion, renderNow, invalidate]);
  useEffect(
    () => () => {
      // reset the ids too — StrictMode remounts rerun the effects, and a stale
      // non-null id would make invalidate()'s "frame already scheduled" guard
      // wedge shut forever
      if (entranceRaf.current != null) cancelAnimationFrame(entranceRaf.current);
      if (frameReq.current != null) cancelAnimationFrame(frameReq.current);
      if (moveRaf.current != null) cancelAnimationFrame(moveRaf.current);
      entranceRaf.current = null;
      frameReq.current = null;
      moveRaf.current = null;
    },
    [],
  );

  // link opacity follows the filter state (read by the entrance loop via ref)
  useEffect(() => {
    const gl = glRef.current;
    if (!gl || entranceRaf.current != null) return;
    gl.linkMat.opacity = filtering ? 0.1 : 0.22;
    invalidate();
  }, [filtering, invalidate]);

  // ---- per-node attributes: colour / size / alpha / ring ---------------------
  useEffect(() => {
    const gl = glRef.current;
    if (!gl?.geo) return;
    const tracks = lib.tracks;
    const n = tracks.length;
    const color = gl.geo.getAttribute('aColor') as THREE.BufferAttribute;
    const sizeA = gl.geo.getAttribute('aSize') as THREE.BufferAttribute;
    const alpha = gl.geo.getAttribute('aAlpha') as THREE.BufferAttribute;
    const ring = gl.geo.getAttribute('aRing') as THREE.BufferAttribute;
    const carr = color.array as Float32Array;
    const sarr = sizeA.array as Float32Array;
    const aarr = alpha.array as Float32Array;
    const rarr = ring.array as Float32Array;
    const scratch = new THREE.Color();
    const cache = new Map<string, [number, number, number]>();
    for (let i = 0; i < n; i++) {
      const t = tracks[i]!;
      const matched = matchSet.has(t.idx);
      const isSel = selected != null && selected.idx === t.idx;
      const isNb = neighbourSet.has(t.idx);
      const base = 3.4 + (t.confidence ?? 0.5) * 2.2;
      sarr[i] = isSel ? base + 4 : isNb ? base + 1.6 : base;
      let op = matched ? 1 : 0.07;
      if (selected && matched && !isSel && !isNb) op = filtering ? 0.5 : 0.32;
      aarr[i] = op;
      const cssCol = isSel ? '#d94b2a' : nodeColor(t, colorBy);
      let lin = cache.get(cssCol);
      if (!lin) {
        const [r, g, b] = liftNight(cssCol);
        scratch.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
        lin = [scratch.r, scratch.g, scratch.b];
        cache.set(cssCol, lin);
      }
      carr[i * 3] = lin[0];
      carr[i * 3 + 1] = lin[1];
      carr[i * 3 + 2] = lin[2];
      rarr[i] = !nodeFilled(t, colorBy) && !isSel && !isNb ? 1 : 0;
    }
    color.needsUpdate = true;
    sizeA.needsUpdate = true;
    alpha.needsUpdate = true;
    ring.needsUpdate = true;
    invalidate();
  }, [lib, matchSet, colorBy, selected, neighbourSet, filtering, invalidate]);

  // ---- camera + point scale follow the view ---------------------------------
  useEffect(() => {
    const gl = glRef.current;
    const { w, h } = size;
    if (!gl || w === 0 || h === 0) return;
    gl.renderer.setSize(w, h, false);
    gl.composer.setSize(w, h);
    const { ox, oy, f } = fit(w, h);
    const v = view;
    gl.camera.left = ((0 - ox) / f - v.tx) / v.k;
    gl.camera.right = ((w - ox) / f - v.tx) / v.k;
    gl.camera.top = ((0 - oy) / f - v.ty) / v.k;
    gl.camera.bottom = ((h - oy) / f - v.ty) / v.k;
    gl.camera.updateProjectionMatrix();
    gl.starMat.uniforms.uScale!.value = 2 * HALO * f * Math.pow(v.k, SIZE_EXP) * gl.pr;
    // nebula scales spatially (it's a cloud you fly into) but thins with depth
    const nebFade = Math.min(1, Math.max(0.25, 1.35 - v.k * 0.22));
    gl.nebulaMat.uniforms.uScale!.value = Math.min(900, 2 * 46 * f * v.k * gl.pr) * nebFade;
    invalidate();

    // label layer: one transform + one counter-scale var; labels never re-lay-out
    const inner = labelInnerRef.current;
    if (inner) {
      inner.style.transform = `translate(${ox + v.tx * f}px, ${oy + v.ty * f}px) scale(${v.k * f})`;
      inner.style.setProperty('--inv', String(1 / (v.k * f)));
      inner.style.setProperty(
        '--gop',
        String(Math.max(0, Math.min(0.95, 1.2 - 0.3 * v.k)) * (v.k <= GENRE_LABEL_MAX_K ? 1 : 0)),
      );
    }
  }, [view, size, invalidate]);

  // ---- track labels: recomputed when the view settles ------------------------
  const [labelIdx, setLabelIdx] = useState<number[]>([]);
  useEffect(() => {
    const id = setTimeout(() => {
      const v = viewRef.current;
      const { w, h } = sizeRef.current;
      if (v.k < TRACK_LABEL_MIN_K || w === 0) {
        setLabelIdx((prev) => (prev.length ? [] : prev));
        return;
      }
      const { ox, oy, f } = fit(w, h);
      const tracks = lib.tracks;
      const cand: { i: number; sx: number; sy: number; p: number }[] = [];
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i]!;
        if (!matchSet.has(t.idx)) continue;
        const sx = ox + (v.tx + t.x * v.k) * f;
        const sy = oy + (v.ty + t.y * v.k) * f;
        if (sx < 0 || sx > w || sy < 0 || sy > h) continue;
        const p =
          (selected && selected.idx === t.idx ? 100 : 0) +
          (neighbourSet.has(t.idx) ? 50 : 0) +
          (t.confidence ?? 0.5) +
          (t.analysed ? 0.2 : 0);
        cand.push({ i, sx, sy, p });
      }
      cand.sort((a, b) => b.p - a.p);
      const used = new Set<string>();
      const out: number[] = [];
      for (const c of cand) {
        if (out.length >= TRACK_LABEL_CAP) break;
        const key = `${Math.floor(c.sx / LABEL_CELL_W)}|${Math.floor(c.sy / LABEL_CELL_H)}`;
        if (used.has(key)) continue;
        used.add(key);
        out.push(c.i);
      }
      setLabelIdx((prev) => (prev.length === out.length && prev.every((x, j) => x === out[j]) ? prev : out));
    }, 140);
    return () => clearTimeout(id);
  }, [view, size, lib, matchSet, selected, neighbourSet]);

  // ---- picking (uniform spatial grid, as before) ------------------------------
  const PICK_CELL = 32;
  const pickGrid = useMemo(() => {
    const g = new Map<string, number[]>();
    lib.tracks.forEach((t, i) => {
      const k = `${Math.floor(t.x / PICK_CELL)}|${Math.floor(t.y / PICK_CELL)}`;
      const bucket = g.get(k);
      if (bucket) bucket.push(i);
      else g.set(k, [i]);
    });
    return g;
  }, [lib]);
  const pick = useCallback(
    (clientX: number, clientY: number): ObsTrack | null => {
      const r = wrapRef.current!.getBoundingClientRect();
      const { ox, oy, f } = fit(r.width, r.height);
      const v = viewRef.current;
      const ux = ((clientX - r.left - ox) / f - v.tx) / v.k;
      const uy = ((clientY - r.top - oy) / f - v.ty) / v.k;
      const tolUser = Math.max(6, 7 / (v.k * f));
      let best: ObsTrack | null = null;
      let bd = tolUser * tolUser;
      const tracks = lib.tracks;
      const gx0 = Math.floor((ux - tolUser) / PICK_CELL);
      const gx1 = Math.floor((ux + tolUser) / PICK_CELL);
      const gy0 = Math.floor((uy - tolUser) / PICK_CELL);
      const gy1 = Math.floor((uy + tolUser) / PICK_CELL);
      for (let gx = gx0; gx <= gx1; gx++) {
        for (let gy = gy0; gy <= gy1; gy++) {
          const cell = pickGrid.get(`${gx}|${gy}`);
          if (!cell) continue;
          for (const i of cell) {
            const t = tracks[i]!;
            const dx = t.x - ux;
            const dy = t.y - uy;
            const d = dx * dx + dy * dy;
            if (d < bd) {
              bd = d;
              best = t;
            }
          }
        }
      }
      return best;
    },
    [lib, pickGrid],
  );

  // ---- pan + zoom + pinch -----------------------------------------------------
  const clampK = (k: number) => Math.max(K_MIN, Math.min(K_MAX, k));
  const commitView = (next: View) => {
    viewRef.current = next;
    pending.current = next;
    if (moveRaf.current == null) {
      moveRaf.current = requestAnimationFrame(() => {
        moveRaf.current = null;
        if (pending.current) setView(pending.current);
      });
    }
  };
  const onWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const r = wrapRef.current!.getBoundingClientRect();
    const { ox, oy, f } = fit(r.width, r.height);
    const vbx = (e.clientX - r.left - ox) / f;
    const vby = (e.clientY - r.top - oy) / f;
    setView((v) => {
      const k2 = clampK(v.k * (e.deltaY < 0 ? 1.12 : 0.893));
      const ux = (vbx - v.tx) / v.k;
      const uy = (vby - v.ty) / v.k;
      return { k: k2, tx: vbx - ux * k2, ty: vby - uy * k2 };
    });
  }, []);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [onWheel]);

  const midAndDist = () => {
    const pts = [...pointers.current.values()];
    const mx = (pts[0]!.x + pts[1]!.x) / 2;
    const my = (pts[0]!.y + pts[1]!.y) / 2;
    return { mx, my, d: Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y) };
  };
  const onPointerDown = (e: React.PointerEvent) => {
    // let the zoom/reset controls be plain buttons — capturing their pointer
    // would retarget the click to the wrapper (deselect) and eat the zoom
    if ((e.target as HTMLElement).closest('button')) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    downAt.current = { x: e.clientX, y: e.clientY };
    onHover(null);
    if (pointers.current.size === 2) {
      // second finger → switch from drag to pinch about the midpoint
      drag.current = null;
      const r = wrapRef.current!.getBoundingClientRect();
      const { ox, oy, f } = fit(r.width, r.height);
      const { mx, my, d } = midAndDist();
      const v = viewRef.current;
      const vbx = (mx - r.left - ox) / f;
      const vby = (my - r.top - oy) / f;
      pinch.current = { d0: Math.max(1, d), k0: v.k, ux: (vbx - v.tx) / v.k, uy: (vby - v.ty) / v.k };
      suppressClick.current = true;
    } else {
      const v = viewRef.current;
      drag.current = { sx: e.clientX, sy: e.clientY, tx: v.tx, ty: v.ty };
      setDragging(true);
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (pointers.current.has(e.pointerId)) {
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    if (pinch.current && pointers.current.size >= 2) {
      const r = wrapRef.current!.getBoundingClientRect();
      const { ox, oy, f } = fit(r.width, r.height);
      const { mx, my, d } = midAndDist();
      const p = pinch.current;
      const k2 = clampK((p.k0 * d) / p.d0);
      const vbx = (mx - r.left - ox) / f;
      const vby = (my - r.top - oy) / f;
      commitView({ k: k2, tx: vbx - p.ux * k2, ty: vby - p.uy * k2 });
      return;
    }
    const dr = drag.current;
    if (dr) {
      const r = wrapRef.current!.getBoundingClientRect();
      const { f } = fit(r.width, r.height);
      commitView({
        k: viewRef.current.k,
        tx: dr.tx + (e.clientX - dr.sx) / f,
        ty: dr.ty + (e.clientY - dr.sy) / f,
      });
      return;
    }
    const hit = pick(e.clientX, e.clientY);
    onHover(hit || null, hit ? e : undefined);
  };
  const onPointerEnd = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pinch.current && pointers.current.size < 2) {
      pinch.current = null;
      const rest = [...pointers.current.values()][0];
      if (rest) {
        const v = viewRef.current;
        drag.current = { sx: rest.x, sy: rest.y, tx: v.tx, ty: v.ty };
        return;
      }
    }
    if (pointers.current.size === 0) {
      if (downAt.current && Math.hypot(e.clientX - downAt.current.x, e.clientY - downAt.current.y) > 5) {
        suppressClick.current = true;
      }
      downAt.current = null;
      if (moveRaf.current != null) {
        cancelAnimationFrame(moveRaf.current);
        moveRaf.current = null;
      }
      if (pending.current) setView(pending.current);
      pending.current = null;
      drag.current = null;
      setDragging(false);
    }
  };
  const onClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    const hit = pick(e.clientX, e.clientY);
    onSelect(hit && selected && hit.idx === selected.idx ? null : hit);
  };

  const reset = () => setView({ k: 1, tx: 0, ty: 0 });
  const zoom = (factor: number) =>
    setView((v) => {
      const k2 = clampK(v.k * factor);
      const ux = (500 - v.tx) / v.k;
      const uy = (500 - v.ty) / v.k;
      return { k: k2, tx: 500 - ux * k2, ty: 500 - uy * k2 };
    });

  // ---- fly-to: animate the camera to centre a requested node -----------------
  // Screen centre is always viewbox (500,500) under meet-fit letterboxing, so
  // the target is exact regardless of stage aspect. Zoom eases geometrically
  // (perceptually linear), translation linearly on the same eased parameter —
  // the focal point drifts a hair mid-flight but lands exactly.
  const flyRaf = useRef<number | null>(null);
  useEffect(() => {
    if (!focus) return;
    const t = focus.t;
    const from = viewRef.current;
    const k2 = clampK(Math.max(from.k, 3));
    const target = { k: k2, tx: 500 - t.x * k2, ty: 500 - t.y * k2 };
    if (flyRaf.current != null) cancelAnimationFrame(flyRaf.current);
    if (reducedMotion) {
      viewRef.current = target;
      setView(target);
      return;
    }
    const t0 = performance.now();
    const DUR = 600;
    const step = () => {
      const p = Math.min(1, (performance.now() - t0) / DUR);
      const e = 1 - Math.pow(1 - p, 3);
      const k = from.k * Math.pow(target.k / from.k, e);
      const next = {
        k,
        tx: from.tx + (target.tx - from.tx) * e,
        ty: from.ty + (target.ty - from.ty) * e,
      };
      viewRef.current = next;
      setView(next);
      flyRaf.current = p < 1 ? requestAnimationFrame(step) : null;
    };
    flyRaf.current = requestAnimationFrame(step);
    return () => {
      if (flyRaf.current != null) {
        cancelAnimationFrame(flyRaf.current);
        flyRaf.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.n]);

  // ---- keyboard: pan with arrows, zoom with +/-, 0 resets ---------------------
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('button')) return; // zoom controls keep their own keys
    const PAN = 60; // viewbox units per press — a comfortable nudge at any zoom
    const v = viewRef.current;
    if (e.key === 'ArrowLeft') commitView({ ...v, tx: v.tx + PAN });
    else if (e.key === 'ArrowRight') commitView({ ...v, tx: v.tx - PAN });
    else if (e.key === 'ArrowUp') commitView({ ...v, ty: v.ty + PAN });
    else if (e.key === 'ArrowDown') commitView({ ...v, ty: v.ty - PAN });
    else if (e.key === '+' || e.key === '=') zoom(1.3);
    else if (e.key === '-' || e.key === '_') zoom(0.77);
    else if (e.key === '0') reset();
    else return;
    e.preventDefault();
  };

  const transform = `translate(${view.tx} ${view.ty}) scale(${view.k})`;
  // Constellation names, greedily decluttered: lib.genres is most-populous
  // first, so when two centroids crowd each other (common on the sound map,
  // where 80+ genre centroids can share the dense core) the bigger scene wins.
  const genreLabels = useMemo(() => {
    const kept: { g: string; c: { x: number; y: number } }[] = [];
    for (const g of lib.genres) {
      if (g === '—') continue;
      const c = lib.centers[g];
      if (!c) continue;
      if (kept.some((k) => Math.hypot(k.c.x - c.x, k.c.y - c.y) < 70)) continue;
      kept.push({ g, c });
      if (kept.length >= 36) break;
    }
    return kept;
  }, [lib]);

  if (failed) {
    return (
      <div className="cmap cmap-galaxy" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span className="t-caption ad-muted">WEBGL UNAVAILABLE — THE OBSERVATORY NEEDS A GPU-CAPABLE BROWSER</span>
      </div>
    );
  }

  return (
    <div
      className="cmap cmap-galaxy"
      ref={wrapRef}
      style={{ cursor: dragging ? 'grabbing' : hovered ? 'pointer' : 'grab' }}
      tabIndex={0}
      role="application"
      aria-label="library map — arrow keys pan, plus and minus zoom, zero resets, click a star to inspect it"
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onPointerLeave={onPointerEnd}
      onClick={onClick}
    >
      <canvas ref={glCanvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />

      {/* constellation names + track labels — one transformed layer, no re-layout */}
      <div className="cmap-labels" aria-hidden="true">
        <div className="cmap-labels-inner" ref={labelInnerRef}>
          {genreLabels.map(({ g, c }) => (
            <span key={g} className="cmap-glabel" style={{ transform: `translate(${c.x}px, ${c.y}px) scale(var(--inv, 1)) translate(-50%, -50%)` }}>
              {g}
            </span>
          ))}
          {labelIdx.map((i) => {
            const t = lib.tracks[i];
            if (!t) return null;
            const isSel = selected != null && selected.idx === t.idx;
            return (
              <span
                key={t.idx}
                className={'cmap-tlabel' + (isSel || neighbourSet.has(t.idx) ? ' acc' : '')}
                style={{ transform: `translate(${t.x}px, ${t.y}px) scale(var(--inv, 1)) translate(-50%, 9px)` }}
              >
                {t.title || '—'}
              </span>
            );
          })}
        </div>
      </div>

      {/* highlight overlay — wiring, ripple, hover (a few elements at most) */}
      <svg
        viewBox="0 0 1000 1000"
        preserveAspectRatio="xMidYMid meet"
        className="cmap-svg"
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
      >
        <g transform={transform}>
          {selected && (
            <g className="cmap-wire">
              {neighbours.map((n, i) => (
                <line
                  key={i}
                  x1={selected.x}
                  y1={selected.y}
                  x2={n.x}
                  y2={n.y}
                  stroke="var(--accent)"
                  strokeWidth={1.1}
                  vectorEffect="non-scaling-stroke"
                  strokeDasharray="3 2.5"
                  className="wire-line"
                  style={{ animationDelay: i * 60 + 'ms' }}
                />
              ))}
            </g>
          )}
          {hovered && (!selected || selected.idx !== hovered.idx) && (
            <circle
              cx={hovered.x}
              cy={hovered.y}
              r={3.4 + (hovered.confidence ?? 0.5) * 2.2 + 2.4}
              fill="none"
              stroke="var(--accent)"
              strokeWidth={1.3}
              vectorEffect="non-scaling-stroke"
              style={{ transition: 'r .15s cubic-bezier(.2,.7,.2,1)' }}
            />
          )}
          {selected && (
            <circle
              cx={selected.x}
              cy={selected.y}
              r={14}
              fill="none"
              stroke="var(--accent)"
              strokeWidth={1.4}
              vectorEffect="non-scaling-stroke"
              className="cmap-ripple"
            />
          )}
        </g>
      </svg>

      {/* zoom controls */}
      <div className="cmap-zoom">
        <button onClick={() => zoom(1.3)} aria-label="zoom in">
          +
        </button>
        <button onClick={() => zoom(0.77)} aria-label="zoom out">
          −
        </button>
        <button onClick={reset} aria-label="reset" className="cmap-reset">
          RESET
        </button>
      </div>

      {/* legend — swatches pass through the same night-lift as the stars, and
          every colour-by mode gets the key its nodeColor/nodeFilled actually
          draw: heat ramps for the continuous scalars (with a hollow chip for
          the unmeasured), palettes for the categoricals */}
      <div className="cmap-legend">
        <span className="t-caption ad-muted">{legendLabel(colorBy)}</span>
        {colorBy === 'energy' || colorBy === 'confidence' || colorBy === 'loudness' || colorBy === 'pace' ? (
          <>
            <div className="legend-ramp">
              <span className="lr-bar" />
              <span className="t-caption ad-muted">{RAMP_ENDS[colorBy][0]}</span>
              <span className="t-caption ad-muted" style={{ marginLeft: 'auto' }}>
                {RAMP_ENDS[colorBy][1]}
              </span>
            </div>
            {(colorBy === 'loudness' || colorBy === 'pace') && (
              <div className="legend-keys">
                <span>
                  <i className="lk hollow" style={{ borderColor: liftNightCss('#9b948a') }} />
                  NOT MEASURED
                </span>
              </div>
            )}
          </>
        ) : colorBy === 'source' ? (
          <div className="legend-keys">
            <span>
              <i className="lk" style={{ background: liftNightCss('#d94b2a') }} />
              MANUAL
            </span>
            <span>
              <i className="lk" style={{ background: liftNightCss('#9a5b1f') }} />
              LLM
            </span>
            <span>
              <i className="lk" style={{ background: liftNightCss('#4a443d') }} />
              PROPAGATED
            </span>
            <span>
              <i className="lk hollow" style={{ borderColor: liftNightCss('#9b948a') }} />
              UNCERTAIN · LEGACY
            </span>
          </div>
        ) : colorBy === 'vocal' ? (
          <div className="legend-keys">
            <span>
              <i className="lk" style={{ background: liftNightCss('#d94b2a') }} />
              VOCAL
            </span>
            <span>
              <i className="lk" style={{ background: liftNightCss('#4a443d') }} />
              INSTRUMENTAL
            </span>
            <span>
              <i className="lk hollow" style={{ borderColor: liftNightCss('#9b948a') }} />
              NOT ANALYSED
            </span>
          </div>
        ) : (
          <div className="legend-keys">
            <span>
              <i className="lk" style={{ background: liftNightCss('#d94b2a') }} />
              ANALYSED
            </span>
            <span>
              <i className="lk hollow" style={{ borderColor: liftNightCss('#9b948a') }} />
              NOT ANALYSED
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// End labels for the heat-ramp legends, per continuous colour-by mode.
const RAMP_ENDS: Record<'energy' | 'confidence' | 'loudness' | 'pace', [string, string]> = {
  energy: ['LOW', 'HIGH'],
  confidence: ['0.0', '1.0'],
  loudness: ['QUIET', 'LOUD'],
  pace: ['CALM', 'DRIVING'],
};

function legendLabel(c: ColorBy): string {
  switch (c) {
    case 'energy':
      return 'NODE COLOUR · ENERGY';
    case 'confidence':
      return 'NODE COLOUR · TAG CONFIDENCE';
    case 'source':
      return 'NODE COLOUR · TAG SOURCE';
    case 'loudness':
      return 'NODE COLOUR · LOUDNESS';
    case 'pace':
      return 'NODE COLOUR · PACE';
    case 'vocal':
      return 'NODE COLOUR · VOICE';
    default:
      return 'NODE COLOUR · ACOUSTIC ANALYSIS';
  }
}
