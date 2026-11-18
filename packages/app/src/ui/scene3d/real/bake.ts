/**
 * The textures of the realistic scene (Phase 8), drawn once by the GPU when the scene is made: the
 * asphalt, the ice, the ground beside the road and the ragged edge of an icy zone. Nothing is downloaded and nothing is
 * computed on the main thread: each is one quad drawn with a noise shader into a texture that repeats.
 *
 * A texture holds linear values in half floats: the dark asphalt keeps its detail, and no color space is converted.
 */
import {
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  RepeatWrapping,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
  type IUniform,
  type Texture,
  type WebGLRenderer,
} from 'three';

/** Value noise that repeats every `period` cells, and sums of it over octaves. */
export const NOISE = /* glsl */ `
  float hash(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
  }
  float noise(vec2 p, float period) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(mod(i, period));
    float b = hash(mod(i + vec2(1.0, 0.0), period));
    float c = hash(mod(i + vec2(0.0, 1.0), period));
    float d = hash(mod(i + vec2(1.0, 1.0), period));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  float fbm(vec2 p, float period) {
    float sum = 0.0;
    float amplitude = 0.5;
    for (int octave = 0; octave < 5; octave++) {
      sum += amplitude * noise(p, period);
      p *= 2.0;
      period *= 2.0;
      amplitude *= 0.5;
    }
    return sum;
  }
`;

const VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/** A normal map from a height: `height(uv)` must be defined before it, `texel` is one pixel and `relief` its depth. */
const NORMAL = /* glsl */ `
  uniform vec2 texel;
  uniform float relief;
  void main() {
    float dx = height(vUv - vec2(texel.x, 0.0)) - height(vUv + vec2(texel.x, 0.0));
    float dy = height(vUv - vec2(0.0, texel.y)) - height(vUv + vec2(0.0, texel.y));
    gl_FragColor = vec4(normalize(vec3(dx * relief, dy * relief, 1.0)) * 0.5 + 0.5, 1.0);
  }
`;

// The asphalt: fine aggregate, a few pale stones, and slow changes of tone. One tile is 3 m.
const ASPHALT_HEIGHT = /* glsl */ `
  float height(vec2 uv) {
    return 0.55 * noise(uv * 192.0, 192.0) + 0.3 * noise(uv * 96.0 + 5.0, 96.0) + 0.15 * fbm(uv * 12.0, 12.0);
  }
`;
const ASPHALT = /* glsl */ `
  void main() {
    float grain = noise(vUv * 192.0, 192.0);
    float stones = smoothstep(0.7, 0.92, noise(vUv * 128.0 + 9.0, 128.0));
    float tone = fbm(vUv * 6.0, 6.0);
    vec3 color = vec3(0.046, 0.048, 0.052) * (0.72 + 0.6 * tone) * (0.82 + 0.36 * grain);
    color = mix(color, vec3(0.17, 0.17, 0.16), 0.5 * stones);
    gl_FragColor = vec4(color, 1.0);
  }
`;

// The ice: a pale frosted sheet with the dark road showing through where it is thin. One tile is 4 m.
const ICE_HEIGHT = /* glsl */ `
  float height(vec2 uv) {
    return fbm(uv * 18.0, 18.0) + 0.25 * noise(uv * 90.0, 90.0);
  }
`;
const ICE_THICK = /* glsl */ `
  float thick(vec2 uv) {
    return smoothstep(0.3, 0.62, fbm(uv * 5.0 + 2.0, 5.0));
  }
`;
const ICE = /* glsl */ `
  void main() {
    float frost = fbm(vUv * 24.0 + 4.0, 24.0);
    vec3 road = vec3(0.03, 0.033, 0.038);
    vec3 sheet = vec3(0.46, 0.56, 0.62) * (0.8 + 0.4 * frost);
    gl_FragColor = vec4(mix(road, sheet, 0.25 + 0.75 * thick(vUv)), 1.0);
  }
`;
/** Roughness in the green channel: glassy where the ice is thin, frosted where it is thick. */
const ICE_ROUGHNESS = /* glsl */ `
  void main() {
    float frost = fbm(vUv * 24.0 + 4.0, 24.0);
    float roughness = mix(0.05, 0.42, thick(vUv) * (0.45 + 0.55 * frost));
    gl_FragColor = vec4(0.0, roughness, 0.0, 1.0);
  }
`;

