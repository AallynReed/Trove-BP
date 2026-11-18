// The Blueprint Editor UI. Every file stays in this tab: the engine runs in-page through call().
import { call } from '../engine/api.js';
import { esc } from '../app/dom.js';
import { VoxelScene } from './voxel-scene.js';

var isActive = function () { return true; };

var state = {
  file: null,
  data: null,
  base: null,
  origin: [],
  history: [],
  redo: [],
  scene: null,
  selection: -1,
  index: null,
  paint: { rgb: 0xff6b6b, type: 21, w: 0 },
  tool: 'paint',
  mode: 'both',
  scope: 'voxel',
  kind: 'other',
  docs: [],
  active: 0,
  anchor: 0,
  docSeq: 1,
  drawn: {},
  isolate: false,
  stroke: null,
  strokeNormal: null,

  slice: { on: false, axis: 'y', at: 0 },

  box: { fill: true, from: null, to: null, plane: null, lift: [0, 0, 0] },
  report: null,
  showAttach: true,
  swatches: [],
  sessionId: '',
  restoring: false,
  openWith: null,
  sel: null,
  selOut: false,
  grab: 'connected',
  nav: 'magicavoxel',
};

var ATTACH_COLOUR = 0xff3fd5;
var FINDING_COLOUR = { error: 0xff5555, warning: 0xffc857, info: 0x58a6ff };

function $(id) { return document.getElementById(id); }

function setStatus(msg, kind) {
  var el = $('bpe-status');
  if (!el) return;
  el.textContent = msg || '';
  el.className = 'bpe-status' + (kind ? ' bpe-' + kind : '');
  el.hidden = !msg;
}

function hex(rgb) {
  return '#' + ('000000' + (rgb >>> 0).toString(16)).slice(-6);
}
function unhex(s) {
  return parseInt(String(s || '').replace('#', ''), 16) & 0xFFFFFF;
}

function openFile(file, note, done, fail) {
  if (!file) return;
  if (!/\.blueprint$/i.test(file.name)) {
    setStatus('That isn’t a .blueprint file.', 'error');
    return;
  }
  state.openWith = { kind: 'file', file: file };
  setStatus('Opening ' + file.name + '…');
  var fd = new FormData();
  fd.append('file', file, file.name);
  call('inspect', fd)
    .then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) throw new Error((body && body.detail) || 'That blueprint couldn’t be opened.');
        return body;
      });
    })
    .then(function (payload) { loaded(file, payload, note); if (done) done(); })
    .catch(function (err) {
      if (fail) fail(err); else setStatus(err.message || String(err), 'error');
    });
}

function loaded(file, payload, note) {
  state.docs = [makeDoc(file, payload)];
  state.active = 0;
  state.anchor = 0;
  mount(note);
}

function mount(note) {

  if (!state.restoring) state.sessionId = 'S' + Date.now() + '-' + (state.docSeq);
  state.isolate = false;
  state.report = null;
  state.drawn = {};
  $('bpe-report').hidden = true;
  $('bpe-empty').hidden = true;
  $('bpe-workspace').hidden = false;

  document.body.classList.add('bpe-working');

  var d0 = state.docs[state.active];
  state.file = d0.file;
  state.data = d0.payload;
  state.base = d0.base;
  state.origin = d0.origin;
  state.history = d0.history;
  state.redo = d0.redo;
  state.selection = -1;

  state.sel = null;

  state.slice.on = false;
  state.slice.at = 0;
  cancelBox();
  rebuildIndex();

  renderSlice();
  renderKinds();
  renderTransforms();
  renderToolHint();
  renderPalette();
  renderMaterialList();
  renderMeta();
  renderSelection();
  renderLayers();
  updateDirty();
  setStatus(note || '', note ? 'ok' : '');

  if (state.scene) { state.scene.dispose(); state.scene = null; }

  var seededId = d0.id;
  VoxelScene.create({
    stage: $('bpe-stage'),
    data: liveView(),
    name: d0.payload.name,

    onPick: onPick,
    onHover: onHover,
    onDrag: function (dx, dy, dz) { nudgeActive(dx, dy, dz); },

    onStroke: onStroke,
    onRect: onRect,
  }).then(function (scene) {
    state.scene = scene;
    scene.setDragMode(dragModeFor(state.tool));
    scene.setNavScheme(state.nav);

    var now = active();
    if (now && now.id !== seededId) scene.rebuild(viewOf(now));
    drawStack();
    drawAttachment();
    drawSelection();

  }).catch(function (err) {
    setStatus(err.message || 'The 3D view could not start.', 'error');
  });
}

function liveView() {
  var d = state.data;
  var s = state.slice;
  var v = { count: 0, size: d.size, x: [], y: [], z: [], rgb: [],
            kind: [], level: [], spec: [] };
  for (var i = 0; i < d.count; i++) {
    if (!d.live[i]) continue;

    if (s.on && d[s.axis][i] !== s.at) continue;
    v.x.push(d.x[i]); v.y.push(d.y[i]); v.z.push(d.z[i]); v.rgb.push(d.rgb[i]);
    v.kind.push(d.kind[i]); v.level.push(d.level[i]); v.spec.push(d.spec[i]);
    v.count++;
  }
  return v;
}

function sliceMax() {
  var d = state.data;
  if (!d || !d.size) return 0;
  return Math.max(0, d.size[{ x: 0, y: 1, z: 2 }[state.slice.axis]] - 1);
}

function setSlice(next) {
  var s = state.slice;
  var axisChanged = next.axis !== undefined && next.axis !== s.axis;
  var turnedOn = next.on === true && !s.on;
  if (next.axis !== undefined) s.axis = next.axis;
  if (next.on !== undefined) s.on = next.on;

  if (axisChanged || turnedOn) s.at = Math.floor(sliceMax() / 2);
  if (next.at !== undefined) s.at = next.at;
  s.at = Math.max(0, Math.min(s.at, sliceMax()));
  cancelBox();
  renderSlice();
  if (state.scene) state.scene.rebuild(liveView());
  drawStack();
}

function renderSlice() {
  var s = state.slice, max = sliceMax();

  if (state.scene) state.scene.setPickPlane(s.on ? { axis: s.axis, at: s.at } : null);
  Array.prototype.forEach.call($('bpe-slice-axes').children, function (b) {
    b.setAttribute('aria-pressed',
      String(s.on ? b.dataset.slice === s.axis : b.dataset.slice === 'off'));
  });
  $('bpe-slicebar').hidden = !s.on;
  $('bpe-slicehint').hidden = !s.on;
  var at = $('bpe-slice-at');
  at.max = String(max);
  at.value = String(s.at);
  $('bpe-slice-read').textContent = s.at + ' / ' + max;
}

function rebuildIndex() {
  var d = state.data;
  state.index = new Map();
  for (var i = 0; i < d.count; i++) {
    if (d.live[i]) state.index.set(d.x[i] + ',' + d.y[i] + ',' + d.z[i], i);
  }
}

function liveCount() {
  var d = state.data, n = 0;
  for (var i = 0; i < d.count; i++) if (d.live[i]) n++;
  return n;
}

function editList() { return editListOf(state.docs[state.active]); }

function editListOf(docu) {
  var d = docu.payload, b = docu.base, out = [];
  for (var i = 0; i < d.count; i++) {
    var orig = docu.origin[i];
    if (orig < 0) {
      if (d.live[i]) {
        out.push({ add: [d.x[i], d.y[i], d.z[i]],
                   type: d.type[i], w: d.w[i], rgb: d.rgb[i] });
      }
      continue;
    }
    if (!d.live[i]) { out.push({ i: orig, del: true }); continue; }
    var e = null;
    if (d.type[i] !== b.type[orig] || d.w[i] !== b.w[orig]) {
      e = { i: orig, type: d.type[i], w: d.w[i] };
    }
    if (d.rgb[i] !== b.rgb[orig]) {
      e = e || { i: orig };
      e.rgb = d.rgb[i];
    }
    if (e) out.push(e);
  }
  return out;
}

var GRABS = [
  { id: 'voxel', label: 'Just that voxel' },
  { id: 'connected', label: 'Everything joined to it' },
  { id: 'colour', label: 'Every voxel of that colour' },
  { id: 'colour-connected', label: 'That colour, joined up' },
  { id: 'material', label: 'Every voxel of that material' },
];

var SELECT_COLOUR = 0x58a6ff;

var BOX_COLOUR = 0x6ee7a8;

function renderGrabs() {
  var el = $('bpe-grabs');
  if (!el) return;
  el.innerHTML = GRABS.map(function (g) {
    return '<button type="button" data-grab="' + g.id + '"'
      + ' aria-pressed="' + (state.grab === g.id) + '">' + esc(g.label) + '</button>';
  }).join('');
}

function flood(i, same) {
  var d = state.data, out = new Set([i]);
  var queue = [i];
  while (queue.length) {
    var c = queue.pop();
    var x = d.x[c], y = d.y[c], z = d.z[c];
    var nb = [[x+1,y,z],[x-1,y,z],[x,y+1,z],[x,y-1,z],[x,y,z+1],[x,y,z-1]];
    for (var n = 0; n < 6; n++) {
      var j = state.index.get(nb[n][0] + ',' + nb[n][1] + ',' + nb[n][2]);
      if (j === undefined || out.has(j) || !d.live[j]) continue;
      if (!same(j, i)) continue;
      out.add(j);
      queue.push(j);
    }
  }
  return out;
}

function grabFrom(i) {
  var d = state.data, out;
  if (state.grab === 'voxel') return new Set([i]);
  if (state.grab === 'connected') return flood(i, function () { return true; });
  if (state.grab === 'colour-connected') {
    return flood(i, function (j) { return d.rgb[j] === d.rgb[i]; });
  }
  out = new Set();
  if (state.grab === 'colour') {
    for (var j = 0; j < d.count; j++) if (d.live[j] && d.rgb[j] === d.rgb[i]) out.add(j);
    return out;
  }
  for (var k = 0; k < d.count; k++) {
    if (d.live[k] && d.type[k] === d.type[i] && d.w[k] === d.w[i]) out.add(k);
  }
  return out;
}

function allowed(i) {
  if (!state.sel || !state.sel.size) return true;
  return state.selOut ? !state.sel.has(i) : state.sel.has(i);
}

function selectAt(i, additive) {
  var got = grabFrom(i);
  if (additive && state.sel) got.forEach(function (j) { state.sel.add(j); });
  else state.sel = got;
  afterSelection();
}

function clearSelection() {
  state.sel = null;

  state.selOut = false;
  afterSelection();
}

function afterSelection() {
  drawSelection();
  renderSelectionBar();
  renderToolHint();
}

function drawSelection() {
  if (!state.scene) return;
  var d = state.data;
  if (!state.sel || !state.sel.size || !d) {
    state.scene.setOverlay('sel', [], SELECT_COLOUR, 1.04);
    return;
  }
  var pts = [];
  state.sel.forEach(function (i) {
    if (d.live[i]) pts.push([d.x[i], d.y[i], d.z[i]]);
  });
  state.scene.setOverlay('sel', pts, SELECT_COLOUR, 1.04);
}

