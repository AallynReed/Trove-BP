// The Blueprint Editor engine: inspect, apply edits, flatten layers, transform, .qb export/import, checks.
import { Fault, commas, fault } from './bytes.js';
import { attachment, decode, encode, encodeDoc, entityCount, isEmpty } from './codec.js';
import { materialFor } from './format.js';
import * as lint from './lint.js';
import * as materials from './materials.js';
import { ALIGN_MODES, flatten } from './merge.js';
import * as qb from './qb.js';
import * as transform from './transform.js';

export const EDITOR_VOXEL_CAP = 150_000;
export const MAX_BLUEPRINT_BYTES = 4 * 1024 * 1024;
export const MAX_QB_BYTES = 48 * 1024 * 1024;
export const MAX_ADDED_VOXELS = 20_000;
export const COORD_LIMIT = 4096;
export const MAX_LAYERS = 8;

const ed = fault('editor');

// Errors from the format layers surface as editor messages; anything else stays unhandled.
async function wrap(kinds, fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Fault && kinds.includes(e.kind)) throw ed(e.message);
    throw e;
  }
}

// Python int() for a JSON value; null where it raises.
function int(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === 'string' && /^\s*[+-]?\d+(_\d+)*\s*$/.test(v)) return parseInt(v.replace(/_/g, ''), 10);
  return null;
}

function truthy(v) {
  if (v === null || v === undefined) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return !!v;
}

export async function decodeOrRaise(raw) {
  if (raw.length > MAX_BLUEPRINT_BYTES) throw ed('That file is too large to be a Trove blueprint.');
  if (await isEmpty(raw)) throw ed("This blueprint is an empty placeholder - there's nothing to edit.");
  return wrap(['blueprint'], () => decode(raw));
}

export async function inspect(raw, name) {
  const doc = await decodeOrRaise(raw);
  const n = doc.voxels.length;
  if (n > EDITOR_VOXEL_CAP) {
    throw ed(`This model has ${commas(n)} voxels, past the editor's ${commas(EDITOR_VOXEL_CAP)} limit. It can still be viewed in 3D.`);
  }
  const cols = { x: [], y: [], z: [], rgb: [], kind: [], level: [], spec: [], type: [], w: [], edit: [], paint: [] };
  let procedural = 0, placeholders = 0, locked = 0;
  const seen = new Map();
  for (const v of doc.voxels) {
    const [r, g, b, kind, level, spec] = materialFor(v.r, v.g, v.b, v.w, v.ty);
    const editable = materials.isEditable(v.ty);
    const proc = materials.isProcedural(v.ty, v.r, v.g, v.b);
    cols.x.push(v.x); cols.y.push(v.y); cols.z.push(v.z);
    cols.rgb.push((r << 16) | (g << 8) | b);
    cols.kind.push(kind); cols.level.push(level); cols.spec.push(spec);
    cols.type.push(v.ty); cols.w.push(v.w);
    cols.edit.push(editable ? 1 : 0); cols.paint.push(proc ? 0 : 1);
    if (!editable) locked++;
    if (v.ty === materials.PLACEHOLDER_TYPE) placeholders++;
    if (proc) procedural++;
    const k = v.ty + ':' + v.w;
    const e = seen.get(k);
    if (e) e.count++; else seen.set(k, { type: v.ty, w: v.w, count: 1 });
  }
  const mats = [...seen.values()].sort((a, b) => b.count - a.count).map(({ type, w, count }) => ({
    type, w, count, label: materials.describe(type, w), editable: materials.isEditable(type),
  }));
  return {
    name,
    count: n,
    size: doc.size,
    version: doc.version,
    attachment: attachment(doc),
    origin: doc.version === 5 ? doc.pos : doc.offset,
    creation_types: lint.creationTypes(),
    transforms: transform.OPERATIONS.map(([op, label]) => ({ op, label })),
    align_modes: ALIGN_MODES.map(([mode, label]) => ({ mode, label })),
    ...cols,
    materials: mats,
    stats: { voxels: n, locked, procedural, placeholders, entities: entityCount(doc.entity) },
    palette: materials.palette(),
  };
}

function materialOf(entry) {
  const need = () => ed('A material edit needs both a type and a w.');
  if (!('type' in entry)) throw need();
  const t = int(entry.type), w = 'w' in entry ? int(entry.w) : null;
  if (t === null || w === null) throw need();
  try {
    return materials.validate(t, w);
  } catch (e) {
    throw ed(e.message);
  }
}

