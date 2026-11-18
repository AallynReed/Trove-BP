// Integer helpers with the Rust/Python semantics the formats rely on.

export const TWO32 = 2 ** 32;

export class Fault extends Error {
  /** @param {'blueprint'|'editor'|'transform'|'merge'|'qb'|'unhandled'} kind */
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

export const fault = (kind) => (msg) => new Fault(kind, msg);

export function fdiv(a, b) {
  return Math.floor(a / b);
}

export function fmod(a, b) {
  const r = a % b;
  return r !== 0 && (r < 0) !== (b < 0) ? r + b : r;
}

// Python round(): half to even.
export function roundHalfEven(x) {
  const r = Math.sign(x) * Math.round(Math.abs(x));
  return Math.abs(x - Math.trunc(x)) === 0.5 && r % 2 !== 0 ? r - Math.sign(x) : r;
}

export function commas(n) {
  return String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',').replace(/^/, n < 0 ? '-' : '');
}

// LEB128 masked to 32 bits, at most 10 bytes. Returns null when truncated or too long.
export function uleb(data, pos) {
  let result = 0;
  let shift = 0;
  for (;;) {
    if (pos >= data.length) return { err: 'Truncated LEB128 value.' };
    const byte = data[pos++];
    if (shift < 32) result = (result + (byte & 0x7f) * 2 ** shift) % TWO32;
    if ((byte & 0x80) === 0) return { value: result, pos };
    shift += 7;
    if (shift >= 64) return { err: 'LEB128 value too large.' };
  }
}

export function svarint(data, pos) {
  const r = uleb(data, pos);
  if (r.err) return r;
  const half = Math.floor(r.value / 2);
  return { value: r.value % 2 ? -half - 1 : half, pos: r.pos };
}

export function writeUleb(out, value) {
  let v = Number(BigInt.asUintN(32, BigInt(value)));
  for (;;) {
    const byte = v & 0x7f;
    v = Math.floor(v / 128);
    if (v !== 0) out.push(byte | 0x80);
    else { out.push(byte); return; }
  }
}

export function writeSvarint(out, v) {
  const b = BigInt(v);
  writeUleb(out, (b << 1n) ^ (b >> 31n));
}

export function i32At(b, off) {
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24));
}

export function u32At(b, off) {
  return i32At(b, off) >>> 0;
}

export function u16At(b, off) {
  return b[off] | (b[off + 1] << 8);
}

export function pushU32(out, v) {
  out.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
}

export function pushU16(out, v) {
  out.push(v & 255, (v >>> 8) & 255);
}

// i32::try_from or fail.
export function pushI32(out, v) {
  if (!Number.isInteger(v) || v < -(2 ** 31) || v >= 2 ** 31) return false;
  pushU32(out, v | 0);
  return true;
}

export function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
