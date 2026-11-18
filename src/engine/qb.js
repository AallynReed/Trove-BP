// Qubicle Binary (.qb) with Trove's _a / _s / _t material maps.
import { Fault, commas, fault, fdiv, fmod, pushU32 } from './bytes.js';
import { EMPTY_ENTITIES, attachment, encode } from './codec.js';
import { materialFor } from './format.js';
import { alphaForW, classOf, describe, isProcedural } from './materials.js';

const QB_VERSION = 257, CODEFLAG = 2, NEXTSLICEFLAG = 6;
export const ATTACHMENT_RGB = [255, 0, 255];
const MAX_MAPPED_SPECULAR = 4;
const VALID_ALPHA = [16, 48, 80, 112, 144, 176, 208, 240, 255];
const TYPES = [21, 18, 54, 55, 56];
const TYPE_RGB = [[255, 255, 255], [128, 128, 128], [64, 64, 64], [255, 0, 0], [255, 255, 0]];
const SPEC_RGB = [[128, 0, 0], [0, 128, 0], [0, 0, 128], [128, 128, 0], [128, 0, 128]];

export const typeIndex = (t) => (TYPES.includes(t) ? TYPES.indexOf(t) : null);
export const typeRgb = (i) => TYPE_RGB[i] || null;
export const specularRgb = (w) => SPEC_RGB[w] || null;