function colourOf(entry) {
  if (!('rgb' in entry)) throw new Fault('unhandled', "KeyError: 'rgb'");
  const p = int(entry.rgb);
  if (p === null || p < 0 || p > 0xffffff) throw ed('An edit has an invalid colour.');
  return p;
}

function coerce(edits, total) {
  if (!Array.isArray(edits)) throw ed("The edit list wasn't understood.");
  if (edits.length > total + MAX_ADDED_VOXELS) throw ed("That's more edits than one save should carry.");
  const changes = new Map(), deletes = new Set(), adds = [];
  for (const entry of edits) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw ed("The edit list wasn't understood.");
    if ('add' in entry) {
      const coords = entry.add;
      if (!Array.isArray(coords) || coords.length !== 3) throw ed('A new voxel needs an x, y and z.');
      const cell = coords.map((c) => {
        const v = int(c);
        if (v === null) throw ed('A new voxel has invalid coordinates.');
        return v;
      });
      if (!cell.every((c) => c >= -COORD_LIMIT && c <= COORD_LIMIT)) throw ed('A new voxel is outside the buildable area.');
      const material = materialOf(entry);
      adds.push({ cell, rgb: colourOf(entry), material });
      if (adds.length > MAX_ADDED_VOXELS) throw ed(`That's more than ${commas(MAX_ADDED_VOXELS)} new voxels in one save.`);
      continue;
    }
    const idx = 'i' in entry ? int(entry.i) : null;
    if (idx === null) throw ed('An edit is missing its voxel index.');
    if (idx < 0 || idx >= total) throw ed('An edit points outside the blueprint.');
    if (truthy(entry.del)) { deletes.add(idx); continue; }
    const change = { material: null, rgb: null };
    if ('type' in entry || 'w' in entry) change.material = materialOf(entry);
    if ('rgb' in entry) change.rgb = colourOf(entry);
    if (change.material || change.rgb !== null) {
      const slot = changes.get(idx) || { material: null, rgb: null };
      slot.material = change.material || slot.material;
      slot.rgb = change.rgb !== null ? change.rgb : slot.rgb;
      changes.set(idx, slot);
    }
  }
  return { changes, deletes, adds };
}

function reframe(voxels, doc) {
  const ext = (k, f, init) => voxels.reduce((m, v) => f(m, [v.x, v.y, v.z][k]), init);
  const mn = [0, 1, 2].map((k) => Math.min(ext(k, Math.min, Infinity), 0));
  const mx = [0, 1, 2].map((k) => ext(k, Math.max, -Infinity));
  const size = [0, 1, 2].map((k) => Math.max(doc.size[k], mx[k] + 1) - mn[k]);
  const shift = [-mn[0], -mn[1], -mn[2]];
  let entity = doc.entity.slice();
  let attach = attachment(doc);
  if (shift[0] || shift[1] || shift[2]) {
    for (const v of voxels) { v.x += shift[0]; v.y += shift[1]; v.z += shift[2]; }
    if (attach) attach = [attach[0] + shift[0], attach[1] + shift[1], attach[2] + shift[2]];
    entity = transform.translateEntities(entity, shift);
  }
  const [pos, offset] = transform.reorigin(doc, attach, size);
  return { voxels, size, pos, offset, entity };
}

export async function applyEdits(raw, edits) {
  const doc = await decodeOrRaise(raw);
  const { changes, deletes, adds } = coerce(edits, doc.voxels.length);
  const out = [];
  let recoloured = 0, rematerialised = 0, ignored = 0;
  doc.voxels.forEach((v, i) => {
    if (deletes.has(i)) return;
    const change = changes.get(i);
    if (!change) { out.push(v); return; }
    const nv = { ...v };
    if (change.material) {
      if (materials.isEditable(v.ty)) { [nv.ty, nv.w] = change.material; rematerialised++; } else ignored++;
    }
    if (change.rgb !== null) {
      if (materials.isProcedural(v.ty, v.r, v.g, v.b)) ignored++;
      else { nv.r = (change.rgb >> 16) & 255; nv.g = (change.rgb >> 8) & 255; nv.b = change.rgb & 255; recoloured++; }
    }
    out.push(nv);
  });
  if (adds.length) {
    const occupied = new Map(out.map((v, i) => [v.x + ',' + v.y + ',' + v.z, i]));
    for (const a of adds) {
      const nv = { x: a.cell[0], y: a.cell[1], z: a.cell[2], r: (a.rgb >> 16) & 255, g: (a.rgb >> 8) & 255, b: a.rgb & 255, w: a.material[1], ty: a.material[0] };
      const k = a.cell.join(',');
      const i = occupied.get(k);
      if (i !== undefined) out[i] = nv; else { occupied.set(k, out.length); out.push(nv); }
    }
  }
  if (!out.length) throw ed('That would erase the whole model - a blueprint needs at least one voxel.');
  if (out.length > EDITOR_VOXEL_CAP) throw ed(`That would take the model past the editor's ${commas(EDITOR_VOXEL_CAP)} voxel limit.`);
  const f = adds.length || deletes.size
    ? await wrap(['transform'], () => reframe(out.map((v) => ({ ...v })), doc))
    : { voxels: out, size: doc.size, pos: doc.pos, offset: doc.offset, entity: doc.entity.slice() };
  const data = await wrap(['blueprint', 'transform'], () => encode(f.voxels, doc.version, f.pos, f.entity, f.offset, f.size));
  return [data, {
    voxels: f.voxels.length, recoloured, rematerialised, added: adds.length, erased: deletes.size,
    size: f.size, ignored, version: doc.version, bytes: data.length,
  }];
}

