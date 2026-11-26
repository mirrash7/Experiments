// Move-detection robustness bench: drives an ActionDetector with a scripted, randomised session of every game move
// under realistic single-webcam noise, on a simulated clock, and reports per move: detection rate, phantom events
// and detection delay (event capture time - motion start). Used by triggerTest.js (node) and lab.moveBench().
//
// Noise model (monocular trackers): anisotropic gaussian keypoint noise, x/y sxy (1-2 cm) and depth sz (3-8 cm),
// the depth part half white / half slowly wandering (AR(1), rho 0.85: monocular depth wobbles over several frames);
// frame interval jitter +-12 %; whole dropped frames; short limb occlusions (a chain's confidence falls to 0.1-0.3
// for 1-5 frames while its position freezes or jumps by up to 12 cm). Optional upper-body framing (no legs tracked).
//
// Moves (each starts and ends in the fighting guard, randomised per rep):
//   punchLeft/punchRight  straight punches, varied target (lane offset, height, reach 0.48-0.64 m), speed (out
//                         0.08-0.16 s), shoulder drive and rear-arm pull back
//   kickLeft/kickRight    the synthetic front kick + a balancing arm swing (front arm drives forward-down, the
//                         other swings back: the phantom-punch case), amplitude 0-1
//   jump                  the synthetic jump; arms overhead or swung forward-up at take-off
//   duck                  hip squat (synthetic), or a waist bend / head bob (hips barely drop)
//   duckHead              waist bend / bob only, with the legs untracked
//   dodgeLeft/Right       upper-body lean 0.3-0.5 rad held 0.5 s
//   guard                 both fists to the face, held 0.8 s
//   charge                both hands overhead (fast raise) held 1.2 s
//   chargeClipped         same, wrists out of the top of the frame (confidence 0.1, extrapolated positions)
//   idle / tpose / wave   negatives: nothing may fire
import * as THREE from 'three';
import { SyntheticSource } from '../sources/syntheticSource.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const ARM = [0.28, 0.27];
const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function limb(a, c, [l1, l2], pole) {
  const d = c.clone().sub(a); let L = d.length();
  const max = (l1 + l2) * 0.999;
  if (L > max) { d.multiplyScalar(max / L); c.copy(a).add(d); L = max; }
  d.normalize();
  const n = pole.clone().addScaledVector(d, -pole.dot(d)).normalize();
  const cosA = Math.min(1, Math.max(-1, (l1 * l1 + L * L - l2 * l2) / (2 * l1 * L)));
  return a.clone().addScaledVector(d, l1 * cosA).addScaledVector(n, l1 * Math.sqrt(1 - cosA * cosA));
}
const UPPER = ['leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow', 'leftWrist', 'rightWrist', 'leftHand', 'rightHand', 'neck', 'nose', 'leftEar', 'rightEar'];
const LEGS = ['leftKnee', 'rightKnee', 'leftAnkle', 'rightAnkle', 'leftHeel', 'rightHeel', 'leftToe', 'rightToe'];
const CHAINS = [['leftElbow', 'leftWrist', 'leftHand'], ['rightElbow', 'rightWrist', 'rightHand'],
  ['leftKnee', 'leftAnkle', 'leftHeel', 'leftToe'], ['rightKnee', 'rightAnkle', 'rightHeel', 'rightToe'], ['nose', 'leftEar', 'rightEar']];

export const BENCH_MOVES = ['punchLeft', 'punchRight', 'kickLeft', 'kickRight', 'jump', 'duck', 'duckHead', 'dodgeLeft', 'dodgeRight',
  'guard', 'charge', 'chargeClipped', 'idle', 'tpose', 'wave'];
const UPPER_MOVES = ['punchLeft', 'punchRight', 'duckHead', 'dodgeLeft', 'dodgeRight', 'guard', 'charge', 'chargeClipped', 'idle', 'tpose', 'wave'];
/** Events that count as phantoms when not expected (impulses + the held moves that trigger notes). */
const PHANTOM = ['punchLeft', 'punchRight', 'kickLeft', 'kickRight', 'jump', 'squat', 'handsUp'];