function pruneSelection() {
  if (!state.sel) return;
  var d = state.data, dead = [];
  state.sel.forEach(function (i) { if (!d.live[i]) dead.push(i); });
  dead.forEach(function (i) { state.sel.delete(i); });
  if (!state.sel.size) state.sel = null;
}

function renderSelectionBar() {
  var n = state.sel ? state.sel.size : 0;
  var bar = $('bpe-selbar');
  if (!bar) return;
  bar.hidden = !n;
  if (!n) return;
  $('bpe-selcount').textContent = n.toLocaleString()
    + (n === 1 ? ' voxel selected' : ' voxels selected');
  var out = $('bpe-selout');
  out.setAttribute('aria-pressed', String(state.selOut));
  out.textContent = state.selOut ? 'Working outside it' : 'Working inside it';
}

function shiftSelection(dx, dy, dz, copy) {
  if (!state.data || !state.sel || !state.sel.size) return;
  var d = state.data, batch = [], rows = [];
  state.sel.forEach(function (i) { if (d.live[i]) rows.push(i); });
  if (!rows.length) return;

  var moving = new Set(rows.map(function (i) {
    return (d.x[i] + dx) + ',' + (d.y[i] + dy) + ',' + (d.z[i] + dz);
  }));
  var carried = rows.map(function (i) {
    return { x: d.x[i] + dx, y: d.y[i] + dy, z: d.z[i] + dz,
             rgb: d.rgb[i], type: d.type[i], w: d.w[i] };
  });

  if (!copy) {

    rows.forEach(function (i) {
      if (!moving.has(d.x[i] + ',' + d.y[i] + ',' + d.z[i])) eraseVoxel(i, batch);
    });
  }
  var next = new Set();
  carried.forEach(function (v) {
    var j = addVoxelAt(v, batch);
    if (j >= 0) next.add(j);
  });
  state.sel = next;
  commit(batch, 0);
  afterSelection();
  setStatus((copy ? 'Copied ' : 'Moved ') + carried.length.toLocaleString()
    + ' voxel' + (carried.length === 1 ? '' : 's') + '.', 'ok');
}

function drawAttachment() {
  if (!state.scene) return;
  var a = state.data && state.data.attachment;
  state.scene.setOverlay('attach',
    (a && state.showAttach) ? [a] : [], ATTACH_COLOUR, 1.25);
}

function highlightFinding(finding) {
  if (!state.scene || !state.data) return;
  var d = state.data;
  var pts = (finding && finding.voxels || []).map(function (i) {
    return [d.x[i], d.y[i], d.z[i]];
  });
  state.scene.setOverlay('lint', pts, FINDING_COLOUR[finding && finding.level] || 0xff5555, 1.1);
}

function runCheck() {
  if (!state.file) return;
  var btn = $('bpe-check');
  btn.disabled = true;
  setStatus('Checking…');
  var fd = new FormData();
  anchorParts(fd);
  fd.append('kind', state.kind);
  stackParts(fd);
  call('check', fd)
    .then(function (res) {
      return res.json().then(function (b) {
        if (!res.ok) throw new Error((b && b.detail) || 'The check couldn’t run.');
        return b;
      });
    })
    .then(function (report) {
      state.report = report;
      renderReport();
      setStatus('');
    })
    .catch(function (err) { setStatus(err.message || String(err), 'error'); })
    .finally(function () { btn.disabled = false; });
}

function staleReport() {
  if (!state.report) return;
  state.report = null;
  if (state.scene) state.scene.clearOverlay('lint');
  var box = $('bpe-report');
  box.hidden = false;
  box.innerHTML = '<p class="bpe-hint">You’ve changed the model since the last check. '
    + 'Run it again to see where it stands.</p>';
}

function renderReport() {
  var box = $('bpe-report');
  var r = state.report;
  if (!r) { box.innerHTML = ''; box.hidden = true; return; }
  box.hidden = false;
  var c = r.counts;
  var head = c.error
    ? '<strong class="bpe-r-error">' + c.error + ' to fix</strong>'
    : '<strong class="bpe-r-ok"><i class="fa-solid fa-check" aria-hidden="true"></i> Nothing blocking</strong>';
  if (c.warning) head += '<span>' + c.warning + ' to look at</span>';

  var items = r.findings.map(function (f, i) {
    return '<li class="bpe-finding bpe-f-' + f.level + '">'
      + '<div class="bpe-f-head"><span class="bpe-f-dot"></span><strong>' + esc(f.title) + '</strong>'
      + (f.voxels.length
          ? '<button type="button" class="bpe-f-show" data-finding="' + i + '">Show '
            + f.voxels.length.toLocaleString() + '</button>'
          : '')
      + '</div><p>' + esc(f.body) + '</p></li>';
  }).join('');

  box.innerHTML = '<div class="bpe-r-head">' + head + '</div>'
    + (items ? '<ul class="bpe-findings">' + items + '</ul>' : '')
    + '<ul class="bpe-satisfied">'
    + r.satisfied.map(function (s) {
        return '<li><i class="fa-solid fa-check" aria-hidden="true"></i> ' + esc(s) + '</li>';
      }).join('')
    + '</ul>'
    + '<p class="bpe-hint">These are the Trove Creations submission guidelines. '
    + 'Plenty of official game items bend them — they describe what gets accepted, '
    + 'not what the game can load.</p>';
}

function reshade(i, payload) {
  var d = payload || state.data;
  var t = d.type[i], w = d.w[i];
  var glass = (t === 18 || t === 54 || t === 56);
  var glow = (t === 55 || t === 56);
  d.kind[i] = glow ? (glass ? 3 : 2) : (glass ? 1 : 0);
  d.level[i] = glass ? (16 + 32 * Math.max(0, Math.min(w, 7))) : 255;
  d.spec[i] = (d.kind[i] === 0) ? Math.max(0, Math.min(w, 7)) : 0;
}

function applyTo(i, change, batch) {
  var d = state.data;
  var wantsColour = change.rgb !== undefined;
  var wantsMaterial = change.type !== undefined;
  var canColour = wantsColour && d.paint[i];
  var canMaterial = wantsMaterial && d.edit[i];
  if (!canColour && !canMaterial) return false;

  batch.push({ index: i, rgb: d.rgb[i], type: d.type[i], w: d.w[i], live: d.live[i] });
  if (canColour) d.rgb[i] = change.rgb;
  if (canMaterial) { d.type[i] = change.type; d.w[i] = change.w; }
  reshade(i);
  return true;
}

function eraseVoxel(i, batch) {
  var d = state.data;
  if (!d.live[i]) return false;
  batch.push({ index: i, rgb: d.rgb[i], type: d.type[i], w: d.w[i], live: 1 });
  d.live[i] = 0;
  return true;
}

function addVoxel(x, y, z, batch) {
  var d = state.data;
  for (var i = 0; i < d.count; i++) {
    if (d.x[i] === x && d.y[i] === y && d.z[i] === z) {
      batch.push({ index: i, rgb: d.rgb[i], type: d.type[i], w: d.w[i], live: d.live[i] });
      d.live[i] = 1;
      d.rgb[i] = state.paint.rgb;
      d.type[i] = state.paint.type;
      d.w[i] = state.paint.w;
      reshade(i);
      return true;
    }
  }
  var n = d.count;
  d.x.push(x); d.y.push(y); d.z.push(z);
  d.rgb.push(state.paint.rgb);
  d.type.push(state.paint.type); d.w.push(state.paint.w);
  d.kind.push(0); d.level.push(255); d.spec.push(0);
  d.edit.push(1); d.paint.push(1);
  d.live.push(1);
  state.origin.push(-1);
  d.count = n + 1;
  reshade(n);
  batch.push({ index: n, added: true });
  return true;
}

function addVoxelAt(v, batch) {
  var d = state.data;
  var key = v.x + ',' + v.y + ',' + v.z;
  var i = state.index.get(key);
  if (i !== undefined) {
    batch.push({ index: i, rgb: d.rgb[i], type: d.type[i], w: d.w[i], live: d.live[i] });
    d.live[i] = 1; d.rgb[i] = v.rgb; d.type[i] = v.type; d.w[i] = v.w;
    reshade(i);
    return i;
  }
  var n = d.count;
  d.x.push(v.x); d.y.push(v.y); d.z.push(v.z);
  d.rgb.push(v.rgb); d.type.push(v.type); d.w.push(v.w);
  d.kind.push(0); d.level.push(255); d.spec.push(0);
  d.edit.push(1); d.paint.push(1);
  d.live.push(1);
  state.origin.push(-1);
  d.count = n + 1;
  reshade(n);
  state.index.set(key, n);
  batch.push({ index: n, added: true });
  return n;
}

function commit(batch, refused) {
  if (batch.length) {
    rebuildIndex();
    if (state.scene) state.scene.rebuild(liveView());
    if (state.stroke) {

      state.stroke.push.apply(state.stroke, batch);
    } else {
      state.history.push(batch);
      state.redo.length = 0;
      renderMaterialList();
      renderMeta();
      renderLayers();
      updateDirty();
      staleReport();
    }
  }
  if (refused) {
    setStatus(refused + (refused === 1 ? ' voxel is' : ' voxels are')
      + ' controlled by the game — a deco placeholder, terrain that’s coloured'
      + ' in-game, or a material outside the modding palette — so they were left'
      + ' as they are.', 'warn');
  } else if (batch.length) {
    setStatus('');
  }
}

function change() {
  var c = {};
  if (state.mode === 'colour' || state.mode === 'both') c.rgb = state.paint.rgb;
  if (state.mode === 'material' || state.mode === 'both') {
    c.type = state.paint.type; c.w = state.paint.w;
  }
  return c;
}

function targetsFor(i) {
  var d = state.data;
  if (state.scope === 'voxel') return [i];
  var out = [];
  if (state.scope === 'colour') {
    var rgb = d.rgb[i];
    for (var j = 0; j < d.count; j++) if (d.live[j] && d.rgb[j] === rgb) out.push(j);
    return out;
  }
  var t = d.type[i], w = d.w[i];
  for (var k = 0; k < d.count; k++) {
    if (d.live[k] && d.type[k] === t && d.w[k] === w) out.push(k);
  }
  return out;
}

var AXES = ['x', 'y', 'z'];

function normalAxis(hit) {
  return hit.nx ? 'x' : (hit.ny ? 'y' : 'z');
}

function inGrid(c) {
  var s = state.data.size;
  return c.x >= 0 && c.y >= 0 && c.z >= 0
      && c.x < s[0] && c.y < s[1] && c.z < s[2];
}

function planeAxes(fixed) {
  return AXES.filter(function (a) { return a !== fixed; });
}

function boxCells() {
  var b = state.box;
  if (!b.from || !b.to) return [];
  var free = planeAxes(b.plane);
  var a0 = free[0], a1 = free[1];

  var lo0 = Math.min(b.from[a0], b.to[a0]), hi0 = Math.max(b.from[a0], b.to[a0]);
  var lo1 = Math.min(b.from[a1], b.to[a1]), hi1 = Math.max(b.from[a1], b.to[a1]);
  var lim = { x: state.data.size[0] - 1, y: state.data.size[1] - 1, z: state.data.size[2] - 1 };
  lo0 = Math.max(0, lo0); hi0 = Math.min(lim[a0], hi0);
  lo1 = Math.max(0, lo1); hi1 = Math.min(lim[a1], hi1);
  var out = [];
  for (var p = lo0; p <= hi0; p++) {
    for (var q = lo1; q <= hi1; q++) {
      var cell = { x: b.from.x, y: b.from.y, z: b.from.z };
      cell[a0] = p; cell[a1] = q;
      out.push(cell);
    }
  }
  return out;
}

