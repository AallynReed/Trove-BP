// A minimal stored (uncompressed) .zip writer.
import { concat, pushU16, pushU32 } from './bytes.js';

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC[(c ^ data[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// entries: [name, Uint8Array][].
export function zip(entries, date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const parts = [], central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(data);
    const fields = (h) => {
      pushU16(h, 20); pushU16(h, 0x0800); pushU16(h, 0); pushU16(h, time); pushU16(h, day);
      pushU32(h, crc); pushU32(h, data.length); pushU32(h, data.length); pushU16(h, nameBytes.length); pushU16(h, 0);
    };
    const local = [];
    pushU32(local, 0x04034b50); fields(local);
    const head = concat([Uint8Array.from(local), nameBytes]);
    parts.push(head, data);
    const c = [];
    pushU32(c, 0x02014b50); pushU16(c, 20); fields(c);
    pushU16(c, 0); pushU16(c, 0); pushU16(c, 0); pushU32(c, 0); pushU32(c, offset);
    central.push(concat([Uint8Array.from(c), nameBytes]));
    offset += head.length + data.length;
  }
  const dir = concat(central);
  const end = [];
  pushU32(end, 0x06054b50); pushU16(end, 0); pushU16(end, 0); pushU16(end, entries.length); pushU16(end, entries.length);
  pushU32(end, dir.length); pushU32(end, offset); pushU16(end, 0);
  return concat([...parts, dir, Uint8Array.from(end)]);
}
