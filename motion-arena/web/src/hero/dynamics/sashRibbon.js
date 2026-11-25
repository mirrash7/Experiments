// CPU ribbon driver for the verlet sash tails (WP5). Owner: WP5. Spec 2.6 / 2.12, QA r2 P1-4 / P2-4.
//
// The tails have no mesh of their own any more: the costume merges a static rest drape of both tails (topology from
// costume/ribbon.js) and hands that vertex range to this driver (`api.sash.ribbon`). Each frame the range is rewritten
// in HIPS-REST space (world result pushed through inverse(hips.matrixWorld · hipsBoneInverse)); the costume skins it
// 100% to hips while claimed. So the tails share the costume's draw, outline hull and single shadow draw: they cast a
// ground shadow again with the shadow pass still at 4 draws, and the main pass loses 2 draws.
// Look (costume/ribbon.js): wide soft cloth, deep wandering lengthwise folds, edge beads, progressive twist, slanted
// cut, and a curl across the width that cups the edges toward the body where the tail wraps a limb (from the chain's
// collider proximity); the twist relaxes there so an edge never turns into the leg.
// Ring frames: the flat side faces away from the nearest collider, blending from the knot's outward axis at the root.
// The knot axis and every per-particle normal are low-passed (40 ms) so a knot snap (fast pose change) never spins the
// ribbon edge-on for a few frames. No allocations per frame.
// Floor (QA r3 P0-1): `env.floorY` (world). Near the floor the ring normal blends to world up (the tail lies flat) and
// twist / curl / S-bend relax; after writing, every ring (incl. the cut-end cap corners) is lifted so its lowest vertex
// is >= floor + FLOOR_CLEAR, folded into the same per-ring push as the limb push-out (the limb pass runs after it, then
// the floor lift is re-asserted).

import * as THREE from 'three';
import { writeRibbonTail, ribbonProbes } from '../costume/ribbon.js';

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const _m = new THREE.Matrix4();
const _restHips = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _o = new THREE.Vector3();
const _mw = new THREE.Matrix4();
const _restHipsInv = new THREE.Matrix4();
const _n = new THREE.Vector3();
/** Probe clearance (m) for the ring push-out (measurePenetration uses margin 0, tolerance 2 mm). */
const PROBE_MARGIN = 0.0035;
/** Rendered ribbon floor clearance (m) and the particle height band (m above the floor) over which it lies down flat. */
const FLOOR_CLEAR = 0.006, FLOOR_BAND0 = 0.016, FLOOR_BAND1 = 0.07;

/**
 * tails: [{ chain: VerletChain }] in the slot layout's tail order.
 * opts: { rig, slot: api.sash.ribbon, knot: Object3D (child of hips), curl (1/m) }
 */
