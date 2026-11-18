// A small hand-made lantern that exercises every material: finishes, glass levels, glow and an attachment point.
import { encode } from '../engine/codec.js';

export function lanternVoxels() {
  const out = [];
  const put = (x, y, z, rgb, ty = 21, w = 0) => out.push({ x, y, z, r: (rgb >> 16) & 255, g: (rgb >> 8) & 255, b: rgb & 255, ty, w });
  const S = 9;
  for (let x = 0; x < S; x++) for (let z = 0; z < S; z++) put(x, 0, z, 0x3a3f47, 21, 1);
  for (let x = 1; x < S - 1; x++) for (let z = 1; z < S - 1; z++) put(x, 1, z, 0x5b4636, 21, 4);
  for (let y = 2; y < 10; y++) {
    for (const [x, z] of [[1, 1], [1, 7], [7, 1], [7, 7]]) put(x, y, z, 0x8a6a3f, 21, 1);
    for (let k = 2; k < 7; k++) {
      put(k, y, 1, 0x9fd8ff, 18, 2);
      put(k, y, 7, 0x9fd8ff, 18, 2);
      put(1, y, k, 0xc9b6ff, 54, 4);
      put(7, y, k, 0xc9b6ff, 54, 4);
    }
  }
  for (let x = 3; x < 6; x++) for (let y = 4; y < 7; y++) for (let z = 3; z < 6; z++) put(x, y, z, 0xffb347, 55, 0);
  put(4, 7, 4, 0xfff1a8, 56, 6);
  for (let x = 0; x < S; x++) for (let z = 0; z < S; z++) put(x, 10, z, 0xb3262f, 21, 3);
  for (let x = 2; x < 7; x++) for (let z = 2; z < 7; z++) put(x, 11, z, 0x7a1b22, 21, 2);
  for (const y of [12, 13, 14]) put(4, y, 4, 0xd9a441, 21, 1);
  put(3, 14, 4, 0xd9a441, 21, 1);
  put(5, 14, 4, 0xd9a441, 21, 1);
  return out;
}

export async function demoFile() {
  const voxels = lanternVoxels();
  const size = [9, 15, 9];
  const bytes = await encode(voxels, 5, [-4, -14, -4], new Uint8Array(0), [0, 0, 0], size);
  return new File([bytes], 'demo-lantern.blueprint');
}