function setWrist(out, side, w, pole, shoulder = null) {
  const J = out.joints;
  if (shoulder) J[side + 'Shoulder'] = shoulder;
  const S = J[side + 'Shoulder'];
  const old = J[side + 'Wrist'].clone();
  J[side + 'Elbow'] = limb(S, w, ARM, pole);
  J[side + 'Wrist'] = w;
  J[side + 'Hand'] = w.clone().add(w.clone().sub(J[side + 'Elbow']).normalize().multiplyScalar(0.09));
  const d = w.clone().sub(old);
  for (const k of [side + 'Index', side + 'Pinky']) if (out.extra[k]) out.extra[k].add(d);
}
function rotUpper(out, axis, ang) {   // rotate the upper body about the hip centre
  const J = out.joints, c = J.leftHip.clone().add(J.rightHip).multiplyScalar(0.5);
  const q = new THREE.Quaternion().setFromAxisAngle(axis, ang);
  for (const n of UPPER) if (J[n]) J[n].sub(c).applyQuaternion(q).add(c);
  for (const n of Object.keys(out.extra)) out.extra[n].sub(c).applyQuaternion(q).add(c);
}

/** Blend both arms of `out` from the guard pose `g` (k = 0) to their pose in `out` (k = 1): no teleporting arms. */
function blendArms(out, g, k) {
  if (k >= 1) return;
  for (const s of ['left', 'right']) {
    const sg = s === 'left' ? 1 : -1, J = out.joints;
    const w = g.joints[s + 'Wrist'].clone().lerp(J[s + 'Wrist'], k);
    // pole: from the guard's elbow-down to the target elbow side
    const S = J[s + 'Shoulder'], E = J[s + 'Elbow'], W = J[s + 'Wrist'];
    const d = W.clone().sub(S).normalize();
    const pT = E.clone().sub(S); pT.addScaledVector(d, -pT.dot(d)).normalize();
    setWrist(out, s, w, V(sg * 0.4, -1, -0.25).lerp(pT, k));
  }
}

/** Build a randomised move instance (timing + parameters) starting at t0 (ms). */
function makeMove(kind, t0, rand) {
  const U = (a, b) => a + (b - a) * rand();
  const m = { kind, t0, p: {} };
  const side = /Left$/.test(kind) ? 'left' : /Right$/.test(kind) ? 'right' : null;
  m.side = side;
  switch (kind) {
    case 'punchLeft': case 'punchRight':
      m.p = { out: U(0.08, 0.16), x: U(-0.03, 0.16), y: U(1.36, 1.52), z: U(0.52, 0.66), drive: U(0, 0.06) };
      m.dur = (m.p.out + 0.06 + 0.24) * 1000; m.expect = kind; break;
    case 'kickLeft': case 'kickRight':
      m.p = { swing: rand() < 0.25 ? U(0, 0.3) : U(0.5, 1) };
      m.dur = 1000; m.expect = kind; break;
    case 'jump': m.p = { arms: rand() < 0.5 ? 'over' : 'swing' }; m.dur = 1300; m.expect = 'jump'; m.allow = ['handsUp']; break;
    case 'duck': m.p = { style: rand() < 0.5 ? 'squat' : 'bend', th: U(0.6, 0.9), drop: U(0.03, 0.1), hold: 0.5 };
      m.dur = (0.45 + 0.5 + 0.45) * 1000; m.expect = 'squat'; m.win = [0.45, 0.95]; break;
    case 'duckHead': m.p = { style: 'bend', th: U(0.6, 0.9), drop: U(0.0, 0.08), hold: 0.5, noLegs: true };
      m.dur = (0.45 + 0.5 + 0.45) * 1000; m.expect = 'squat'; m.win = [0.45, 0.95]; break;
    case 'dodgeLeft': case 'dodgeRight': m.p = { ang: U(0.3, 0.5), hold: 0.5 }; m.dur = 950; m.expect = kind === 'dodgeLeft' ? 'leanLeft' : 'leanRight'; m.win = [0.2, 0.7]; break;
    case 'guard': m.p = { hold: 0.8 }; m.dur = 1100; m.expect = 'guard'; m.win = [0.15, 0.95]; break;
    case 'charge': case 'chargeClipped': m.p = { hold: 1.2, clipped: kind === 'chargeClipped', raise: U(0.15, 0.3) }; m.dur = (m.p.raise + 1.2 + 0.35) * 1000;
      m.expect = 'handsUp'; m.win = [m.p.raise + 0.1, m.p.raise + 1.2]; break;
    case 'idle': m.dur = 1500; break;
    case 'tpose': m.dur = 1600; m.allow = ['tPose']; break;
    case 'wave': m.dur = 2000; m.allow = ['rightHandUp']; break;
    default: m.dur = 1000;
  }
  return m;
}