// The ground beside the road: soil and low grass. One tile is 10 m.
const VERGE_HEIGHT = /* glsl */ `
  float height(vec2 uv) {
    return fbm(uv * 48.0, 48.0) + 0.5 * noise(uv * 220.0, 220.0);
  }
`;
const VERGE = /* glsl */ `
  void main() {
    float cover = smoothstep(0.26, 0.42, fbm(patches(vUv), 5.0));
    float blade = noise(vUv * 260.0, 260.0);
    vec3 soil = vec3(0.105, 0.09, 0.063);
    vec3 grass = mix(vec3(0.06, 0.1, 0.038), vec3(0.1, 0.14, 0.054), fbm(vUv * 14.0 + 11.0, 14.0));
    gl_FragColor = vec4(mix(soil, grass, cover) * (0.78 + 0.44 * blade), 1.0);
  }
`;
const VERGE_COVER = /* glsl */ `
  vec2 patches(vec2 uv) {
    return uv * 5.0 + 1.5;
  }
`;

// The edge of an icy zone, `extent` m long and wide: whole inside, ragged within about a meter of its border.
const ZONE_EDGE = /* glsl */ `
  uniform vec2 extent;
  void main() {
    vec2 p = vUv * extent;
    float border = min(min(p.x, extent.x - p.x), min(p.y, extent.y - p.y));
    float ragged = fbm(p * 0.8, 4096.0);
    float inside = smoothstep(0.15, 0.75, border - 0.9 * ragged + 0.25);
    gl_FragColor = vec4(inside, inside, inside, 1.0);
  }
`;

type Uniforms = Record<string, IUniform>;

/** Draws `fragment` over a texture of `width` × `height` pixels that repeats and has its smaller copies. */
function bake(renderer: WebGLRenderer, fragment: string, width: number, height: number, uniforms: Uniforms = {}) {
  const target = new WebGLRenderTarget(width, height, {
    type: HalfFloatType,
    depthBuffer: false,
    generateMipmaps: true,
    minFilter: LinearMipmapLinearFilter,
    magFilter: LinearFilter,
    wrapS: RepeatWrapping,
    wrapT: RepeatWrapping,
    anisotropy: Math.min(8, renderer.capabilities.getMaxAnisotropy()),
  });
  const material = new ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: `varying vec2 vUv;\n${NOISE}\n${fragment}`,
    uniforms,
    depthTest: false,
    depthWrite: false,
  });
  const quad = new Mesh(new PlaneGeometry(2, 2), material);
  const scene = new Scene();
  scene.add(quad);
  const before = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.render(scene, new OrthographicCamera(-1, 1, 1, -1, 0, 1));
  renderer.setRenderTarget(before);
  quad.geometry.dispose();
  material.dispose();
  return target;
}

const relief = (size: number, depth: number): Uniforms => ({
  texel: { value: new Vector2(1 / size, 1 / size) },
  relief: { value: depth },
});

/** A surface's textures; `dispose` frees them. */
export interface SurfaceTextures {
  map: Texture;
  normalMap: Texture;
  roughnessMap?: Texture;
  dispose(): void;
}

function surface(targets: WebGLRenderTarget[], named: Omit<SurfaceTextures, 'dispose'>): SurfaceTextures {
  return { ...named, dispose: () => targets.forEach((target) => target.dispose()) };
}

export function bakeAsphalt(renderer: WebGLRenderer): SurfaceTextures {
  const size = 512;
  const map = bake(renderer, ASPHALT, size, size);
  const normal = bake(renderer, ASPHALT_HEIGHT + NORMAL, size, size, relief(size, 2.2));
  return surface([map, normal], { map: map.texture, normalMap: normal.texture });
}

export function bakeIce(renderer: WebGLRenderer): SurfaceTextures {
  const size = 512;
  const map = bake(renderer, ICE_THICK + ICE, size, size);
  const normal = bake(renderer, ICE_HEIGHT + NORMAL, size, size, relief(size, 0.35));
  const roughness = bake(renderer, ICE_THICK + ICE_ROUGHNESS, size, size);
  return surface([map, normal, roughness], {
    map: map.texture,
    normalMap: normal.texture,
    roughnessMap: roughness.texture,
  });
}

export function bakeVerge(renderer: WebGLRenderer): SurfaceTextures {
  const size = 1024;
  const map = bake(renderer, VERGE_COVER + VERGE, size, size);
  const normal = bake(renderer, VERGE_HEIGHT + NORMAL, size, size, relief(size, 3));
  return surface([map, normal], { map: map.texture, normalMap: normal.texture });
}

/** The edge of a zone `length` m long and `width` m wide, as a mask over the zone (1 inside); the caller frees it. */
export function bakeZoneEdge(renderer: WebGLRenderer, length: number, width: number): WebGLRenderTarget {
  const columns = Math.min(2048, Math.max(64, Math.round(length * 4)));
  const rows = Math.min(256, Math.max(32, Math.round(width * 8)));
  const target = bake(renderer, ZONE_EDGE, columns, rows, { extent: { value: new Vector2(length, width) } });
  // The mask covers its zone once: it does not repeat past its border.
  target.texture.channel = 1;
  return target;
}
