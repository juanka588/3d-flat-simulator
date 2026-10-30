/**
 * Render passes (CG1): depth, view-space normals, class and instance id masks, structural edges and the camera, drawn from
 * the same camera as the colour render, the same size, without any debug marker.
 *
 * Every pass but the colour one is drawn into an unsampled RGBA8 render target with flat shader output (no lights, no tone
 * mapping, no colour management, no antialiasing), so the bytes depend on the geometry only and are the same on every run.
 * Depth is packed as millimetres into R (high byte) and G (low byte), read back and written as a 16-bit grayscale PNG.
 *
 * The live scene graph is borrowed for the duration of one call: helper objects are hidden, geometries and materials of
 * the id passes are swapped, and everything is put back (also when a pass throws).
 */
import type { Owner, PinholeCamera, Scene } from '@flat/scene';
import { cameraFromMatrixWorld, intrinsicsOf } from '@flat/scene';
import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  Matrix4,
  MeshNormalMaterial,
  NearestFilter,
  RGBAFormat,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  Vector3,
  WebGLRenderTarget,
} from 'three';
import type { Camera, InstancedMesh, Material, Mesh, Object3D, OrthographicCamera, PerspectiveCamera, WebGLRenderer } from 'three';
import { DEFAULT_EDGE_PARAMS, detectEdges } from './edges';
import type { EdgeParams } from './edges';
import { CLASS_COLORS, SceneIndex, buildClassLegend, buildLegend, packRgb } from './legend';
import type { ClassLegendEntry, Entity, LegendEntry } from './legend';
import { encodePng, pngDataUrl } from './png';

export const PASS_KINDS = ['color', 'depth', 'depthVis', 'normals', 'ids', 'instances', 'edges', 'edgesItems'] as const;
export type PassKind = (typeof PASS_KINDS)[number];

export interface PassesRequest {
  /** Which images to draw (default: all). The camera JSON is always returned. */
  kinds?: readonly PassKind[];
  /** Pixels; default: the size of the canvas. The page's viewport is forced to it for the call. */
  size?: { width: number; height: number };
  /** Tuning of the edge detector. */
  edges?: Partial<EdgeParams>;
}

export interface PassCamera {
  type: 'perspective' | 'orthographic';
  width: number;
  height: number;
  aspect: number;
  /** Vertical field of view in degrees (perspective). */
  fovDeg: number | null;
  near: number;
  far: number;
  /** Pixels (perspective only). */
  intrinsics: { fx: number; fy: number; cx: number; cy: number } | null;
  /** World space, metres. */
  position: [number, number, number];
  /** The point the camera looks at: the world point at the image centre (or 1 m ahead when nothing was drawn there). */
  target: [number, number, number];
  right: [number, number, number];
  up: [number, number, number];
  forward: [number, number, number];
  /** Camera to world and world to camera, column-major (three.js `matrixWorld` / `matrixWorldInverse`), and the projection matrix. */
  matrixWorld: number[];
  viewMatrix: number[];
  projectionMatrix: number[];
  /** Orthographic only. */
  ortho: { left: number; right: number; top: number; bottom: number; zoom: number } | null;
  conventions: string;
}

export interface DepthInfo {
  /** Image encoding: PNG, 1 channel, 16 bit. */
  encoding: 'png16-gray';
  /** Metres per unit of the stored value. */
  unitM: number;
  /** Stored value for "nothing drawn". */
  invalid: number;
  /** Depth is the distance along the optical axis (view-space z), not the distance to the camera. */
  kind: 'z';
  minM: number | null;
  maxM: number | null;
  /** `depthVis`: 255 at `minM`, 0 at `maxM`. */
  visualisation: string;
}

export interface PassesResult {
  size: { width: number; height: number };
  /** PNG data URLs by kind. */
  images: Partial<Record<PassKind, string>>;
  camera: PassCamera;
  depth: DepthInfo | null;
  legend: { classes: ClassLegendEntry[]; instances: LegendEntry[]; unclassified: string[] } | null;
  edges: (EdgeParams & { source: string }) | null;
  ms: number;
}

