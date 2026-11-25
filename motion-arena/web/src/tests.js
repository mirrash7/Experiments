// Test modes: Reaction test (time from prompt to detected action) and Pose Match (joint-angle accuracy).
import * as THREE from 'three';
import { ACTIONS } from './actions.js';

// --------------------------------------------------------------------------------------------- Reaction
const REACTION_PROMPTS = ['handsUp', 'leftHandUp', 'rightHandUp', 'squat', 'jump', 'punchLeft', 'punchRight', 'tPose', 'leanLeft', 'leanRight'];

export class ReactionTest {
  constructor(ui, { rounds = 8 } = {}) {
    this.ui = ui; this.rounds = rounds;
    this.results = []; this.active = false; this.current = null; this.timer = null;
  }
  start() {
    this.stop();
    this.results = []; this.active = true;
    this.ui.banner('Reaction test', 'Do each move as soon as it appears');
    this._next(1800);
  }
  stop() { this.active = false; clearTimeout(this.timer); this.current = null; this.ui.prompt(null); }
  _next(delay) {
    this.current = null;
    this.ui.prompt({ text: 'Get ready…', sub: `Round ${this.results.length + 1} / ${this.rounds}`, color: '#ffffff88' });
    this.timer = setTimeout(() => {
      if (!this.active) return;
      const pool = REACTION_PROMPTS.filter((p) => p !== this.results.at(-1)?.action);
      const action = pool[Math.floor(Math.random() * pool.length)];
      this.current = { action, tPrompt: 0 };
      this.ui.prompt({ text: ACTIONS[action].label + '!', sub: 'GO', color: ACTIONS[action].color });
      // timestamp the prompt when it is actually painted
      requestAnimationFrame(() => requestAnimationFrame((t) => { if (this.current) this.current.tPrompt = t; }));
      this.timer = setTimeout(() => this._miss(), 4000);
    }, delay);
  }
  _miss() {
    if (!this.current) return;
    this.results.push({ action: this.current.action, total: null, system: null });
    this.ui.flash('MISSED', '#ff6b6b');
    this._advance();
  }
  onAction(name, info) {
    if (!this.active || !this.current || !this.current.tPrompt) return;
    if (name !== this.current.action) return;
    clearTimeout(this.timer);
    const total = info.t - this.current.tPrompt;
    const system = info.tCapture ? info.t - info.tCapture : null; // capture → detection
    this.results.push({ action: name, total, system });
    this.ui.flash(`${Math.round(total)} ms`, ACTIONS[name].color);
    this._advance();
  }
  _advance() {
    this.current = null;
    if (this.results.length >= this.rounds) {
      this.active = false;
      this.ui.prompt(null);
      this.ui.showResults(this.summary());
    } else this._next(1200 + Math.random() * 1500);
  }
  summary() {
    const hits = this.results.filter((r) => r.total != null);
    const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
    const sys = hits.filter((r) => r.system != null).map((r) => r.system);
    return {
      title: 'Reaction test results',
      rows: this.results.map((r) => [ACTIONS[r.action].label, r.total == null ? 'missed' : `${Math.round(r.total)} ms`,
        r.system == null ? '–' : `${Math.round(r.system)} ms`]),
      header: ['Move', 'Prompt → detected', 'Capture → detected'],
      footer: [
        `Hit ${hits.length}/${this.results.length}`,
        `avg total ${Math.round(avg(hits.map((r) => r.total)))} ms`,
        `avg system latency ${Math.round(avg(sys))} ms`,
        `≈ your reaction + move time ${Math.round(avg(hits.map((r) => r.total)) - avg(sys))} ms`,
      ],
    };
  }
}

