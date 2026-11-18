// zlib streams. Trove writes v5 bodies without a final block, so inflate keeps whatever decodes
// (zlib's decompressobj behaviour); the browser's DecompressionStream drops output on truncation.
import { Unzlib, zlibSync } from 'fflate';

// Inflate a zlib stream; null when it is not valid zlib.
export async function inflate(data) {
  const parts = [];
  try {
    new Unzlib((chunk) => parts.push(chunk)).push(data, false);
  } catch {
    return null;
  }
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export async function deflate(data) {
  return zlibSync(data, { level: 9 });
}
