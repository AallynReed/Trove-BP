// Whole .blueprint files in and out: the v5 zlib container, exact error messages, entity records.
import { Fault, fault, fdiv, i32At, u32At, uleb, svarint, writeUleb, writeSvarint, pushU32, concat } from './bytes.js';
import { MAGIC, version, decodeV34, decodeV5, encodeRaw } from './format.js';
import { inflate, deflate } from './zlib.js';

export const EMPTY_ENTITIES = Uint8Array.of(0, 0, 0, 0);
const bp = fault('blueprint');

export async function inflateV5(data) {
  const body = await inflate(data.subarray(9));
  if (!body) throw bp('Failed to inflate v5 blueprint: Error -3 while decompressing data');
  return body;
}

export async function isEmpty(data) {
  const v = version(data);
  if (v === 3 || v === 4) {
    const c = uleb(data, 9);
    return c.err ? true : c.value === 0;
  }
  if (v === 5) {
    const body = await inflate(data.subarray(9));
    return !body || body.length < 28 ? true : i32At(body, 24) <= 0;
  }
  return true;
}

function v34Fault(data) {
  const c = uleb(data, 9);
  if (c.err) return bp(c.err);
  let pos = c.pos;
  for (let k = 0; k < c.value; k++) {
    for (let j = 0; j < 3; j++) {
      const s = svarint(data, pos);
      if (s.err) return bp(s.err);
      pos = s.pos;
    }
    if (pos + 6 > data.length) return bp('v3/v4 voxel record is truncated.');
    pos += 6;
  }
  if (c.value === 0) return bp('Blueprint contains no voxels (empty placeholder).');
  return new Fault('unhandled', 'native v3/v4 decode refused a valid file');
}

// The decoded document: {version, size, pos, voxels, entity, offset}.
export async function decode(data) {
  const v = version(data);
  if (v === null) throw bp("Not a Trove blueprint (missing 'kiwib' magic).");
  if (v === 3 || v === 4) {
    const d = decodeV34(data, v);
    if (!d) throw v34Fault(data);
    return { version: v, size: d.size, pos: d.pos, entity: data.slice(d.entityStart), voxels: d.voxels, offset: d.offset };
  }
  if (v === 5) {
    const body = await inflateV5(data);
    if (body.length < 32) throw bp('v5 blueprint payload is too small.');
    const sx = i32At(body, 12), sy = i32At(body, 16), sz = i32At(body, 20), count = i32At(body, 24);
    if (count <= 0 || sx <= 0 || sy <= 0 || sz <= 0) throw bp('v5 blueprint is empty or has invalid bounds.');
    const d = decodeV5(body);
    if (!d) throw new Fault('unhandled', 'unpack_from requires a buffer of more bytes');
    return { version: 5, size: d.size, pos: d.pos, entity: body.slice(d.entityStart), voxels: d.voxels, offset: d.offset };
  }
  throw bp(`Unsupported kiwib blueprint version: ${v}.`);
}

export function attachment(doc) {
  return doc.version === 5 ? doc.pos.map((p) => 0 - p) : null;
}

// The uncompressed bytes encode() would deflate (v5) or return (v3/v4).
export function encodePayload(voxels, ver, pos, entity, offset, size) {
  const blob = ver === 5 && !entity.length ? EMPTY_ENTITIES : entity;
  const out = encodeRaw(voxels, ver, size, pos, offset, blob);
  if (out) return out;
  if (!voxels.length) throw bp('Cannot encode a blueprint with no voxels.');
  if (ver < 3 || ver > 5) throw bp(`Unsupported encode version: ${ver}.`);
  const [sx, sy, sz] = size || [0, 1, 2].map((k) => Math.max(...voxels.map((v) => [v.x, v.y, v.z][k])) + 1);
  if (voxels.some((v) => v.x >= sx || v.y >= sy || v.z >= sz || Math.min(v.x, v.y, v.z) < 0)) {
    throw bp("A voxel lies outside the blueprint's bounding box.");
  }
  throw new Fault('unhandled', 'argument out of range');
}

export async function encode(voxels, ver, pos, entity, offset, size) {
  const out = encodePayload(voxels, ver, pos, entity, offset, size);
  if (ver !== 5) return out;
  const head = [...MAGIC];
  pushU32(head, 5);
  return concat([Uint8Array.from(head), await deflate(out)]);
}

export function encodeDoc(doc) {
  return encode(doc.voxels, doc.version, doc.pos, doc.entity, doc.offset, doc.size);
}

// Entity records [x, y, z, bytes] and the tail after them; null when unreadable.
export function readEntityRecords(blob) {
  if (blob.length < 4) return { records: [], tail: new Uint8Array(0) };
  const count = u32At(blob, 0);
  const records = [];
  let i = 4;
  for (let k = 0; k < count; k++) {
    const x = svarint(blob, i); if (x.err) return null;
    const y = svarint(blob, x.pos); if (y.err) return null;
    const z = svarint(blob, y.pos); if (z.err) return null;
    const len = uleb(blob, z.pos); if (len.err) return null;
    const end = len.pos + len.value;
    if (end > blob.length) return null;
    records.push([x.value, y.value, z.value, blob.slice(len.pos, end)]);
    i = end;
  }
  return { records, tail: blob.slice(i) };
}

export function writeEntityRecords(records, tail) {
  const out = [];
  pushU32(out, records.length);
  for (const [x, y, z, sub] of records) {
    writeSvarint(out, x); writeSvarint(out, y); writeSvarint(out, z);
    writeUleb(out, sub.length);
    for (const b of sub) out.push(b);
  }
  for (const b of tail) out.push(b);
  return Uint8Array.from(out);
}

export function entityCount(blob) {
  return blob.length < 4 ? 0 : u32At(blob, 0);
}

export function centred(size) {
  return [-fdiv(size[0], 2), -fdiv(size[1], 2), -fdiv(size[2], 2)];
}