const qbErr = fault('qb');
const same = (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
const key = (x, y, z) => x + ',' + y + ',' + z;

// Insertion-ordered cells, last value wins.
class Cells {
  constructor() { this.map = new Map(); }
  set(c, rgb) {
    const k = key(c[0], c[1], c[2]);
    const e = this.map.get(k);
    if (e) e.rgb = rgb; else this.map.set(k, { c, rgb });
  }
  get(c) { const e = this.map.get(key(c[0], c[1], c[2])); return e ? e.rgb : null; }
  get size() { return this.map.size; }
  items() { return [...this.map.values()]; }
}

function u32(d, off) {
  if (off + 4 > d.length) throw new Fault('unhandled', 'unpack_from requires a buffer');
  return (d[off] | (d[off + 1] << 8) | (d[off + 2] << 16) | (d[off + 3] << 24)) >>> 0;
}

export function read(data) {
  if (data.length < 24) throw qbErr('That file is too short to be a .qb.');
  const h = [0, 1, 2, 3, 4, 5].map((k) => u32(data, k * 4));
  const [, colourFormat, zOrientation, compression, , count] = h;
  if (count === 0 || count > 512) throw qbErr('That .qb declares an implausible number of matrices.');
  const out = [];
  let off = 24;
  for (let m = 0; m < count; m++) {
    if (off >= data.length) throw qbErr('That .qb is truncated.');
    off += 1 + data[off];
    const sx = u32(data, off), sy = u32(data, off + 4), sz = u32(data, off + 8);
    off += 12;
    const pos = [u32(data, off) | 0, u32(data, off + 4) | 0, u32(data, off + 8) | 0];
    off += 12;
    if (sx * sy * sz > 64_000_000) throw qbErr('That .qb declares an implausibly large matrix.');
    let cells = new Cells();
    if (compression === 0) {
      const need = 4 * sx * sy * sz;
      if (off + need > data.length) throw qbErr('That .qb is truncated.');
      for (let z = 0; z < sz; z++) {
        for (let y = 0; y < sy; y++) {
          const base = off + 4 * (z * sy * sx + y * sx);
          for (let x = 0; x < sx; x++) {
            const i = base + 4 * x;
            if (data[i + 3] > 0) cells.set([x, y, z], [data[i], data[i + 1], data[i + 2]]);
          }
        }
      }
      off += need;
    } else {
      off = readRle(data, off, sx, sz, cells);
    }
    if (colourFormat === 1) for (const e of cells.items()) e.rgb = [e.rgb[2], e.rgb[1], e.rgb[0]];
    if (zOrientation === 0) {
      const flipped = new Cells();
      for (const { c, rgb } of cells.items()) flipped.set([c[0], c[1], sz - 1 - c[2]], rgb);
      cells = flipped;
    }
    out.push({ size: [sx, sy, sz], pos, cells });
  }
  return out;
}

function readRle(data, off, sx, sz, cells) {
  const place = (index, z) => {
    if (sx === 0) throw new Fault('unhandled', 'integer modulo by zero');
    return [fmod(index, sx), fdiv(index, sx), z];
  };
  for (let z = 0; z < sz; z++) {
    let index = 0;
    for (;;) {
      if (off + 4 > data.length) throw qbErr('That .qb is truncated.');
      const chunk = u32(data, off);
      off += 4;
      if (chunk === NEXTSLICEFLAG) break;
      if (chunk === CODEFLAG) {
        if (off + 8 > data.length) throw qbErr('That .qb is truncated.');
        const run = u32(data, off);
        const rgb = [data[off + 4], data[off + 5], data[off + 6]], a = data[off + 7];
        off += 8;
        if (a > 0) for (let k = 0; k < run; k++) cells.set(place(index++, z), rgb);
        else index += run;
      } else {
        if (chunk >>> 24 > 0) cells.set(place(index, z), [chunk & 255, (chunk >>> 8) & 255, (chunk >>> 16) & 255]);
        index++;
      }
    }
  }
  return off;
}

function merge(ms) {
  if (!ms.length) throw qbErr('That .qb has no matrices.');
  if (ms.length === 1) return [ms[0].cells, ms[0].size, ms[0].pos];
  const mn = [0, 1, 2].map((k) => Math.min(...ms.map((m) => m.pos[k])));
  const cells = new Cells();
  for (const m of ms) {
    const o = [0, 1, 2].map((k) => m.pos[k] - mn[k]);
    for (const { c, rgb } of m.cells.items()) cells.set([c[0] + o[0], c[1] + o[1], c[2] + o[2]], rgb);
  }
  if (!cells.size) throw new Fault('unhandled', 'max() arg is an empty sequence');
  const items = cells.items();
  const size = [0, 1, 2].map((k) => items.reduce((mx, e) => Math.max(mx, e.c[k]), -Infinity) + 1);
  return [cells, size, ms[0].pos];
}

// One RLE matrix; `cells` is a Map "x,y,z" -> rgb.
export function write(cells, [sx, sy, sz], name, pos) {
  const out = [];
  for (const v of [QB_VERSION, 0, 1, 1, 0, 1]) pushU32(out, v);
  const stem = [...name].map((c) => (c.codePointAt(0) <= 255 ? c.codePointAt(0) : 63)).slice(0, 255);
  out.push(stem.length, ...stem);
  for (const v of [sx, sy, sz]) pushU32(out, v >>> 0);
  for (const v of pos) pushU32(out, v | 0);
  const flush = (val, len) => {
    if (!len) return;
    if (len > 1) { pushU32(out, CODEFLAG); pushU32(out, len); }
    if (val) out.push(val[0], val[1], val[2], 255); else out.push(0, 0, 0, 0);
  };
  for (let z = 0; z < sz; z++) {
    let runVal = null, runLen = 0;
    for (let y = 0; y < sy; y++) {
      for (let x = 0; x < sx; x++) {
        const v = cells.get(key(x, y, z)) || null;
        if (v === runVal || (v && runVal && same(v, runVal))) runLen++;
        else { flush(runVal, runLen); runVal = v; runLen = 1; }
      }
    }
    flush(runVal, runLen);
    pushU32(out, NEXTSLICEFLAG);
  }
  return Uint8Array.from(out);
}

// The four authoring files (base, _a, _s, _t) for a decoded blueprint.
export function fromBlueprint(doc, stem) {
  const attach = attachment(doc);
  let mn = [0, 0, 0];
  let [sx, sy, sz] = doc.size;
  if (attach) {
    mn = attach.map((a) => Math.min(a, 0));
    sx = Math.max(sx, attach[0] + 1) - mn[0];
    sy = Math.max(sy, attach[1] + 1) - mn[1];
    sz = Math.max(sz, attach[2] + 1) - mn[2];
  }
  const qx = (x) => sx - 1 - (x - mn[0]);
  const maps = [new Map(), new Map(), new Map(), new Map()];
  let droppedSpec = 0;
  const unmapped = new Map();
  const rough = specularRgb(0);
  for (const v of doc.voxels) {
    const k = key(qx(v.x), v.y - mn[1], v.z - mn[2]);
    const t = v.ty, w = v.w;
    let rgb = [v.r, v.g, v.b];
    if (isProcedural(t, v.r, v.g, v.b)) rgb = materialFor(v.r, v.g, v.b, v.w, t).slice(0, 3);
    maps[0].set(k, rgb);
    let index = typeIndex(t);
    if (index === null) { unmapped.set(t, (unmapped.get(t) || 0) + 1); index = 0; }
    maps[3].set(k, typeRgb(index) || [255, 255, 255]);
    if (classOf(t) === 'glass') {
      const level = alphaForW(w);
      maps[1].set(k, [level, level, level]);
      maps[2].set(k, rough);
    } else {
      maps[1].set(k, [255, 255, 255]);
      if (w > MAX_MAPPED_SPECULAR) { droppedSpec++; maps[2].set(k, rough); } else maps[2].set(k, specularRgb(w) || rough);
    }
  }
  let akey = [0, 0, 0], pos = [0, 0, 0];
  if (attach) {
    akey = [qx(attach[0]), attach[1] - mn[1], attach[2] - mn[2]];
    for (const m of maps) m.set(key(...akey), ATTACHMENT_RGB);
    pos = [-akey[0], -akey[1], -akey[2]];
  }
  const size = [sx, sy, sz];
  const names = [stem, `${stem}_a`, `${stem}_s`, `${stem}_t`];
  const files = names.map((n, i) => [`${n}.qb`, write(maps[i], size, n, pos)]);

  const notes = [];
  if (attach) notes.push(`The attachment point is written as a magenta voxel at (${akey[0]}, ${akey[1]}, ${akey[2]}) in all four files.`);
  else if (doc.version !== 5) {
    notes.push(`This is a v${doc.version} blueprint, which stores no attachment point, so none was written. Add a magenta (255, 0, 255) voxel where the model should be held before compiling it back.`);
  }
  if (droppedSpec > 0) {
    notes.push(`${commas(droppedSpec)} solid voxel${droppedSpec !== 1 ? 's' : ''} use a specular finish beyond the five the material maps can express, and were written as rough. Re-importing this .qb will not bring them back.`);
  }
  if (unmapped.size) {
    const total = [...unmapped.values()].reduce((a, b) => a + b, 0);
    const types = [...unmapped.keys()].sort((a, b) => a - b);
    notes.push(`${commas(total)} voxel${total !== 1 ? 's' : ''} use materials the game keeps to itself (${types.slice(0, 3).map((t) => describe(t, 0)).join(', ')}) and were written as plain solid. The .blueprint you exported from still has them.`);
  }
  return { files, notes, attachment: attach, size };
}

function classify(files) {
  const out = {};
  for (const [name, data] of files) {
    let stem = name.split('/').pop();
    if (stem.toLowerCase().endsWith('.qb')) stem = [...stem].slice(0, -3).join('');
    const low = stem.toLowerCase();
    const k = low.endsWith('_a') ? 'a' : low.endsWith('_s') ? 's' : low.endsWith('_t') ? 't' : null;
    if (!k) { if (!out.base) out.base = data; continue; }
    out[k] = data;
  }
  if (!out.base) throw qbErr('No base .qb was found - the model file must not end in _a, _s or _t.');
  return out;
}

// [name, bytes][] -> [v5 blueprint bytes, summary].
export async function toBlueprint(files) {
  const parts = classify(files);
  const base = read(parts.base);
  const single = base.length === 1;
  const [cells, size, basePos] = merge(base);
  if (!cells.size) throw qbErr('That .qb has no visible voxels.');
  const maps = {};
  for (const k of ['a', 's', 't']) {
    if (!parts[k]) continue;
    const [m, msize] = merge(read(parts[k]));
    if (msize[0] !== size[0] || msize[1] !== size[1] || msize[2] !== size[2]) {
      throw qbErr(`The ${k.toUpperCase()} map is ${msize.join('x')} but the model is ${size.join('x')}. Material maps have to match the model exactly.`);
    }
    maps[k] = m;
  }
  const items = cells.items();
  const marker = items.find((e) => same(e.rgb, ATTACHMENT_RGB));
  let attach = marker ? marker.c : null;
  const fromMarker = !!attach;
  if (!attach && single) {
    const [dx, dy, dz] = basePos;
    if (dx <= 0 && dy <= 0 && dz <= 0 && (dx || dy || dz) && -dx < size[0] && -dy < size[1] && -dz < size[2]) attach = [-dx, -dy, -dz];
  }
  let filledMarker = null;
  if (attach) {
    const [ax, ay, az] = attach;
    filledMarker = [[ax + 1, ay, az], [ax - 1, ay, az], [ax, ay + 1, az], [ax, ay - 1, az], [ax, ay, az + 1], [ax, ay, az - 1]]
      .find((c) => { const v = cells.get(c); return v && !same(v, ATTACHMENT_RGB); }) || null;
  }
  const sorted = items.slice().sort((a, b) => a.c[2] - b.c[2] || a.c[1] - b.c[1] || a.c[0] - b.c[0]);
  let unknownAlpha = 0, unknownType = 0, unknownSpec = 0;
  const voxels = [];
  for (const { c, rgb: rgb0 } of sorted) {
    let rgb = rgb0, src = c;
    if (same(rgb, ATTACHMENT_RGB)) {
      if (filledMarker && same(src, attach)) { rgb = cells.get(filledMarker) || rgb; src = filledMarker; } else continue;
    }
    let index = 0;
    const tc = maps.t && maps.t.get(src);
    if (tc && !same(tc, ATTACHMENT_RGB)) {
      const i = TYPE_RGB.findIndex((r) => same(r, tc));
      if (i >= 0) index = i; else unknownType++;
    }
    const ty = TYPES[index];
    let w = 0;
    if (classOf(ty) === 'glass') {
      const ac = maps.a && maps.a.get(src);
      if (ac && !same(ac, ATTACHMENT_RGB)) {
        if (ac[0] === ac[1] && ac[1] === ac[2] && VALID_ALPHA.includes(ac[0])) w = ac[0] === 255 ? 0 : Math.max(0, Math.min(7, fdiv(ac[0] - 16, 32)));
        else { unknownAlpha++; w = 3; }
      }
    } else {
      const sc = maps.s && maps.s.get(src);
      if (sc && !same(sc, ATTACHMENT_RGB) && !same(sc, [255, 255, 255])) {
        const i = SPEC_RGB.findIndex((r) => same(r, sc));
        if (i >= 0) w = i; else unknownSpec++;
      }
    }
    voxels.push({ x: c[0], y: c[1], z: c[2], r: rgb[0], g: rgb[1], b: rgb[2], w, ty });
  }
  if (!voxels.length) throw qbErr("That .qb is only an attachment point - there's no model to compile.");
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const v of voxels) {
    [v.x, v.y, v.z].forEach((c, k) => { lo[k] = Math.min(lo[k], c); hi[k] = Math.max(hi[k], c); });
  }
  const tight = [0, 1, 2].map((k) => hi[k] - lo[k] + 1);
  for (const v of voxels) { v.x = tight[0] - 1 - (v.x - lo[0]); v.y -= lo[1]; v.z -= lo[2]; }
  const pos = attach ? [-(tight[0] - 1 - (attach[0] - lo[0])), -(attach[1] - lo[1]), -(attach[2] - lo[2])] : [-fdiv(tight[0], 2), 0, -fdiv(tight[2], 2)];
  const data = await encode(voxels, 5, pos, EMPTY_ENTITIES, [0, 0, 0], tight);
  return [data, {
    voxels: voxels.length,
    size: tight,
    attachment: attach ? [attach[0] - lo[0], attach[1] - lo[1], attach[2] - lo[2]] : null,
    attachment_source: fromMarker ? 'marker' : attach ? 'offset' : null,
    maps: Object.keys(maps).sort(),
    unknown_type: unknownType,
    unknown_alpha: unknownAlpha,
    unknown_specular: unknownSpec,
  }];
}
