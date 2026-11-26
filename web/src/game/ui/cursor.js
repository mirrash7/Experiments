// Hand cursor: the player's tracked hand drives a glowing reticle over any [data-ui-button] on the page.
//
// Mapping ('body' mode, default): a Kinect-style "interaction box" in front of the player's shoulders. The hand
// position is taken RELATIVE to the shoulder centre in hero space (hero hand bones, which the motion pipeline has
// already predicted to render time and spring-smoothed), normalized by arm length, and mapped to the screen.
// It is independent of the 3D camera (title orbit, cinematic cuts), so the cursor never drifts when the camera
// moves, and it uses the same player-left = screen-left convention as the gameplay camera. Fallback when no hero:
// the tracker's 3D joints (same frame convention). 'project' mode projects the hand bone through ctx.camera.
//
// Select: hold over a button for 0.8 s (radial fill), or punch while over / snapped to it. Magnetic snapping pulls
// the reticle toward the nearest button. Mouse moves take over instantly (native clicks), keyboard arrows move focus.
import * as THREE from 'three';
import { freshFrame, OneEuro, clamp01, h } from './body.js';

const DWELL_S = 0.8;
const SVG_NS = 'http://www.w3.org/2000/svg';
const RING_R = 26, RING_C = 2 * Math.PI * RING_R;

const _v = new THREE.Vector3(), _m = new THREE.Matrix4();
const P = () => ({ x: 0, y: 0, z: 0 });

