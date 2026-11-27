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
//   kneeLeft/kneeRight    knee strike (thigh 60-100 deg up, shin hanging or folded, no extension), 50 % with both hands
//                         pulling down; expects kickLeft/kickRight with detector.kneeStrike (bench option kneeStrike)
//   idle / tpose / wave   negatives: nothing may fire
//   + the sequences (SEQ_MOVES, see makeSeq): dodge -> counter, duck -> jabs, jump -> kick, guard -> 3 punches,
//     eighth-note punches, kick -> punch
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

// Whole-body transforms layered over the guard (and over any punch composed on top, see seqPose)
/** Waist bend / bob duck: drop the upper body + hips by p.drop and pitch it forward by p.th (u = 0..1). */
function bendX(out, p, u) {
  const J = out.joints;
  for (const n of [...UPPER, 'leftHip', 'rightHip']) J[n].y -= p.drop * u;
  for (const n of Object.keys(out.extra)) out.extra[n].y -= p.drop * u;
  rotUpper(out, V(1, 0, 0), p.th * u);
}
/** Dodge: lean (frontal-plane tilt of the upper body) or side step (whole body translates); in / hold / back (s). */
function dodgeX(out, m, tau) {
  const p = m.p, h = p.hold, i = p.inT ?? 0.2, b = p.back ?? 0.25;
  const k = tau < i ? sm(0, i, tau) : tau < i + h ? 1 : 1 - sm(i + h, i + h + b, tau);
  const sg = m.kind === 'dodgeLeft' ? 1 : -1;
  if (p.style === 'step') {
    for (const v of [...Object.values(out.joints), ...Object.values(out.extra)]) v.x += sg * p.dist * k;
  } else rotUpper(out, V(0, 0, 1), -sg * p.ang * k);   // leanLeft: shoulders toward +x
}

/** Knee strike on `side`: the thigh swings forward-up to p.ang (rad from hanging), the shin hangs / folds back by
 *  p.fold, the torso leans back a little and (p.pull > 0) both hands pull down toward the knee (clinch knee). */
function kneeX(out, side, p, tau) {
  const J = out.joints, sg = side === 'left' ? 1 : -1;
  const u = tau < p.up ? sm(0, p.up, tau) : tau < p.up + p.hold ? 1 : 1 - sm(p.up + p.hold, p.up + p.hold + p.down, tau);
  if (u <= 0) return;
  const H = J[side + 'Hip'], K0 = J[side + 'Knee'], A0 = J[side + 'Ankle'];
  const thigh = H.distanceTo(K0), shin = K0.distanceTo(A0);
  const d0 = K0.clone().sub(H).normalize(), s0 = A0.clone().sub(K0).normalize();
  const dR = V(-sg * 0.08, -Math.cos(p.ang), Math.sin(p.ang)).normalize();
  const sR = V(0, -Math.cos(p.fold), -Math.sin(p.fold));
  const K = H.clone().addScaledVector(d0.lerp(dR, u).normalize(), thigh);
  const A = K.clone().addScaledVector(s0.lerp(sR, u).normalize(), shin);
  const dA = A.clone().sub(A0);
  J[side + 'Knee'] = K; J[side + 'Ankle'] = A;
  for (const n of [side + 'Heel', side + 'Toe']) if (J[n]) J[n].add(dA);
  rotUpper(out, V(1, 0, 0), -0.1 * u);
  if (p.pull > 0) for (const s of ['left', 'right']) {
    const g = s === 'left' ? 1 : -1;
    setWrist(out, s, J[s + 'Wrist'].clone().lerp(V(g * 0.06 + sg * 0.05, 1.08, 0.38), p.pull * u), V(g * 0.4, -1, -0.25));
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
    case 'kneeLeft': case 'kneeRight':
      // knee strike: thigh raised 60-100 deg from hanging (90 = horizontal), shin hanging or folded back, no extension
      m.p = { ang: U(1.05, 1.75), fold: U(0, 0.6), up: U(0.15, 0.3), hold: U(0.05, 0.2), down: U(0.25, 0.4), pull: rand() < 0.5 ? U(0.5, 1) : 0 };
      m.dur = (m.p.up + m.p.hold + m.p.down) * 1000 + 100; m.expect = kind === 'kneeLeft' ? 'kickLeft' : 'kickRight'; break;
    case 'idle': m.dur = 1500; break;
    case 'tpose': m.dur = 1600; m.allow = ['tPose']; break;
    case 'wave': m.dur = 2000; m.allow = ['rightHandUp']; break;
    default: m.dur = 1000;
  }
  return m;
}

