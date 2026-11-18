// The kiwib voxel tables: v3/v4 records and the v5 grid, plus the render material model.
import { fdiv, fmod, i32At, u16At, u32At, uleb, svarint, writeUleb, writeSvarint, pushU16, pushU32, pushI32 } from './bytes.js';

export const MAGIC = [0x6b, 0x69, 0x77, 0x69, 0x62];
const AUTHORED = [21, 18, 54, 55, 56, 24];

export function version(data) {
  if (data.length < 9) return null;
  for (let i = 0; i < 5; i++) if (data[i] !== MAGIC[i]) return null;
  return u32At(data, 5);
}

// v3/v4 records from offset 9, absolute coords. Strict: a truncated record fails.
export function v34Records(data) {
  const c = uleb(data, 9);
  if (c.err) return null;
  let pos = c.pos;
  const out = [];
  for (let k = 0; k < c.value; k++) {
    const x = svarint(data, pos); if (x.err) return null;
    const y = svarint(data, x.pos); if (y.err) return null;
    const z = svarint(data, y.pos); if (z.err) return null;
    pos = z.pos;
    if (pos + 6 > data.length) return null;
    out.push({ x: x.value, y: y.value, z: z.value, ty: u16At(data, pos), b: data[pos + 2], g: data[pos + 3], r: data[pos + 4], w: data[pos + 5] });
    pos += 6;
  }
  return { voxels: out, end: pos };
}

// The v5 tables over the inflated body: header ints, grid-local voxels, end offset.
export function v5Tables(body) {
  if (body.length < 32) return null;
  const h = [];
  for (let k = 0; k < 8; k++) h.push(i32At(body, k * 4));
  const [, , , sx, , sz, count, start] = h;
  if (count < 0) return null;
  const n = count;
  const deltasEnd = 32 + 4 * Math.max(0, n - 1);
  const typesEnd = deltasEnd + 2 * n;
  const end = typesEnd + 4 * n;
  if (end > body.length) return null;
  if (n === 0) return { h, voxels: [], end };
  const plane = sx * sz;
  if (plane === 0 || sx === 0) return null;
  const out = new Array(n);
  let l = start;
  for (let i = 0; i < n; i++) {
    if (i > 0) l += i32At(body, 32 + 4 * (i - 1));
    const rem = fmod(l, plane);
    const c = u32At(body, typesEnd + 4 * i);
    out[i] = { x: fmod(rem, sx), y: fdiv(l, plane), z: fdiv(rem, sx), r: (c >>> 16) & 255, g: (c >>> 8) & 255, b: c & 255, w: c >>> 24, ty: u16At(body, deltasEnd + 2 * i) };
  }
  return { h, voxels: out, end };
}

export function decodeV34(data, ver) {
  const rec = v34Records(data);
  if (!rec || !rec.voxels.length) return null;
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const v of rec.voxels) {
    const c = [v.x, v.y, v.z];
    for (let k = 0; k < 3; k++) { if (c[k] < mn[k]) mn[k] = c[k]; if (c[k] > mx[k]) mx[k] = c[k]; }
  }
  const size = [mx[0] - mn[0] + 1, mx[1] - mn[1] + 1, mx[2] - mn[2] + 1];
  const voxels = rec.voxels.map((v) => ({ ...v, x: v.x - mn[0], y: v.y - mn[1], z: v.z - mn[2] }));
  return { version: ver, size, pos: size.map((s) => -fdiv(s, 2)), voxels, entityStart: rec.end, offset: mn };
}

export function decodeV5(body) {
  if (body.length < 32) return null;
  const sx = i32At(body, 12), sy = i32At(body, 16), sz = i32At(body, 20), count = i32At(body, 24);
  if (count <= 0 || sx <= 0 || sy <= 0 || sz <= 0) return null;
  const t = v5Tables(body);
  if (!t) return null;
  return { version: 5, size: [t.h[3], t.h[4], t.h[5]], pos: [t.h[0], t.h[1], t.h[2]], voxels: t.voxels, entityStart: t.end, offset: [0, 0, 0] };
}