function drawBox() {
  if (!state.scene) return;
  var b = state.box;
  if (!b.from || !b.to) { state.scene.setOverlay('box', [], BOX_COLOUR, 1.02); return; }
  var n = b.fill ? b.lift : [0, 0, 0];
  var pts = boxCells().map(function (c) {
    return [c.x + n[0], c.y + n[1], c.z + n[2]];
  });
  state.scene.setOverlay('box', pts, BOX_COLOUR, b.fill && b.lift[0] + b.lift[1] + b.lift[2] ? 1.02 : 1.08);
}

function cancelBox() {
  state.box.from = state.box.to = state.box.plane = null;
  state.box.lift = [0, 0, 0];
  drawBox();
}

function commitBox() {
  var b = state.box;
  if (!b.from || !b.to) return;
  var cells = boxCells();
  var n = b.lift;
  var batch = [], refused = 0, done = 0;
  cells.forEach(function (c) {
    if (b.fill) {
      var v = { x: c.x + n[0], y: c.y + n[1], z: c.z + n[2],
                rgb: state.paint.rgb, type: state.paint.type, w: state.paint.w };

      if (v.x < 0 || v.y < 0 || v.z < 0) { refused++; return; }
      addVoxelAt(v, batch);
      done++;
    } else {
      var i = state.index.get(c.x + ',' + c.y + ',' + c.z);
      if (i === undefined) return;
      if (!allowed(i)) { refused++; return; }
      if (eraseVoxel(i, batch)) done++;
    }
  });
  cancelBox();
  if (!batch.length) {
    setStatus(b.fill ? 'Nothing could be placed there.'
                     : 'No voxels of this part in that box.', 'warn');
    return;
  }
  commit(batch, 0);
  pruneSelection();
  afterSelection();
  setStatus(done.toLocaleString() + ' voxel' + (done === 1 ? '' : 's')
    + (b.fill ? ' placed' : ' cleared')
    + (refused ? ' · ' + refused + ' skipped (outside the selection or the grid)' : '')
    + '.', 'ok');
}

function onPick(hit, ev) {
  if (!hit || !state.data) return;

  if (state.tool === 'box') {
    var b = state.box;

    if (state.slice.on) {
      b.plane = state.slice.axis;
      b.lift = [0, 0, 0];
    } else if (!b.plane) {
      b.plane = normalAxis(hit);
      b.lift = [hit.nx, hit.ny, hit.nz];
    } else if (b.plane !== normalAxis(hit)
               || b.lift[0] !== hit.nx || b.lift[1] !== hit.ny || b.lift[2] !== hit.nz) {

      return;
    }
    if (!b.from) b.from = { x: hit.x, y: hit.y, z: hit.z };
    b.to = { x: hit.x, y: hit.y, z: hit.z };
    drawBox();
    return;
  }

  if (hit.onPlane) {
    if (state.tool !== 'add') return;

    if (!inGrid(hit)) return;
    var planeBatch = [];
    addVoxel(hit.x, hit.y, hit.z, planeBatch);
    commit(planeBatch, 0);
    state.selection = state.index.get(hit.x + ',' + hit.y + ',' + hit.z);
    if (state.selection === undefined) state.selection = -1;
    renderSelection();
    return;
  }

  var i = state.index.get(hit.x + ',' + hit.y + ',' + hit.z);
  if (i === undefined) return;
  var batch = [], refused = 0;

  if (state.tool === 'pick' || (ev && ev.altKey)) {
    state.paint.rgb = state.data.rgb[i];
    if (state.data.edit[i]) {
      state.paint.type = state.data.type[i];
      state.paint.w = state.data.w[i];
    }
    state.selection = i;
    syncPaintUI();
    renderSelection();
    setStatus('Picked up ' + hex(state.paint.rgb).toUpperCase()
      + (state.data.edit[i] ? ' · ' + label(i) : '')
      + (state.data.edit[i] ? '' : ' (its material is one the game manages, so only the colour was taken)'),
      'ok');
    return;
  }

  if (state.tool === 'select') {
    selectAt(i, !!(ev && ev.shiftKey));
    state.selection = i;
    renderSelection();
    return;
  }

  if (state.tool === 'add') {

    if (state.stroke) {
      if (!state.strokeNormal) state.strokeNormal = [hit.nx, hit.ny, hit.nz];
      var n = state.strokeNormal;
      if (n[0] !== hit.nx || n[1] !== hit.ny || n[2] !== hit.nz) return;
    }

    if (state.slice.on && normalAxis(hit) === state.slice.axis) {
      setStatus('That face points out of the slice, so a voxel there would land in '
        + 'the layer behind it. Step the slice, or build from a side face.', 'warn');
      return;
    }
    addVoxel(hit.x + hit.nx, hit.y + hit.ny, hit.z + hit.nz, batch);
    commit(batch, 0);
    state.selection = state.index.get(
      (hit.x + hit.nx) + ',' + (hit.y + hit.ny) + ',' + (hit.z + hit.nz));
    if (state.selection === undefined) state.selection = -1;
    renderSelection();
    return;
  }

  var targets = targetsFor(i).filter(allowed);

  if (!targets.length) {
    if (state.sel && state.sel.size) {
      setStatus('That voxel is outside the selection. Clear it, or invert it with '
        + '“Working inside it”.', 'warn');
    }
    return;
  }

  if (state.tool === 'erase') {
    targets.forEach(function (j) { eraseVoxel(j, batch); });
    commit(batch, 0);
    pruneSelection();
    afterSelection();
    state.selection = -1;
    renderSelection();
    return;
  }

  state.selection = i;
  renderSelection();

  var c = change();
  if (!Object.keys(c).length) return;

  targets.forEach(function (j) { if (!applyTo(j, c, batch)) refused++; });
  commit(batch, refused);
  renderSelection();
}

function onHover(hit) {
  var el = $('bpe-hover');
  if (!el) return;
  var i = (hit && state.data)
    ? state.index.get(hit.x + ',' + hit.y + ',' + hit.z)
    : undefined;
  if (i === undefined) {

    if (hit && hit.onPlane && state.data && inGrid(hit)) {
      var where = hit.x + ', ' + hit.y + ', ' + hit.z + ' · empty';
      if (el.textContent !== where) el.textContent = where;
      el.hidden = false;
      return;
    }
    if (!el.hidden) { el.hidden = true; el.textContent = ''; }
    return;
  }
  var text = hit.x + ', ' + hit.y + ', ' + hit.z + ' · ' + label(i);
  if (el.textContent !== text) el.textContent = text;
  el.hidden = false;
}

function undo() {
  undoDoc(active());
  pruneSelection();
  afterSelection();
}

function redo() {
  redoDoc(active());
  pruneSelection();
  afterSelection();
}

function snapshot(docu, batch) {
  var d = docu.payload;
  return batch.map(function (rec) {
    var i = rec.index;
    return { index: i, rgb: d.rgb[i], type: d.type[i], w: d.w[i], live: d.live[i] };
  });
}

function undoDoc(docu) {
  if (!docu) return;
  var batch = docu.history.pop();
  if (!batch) return;
  docu.redo.push(snapshot(docu, batch));
  applyBatch(docu, batch);
}

function redoDoc(docu) {
  if (!docu) return;
  var batch = docu.redo.pop();
  if (!batch) return;
  docu.history.push(snapshot(docu, batch));
  applyBatch(docu, batch);
}

function applyBatch(docu, batch) {
  var d = docu.payload;

  for (var k = batch.length - 1; k >= 0; k--) {
    var rec = batch[k];
    var i = rec.index;
    if (rec.added) {

      d.live[i] = 0;
      continue;
    }
    d.rgb[i] = rec.rgb; d.type[i] = rec.type; d.w[i] = rec.w; d.live[i] = rec.live;
    reshade(i, d);
  }

  if (docu !== active()) {
    docu.dirtyMesh = true;
    renderLayers();
    drawStack();
    updateDirty();
    return;
  }
  rebuildIndex();
  if (state.scene) state.scene.rebuild(liveView());
  renderMaterialList();
  renderMeta();
  renderSelection();
  renderLayers();
  updateDirty();
  setStatus('');
}

function revertAll() {
  var d = state.data, b = state.base;
  for (var i = 0; i < d.count; i++) {
    var orig = state.origin[i];
    if (orig < 0) { d.live[i] = 0; continue; }
    d.rgb[i] = b.rgb[orig]; d.type[i] = b.type[orig]; d.w[i] = b.w[orig];
    d.live[i] = 1;
    reshade(i);
  }

  state.history.length = 0;
  state.redo.length = 0;
  rebuildIndex();
  if (state.scene) state.scene.rebuild(liveView());
  renderMaterialList();
  renderMeta();
  renderSelection();
  updateDirty();
  setStatus('');
}