const duckU = (p, tau) => (tau < 0.45 ? sm(0, 0.4, tau) : tau < 0.45 + p.hold ? 1 : 1 - sm(0.45 + p.hold, 0.9 + p.hold, tau));

// ------------------------------------------------------------------------------- sequences (BREAKLIGHT design QA r2)
// Combos as the charts and the boss write them at 128 bpm (beat 469 ms), at or tighter than the tightest gap written:
//   dodgeCounter  lean (75 %) or side step away, short hold, come back throwing the counter: the punch starts anywhere
//                 from the end of the lean-in to just after the return (Act 3 / boss 'VR . SL': counter 1 beat later)
//   duckJab       duck (hip squat or waist bend), rise and jab within 0-0.45 s, a second jab (same or other arm) 1 beat on
//   jumpKick      jump, a kick (or knee) 0.05-0.65 s after landing, 40 %: the other foot 2 beats later ('CL . CR')
//   jumpPunch     jump (fists in guard, or overhead), a punch 0-0.5 s after touch-down (or once the arms are down), a
//                 second 1 beat on (Act 1 'J . . .' -> 'SL SR? CR .')
//   guardPunch3   guard (brute block), then 3 alternating punches 0.23-0.47 s apart from the guard
//   punchAlt8     6 alternating punches on eighth notes (234 ms), fast out (70-110 ms) and back (150-200 ms)
//   kickPunch     a kick (or knee), the punch lands 2 beats after it
// Each part is scored on its own (punch parts: the event within 450 ms of the motion start; held parts: the state on
// >= 80 % of their window); a sequence is "full" when every part hit. Phantoms count per part (100 parts = 100 moves).
export const SEQ_MOVES = ['dodgeCounter', 'duckJab', 'jumpKick', 'jumpPunch', 'guardPunch3', 'punchAlt8', 'kickPunch'];
export const SEQ_UPPER = ['dodgeCounter', 'duckJab', 'guardPunch3', 'punchAlt8'];
const BEAT = 60 / 128;
const partKey = (kind) => kind.replace(/(Left|Right)$/, '').replace(/Head$/, '');
const isPunch = (pt) => pt.kind === 'punchLeft' || pt.kind === 'punchRight';
const isXform = (pt) => pt.kind.startsWith('dodge') || ((pt.kind === 'duck' || pt.kind === 'duckHead') && pt.p.style === 'bend');