// Render material for a voxel: [r, g, b, kind, level, spec]; kind 0 solid, 1 glass, 2 glow, 3 glow-glass.
export function materialFor(r, g, b, w, t) {
  if (!AUTHORED.includes(t) && Math.max(r, g, b) <= 24) {
    [r, g, b] = ({ 1: [150, 130, 100], 2: [40, 170, 0], 3: [120, 120, 120], 4: [110, 78, 165], 79: [185, 194, 197], 100: [220, 222, 225], 174: [232, 33, 70] })[t] || [110, 110, 110];
  }
  const kind = t === 55 ? 2 : t === 56 ? 3 : t === 18 || t === 54 ? 1 : 0;
  const wc = Math.min(w, 7);
  const level = kind === 1 || kind === 3 ? 16 + 32 * wc : 255;
  return [r, g, b, kind, level, kind === 0 ? wc : 0];
}

// One cell per position: the last voxel's material wins, the first one's slot is kept.
export function renderCells(voxels) {
  const at = new Map();
  const out = [];
  for (const v of voxels) {
    const [r, g, b, kind, level, spec] = materialFor(v.r, v.g, v.b, v.w, v.ty);
    const cell = { x: v.x, y: v.y, z: v.z, r, g, b, kind, level, spec };
    const key = v.x + ',' + v.y + ',' + v.z;
    const i = at.get(key);
    if (i === undefined) { at.set(key, out.length); out.push(cell); } else out[i] = cell;
  }
  return out;
}

const DEFAULT_TYPE = 0x15;

// The uncompressed file (v3/v4) or v5 payload; null where the reference encoder refuses.
export function encodeRaw(voxels, ver, size, pos, offset, entityBlob) {
  if (!voxels.length || ver < 3 || ver > 5) return null;
  const mx = [-Infinity, -Infinity, -Infinity];
  let mn = Infinity;
  for (const v of voxels) {
    if (v.x > mx[0]) mx[0] = v.x; if (v.y > mx[1]) mx[1] = v.y; if (v.z > mx[2]) mx[2] = v.z;
    mn = Math.min(mn, v.x, v.y, v.z);
  }
  const [sx, sy, sz] = size || [mx[0] + 1, mx[1] + 1, mx[2] + 1];
  if (mx[0] >= sx || mx[1] >= sy || mx[2] >= sz || mn < 0) return null;
  const ty = (v) => (v.ty ?? DEFAULT_TYPE) & 0xffff;
  const out = [];
  if (ver !== 5) {
    out.push(...MAGIC);
    pushU32(out, ver);
    writeUleb(out, voxels.length);
    for (const v of voxels) {
      writeSvarint(out, offset[0] + v.x);
      writeSvarint(out, offset[1] + v.y);
      writeSvarint(out, offset[2] + v.z);
      pushU16(out, ty(v));
      out.push(v.b & 255, v.g & 255, v.r & 255, (v.w ?? 0) & 255);
    }
    for (const b of entityBlob) out.push(b);
    return Uint8Array.from(out);
  }
  const p = pos || [-fdiv(sx, 2), 0, -fdiv(sz, 2)];
  const plane = sx * sz;
  const cells = new Map();
  for (const v of voxels) {
    const l = v.x + v.z * sx + v.y * plane;
    const color = ((v.b & 255) | ((v.g & 255) << 8) | ((v.r & 255) << 16) | (((v.w ?? 0) & 255) << 24)) >>> 0;
    cells.set(l, [ty(v), color]);
  }
  const order = [...cells.keys()].sort((a, b) => a - b);
  for (const v of [p[0], p[1], p[2], sx, sy, sz, order.length, order[0]]) if (!pushI32(out, v)) return null;
  for (let i = 1; i < order.length; i++) if (!pushI32(out, order[i] - order[i - 1])) return null;
  for (const l of order) pushU16(out, cells.get(l)[0]);
  for (const l of order) pushU32(out, cells.get(l)[1]);
  for (const b of entityBlob) out.push(b);
  return Uint8Array.from(out);
}
