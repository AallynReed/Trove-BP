import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roundHalfEven, svarint, uleb, writeSvarint, writeUleb, fdiv, fmod } from '../src/engine/bytes.js';
import { decode, encodePayload, entityCount, isEmpty, readEntityRecords, writeEntityRecords } from '../src/engine/codec.js';
import { materialFor, version } from '../src/engine/format.js';
import { fixture } from './helpers.js';

test('LEB128 is masked to 32 bits and capped at 10 bytes', () => {
  const out = [];
  writeUleb(out, 2 ** 32 + 5);
  assert.deepEqual(uleb(Uint8Array.from(out), 0), { value: 5, pos: 1 });
  assert.equal(uleb(Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0x7f), 0).value, 0xffffffff);
  assert.equal(uleb(new Uint8Array(10).fill(0x80), 0).err, 'LEB128 value too large.');
  assert.equal(uleb(Uint8Array.of(0x80), 0).err, 'Truncated LEB128 value.');
});

test('zigzag varints round-trip negatives', () => {
  for (const v of [0, -1, 1, -64, 63, -(2 ** 31), 2 ** 31 - 1]) {
    const out = [];
    writeSvarint(out, v);
    assert.equal(svarint(Uint8Array.from(out), 0).value, v);
  }
});

test('Python integer semantics', () => {
  assert.deepEqual([fdiv(-7, 2), fmod(-7, 2)], [-4, 1]);
  assert.deepEqual([fdiv(7, -2), fmod(7, -2)], [-4, -1]);
  assert.deepEqual([0.5, 1.5, 2.5, -0.5, -1.5, -2.5, -7.5].map(roundHalfEven), [0, 2, 2, 0, -2, -2, -8]);
});

test('material model', () => {
  assert.deepEqual(materialFor(1, 2, 3, 0, 3), [120, 120, 120, 0, 255, 0]);
  assert.deepEqual(materialFor(1, 2, 3, 0, 21), [1, 2, 3, 0, 255, 0]);
  assert.deepEqual(materialFor(9, 9, 9, 9, 54), [9, 9, 9, 1, 16 + 32 * 7, 0]);
  assert.deepEqual(materialFor(9, 9, 9, 3, 55), [9, 9, 9, 2, 255, 0]);
  assert.deepEqual(materialFor(9, 9, 9, 4, 21), [9, 9, 9, 0, 255, 4]);
});

test('decodes every format version', async () => {
  for (const [name, ver] of [['tiny-v3', 3], ['tiny-v4', 4], ['tiny-v5', 5]]) {
    const raw = fixture(`${name}.blueprint`);
    assert.equal(version(raw), ver);
    assert.equal(await isEmpty(raw), false);
    const doc = await decode(raw);
    assert.equal(doc.voxels.length, ver === 5 ? 18 : 19);
    assert.equal(entityCount(doc.entity), ver === 3 ? 0 : 1);
  }
});

test('re-encoding a decoded file gives the same bytes', async () => {
  for (const name of ['tiny-v3', 'tiny-v4']) {
    const raw = fixture(`${name}.blueprint`);
    const d = await decode(raw);
    assert.deepEqual(encodePayload(d.voxels, d.version, d.pos, d.entity, d.offset, d.size), raw);
  }
});

test('entity records round-trip with their tail', async () => {
  const d = await decode(fixture('tiny-v5.blueprint'));
  const read = readEntityRecords(d.entity);
  assert.deepEqual(read.records.map((r) => r.slice(0, 3)), [[1, 2, 3]]);
  assert.deepEqual(writeEntityRecords(read.records, read.tail), d.entity);
});

test('rejects what is not a blueprint', async () => {
  await assert.rejects(decode(Uint8Array.of(1, 2, 3)), /missing 'kiwib' magic/);
  assert.equal(await isEmpty(Uint8Array.of(0x6b, 0x69, 0x77, 0x69, 0x62, 3, 0, 0, 0, 0)), true);
});
