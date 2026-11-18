import './styles.css';
import './icons.css';
import '../editor/editor.css';
import { $, esc } from './dom.js';
import { demoFile } from './demo.js';
import { pack } from '../engine/pack.js';
import { decodeDds } from '../engine/dds.js';
import { VoxelMesh } from '../viewer/voxel-mesh.js';
import { buildViewer } from '../viewer/viewer.js';
import { initEditor, openFile as editFile } from '../editor/editor.js';

const state = { files: [], shown: [], current: -1, viewer: null, mode: 'view', seq: 0, edited: null };
const pathOf = (f) => f.webkitRelativePath || f.relPath || f.name;

let toastTimer = 0;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4200);
}

// ---- the specular atlas (a game file, so it comes from the user's own install) ----

const DB = 'trovebp', STORE = 'assets';

function idb(mode, fn) {
  return new Promise((resolve) => {
    try {
      const open = indexedDB.open(DB, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(STORE);
      open.onerror = () => resolve(null);
      open.onsuccess = () => {
        try {
          const tx = open.result.transaction(STORE, mode);
          const req = fn(tx.objectStore(STORE));
          tx.oncomplete = () => resolve(req ? req.result : null);
          tx.onerror = () => resolve(null);
        } catch { resolve(null); }
      };
    } catch { resolve(null); }
  });
}

async function useBrdf(bytes, remember) {
  try {
    const { width, height, rgba } = decodeDds(bytes);
    VoxelMesh.setBrdfMap(window.THREE, width, height, rgba);
    $('open-brdf').textContent = 'Specular map ✓';
    $('open-brdf').setAttribute('aria-label', 'Specular map loaded. Load a different one');
    if (remember) {
      await idb('readwrite', (s) => s.put(bytes, 'brdfmap'));
      toast('Specular map loaded. Metal, water and the other finishes now show.');
    }
  } catch (e) {
    toast(`That specular map could not be read: ${e.message}`);
  }
}

// ---- the model list ----

function setFiles(files, label) {
  const found = [...files];
  const brdf = found.find((f) => f.name.toLowerCase() === 'brdfmap.dds');
  if (brdf) brdf.arrayBuffer().then((b) => useBrdf(new Uint8Array(b), true));
  const models = found.filter((f) => /\.blueprint$/i.test(f.name)).sort((a, b) => pathOf(a).localeCompare(pathOf(b)));
  if (!models.length) {
    if (!brdf) toast('No .blueprint files there.');
    return;
  }
  state.files = models;
  state.current = -1;
  $('pack-name').textContent = label || `${models.length} model${models.length === 1 ? '' : 's'}`;
  $('search').disabled = false;
  $('search').value = '';
  renderList();
  select(0);
}

function renderList() {
  const q = $('search').value.trim().toLowerCase();
  state.shown = state.files.map((f, i) => i).filter((i) => !q || pathOf(state.files[i]).toLowerCase().includes(q));
  $('list-count').textContent = state.files.length ? `${state.shown.length.toLocaleString()} of ${state.files.length.toLocaleString()}` : '';
  const LIMIT = 2000;
  $('file-list').innerHTML = state.shown.slice(0, LIMIT).map((i) => {
    const p = pathOf(state.files[i]);
    const cut = p.lastIndexOf('/');
    return `<li><button type="button" class="file" data-i="${i}"${i === state.current ? ' aria-current="true"' : ''}>`
      + `<span class="file-name">${esc(p.slice(cut + 1).replace(/\.blueprint$/i, ''))}</span>`
      + (cut > 0 ? `<span class="file-dir">${esc(p.slice(0, cut))}</span>` : '') + '</button></li>';
  }).join('') + (state.shown.length > LIMIT ? `<li class="file-more">${(state.shown.length - LIMIT).toLocaleString()} more. Filter to find them.</li>` : '');
}

function message(text, error) {
  const el = $('viewer-msg');
  el.textContent = text || '';
  el.hidden = !text;
  el.classList.toggle('error', !!error);
}

const KIND_NAMES = ['solid', 'glass', 'glowing', 'glowing glass'];

async function select(i) {
  if (i < 0 || i >= state.files.length) return;
  const seq = ++state.seq;
  state.current = i;
  for (const b of $('file-list').querySelectorAll('[aria-current]')) b.removeAttribute('aria-current');
  const btn = $('file-list').querySelector(`[data-i="${i}"]`);
  if (btn) { btn.setAttribute('aria-current', 'true'); btn.scrollIntoView({ block: 'nearest' }); }
  const file = state.files[i];
  $('empty').hidden = true;
  $('edit-this').hidden = false;
  $('model-title').textContent = file.name.replace(/\.blueprint$/i, '');
  $('model-meta').textContent = '';
  message('Loading…');
  if (state.viewer) { state.viewer.dispose(); state.viewer = null; }
  try {
    const data = await pack(new Uint8Array(await file.arrayBuffer()));
    if (seq !== state.seq) return;
    message('');
    const counts = [0, 0, 0, 0];
    for (let k = 0; k < data.count; k++) counts[data.kind[k]]++;
    const kinds = counts.map((n, k) => (n && k ? `${n.toLocaleString()} ${KIND_NAMES[k]}` : '')).filter(Boolean);
    $('model-meta').textContent = [`${data.count.toLocaleString()} voxels`, data.size.join('×'), `v${data.version}`, ...kinds].join(' · ');
    state.viewer = buildViewer($('viewer-stage'), data, file.name.replace(/\.blueprint$/i, ''));
  } catch (e) {
    if (seq !== state.seq) return;
    message(e.code === 'empty' ? 'This blueprint is an empty placeholder: it holds no voxels.' : e.message || 'This model could not be read.', true);
  }
}

// ---- opening files ----

async function entriesOf(items) {
  const out = [];
  const walk = async (entry, dir) => {
    if (entry.isFile) {
      const f = await new Promise((res, rej) => entry.file(res, rej));
      f.relPath = dir + f.name;
      out.push(f);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e, dir + entry.name + '/');
      }
    }
  };
  for (const e of items) if (e) await walk(e, '');
  return out;
}

