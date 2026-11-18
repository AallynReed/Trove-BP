// Voxel payload to meshes: only faces that can be seen, one mesh per material, lit by Trove's object shader.

var FACES = [
  [1, 0, 0, 0, 1, 0, 0, 0, 1],
  [-1, 0, 0, 0, 0, 1, 0, 1, 0],
  [0, 1, 0, 0, 0, 1, 1, 0, 0],
  [0, -1, 0, 1, 0, 0, 0, 0, 1],
  [0, 0, 1, 1, 0, 0, 0, 1, 0],
  [0, 0, -1, 0, 1, 0, 1, 0, 0]
];

// Past this many cells the bounding box is mostly air, so index by key instead.
var MAX_CELLS = 16 << 20;

function isOpaque(kind) { return kind === 0 || kind === 2; }

var BRDF_MAP = { value: null };
var _brdfWaiters = [];

// A neutral white sun; the game feeds these per biome and time of day.
var SUN = 0.66, SUN_SPEC = 0.85, AMBIENT = 0.36;
var FALLBACK_DIR = [0.7, 1.0, 0.55];
var LIGHT = null;
var HOST_DIR = null;
var CTL = null;

function ensureLight(THREE) {
  if (LIGHT) return LIGHT;
  LIGHT = {
    kBrdfMap: BRDF_MAP,
    kSun: { value: new THREE.Vector3(SUN, SUN, SUN) },
    kSunSpec: { value: new THREE.Vector3(SUN_SPEC, SUN_SPEC, SUN_SPEC) },
    kAmbient: { value: new THREE.Vector3(AMBIENT, AMBIENT, AMBIENT) },
    kSunDir: { value: new THREE.Vector3().fromArray(FALLBACK_DIR).normalize() },
  };
  return LIGHT;
}

function setLighting(THREE, opts) {
  var L = ensureLight(THREE);
  if (opts.lightDir && !HOST_DIR) HOST_DIR = [opts.lightDir[0], opts.lightDir[1], opts.lightDir[2]];
  if (CTL) return applyControl(THREE);
  if (opts.lightDir) L.kSunDir.value.fromArray(opts.lightDir).normalize();
  if (opts.sun) L.kSun.value.fromArray(opts.sun);
  if (opts.specular) L.kSunSpec.value.fromArray(opts.specular);
  if (opts.ambient) L.kAmbient.value.fromArray(opts.ambient);
}

function setLightControl(THREE, ctl) {
  CTL = ctl ? { intensity: ctl.intensity, azimuth: ctl.azimuth, elevation: ctl.elevation } : null;
  if (CTL) return applyControl(THREE);
  var L = ensureLight(THREE);
  L.kSun.value.setScalar(SUN);
  L.kSunSpec.value.setScalar(SUN_SPEC);
  L.kAmbient.value.setScalar(AMBIENT);
  L.kSunDir.value.fromArray(HOST_DIR || FALLBACK_DIR).normalize();
}

function applyControl(THREE) {
  var L = ensureLight(THREE), t = Math.max(0, Math.min(1, CTL.intensity));
  L.kSun.value.setScalar(SUN * t);
  L.kSunSpec.value.setScalar(SUN_SPEC * t);
  L.kAmbient.value.setScalar(AMBIENT + SUN * (1 - t));
  var e = CTL.elevation * Math.PI / 180, a = CTL.azimuth * Math.PI / 180;

  L.kSunDir.value.set(Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a));
}

function sunDirection(THREE) {
  return ensureLight(THREE).kSunDir.value.toArray();
}

function lightControlDefaults() {
  var d = HOST_DIR || FALLBACK_DIR, DEG = 180 / Math.PI;
  var len = Math.hypot(d[0], d[1], d[2]) || 1;
  return {
    intensity: 1,
    azimuth: (Math.round(Math.atan2(d[0], d[2]) * DEG) + 360) % 360,
    elevation: Math.round(Math.asin(d[1] / len) * DEG),
  };
}

var VERT = [
  'attribute vec3 color;',
  'varying vec3 vCol;',
  'varying vec3 vNor;',
  'varying vec3 vEye;',
  'void main() {',
  '  vCol = color;',
  '  vNor = normalize(normalMatrix * normal);',
  '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
  '  vEye = -mv.xyz;',
  '  gl_Position = projectionMatrix * mv;',
  '}'
].join('\n');

