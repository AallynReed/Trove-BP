// In-page stand-in for the editor's old HTTP endpoints: FormData in, a Response out, nothing leaves the tab.
import { Fault } from './bytes.js';
import * as editor from './editor.js';
import { zip } from './zip.js';

const tail = (name) => name.split('/').pop();
const bytesOf = async (f) => new Uint8Array(await f.arrayBuffer());

// Header values must stay Latin-1, so escape everything else.
const headerJson = (v) => JSON.stringify(v).replace(/[\u0080-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

function bad(message, status = 400) {
  return new Response(JSON.stringify({ detail: message }), { status, headers: { 'content-type': 'application/json' } });
}

function json(v) {
  return new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
}

function octet(data, headers = {}, type = 'application/octet-stream') {
  return new Response(data, { headers: { 'content-type': type, ...headers } });
}

function parse(text, fallback, message) {
  try {
    return JSON.parse(text || fallback);
  } catch {
    throw new Fault('editor', message);
  }
}

async function stackOf(fd) {
  const layers = fd.getAll('layers').filter((f) => f && f.name);
  if (!layers.length) return [[], []];
  const specs = parse(fd.get('stack'), '[]', "The layer list wasn't understood.");
  if (!Array.isArray(specs)) throw new Fault('editor', "The layer list wasn't understood.");
  return [await Promise.all(layers.map(bytesOf)), specs];
}

async function base(fd) {
  const file = fd.get('file');
  if (!file || typeof file === 'string') throw new Fault('editor', 'No file was given.');
  const data = await bytesOf(file);
  if (!data.length) throw new Fault('editor', 'That file is empty.');
  return { file, data, edits: parse(fd.get('edits'), '[]', "The edit list wasn't understood."), anchor: parseInt(fd.get('anchor_at') || '0', 10) || 0 };
}

function qbStem(filename) {
  let stem = tail(filename || 'model');
  if (stem.toLowerCase().endsWith('.blueprint')) stem = [...stem].slice(0, -'.blueprint'.length).join('');
  return stem.replace(/[^A-Za-z0-9._-]/g, '_') || 'model';
}

const routes = {
  async inspect(fd) {
    const { file, data } = await base(fd);
    return json(await editor.inspect(data, tail(file.name || 'blueprint')));
  },
  async flatten(fd) {
    const b = await base(fd);
    const [layers, specs] = await stackOf(fd);
    if (!layers.length) return bad('There are no layers to flatten.');
    const [out, summary] = await editor.composite(b.data, b.edits, layers, specs, b.anchor);
    return octet(out, { 'x-summary': headerJson(summary) });
  },
  async transform(fd) {
    const b = await base(fd);
    const ops = parse(fd.get('ops'), '[]', "The request wasn't understood.");
    const [out, summary] = await editor.transformFile(b.data, b.edits, ops);
    return octet(out, { 'x-summary': headerJson(summary) });
  },
  async 'export-qb'(fd) {
    const b = await base(fd);
    const [layers, specs] = await stackOf(fd);
    const [entries, summary] = await editor.exportQb(b.data, b.edits, layers, specs, b.anchor, qbStem(b.file.name));
    return octet(zip(entries), { 'x-notes': headerJson(summary.notes) }, 'application/zip');
  },
  async 'import-qb'(fd) {
    const parts = [];
    for (const up of fd.getAll('files')) {
      if (!up || !up.name) continue;
      const name = tail(up.name);
      if (!name.toLowerCase().endsWith('.qb')) return bad(`'${name}' isn't a .qb file.`);
      const data = await bytesOf(up);
      const slot = parts.find((p) => p[0] === name);
      if (slot) slot[1] = data; else parts.push([name, data]);
    }
    if (!parts.length) return bad('No .qb files were sent.');
    if (parts.length > 4) return bad('Send the model and up to three material maps.');
    const [data, summary] = await editor.importQb(parts);
    return octet(data, { 'x-summary': headerJson(summary) });
  },
  async check(fd) {
    const b = await base(fd);
    const [layers, specs] = await stackOf(fd);
    return json(await editor.checkFile(b.data, b.edits, String(fd.get('kind') || 'other'), layers, specs, b.anchor));
  },
  async save(fd) {
    const b = await base(fd);
    const [layers, specs] = await stackOf(fd);
    const [out, summary] = await editor.composite(b.data, b.edits, layers, specs, b.anchor);
    return octet(out, { 'x-recoloured': String(summary.recoloured), 'x-rematerialised': String(summary.rematerialised), 'x-ignored': String(summary.ignored) });
  },
};

export async function call(route, fd) {
  try {
    return await routes[route](fd);
  } catch (e) {
    if (e instanceof Fault && e.kind === 'editor') return bad(e.message);
    console.error(e);
    return bad('Something went wrong handling that file.', 500);
  }
}
