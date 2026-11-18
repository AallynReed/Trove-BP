// Uncompressed DDS (the specular atlas, brdfmap.dds): level 0 as opaque RGBA bytes.
import { u32At } from './bytes.js';

const DDPF_ALPHAPIXELS = 0x1, DDPF_RGB = 0x40, DDPF_LUMINANCE = 0x20000;

function channel(px, mask) {
  if (!mask) return 0;
  let shift = 0;
  while (!((mask >>> shift) & 1)) shift++;
  const max = mask >>> shift;
  return Math.round((((px & mask) >>> shift) * 255) / max);
}

export function decodeDds(data) {
  if (data.length < 128 || data[0] !== 0x44 || data[1] !== 0x44 || data[2] !== 0x53 || data[3] !== 0x20 || u32At(data, 4) !== 124) {
    throw new Error('Not a DDS file.');
  }
  const height = u32At(data, 12), width = u32At(data, 16);
  const flags = u32At(data, 80), bits = u32At(data, 88);
  const n = width * height, rgba = new Uint8Array(n * 4);
  if (flags & DDPF_RGB) {
    const bpp = bits >>> 3;
    if (bpp < 2 || bpp > 4 || 128 + n * bpp > data.length) throw new Error('Unsupported DDS layout.');
    const masks = [u32At(data, 92), u32At(data, 96), u32At(data, 100)];
    for (let i = 0; i < n; i++) {
      const o = 128 + i * bpp;
      let px = 0;
      for (let k = bpp - 1; k >= 0; k--) px = px * 256 + data[o + k];
      for (let c = 0; c < 3; c++) rgba[i * 4 + c] = channel(px >>> 0, masks[c]);
      rgba[i * 4 + 3] = 255;
    }
  } else if (flags & DDPF_LUMINANCE && bits === 8) {
    if (128 + n > data.length) throw new Error('Unsupported DDS layout.');
    for (let i = 0; i < n; i++) rgba.fill(data[128 + i], i * 4, i * 4 + 3), (rgba[i * 4 + 3] = 255);
  } else {
    throw new Error('Only uncompressed DDS textures are supported here.');
  }
  return { width, height, rgba, alpha: !!(flags & DDPF_ALPHAPIXELS) };
}