function save() {
  if (!state.file) return;
  setStatus('Saving…');
  var fd = new FormData();
  anchorParts(fd);
  stackParts(fd);
  call('save', fd)
    .then(function (res) {
      if (!res.ok) {
        return res.json().then(function (b) {
          throw new Error((b && b.detail) || 'The blueprint couldn’t be saved.');
        });
      }
      var ignored = parseInt(res.headers.get('X-Ignored') || '0', 10);
      return res.blob().then(function (blob) { return { blob: blob, ignored: ignored }; });
    })
    .then(function (out) {
      var url = URL.createObjectURL(out.blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = state.file.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      setStatus(out.ignored
        ? 'Saved. ' + out.ignored + ' protected voxels were left untouched.'
        : 'Saved — check your downloads.', 'ok');
    })
    .catch(function (err) { setStatus(err.message || String(err), 'error'); });
}

function runTransform(op) {
  if (!state.file) return;
  var list = editList();
  setStatus('Turning the model…');
  var fd = new FormData();
  fd.append('file', state.file, state.file.name);
  fd.append('edits', JSON.stringify(list));
  fd.append('ops', JSON.stringify([op]));
  call('transform', fd)
    .then(function (res) {
      if (!res.ok) {
        return res.json().then(function (b) {
          throw new Error((b && b.detail) || 'The model couldn’t be turned.');
        });
      }
      var summary = {};
      try { summary = JSON.parse(res.headers.get('X-Summary') || '{}'); } catch (e) {  }
      return res.blob().then(function (blob) { return { blob: blob, summary: summary }; });
    })
    .then(function (out) {
      var s = out.summary;
      var label = (state.data.transforms || []).reduce(function (acc, t) {
        return t.op === op ? t.label : acc;
      }, op);
      var bits = [label.toLowerCase()];
      if (s.size_before && s.size_after && s.size_before.join() !== s.size_after.join()) {
        bits.push('now ' + s.size_after.join('×'));
      }
      if (s.attachment) bits.push('attachment point moved with it');
      if (s.entities) bits.push(s.entities.toLocaleString() + ' placed object'
        + (s.entities === 1 ? '' : 's') + ' moved too');
      var file = new File([out.blob], state.file.name);
      var note = 'Applied ' + bits.join(' · ') + '.';

      openFile(file, note);
    })
    .catch(function (err) { setStatus(err.message || String(err), 'error'); });
}

function renderTransforms() {
  var ops = state.data.transforms || [];
  var groups = [{ key: 'rotate_', caption: 'Rotate' }, { key: 'mirror_', caption: 'Flip' }];
  $('bpe-transforms').innerHTML = groups.map(function (g) {
    var row = ops.filter(function (t) { return t.op.indexOf(g.key) === 0; });
    if (!row.length) return '';
    return '<span class="bpe-xform-cap">' + esc(g.caption) + '</span>'
      + row.map(function (t) {
        return '<button type="button" class="bpe-xform" data-op="' + t.op + '"'
          + ' title="' + esc(t.label) + '" aria-label="' + esc(t.label) + '">'
          + t.op.slice(-1).toUpperCase() + '</button>';
      }).join('');
  }).join('');
}

function doc(i) { return state.docs[i] || null; }
function active() { return state.docs[state.active] || null; }

function anchorDoc() { return state.docs[state.anchor] || null; }

function alignOffset(d, mode) {
  var b = anchorDoc();
  if (!b || !d || d === b) return [0, 0, 0];
  if (mode === 'corner') return [0, 0, 0];
  if (mode === 'centre') {
    return [0, 1, 2].map(function (i) {
      return Math.round((b.payload.size[i] - 1) / 2 - (d.payload.size[i] - 1) / 2);
    });
  }
  if (!b.payload.attachment || !d.payload.attachment) return null;
  return [0, 1, 2].map(function (i) {
    return b.payload.attachment[i] - d.payload.attachment[i];
  });
}

function placement(d) {
  if (!d || d === anchorDoc()) return [0, 0, 0];
  var base = alignOffset(d, d.mode);
  if (!base) return null;
  return [base[0] + d.offset[0], base[1] + d.offset[1], base[2] + d.offset[2]];
}

function viewOf(d) {
  var p = d.payload;
  var v = { count: 0, size: p.size, x: [], y: [], z: [], rgb: [],
            kind: [], level: [], spec: [] };
  for (var i = 0; i < p.count; i++) {
    if (!p.live[i]) continue;
    v.x.push(p.x[i]); v.y.push(p.y[i]); v.z.push(p.z[i]); v.rgb.push(p.rgb[i]);
    v.kind.push(p.kind[i]); v.level.push(p.level[i]); v.spec.push(p.spec[i]);
    v.count++;
  }
  return v;
}

function drawStack() {
  if (!state.scene || !state.docs.length) return;
  var a = active();
  var at = placement(a) || [0, 0, 0];
  state.scene.setModelOffset(at[0], at[1], at[2]);
  state.scene.clearLayers();
  state.docs.forEach(function (d, i) {
    if (i === state.active) return;
    if (!d.visible || state.isolate) return;
    var t = placement(d);
    if (!t) return;
    state.scene.setLayer(d.id, viewOf(d), 0x6e7785);
    state.scene.moveLayer(d.id, t[0], t[1], t[2]);
  });
}

function stackStats() {
  var cells = new Set();
  var hidden = 0;
  state.docs.forEach(function (d) {
    var t = placement(d);
    if (!t) return;
    var p = d.payload;
    for (var i = 0; i < p.count; i++) {
      if (!p.live[i]) continue;
      var k = (p.x[i] + t[0]) + ',' + (p.y[i] + t[1]) + ',' + (p.z[i] + t[2]);
      if (cells.has(k)) hidden++;
      cells.add(k);
    }
  });
  return { total: cells.size, hidden: hidden };
}

function makeDoc(file, payload, extra) {
  payload.live = [];
  var origin = [];
  for (var i = 0; i < payload.count; i++) { payload.live.push(1); origin.push(i); }
  var d = {
    id: 'D' + (state.docSeq++),
    file: file,
    payload: payload,
    base: { rgb: payload.rgb.slice(), type: payload.type.slice(), w: payload.w.slice() },
    origin: origin,
    history: [],
    redo: [],
    mode: 'attachment',
    offset: [0, 0, 0],
    visible: true,

    path: '',
    ap: null,
    added: false,
    locked: false,
    move: [0, 0, 0],
    row: [0, 0, 0],
  };
  return Object.assign(d, extra || {});
}

function setActive(i) {
  if (i < 0 || i >= state.docs.length) return;

  if (state.docs[state.active]) state.docs[state.active].dirtyMesh = true;
  state.active = i;
  var d = state.docs[i];
  state.file = d.file;
  state.data = d.payload;
  state.base = d.base;
  state.origin = d.origin;
  state.history = d.history;
  state.redo = d.redo;
  state.selection = -1;
  state.sel = null;

  state.slice.at = Math.min(state.slice.at, sliceMax());
  cancelBox();
  rebuildIndex();
  renderSlice();
  renderKinds();
  renderTransforms();
  renderPalette();
  renderMaterialList();
  renderMeta();
  renderSelection();
  renderLayers();
  updateDirty();
  if (state.scene) {
    state.scene.rebuild(liveView());
    drawStack();
    drawAttachment();

  }
}

function addLayer(file) {
  if (!file) return;
  if (state.docs.length >= 8) {
    setStatus('That is as many layers as one stack takes.', 'error');
    return;
  }
  setStatus('Reading ' + file.name + '...');
  var fd = new FormData();
  fd.append('file', file, file.name);
  call('inspect', fd)
    .then(function (res) {
      return res.json().then(function (b) {
        if (!res.ok) throw new Error((b && b.detail) || 'That blueprint could not be opened.');
        return b;
      });
    })
    .then(function (payload) {
      var d = makeDoc(file, payload);

      var anc = anchorDoc();
      d.mode = (anc && anc.payload.attachment && payload.attachment)
        ? 'attachment' : 'centre';
      state.docs.push(d);
      setActive(state.docs.length - 1);
      setStatus('Layered in ' + payload.name
        + '. It is the layer you are editing - use Move to drag it about.', 'ok');
    })
    .catch(function (err) { setStatus(err.message || String(err), 'error'); });
}

function removeLayer(i) {
  if (!state.docs[i] || state.docs.length < 2) return;
  if (i === state.anchor) {
    setStatus('That layer is the anchor everything else is placed against. Make '
      + 'another layer the anchor first.', 'error');
    return;
  }
  if (state.scene) state.scene.clearLayer(state.docs[i].id);
  state.docs.splice(i, 1);
  if (state.anchor > i) state.anchor--;
  setActive(Math.min(state.active, state.docs.length - 1));
}

function reorderLayer(i, dir) {
  var j = i + dir;
  if (i < 0 || j < 0 || i >= state.docs.length || j >= state.docs.length) return;
  var tmp = state.docs[i];
  state.docs[i] = state.docs[j];
  state.docs[j] = tmp;
  if (state.anchor === i) state.anchor = j;
  else if (state.anchor === j) state.anchor = i;
  setActive(state.active === i ? j : (state.active === j ? i : state.active));
}

function setAnchor(i) {
  if (!state.docs[i] || i === state.anchor) return;
  var world = state.docs.map(placement);
  state.anchor = i;
  state.docs.forEach(function (d, k) {
    if (k === i) { d.offset = [0, 0, 0]; return; }
    var here = world[k], there = world[i];
    if (!here || !there) { d.offset = [0, 0, 0]; return; }
    var base = alignOffset(d, d.mode) || [0, 0, 0];
    d.offset = [here[0] - there[0] - base[0],
                here[1] - there[1] - base[1],
                here[2] - there[2] - base[2]];
  });
  renderLayers();
  drawStack();
}

function nudgeActive(dx, dy, dz) {
  var d = active();
  if (!d) return;

  if (d === anchorDoc()) return;
  d.offset = [d.offset[0] + dx, d.offset[1] + dy, d.offset[2] + dz];
  renderLayers();
  drawStack();
}

function renderLayers() {
  if (!state.docs.length) return;
  var multi = state.docs.length > 1;

  $('bpe-unionblock').hidden = false;
  $('bpe-flatten').disabled = !multi;

  var rows = [];
  for (var i = state.docs.length - 1; i >= 0; i--) {
    var d = state.docs[i];
    var t = placement(d);
    var isAnchor = (i === state.anchor);
    rows.push('<li class="bpe-layerrow' + (i === state.active ? ' active' : '')
      + (isAnchor ? ' anchored' : '') + '">'
      + '<button type="button" class="bpe-layerpick" data-pick="' + i + '">'
      + '<strong>' + esc(d.payload.name) + '</strong><span>'
      + liveCountOf(d).toLocaleString() + ' voxels'
      + (isAnchor ? ' - anchor'
                  : (t ? ' at ' + t.join(', ') : ' - cannot line up this way'))
      + '</span></button>'
      + '<button type="button" class="bpe-layerbtn bpe-anchorbtn'
      + (isAnchor ? ' on' : '') + '" data-anchor="' + i + '" aria-pressed="' + isAnchor
      + '" aria-label="Use as the anchor"><i class="fa-solid fa-thumbtack"'
      + ' aria-hidden="true"></i></button>'
      + '<button type="button" class="bpe-layerbtn" data-vis="' + i
      + '" aria-label="Show or hide"' + (isAnchor ? ' disabled' : '')
      + '><i class="fa-solid fa-eye' + (d.visible ? '' : '-slash')
      + '" aria-hidden="true"></i></button>'
      + '<button type="button" class="bpe-layerbtn" data-up="' + i + '" aria-label="Move up"'
      + (i === state.docs.length - 1 ? ' disabled' : '') + '>&uarr;</button>'
      + '<button type="button" class="bpe-layerbtn" data-down="' + i + '" aria-label="Move down"'
      + (i === 0 ? ' disabled' : '') + '>&darr;</button>'
      + '<button type="button" class="bpe-layerbtn" data-drop="' + i
      + '" aria-label="Remove layer"' + (isAnchor ? ' disabled' : '')
      + '><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>'
      + '</li>');
  }
  $('bpe-layerlist').innerHTML = rows.join('');

  var a = active();
  var movable = a && a !== anchorDoc();
  $('bpe-movefold').hidden = !movable;
  $('bpe-movefold-label').textContent = 'Line it up';
  if (movable) { renderAlignModes(a); renderNudge(a); }

  var st = stackStats();
  $('bpe-layerinfo').textContent = multi
    ? ('Flattens to ' + st.total.toLocaleString() + ' voxels'
       + (st.hidden ? ' - ' + st.hidden.toLocaleString()
          + ' hidden underneath, still there until you download' : ''))
    : '';
  renderToolHint();
}

function liveCountOf(d) {
  var n = 0;
  for (var i = 0; i < d.payload.count; i++) if (d.payload.live[i]) n++;
  return n;
}

function renderAlignModes(d) {
  var modes = (anchorDoc() || state.docs[0]).payload.align_modes || [];
  $('bpe-align').innerHTML = modes.map(function (m) {
    return '<option value="' + m.mode + '"' + (m.mode === d.mode ? ' selected' : '')
      + '>' + esc(m.label) + '</option>';
  }).join('');
}

function renderNudge(d) {
  ['x', 'y', 'z'].forEach(function (a, i) {
    var v = d.offset[i];
    $('bpe-nudge-' + a).textContent = (v > 0 ? '+' : '') + v;
  });
}

function stackParts(fd) {
  if (state.docs.length < 2) return;
  var others = state.docs.filter(function (_, i) { return i !== state.anchor; });
  others.forEach(function (d) { fd.append('layers', d.file, d.file.name); });
  fd.append('stack', JSON.stringify(others.map(function (d) {
    return { mode: d.mode, offset: d.offset, edits: editListOf(d) };
  })));

  fd.append('anchor_at', String(state.anchor));
}

function anchorParts(fd) {
  var a = anchorDoc();
  fd.append('file', a.file, a.file.name);
  fd.append('edits', JSON.stringify(editListOf(a)));
}

function flattenStack() {
  if (state.docs.length < 2) return;
  setStatus('Unioning the layers...');
  var fd = new FormData();
  anchorParts(fd);
  stackParts(fd);
  call('flatten', fd)
    .then(function (res) {
      if (!res.ok) {
        return res.json().then(function (b) {
          throw new Error((b && b.detail) || 'The layers could not be unioned.');
        });
      }
      var summary = {};
      try { summary = JSON.parse(res.headers.get('X-Summary') || '{}'); } catch (e) {  }
      return res.blob().then(function (blob) { return { blob: blob, summary: summary }; });
    })
    .then(function (out) {
      var s = out.summary;
      var bits = [s.voxels.toLocaleString() + ' voxels from ' + ((s.layers || 0) + 1) + ' models'];
      if (s.hidden) bits.push(s.hidden.toLocaleString() + ' overlapping cell'
        + (s.hidden === 1 ? '' : 's') + ' went to the layer above');
      if (s.entities) bits.push(s.entities);
      var name = anchorDoc().file.name;
      openFile(new File([out.blob], name),
               'Unioned into one blueprint - ' + bits.join(' - ') + '.');
    })
    .catch(function (err) { setStatus(err.message || String(err), 'error'); });
}

function download(blob, filename) {
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
}

function exportQb() {
  if (!state.file) return;
  setStatus('Building the .qb files…');
  var fd = new FormData();
  anchorParts(fd);
  stackParts(fd);
  call('export-qb', fd)
    .then(function (res) {
      if (!res.ok) {
        return res.json().then(function (b) {
          throw new Error((b && b.detail) || 'The export failed.');
        });
      }
      var notes = [];
      try { notes = JSON.parse(res.headers.get('X-Notes') || '[]'); } catch (e) {  }
      return res.blob().then(function (blob) { return { blob: blob, notes: notes }; });
    })
    .then(function (out) {
      var stem = state.file.name.replace(/\.blueprint$/i, '') || 'model';
      download(out.blob, stem + '_qb.zip');

      setStatus(out.notes.length
        ? 'Exported four .qb files. ' + out.notes.join(' ')
        : 'Exported four .qb files — model, alpha, specular and type.', 'ok');
    })
    .catch(function (err) { setStatus(err.message || String(err), 'error'); });
}

function importQb(fileList) {
  var picked = Array.prototype.slice.call(fileList).filter(function (f) {
    return /\.qb$/i.test(f.name);
  });
  if (!picked.length) {
    setStatus('Pick a .qb file — and its _a / _s / _t maps too, if you have them.', 'error');
    return;
  }
  if (picked.length > 4) {
    setStatus('Send the model and up to three material maps.', 'error');
    return;
  }
  setStatus('Compiling ' + picked.length + ' .qb file' + (picked.length === 1 ? '' : 's') + '…');
  var fd = new FormData();
  picked.forEach(function (f) { fd.append('files', f, f.name); });
  call('import-qb', fd)
    .then(function (res) {
      if (!res.ok) {
        return res.json().then(function (b) {
          throw new Error((b && b.detail) || 'Those .qb files couldn’t be compiled.');
        });
      }
      var summary = {};
      try { summary = JSON.parse(res.headers.get('X-Summary') || '{}'); } catch (e) {  }
      return res.blob().then(function (blob) { return { blob: blob, summary: summary }; });
    })
    .then(function (out) {
      var base = picked.find(function (f) { return !/_[ast]\.qb$/i.test(f.name); }) || picked[0];
      var stem = base.name.replace(/\.qb$/i, '');
      var file = new File([out.blob], stem + '.blueprint');
      var s = out.summary;
      var bits = [];
      if (s.maps && s.maps.length) {
        bits.push('read the ' + s.maps.join(', ') + ' map' + (s.maps.length === 1 ? '' : 's'));
      } else {
        bits.push('no material maps were supplied, so everything is a rough solid');
      }
      if (s.attachment_source === 'marker') bits.push('found the attachment point');
      else if (s.attachment_source === 'offset') bits.push('took the attachment point from the matrix offset');

      else bits.push('no attachment marker, so it was centred — add a magenta '
        + '(255, 0, 255) voxel if it needs a specific grip point');
      var lossy = (s.unknown_type || 0) + (s.unknown_alpha || 0) + (s.unknown_specular || 0);
      if (lossy) bits.push(lossy.toLocaleString() + ' voxels had map colours outside the palette and fell back to defaults');

      openFile(file, 'Compiled — ' + bits.join('; ') + '.');
    })
    .catch(function (err) { setStatus(err.message || String(err), 'error'); });
}

function label(i) {
  var d = state.data, t = d.type[i], w = d.w[i];
  var pal = (d.palette.types || []).find(function (p) { return p.type === t; });
  if (!pal) {
    var known = (d.materials || []).find(function (m) { return m.type === t && m.w === w; });
    return known ? known.label : 'Unknown type ' + t;
  }
  var opt = (pal.options || []).find(function (o) { return o.w === w; });
  return pal.label + (opt ? ' · ' + opt.label : '');
}

var KIND_LABELS = {
  other: 'Not sure / something else', melee: 'Melee weapon', gun: 'Gun',
  staff: 'Staff', bow: 'Bow', spear: 'Spear', fist: 'Fist weapon',
  mask: 'Mask / face', hat: 'Hat', hair: 'Hair / helmet', deco: 'Decoration',
};

function renderKinds() {
  var types = state.data.creation_types || ['other'];

  types = types.slice().sort(function (a, b) {
    return (a === 'other' ? -1 : b === 'other' ? 1 : a.localeCompare(b));
  });
  $('bpe-kind').innerHTML = types.map(function (t) {
    return '<option value="' + t + '"' + (t === state.kind ? ' selected' : '') + '>'
      + esc(KIND_LABELS[t] || t) + '</option>';
  }).join('');
}

var SWATCH_KEY = 'trovebp.swatches';
var MAX_SWATCHES = 24;

function loadSwatches() {
  try {
    var v = JSON.parse(localStorage.getItem(SWATCH_KEY) || '[]');
    if (!Array.isArray(v)) return [];
    return v.filter(function (n) { return typeof n === 'number' && n >= 0 && n <= 0xFFFFFF; })
            .slice(0, MAX_SWATCHES);
  } catch (e) { return []; }
}

function storeSwatches() {
  try { localStorage.setItem(SWATCH_KEY, JSON.stringify(state.swatches)); } catch (e) {  }
}

function renderSwatches() {
  var el = $('bpe-swatches');
  if (!el) return;
  if (!state.swatches.length) {
    el.innerHTML = '<li class="bpe-swempty">'
      + 'Press + to keep a colour here.</li>';
    return;
  }
  el.innerHTML = state.swatches.map(function (rgb, i) {
    var h = hex(rgb).toUpperCase();

    var on = rgb === state.paint.rgb;
    return '<li class="bpe-sw' + (on ? ' bpe-sw-on' : '') + '">'
      + '<button type="button" class="bpe-swbtn" data-sw="' + i + '" style="background:' + h + '"'
      + ' aria-pressed="' + on + '" title="Paint with ' + h + '">'
      + '<span class="sr-only">' + h + '</span></button>'
      + '<button type="button" class="bpe-swx" data-swx="' + i + '"'
      + ' title="Remove ' + h + '" aria-label="Remove ' + h + '">&times;</button></li>';
  }).join('');
}

function syncPaintUI() {
  $('bpe-colour').value = hex(state.paint.rgb);
  $('bpe-colour-hex').textContent = hex(state.paint.rgb).toUpperCase();
  renderPalette();
  renderSwatches();
}

var NAV_KEY = 'trovebp.nav';
var NAV_DEFAULT = 'magicavoxel';
var NAV_INFO = {
  magicavoxel: {
    orbit: '<span data-i18n>Right-drag</span>',
    pan: '<span data-i18n>Middle-drag</span>',
    zoom: '<span data-i18n>Scroll</span>',
    turn: 'Right-drag turns the view.',
  },
  blender: {
    orbit: '<span data-i18n>Middle-drag</span>',
    pan: '<kbd>Shift</kbd> + <span data-i18n>middle-drag</span>',
    zoom: '<span data-i18n>Scroll</span>, <span data-i18n>or</span> <kbd>Ctrl</kbd> + <span data-i18n>middle-drag</span>',
    turn: 'Middle-drag turns the view.',
  },
  maya: {
    orbit: '<kbd>Alt</kbd> + <span data-i18n>drag</span>',
    pan: '<kbd>Alt</kbd> + <span data-i18n>middle-drag</span>',
    zoom: '<span data-i18n>Scroll</span>, <span data-i18n>or</span> <kbd>Alt</kbd> + <span data-i18n>right-drag</span>',
    turn: 'Alt-drag turns the view.',
  },
};

function loadNav() {
  try {
    var v = localStorage.getItem(NAV_KEY);
    return NAV_INFO[v] ? v : NAV_DEFAULT;
  } catch (e) { return NAV_DEFAULT; }
}

function setNav(name) {
  state.nav = NAV_INFO[name] ? name : NAV_DEFAULT;
  try { localStorage.setItem(NAV_KEY, state.nav); } catch (e) {  }
  if (state.scene) state.scene.setNavScheme(state.nav);
  renderNav();
  renderToolHint();
}

function renderNav() {
  var info = NAV_INFO[state.nav] || NAV_INFO[NAV_DEFAULT];
  ['orbit', 'pan', 'zoom'].forEach(function (k) {
    var el = $('bpe-nav-' + k);
    if (el) el.innerHTML = info[k];
  });

  document.querySelectorAll('[data-nav]').forEach(function (b) {
    var on = b.dataset.nav === state.nav;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  });

}

function dragModeFor(tool) {
  if (tool === 'move') return 'move';
  if (tool === 'select') return 'marquee';
  if (tool === 'paint' || tool === 'add' || tool === 'erase' || tool === 'box') return 'stroke';
  return '';
}

function onRect(cells, ev) {
  if (!state.data || state.tool !== 'select') return;
  var d = state.data, rows = [];
  cells.forEach(function (c) {
    var i = state.index.get(c.x + ',' + c.y + ',' + c.z);
    if (i !== undefined && d.live[i]) rows.push(i);
  });
  var add = !!(ev && ev.shiftKey);
  var sub = !!(ev && (ev.ctrlKey || ev.metaKey));
  if (!rows.length) {
    if (!add && !sub) clearSelection();
    setStatus('Nothing in that box.' + (state.slice.on ? ' The slice is on, so only its layer can be caught.' : ''));
    return;
  }
  if (sub) {
    if (state.sel) rows.forEach(function (i) { state.sel.delete(i); });
  } else if (add && state.sel) {
    rows.forEach(function (i) { state.sel.add(i); });
  } else {
    state.sel = new Set(rows);
  }
  if (state.sel && !state.sel.size) state.sel = null;
  afterSelection();
  var n = state.sel ? state.sel.size : 0;
  setStatus(rows.length.toLocaleString() + ' voxel' + (rows.length === 1 ? '' : 's')
    + (sub ? ' removed · ' : (add ? ' added · ' : ' caught · '))
    + n.toLocaleString() + ' selected.', 'ok');
}

function onStroke(phase) {

  if (state.tool === 'move') return;

  if (state.tool === 'box') {
    if (phase === 'start') cancelBox(); else commitBox();
    return;
  }
  if (phase === 'start') {
    state.stroke = [];
    state.strokeNormal = null;
    return;
  }
  var batch = state.stroke;
  state.stroke = null;
  state.strokeNormal = null;
  if (batch && batch.length) {
    state.history.push(batch);
    state.redo.length = 0;
    renderMaterialList();
    renderMeta();
    renderLayers();
    renderSelection();
    updateDirty();
    staleReport();
  }
}

var TOOL_ORDER = ['paint', 'pick', 'add', 'erase', 'move', 'select', 'box'];
var TOOL_KEYS = {
  paint: 'B', pick: 'I', add: 'A', erase: 'E', move: 'V', select: 'S', box: 'R',
};
var KEY_TOOL = (function () {
  var m = {};
  TOOL_ORDER.forEach(function (t, i) {
    m[TOOL_KEYS[t].toLowerCase()] = t;
    m[String(i + 1)] = t;
    m['m'] = 'select';
  });
  return m;
})();

function setTool(name) {
  if (!name || TOOL_ORDER.indexOf(name) < 0) return;
  state.tool = name;
  document.querySelectorAll('[data-tool]').forEach(function (o) {
    o.setAttribute('aria-pressed', String(o.dataset.tool === state.tool));
  });
  if (state.scene) state.scene.setDragMode(dragModeFor(state.tool));
  $('bpe-grabblock').hidden = state.tool !== 'select';
  $('bpe-boxblock').hidden = state.tool !== 'box';

  cancelBox();
  renderToolHint();
}

function labelToolKeys() {
  document.querySelectorAll('[data-tool]').forEach(function (b) {
    var key = TOOL_KEYS[b.dataset.tool];
    if (!key) return;
    var name = b.getAttribute('aria-label') || b.title;
    b.title = name + ' (' + key + ')';
  });
}

function renderToolHint() {

  var turn = ' ' + (NAV_INFO[state.nav] || NAV_INFO[NAV_DEFAULT]).turn;
  var hints = {
    paint: 'Click or drag across voxels to paint them.' + turn,
    pick: 'Click a voxel to copy its colour and material into the settings below.',
    add: 'Drag along a face to lay voxels against it.' + turn,
    erase: 'Click or drag across voxels to delete them.' + turn,
    move: 'Drag to slide this layer around.' + turn,
    select: 'Click a voxel, or drag a box across the model. Shift adds to the '
      + 'selection and Ctrl takes away. Everything else then works only where it lands.',
    box: 'Drag out a rectangle across one face to fill or clear it in one go. '
      + 'Turn on a slice first to work inside the model.',
  };
  var hint = hints[state.tool] || hints.paint;

  if (state.docs.length > 1 && active()) {
    hint += ' Working on ' + active().payload.name + '.';
  }
  if (state.tool === 'move' && active() === anchorDoc()) {
    hint = 'This layer is the anchor - the frame the others are placed against, so it '
      + 'does not move. Pick another layer, or pin a different one as the anchor.';
  }
  $('bpe-toolhint').textContent = hint;
  var faded = state.tool === 'erase' || state.tool === 'pick'
           || state.tool === 'move' || state.tool === 'select';
  ['bpe-paint-colour', 'bpe-paint-material'].forEach(function (id) {
    var el = $(id);
    if (el) el.classList.toggle('bpe-faded', faded);
  });

  var modes = $('bpe-modes');
  if (modes) modes.classList.toggle('bpe-faded', state.tool !== 'paint');

  var scopes = $('bpe-scopes');
  var single = state.tool === 'pick' || state.tool === 'add' || state.tool === 'move';
  if (scopes) scopes.classList.toggle('bpe-faded', single);
  var lbl = $('bpe-scope-label');
  if (lbl) lbl.classList.toggle('bpe-faded', single);
  renderScopeHint();
}

function renderScopeHint() {
  var el = $('bpe-scopehint');
  if (!el || !state.data) return;
  if (state.tool === 'pick' || state.tool === 'add' || state.scope === 'voxel') {
    el.textContent = '';
    el.hidden = true;
    return;
  }
  el.hidden = false;
  if (state.selection < 0) {
    el.textContent = state.scope === 'colour'
      ? 'Matches on the exact colour of whichever voxel you click.'
      : 'Matches on material — on a plain model that can be most of it.';
    return;
  }
  var n = targetsFor(state.selection).length;
  el.textContent = 'The selected voxel matches ' + n.toLocaleString()
    + (n === 1 ? ' voxel' : ' voxels') + '.';
}

function qbDot(o) {
  return o && o.qb
    ? '<span class="bpe-qbdot" style="background:' + esc(o.qb) + '" aria-hidden="true"></span>'
    : '';
}
function qbTitle(o) {
  return o && o.qb
    ? ' title="' + esc(o.qb.toUpperCase() + ' in the ' + (o.qb_map || '') + '.qb map') + '"'
    : '';
}

function renderPalette() {
  if (!state.data) return;
  var pal = state.data.palette;
  var html = (pal.types || []).map(function (p) {
    return '<button type="button" class="bpe-mat" data-type="' + p.type + '"'
      + ' aria-pressed="' + (state.paint.type === p.type) + '"'
      + qbTitle(p) + '>' + qbDot(p) + esc(p.label) + '</button>';
  }).join('');
  $('bpe-types').innerHTML = html;
  renderWOptions();
}

function renderWOptions() {
  if (!state.data) return;
  var pal = state.data.palette;
  var p = (pal.types || []).find(function (t) { return t.type === state.paint.type; });
  var opts = (p && p.options) || [];

  var single = opts.length < 2;
  $('bpe-finish-label').hidden = single;
  $('bpe-finish').hidden = single;
  if (!p) { $('bpe-finish').innerHTML = ''; return; }
  $('bpe-finish-label').textContent = p['class'] === 'glass' ? 'Opacity' : 'Finish';
  $('bpe-finish').innerHTML = opts.map(function (o) {
    return '<button type="button" class="bpe-w" data-w="' + o.w + '"'
      + ' aria-pressed="' + (state.paint.w === o.w) + '"'
      + qbTitle(o) + '>' + qbDot(o) + esc(o.label) + '</button>';
  }).join('');
}

function renderMaterialList() {
  var d = state.data;
  var seen = new Map();
  for (var i = 0; i < d.count; i++) {
    if (!d.live[i]) continue;
    var key = d.type[i] + ':' + d.w[i];
    var e = seen.get(key);
    if (e) { e.count++; e.colours.add(d.rgb[i]); }
    else {
      seen.set(key, { type: d.type[i], w: d.w[i], count: 1, i: i,
                      colours: new Set([d.rgb[i]]) });
    }
  }
  var rows = Array.from(seen.values()).sort(function (a, b) { return b.count - a.count; });
  $('bpe-materials').innerHTML = rows.map(function (r) {

    var canMaterial = !!d.edit[r.i], canColour = !!d.paint[r.i];
    var locked = !canMaterial && !canColour;
    var title = canMaterial && canColour ? 'Apply the current paint to all of these'
      : canColour ? 'These can be recoloured, but their material is fixed'
      : 'Their material can change, but Trove colours these itself';

    var cols = Array.from(r.colours);
    var swatch = cols.length === 1
      ? 'background:' + hex(cols[0])
      : 'background:linear-gradient(135deg,' + cols.slice(0, 3).map(function (c, k, a) {
          var from = Math.round(k / a.length * 100), to = Math.round((k + 1) / a.length * 100);
          return hex(c) + ' ' + from + '%,' + hex(c) + ' ' + to + '%';
        }).join(',') + ')';
    var colnote = cols.length > 1 ? ' · ' + cols.length + ' colours' : '';
    return '<li class="bpe-matrow' + (locked ? ' bpe-locked' : '') + '">'
      + '<span class="bpe-swatch" style="' + swatch + '" title="'
      + esc(cols.length === 1 ? hex(cols[0]).toUpperCase() : cols.length + ' different colours')
      + '"></span>'
      + '<span class="bpe-matname" title="' + esc(label(r.i) + colnote) + '">'
      + esc(label(r.i)) + '<small class="bpe-colnote">' + esc(colnote) + '</small></span>'
      + '<span class="bpe-matcount">' + r.count.toLocaleString() + '</span>'
      + (locked
          ? '<span class="bpe-lock" title="Controlled by the game — preserved on save">'
            + '<i class="fa-solid fa-lock" aria-hidden="true"></i></span>'
          : '<button type="button" class="bpe-applyall' + ((canMaterial && canColour) ? '' : ' bpe-partial')
            + '" data-type="' + r.type + '" data-w="' + r.w + '" title="' + esc(title) + '">Apply</button>')
      + '</li>';
  }).join('');
}

function renderMeta() {
  var s = state.data.stats;
  var live = liveCount();
  var bits = [
    live.toLocaleString() + ' voxels'
      + (live !== s.voxels ? ' (was ' + s.voxels.toLocaleString() + ')' : ''),
    'v' + state.data.version,
    state.data.size.join('×'),
  ];
  $('bpe-meta').textContent = bits.join(' · ');

  $('bpe-filename').textContent = state.data.name;

  var notes = [];
  if (s.placeholders) {
    notes.push(s.placeholders.toLocaleString() + ' deco placeholder'
      + (s.placeholders === 1 ? '' : 's') + ' — these mark where furniture goes'
      + ' and are kept exactly as they are.');
  }
  if (s.procedural) {
    notes.push(s.procedural.toLocaleString() + ' voxel'
      + (s.procedural === 1 ? ' is' : 's are') + ' coloured by the game at runtime'
      + ' (terrain and the like), so repainting them here would have no effect in game.');
  }
  var other = s.locked - s.placeholders;
  if (other > 0) {
    notes.push(other.toLocaleString() + (other === 1 ? ' more voxel uses a material' : ' more voxels use materials')
      + ' outside the modding palette and ' + (other === 1 ? 'is' : 'are') + ' preserved as-is.');
  }
  if (s.entities) {
    notes.push(s.entities.toLocaleString() + ' placed object'
      + (s.entities === 1 ? '' : 's') + ' travel with the model untouched.');
  }

  var a = state.data.attachment;
  if (a) {
    var outside = a[0] < 0 || a[1] < 0 || a[2] < 0
      || a[0] >= state.data.size[0] || a[1] >= state.data.size[1] || a[2] >= state.data.size[2];
    notes.push('Attaches at ' + a.join(', ') + (outside
      ? ' — outside the model, which is right for a hat or mask: the gap is where the head goes.'
      : ' — the pink marker in the view, where the game grips it.'));
  } else if (state.data.version !== 5) {
    notes.push('This is an older blueprint (v' + state.data.version + '), which stores no '
      + 'attachment point, so there is none to show.');
  }
  var box = $('bpe-notes');
  box.innerHTML = notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('');
  box.hidden = !notes.length;
}

function renderSelection() {
  var box = $('bpe-selection');
  var i = state.selection;
  renderScopeHint();
  if (i < 0 || !state.data) {
    box.innerHTML = '<p class="bpe-hint">Click a voxel to select it.</p>';
    return;
  }
  var d = state.data;

  var note = '';
  if (!d.edit[i] && !d.paint[i]) {
    note = 'The game controls this voxel’s colour and material. It’s saved exactly as it is.';
  } else if (!d.edit[i]) {
    note = 'You can recolour this voxel, but its material is one the game manages and is kept as-is.';
  } else if (!d.paint[i]) {
    note = 'Trove colours this voxel itself, so only its material can be changed here.';
  }
  box.innerHTML =
    '<div class="bpe-selrow"><span class="bpe-swatch" style="background:'
      + hex(d.rgb[i]) + '"></span>'
    + '<div><strong>' + esc(label(i)) + '</strong>'
    + '<span class="bpe-selcoords">' + d.x[i] + ', ' + d.y[i] + ', ' + d.z[i]
    + ' · ' + hex(d.rgb[i]).toUpperCase() + '</span></div></div>'
    + (note
        ? '<p class="bpe-hint bpe-warn"><i class="fa-solid fa-lock" aria-hidden="true"></i> '
          + esc(note) + '</p>'
        : '');
}

function updateDirty() {
  scheduleSave();
  var n = editList().length;
  $('bpe-save').disabled = false;
  var undoBtn = $('bpe-undo'), redoBtn = $('bpe-redo');
  undoBtn.disabled = !state.history.length;
  redoBtn.disabled = !state.redo.length;
  $('bpe-revert').disabled = !n;
  $('bpe-dirty').textContent = n
    ? n.toLocaleString() + ' voxel' + (n === 1 ? '' : 's') + ' changed'
    : 'No changes yet';
}

var DB_NAME = 'trovebp-editor', DB_STORE = 'sessions', DB_VERSION = 1;
var MAX_SESSIONS = 6;
var saveTimer = 0, dbPromise = null;

function idb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(function (resolve, reject) {
    if (!window.indexedDB) { reject(new Error('no indexedDB')); return; }
    var req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = function () {
      if (!req.result.objectStoreNames.contains(DB_STORE)) {
        req.result.createObjectStore(DB_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  }).catch(function (e) { dbPromise = null; throw e; });
  return dbPromise;
}

function idbDo(mode, fn) {
  return idb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(DB_STORE, mode);
      var req = fn(tx.objectStore(DB_STORE));
      tx.oncomplete = function () { resolve(req && req.result); };
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error); };
    });
  });
}