function setMode(mode) {
  state.mode = mode;
  document.body.dataset.app = mode;
  $('view-page').hidden = mode !== 'view';
  $('bpe-page').hidden = mode !== 'edit';
  $('tab-view').setAttribute('aria-selected', String(mode === 'view'));
  $('tab-edit').setAttribute('aria-selected', String(mode === 'edit'));
  const file = state.files[state.current];
  if (mode === 'edit' && file && state.edited !== file) {
    state.edited = file;
    editFile(file);
  }
  window.dispatchEvent(new Event('resize'));
}

function wire() {
  const pick = (id) => () => $(id).click();
  $('open-folder').addEventListener('click', pick('folder-input'));
  $('empty-folder').addEventListener('click', pick('folder-input'));
  $('open-files').addEventListener('click', () => (state.mode === 'edit' ? $('bpe-input') : $('files-input')).click());
  $('empty-files').addEventListener('click', pick('files-input'));
  $('open-brdf').addEventListener('click', pick('brdf-input'));
  $('folder-input').addEventListener('change', (e) => {
    const files = [...e.target.files];
    const root = files[0] && pathOf(files[0]).split('/')[0];
    setMode('view');
    setFiles(files, root);
    e.target.value = '';
  });
  $('files-input').addEventListener('change', (e) => { setFiles(e.target.files); e.target.value = ''; });
  $('brdf-input').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) useBrdf(new Uint8Array(await f.arrayBuffer()), true);
    e.target.value = '';
  });
  $('empty-demo').addEventListener('click', async () => setFiles([await demoFile()], 'Demo'));
  $('search').addEventListener('input', renderList);
  $('file-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (b) select(+b.dataset.i);
  });
  $('file-list').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const at = state.shown.indexOf(state.current);
    const next = state.shown[Math.max(0, Math.min(state.shown.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next !== undefined) { select(next); $('file-list').querySelector(`[data-i="${next}"]`)?.focus(); }
  });
  $('tab-view').addEventListener('click', () => setMode('view'));
  $('tab-edit').addEventListener('click', () => setMode('edit'));
  $('edit-this').addEventListener('click', () => setMode('edit'));

  const page = $('view-page'), overlay = $('drop-overlay');
  let depth = 0;
  page.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; overlay.hidden = false; });
  page.addEventListener('dragover', (e) => e.preventDefault());
  page.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; overlay.hidden = true; } });
  page.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    const items = [...(e.dataTransfer.items || [])].map((it) => it.webkitGetAsEntry && it.webkitGetAsEntry());
    const files = items.some(Boolean) ? await entriesOf(items) : [...e.dataTransfer.files];
    setFiles(files);
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
}

wire();
initEditor(() => state.mode === 'edit');
idb('readonly', (s) => s.get('brdfmap')).then((b) => { if (b) useBrdf(new Uint8Array(b), false); });
