// Quarter turns and mirrors that carry the box, the attachment point and placed objects.
import { fault, fdiv } from './bytes.js';
import { attachment, centred, readEntityRecords, writeEntityRecords } from './codec.js';

export const OPERATIONS = [
  ['rotate_x', 'Rotate on X'],
  ['rotate_y', 'Rotate on Y'],
  ['rotate_z', 'Rotate on Z'],
  ['mirror_x', 'Flip left-right'],
  ['mirror_y', 'Flip upside-down'],
  ['mirror_z', 'Flip front-back'],
];

const tf = fault('transform');

function mapper(op, [sx, sy, sz]) {
  const s = [sx, sy, sz];
  switch (op) {
    case 'rotate_x': return [([x, y, z]) => [x, z, s[1] - 1 - y], [sx, sz, sy]];
    case 'rotate_y': return [([x, y, z]) => [z, y, s[0] - 1 - x], [sz, sy, sx]];
    case 'rotate_z': return [([x, y, z]) => [y, s[0] - 1 - x, z], [sy, sx, sz]];
    case 'mirror_x': return [([x, y, z]) => [s[0] - 1 - x, y, z], s];
    case 'mirror_y': return [([x, y, z]) => [x, s[1] - 1 - y, z], s];
    case 'mirror_z': return [([x, y, z]) => [x, y, s[2] - 1 - z], s];
    default: return null;
  }
}

function rewriteEntities(blob, point) {
  if (blob.length < 4) return blob.slice();
  const read = readEntityRecords(blob);
  if (!read) throw tf("This model has placed objects whose data can't be read, so it can't be moved without leaving them behind.");
  if (!read.records.length) return blob.slice();
  return writeEntityRecords(read.records.map(([x, y, z, sub]) => [...point([x, y, z]), sub]), read.tail);
}

export function translateEntities(blob, shift) {
  if (!shift[0] && !shift[1] && !shift[2]) return blob.slice();
  return rewriteEntities(blob, ([x, y, z]) => [x + shift[0], y + shift[1], z + shift[2]]);
}

// The origin a reshaped box gets: kept on the grip if there is one.
export function reorigin(doc, attach, size) {
  let pos;
  if (attach) pos = [-attach[0], -attach[1], -attach[2]];
  else if (doc.version === 5) pos = [-fdiv(size[0], 2), doc.pos[1], -fdiv(size[2], 2)];
  else pos = centred(size);
  const offset = doc.version === 3 || doc.version === 4 ? centred(size) : doc.offset;
  return [pos, offset];
}

export function apply(doc, ops) {
  if (!Array.isArray(ops) || !ops.length) throw tf('No transform was given.');
  if (ops.length > 16) throw tf("That's more transforms than one step should carry.");
  let voxels = doc.voxels.map((v) => ({ ...v }));
  let size = doc.size;
  let attach = attachment(doc);
  let entity = doc.entity.slice();
  for (const op of ops) {
    const m = typeof op === 'string' ? mapper(op, size) : null;
    if (!m) throw tf(`Unknown transform: ${op}.`);
    const [point, next] = m;
    size = next;
    for (const v of voxels) [v.x, v.y, v.z] = point([v.x, v.y, v.z]);
    if (attach) attach = point(attach);
    entity = rewriteEntities(entity, point);
  }
  const [pos, offset] = reorigin(doc, attach, size);
  return { version: doc.version, size, pos, voxels, entity, offset };
}