function bytesOf(file) {
  if (!file) return Promise.resolve(null);
  if (file._bytes) return Promise.resolve(file._bytes);
  return file.arrayBuffer().then(function (buf) {
    try { file._bytes = buf; } catch (e) {  }
    return buf;
  });
}

function reopenSpec() {
  var o = state.openWith;
  if (!o) return Promise.resolve(null);
  if (o.kind === 'game') {
    return Promise.resolve({ kind: 'game', prefab: o.prefab, label: o.label });
  }
  if (o.kind === 'files') {
    return Promise.all(o.files.map(function (f) {
      return bytesOf(f).then(function (b) { return { name: f.name, bytes: b }; });
    })).then(function (parts) { return { kind: 'files', parts: parts }; });
  }
  return bytesOf(o.file).then(function (b) {
    return { kind: o.kind, name: o.file.name, bytes: b };
  });
}

function docSnapshot(d) {
  return {
    path: d.path || '', name: d.file ? d.file.name : '',
    edits: editListOf(d),
    move: d.move.slice(), row: d.row.slice(), offset: d.offset.slice(),
    ap: d.ap, locked: !!d.locked, visible: d.visible !== false,
    added: !!d.added, mode: d.mode,
  };
}

function editedCount() {
  return state.docs.reduce(function (n, d) { return n + editListOf(d).length; }, 0);
}

