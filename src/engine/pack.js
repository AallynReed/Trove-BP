// The viewer payload: one entry per occupied cell as parallel typed arrays.
import { isEmpty, decode } from './codec.js';
import { renderCells } from './format.js';

export const RENDER_VOXEL_CAP = 250_000;

export class PackError extends Error {
  /** @param {'empty'|'toolarge'|'invalid'|'unhandled'} code */
  constructor(code, message, count) {
    super(message);
    this.code = code;
    this.count = count;
  }
}

export async function pack(raw, cap = RENDER_VOXEL_CAP) {
  if (await isEmpty(raw)) throw new PackError('empty', 'This blueprint is an empty placeholder.');
  let doc;
  try {
    doc = await decode(raw);
  } catch (e) {
    throw new PackError(e.kind === 'blueprint' ? 'invalid' : 'unhandled', e.message);
  }
  const cells = renderCells(doc.voxels);
  const n = cells.length;
  if (n > cap) throw new PackError('toolarge', `This model has ${n.toLocaleString('en-US')} voxels, more than the ${cap.toLocaleString('en-US')} the viewer draws.`, n);
  const x = new Int32Array(n), y = new Int32Array(n), z = new Int32Array(n);
  const rgb = new Uint32Array(n), kind = new Uint8Array(n), level = new Uint16Array(n), spec = new Uint8Array(n);
  let anySpec = false;
  for (let i = 0; i < n; i++) {
    const c = cells[i];
    x[i] = c.x; y[i] = c.y; z[i] = c.z;
    rgb[i] = (c.r << 16) | (c.g << 8) | c.b;
    kind[i] = c.kind; level[i] = c.level; spec[i] = c.spec;
    if (c.spec) anySpec = true;
  }
  const extent = (a) => {
    let lo = n ? a[0] : 0, hi = lo;
    for (let i = 1; i < n; i++) { if (a[i] < lo) lo = a[i]; else if (a[i] > hi) hi = a[i]; }
    return hi - lo + 1;
  };
  const out = { count: n, size: [extent(x), extent(y), extent(z)], x, y, z, rgb, kind, level, version: doc.version };
  if (anySpec) out.spec = spec;
  return out;
}
