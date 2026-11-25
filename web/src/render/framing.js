// Framing QA (spec 2.14 / 4.I): how tall the hero is on screen and whether HUD panels cover it. Owner: WP6.
import * as THREE from 'three';
import { isOutlineMesh } from './debugViews.js';

const _box = new THREE.Box3(), _mb = new THREE.Box3(), _v = new THREE.Vector3();

/** World-space AABB of the posed hero (skinned bounds), outline hulls excluded. */
export function heroWorldBox(hero, target = new THREE.Box3()) {
  target.makeEmpty();
  hero.root.updateMatrixWorld(true);
  hero.root.traverse((o) => {
    if (!o.isMesh || !o.visible || isOutlineMesh(o) || o.userData.qaHelper) return;
    if (o.isSkinnedMesh) { o.computeBoundingBox(); _mb.copy(o.boundingBox).applyMatrix4(o.matrixWorld); }
    else { if (!o.geometry.boundingBox) o.geometry.computeBoundingBox(); _mb.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld); }
    target.union(_mb);
  });
  return target;
}

/**
 * @param {THREE.Camera} camera
 * @param {object} hero
 * @param {object} [o]
 * @param {number} [o.width=innerWidth] @param {number} [o.height=innerHeight]  CSS px of the canvas
 * @param {Element[]} [o.panels]  HUD elements to test for overlap
 * @returns {{ heightPct, rect:{x0,y0,x1,y1}, centreX, overlaps: string[] }}
 */
export function measureFraming(camera, hero, { width = innerWidth, height = innerHeight, panels = [] } = {}) {
  heroWorldBox(hero, _box);
  if (_box.isEmpty()) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < 8; i++) {
    _v.set(i & 1 ? _box.max.x : _box.min.x, i & 2 ? _box.max.y : _box.min.y, i & 4 ? _box.max.z : _box.min.z).project(camera);
    const sx = (_v.x * 0.5 + 0.5) * width, sy = (-_v.y * 0.5 + 0.5) * height;
    x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
  }
  // the AABB corners overstate the silhouette width for a rotated/side view; height is what 2.14 tests
  const overlaps = [];
  for (const el of panels) {
    if (!el || el.offsetParent === null) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0) continue;
    if (r.left < x1 && r.right > x0 && r.top < y1 && r.bottom > y0) overlaps.push(el.id || el.className);
  }
  return {
    heightPct: +(((y1 - y0) / height) * 100).toFixed(1),
    rect: { x0: Math.round(x0), y0: Math.round(y0), x1: Math.round(x1), y1: Math.round(y1) },
    centreX: Math.round((x0 + x1) / 2),
    worldHeight: +(_box.max.y - _box.min.y).toFixed(3),
    overlaps,
  };
}