function makeSeq(kind, t0, rand, o = {}) {
  const U = (a, b) => a + (b - a) * rand();
  const side = () => (rand() < 0.5 ? 'Left' : 'Right');
  const opp = (x) => (x === 'Left' ? 'Right' : 'Left');
  const parts = [];
  const part = (k, at) => { const pt = makeMove(k, t0 + at * 1000, rand); parts.push(pt); return pt; };
  const punch = (x, at, fast = false) => {
    const pt = part('punch' + x, at);
    if (fast) { pt.p.out = U(0.07, 0.11); pt.p.back = U(0.15, 0.2); } else pt.p.back = 0.24;
    pt.dur = (pt.p.out + 0.06 + pt.p.back) * 1000; pt.matchMs = 450;
    return pt;
  };
  const kickK = o.knees ? 'knee' : 'kick';
  const kickHit = (pt) => (o.knees ? pt.p.up : 0.17);          // ~ when a kick / knee is detected (its judged hit)
  switch (kind) {
    case 'dodgeCounter': {
      const x = side(), d = part('dodge' + x, 0);
      const style = o.upperBody || rand() < 0.75 ? 'lean' : 'step';
      Object.assign(d.p, { style, inT: U(0.15, 0.25), hold: U(0.15, 0.35), back: U(0.2, 0.3), dist: U(0.42, 0.55) });
      d.dur = (d.p.inT + d.p.hold + d.p.back) * 1000;
      d.expect = (style === 'step' ? 'step' : 'lean') + x; d.win = [d.p.inT + 0.05, d.p.inT + d.p.hold + 0.05];
      punch(rand() < 0.5 ? x : opp(x), U(d.p.inT - 0.05, d.p.inT + d.p.hold + d.p.back + 0.1));
      break;
    }
    case 'duckJab': {
      const d = part(o.upperBody ? 'duckHead' : 'duck', 0);
      d.p.hold = U(0.2, 0.45); d.dur = (0.9 + d.p.hold) * 1000; d.win = [0.45, 0.45 + d.p.hold];
      const x = side(), a = U(0.45 + d.p.hold, 0.9 + d.p.hold);
      punch(x, a); punch(rand() < 0.5 ? x : opp(x), a + BEAT + U(-0.03, 0.03));
      break;
    }
    case 'jumpKick': {
      part('jump', 0);
      const x = side(), k = part(kickK + x, U(1.0, 1.6));
      if (rand() < 0.4) part(kickK + opp(x), (k.t0 - t0) / 1000 + 2 * BEAT + U(-0.04, 0.04));
      break;
    }
    case 'jumpPunch': {
      // touch-down at ~0.7 s, landing squash until 0.95 s. Fists kept in guard (50 %): the punch starts 0-0.5 s after
      // touch-down; arms overhead: once they are back down (1.25 s)
      const j = part('jump', 0), guardHop = rand() < 0.5;
      j.p.arms = guardHop ? 'guard' : 'over';
      const x = side(), a = guardHop ? U(0.7, 1.2) : U(1.2, 1.6);
      punch(x, a); punch(opp(x), a + BEAT + U(-0.03, 0.03));
      break;
    }
    case 'guardPunch3': {
      const g = part('guard', 0);
      g.p.end = 0.15 + U(0.3, 0.6); g.dur = (g.p.end + 0.15) * 1000; g.win = [0.15, g.p.end];
      let x = side(), a = g.p.end + U(-0.05, 0.1);
      for (let i = 0; i < 3; i++) { punch(x, a); x = opp(x); a += U(0.23, 0.47); }
      break;
    }
    case 'punchAlt8': {
      let x = side(), a = 0;
      for (let i = 0; i < 6; i++) { punch(x, a, true); x = opp(x); a += BEAT / 2 + U(-0.015, 0.015); }
      break;
    }
    case 'kickPunch': {
      const x = side(), k = part(kickK + x, 0);
      punch(rand() < 0.5 ? x : opp(x), kickHit(k) + 2 * BEAT - 0.09 + U(-0.06, 0.06));
      break;
    }
    default: throw new Error('unknown sequence ' + kind);
  }
  parts.sort((a, b) => a.t0 - b.t0);
  const end = Math.max(...parts.map((pt) => pt.t0 + pt.dur));
  const allow = [...new Set(parts.flatMap((pt) => pt.allow ?? []))];
  return { kind, t0, seq: true, parts, p: {}, side: null, dur: end - t0, allow };
}

const punchK = (p, tau) => (tau < p.out ? sm(0, p.out, tau) : tau < p.out + 0.06 ? 1 : 1 - sm(p.out + 0.06, p.out + 0.06 + (p.back ?? 0.24), tau));
/** Punches layered over any body pose: the fist target moves with the (current) shoulder, consecutive punches of one
 *  arm chain from where the previous one is (no teleporting), the other arm pulls back a little. */
