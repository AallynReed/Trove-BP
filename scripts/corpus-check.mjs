// Diff the JS engine against a reference dump: node scripts/corpus-check.mjs <reference.jsonl>
// Viewer lines: {p, n, size, spec, h} or {p, err}, h = sha256 over the packed arrays.
// Editor lines: {p, inspect, apply, transform, check_*, export, import, flatten}, see editRecord().
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pack } from '../src/engine/pack.js';
import { inflate } from '../src/engine/zlib.js';
import * as editor from '../src/engine/editor.js';

function digest(v) {
  const h = createHash('sha256');
  const row = Buffer.alloc(16);
  for (let i = 0; i < v.count; i++) {
    row.writeInt32LE(v.x[i], 0);
    row.writeInt32LE(v.y[i], 4);
    row.writeInt32LE(v.z[i], 8);
    row.writeUInt32LE(v.rgb[i], 12);
    h.update(row);
    h.update(Buffer.of(v.kind[i], v.level[i] & 255, v.level[i] >> 8, v.spec ? v.spec[i] : 0));
  }
  return h.digest('hex');
}

const sha = (b) => createHash('sha256').update(b).digest('hex');

async function payload(b) {
  return b.length > 9 && b[5] === 5 ? inflate(b.subarray(9)) : b;
}

function fail(e) {
  return e.kind === 'editor' ? { err: e.message } : { err: 'unhandled', m: e.message };
}

function editsFor(n, size) {
  const out = [];
  for (let i = 0; i < n; i++) {
    if (i % 7 === 3) out.push({ i, rgb: (i * 2654435761) % 0xffffff });
    if (i % 11 === 5) out.push({ i, type: 18, w: i % 8 });
    if (i % 17 === 9) out.push({ i, type: 55, w: 3, rgb: 0x123456 });
    if (i % 13 === 1) out.push({ i, del: true });
  }
  out.push({ add: [size[0], 0, 0], rgb: 0xff8800, type: 21, w: 1 });
  out.push({ add: [-1, 2, 1], rgb: 0x00ff88, type: 56, w: 5 });
  out.push({ add: [0, size[1] + 1, 0], rgb: 0x8800ff, type: 54, w: 9 });
  return out;
}

const noBytes = ({ bytes: _bytes, ...rest }) => rest;
// Key order is not part of the contract, so compare with sorted keys.
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));

async function attempt(fn) {
  try { return await fn(); } catch (e) { return fail(e); }
}

// Mirrors the reference harness: the same fixed edit script on every file.
async function editRecord(p, raw, layer) {
  const rec = { p };
  let ins;
  try { ins = await editor.inspect(raw, 'm'); } catch (e) { rec.inspect = fail(e); return rec; }
  rec.inspect = { h: sha(JSON.stringify(ins)) };
  const edits = editsFor(ins.count, ins.size);
  rec.apply = await attempt(async () => { const [d, s] = await editor.applyEdits(raw, edits); return { h: sha(await payload(d)), s: noBytes(s) }; });
  const ops = ['rotate_y', 'mirror_x', 'rotate_x'];
  rec.transform = await attempt(async () => { const [d, s] = await editor.transformFile(raw, edits, ops); return { h: sha(await payload(d)), s }; });
  for (const kind of ['melee', 'hat', 'deco']) {
    rec['check_' + kind] = await attempt(async () => ({ h: sha(JSON.stringify(await editor.checkFile(raw, [], kind, [], [], 0))) }));
  }
  try {
    const [files, s] = await editor.exportQb(raw, edits, [], [], 0, 'm');
    rec.export = { files: files.map(([n, d]) => n + ':' + sha(d)), s };
    rec.import = await attempt(async () => { const [d, s2] = await editor.importQb(files); return { h: sha(await payload(d)), s: s2 }; });
  } catch (e) { rec.export = fail(e); }
  if (layer) {
    const specs = [{ mode: 'centre', offset: [1, 0, -1] }];
    rec.flatten = await attempt(async () => { const [d, s] = await editor.composite(raw, [], [layer], specs, 1); return { h: sha(await payload(d)), s: noBytes(s) }; });
  }
  return rec;
}

async function editMain(lines) {
  const tally = {};
  const bad = [];
  for (let i = 0; i < lines.length; i++) {
    const want = lines[i];
    const raw = new Uint8Array(readFileSync(want.p));
    const layer = lines[i + 1] ? new Uint8Array(readFileSync(lines[i + 1].p)) : null;
    const got = await editRecord(want.p, raw, layer);
    for (const k of Object.keys(want)) {
      if (k === 'p') continue;
      const ok = canon(got[k]) === canon(want[k]);
      const t = k + (want[k].err ? ' (error)' : '') + (ok ? '' : ' MISMATCH');
      tally[t] = (tally[t] || 0) + 1;
      if (!ok && bad.length < 20) bad.push({ p: want.p, op: k, want: want[k], got: got[k] });
    }
  }
  console.log(tally);
  for (const b of bad) console.log(JSON.stringify(b));
  process.exit(bad.length ? 1 : 0);
}

async function main() {
  const ref = process.argv[2];
  if (!ref) { console.error('usage: corpus-check.mjs <reference.jsonl>'); process.exit(2); }
  const lines = readFileSync(ref, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  if (lines[0] && 'inspect' in lines[0]) return editMain(lines);
  const tally = {};
  const bad = [];
  for (const r of lines) {
    let got;
    try {
      const v = await pack(new Uint8Array(readFileSync(r.p)));
      got = { n: v.count, size: v.size, spec: !!v.spec, h: digest(v) };
    } catch (e) {
      got = { err: e.code === 'toolarge' ? `toolarge:${e.count}` : e.code === 'empty' ? 'empty' : `${e.code}:${e.message}` };
    }
    const want = r.err ? { err: r.err } : { n: r.n, size: r.size, spec: r.spec, h: r.h };
    const ok = JSON.stringify(got) === JSON.stringify(want);
    const k = (r.err ? r.err.split(':')[0] : 'decoded') + (ok ? '' : ' MISMATCH');
    tally[k] = (tally[k] || 0) + 1;
    if (!ok && bad.length < 20) bad.push({ p: r.p, want, got });
  }
  console.log(tally);
  for (const b of bad) console.log(JSON.stringify(b));
  process.exit(bad.length ? 1 : 0);
}

main();