export function createSashRibbon(tails, { rig, slot, knot = null, curl = 4, twistRelax = 0.6, env = { floorY: -Infinity } }) {
  const L = slot.layout, geo = slot.geometry, base = slot.vertexStart;
  const hips = rig.all.hips;
  _restHips.makeTranslation(rig.restWorld.hips.x, rig.restWorld.hips.y, rig.restWorld.hips.z);
  _restHipsInv.copy(_restHips).invert();
  const probes = ribbonProbes();
  const pushW = new Float32Array(L.tails.reduce((m, t) => Math.max(m, t.R), 0) * 3);   // world push per ring
  const floorW = new Float32Array(pushW.length / 3);                                     // world floor lift per ring
  const buf = { pos: geo.attributes.position.array, nrm: geo.attributes.normal.array, onrm: geo.attributes.outlineNormal.array };
  const T = tails.map((t, i) => {
    const n = t.chain.n;
    return { chain: t.chain, lt: L.tails[i], n, P: new Float32Array(n * 3), N: new Float32Array(n * 3), curl: new Float32Array(n), twK: new Float32Array(n), Nv: false };
  });
  const Z = new THREE.Vector3(0, 0, 1);
  const out = knot ? Z.clone().applyQuaternion(knot.quaternion) : Z.clone();
  let outValid = false;
  const e = _m.elements;
  const UPLOAD = ['position', 'normal', 'outlineNormal'];
  const stats = { vertices: L.nv, tris: L.ni / 3, probedRings: 0, pushedRings: 0, floorRings: 0 };   // QA counters (cumulative)
  slot.claim(true);

  /** Rebuild the ribbon. dt drives the normal / knot-axis smoothing. */
  function update(dt) {
    _m.copy(hips.matrixWorld).invert().premultiply(_restHips);    // world -> hips-rest space
    const sc = Math.hypot(e[0], e[1], e[2]) || 1;                 // 1/worldScale
    const kN = outValid ? 1 - Math.exp(-Math.max(dt, 0) / 0.04) : 1;
    if (knot) {
      _o.copy(Z).applyQuaternion(knot.quaternion);
      out.lerp(_o, kN).normalize();
      outValid = true;
    }
    const fy = env.floorY, hasFloor = fy > -1e8;
    // world up in hips-rest space (rotation part of _m, unscaled)
    const ux = e[4] / sc, uy = e[5] / sc, uz = e[6] / sc;
    for (const t of T) {
      const ch = t.chain, n = t.n, P = t.P, N = t.N, x = ch.x;
      for (let i = 0; i < n; i++) {
        const j = i * 3;
        _v.set(x[j], x[j + 1], x[j + 2]).applyMatrix4(_m);
        P[j] = _v.x; P[j + 1] = _v.y; P[j + 2] = _v.z;
        // desired outward normal: knot axis at the root -> away from the nearest collider when close
        const s = i / (n - 1);
        const prox = 1 - smooth(0.012, 0.09, ch.cd[i] / sc);
        const b = i === 0 ? 0 : smooth(0, 0.15, s) * prox;
        let nx = ch.cn[j], ny = ch.cn[j + 1], nz = ch.cn[j + 2];
        const rx = (e[0] * nx + e[4] * ny + e[8] * nz) / sc, ry = (e[1] * nx + e[5] * ny + e[9] * nz) / sc, rz = (e[2] * nx + e[6] * ny + e[10] * nz) / sc;
        nx = out.x + (rx - out.x) * b; ny = out.y + (ry - out.y) * b; nz = out.z + (rz - out.z) * b;
        // lying on the floor: flat side down (normal -> up, keeping the side it already faces), no twist / curl / bend
        const fl = hasFloor && i > 0 ? 1 - smooth(FLOOR_BAND0, FLOOR_BAND1, x[j + 1] - fy) : 0;
        if (fl > 0) {
          const sg = nx * ux + ny * uy + nz * uz < 0 ? -1 : 1;
          nx += (sg * ux - nx) * fl; ny += (sg * uy - ny) * fl; nz += (sg * uz - nz) * fl;
        }
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l; ny /= l; nz /= l;
        const cu = curl * b * (1 - fl), tk = (1 - twistRelax * prox) * (1 - fl);
        if (!t.Nv) { N[j] = nx; N[j + 1] = ny; N[j + 2] = nz; t.curl[i] = cu; t.twK[i] = tk; } else {
          N[j] += (nx - N[j]) * kN; N[j + 1] += (ny - N[j + 1]) * kN; N[j + 2] += (nz - N[j + 2]) * kN;
          t.curl[i] += (cu - t.curl[i]) * kN;
          t.twK[i] += (tk - t.twK[i]) * kN;
        }
      }
      t.Nv = true;
      writeRibbonTail(L, t.lt, P, N, n, t.curl, t.twK, out, buf, base);
      pushOut(t, sc, hasFloor ? fy + FLOOR_CLEAR : -Infinity);
    }
    slot.upload(UPLOAD);
  }

  /**
   * Zero-penetration guarantee for the WIDE ribbon (the chain only collides its centre line): probe the body-side
   * points of every ring against the chain's active colliders (current frame) and move the whole ring out along the
   * collider normal by the deepest violation (the pushes are millimetres; no neighbour smoothing, which could push a
   * ring into a different limb).
   */
  function pushOut(t, sc, floor) {
    const ch = t.chain, cols = ch.active, nc = ch.activeN, lt = t.lt, R = lt.R, S = L.S, pos = buf.pos, n = t.n, cd = ch.cd;
    _mw.copy(hips.matrixWorld).multiply(_restHipsInv);
    // floor: lowest world y of each ring (side vertices + its cap at the ends) -> lift
    const me = _mw.elements, m1 = me[1], m5 = me[5], m9 = me[9], m13 = me[13];
    let anyF = false;
    for (let r = 0; r < R; r++) {
      floorW[r] = 0;
      if (!(floor > -1e8)) continue;
      let lo = Infinity;
      const v0 = base + lt.side0 + r * S;
      for (let k = 0; k < S; k++) { const o = (v0 + k) * 3, y = m1 * pos[o] + m5 * pos[o + 1] + m9 * pos[o + 2] + m13; if (y < lo) lo = y; }
      if (r === 0 || r === R - 1) {
        const cb = base + (r === 0 ? lt.cap0 : lt.cap1);
        for (let k = 0; k <= S; k++) { const o = (cb + k) * 3, y = m1 * pos[o] + m5 * pos[o + 1] + m9 * pos[o + 2] + m13; if (y < lo) lo = y; }
      }
      if (lo < floor) { floorW[r] = floor - lo; anyF = true; stats.floorRings++; }
    }
    if (!nc && !anyF) return;
    // a ring can only touch a limb if its centre is within its half extent (+ the chain margin already in cd)
    const reach = (Math.max(lt.w0, lt.w1) / 2 + lt.edge + PROBE_MARGIN + 0.006) * (1 / sc) - ch.o.margin;
    let any = false;
    for (let r = 0; r < R; r++) {
      let px = 0, py = floorW[r], pz = 0;
      pushW[r * 3] = 0; pushW[r * 3 + 1] = py; pushW[r * 3 + 2] = 0;
      if (py) any = true;
      let i1 = Math.floor((r / (R - 1)) * (n - 1)); if (i1 > n - 2) i1 = n - 2;
      if (!nc || Math.min(cd[i1], cd[i1 + 1]) > reach) continue;
      const vb = base + lt.side0 + r * S;
      // up to 3 passes: a push out of one limb (or for one probe) can move another probe into the wedge of an
      // overlapping collider (thigh capsule / fur torus)
      for (let pass = 0; pass < 3; pass++) {
        let moved = false;
        for (let q = 0; q < probes.length; q++) {
          const o = (vb + probes[q]) * 3;
          _v.set(pos[o], pos[o + 1], pos[o + 2]).applyMatrix4(_mw);
          let x = _v.x + px, y = _v.y + py, z = _v.z + pz;
          for (let c = 0; c < nc; c++) {
            const d = cols[c].sdf(x, y, z, pass ? PROBE_MARGIN * 1.5 : PROBE_MARGIN, _n);
            if (d < 0) { px -= _n.x * d; py -= _n.y * d; pz -= _n.z * d; x -= _n.x * d; y -= _n.y * d; z -= _n.z * d; moved = true; }
          }
        }
        if (!moved) break;
      }
      if (floorW[r] > 0 && py < floorW[r]) py = floorW[r];        // a limb never pushes a floor ring back under it
      pushW[r * 3] = px; pushW[r * 3 + 1] = py; pushW[r * 3 + 2] = pz;
      if (px || py !== floorW[r] || pz) { any = true; stats.pushedRings++; }
      stats.probedRings++;
    }
    if (!any) return;
    for (let r = 0; r < R; r++) {
      const wx = pushW[r * 3], wy = pushW[r * 3 + 1], wz = pushW[r * 3 + 2];
      if (!wx && !wy && !wz) continue;
      // world vector -> hips-rest (rotation + 1/scale of _m)
      const dx = e[0] * wx + e[4] * wy + e[8] * wz, dy = e[1] * wx + e[5] * wy + e[9] * wz, dz = e[2] * wx + e[6] * wy + e[10] * wz;
      const v0 = base + lt.side0 + r * S;
      for (let k = 0; k < S; k++) { const o = (v0 + k) * 3; pos[o] += dx; pos[o + 1] += dy; pos[o + 2] += dz; }
      if (r === 0 || r === R - 1) {
        const cb = base + (r === 0 ? lt.cap0 : lt.cap1);
        for (let k = 0; k <= S; k++) { const o = (cb + k) * 3; pos[o] += dx; pos[o + 1] += dy; pos[o + 2] += dz; }
      }
    }
    void sc;
  }

  return {
    meshes: [], geometry: geo, vertexStart: base, vertexCount: slot.vertexCount, update,
    /** Drop the normal / curl / twist smoothing (the chains were re-draped: reset or teleport), next update snaps. */
    snap() { for (const t of T) t.Nv = false; outValid = false; },
    stats,
    dispose() { slot.claim(false); },
  };
}
