import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pack } from '../src/engine/pack.js';
import { demoFile } from '../src/app/demo.js';
import { expected, fixture, VERSIONS } from './helpers.js';

test('viewer payload matches the reference decoder', async () => {
  for (const name of VERSIONS) {
    const v = await pack(fixture(`${name}.blueprint`));
    const want = expected[name].pack;
    assert.equal(v.count, want.count);
    assert.deepEqual(v.size, want.size);
    for (const k of ['x', 'y', 'z', 'rgb', 'kind', 'level']) assert.deepEqual([...v[k]], want[k], `${name} ${k}`);
    assert.deepEqual(v.spec ? [...v.spec] : undefined, want.spec);
  }
});

test('empty placeholders and oversized models are refused', async () => {
  const empty = Uint8Array.of(0x6b, 0x69, 0x77, 0x69, 0x62, 4, 0, 0, 0, 0);
  await assert.rejects(pack(empty), (e) => e.code === 'empty');
  await assert.rejects(pack(fixture('tiny-v5.blueprint'), 10), (e) => e.code === 'toolarge' && e.count === 18);
});

test('the demo model uses every material kind', async () => {
  const file = await demoFile();
  const v = await pack(new Uint8Array(await file.arrayBuffer()));
  assert.equal(v.version, 5);
  assert.deepEqual(new Set(v.kind), new Set([0, 1, 2, 3]));
  assert.ok(v.spec.some((s) => s > 0));
});