function scheduleSave() {
  if (!state.docs.length || state.restoring) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSession, 900);
}

function saveSession() {
  if (!state.docs.length || state.restoring) return Promise.resolve();
  return reopenSpec().then(function (open) {
    if (!open) return null;
    var rec = {
      id: state.sessionId,
      savedAt: Date.now(),
      name: (state.docs[0].file || {}).name || 'blueprint',
      parts: state.docs.length,
      edited: editedCount(),
      open: open,
      docs: state.docs.map(docSnapshot),
      active: state.active, anchor: state.anchor,
    };
    return idbDo('readwrite', function (st) { st.put(rec); }).then(trimSessions);
  }).then(markSaved, function () {  });
}

function trimSessions() {
  return listSessions().then(function (all) {
    var extra = all.slice(MAX_SESSIONS);
    if (!extra.length) return null;
    return idbDo('readwrite', function (st) {
      extra.forEach(function (r) { st.delete(r.id); });
    });
  });
}

function listSessions() {
  return idbDo('readonly', function (st) { return st.getAll(); })
    .then(function (all) {
      return (all || []).sort(function (a, b) { return b.savedAt - a.savedAt; });
    })
    .catch(function () { return []; });
}

function dropSession(id) {
  return idbDo('readwrite', function (st) { st.delete(id); }).catch(function () {});
}