// Trove's terrain.fragment lighting: wrapped diffuse, a baked specular lobe from the atlas, ambient.
var FRAG = [
  'uniform sampler2D kBrdfMap;',
  'uniform vec3 kSun;',
  'uniform vec3 kSunSpec;',
  'uniform vec3 kAmbient;',
  'uniform vec3 kSunDir;',
  'uniform float kTile;',
  'uniform float kGlow;',
  'uniform float kOpacity;',
  'varying vec3 vCol;',
  'varying vec3 vNor;',
  'varying vec3 vEye;',
  '',

  'vec3 kBrdf(vec3 N, vec3 L, vec3 E) {',
  '  float sel = floor(kTile + 0.01);',
  '  float bias = kTile - sel;',
  '  vec2 cell = vec2(mod(sel, 4.0), step((kTile + 0.01) / 4.0, 1.0));',
  '  vec3 H = normalize(E + L);',
  '  vec2 tx;',
  '  tx.x = clamp((dot(N, H) / (1.0 - bias)) - bias / (1.0 - bias), 0.0078125, 0.9921875);',
  '  tx.y = clamp(dot(L, H), 0.00390625, 0.99609375);',
  '  return texture2D(kBrdfMap, (cell + tx) * vec2(0.25, 0.5)).rgb',
  '         * clamp(dot(N, L) * 2.0 + 1.0, 0.0, 1.0) * 1.5;',
  '}',
  '',
  'void main() {',
  '  vec3 N = normalize(vNor);',
  '  vec3 E = normalize(vEye);',
  '  vec3 L = normalize((viewMatrix * vec4(kSunDir, 0.0)).xyz);',
  '  vec3 spec = kBrdf(N, L, E) * kSunSpec;',
  '  vec3 lighting = kSun * pow(max(dot(N, L) * 0.7 + 0.3, 0.0), 0.65) + spec + kAmbient;',
  '  vec3 lit = vCol * mix(lighting, vec3(1.2), kGlow);',

  '  gl_FragColor = vec4(lit, max(max(spec.r, spec.g), max(kOpacity, spec.b)));',
  '}'
].join('\n');