/** Pose of move m at capture time tc (ms). Returns {joints, extra, lowConf: Set} (player frame, metres). */
function movePose(src, m, tc) {
  const base = 400 + ((tc / 1000) % 4);
  const tau = m ? (tc - m.t0) / 1000 : 0;
  const lowConf = new Set();
  const guardPose = () => { src.phase = 0; return src.pose(base); };
  let out;
  if (!m) { out = guardPose(); src.phase = null; return { ...out, lowConf }; }
  const p = m.p;
  switch (m.kind) {
    case 'punchLeft': case 'punchRight': {
      out = guardPose();
      const s = m.side, sg = s === 'left' ? 1 : -1, o = s === 'left' ? 'right' : 'left';
      const k = tau < p.out ? sm(0, p.out, tau) : tau < p.out + 0.06 ? 1 : 1 - sm(p.out + 0.06, p.out + 0.3, tau);
      const J = out.joints;
      const S = J[s + 'Shoulder'].clone().add(V(0, 0, p.drive * k));
      const w0 = J[s + 'Wrist'].clone(), w1 = V(sg * p.x, p.y, p.z);
      setWrist(out, s, w0.lerp(w1, k), V(sg * 0.4, -1, -0.25).lerp(V(sg * 0.7, -1, 0), k), S);
      const ow = J[o + 'Wrist'].clone().add(V(0, -0.02 * k, -0.05 * k));
      setWrist(out, o, ow, V(-sg * 0.4, -1, -0.25));
      break;
    }
    case 'kickLeft': case 'kickRight': {
      src.phase = 2; out = src.pose(400 + (m.side === 'left' ? 0 : 2) + Math.min(1.99, tau));
      const s = m.side, sg = s === 'left' ? 1 : -1, o = s === 'left' ? 'right' : 'left';
      const T = [0.25, 0.37, 0.47, 0.67, 0.95], v = tau;
      const chamber = v < T[0] ? sm(0, T[0], v) : v < T[3] ? 1 : 1 - sm(T[3], T[4], v);
      const ext = v < T[0] ? 0 : v < T[1] ? sm(T[0], T[1], v) : v < T[2] ? 1 : 1 - sm(T[2], T[3], v);
      const a = p.swing * Math.min(1, chamber * 0.6 + ext * 0.6);
      const J = out.joints;
      // arm opposite the kicking leg drives forward-down, the kicking side's arm swings back and out
      setWrist(out, o, J[o + 'Wrist'].clone().lerp(V(-sg * 0.12, 1.18, 0.5), a), V(-sg * 0.5, -1, -0.2));
      setWrist(out, s, J[s + 'Wrist'].clone().lerp(V(sg * 0.38, 1.05, -0.12), a), V(sg * 0.6, -1, -0.4));
      break;
    }
    case 'jump': {
      src.phase = 4; out = src.pose(400 + Math.min(1.3, tau));
      if (p.arms === 'over') blendArms(out, guardPose(), tau < 0.6 ? sm(0, 0.22, tau) : 1 - sm(1.0, 1.25, tau));
      if (p.arms === 'swing') {
        const J = out.joints, v = tau;
        const back = v < 0.25 ? sm(0, 0.2, v) : 1 - sm(0.22, 0.34, v);         // arms back on the dip
        const fwd = v < 0.22 ? 0 : v < 0.75 ? sm(0.22, 0.36, v) : 1 - sm(0.75, 1.1, v); // swing forward-up on take-off
        for (const s of ['left', 'right']) {
          const sg = s === 'left' ? 1 : -1, S = J[s + 'Shoulder'];
          const rest = V(S.x + sg * 0.08, S.y - 0.5, S.z + 0.05);
          const w = rest.clone().lerp(V(S.x + sg * 0.05, S.y - 0.45, S.z - 0.3), back).lerp(V(S.x - sg * 0.02, S.y + 0.05, S.z + 0.5), fwd);
          setWrist(out, s, w, V(sg * 0.3, -0.5, -1));
        }
      }
      break;
    }
    case 'duck': case 'duckHead': {
      const h = p.hold, u = tau < 0.45 ? sm(0, 0.4, tau) : tau < 0.45 + h ? 1 : 1 - sm(0.45 + h, 0.9 + h, tau);
      if (p.style === 'squat') { src.phase = 3; out = src.pose(400 + (tau < 0.45 ? tau / 0.45 : tau < 0.45 + h ? 1 : Math.min(2, 1 + (tau - 0.45 - h) / 0.45))); break; }
      out = guardPose();
      const J = out.joints;
      for (const n of [...UPPER, 'leftHip', 'rightHip']) J[n].y -= p.drop * u;
      for (const n of Object.keys(out.extra)) out.extra[n].y -= p.drop * u;
      rotUpper(out, V(1, 0, 0), p.th * u);
      break;
    }
    case 'dodgeLeft': case 'dodgeRight': {
      out = guardPose();
      const h = p.hold, k = tau < 0.2 ? sm(0, 0.2, tau) : tau < 0.2 + h ? 1 : 1 - sm(0.2 + h, 0.45 + h, tau);
      rotUpper(out, V(0, 0, 1), (m.kind === 'dodgeLeft' ? -1 : 1) * p.ang * k);   // leanLeft: shoulders toward +x
      break;
    }
    case 'guard': {
      out = guardPose();
      const J = out.joints, k = tau < 0.95 ? sm(0, 0.15, tau) : 1 - sm(0.95, 1.1, tau);
      for (const s of ['left', 'right']) {
        const sg = s === 'left' ? 1 : -1, S = J[s + 'Shoulder'];
        setWrist(out, s, J[s + 'Wrist'].clone().lerp(V(S.x - sg * 0.06, J.nose.y - 0.08, S.z + 0.24), k), V(sg * 0.4, -1, -0.25));
      }
      break;
    }
    case 'charge': case 'chargeClipped': {
      out = guardPose();
      const J = out.joints, r = p.raise, h = p.hold;
      const up = tau < r + h ? sm(0, r, tau) : 1 - sm(r + h, r + h + 0.3, tau);
      for (const s of ['left', 'right']) {
        const sg = s === 'left' ? 1 : -1, S = J[s + 'Shoulder'];
        const w = J[s + 'Wrist'].clone().lerp(V(S.x + sg * 0.12, J.nose.y + 0.34, S.z + 0.04), up);
        setWrist(out, s, w, V(sg * 0.4, -1, -0.25).lerp(V(sg, 0.2, -0.2), up));
        if (p.clipped && J[s + 'Wrist'].y > J.nose.y + 0.12) {
          // out of the top of the frame: low confidence, the tracker extrapolates (wanders) the wrist + hand
          lowConf.add(s + 'Wrist'); lowConf.add(s + 'Hand');
          const e = V(Math.sin(tc * 0.007 + sg) * 0.12, -0.15 + Math.sin(tc * 0.011) * 0.1, Math.cos(tc * 0.005) * 0.1);
          J[s + 'Wrist'].add(e); J[s + 'Hand'].add(e);
        }
      }
      break;
    }
    case 'tpose': src.phase = 5; out = src.pose(400); blendArms(out, guardPose(), tau < 0.8 ? sm(0, 0.35, tau) : 1 - sm(1.25, 1.6, tau)); break;
    case 'wave': src.phase = 6; out = src.pose(400 + (tc / 1000) % 4); blendArms(out, guardPose(), tau < 1 ? sm(0, 0.35, tau) : 1 - sm(1.65, 2, tau)); break;
    default: out = guardPose();
  }
  src.phase = null;
  if (p.noLegs) for (const n of LEGS) lowConf.add(n);
  return { ...out, lowConf };
}