// ---------------------------------------------------------------------------------------------
// What is a helper
// ---------------------------------------------------------------------------------------------

/** Objects that are tooling, never part of the flat: hidden in every pass, including the clean colour one. */
const HELPER_NAMES = new Set(['selection-highlight', 'person', 'structural-overlay', 'editor-overlay']);
/** Objects that only exist for the final look (sky, soft shadow decals, shadow-only casters, ghost outlines): hidden in the geometric passes. */
const VISUAL_NAMES = new Set(['sky', 'shadow-casters', 'contact-shadows', 'context-canopy', 'host-ghost', 'host-ghost-edges', 'host-facade-edges']);

/** Debug markers and tooling: the selection tint, the person ghost, plan overlays, editor gizmos and the glowing bulb sphere of a point lamp. */
export function isHelper(o: Object3D): boolean {
  return HELPER_NAMES.has(o.name) || o.userData['helper'] === true || (o.name.startsWith('fixture:') && o.userData['lampType'] === 'point');
}

function isVisualOnly(o: Object3D): boolean {
  if (VISUAL_NAMES.has(o.name)) return true;
  const any = o as Object3D & { isLine?: boolean; isPoints?: boolean; isSprite?: boolean; isMesh?: boolean; material?: Material | Material[] };
  if (any.isLine || any.isPoints || any.isSprite) return true;
  if (any.isMesh && any.material) {
    const mats = Array.isArray(any.material) ? any.material : [any.material];
    if (mats.length > 0 && mats.every((m) => m.colorWrite === false)) return true;
  }
  return false;
}

/** Hides what `hide` says, runs `fn`, and shows it again. */
function withHidden<T>(root: Object3D, hide: (o: Object3D) => boolean, fn: () => T): T {
  const hidden: Object3D[] = [];
  root.traverse((o) => {
    if (o !== root && o.visible && hide(o)) {
      o.visible = false;
      hidden.push(o);
    }
  });
  try {
    return fn();
  } finally {
    for (const o of hidden) o.visible = true;
  }
}

// ---------------------------------------------------------------------------------------------
// Drawables
// ---------------------------------------------------------------------------------------------

type Drawable =
  | { t: 'shell'; mesh: Mesh; name: string; owners: readonly Owner[] }
  | { t: 'item'; mesh: Mesh; ids: readonly string[]; instanced: boolean }
  | { t: 'fixture'; mesh: Mesh; id: string }
  | { t: 'context'; mesh: Mesh }
  | { t: 'other'; mesh: Mesh };

function itemIdOf(o: Object3D): string | undefined {
  for (let p: Object3D | null = o; p; p = p.parent) {
    const id = p.userData['itemId'];
    if (typeof id === 'string') return id;
  }
  return undefined;
}