function applyPunches(out, ref, punches, tc) {
  const J = out.joints;
  for (const s of ['left', 'right']) {
    const sg = s === 'left' ? 1 : -1, o = s === 'left' ? 'right' : 'left';
    const w = J[s + 'Wrist'].clone();
    let kMax = 0, drive = 0, touched = false;
    for (const pt of punches) {
      const p = pt.p, k = punchK(p, (tc - pt.t0) / 1000);
      if (pt.side === o) { w.add(V(0, -0.02 * k, -0.05 * k)); touched = true; continue; }
      const target = J[s + 'Shoulder'].clone().add(V(sg * p.x, p.y, p.z).sub(ref[s]));
      w.lerp(target, k); kMax = Math.max(kMax, k); drive += p.drive * k; touched = true;
    }
    if (touched) setWrist(out, s, w, V(sg * 0.4, -1, -0.25).lerp(V(sg * 0.7, -1, 0), kMax), J[s + 'Shoulder'].clone().add(V(0, 0, drive)));
  }
}
function blendPose(a, b, k) {
  for (const [n, v] of Object.entries(a.joints)) if (b.joints[n]) v.lerp(b.joints[n], k);
  for (const [n, v] of Object.entries(a.extra)) if (b.extra[n]) v.lerp(b.extra[n], k);
}
/** Pose of a sequence: the latest active body part (cross-faded over 0.2 s from an overlapping one), punches on top;
 *  a lean / step / waist-bend body is applied AFTER the punches, so the punch is thrown relative to the moving torso. */
function seqPose(src, m, tc, guardPose) {
  const act = m.parts.filter((pt) => tc >= pt.t0 && tc < pt.t0 + pt.dur);
  const bodies = act.filter((pt) => !isPunch(pt)), punches = act.filter(isPunch);
  const g = guardPose();
  const ref = { left: g.joints.leftShoulder.clone(), right: g.joints.rightShoulder.clone() };
  let out = g, lowConf = new Set(), xf = null;
  const body = bodies[bodies.length - 1];
  if (body && isXform(body)) { out = guardPose(); xf = body; }
  else if (body) {
    const r = movePose(src, body, tc); out = r; lowConf = r.lowConf;
    const prev = bodies.length > 1 ? bodies[bodies.length - 2] : null;
    if (prev && !isXform(prev)) {
      const a = movePose(src, prev, tc);
      blendPose(a, r, sm(0, 0.2, (tc - body.t0) / 1000));
      out = a; for (const n of a.lowConf) lowConf.add(n);
    }
  }
  if (punches.length) applyPunches(out, ref, punches, tc);
  if (xf) {
    const tau = (tc - xf.t0) / 1000;
    if (xf.kind.startsWith('dodge')) dodgeX(out, xf, tau); else bendX(out, xf.p, duckU(xf.p, tau));
    if (xf.p.noLegs) for (const n of LEGS) lowConf.add(n);
  }
  src.phase = null;
  return { joints: out.joints, extra: out.extra, lowConf };
}