export function createCursor(ctx, root) {
  const sfx = (n) => { try { ctx.audio?.sfx?.(n); } catch { /* audio optional */ } };

  // ---------------------------------------------------------------- DOM
  const el = h('div', { class: 'bl-cursor is-off', 'aria-hidden': 'true' });
  el.innerHTML = `
    <svg viewBox="-40 -40 80 80" width="80" height="80">
      <defs><filter id="blCurGlow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
      <g class="bl-cur-spin"><path d="M0 -34 L4 -29 L-4 -29Z M0 34 L4 29 L-4 29Z M-34 0 L-29 4 L-29 -4Z M34 0 L29 4 L29 -4Z" class="bl-cur-ticks"/></g>
      <circle r="${RING_R}" class="bl-cur-track"/>
      <circle r="${RING_R}" class="bl-cur-prog" stroke-dasharray="${RING_C}" stroke-dashoffset="${RING_C}" transform="rotate(-90)" filter="url(#blCurGlow)"/>
      <circle r="9" class="bl-cur-core" filter="url(#blCurGlow)"/>
      <circle r="3.2" class="bl-cur-dot"/>
    </svg>
    <span class="bl-cur-hint"></span>`;
  root.append(el);
  const prog = el.querySelector('.bl-cur-prog');
  const hint = el.querySelector('.bl-cur-hint');

  // ---------------------------------------------------------------- state
  const st = {
    enabled: 'auto',            // 'auto' = on whenever a [data-ui-button] is visible
    mode: 'body',               // 'body' | 'project'
    active: false,
    source: 'none',             // 'hand' | 'mouse' | 'none'
    engaged: false,             // hand raised into the interaction box
    hand: 'right',
    raw: { u: 0.5, v: 0.5 },    // filtered hand position, normalized screen coords (before the magnet)
    x: innerWidth / 2, y: innerHeight / 2,   // displayed reticle position, px
    target: null, dwell: 0, lastSelect: 0, selects: 0,
    tracked: false,
  };
  const fu = new OneEuro(1.4, 5, 1.2), fv = new OneEuro(1.4, 5, 1.2);
  let mouse = { x: 0, y: 0, t: -1e9 };
  let buttons = [], allButtons = [], buttonsT = 0;
  let switchT = 0, lastEngagedT = -1e9;
  const hist = new Array(16).fill(null).map(() => ({ t: 0, target: null })); let histI = 0;
  const S = P(), Lh = P(), Rh = P(), Ls = P(), Rs = P(), Hp = P();

  // ---------------------------------------------------------------- inputs
  const onMove = (e) => { if (e.pointerType === 'touch') return; mouse = { x: e.clientX, y: e.clientY, t: performance.now() }; };
  addEventListener('pointermove', onMove, { passive: true });
  const onKey = (e) => {
    const dirs = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const d = dirs[e.key];
    if (!d) return;
    const list = visibleButtons(true, true);
    if (!list.length) return;
    e.preventDefault();
    const cur = list.includes(document.activeElement) ? document.activeElement : null;
    if (!cur) { list[0].focus(); sfx('uiHover'); return; }
    const a = cur.getBoundingClientRect(), ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    let best = null, bestS = Infinity;
    for (const b of list) {
      if (b === cur) continue;
      const r = b.getBoundingClientRect(), dx = r.left + r.width / 2 - ax, dy = r.top + r.height / 2 - ay;
      const along = dx * d[0] + dy * d[1];
      if (along <= 4) continue;
      const across = Math.abs(dx * d[1]) + Math.abs(dy * d[0]);
      const s = along + across * 2.2;
      if (s < bestS) { bestS = s; best = b; }
    }
    if (best) { best.focus(); sfx('uiHover'); }
  };
  addEventListener('keydown', onKey);
  const offPunch = ctx.motion?.actions?.on?.((name) => {
    if (name !== 'punchLeft' && name !== 'punchRight') return;
    if (!st.active || st.source !== 'hand') return;
    // the punch moves the hand forward (and often up): use where the reticle was ~120 ms before it fired
    const now = performance.now();
    let t = st.target;
    for (let i = 0; i < hist.length; i++) {
      const e = hist[(histI - 1 - i + hist.length * 2) % hist.length];
      if (e.t && now - e.t >= 100 && now - e.t < 400) { t = e.target || t; break; }
    }
    if (t && t.isConnected && !t.hasAttribute('data-ui-nopunch')) select(t, 'punch');
  });

  // ---------------------------------------------------------------- buttons
  function isUsable(b) {
    if (b.disabled || b.closest('[data-ui-inert], .is-leaving, .bl-hidden')) return false;
    const r = b.getBoundingClientRect();
    return r.width > 2 && r.height > 2 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }
  function visibleButtons(force = false, keyboard = false) {
    const now = performance.now();
    if (force || now - buttonsT > 200) {
      buttonsT = now;
      allButtons = [...document.querySelectorAll('[data-ui-button]')].filter(isUsable);
      // [data-ui-mouseonly]: never a hand target (e.g. calibration SKIP: the T-pose puts the hands at the edges)
      buttons = allButtons.filter((b) => !b.hasAttribute('data-ui-mouseonly'));
    }
    return keyboard ? allButtons : buttons;
  }

  function setTarget(t) {
    if (t === st.target) return;
    if (st.target) { st.target.classList.remove('is-hover'); st.target.style.removeProperty('--dwell'); }
    st.target = t; st.dwell = 0;
    if (t) { t.classList.add('is-hover'); if (st.source === 'hand') sfx('uiHover'); }
  }

  function select(t, how = 'dwell') {
    const now = performance.now();
    if (now - st.lastSelect < 350) return;
    st.lastSelect = now; st.selects++; st.lastHow = how;
    sfx('uiSelect');
    burst(how);
    t.classList.add('is-pressed');
    setTimeout(() => t.classList.remove('is-pressed'), 260);
    st.dwell = 0;
    t.click();
  }

  function burst(how) {
    const b = h('div', { class: 'bl-cursor-burst' + (how === 'punch' ? ' is-punch' : '') });
    b.style.transform = `translate3d(${st.x}px, ${st.y}px, 0)`;
    root.append(b);
    b.animate([{ opacity: 1, scale: 0.4 }, { opacity: 0, scale: how === 'punch' ? 3.2 : 2.2 }], { duration: 420, easing: 'cubic-bezier(.2,.8,.2,1)' }).onfinish = () => b.remove();
  }

  // ---------------------------------------------------------------- hand sampling
  const local = (bone, out) => {
    bone.updateWorldMatrix(true, false);
    _v.setFromMatrixPosition(bone.matrixWorld);
    _m.copy(ctx.hero.root.matrixWorld).invert();
    _v.applyMatrix4(_m);
    out.x = _v.x; out.y = _v.y; out.z = _v.z;
    return out;
  };
  const copy = (src, out) => { out.x = src.x; out.y = src.y; out.z = src.z; return out; };

  /** Fill Ls/Rs/Lh/Rh/Hp (hero space or player space, same convention: left = +x, forward = +z). */
  function sampleBody(frame) {
    const B = ctx.hero?.bones;
    if (B?.leftHand && B?.rightHand && B?.leftUpperArm && ctx.hero.root) {
      local(B.leftUpperArm, Ls); local(B.rightUpperArm, Rs);
      local(B.leftHandTip || B.leftHand, Lh); local(B.rightHandTip || B.rightHand, Rh);
      local(B.hips, Hp);
      return ctx.hero.info?.armLength || 0.5;
    }
    const J = frame?.joints;
    if (!J?.leftShoulder || !J?.rightShoulder) return 0;
    copy(J.leftShoulder, Ls); copy(J.rightShoulder, Rs);
    copy(J.leftHand || J.leftWrist, Lh); copy(J.rightHand || J.rightWrist, Rh);
    Hp.x = (J.leftHip.x + J.rightHip.x) / 2; Hp.y = (J.leftHip.y + J.rightHip.y) / 2; Hp.z = (J.leftHip.z + J.rightHip.z) / 2;
    const arm = Math.hypot(J.leftShoulder.x - J.leftWrist.x, J.leftShoulder.y - J.leftWrist.y, J.leftShoulder.z - J.leftWrist.z);
    return Math.max(0.45, Math.min(0.75, arm * 1.05)) || 0.55;
  }

  /** Normalized screen position of one hand in the interaction box. */
  function handUV(side, L, out) {
    const H = side === 'left' ? Lh : Rh, sg = side === 'left' ? 1 : -1;
    const relx = H.x - S.x, rely = H.y - S.y, relz = H.z - S.z;
    out.u = 0.5 + (-relx + sg * 0.2 * L) / (1.1 * L);
    out.v = 0.5 - (rely + 0.12 * L) / (0.85 * L);
    out.score = rely + 0.6 * Math.max(0, relz);
    out.engaged = rely > -0.55 * L || relz > 0.5 * L;
    return out;
  }
  const UL = { u: 0, v: 0, score: 0, engaged: false }, UR = { u: 0, v: 0, score: 0, engaged: false };

  function projectUV(side, out) {
    const B = ctx.hero?.bones; const bone = side === 'left' ? (B?.leftHandTip || B?.leftHand) : (B?.rightHandTip || B?.rightHand);
    if (!bone || !ctx.camera) return null;
    bone.updateWorldMatrix(true, false);
    _v.setFromMatrixPosition(bone.matrixWorld).project(ctx.camera);
    out.u = (_v.x + 1) / 2; out.v = (1 - _v.y) / 2;
    return out;
  }

  /** Track the hand → st.raw (filtered) and st.engaged. Returns true if a hand sample exists. */
  function trackHand(dt, now) {
    const frame = freshFrame(ctx.motion, 600, now);
    st.tracked = !!frame;
    if (!frame) { st.engaged = false; return false; }
    const L = sampleBody(frame);
    if (!L) { st.engaged = false; return false; }
    S.x = (Ls.x + Rs.x) / 2; S.y = (Ls.y + Rs.y) / 2; S.z = (Ls.z + Rs.z) / 2;
    handUV('left', L, UL); handUV('right', L, UR);
    // active hand: the raised one, with hysteresis (switch after 150 ms of the other being clearly higher)
    const cur = st.hand === 'left' ? UL : UR, oth = st.hand === 'left' ? UR : UL;
    const want = (oth.engaged && !cur.engaged) || (oth.engaged && oth.score > cur.score + 0.14 * L);
    switchT = want ? switchT + dt : 0;
    if (switchT > 0.15 || (want && !cur.engaged)) {
      st.hand = st.hand === 'left' ? 'right' : 'left'; switchT = 0;
      const n = st.hand === 'left' ? UL : UR; fu.reset(n.u); fv.reset(n.v);
    }
    const A = st.hand === 'left' ? UL : UR;
    st.engaged = A.engaged;
    let u = A.u, v = A.v;
    if (st.mode === 'project') { const p = projectUV(st.hand, { u: 0, v: 0 }); if (p) { u = p.u; v = p.v; } }
    st.raw.u = fu.filter(clamp01(u), dt);
    st.raw.v = fv.filter(clamp01(v), dt);
    return true;
  }

  // ---------------------------------------------------------------- magnet
  function nearest(px, py, list) {
    let best = null, bestD = Infinity;
    for (const b of list) {
      const r = b.getBoundingClientRect();
      const dx = Math.max(r.left - px, 0, px - r.right), dy = Math.max(r.top - py, 0, py - r.bottom);
      const d = Math.hypot(dx, dy);
      if (d < bestD) { bestD = d; best = { el: b, r, d }; }
    }
    return best;
  }

  // ---------------------------------------------------------------- per frame
  function update(dt = 1 / 60) {
    const now = performance.now();
    dt = Math.min(0.1, Math.max(1e-4, dt));
    const list = visibleButtons();
    const want = st.enabled === true || (st.enabled === 'auto' && list.length > 0);
    if (want !== st.active) {
      st.active = want;
      el.classList.toggle('is-off', !want);
      if (!want) { setTarget(null); st.source = 'none'; }
    }
    if (!st.active) { trackHand(dt, now); return; }

    const hasHand = trackHand(dt, now);
    if (st.engaged) lastEngagedT = now;
    const mouseRecent = now - mouse.t < 1500;
    const prevSource = st.source;
    if (mouseRecent && (!st.engaged || now - mouse.t < 400)) st.source = 'mouse';
    else if (hasHand) st.source = 'hand';
    else st.source = mouseRecent ? 'mouse' : 'none';
    if (prevSource !== st.source && st.source === 'hand') { st.x = st.raw.u * innerWidth; st.y = st.raw.v * innerHeight; }

    let px, py;
    const W = innerWidth, H = innerHeight;
    if (st.source === 'mouse') { px = mouse.x; py = mouse.y; }
    else { px = (0.03 + st.raw.u * 0.94) * W; py = (0.04 + st.raw.v * 0.92) * H; }

    // magnetic snap (hand only: the mouse is already precise)
    let target = null;
    const R = Math.min(W, H) * 0.075;
    const n = list.length ? nearest(px, py, list) : null;
    if (n) {
      const keep = n.el === st.target ? R * 1.5 : R;
      if (n.d <= keep) target = n.el;
      if (st.source === 'hand' && target) {
        const cx = n.r.left + n.r.width / 2, cy = n.r.top + n.r.height / 2;
        const inside = n.d === 0;
        const k = inside ? 0.42 : 0.5 * (1 - n.d / keep) ** 2;
        px += (cx - px) * k; py += (cy - py) * k * 1.15;
      }
    }
    if (st.source === 'hand' && !st.engaged) target = null;
    setTarget(target);
    hist[histI].t = now; hist[histI].target = target; histI = (histI + 1) % hist.length;

    // displayed position: a short spring (~18 ms) so magnet engage/release never jumps
    if (st.source === 'mouse') { st.x = px; st.y = py; }
    else { const a = 1 - Math.exp(-dt / 0.018); st.x += (px - st.x) * a; st.y += (py - st.y) * a; }

    // dwell
    if (target && st.source === 'hand' && st.engaged) {
      const repeat = target.hasAttribute('data-ui-repeat');
      const dwellS = +target.getAttribute('data-ui-dwell') || (repeat && st.selects ? DWELL_S * 0.6 : DWELL_S);
      if (now - st.lastSelect > (repeat ? 450 : 700)) st.dwell += dt / dwellS;
      if (st.dwell >= 1) { st.dwell = 0; select(target, 'dwell'); }
    } else st.dwell = Math.max(0, st.dwell - dt * 4);
    if (st.target) st.target.style.setProperty('--dwell', st.dwell.toFixed(3));

    // render
    el.style.transform = `translate3d(${st.x.toFixed(1)}px, ${st.y.toFixed(1)}px, 0)`;
    prog.setAttribute('stroke-dashoffset', (RING_C * (1 - st.dwell)).toFixed(1));
    el.classList.toggle('is-mouse', st.source === 'mouse');
    el.classList.toggle('is-idle', st.source === 'hand' && !st.engaged);
    el.classList.toggle('is-lost', st.source === 'none');
    el.classList.toggle('is-target', !!target);
    el.dataset.hand = st.hand;
    const hintText = st.source === 'none' ? 'no tracking · use mouse / keys' : st.source === 'hand' && !st.engaged ? 'raise a hand' : target && st.source === 'hand' ? 'hold or punch' : '';
    if (hint.textContent !== hintText) hint.textContent = hintText;
  }

  return {
    el, state: st,
    enable(on) { st.enabled = on === 'auto' ? 'auto' : !!on; },
    setMode(m) { st.mode = m === 'project' ? 'project' : 'body'; },
    /** one-euro smoothing of the hand position (normalized screen units / s) */
    tune({ minCutoff, beta, dCutoff } = {}) { for (const f of [fu, fv]) { if (minCutoff) f.minCutoff = minCutoff; if (beta !== undefined) f.beta = beta; if (dCutoff) f.dCutoff = dCutoff; } },
    update,
    /** current reticle position (px) and the raw hand position (normalized) */
    pos() { return { x: st.x, y: st.y, u: st.raw.u, v: st.raw.v, source: st.source, engaged: st.engaged, hand: st.hand }; },
    dispose() {
      removeEventListener('pointermove', onMove); removeEventListener('keydown', onKey);
      offPunch?.(); setTarget(null); el.remove();
    },
  };
}