function drawablesOf(root: Object3D): Drawable[] {
  const out: Drawable[] = [];
  root.traverseVisible((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    const owners = mesh.userData['owners'] as readonly Owner[] | undefined;
    const ids = mesh.userData['itemIds'] as readonly string[] | undefined;
    if (owners) out.push({ t: 'shell', mesh, name: mesh.name, owners });
    else if (mesh.name.startsWith('fixture:')) out.push({ t: 'fixture', mesh, id: mesh.name.slice('fixture:'.length) });
    else if (ids) out.push({ t: 'item', mesh, ids, instanced: true });
    else if (itemIdOf(mesh)) out.push({ t: 'item', mesh, ids: [itemIdOf(mesh)!], instanced: false });
    else if (mesh.name.startsWith('context-') || mesh.name.startsWith('host-')) out.push({ t: 'context', mesh });
    else out.push({ t: 'other', mesh });
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------------------------

const VERTEX = /* glsl */ `
varying float vZ;
varying vec3 vC;
uniform vec3 uColor;
void main() {
  #include <begin_vertex>
  #include <project_vertex>
  vZ = -mvPosition.z;
  #if defined( USE_INSTANCING_COLOR )
    vC = instanceColor;
  #elif defined( USE_COLOR )
    vC = color;
  #else
    vC = uColor;
  #endif
}`;

const DEPTH_FRAGMENT = /* glsl */ `
varying float vZ;
varying vec3 vC;
void main() {
  float mm = min(floor(vZ * 1000.0 + 0.5), 65535.0);
  float hi = floor(mm / 256.0);
  gl_FragColor = vec4(hi / 255.0, (mm - hi * 256.0) / 255.0, 0.0, 1.0);
}`;

const FLAT_FRAGMENT = /* glsl */ `
varying float vZ;
varying vec3 vC;
void main() { gl_FragColor = vec4(vC, 1.0); }`;

function shader(fragmentShader: string, vertexColors: boolean, rgb: readonly [number, number, number] = [0, 0, 0]): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader,
    vertexColors,
    side: DoubleSide,
    toneMapped: false,
    uniforms: { uColor: { value: new Vector3(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255) } },
  });
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------------------------

/** One vertex per triangle corner, coloured per triangle by its owner. Shares the original's bounds. */
function expandShell(geo: BufferGeometry, owners: readonly Owner[], colorOf: (o: Owner) => readonly [number, number, number]): BufferGeometry {
  const index = geo.index!.array;
  const src = geo.getAttribute('position');
  const tris = index.length / 3;
  const position = new Float32Array(tris * 9);
  const color = new Float32Array(tris * 9);
  for (let t = 0; t < tris; t++) {
    for (let k = 0; k < 3; k++) {
      const v = index[t * 3 + k]!;
      position[t * 9 + k * 3] = src.getX(v);
      position[t * 9 + k * 3 + 1] = src.getY(v);
      position[t * 9 + k * 3 + 2] = src.getZ(v);
    }
  }
  for (const o of owners) {
    const c = colorOf(o);
    for (let t = o.start; t < o.start + o.count && t < tris; t++) {
      for (let k = 0; k < 3; k++) {
        color[t * 9 + k * 3] = c[0] / 255;
        color[t * 9 + k * 3 + 1] = c[1] / 255;
        color[t * 9 + k * 3 + 2] = c[2] / 255;
      }
    }
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new Float32BufferAttribute(position, 3));
  out.setAttribute('color', new Float32BufferAttribute(color, 3));
  if (!geo.boundingSphere) geo.computeBoundingSphere();
  out.boundingSphere = geo.boundingSphere!.clone();
  return out;
}

/** The mesh's geometry with only the triangles `keep` accepts (same vertex buffers, no groups); null when none is left. */
function filterTriangles(geo: BufferGeometry, owners: readonly Owner[], keep: (o: Owner) => boolean): BufferGeometry | null {
  const index = geo.index!.array;
  const kept: number[] = [];
  for (const o of owners) {
    if (!keep(o)) continue;
    for (let i = o.start * 3; i < (o.start + o.count) * 3; i++) kept.push(index[i]!);
  }
  if (kept.length === 0) return null;
  const out = new BufferGeometry();
  for (const [name, attr] of Object.entries(geo.attributes)) out.setAttribute(name, attr);
  out.setIndex(kept);
  if (!geo.boundingSphere) geo.computeBoundingSphere();
  out.boundingSphere = geo.boundingSphere!.clone();
  return out;
}

// ---------------------------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------------------------


export interface PassSource {
  gl: WebGLRenderer;
  scene: Scene3;
  camera: Camera;
  /** The flat being drawn (entity classes, locked items, opening types). */
  model: Scene;
}

/** The parts of a three `Scene` the passes touch. */
type Scene3 = Object3D & { background: unknown; environment: unknown; fog: unknown; overrideMaterial: Material | null };

type Mode = 'depth' | 'normals' | 'classes' | 'instances';

// Materials live as long as the page: their shader programs stay compiled between calls.
let depthMaterial: ShaderMaterial | undefined;
let normalMaterial: MeshNormalMaterial | undefined;
let vertexIdMaterial: ShaderMaterial | undefined;
let instanceIdMaterial: ShaderMaterial | undefined;
const uniformMaterials = new Map<number, ShaderMaterial>();

function uniformMaterial(rgb: readonly [number, number, number]): ShaderMaterial {
  const key = packRgb(rgb);
  let m = uniformMaterials.get(key);
  if (!m) {
    if (uniformMaterials.size > 2000) {
      for (const old of uniformMaterials.values()) old.dispose();
      uniformMaterials.clear();
    }
    m = shader(FLAT_FRAGMENT, false, rgb);
    m.uniforms['uColor'] = { value: new Vector3(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255) };
    uniformMaterials.set(key, m);
  }
  return m;
}

/** RGBA bytes read from a render target, flipped to top row first. */
function readTarget(gl: WebGLRenderer, target: WebGLRenderTarget): Uint8Array {
  const { width, height } = target;
  const raw = new Uint8Array(width * height * 4);
  gl.readRenderTargetPixels(target, 0, 0, width, height, raw);
  const out = new Uint8Array(raw.length);
  const row = width * 4;
  for (let y = 0; y < height; y++) out.set(raw.subarray((height - 1 - y) * row, (height - y) * row), y * row);
  return out;
}

class Runner {
  readonly index: SceneIndex;
  readonly unclassified = new Set<string>();
  private readonly target: WebGLRenderTarget;
  readonly width: number;
  readonly height: number;

  constructor(private readonly src: PassSource, width: number, height: number) {
    this.index = new SceneIndex(src.model);
    this.width = width;
    this.height = height;
    this.target = new WebGLRenderTarget(width, height, { type: UnsignedByteType, format: RGBAFormat, minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: true, stencilBuffer: false, samples: 0 });
  }

  dispose(): void {
    this.target.dispose();
  }

  /** The clean colour picture: the canvas drawn without helpers. */
  color(): string {
    const { gl, scene, camera } = this.src;
    return withHidden(scene, isHelper, () => {
      gl.render(scene, camera);
      return gl.domElement.toDataURL('image/png');
    });
  }

  /**
   * One flat-shaded pass as RGBA bytes, top row first. `structureOnly` leaves out everything that is not the building: unlocked
   * items and lamp fixtures (locked furniture, the kitchen and wardrobes, stays: it is part of the room).
   */
  draw(mode: Mode, structureOnly = false): Uint8Array {
    const { gl, scene, camera } = this.src;
    const undo: (() => void)[] = [];
    const swap = (mesh: Mesh, geometry: BufferGeometry | null, material: Material | Material[] | null) => {
      const g = mesh.geometry;
      const m = mesh.material;
      if (geometry) mesh.geometry = geometry;
      if (material) mesh.material = material;
      undo.push(() => {
        mesh.geometry = g;
        mesh.material = m;
        if (geometry) geometry.dispose();
      });
    };
    const hide = (mesh: Mesh) => {
      mesh.visible = false;
      undo.push(() => {
        mesh.visible = true;
      });
    };
    const geometric = mode === 'depth' || mode === 'normals';
    const classes = mode === 'classes';
    const colorOfEntity = (e: Entity): readonly [number, number, number] => (classes ? CLASS_COLORS[e.class] : this.index.colorOf(e.key));
    const isLocked = (id: string) => this.index.itemEntity(id).class === 'locked_fitting';

    const saved = { background: scene.background, environment: scene.environment, fog: scene.fog, override: scene.overrideMaterial, clearAlpha: gl.getClearAlpha(), target: gl.getRenderTarget(), shadowAuto: gl.shadowMap.autoUpdate, shadowNeeds: gl.shadowMap.needsUpdate };
    const clearColor = gl.getClearColor(new Color());
    return withHidden(scene, (o) => isHelper(o) || isVisualOnly(o), () => {
      try {
        if (geometric) {
          depthMaterial ??= shader(DEPTH_FRAGMENT, false);
          normalMaterial ??= new MeshNormalMaterial({ side: DoubleSide });
          scene.overrideMaterial = mode === 'depth' ? depthMaterial : normalMaterial;
        } else {
          vertexIdMaterial ??= shader(FLAT_FRAGMENT, true);
          instanceIdMaterial ??= shader(FLAT_FRAGMENT, false);
          scene.overrideMaterial = null;
        }
        const drawables = drawablesOf(scene);
        // A content-defined draw order. Where two surfaces meet (a wall standing on the floor) the crease pixels tie in depth and,
        // with three's LessEqual test, the last one drawn wins; three would order them by the camera distance of their bounding
        // spheres and then by object id, so a rebuilt mesh (a floor or wall finish change) could flip a crease pixel and the
        // "structural" edges would depend on edit history. Each mesh keeps its own renderOrder (fittings, glass) as the major key.
        drawables
          .map((d) => ({ d, key: `${d.t}|${d.mesh.name}|${d.t === 'item' ? d.ids[0] : d.t === 'fixture' ? d.id : ''}` }))
          .sort((a, b) => a.d.mesh.renderOrder - b.d.mesh.renderOrder || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
          .forEach(({ d }, rank) => {
            const before = d.mesh.renderOrder;
            d.mesh.renderOrder = rank;
            undo.push(() => {
              d.mesh.renderOrder = before;
            });
          });
        for (const d of drawables) {
          if (geometric) {
            if (!structureOnly) continue;
            if (d.t === 'fixture') hide(d.mesh);
            else if (d.t === 'item') {
              if (!d.ids.every(isLocked)) hide(d.mesh);
            } else if (d.t === 'shell' && d.name === 'items') {
              const geo = filterTriangles(d.mesh.geometry, d.owners, (o) => isLocked(o.entityId));
              if (!geo) hide(d.mesh);
              else swap(d.mesh, geo, scene.overrideMaterial);
            }
            continue;
          }
          if (d.t === 'shell') {
            const cache = new Map<string, readonly [number, number, number]>();
            const geo = expandShell(d.mesh.geometry, d.owners, (o) => {
              const key = `${o.kind}|${o.entityId}|${o.zoneId ?? ''}`;
              let c = cache.get(key);
              if (!c) cache.set(key, (c = colorOfEntity(this.index.ofOwner(d.name, o))));
              return c;
            });
            swap(d.mesh, geo, vertexIdMaterial!);
          } else if (d.t === 'item') {
            if (d.instanced) {
              const im = d.mesh as InstancedMesh;
              const colors = new Float32Array(im.count * 3);
              for (let i = 0; i < im.count; i++) {
                const c = colorOfEntity(this.index.itemEntity(d.ids[i] ?? ''));
                colors.set([c[0] / 255, c[1] / 255, c[2] / 255], i * 3);
              }
              const before = im.instanceColor;
              im.instanceColor = new InstancedBufferAttribute(colors, 3);
              undo.push(() => {
                im.instanceColor = before;
              });
              swap(d.mesh, null, instanceIdMaterial!);
            } else swap(d.mesh, null, uniformMaterial(colorOfEntity(this.index.itemEntity(d.ids[0]!))));
          } else if (d.t === 'fixture') swap(d.mesh, null, uniformMaterial(colorOfEntity(this.index.lightEntity(d.id))));
          else if (d.t === 'context') swap(d.mesh, null, uniformMaterial(colorOfEntity(this.index.contextEntity())));
          else {
            this.unclassified.add(d.mesh.name || d.mesh.type);
            swap(d.mesh, null, uniformMaterial(classes ? CLASS_COLORS.other : this.index.colorOf(`other:${d.mesh.name}`)));
          }
        }
        scene.background = null;
        scene.environment = null;
        scene.fog = null;
        gl.shadowMap.autoUpdate = false;
        gl.shadowMap.needsUpdate = false;
        gl.setRenderTarget(this.target);
        gl.setClearColor(0x000000, 0);
        gl.clear();
        gl.render(scene, camera);
        return readTarget(gl, this.target);
      } finally {
        for (const u of undo.reverse()) u();
        gl.setRenderTarget(saved.target);
        gl.setClearColor(clearColor, saved.clearAlpha);
        gl.shadowMap.autoUpdate = saved.shadowAuto;
        gl.shadowMap.needsUpdate = saved.shadowNeeds;
        scene.background = saved.background;
        scene.environment = saved.environment;
        scene.fog = saved.fog;
        scene.overrideMaterial = saved.override;
      }
    });
  }
}

/** Millimetres per pixel from a depth pass (0 where nothing was drawn). */
function depthMm(rgba: Uint8Array): Uint16Array {
  const out = new Uint16Array(rgba.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4 + 3] === 0 ? 0 : rgba[i * 4]! * 256 + rgba[i * 4 + 1]!;
  return out;
}

function rgbOf(rgba: Uint8Array): Uint8Array {
  const out = new Uint8Array((rgba.length / 4) * 3);
  for (let i = 0, n = rgba.length / 4; i < n; i++) {
    out[i * 3] = rgba[i * 4]!;
    out[i * 3 + 1] = rgba[i * 4 + 1]!;
    out[i * 3 + 2] = rgba[i * 4 + 2]!;
  }
  return out;
}

function countColors(rgba: Uint8Array): Map<number, number> {
  const counts = new Map<number, number>();
  for (let i = 0; i < rgba.length; i += 4) {
    const k = (rgba[i]! << 16) | (rgba[i + 1]! << 8) | rgba[i + 2]!;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

const round = (n: number, digits = 6) => Math.round(n * 10 ** digits) / 10 ** digits;

function cameraJson(camera: Camera, width: number, height: number, centreDepthM: number): PassCamera {
  camera.updateMatrixWorld(true);
  const view = new Matrix4().copy(camera.matrixWorld).invert();
  const el = camera.matrixWorld.elements;
  const persp = (camera as PerspectiveCamera).isPerspectiveCamera ? (camera as PerspectiveCamera) : null;
  const ortho = (camera as OrthographicCamera).isOrthographicCamera ? (camera as OrthographicCamera) : null;
  const pin: PinholeCamera = cameraFromMatrixWorld(el, persp?.fov ?? 0, width, height);
  const depth = centreDepthM > 0 ? centreDepthM : 1;
  const vec = (v: readonly number[]) => v.map((x) => round(x)) as [number, number, number];
  return {
    type: persp ? 'perspective' : 'orthographic',
    width,
    height,
    aspect: round(width / height),
    fovDeg: persp ? round(persp.fov) : null,
    near: round((camera as PerspectiveCamera).near),
    far: round((camera as PerspectiveCamera).far),
    intrinsics: persp ? Object.fromEntries(Object.entries(intrinsicsOf(pin)).map(([k, v]) => [k, round(v)])) as PassCamera['intrinsics'] : null,
    position: vec(pin.position),
    target: vec([0, 1, 2].map((i) => pin.position[i]! + pin.forward[i]! * depth)),
    right: vec(pin.right),
    up: vec(pin.up),
    forward: vec(pin.forward),
    matrixWorld: Array.from(el, (x) => round(x, 9)),
    viewMatrix: Array.from(view.elements, (x) => round(x, 9)),
    projectionMatrix: Array.from(camera.projectionMatrix.elements, (x) => round(x, 9)),
    ortho: ortho ? { left: ortho.left, right: ortho.right, top: ortho.top, bottom: ortho.bottom, zoom: ortho.zoom } : null,
    conventions:
      'World: X = plan x, Y = up, Z = plan y (north is -Z), metres. Camera looks down its local -Z, +Y up; right/up/forward are the camera axes in world space. Pixels: origin top-left, x right, y down, pixel (i, j) centre at (i + 0.5, j + 0.5). Depth: metres along forward (view-space z). Unproject: world = position + right * (x - cx) / fx * d - up * (y - cy) / fy * d + forward * d.',
  };
}

/** Draws the requested passes of the scene as seen by the current camera. */
export async function renderPasses(src: PassSource, req: PassesRequest = {}): Promise<PassesResult> {
  const t0 = performance.now();
  const kinds = new Set<PassKind>(req.kinds && req.kinds.length ? req.kinds : PASS_KINDS);
  const { gl, camera } = src;
  const buffer = gl.getDrawingBufferSize(new Vector2());
  const width = buffer.x;
  const height = buffer.y;
  const params = { ...DEFAULT_EDGE_PARAMS, ...req.edges };
  const run = new Runner(src, width, height);
  const images: PassesResult['images'] = {};
  let depthInfo: DepthInfo;
  let legend: PassesResult['legend'] = null;
  let centre: number;
  const memo = new Map<string, Uint8Array>();
  const draw = (mode: Mode, structureOnly = false) => {
    const key = `${mode}:${structureOnly}`;
    let px = memo.get(key);
    if (!px) memo.set(key, (px = run.draw(mode, structureOnly)));
    return px;
  };
  const png = async (channels: 1 | 3 | 4, bitDepth: 8 | 16, data: Uint8Array | Uint16Array) => pngDataUrl(await encodePng({ width, height, channels, bitDepth, data }));
  try {
    {
      const mm = depthMm(draw('depth'));
      centre = mm[Math.floor(height / 2) * width + Math.floor(width / 2)]! / 1000;
      let lo = Infinity;
      let hi = 0;
      for (const v of mm) {
        if (v === 0) continue;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      depthInfo = {
        encoding: 'png16-gray',
        unitM: 0.001,
        invalid: 0,
        kind: 'z',
        minM: hi > 0 ? lo / 1000 : null,
        maxM: hi > 0 ? hi / 1000 : null,
        visualisation: 'depthVis is 8-bit gray: 255 at minM (near), 0 at maxM (far) and for pixels with nothing drawn.',
      };
      if (kinds.has('depth')) images.depth = await png(1, 16, mm);
      if (kinds.has('depthVis')) {
        const vis = new Uint8Array(mm.length);
        const span = Math.max(1, hi - lo);
        for (let i = 0; i < mm.length; i++) vis[i] = mm[i] === 0 ? 0 : Math.round(255 * (1 - (mm[i]! - lo) / span));
        images.depthVis = await png(1, 8, vis);
      }
    }
    if (kinds.has('normals')) images.normals = await png(3, 8, rgbOf(draw('normals')));
    if (kinds.has('ids') || kinds.has('instances')) {
      const classPx = draw('classes');
      const instPx = draw('instances');
      if (kinds.has('ids')) images.ids = await png(3, 8, rgbOf(classPx));
      if (kinds.has('instances')) images.instances = await png(3, 8, rgbOf(instPx));
      legend = { classes: buildClassLegend(countColors(classPx)), instances: buildLegend(run.index, countColors(instPx)), unclassified: [...run.unclassified].sort() };
    }
    let edgeSource: string | null = null;
    for (const [kind, structureOnly] of [['edges', true], ['edgesItems', false]] as const) {
      if (!kinds.has(kind)) continue;
      const mm = depthMm(draw('depth', structureOnly));
      const depth = new Float32Array(mm.length);
      for (let i = 0; i < mm.length; i++) depth[i] = mm[i]! / 1000;
      const edges = detectEdges(depth, rgbOf(draw('normals', structureOnly)), width, height, params);
      images[kind] = await png(1, 8, edges);
      edgeSource = 'depth and normal discontinuities only (no colour, no texture); lines are 255 on 0';
    }
    if (kinds.has('color')) images.color = run.color();
    return {
      size: { width, height },
      images,
      camera: cameraJson(camera, width, height, centre),
      depth: depthInfo,
      legend,
      edges: edgeSource ? { ...params, source: edgeSource } : null,
      ms: Math.round(performance.now() - t0),
    };
  } finally {
    run.dispose();
  }
}