function markSaved() {
  var el = $('bpe-saved');
  if (!el) return;
  el.hidden = false;
  el.textContent = 'Saved in this browser';
}

function replayEdits(docu, edits) {
  var d = docu.payload;
  var cells = new Map();
  for (var i = 0; i < d.count; i++) cells.set(d.x[i] + ',' + d.y[i] + ',' + d.z[i], i);
  (edits || []).forEach(function (e) {
    var j;
    if (e.add) {
      var key = e.add.join(',');
      j = cells.get(key);
      if (j === undefined) {
        j = d.count;
        d.x.push(e.add[0]); d.y.push(e.add[1]); d.z.push(e.add[2]);
        d.rgb.push(0); d.type.push(21); d.w.push(0);
        d.kind.push(0); d.level.push(255); d.spec.push(0);
        d.edit.push(1); d.paint.push(1); d.live.push(1);
        docu.origin.push(-1);
        d.count = j + 1;
        cells.set(key, j);
      }
      d.live[j] = 1;
    } else {
      j = e.i;

      if (!(j >= 0 && j < d.count)) return;
      if (e.del) { d.live[j] = 0; return; }
    }
    if (e.rgb !== undefined) d.rgb[j] = e.rgb;
    if (e.type !== undefined) { d.type[j] = e.type; d.w[j] = e.w; }
    reshade(j, d);
  });
}

function applySnapshot(snaps) {
  var byKey = {};
  snaps.forEach(function (sn) { byKey[sn.path || sn.name] = sn; });
  state.docs.forEach(function (d) {
    var sn = byKey[d.path || (d.file && d.file.name)]
          || (snaps.length === 1 && state.docs.length === 1 ? snaps[0] : null);
    if (!sn) return;
    d.move = sn.move.slice(); d.row = sn.row.slice(); d.offset = sn.offset.slice();
    if (sn.ap !== undefined) d.ap = sn.ap;
    d.locked = sn.locked; d.visible = sn.visible; d.mode = sn.mode || d.mode;
    replayEdits(d, sn.edits);

    d.dirtyMesh = true;
  });
}

function restoreSession(rec) {
  var open = rec.open;
  if (!open) return;
  state.restoring = true;

  var done = function () {

    applySnapshot(rec.docs);
    var want = Math.min(rec.active || 0, state.docs.length - 1);
    state.anchor = Math.min(rec.anchor || 0, state.docs.length - 1);
    state.sessionId = rec.id;
    state.restoring = false;
    setActive(want);
    if (state.scene) state.scene.rebuild(liveView());
    drawStack();
    setStatus('Picked up where you left off — ' + rec.edited.toLocaleString()
      + ' change' + (rec.edited === 1 ? '' : 's') + ' restored. Undo starts fresh.', 'ok');
  };
  var fail = function (err) {
    state.restoring = false;
    setStatus((err && err.message) || 'That saved model could not be reopened.', 'error');
  };

  if (open.kind !== 'file') { fail(); return; }
  openFile(new File([open.bytes], open.name), null, done, fail);
}

function renderSessions() {
  var box = $('bpe-resume'), list = $('bpe-resumelist');
  if (!box || !list) return;
  listSessions().then(function (all) {
    box.hidden = !all.length;
    if (!all.length) return;
    list.innerHTML = all.map(function (r) {
      return '<li class="bpe-resumerow">'
        + '<button type="button" class="bpe-resumeopen" data-resume="' + esc(r.id) + '">'
        + '<span class="bpe-resumename">' + esc(r.name) + '</span>'
        + '<span class="bpe-resumemeta">' + esc(agoText(r.savedAt))
        + ' · ' + r.edited.toLocaleString() + ' change' + (r.edited === 1 ? '' : 's')
        + (r.parts > 1 ? ' · ' + r.parts + ' parts' : '') + '</span></button>'
        + '<button type="button" class="bpe-resumex" data-forget="' + esc(r.id) + '"'
        + ' title="Forget this" aria-label="Forget ' + esc(r.name) + '">&times;</button>'
        + '</li>';
    }).join('');
  });
}