// --------------------------------------------------------------------------------------------- Pose match
// Target poses as character-space bone directions (+X = avatar's left, +Y up, +Z toward the viewer).
const d = (x, y, z) => new THREE.Vector3(x, y, z).normalize();
const ARMS_DOWN = { leftUpperArm: d(0.2, -1, 0), leftForeArm: d(0.1, -1, 0.1), rightUpperArm: d(-0.2, -1, 0), rightForeArm: d(-0.1, -1, 0.1) };
const LEGS_DOWN = { leftThigh: d(0.05, -1, 0), leftShin: d(0, -1, 0), rightThigh: d(-0.05, -1, 0), rightShin: d(0, -1, 0) };
export const TARGET_POSES = [
  { name: 'T-Pose', bones: { leftUpperArm: d(1, 0, 0), leftForeArm: d(1, 0, 0), rightUpperArm: d(-1, 0, 0), rightForeArm: d(-1, 0, 0), ...LEGS_DOWN } },
  { name: 'Victory V', bones: { leftUpperArm: d(0.6, 1, 0), leftForeArm: d(0.6, 1, 0), rightUpperArm: d(-0.6, 1, 0), rightForeArm: d(-0.6, 1, 0), ...LEGS_DOWN } },
  { name: 'Goal Post', bones: { leftUpperArm: d(1, 0, 0), leftForeArm: d(0, 1, 0), rightUpperArm: d(-1, 0, 0), rightForeArm: d(0, 1, 0), ...LEGS_DOWN } },
  { name: 'Star Jump', bones: { leftUpperArm: d(1, 0.7, 0), leftForeArm: d(1, 0.7, 0), rightUpperArm: d(-1, 0.7, 0), rightForeArm: d(-1, 0.7, 0),
    leftThigh: d(0.4, -1, 0), leftShin: d(0.4, -1, 0), rightThigh: d(-0.4, -1, 0), rightShin: d(-0.4, -1, 0) } },
  { name: 'Left Arm Up', bones: { ...ARMS_DOWN, leftUpperArm: d(0.15, 1, 0), leftForeArm: d(0.1, 1, 0), ...LEGS_DOWN } },
  { name: 'Right Arm Point', bones: { ...ARMS_DOWN, rightUpperArm: d(-1, 0.1, 0.4), rightForeArm: d(-1, 0.1, 0.4), ...LEGS_DOWN } },
  { name: 'Knee Raise (right)', bones: { leftUpperArm: d(1, -0.2, 0), leftForeArm: d(1, -0.2, 0), rightUpperArm: d(-1, -0.2, 0), rightForeArm: d(-1, -0.2, 0),
    leftThigh: d(0.05, -1, 0), leftShin: d(0, -1, 0), rightThigh: d(-0.1, 0.05, 1), rightShin: d(0, -1, 0.1) } },
  { name: 'Hands On Head', bones: { leftUpperArm: d(1, 0.45, 0), leftForeArm: d(-0.9, 0.6, 0), rightUpperArm: d(-1, 0.45, 0), rightForeArm: d(0.9, 0.6, 0), ...LEGS_DOWN } },
];
const SCORED = ['leftUpperArm', 'leftForeArm', 'rightUpperArm', 'rightForeArm', 'leftThigh', 'leftShin', 'rightThigh', 'rightShin'];
const CHILD = { leftUpperArm: 'leftForeArm', leftForeArm: 'leftHand', rightUpperArm: 'rightForeArm', rightForeArm: 'rightHand',
  leftThigh: 'leftShin', leftShin: 'leftFoot', rightThigh: 'rightShin', rightShin: 'rightFoot' };

/** Accuracy of the avatar's current limb directions vs a target, in hip-relative character space. */
export function poseError(bones, root, target) {
  root.updateMatrixWorld(true);
  const hipsQ = bones.hips.getWorldQuaternion(new THREE.Quaternion());
  const rootQ = root.getWorldQuaternion(new THREE.Quaternion());
  // ignore body yaw: compare in a frame that only follows the hips' heading
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(rootQ.clone().invert().multiply(hipsQ));
  const yaw = Math.atan2(fwd.x, fwd.z);
  const unYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yaw).multiply(rootQ.clone().invert());
  const per = {};
  let sum = 0, n = 0;
  for (const b of SCORED) {
    if (!target.bones[b]) continue;
    const a = bones[b].getWorldPosition(new THREE.Vector3());
    const c = bones[CHILD[b]].getWorldPosition(new THREE.Vector3());
    const dir = c.sub(a).applyQuaternion(unYaw).normalize();
    const err = THREE.MathUtils.radToDeg(dir.angleTo(target.bones[b]));
    per[b] = err; sum += err; n++;
  }
  const mean = sum / Math.max(1, n);
  return { mean, per, score: Math.max(0, Math.min(100, 100 * (1 - (mean - 8) / 40))) };
}

