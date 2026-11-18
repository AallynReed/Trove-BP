// Orbit viewer for one voxel payload: drawn on demand; drag turns, right/shift-drag pans, wheel zooms.
import { VoxelMesh } from './voxel-mesh.js';
import { ViewerStage } from './viewer-stage.js';

export function buildViewer(stage, data, title) {
  var THREE = window.THREE;
  var W = stage.clientWidth || 800, H = stage.clientHeight || 560;
  var renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(W, H);
  renderer.domElement.setAttribute('role', 'img');
  renderer.domElement.setAttribute('aria-label', 'Interactive 3D voxel model. Drag to rotate, scroll to zoom.');
  renderer.domElement.appendChild(document.createTextNode('3D model preview (requires a WebGL-capable browser).'));
  stage.appendChild(renderer.domElement);

  var scene = new THREE.Scene();

  var camera = new THREE.PerspectiveCamera(42, W / H, 0.1, 8000);
  var meshes = VoxelMesh.build(THREE, data, {
    lightDir: [0.7, 1.0, 0.55],
    onReady: function () { request(); },
  });
  meshes.forEach(function (m) { scene.add(m); });

  var bounds = new THREE.Box3();
  meshes.forEach(function (m) { bounds.expandByObject(m); });
  if (bounds.isEmpty()) {
    bounds.set(new THREE.Vector3(0, 0, 0),
               new THREE.Vector3(data.size[0], data.size[1], data.size[2]));
  }
  var bSize = bounds.getSize(new THREE.Vector3());
  var modelR = Math.max(bSize.x, bSize.y, bSize.z) || 1;

  var pivot = bounds.getCenter(new THREE.Vector3());
  var target = new THREE.Vector3();
  var panX = 0, panY = 0;
  var sph = { radius: modelR * 2.1, theta: Math.PI * 0.27, phi: Math.PI * 0.36 };

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
  applyCamera();

  var el = renderer.domElement;
  var drag = 0, lx = 0, ly = 0, pinch = 0;
  function rotate(dx, dy) {
    sph.theta -= dx * 0.01;
    sph.phi = Math.max(0.04, Math.min(Math.PI - 0.04, sph.phi - dy * 0.01));
  }

  var caster = new THREE.Raycaster(), ndc = new THREE.Vector2();
  var viewDir = new THREE.Vector3(), scratch = new THREE.Vector3();
  var anchor = null;

  function grabAnchor(e) {
    anchor = null;
    var box = el.getBoundingClientRect();
    if (!box.width || !box.height) return;
    ndc.set(((e.clientX - box.left) / box.width) * 2 - 1,
            -((e.clientY - box.top) / box.height) * 2 + 1);
    camera.updateMatrixWorld();
    scene.updateMatrixWorld();
    caster.setFromCamera(ndc, camera);
    var hit = caster.intersectObjects(meshes, false)[0];
    if (hit && hit.point) anchor = hit.point.clone();
  }

  function panDepth() {
    if (!anchor) return sph.radius;
    camera.getWorldDirection(viewDir);
    return Math.max(1e-6, scratch.copy(anchor).sub(camera.position).dot(viewDir));
  }

  function pan(dx, dy) {
    camera.updateMatrixWorld();
    var s = 2 * panDepth() * Math.tan(camera.fov * Math.PI / 360) /
            (stage.clientHeight || 1);
    panX -= dx * s;
    panY += dy * s;
  }
  function zoom(f) { sph.radius = Math.max(modelR * 0.35, Math.min(modelR * 9, sph.radius * f)); }

  function onDown(e) {
    if (e.pointerType === 'touch') return;
    drag = (e.button === 2 || e.shiftKey) ? 2 : 1; lx = e.clientX; ly = e.clientY;
    if (drag === 2) grabAnchor(e);
    stage.classList.add('bpv-grabbing');
    try { el.setPointerCapture(e.pointerId); } catch (err) {  }
    e.preventDefault();
  }
  function onMove(e) {
    if (!drag || e.pointerType === 'touch') return;
    var dx = e.clientX - lx, dy = e.clientY - ly; lx = e.clientX; ly = e.clientY;
    if (drag === 2) pan(dx, dy); else rotate(dx, dy);
    applyCamera(); request();
  }
  function onUp() { drag = 0; anchor = null; stage.classList.remove('bpv-grabbing'); }
  function onWheel(e) { e.preventDefault(); zoom(e.deltaY > 0 ? 1.12 : 0.89); applyCamera(); request(); }
  function dist(e) { var a = e.touches[0], b = e.touches[1]; return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); }
  function onTStart(e) { if (e.touches.length === 1) { drag = 1; lx = e.touches[0].clientX; ly = e.touches[0].clientY; } else if (e.touches.length === 2) { drag = 0; pinch = dist(e); } }
  function onTMove(e) {
    if (e.touches.length === 1 && drag === 1) { var t = e.touches[0]; rotate(t.clientX - lx, t.clientY - ly); lx = t.clientX; ly = t.clientY; applyCamera(); request(); }
    else if (e.touches.length === 2) { var d = dist(e); if (pinch) { zoom(pinch / d); applyCamera(); request(); } pinch = d; }
    e.preventDefault();
  }
  function onTEnd() { drag = 0; pinch = 0; }
  function onResize() { var w = stage.clientWidth, h = stage.clientHeight; if (!w || !h) return; camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h); request(); }

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);

  el.addEventListener('pointercancel', onUp);
  el.addEventListener('lostpointercapture', onUp);
  el.addEventListener('wheel', onWheel, { passive: false });
  el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  el.addEventListener('touchstart', onTStart, { passive: false });
  el.addEventListener('touchmove', onTMove, { passive: false });
  el.addEventListener('touchend', onTEnd);
  window.addEventListener('resize', onResize);

  var raf = 0, alive = true, pending = false;
  function renderOnce() { if (alive) renderer.render(scene, camera); }
  function request() { if (pending) return; pending = true; raf = requestAnimationFrame(function () { pending = false; renderOnce(); }); }
  request();

  var tools = ViewerStage.attach({
    stage: stage, canvas: el, render: renderOnce, name: title,

    scene: scene, focus: function () { return { center: pivot, radius: modelR }; },
  });

  return {
    dispose: function () {
      alive = false; cancelAnimationFrame(raf);
      if (tools) tools.dispose();
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('lostpointercapture', onUp);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTStart);
      el.removeEventListener('touchmove', onTMove);
      el.removeEventListener('touchend', onTEnd);
      window.removeEventListener('resize', onResize);
      meshes.forEach(function (m) { if (m.geometry) m.geometry.dispose(); if (m.material) m.material.dispose(); });
      renderer.dispose();
      if (el.parentNode) el.parentNode.removeChild(el);
    }
  };
}