function agoText(t) {
  var s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

function ready() {
  var input = $('bpe-input');
  $('bpe-open').addEventListener('click', function () { input.click(); });
  $('bpe-open2').addEventListener('click', function () { input.click(); });
  input.addEventListener('change', function () {
    if (input.files && input.files[0]) openFile(input.files[0]);
    input.value = '';
  });

  var drop = $('bpe-page');
  ['dragenter', 'dragover'].forEach(function (t) {
    drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('bpe-dragging'); });
  });
  ['dragleave', 'drop'].forEach(function (t) {
    drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('bpe-dragging'); });
  });

  drop.addEventListener('drop', function (e) {
    var dropped = e.dataTransfer && e.dataTransfer.files;
    if (!dropped || !dropped.length) return;
    var all = Array.prototype.slice.call(dropped);
    var qbs = all.filter(function (f) { return /\.qb$/i.test(f.name); });
    var bps = all.filter(function (f) { return /\.blueprint$/i.test(f.name); });
    if (qbs.length) importQb(qbs);
    else if (bps.length) openFile(bps[0]);
    else if (/\.qbcl$/i.test(all[0].name)) {
      setStatus('That’s a Qubicle project file, which holds several models at once. '
        + 'Export the model as .qb and drop that instead.', 'error');
    } else openFile(all[0]);
  });

  $('bpe-colour').addEventListener('input', function (e) {
    state.paint.rgb = unhex(e.target.value);
    $('bpe-colour-hex').textContent = hex(state.paint.rgb).toUpperCase();
    renderSwatches();
  });

  state.swatches = loadSwatches();
  renderSwatches();

  state.nav = loadNav();
  renderNav();
  $('bpe-swatch-add').addEventListener('click', function () {
    var rgb = state.paint.rgb;
    if (state.swatches.indexOf(rgb) >= 0) {
      setStatus(hex(rgb).toUpperCase() + ' is already in the palette.');
      return;
    }
    state.swatches.unshift(rgb);
    state.swatches.length = Math.min(state.swatches.length, MAX_SWATCHES);
    storeSwatches();
    renderSwatches();
  });

  $('bpe-swatches').addEventListener('click', function (e) {
    var x = e.target.closest('[data-swx]');
    if (x) {
      state.swatches.splice(parseInt(x.dataset.swx, 10), 1);
      storeSwatches();
      renderSwatches();
      return;
    }
    var b = e.target.closest('[data-sw]');
    if (!b) return;
    state.paint.rgb = state.swatches[parseInt(b.dataset.sw, 10)];
    syncPaintUI();
  });

  $('bpe-types').addEventListener('click', function (e) {
    var b = e.target.closest('.bpe-mat');
    if (!b) return;
    state.paint.type = parseInt(b.dataset.type, 10);
    state.paint.w = 0;
    renderPalette();
  });
  $('bpe-finish').addEventListener('click', function (e) {
    var b = e.target.closest('.bpe-w');
    if (!b) return;
    state.paint.w = parseInt(b.dataset.w, 10);
    renderWOptions();
  });

  labelToolKeys();
  document.querySelectorAll('[data-tool]').forEach(function (b) {
    b.addEventListener('click', function () { setTool(b.dataset.tool); });
  });

  $('bpe-boxmodes').addEventListener('click', function (e) {
    var b = e.target.closest('[data-boxmode]');
    if (!b) return;
    state.box.fill = b.dataset.boxmode === 'fill';
    Array.prototype.forEach.call(e.currentTarget.children, function (o) {
      o.setAttribute('aria-pressed', String(o.dataset.boxmode === b.dataset.boxmode));
    });
    drawBox();
  });

  $('bpe-slice-axes').addEventListener('click', function (e) {
    var b = e.target.closest('[data-slice]');
    if (!b || !state.data) return;
    var v = b.dataset.slice;
    setSlice(v === 'off' ? { on: false } : { on: true, axis: v });
  });
  $('bpe-slicebar').addEventListener('click', function (e) {
    var b = e.target.closest('[data-slicestep]');
    if (!b) return;
    setSlice({ at: state.slice.at + parseInt(b.dataset.slicestep, 10) });
  });
  $('bpe-slice-at').addEventListener('input', function (e) {
    setSlice({ at: parseInt(e.target.value, 10) || 0 });
  });

  renderSessions();
  $('bpe-resumelist').addEventListener('click', function (e) {
    var x = e.target.closest('[data-forget]');
    if (x) {
      dropSession(x.dataset.forget).then(renderSessions);
      return;
    }
    var b = e.target.closest('[data-resume]');
    if (!b) return;
    listSessions().then(function (all) {
      var rec = all.find(function (r) { return r.id === b.dataset.resume; });
      if (rec) restoreSession(rec);
    });
  });

  renderGrabs();
  $('bpe-grabs').addEventListener('click', function (e) {
    var b = e.target.closest('[data-grab]');
    if (!b) return;
    state.grab = b.dataset.grab;
    renderGrabs();
  });
  $('bpe-selclear').addEventListener('click', clearSelection);
  $('bpe-selout').addEventListener('click', function () {
    state.selOut = !state.selOut;
    renderSelectionBar();
  });
  $('bpe-selnudge').addEventListener('click', function (e) {
    var b = e.target.closest('[data-selnudge]');
    if (!b) return;
    var v = b.dataset.selnudge.split(',').map(Number);
    shiftSelection(v[0], v[1], v[2], $('bpe-selcopy').checked);
  });

  document.querySelectorAll('[data-mode]').forEach(function (b) {
    b.addEventListener('click', function () {
      state.mode = b.dataset.mode;
      document.querySelectorAll('[data-mode]').forEach(function (o) {
        o.setAttribute('aria-pressed', String(o.dataset.mode === state.mode));
      });
    });
  });
  document.querySelectorAll('[data-scope]').forEach(function (b) {
    b.addEventListener('click', function () {
      state.scope = b.dataset.scope;
      document.querySelectorAll('[data-scope]').forEach(function (o) {
        o.setAttribute('aria-pressed', String(o.dataset.scope === state.scope));
      });
      renderScopeHint();
    });
  });

  $('bpe-materials').addEventListener('click', function (e) {
    var b = e.target.closest('.bpe-applyall');
    if (!b || !state.data) return;
    var t = parseInt(b.dataset.type, 10), w = parseInt(b.dataset.w, 10);
    var c = change();
    if (!Object.keys(c).length) return;
    var batch = [], refused = 0, masked = 0;
    for (var i = 0; i < state.data.count; i++) {
      if (state.data.type[i] !== t || state.data.w[i] !== w) continue;
      if (!allowed(i)) { masked++; continue; }
      if (!applyTo(i, c, batch)) refused++;
    }
    commit(batch, refused);
    if (masked && !refused) {
      setStatus(masked.toLocaleString() + ' voxel' + (masked === 1 ? ' was' : 's were')
        + ' outside the selection and left alone.', 'ok');
    }
  });

  $('bpe-kind').addEventListener('change', function (e) {
    state.kind = e.target.value;
    staleReport();
  });
  $('bpe-check').addEventListener('click', runCheck);
  $('bpe-report').addEventListener('click', function (e) {
    var b = e.target.closest('.bpe-f-show');
    if (!b || !state.report) return;
    var f = state.report.findings[parseInt(b.dataset.finding, 10)];
    var already = b.classList.contains('active');
    [...document.querySelectorAll('.bpe-f-show')].forEach(function (o) {
      o.classList.remove('active');
    });
    if (already) {
      state.scene && state.scene.clearOverlay('lint');
    } else {
      b.classList.add('active');
      highlightFinding(f);
    }
  });
  $('bpe-show-attach').addEventListener('change', function (e) {
    state.showAttach = e.target.checked;
    drawAttachment();
  });

  var qbInput = $('bpe-qb-input');
  $('bpe-import-qb').addEventListener('click', function () { qbInput.click(); });
  $('bpe-import-qb2').addEventListener('click', function () { qbInput.click(); });
  qbInput.addEventListener('change', function () {
    if (qbInput.files && qbInput.files.length) importQb(qbInput.files);
    qbInput.value = '';
  });
  $('bpe-transforms').addEventListener('click', function (e) {
    var b = e.target.closest('.bpe-xform');
    if (b) runTransform(b.dataset.op);
  });
  var layerInput = $('bpe-layer-input');
  $('bpe-layer-open').addEventListener('click', function () { layerInput.click(); });
  layerInput.addEventListener('change', function () {
    if (layerInput.files && layerInput.files.length) {
      addLayer(layerInput.files[0]);
    }
    layerInput.value = '';
  });

  var keysDlg = $('bpe-keysdlg');
  keysDlg.addEventListener('click', function (e) {
    var b = e.target.closest('[data-nav]');
    if (b) setNav(b.dataset.nav);
  });

  keysDlg.addEventListener('keydown', function (e) {
    var b = e.target.closest && e.target.closest('[data-nav]');
    if (!b) return;
    var step = /Right|Down/.test(e.key) ? 1 : (/Left|Up/.test(e.key) ? -1 : 0);
    if (!step) return;
    e.preventDefault();
    var order = VoxelScene ? VoxelScene.SCHEMES : Object.keys(NAV_INFO);
    var at = order.indexOf(state.nav);
    setNav(order[(at + step + order.length) % order.length]);
    var next = keysDlg.querySelector('[data-nav="' + state.nav + '"]');
    if (next) next.focus();
  });
  $('bpe-keys').addEventListener('click', function () {

    if (keysDlg.showModal) keysDlg.showModal(); else keysDlg.setAttribute('open', '');
  });
  $('bpe-keys-close').addEventListener('click', function () { keysDlg.close(); });
  keysDlg.addEventListener('click', function (e) {
    if (e.target === keysDlg) keysDlg.close();
  });

  $('bpe-flatten').addEventListener('click', flattenStack);

  $('bpe-layerlist').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-pick],button[data-vis],button[data-up],' +
                             'button[data-down],button[data-drop],button[data-anchor],' +
                             'button[data-lock]');
    if (!b) return;
    var ds = b.dataset;
    if (ds.pick !== undefined) return setActive(+ds.pick);
    if (ds.anchor !== undefined) return setAnchor(+ds.anchor);
    if (ds.vis !== undefined) {
      var d = doc(+ds.vis);
      if (d) { d.visible = !d.visible; renderLayers(); drawStack(); }
      return;
    }
    if (ds.lock !== undefined) {
      var ld = doc(+ds.lock);
      if (ld) {
        ld.locked = !ld.locked;
        renderLayers();
        setStatus(ld.locked ? '' : ld.payload.name + ' can be moved now.', 'ok');
      }
      return;
    }
    if (ds.up !== undefined) return reorderLayer(+ds.up, 1);
    if (ds.down !== undefined) return reorderLayer(+ds.down, -1);
    if (ds.drop !== undefined) {
      return removeLayer(+ds.drop);
    }
  });

  $('bpe-align').addEventListener('change', function (e) {
    var d = active();
    if (!d) return;
    d.mode = e.target.value;
    d.offset = [0, 0, 0];
    renderLayers();
    drawStack();
  });
  $('bpe-nudge').addEventListener('click', function (e) {
    var b = e.target.closest('[data-nudge]');
    if (!b) return;
    var v = b.dataset.nudge.split(',').map(Number);
    nudgeActive(v[0], v[1], v[2]);
  });
  $('bpe-export-qb').addEventListener('click', exportQb);

  $('bpe-undo').addEventListener('click', undo);
  $('bpe-redo').addEventListener('click', redo);
  $('bpe-revert').addEventListener('click', revertAll);
  $('bpe-save').addEventListener('click', function () {
    save();
  });

  function typing(e) {
    var t = e.target || {};
    return /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '') || t.isContentEditable;
  }

  document.addEventListener('keydown', function (e) {
    if (!isActive()) return;
    var bare = !e.ctrlKey && !e.metaKey && !e.altKey;

    if (state.slice.on && state.data && bare && (e.key === '[' || e.key === ']')
        && !typing(e)) {
      e.preventDefault();
      setSlice({ at: state.slice.at + (e.key === ']' ? 1 : -1) });
      return;
    }

    if (state.data && bare && !typing(e)) {
      var want = KEY_TOOL[e.key.toLowerCase()];
      if (want) {
        e.preventDefault();
        setTool(want);
        setStatus('');
        return;
      }
    }

    if (!(e.ctrlKey || e.metaKey) || !state.data) return;
    var k = e.key.toLowerCase();

    if (k === 'z' && e.shiftKey) { e.preventDefault(); redo(); }
    else if (k === 'y') { e.preventDefault(); redo(); }
    else if (k === 'z') { e.preventDefault(); undo(); }
  });
}


// Start the editor; `active` says whether its page is showing, for the keyboard shortcuts.
export function initEditor(active) {
  if (active) isActive = active;
  ready();
}

export { openFile };
