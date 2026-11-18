// Flatten a layer stack into one blueprint; where two overlap the later layer wins.
import { commas, fault, roundHalfEven } from './bytes.js';
import { attachment, readEntityRecords, writeEntityRecords } from './codec.js';
import { reorigin } from './transform.js';

export const ALIGN_MODES = [
  ['attachment', 'Line up the attachment points'],
  ['centre', 'Line up the centres'],
  ['corner', 'Line up the corners'],
];

const MAX_MERGED_VOXELS = 150_000;
const mg = fault('merge');

function alignOffset(base, over, mode) {
  if (mode === 'corner') return [0, 0, 0];
  if (mode === 'centre') return [0, 1, 2].map((i) => roundHalfEven((base.size[i] - 1) / 2 - (over.size[i] - 1) / 2));
  const a = attachment(base), b = attachment(over);
  if (!a || !b) {
    throw mg("Lining up the attachment points needs both models to have one, and at least one of these doesn't (older v3/v4 blueprints don't store one). Line up the centres or the corners instead.");
  }
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

// layers: [{doc, mode, offset}]. Returns [mergedDoc, summary].
export function flatten(layers, anchor) {
  if (!layers.length) throw mg("There's nothing to flatten.");
  if (anchor >= layers.length) throw mg("The anchor layer isn't in the stack.");
  const base = layers[anchor].doc;
  if (!base.voxels.length) throw mg('The anchor blueprint needs at least one voxel.');
  const total = layers.reduce((n, l) => n + l.doc.voxels.length, 0);
  if (total > MAX_MERGED_VOXELS) throw mg(`Together those are more than ${commas(MAX_MERGED_VOXELS)} voxels, past what the editor can hold.`);

  const placements = [];
  const at = new Map();
  const cells = [];
  let hidden = 0;
  layers.forEach((layer, i) => {
    if (!layer.doc.voxels.length) throw mg('A layer has no voxels.');
    let t = [0, 0, 0];
    if (i !== anchor) {
      if (!ALIGN_MODES.some(([m]) => m === layer.mode)) throw mg(`Unknown alignment: ${layer.mode}.`);
      const a = alignOffset(base, layer.doc, layer.mode);
      t = [a[0] + layer.offset[0], a[1] + layer.offset[1], a[2] + layer.offset[2]];
    }
    placements.push(t);
    for (const v of layer.doc.voxels) {
      const moved = { ...v, x: v.x + t[0], y: v.y + t[1], z: v.z + t[2] };
      const key = moved.x + ',' + moved.y + ',' + moved.z;
      const j = at.get(key);
      if (j !== undefined) { hidden++; cells[j] = moved; } else { at.set(key, cells.length); cells.push(moved); }
    }
  });

  const mn = [0, 1, 2].map((k) => Math.min(0, cells.reduce((m, v) => Math.min(m, [v.x, v.y, v.z][k]), Infinity)));
  const shift = [-mn[0], -mn[1], -mn[2]];
  const voxels = cells.map((v) => ({ ...v, x: v.x + shift[0], y: v.y + shift[1], z: v.z + shift[2] }));
  voxels.sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x);
  const size = [0, 1, 2].map((k) => Math.max(voxels.reduce((m, v) => Math.max(m, [v.x, v.y, v.z][k]), -Infinity) + 1, base.size[k] + shift[k]));

  const [entity, note] = mergeEntities(anchor, layers, placements, shift);
  const a = attachment(base);
  const attach = a ? [a[0] + shift[0], a[1] + shift[1], a[2] + shift[2]] : null;
  const [pos, offset] = reorigin(base, attach, size);
  const merged = { version: base.version, size, pos, voxels, entity, offset };
  return [merged, {
    voxels: voxels.length,
    from_base: base.voxels.length,
    from_layers: total - base.voxels.length,
    layers: layers.length - 1,
    anchor,
    hidden,
    placed_at: placements,
    size,
    attachment: attach,
    entities: note,
  }];
}

function mergeEntities(anchor, layers, placed, shift) {
  const anchorBlob = layers[anchor].doc.entity.slice();
  const reads = layers.map((l) => readEntityRecords(l.doc.entity));
  if (reads.some((r) => !r)) return [anchorBlob, "the placed objects couldn't be read on one of the models, so only the anchor's were kept"];
  const tail = reads[anchor].tail;
  const out = [];
  let carried = 0;
  reads.forEach(({ records }, i) => {
    if (i !== anchor) carried += records.length;
    const t = placed[i];
    for (const [x, y, z, sub] of records) out.push([x + t[0] + shift[0], y + t[1] + shift[1], z + t[2] + shift[2], sub]);
  });
  if (!out.length) return [anchorBlob, ''];
  const note = carried > 0 ? `${carried} placed object${carried !== 1 ? 's' : ''} came across too` : '';
  return [writeEntityRecords(out, tail), note];
}
