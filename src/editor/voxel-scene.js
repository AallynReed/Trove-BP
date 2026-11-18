// The editor's 3D scene: picking, strokes, overlays, layers and camera schemes.
import { VoxelMesh } from '../viewer/voxel-mesh.js';
import { ViewerStage } from '../viewer/viewer-stage.js';


function loadThree() {
  return window.THREE ? Promise.resolve(window.THREE) : Promise.reject(new Error('3D library failed to load.'));
}

function create(opts) {
  return loadThree().then(function (THREE) { return build(THREE, opts); });
}

function build(THREE, opts) {
  var stage = opts.stage;
  var W = stage.clientWidth || 640, H = stage.clientHeight || 420;

  var renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(W, H);
  renderer.domElement.setAttribute('role', 'img');
  renderer.domElement.setAttribute('aria-label',
    'Interactive 3D voxel model. Drag to rotate, scroll to zoom.');
  stage.appendChild(renderer.domElement);

  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(42, W / H, 0.1, 8000);
  var el = renderer.domElement;

  var meshes = [];
  var modelGroup = new THREE.Group();
  scene.add(modelGroup);
  var data = null;
  var pivot = new THREE.Vector3();
  var modelR = 1;

  function disposeMeshes() {
    meshes.forEach(function (m) {
      modelGroup.remove(m);
      if (m.geometry) m.geometry.dispose();
      if (m.material) m.material.dispose();
    });
    meshes = [];
  }

  function rebuild(next, keepCamera) {
    data = next;
    disposeMeshes();
    meshes = VoxelMesh.build(THREE, data, {
      lightDir: [0.7, 1.0, 0.55],
      onReady: function () { request(); },
    });
    meshes.forEach(function (m) { modelGroup.add(m); });

    if (outlineColour != null) setModelOutline(outlineColour);

    if (!keepCamera) {

      var bounds = new THREE.Box3();
      meshes.forEach(function (m) { bounds.expandByObject(m); });
      if (bounds.isEmpty() && data.size) {
        bounds.set(new THREE.Vector3(0, 0, 0),
                   new THREE.Vector3(data.size[0], data.size[1], data.size[2]));
      }
      var bSize = bounds.getSize(new THREE.Vector3());
      modelR = Math.max(bSize.x, bSize.y, bSize.z) || 1;
      bounds.getCenter(pivot);
      sph.radius = modelR * 2.1;
    }
    request();
  }

  var target = new THREE.Vector3();
  var panX = 0, panY = 0;
  var sph = { radius: 2.1, theta: Math.PI * 0.27, phi: Math.PI * 0.36 };
  var dir = new THREE.Vector3(), bRight = new THREE.Vector3(), bUp = new THREE.Vector3();
  var WORLD_UP = new THREE.Vector3(0, 1, 0);

  function applyCamera() {
    var t = sph.theta, p = sph.phi;
    dir.set(Math.sin(p) * Math.sin(t), Math.cos(p), Math.sin(p) * Math.cos(t));
    bRight.crossVectors(WORLD_UP, dir).normalize();
    bUp.crossVectors(dir, bRight);
    target.copy(pivot).addScaledVector(bRight, panX).addScaledVector(bUp, panY);
    camera.position.copy(target).addScaledVector(dir, sph.radius);
    camera.lookAt(target);
  }

  var overlays = {};

  var FACES = [
    { n: [ 1, 0, 0], e: [1, 3, 3, 7, 7, 5, 5, 1] },
    { n: [-1, 0, 0], e: [0, 2, 2, 6, 6, 4, 4, 0] },
    { n: [ 0, 1, 0], e: [2, 3, 3, 7, 7, 6, 6, 2] },
    { n: [ 0,-1, 0], e: [0, 1, 1, 5, 5, 4, 4, 0] },
    { n: [ 0, 0, 1], e: [4, 5, 5, 7, 7, 6, 6, 4] },
    { n: [ 0, 0,-1], e: [0, 1, 1, 3, 3, 2, 2, 0] },
  ];

  function clearOverlay(key) {
    var o = overlays[key];
    if (!o) return;
    modelGroup.remove(o);
    o.children.forEach(function (c) { c.material.dispose(); });
    if (o.children[0]) o.children[0].geometry.dispose();
    delete overlays[key];
  }

  function setOverlay(key, points, colour, scale) {
    clearOverlay(key);
    if (!points || !points.length) { request(); return; }
    scale = scale || 1.06;
    var half = scale / 2;

    var i, filled = new Set(), pts = [];
    for (i = 0; i < points.length; i++) {
      var pk = points[i][0] + ',' + points[i][1] + ',' + points[i][2];
      if (filled.has(pk)) continue;
      filled.add(pk);
      pts.push(points[i]);
    }

    var edges = new Map();
    for (i = 0; i < pts.length; i++) {
      var vx = pts[i][0], vy = pts[i][1], vz = pts[i][2];
      for (var f = 0; f < 6; f++) {
        var F = FACES[f];
        if (filled.has((vx + F.n[0]) + ',' + (vy + F.n[1]) + ',' + (vz + F.n[2]))) continue;
        for (var e = 0; e < 8; e += 2) {
          var ca = F.e[e], cb = F.e[e + 1];
          var ax = vx + (ca & 1), ay = vy + (ca >> 1 & 1), az = vz + (ca >> 2 & 1);
          var bx = vx + (cb & 1), by = vy + (cb >> 1 & 1), bz = vz + (cb >> 2 & 1);
          var ka = ax + ',' + ay + ',' + az, kb = bx + ',' + by + ',' + bz;
          var k = ka < kb ? ka + '|' + kb : kb + '|' + ka;
          var rec = edges.get(k);
          if (rec) { rec.n++; if (rec.f !== f) rec.f = -1; continue; }
          edges.set(k, {
            f: f, n: 1,
            p: [vx + (ca & 1 ? half : -half), vy + (ca >> 1 & 1 ? half : -half),
                vz + (ca >> 2 & 1 ? half : -half),
                vx + (cb & 1 ? half : -half), vy + (cb >> 1 & 1 ? half : -half),
                vz + (cb >> 2 & 1 ? half : -half)],
          });
        }
      }
    }

    var kept = [];
    edges.forEach(function (r) { if (r.n !== 2 || r.f < 0) kept.push(r.p); });
    if (!kept.length) { request(); return; }
    var pos = new Float32Array(kept.length * 6);
    for (i = 0; i < kept.length; i++) pos.set(kept[i], i * 6);

    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));

    var group = new THREE.Group();
    [[true, 0.95], [false, 0.22]].forEach(function (pass) {
      var lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
        color: colour, transparent: true, opacity: pass[1], depthTest: pass[0],
      }));
      lines.renderOrder = pass[0] ? 5 : 4;
      group.add(lines);
    });
    modelGroup.add(group);
    overlays[key] = group;
    request();
  }

  var layers = {};

  function clearLayer(id) {
    var L = layers[id];
    if (!L) return;
    scene.remove(L.group);
    L.group.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    delete layers[id];
    request();
  }

  function clearLayers() {
    Object.keys(layers).forEach(clearLayer);
  }

  function setLayer(id, payload, colour, opts2) {
    clearLayer(id);
    if (!payload || !payload.count) { request(); return; }
    opts2 = opts2 || {};
    var group = new THREE.Group();
    var built = VoxelMesh.build(THREE, payload, {
      lightDir: [0.7, 1.0, 0.55],
      onReady: function () { request(); },
    });
    built.forEach(function (m) { group.add(m); });

    if (opts2.outline !== false) {
      var box = new THREE.Box3().setFromObject(group);
      if (!box.isEmpty()) {
        var helper = new THREE.Box3Helper(box, colour || 0x58a6ff);
        if (helper.material) {
          helper.material.depthTest = false;
          helper.material.transparent = true;
          helper.material.opacity = opts2.opacity == null ? 0.9 : opts2.opacity;
        }
        helper.renderOrder = 4;
        group.add(helper);
      }
    }
    scene.add(group);
    layers[id] = { group: group, meshes: built };
    request();
  }

  function moveLayer(id, x, y, z) {
    var L = layers[id];
    if (!L) return;
    L.group.matrixAutoUpdate = true;
    L.group.position.set(x, y, z);
    request();
  }

  function setLayerMatrix(id, m) {
    var L = layers[id];
    if (!L) return;
    L.group.matrixAutoUpdate = false;
    L.group.matrix.fromArray(m);
    L.group.matrixWorldNeedsUpdate = true;
    request();
  }

  function setModelMatrix(m) {
    if (!m) {
      modelGroup.matrixAutoUpdate = true;
      modelGroup.position.set(0, 0, 0);
      modelGroup.scale.set(1, 1, 1);
      modelGroup.quaternion.identity();
    } else {
      modelGroup.matrixAutoUpdate = false;
      modelGroup.matrix.fromArray(m);
      modelGroup.matrixWorldNeedsUpdate = true;
    }
    request();
  }

  var modelOutline = null, outlineColour = null;
  function setModelOutline(colour) {
    outlineColour = colour == null ? null : colour;
    if (modelOutline) {
      modelGroup.remove(modelOutline);
      modelOutline.geometry.dispose();
      modelOutline.material.dispose();
      modelOutline = null;
    }
    if (colour == null || !meshes.length) { request(); return; }
    var box = new THREE.Box3();
    meshes.forEach(function (m) { box.expandByObject(m); });
    if (box.isEmpty()) { request(); return; }
    modelOutline = new THREE.Box3Helper(box, colour);
    if (modelOutline.material) {
      modelOutline.material.depthTest = false;
      modelOutline.material.transparent = true;
      modelOutline.material.opacity = 0.75;
    }
    modelOutline.renderOrder = 4;
    modelGroup.add(modelOutline);
    request();
  }

  function frameAll() {
    scene.updateMatrixWorld(true);
    var box = new THREE.Box3();
    meshes.forEach(function (m) { box.expandByObject(m); });
    Object.keys(layers).forEach(function (k) {
      (layers[k].meshes || []).forEach(function (m) { box.expandByObject(m); });
    });
    if (box.isEmpty()) return;
    var size = box.getSize(new THREE.Vector3());
    modelR = Math.max(size.x, size.y, size.z) || 1;
    box.getCenter(pivot);
    sph.radius = modelR * 2.1;
    panX = 0; panY = 0;
    applyCamera();
    request();
  }

  var caster = new THREE.Raycaster(), ndc = new THREE.Vector2();
  var viewDir = new THREE.Vector3(), scratch = new THREE.Vector3();
  var anchor = null;

  function castAt(clientX, clientY) {
    var box = el.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    ndc.set(((clientX - box.left) / box.width) * 2 - 1,
            -((clientY - box.top) / box.height) * 2 + 1);
    camera.updateMatrixWorld();
    scene.updateMatrixWorld();
    caster.setFromCamera(ndc, camera);
    return caster.intersectObjects(meshes, false)[0] || null;
  }

  var _lp = new THREE.Vector3();

  var pickPlane = null;
  var _pray = new THREE.Ray(), _ppt = new THREE.Vector3();
  var _pn = new THREE.Vector3(), _plane = new THREE.Plane();

  function castPlane(clientX, clientY) {
    if (!pickPlane) return null;
    var box = el.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    ndc.set(((clientX - box.left) / box.width) * 2 - 1,
            -((clientY - box.top) / box.height) * 2 + 1);
    camera.updateMatrixWorld();
    modelGroup.updateMatrixWorld();
    caster.setFromCamera(ndc, camera);

    _pray.copy(caster.ray).applyMatrix4(_inv.copy(modelGroup.matrixWorld).invert());
    _pn.set(pickPlane.axis === 'x' ? 1 : 0,
            pickPlane.axis === 'y' ? 1 : 0,
            pickPlane.axis === 'z' ? 1 : 0);
    _plane.setFromNormalAndCoplanarPoint(_pn, _ppt.copy(_pn).multiplyScalar(pickPlane.at));
    if (!_pray.intersectPlane(_plane, _ppt)) return null;

    var away = _pray.direction.dot(_pn) > 0 ? -1 : 1;
    return {
      x: pickPlane.axis === 'x' ? pickPlane.at : Math.round(_ppt.x),
      y: pickPlane.axis === 'y' ? pickPlane.at : Math.round(_ppt.y),
      z: pickPlane.axis === 'z' ? pickPlane.at : Math.round(_ppt.z),
      nx: pickPlane.axis === 'x' ? away : 0,
      ny: pickPlane.axis === 'y' ? away : 0,
      nz: pickPlane.axis === 'z' ? away : 0,
      onPlane: true,
    };
  }

  var _inv = new THREE.Matrix4();

  function pick(e) {
    var hit = castAt(e.clientX, e.clientY);
    if (!hit || !hit.face) return castPlane(e.clientX, e.clientY);
    var n = hit.face.normal;
    modelGroup.updateMatrixWorld();
    _lp.copy(hit.point);
    modelGroup.worldToLocal(_lp);
    return {
      x: Math.round(_lp.x - n.x * 0.25),
      y: Math.round(_lp.y - n.y * 0.25),
      z: Math.round(_lp.z - n.z * 0.25),
      nx: Math.round(n.x), ny: Math.round(n.y), nz: Math.round(n.z),
    };
  }

  function pickLayer(e) {
    var hit = castLayers(e);
    return hit ? hit.id : null;
  }

  function castLayers(e) {
    var all = [];
    Object.keys(layers).forEach(function (id) {
      (layers[id].meshes || []).forEach(function (m) { all.push(m); });
    });
    if (!all.length) return null;
    var box = el.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    ndc.set(((e.clientX - box.left) / box.width) * 2 - 1,
            -((e.clientY - box.top) / box.height) * 2 + 1);
    camera.updateMatrixWorld();
    scene.updateMatrixWorld();
    caster.setFromCamera(ndc, camera);
    var hit = caster.intersectObjects(all, false)[0];
    if (!hit) return null;
    var found = null;
    Object.keys(layers).forEach(function (id) {
      if ((layers[id].meshes || []).indexOf(hit.object) >= 0) found = id;
    });
    return found ? { id: found, distance: hit.distance } : null;
  }

  function pickTop(e) {
    var near = castLayers(e);
    var mine = castAt(e.clientX, e.clientY);
    if (near && (!mine || near.distance < mine.distance)) {
      return { layer: near.id, voxel: null };
    }
    return { layer: null, voxel: mine ? pick(e) : null };
  }

  var _rp = new THREE.Vector3();
  function rectPick(x0, y0, x1, y1) {
    if (!data || !data.count) return [];
    var box = el.getBoundingClientRect();
    if (!box.width || !box.height) return [];
    camera.updateMatrixWorld();
    modelGroup.updateMatrixWorld();
    var lox = Math.min(x0, x1), hix = Math.max(x0, x1);
    var loy = Math.min(y0, y1), hiy = Math.max(y0, y1);
    var out = [];
    for (var i = 0; i < data.count; i++) {
      _rp.set(data.x[i], data.y[i], data.z[i])
         .applyMatrix4(modelGroup.matrixWorld).project(camera);
      if (_rp.z < -1 || _rp.z > 1) continue;
      var sx = box.left + (_rp.x + 1) * 0.5 * box.width;
      var sy = box.top + (1 - _rp.y) * 0.5 * box.height;
      if (sx >= lox && sx <= hix && sy >= loy && sy <= hiy) {
        out.push({ x: data.x[i], y: data.y[i], z: data.z[i] });
      }
    }
    return out;
  }

  var band = null, mx0 = 0, my0 = 0;
  function showBand(x1, y1) {
    if (!band) {
      band = document.createElement('div');
      band.className = 'vsc-marquee';
      stage.appendChild(band);
    }
    var box = stage.getBoundingClientRect();
    band.style.left = (Math.min(mx0, x1) - box.left) + 'px';
    band.style.top = (Math.min(my0, y1) - box.top) + 'px';
    band.style.width = Math.abs(x1 - mx0) + 'px';
    band.style.height = Math.abs(y1 - my0) + 'px';
    band.hidden = false;
  }
  function hideBand() { if (band) band.hidden = true; }

  var drag = 0, downBtn = 0, lx = 0, ly = 0, pinch = 0, moved = 0;

  var dragMode = '';
  var dragAccum = new THREE.Vector3();
  var strokeSeen = null;

  function rotate(dx, dy) {
    sph.theta -= dx * 0.01;
    sph.phi = Math.max(0.04, Math.min(Math.PI - 0.04, sph.phi - dy * 0.01));
  }
  function panDepth() {
    if (!anchor) return sph.radius;
    camera.getWorldDirection(viewDir);
    return Math.max(1e-6, scratch.copy(anchor).sub(camera.position).dot(viewDir));
  }
  function pan(dx, dy) {
    camera.updateMatrixWorld();
    var s = 2 * panDepth() * Math.tan(camera.fov * Math.PI / 360) / (stage.clientHeight || 1);
    panX -= dx * s;
    panY += dy * s;
  }
  function zoom(f) {
    sph.radius = Math.max(modelR * 0.2, Math.min(modelR * 9, sph.radius * f));
  }

  function dolly(dx, dy) { zoom(Math.exp((dy - dx) * 0.005)); }

  var NAV_SCHEMES = {

    magicavoxel: function (e) {
      if (e.button === 2) return 'orbit';
      if (e.button === 1) return 'pan';
      return '';
    },

    blender: function (e) {
      if (e.button !== 1) return '';
      if (e.shiftKey) return 'pan';
      if (e.ctrlKey || e.metaKey) return 'dolly';
      return 'orbit';
    },

    maya: function (e) {
      if (!e.altKey) return '';
      if (e.button === 0) return 'orbit';
      if (e.button === 1) return 'pan';
      if (e.button === 2) return 'dolly';
      return '';
    },
  };
  var navScheme = 'magicavoxel';

  function navFor(e) {
    var act = (NAV_SCHEMES[navScheme] || NAV_SCHEMES.magicavoxel)(e);
    if (act) return act;

    if (e.button === 0 && dragMode !== 'marquee') {
      if (e.ctrlKey || e.metaKey) return 'orbit';
      if (e.shiftKey) return 'pan';
    }
    if (e.button === 2) return 'pan';
    return '';
  }

  function beginDrag(e) {
    downBtn = e.button;
    lx = e.clientX; ly = e.clientY; moved = 0;
    stage.classList.add('vsc-grabbing');
    try { el.setPointerCapture(e.pointerId); } catch (err) {  }
    e.preventDefault();
  }

  function onDown(e) {
    if (e.pointerType === 'touch') return;

    if (e.button === 1) e.preventDefault();

    var nav = navFor(e);
    if (nav) {
      drag = nav === 'orbit' ? 1 : (nav === 'pan' ? 2 : 5);
      if (drag === 2) {
        var h = castAt(e.clientX, e.clientY);
        anchor = h && h.point ? h.point.clone() : null;
      }
      beginDrag(e);
      return;
    }

    if (e.button === 1) return;

    if (dragMode === 'marquee' && e.button === 0) {
      drag = 6;
      mx0 = e.clientX; my0 = e.clientY;
      beginDrag(e);
      return;
    }
    if (dragMode && e.button === 0) {
      drag = (dragMode === 'stroke') ? 4 : 3;
      dragAccum.set(0, 0, 0);
      beginDrag(e);

      if (drag === 3 && opts.onStroke) opts.onStroke('start');
      if (drag === 4) {

        strokeSeen = Object.create(null);
        if (opts.onStroke) opts.onStroke('start');
        strokeAt(e);
      }
      return;
    }

    drag = 1;
    beginDrag(e);
  }
  function onMove(e) {
    if (e.pointerType === 'touch') return;
    if (!drag) {
      if (opts.onHover) opts.onHover(pick(e), e);
      return;
    }
    var dx = e.clientX - lx, dy = e.clientY - ly;
    lx = e.clientX; ly = e.clientY;
    moved += Math.abs(dx) + Math.abs(dy);
    if (drag === 4) {

      var pts = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
      if (!pts.length) pts = [e];
      for (var pi = 0; pi < pts.length; pi++) strokeAt(pts[pi]);
      return;
    }
    if (drag === 3) { dragLayer(dx, dy); return; }

    if (drag === 6) { showBand(e.clientX, e.clientY); return; }
    if (drag === 5) dolly(dx, dy);
    else if (drag === 2) pan(dx, dy);
    else rotate(dx, dy);
    applyCamera(); request();
  }

  function dragLayer(dx, dy) {
    camera.updateMatrixWorld();
    var s = 2 * sph.radius * Math.tan(camera.fov * Math.PI / 360) / (stage.clientHeight || 1);

    if (opts.onDragWorld) {
      dragAccum.set(0, 0, 0).addScaledVector(bRight, dx * s).addScaledVector(bUp, -dy * s);
      opts.onDragWorld(dragAccum.x, dragAccum.y, dragAccum.z);
      return;
    }
    dragAccum.addScaledVector(bRight, dx * s).addScaledVector(bUp, -dy * s);
    var step = new THREE.Vector3(
      Math.round(dragAccum.x), Math.round(dragAccum.y), Math.round(dragAccum.z));
    if (step.x || step.y || step.z) {
      dragAccum.sub(step);
      if (opts.onDrag) opts.onDrag(step.x, step.y, step.z);
    }
  }

  function strokeAt(e) {
    var hit = pick(e);
    if (!hit) return;
    var key = hit.x + ',' + hit.y + ',' + hit.z + ':' + hit.nx + ',' + hit.ny + ',' + hit.nz;
    if (strokeSeen[key]) return;
    strokeSeen[key] = 1;
    if (opts.onPick) opts.onPick(hit, e);
  }

  function onUp(e) {
    if (drag === 4) {
      strokeSeen = null;
      if (opts.onStroke) opts.onStroke('end');
    }

    if (drag === 6) {
      hideBand();
      if (moved >= 4 && e && e.clientX !== undefined) {
        if (opts.onRect) opts.onRect(rectPick(mx0, my0, e.clientX, e.clientY), e);
        drag = 0; downBtn = 0; anchor = null; moved = 0;
        stage.classList.remove('vsc-grabbing');
        return;
      }
    }

    if (downBtn === 0 && drag !== 3 && drag !== 4 && moved < 4
        && opts.onPick && e && e.clientX !== undefined) {
      opts.onPick(pick(e), e);
    }
    drag = 0; downBtn = 0; anchor = null; moved = 0;
    stage.classList.remove('vsc-grabbing');
  }

  function onLeave() {
    if (!drag && opts.onHover) opts.onHover(null);
  }
  function onWheel(e) { e.preventDefault(); zoom(e.deltaY > 0 ? 1.12 : 0.89); applyCamera(); request(); }
  function dist(e) {
    var a = e.touches[0], b = e.touches[1];
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }
  function onTStart(e) {
    if (e.touches.length === 1) { drag = 1; lx = e.touches[0].clientX; ly = e.touches[0].clientY; moved = 0; }
    else if (e.touches.length === 2) { drag = 0; pinch = dist(e); }
  }
  function onTMove(e) {
    if (e.touches.length === 1 && drag === 1) {
      var t = e.touches[0];
      moved += Math.abs(t.clientX - lx) + Math.abs(t.clientY - ly);
      rotate(t.clientX - lx, t.clientY - ly);
      lx = t.clientX; ly = t.clientY; applyCamera(); request();
    } else if (e.touches.length === 2) {
      var d = dist(e);
      if (pinch) { zoom(pinch / d); applyCamera(); request(); }
      pinch = d;
    }
    e.preventDefault();
  }
  function onTEnd(e) {

    if (drag === 1 && moved < 6 && opts.onPick && e.changedTouches && e.changedTouches[0]) {
      opts.onPick(pick(e.changedTouches[0]), e);
    }
    drag = 0; pinch = 0; moved = 0;
  }
  function onResize() {
    var w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h) return;
    camera.aspect = w / h; camera.updateProjectionMatrix();
    renderer.setSize(w, h); request();
  }

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointerleave', onLeave);
  el.addEventListener('pointercancel', onUp);
  el.addEventListener('lostpointercapture', onUp);
  el.addEventListener('wheel', onWheel, { passive: false });
  el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  el.addEventListener('touchstart', onTStart, { passive: false });
  el.addEventListener('touchmove', onTMove, { passive: false });
  el.addEventListener('touchend', onTEnd);
  window.addEventListener('resize', onResize);

  var ro = null;
  if (window.ResizeObserver) {
    ro = new ResizeObserver(function () { onResize(); });
    ro.observe(stage);
  }

  var raf = 0, alive = true, pending = false;
  function renderOnce() { if (alive) renderer.render(scene, camera); }
  function request() {
    if (pending) return;
    pending = true;
    raf = requestAnimationFrame(function () { pending = false; renderOnce(); });
  }

  if (opts.data) rebuild(opts.data, false);
  applyCamera();
  request();

  var tools = ViewerStage.attach({
    stage: stage, canvas: el, render: renderOnce, name: opts.name || 'Model',

    scene: scene, focus: function () { return { center: pivot, radius: modelR }; },
  });

  return {
    rebuild: function (next) { rebuild(next, true); },
    reframe: function () { rebuild(data, false); applyCamera(); request(); },
    frameAll: frameAll,
    pick: pick,
    pickLayer: pickLayer,
    pickTop: pickTop,
    request: request,
    setOverlay: setOverlay,
    setLayer: setLayer,
    moveLayer: moveLayer,
    setLayerMatrix: setLayerMatrix,
    setModelMatrix: setModelMatrix,
    setModelOutline: setModelOutline,
    clearLayer: clearLayer,
    clearLayers: clearLayers,
    setDragMode: function (mode) { dragMode = mode || ''; },

    setNavScheme: function (name) {
      navScheme = NAV_SCHEMES[name] ? name : 'magicavoxel';
    },

    setPickPlane: function (p) { pickPlane = p || null; },
    setModelOffset: function (x, y, z) {
      modelGroup.matrixAutoUpdate = true;
      modelGroup.position.set(x, y, z);
      request();
    },
    clearOverlay: clearOverlay,

    resize: onResize,
    dispose: function () {
      alive = false; cancelAnimationFrame(raf);
      Object.keys(overlays).forEach(clearOverlay);
      setModelOutline(null);
      clearLayers();
      if (tools) tools.dispose();
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('lostpointercapture', onUp);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTStart);
      el.removeEventListener('touchmove', onTMove);
      el.removeEventListener('touchend', onTEnd);
      window.removeEventListener('resize', onResize);
      if (ro) { ro.disconnect(); ro = null; }
      disposeMeshes();
      renderer.dispose();
      if (band && band.parentNode) band.parentNode.removeChild(band);
      band = null;
      if (el.parentNode) el.parentNode.removeChild(el);
    },
  };
}

export var VoxelScene = { create: create, SCHEMES: ['magicavoxel', 'blender', 'maya'] };