export async function transformFile(raw, edits, ops) {
  const [edited] = await composite(raw, edits, [], [], 0);
  const doc = await decode(edited);
  const [moved, data] = await wrap(['transform', 'blueprint'], async () => {
    const m = transform.apply(doc, ops);
    return [m, await encodeDoc(m)];
  });
  return [data, { applied: ops, size_before: doc.size, size_after: moved.size, attachment: attachment(moved), entities: entityCount(moved.entity) }];
}

function layerSpecs(specs, count) {
  if (!Array.isArray(specs) || specs.length !== count) throw ed("The layer list didn't match the files that arrived.");
  if (count > MAX_LAYERS) throw ed(`That's more than ${MAX_LAYERS} layers in one stack.`);
  return specs.map((spec) => {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw ed("A layer's placement wasn't understood.");
    const mode = truthy(spec.mode) ? String(spec.mode) : 'attachment';
    const bad = () => ed('A layer has an invalid offset.');
    let offset = [0, 0, 0];
    if (truthy(spec.offset)) {
      if (!Array.isArray(spec.offset)) throw bad();
      offset = spec.offset.map((v) => { const i = int(v); if (i === null) throw bad(); return i; });
    }
    if (offset.length !== 3 || offset.some((v) => Math.abs(v) > COORD_LIMIT)) throw bad();
    return { mode, offset, edits: truthy(spec.edits) ? spec.edits : [] };
  });
}

// Apply edits to the base, then flatten any extra layers onto it.
export async function composite(raw, edits, layers, specs, anchorAt) {
  const [edited, summary] = await applyEdits(raw, edits);
  if (!layers.length) return [edited, { ...summary, layers: 0 }];
  const placements = layerSpecs(specs, layers.length);
  if (!(anchorAt >= 0 && anchorAt <= layers.length)) throw ed("The anchor layer isn't in the stack.");
  const [data, msum] = await wrap(['merge', 'blueprint'], async () => {
    const stack = [];
    for (let i = 0; i < layers.length; i++) {
      const p = placements[i];
      const painted = truthy(p.edits) ? (await applyEdits(layers[i], p.edits))[0] : layers[i];
      stack.push({ doc: await decodeOrRaise(painted), mode: p.mode, offset: p.offset });
    }
    stack.splice(anchorAt, 0, { doc: await decode(edited), mode: 'corner', offset: [0, 0, 0] });
    const [merged, s] = flatten(stack, anchorAt);
    return [await encodeDoc(merged), s];
  });
  return [data, { ...summary, ...msum }];
}

export async function exportQb(raw, edits, layers, specs, anchorAt, stem) {
  const [edited] = await composite(raw, edits, layers, specs, anchorAt);
  const doc = await wrap(['qb', 'blueprint'], () => decode(edited));
  const built = qb.fromBlueprint(doc, stem);
  return [built.files, { notes: built.notes, attachment: built.attachment, size: built.size, files: built.files.map(([n]) => n).sort() }];
}

export async function importQb(files) {
  const total = files.reduce((n, [, d]) => n + d.length, 0);
  if (total > MAX_QB_BYTES) throw ed('Those .qb files are too large to compile.');
  return wrap(['qb', 'blueprint'], () => qb.toBlueprint(files));
}

export async function checkFile(raw, edits, kind, layers, specs, anchorAt) {
  const [edited] = await composite(raw, edits, layers, specs, anchorAt);
  return lint.check(await decode(edited), kind);
}