/** Pose of move m at capture time tc (ms). Returns {joints, extra, lowConf: Set} (player frame, metres). */
function movePose(src, m, tc) {
  const base = 400 + ((tc / 1000) % 4);
  const tau = m ? (tc - m.t0) / 1000 : 0;
  const lowConf = new Set();
  const guardPose = () => { src.phase = 0; return src.pose(base); };
  let out;
  if (!m) { out = guardPose(); src.phase = null; return { ...out, lowConf }; }
  if (m.seq) return seqPose(src, m, tc, guardPose);
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
      if (p.arms === 'guard') {   // boxer's hop: the fists stay in guard, carried with the body
        const gp = guardPose(), J = out.joints, dv = J.neck.clone().sub(gp.joints.neck);
        for (const s of ['left', 'right']) setWrist(out, s, gp.joints[s + 'Wrist'].clone().add(dv), V(s === 'left' ? 0.4 : -0.4, -1, -0.25));
      }
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
      const h = p.hold, u = duckU(p, tau);
      if (p.style === 'squat') { src.phase = 3; out = src.pose(400 + (tau < 0.45 ? tau / 0.45 : tau < 0.45 + h ? 1 : Math.min(2, 1 + (tau - 0.45 - h) / 0.45))); break; }
      out = guardPose();
      bendX(out, p, u);
      break;
    }
    case 'dodgeLeft': case 'dodgeRight': {
      out = guardPose();
      dodgeX(out, m, tau);
      break;
    }
    case 'guard': {
      out = guardPose();
      const e = p.end ?? 0.95, J = out.joints, k = tau < e ? sm(0, 0.15, tau) : 1 - sm(e, e + 0.15, tau);
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
    case 'kneeLeft': case 'kneeRight': {
      out = guardPose();
      kneeX(out, m.side, p, tau);
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
 * (0.015 / 0.05), dropout (true), upperBody (false: legs tracked), seated (detector.seated + upper body), seed, latencyMs (45),
 * kinds (move and / or SEQ_MOVES names; default BENCH_MOVES / UPPER_MOVES), kneeStrike (detector.kneeStrike = true and the
 * sequences' kicks become knee strikes), detectorOpts (assigned onto the detector).
 * Returns {perMove: {kind: {n, hit, delays[], phantoms, phantomNames, sub?}}, phantomsPer100, frames, costMs, ...}.
 * Sequences: n / hit = whole sequences / fully hit ones, sub = per part kind {n, hit, delays, decide}.
 */
export function runMoveBench({ Detector, kinds: only = null, onFrame = null, seated = false, reps = 24, rate = 30, sxy = 0.015, sz = 0.05, dropout = true, upperBody = false, seed = 1, latencyMs = 45, kneeStrike = false, detectorOpts = null } = {}) {
  let rnd = seed * 7919 + 13;
  const rand = () => { rnd = (rnd * 16807) % 2147483647; return rnd / 2147483647; };
  const g = () => { let s = 0; for (let i = 0; i < 6; i++) s += rand(); return (s - 3) * Math.SQRT2; };
  const src = new SyntheticSource({ rate, noise: 0 });
  const det = new Detector();
  if (seated) { det.seated = true; upperBody = true; }
  if (kneeStrike) det.kneeStrike = true;
  if (detectorOpts) Object.assign(det, detectorOpts);
  let now = 0;
  det.clock = () => now;
  const events = [];
  det.on((name, info) => events.push({ name, tc: info.tCapture ?? (info.t - latencyMs), tDecide: info.t - latencyMs, knee: !!info.knee }));

  // script: T-pose calibration (as the game does), guard, then the shuffled moves with guard gaps
  const kinds = only ?? (upperBody ? UPPER_MOVES : BENCH_MOVES);
  const list = [];
  for (const k of kinds) for (let i = 0; i < reps; i++) list.push(k);
  for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
  const moves = [];
  let t = 3200;
  for (const k of list) {
    const m = SEQ_MOVES.includes(k) ? makeSeq(k, t, rand, { upperBody, knees: kneeStrike }) : makeMove(k, t, rand);
    moves.push(m); t += m.dur + (350 + rand() * 450);
  }
  const tEnd = t + 1000;
  const calibTpose = { kind: 'tpose', t0: 0, dur: 1500, p: {} };
  const partsOf = (m) => m.parts ?? [m];

  // noise state
  const ar = {}; const occl = new Map(); const frozen = {};
  let frames = 0, cost = 0, mi = 0;
  let tc = 0;
  const stateTrace = new Map();    // held states: per move / part, frames with the expected state true
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
    if (m) for (const pt of partsOf(m)) {   // held moves are judged on the state (as the game's judge does), not on an entry event
      if (!pt.win) continue;
      let tr = stateTrace.get(pt);
      if (!tr) stateTrace.set(pt, (tr = { on: 0, n: 0, first: null }));
      if (tc >= pt.t0 && tr.first === null && det.state[pt.expect]) tr.first = tc;
      if (tc > pt.t0 + pt.win[0] * 1000 && tc < pt.t0 + pt.win[1] * 1000) { tr.n++; if (det.state[pt.expect]) tr.on++; }
    }
  }

  // score (parts in time order, greedy event matching)
  const perMove = {};
  const entry = () => ({ n: 0, hit: 0, delays: [], decide: [], phantoms: 0, phantomNames: {} });
  for (const k of kinds) perMove[k] = SEQ_MOVES.includes(k) ? { ...entry(), sub: {}, units: 0 } : entry();
  const used = new Set();
  const owner = (tcE) => moves.find((m) => tcE >= m.t0 - 30 && tcE <= m.t0 + m.dur + 250);
  let units = 0;
  for (const m of moves) {
    const r = perMove[m.kind];
    r.n++;
    const parts = partsOf(m);
    units += m.seq ? parts.length : 1;
    if (m.seq) r.units += parts.length;
    let all = true;
    for (const pt of parts) {
      if (!pt.expect) continue;
      const rr = m.seq ? (r.sub[partKey(pt.kind)] ??= { n: 0, hit: 0, delays: [], decide: [] }) : r;
      if (m.seq) rr.n++;
      const end = pt.t0 + (pt.matchMs ?? pt.dur + 250);
      let hit = false;
      // the entry event of a held state is consumed too (it is not a phantom)
      const e = events.find((ev, i) => !used.has(i) && ev.name === pt.expect && ev.tc >= pt.t0 - 30 && ev.tc <= end && (used.add(i) || true));
      if (pt.win) {
        const tr = stateTrace.get(pt);
        if (tr && tr.n > 0 && tr.on / tr.n >= 0.8) { hit = true; rr.delays.push(Math.max(0, (tr.first ?? pt.t0) - pt.t0)); }
      } else {
        if (e) { hit = true; rr.delays.push(e.tc - pt.t0); rr.decide.push(e.tDecide - pt.t0); if (e.knee) rr.knee = (rr.knee ?? 0) + 1; }
      }
      if (hit) rr.hit++;
      all &&= hit;
    }
    if (m.seq && all) r.hit++;
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
  return { events, movesList: moves, perMove, moves: units, phantomTotal, gapPhantoms, phantomsPer100: (100 * phantomTotal) / units,
    frames, costMs: cost / Math.max(1, frames), cfg: { reps, rate, sxy, sz, dropout, upperBody, seated, seed, kneeStrike } };
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
      if (v.sub) {
        o.sub ??= {}; o.units = (o.units ?? 0) + v.units;
        for (const [pk, pv] of Object.entries(v.sub)) {
          const q = o.sub[pk] ?? (o.sub[pk] = { n: 0, hit: 0, delays: [], decide: [] });
          q.n += pv.n; q.hit += pv.hit; q.delays.push(...pv.delays); q.decide.push(...pv.decide);
          if (pv.knee) q.knee = (q.knee ?? 0) + pv.knee;
        }
      }
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
    if (v.sub) {   // sequence: whole-sequence success, then one row per part kind
      rows.push(`${k.padEnd(14)} ${String(v.n).padStart(4)} ${pct(v.hit, v.n).padStart(6)}   full sequences      ${(`${v.units} parts`).padStart(10)}   ${v.phantoms}${ph ? '  ' + ph : ''}` +
        `  (${((100 * v.phantoms) / Math.max(1, v.units)).toFixed(2)}/100)`);
      for (const [pk, pv] of Object.entries(v.sub)) {
        rows.push(`  .${pk.padEnd(11)} ${String(pv.n).padStart(4)} ${pct(pv.hit, pv.n).padStart(6)}   ${ms(med(pv.delays)).padStart(5)} / ${ms(p90(pv.delays)).padStart(4)}   ${(pv.decide.length ? ms(med(pv.decide)) : '-').padStart(10)}${pv.knee ? `   knee ${pv.knee}` : ''}`);
      }
      continue;
    }
    rows.push(`${k.padEnd(14)} ${String(v.n).padStart(4)} ${neg ? '     -' : pct(v.hit, v.n).padStart(6)}   ${neg ? '        -       ' : `${ms(med(v.delays)).padStart(5)} / ${ms(p90(v.delays)).padStart(4)}`}   ${(neg || !v.decide.length ? '-' : ms(med(v.decide))).padStart(10)}   ${v.phantoms}${ph ? '  ' + ph : ''}`);
  }
  return rows.join('\n');
}

/** Targets: >= 97 % per detectable move (per part kind of a sequence), <= 1 phantom per 100 moves (parts). */
export function benchFails(r, minHit = 0.97, maxPh = 1) {
  const fails = [];
  for (const [k, v] of Object.entries(r.perMove)) {
    if (v.sub) { for (const [pk, pv] of Object.entries(v.sub)) if (pv.n && pv.hit / pv.n < minHit) fails.push(`${k}.${pk} ${pct(pv.hit, pv.n)}%`); continue; }
    if (!['idle', 'tpose', 'wave'].includes(k) && v.n && v.hit / v.n < minHit) fails.push(`${k} ${pct(v.hit, v.n)}%`);
  }
  if (r.phantomsPer100 > maxPh) fails.push(`${r.phantomsPer100.toFixed(2)} phantoms/100`);
  return fails;
}