/**
 * Run the bench. opts: Detector (class, default required), reps per move (24), rate Hz (30), sxy / sz metres noise
 * (0.015 / 0.05), dropout (true), upperBody (false: legs tracked), seated (detector.seated + upper body), seed, latencyMs (45).
 * Returns {perMove: {kind: {n, hit, delays[], phantoms, phantomNames}}, phantomsPer100, frames, costMs, ...}.
 */
export function runMoveBench({ Detector, kinds: only = null, onFrame = null, seated = false, reps = 24, rate = 30, sxy = 0.015, sz = 0.05, dropout = true, upperBody = false, seed = 1, latencyMs = 45 } = {}) {
  let rnd = seed * 7919 + 13;
  const rand = () => { rnd = (rnd * 16807) % 2147483647; return rnd / 2147483647; };
  const g = () => { let s = 0; for (let i = 0; i < 6; i++) s += rand(); return (s - 3) * Math.SQRT2; };
  const src = new SyntheticSource({ rate, noise: 0 });
  const det = new Detector();
  if (seated) { det.seated = true; upperBody = true; }
  let now = 0;
  det.clock = () => now;
  const events = [];
  det.on((name, info) => events.push({ name, tc: info.tCapture ?? (info.t - latencyMs), tDecide: info.t - latencyMs }));

  // script: T-pose calibration (as the game does), guard, then the shuffled moves with guard gaps
  const kinds = only ?? (upperBody ? UPPER_MOVES : BENCH_MOVES);
  const list = [];
  for (const k of kinds) for (let i = 0; i < reps; i++) list.push(k);
  for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
  const moves = [];
  let t = 3200;
  for (const k of list) { const m = makeMove(k, t, rand); moves.push(m); t += m.dur + (350 + rand() * 450); }
  const tEnd = t + 1000;
  const calibTpose = { kind: 'tpose', t0: 0, dur: 1500, p: {} };

  // noise state
  const ar = {}; const occl = new Map(); const frozen = {};
  let frames = 0, cost = 0, mi = 0;
  let tc = 0;
  const stateTrace = {};    // held states: per move, frames with the expected state true
  while (tc < tEnd) {
    tc += (1000 / rate) * (1 + (rand() - 0.5) * 0.24);
    if (dropout && rand() < 0.02) continue;                 // dropped frame
    while (mi < moves.length && moves[mi].t0 + moves[mi].dur < tc) mi++;
    const m = tc < 1500 ? calibTpose : (mi < moves.length && moves[mi].t0 <= tc ? moves[mi] : null);
    const { joints, lowConf } = movePose(src, m, tc);
    const conf = {};
    // occlusions: a chain goes low-confidence for 1-5 frames, its points freeze or jump
    if (dropout && rand() < 0.03) {
      const ch = CHAINS[Math.floor(rand() * CHAINS.length)];
      occl.set(ch, { left: 1 + Math.floor(rand() * 5), jump: rand() < 0.5 ? V(g() * 0.06, g() * 0.06, g() * 0.06) : null });
    }
    const occluded = new Set();
    for (const [ch, o] of occl) {
      for (const n of ch) {
        occluded.add(n);
        if (o.jump) joints[n].add(o.jump); else if (frozen[n]) joints[n].copy(frozen[n]);
      }
      if (--o.left <= 0) occl.delete(ch);
    }
    for (const k of Object.keys(joints)) {
      const a = ar[k] ?? (ar[k] = { z: 0 });
      a.z = a.z * 0.85 + g() * Math.sqrt(1 - 0.85 * 0.85);
      joints[k].x += g() * sxy; joints[k].y += g() * sxy;
      joints[k].z += sz * (g() * Math.SQRT1_2 + a.z * Math.SQRT1_2) - 2.5;
      const low = lowConf.has(k) || (upperBody && LEGS.includes(k));
      conf[k] = low ? 0.1 : occluded.has(k) ? 0.1 + rand() * 0.2 : 0.75 + rand() * 0.25;
      if (!occluded.has(k)) frozen[k] = joints[k].clone();
    }
    now = tc + latencyMs;
    const c0 = performance.now();
    det.pushFrame({ joints, conf, tCapture: tc });
    cost += performance.now() - c0;
    onFrame?.(det, m, tc, joints);
    frames++;
    if (m && m.win) {   // held moves are judged on the state (as the game's judge does), not on an entry event
      const tr = stateTrace[m.t0] ?? (stateTrace[m.t0] = { on: 0, n: 0, first: null });
      if (tr.first === null && det.state[m.expect]) tr.first = tc;
      if (tc > m.t0 + m.win[0] * 1000 && tc < m.t0 + m.win[1] * 1000) { tr.n++; if (det.state[m.expect]) tr.on++; }
    }
  }

  // score
  const perMove = {};
  for (const k of kinds) perMove[k] = { n: 0, hit: 0, delays: [], decide: [], phantoms: 0, phantomNames: {} };
  const used = new Set();
  const owner = (tcE) => moves.find((m) => tcE >= m.t0 - 30 && tcE <= m.t0 + m.dur + 250);
  for (const m of moves) {
    const r = perMove[m.kind];
    r.n++;
    if (!m.expect) continue;
    const e = events.find((ev, i) => !used.has(i) && ev.name === m.expect && ev.tc >= m.t0 - 30 && ev.tc <= m.t0 + m.dur + 250 && (used.add(i) || true));
    if (m.win) {
      const tr = stateTrace[m.t0];
      if (tr && tr.n > 0 && tr.on / tr.n >= 0.8) { r.hit++; r.delays.push(Math.max(0, (tr.first ?? m.t0) - m.t0)); }
    } else if (e) { r.hit++; r.delays.push(e.tc - m.t0); r.decide.push(e.tDecide - m.t0); }
  }
  let phantomTotal = 0, gapPhantoms = 0;
  events.forEach((ev, i) => {
    if (used.has(i) || !PHANTOM.includes(ev.name) || ev.tc < 2600) return;   // calibration window excluded
    const m = owner(ev.tc);
    if (m && m.allow?.includes(ev.name)) return;
    phantomTotal++;
    if (!m) { gapPhantoms++; return; }
    const r = perMove[m.kind];
    r.phantoms++; r.phantomNames[ev.name] = (r.phantomNames[ev.name] ?? 0) + 1;
  });
  return { events, movesList: moves, perMove, moves: moves.length, phantomTotal, gapPhantoms, phantomsPer100: (100 * phantomTotal) / moves.length,
    frames, costMs: cost / Math.max(1, frames), cfg: { reps, rate, sxy, sz, dropout, upperBody, seated, seed } };
}

