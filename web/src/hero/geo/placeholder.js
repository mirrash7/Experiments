// WP0 placeholder primitives (used only by the stub builders; packages may delete their use of it).
import * as THREE from 'three';

/**
 * Closed lathe tube along an axis. profile = [[s, r], ...] with s = distance along the axis (ascending),
 * r = radius; poles are added automatically at both ends. Returns geometry in root space:
 * axis 'x+' | 'x-' | 'y+' | 'y-' | 'z+', starting at `origin`. scale = [sx, sz] squash of the cross-section
 * applied before orientation (on lathe X/Z).
 */
export function latheTube(profile, { origin = [0, 0, 0], axis = 'y+', radial = 16, scale = [1, 1] } = {}) {
  const pts = [new THREE.Vector2(0, profile[0][0])];
  for (const [s, r] of profile) pts.push(new THREE.Vector2(Math.max(r, 1e-4), s));
  pts.push(new THREE.Vector2(0, profile[profile.length - 1][0]));
  const g = new THREE.LatheGeometry(pts, radial);
  g.scale(scale[0], 1, scale[1]);
  if (axis === 'x+') g.rotateZ(-Math.PI / 2);
  else if (axis === 'x-') g.rotateZ(Math.PI / 2);
  else if (axis === 'y-') g.rotateZ(Math.PI);
  else if (axis === 'z+') g.rotateX(Math.PI / 2);
  g.translate(...origin);
  g.computeVertexNormals();
  return g;
}

/** Ellipsoid centred at c with radii r. */
export function ellipsoid(c, r, w = 24, h = 16) {
  const g = new THREE.SphereGeometry(1, w, h);
  g.scale(...r);
  g.translate(...c);
  return g;
}

/** Torus around the Y axis (ring in the XZ plane) at centre c; sz squashes depth. */
export function ringY(c, R, tube, { sz = 1, radial = 10, tubular = 32 } = {}) {
  const g = new THREE.TorusGeometry(R, tube, radial, tubular);
  g.rotateX(Math.PI / 2);
  g.scale(1, 1, sz);
  g.translate(...c);
  return g;
}

/** Axis-aligned box from min to max corner. */
export function boxMinMax(min, max) {
  const g = new THREE.BoxGeometry(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  g.translate((max[0] + min[0]) / 2, (max[1] + min[1]) / 2, (max[2] + min[2]) / 2);
  return g;
}