// The specular atlas (the game's brdfmap.dds) as RGBA bytes; until set, highlights read black.
function setBrdfMap(THREE, width, height, rgba) {
  var tex = new THREE.DataTexture(rgba, width, height, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  if (BRDF_MAP.value) BRDF_MAP.value.dispose();
  BRDF_MAP.value = tex;
  _brdfWaiters.forEach(function (fn) { fn(); });
}

function hasBrdfMap() { return !!BRDF_MAP.value; }

// Glass opacity is (level / 255)^2; glow is the shader's own glow term.
function makeMaterial(THREE, kind, level, spec) {
  var L = ensureLight(THREE), glass = (kind === 1 || kind === 3);
  return new THREE.ShaderMaterial({
    uniforms: {
      kBrdfMap: L.kBrdfMap, kSun: L.kSun, kSunSpec: L.kSunSpec,
      kAmbient: L.kAmbient, kSunDir: L.kSunDir,
      kTile: { value: kind === 0 ? (spec || 0) : 0 },
      kGlow: { value: (kind === 2 || kind === 3) ? 1 : 0 },
      kOpacity: { value: glass ? Math.pow((level || 255) / 255, 2) : 1 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: glass,
    depthWrite: !glass,
  });
}

// Which voxel sits at each cell, so a face can ask its neighbour's kind.
function occupancy(X, Y, Z, n) {
  var minX = Infinity, minY = Infinity, minZ = Infinity;
  var maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity, i;
  for (i = 0; i < n; i++) {
    if (X[i] < minX) minX = X[i]; if (X[i] > maxX) maxX = X[i];
    if (Y[i] < minY) minY = Y[i]; if (Y[i] > maxY) maxY = Y[i];
    if (Z[i] < minZ) minZ = Z[i]; if (Z[i] > maxZ) maxZ = Z[i];
  }
  var w = maxX - minX + 3, h = maxY - minY + 3, d = maxZ - minZ + 3;
  if (n && w * h * d <= MAX_CELLS) {
    var grid = new Int32Array(w * h * d), hd = h * d;
    for (i = 0; i < n; i++) grid[(X[i] - minX + 1) * hd + (Y[i] - minY + 1) * d + (Z[i] - minZ + 1)] = i + 1;
    return function (x, y, z) {
      x -= minX; y -= minY; z -= minZ;
      if (x < -1 || y < -1 || z < -1 || x > w - 2 || y > h - 2 || z > d - 2) return 0;
      return grid[(x + 1) * hd + (y + 1) * d + (z + 1)];
    };
  }
  var map = new Map();
  for (i = 0; i < n; i++) map.set(X[i] + ',' + Y[i] + ',' + Z[i], i + 1);
  return function (x, y, z) { return map.get(x + ',' + y + ',' + z) || 0; };
}

function build(THREE, part, opts) {
  var X = part.x, Y = part.y, Z = part.z, RGB = part.rgb;
  var KIND = part.kind, LVL = part.level, SPEC = part.spec;
  var n = X ? X.length : 0;
  if (!n) return [];

  opts = opts || {};
  setLighting(THREE, opts);
  if (opts.onReady) { _brdfWaiters.push(opts.onReady); if (_brdfWaiters.length > 8) _brdfWaiters.shift(); }

  var at = occupancy(X, Y, Z, n);
  var kindOf = function (i) { return KIND ? (KIND[i] || 0) : 0; };
  var groupOf = function (i, k) {
    return k + ':' + ((k === 1 || k === 3) ? (LVL ? LVL[i] : 255) : 255)
             + ':' + (k === 0 && SPEC ? (SPEC[i] || 0) : 0);
  };

  var mask = new Uint8Array(n), counts = {}, i, f;
  for (i = 0; i < n; i++) {
    var k = kindOf(i), opaque = isOpaque(k), bits = 0, drawn = 0;
    for (f = 0; f < 6; f++) {
      var F = FACES[f], nb = at(X[i] + F[0], Y[i] + F[1], Z[i] + F[2]);
      // Draw a face with nothing beside it, or an opaque face beside glass; glass never draws against a neighbour.
      var draw = nb === 0 ? true : (opaque && !isOpaque(kindOf(nb - 1)));
      if (draw) { bits |= 1 << f; drawn++; }
    }
    mask[i] = bits;
    if (drawn) { var g = groupOf(i, k); counts[g] = (counts[g] || 0) + drawn; }
  }

  var buffers = {};
  Object.keys(counts).forEach(function (g) {
    var q = counts[g];
    buffers[g] = { pos: new Float32Array(q * 12), nor: new Float32Array(q * 12),
                   col: new Float32Array(q * 12), idx: new Uint32Array(q * 6), v: 0, t: 0 };
  });

  for (i = 0; i < n; i++) {
    if (!mask[i]) continue;
    var b = buffers[groupOf(i, kindOf(i))];
    var c = RGB ? RGB[i] : 0xffffff;
    var cr = ((c >> 16) & 255) / 255, cg = ((c >> 8) & 255) / 255, cb = (c & 255) / 255;
    var x = X[i], y = Y[i], z = Z[i];
    for (f = 0; f < 6; f++) {
      if (!(mask[i] & (1 << f))) continue;
      F = FACES[f];
      var fx = x + F[0] * 0.5, fy = y + F[1] * 0.5, fz = z + F[2] * 0.5;
      var ux = F[3] * 0.5, uy = F[4] * 0.5, uz = F[5] * 0.5;
      var vx = F[6] * 0.5, vy = F[7] * 0.5, vz = F[8] * 0.5;
      var base = b.v / 3, p = b.v;

      b.pos[p] = fx - ux - vx; b.pos[p + 1] = fy - uy - vy; b.pos[p + 2] = fz - uz - vz;
      b.pos[p + 3] = fx + ux - vx; b.pos[p + 4] = fy + uy - vy; b.pos[p + 5] = fz + uz - vz;
      b.pos[p + 6] = fx + ux + vx; b.pos[p + 7] = fy + uy + vy; b.pos[p + 8] = fz + uz + vz;
      b.pos[p + 9] = fx - ux + vx; b.pos[p + 10] = fy - uy + vy; b.pos[p + 11] = fz - uz + vz;
      for (var j = 0; j < 4; j++) {
        b.nor[p + j * 3] = F[0]; b.nor[p + j * 3 + 1] = F[1]; b.nor[p + j * 3 + 2] = F[2];
        b.col[p + j * 3] = cr; b.col[p + j * 3 + 1] = cg; b.col[p + j * 3 + 2] = cb;
      }
      b.v += 12;
      b.idx[b.t] = base; b.idx[b.t + 1] = base + 1; b.idx[b.t + 2] = base + 2;
      b.idx[b.t + 3] = base; b.idx[b.t + 4] = base + 2; b.idx[b.t + 5] = base + 3;
      b.t += 6;
    }
  }

  return Object.keys(buffers).map(function (g) {
    var b = buffers[g], kv = g.split(':'), k = +kv[0], lv = +kv[1], sp = +kv[2];
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(b.pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(b.nor, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(b.col, 3));
    geo.setIndex(new THREE.BufferAttribute(b.idx, 1));
    geo.computeBoundingSphere();
    var mesh = new THREE.Mesh(geo, makeMaterial(THREE, k, lv, sp));
    if (k === 1 || k === 3) mesh.renderOrder = 1;
    return mesh;
  });
}

export var VoxelMesh = {
  build: build, makeMaterial: makeMaterial, setLighting: setLighting, setBrdfMap: setBrdfMap, hasBrdfMap: hasBrdfMap,
  setLightControl: setLightControl, lightControlDefaults: lightControlDefaults,
  sunDirection: sunDirection,
};