const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) : '-');
const med = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const p90 = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))]; };

/** Merge several bench results (same move set) into one. */
export function mergeBench(results) {
  const out = { perMove: {}, moves: 0, phantomTotal: 0, gapPhantoms: 0, frames: 0, costMs: 0 };
  for (const r of results) {
    out.moves += r.moves; out.phantomTotal += r.phantomTotal; out.gapPhantoms += r.gapPhantoms; out.frames += r.frames; out.costMs += r.costMs * r.frames;
    for (const [k, v] of Object.entries(r.perMove)) {
      const o = out.perMove[k] ?? (out.perMove[k] = { n: 0, hit: 0, delays: [], decide: [], phantoms: 0, phantomNames: {} });
      o.n += v.n; o.hit += v.hit; o.delays.push(...v.delays); o.decide.push(...v.decide); o.phantoms += v.phantoms;
      for (const [n, c] of Object.entries(v.phantomNames)) o.phantomNames[n] = (o.phantomNames[n] ?? 0) + c;
    }
  }
  out.costMs /= Math.max(1, out.frames);
  out.phantomsPer100 = (100 * out.phantomTotal) / Math.max(1, out.moves);
  return out;
}

/** Plain-text table. delay = event capture time - motion start (what the judge uses); decide = when the detector
 *  decided (later than the capture stamp when a punch waited one frame for confirmation). */