export class PoseMatchTest {
  constructor(ui, ghost) {
    this.ui = ui; this.ghost = ghost;
    this.active = false; this.index = 0; this.hold = 0; this.results = []; this.tStart = 0;
  }
  start() {
    this.active = true; this.index = 0; this.results = [];
    this.ui.banner('Pose match', 'Match the glowing ghost and hold it');
    this._show();
  }
  stop() { this.active = false; this.ghost.visible = false; this.ui.prompt(null); this.ui.meter(null); }
  _show() {
    const p = TARGET_POSES[this.index];
    this.ghost.setPose(p.bones);
    this.ghost.visible = true;
    this.hold = 0; this.best = 0; this.tStart = performance.now();
    this.ui.prompt({ text: p.name, sub: `Pose ${this.index + 1} / ${TARGET_POSES.length} — hold 1 s at ≥ 75%`, color: '#9be7ff' });
  }
  update(dt, bones, root, tracking) {
    if (!this.active) return;
    const p = TARGET_POSES[this.index];
    const e = poseError(bones, root, p);
    this.best = Math.max(this.best, e.score);
    this.ghost.highlight(e.per);
    this.ui.meter({ value: e.score, label: `${Math.round(e.score)}%  (avg limb error ${e.mean.toFixed(0)}°)` });
    if (tracking && e.score >= 75) this.hold += dt; else this.hold = Math.max(0, this.hold - dt * 2);
    const elapsed = (performance.now() - this.tStart) / 1000;
    if (this.hold >= 1 || elapsed > 12) {
      this.results.push({ name: p.name, score: this.best, err: e.mean, time: this.hold >= 1 ? elapsed : null });
      this.ui.flash(this.hold >= 1 ? 'MATCHED!' : 'SKIPPED', this.hold >= 1 ? '#2ed573' : '#ff6b6b');
      this.index++;
      if (this.index >= TARGET_POSES.length) {
        this.stop();
        const ok = this.results.filter((r) => r.time != null);
        this.ui.showResults({
          title: 'Pose match results',
          header: ['Pose', 'Best accuracy', 'Time to match'],
          rows: this.results.map((r) => [r.name, `${Math.round(r.score)}%`, r.time == null ? 'skipped' : `${r.time.toFixed(1)} s`]),
          footer: [`Matched ${ok.length}/${this.results.length}`,
            `mean best accuracy ${Math.round(this.results.reduce((a, r) => a + r.score, 0) / this.results.length)}%`],
        });
      } else this._show();
    }
  }
}

// --------------------------------------------------------------------------------------------- Ghost
/** Glowing capsule skeleton that displays a target pose next to/over the avatar. */
export class Ghost extends THREE.Group {
  constructor(retarget) {
    super();
    this.rt = retarget;
    this.visible = false;
    const P = retarget.restPos;
    this.len = {};
    for (const b of SCORED) this.len[b] = P[b].distanceTo(P[CHILD[b]]);
    this.mat = {};
    this.segs = {};
    const geo = new THREE.CapsuleGeometry(0.045, 1, 4, 10);
    geo.translate(0, 0.5, 0);
    for (const b of SCORED) {
      const m = new THREE.MeshBasicMaterial({ color: 0x66e0ff, transparent: true, opacity: 0.5, depthWrite: false, depthTest: false });
      const mesh = new THREE.Mesh(geo, m);
      mesh.renderOrder = 15; this.add(mesh); this.segs[b] = mesh; this.mat[b] = m;
    }
    const torsoGeo = new THREE.CapsuleGeometry(0.11, 0.38, 4, 12);
    this.torso = new THREE.Mesh(torsoGeo, new THREE.MeshBasicMaterial({ color: 0x66e0ff, transparent: true, opacity: 0.2, depthWrite: false, depthTest: false }));
    this.add(this.torso);
    this.head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 12), this.torso.material);
    this.add(this.head);
    this.renderOrder = 10;
  }
  setPose(dirs) {
    const P = this.rt.restPos;
    const hip = P.hips;
    this.torso.position.set(0, (P.hips.y + P.neck.y) / 2, 0);
    this.head.position.set(0, P.head.y + 0.1, 0);
    const start = { leftUpperArm: P.leftUpperArm, rightUpperArm: P.rightUpperArm, leftThigh: P.leftThigh, rightThigh: P.rightThigh };
    const place = (b, from) => {
      const dir = dirs[b];
      const s = this.segs[b];
      s.position.copy(from);
      s.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      s.scale.set(1, this.len[b], 1);
      return from.clone().add(dir.clone().multiplyScalar(this.len[b]));
    };
    for (const side of ['left', 'right']) {
      const elbow = place(side + 'UpperArm', start[side + 'UpperArm']);
      place(side + 'ForeArm', elbow);
      const knee = place(side + 'Thigh', start[side + 'Thigh']);
      place(side + 'Shin', knee);
    }
    void hip;
  }
  highlight(per) {
    for (const [b, m] of Object.entries(this.mat)) {
      const e = per[b] ?? 0;
      m.color.setHSL(THREE.MathUtils.clamp(0.33 - (e - 10) / 90, 0, 0.33), 0.9, 0.6);
    }
  }
}
