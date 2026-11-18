import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as editor from '../src/engine/editor.js';
import { inflate } from '../src/engine/zlib.js';
import { zip, crc32 } from '../src/engine/zip.js';
import { call } from '../src/engine/api.js';
import { expected, fixture, sha, VERSIONS } from './helpers.js';

const payload = async (b) => (b[5] === 5 ? inflate(b.subarray(9)) : b);
const EDITS = [{ i: 0, rgb: 0x123456 }, { i: 3, type: 18, w: 2 }, { i: 5, del: true }, { add: [-1, 0, 0], rgb: 0xff0000, type: 55, w: 0 }];
const withoutBytes = ({ bytes: _bytes, ...rest }) => rest;

test('inspect lists materials and stats like the reference', async () => {
  for (const name of VERSIONS) {
    const ins = await editor.inspect(fixture(`${name}.blueprint`), 'm');
    assert.deepEqual(ins.materials, expected[name].inspect_materials);
    assert.deepEqual(ins.stats, expected[name].inspect_stats);
  }
});

test('edits, transforms, checks and .qb export match the reference', async () => {
  for (const name of VERSIONS) {
    const raw = fixture(`${name}.blueprint`);
    const want = expected[name];
    const [applied, summary] = await editor.applyEdits(raw, EDITS);
    assert.equal(sha(await payload(applied)), want.apply_hex, name);
    assert.deepEqual(withoutBytes(summary), withoutBytes(want.apply_summary));
    const [moved] = await editor.transformFile(raw, [], ['rotate_z', 'mirror_y']);
    assert.equal(sha(await payload(moved)), want.transform_hex, name);
    const [files] = await editor.exportQb(raw, [], [], [], 0, 'm');
    assert.deepEqual(files.map(([n, d]) => [n, sha(d)]), want.qb);
    assert.deepEqual(await editor.checkFile(raw, [], 'melee', [], [], 0), want.check_melee);
  }
});

test('.qb export compiles back to the same model', async () => {
  const raw = fixture('tiny-v5.blueprint');
  const [files] = await editor.exportQb(raw, [], [], [], 0, 'm');
  const [back, summary] = await editor.importQb(files);
  assert.equal(summary.attachment_source, 'marker');
  const a = await editor.inspect(raw, 'm');
  const b = await editor.inspect(back, 'm');
  assert.deepEqual(b.attachment, a.attachment);
  assert.deepEqual(b.size, a.size);
});

test('edit errors carry a message for the person', async () => {
  const raw = fixture('tiny-v3.blueprint');
  await assert.rejects(editor.applyEdits(raw, [{ i: 999, rgb: 1 }]), /outside the blueprint/);
  await assert.rejects(editor.applyEdits(raw, [{ i: 0, type: 3, w: 0 }]), /not an editable material/);
  const all = Array.from({ length: 19 }, (_, i) => ({ i, del: true }));
  await assert.rejects(editor.applyEdits(raw, all), /erase the whole model/);
});

test('the in-page endpoints answer like the old HTTP ones', async () => {
  const fd = new FormData();
  fd.append('file', new File([fixture('tiny-v4.blueprint')], 'tiny.blueprint'));
  fd.append('edits', JSON.stringify(EDITS));
  const res = await call('save', fd);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-Recoloured'), '1');
  const bad = new FormData();
  bad.append('file', new File([Uint8Array.of(1, 2, 3)], 'x.blueprint'));
  const r2 = await call('inspect', bad);
  assert.equal(r2.status, 400);
  assert.match((await r2.json()).detail, /empty placeholder/);
});

test('zip writer produces a readable archive', () => {
  const data = new TextEncoder().encode('hello');
  const z = zip([['a.txt', data]], new Date(2026, 0, 2, 3, 4, 6));
  const dv = new DataView(z.buffer);
  assert.equal(dv.getUint32(0, true), 0x04034b50);
  assert.equal(dv.getUint32(14, true), crc32(data));
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(dv.getUint32(z.length - 22, true), 0x06054b50);
});