export function formatBench(r, title = '') {
  const rows = [`${title}  moves=${r.moves} phantoms=${r.phantomTotal} (${r.phantomsPer100.toFixed(2)}/100 moves, ${r.gapPhantoms} between moves)  detector ${(r.costMs * 1000).toFixed(1)} us/frame`,
    'move           n    hit%   delay med/p90 ms   decide med   phantoms'];
  const ms = (x) => (isNaN(x) ? '-' : String(Math.round(x)));
  for (const [k, v] of Object.entries(r.perMove)) {
    const ph = Object.entries(v.phantomNames).map(([n, c]) => `${n}x${c}`).join(' ');
    const neg = ['idle', 'tpose', 'wave'].includes(k);
    rows.push(`${k.padEnd(14)} ${String(v.n).padStart(4)} ${neg ? '     -' : pct(v.hit, v.n).padStart(6)}   ${neg ? '        -       ' : `${ms(med(v.delays)).padStart(5)} / ${ms(p90(v.delays)).padStart(4)}`}   ${(neg || !v.decide.length ? '-' : ms(med(v.decide))).padStart(10)}   ${v.phantoms}${ph ? '  ' + ph : ''}`);
  }
  return rows.join('\n');
}

/** Targets: >= 97 % per detectable move, <= 1 phantom per 100 moves. */
export function benchFails(r, minHit = 0.97, maxPh = 1) {
  const fails = [];
  for (const [k, v] of Object.entries(r.perMove)) if (!['idle', 'tpose', 'wave'].includes(k) && v.n && v.hit / v.n < minHit) fails.push(`${k} ${pct(v.hit, v.n)}%`);
  if (r.phantomsPer100 > maxPh) fails.push(`${r.phantomsPer100.toFixed(2)} phantoms/100`);
  return fails;
}
