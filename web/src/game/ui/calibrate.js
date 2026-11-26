// Calibration screen: "Strike the pose". A glowing T-pose silhouette fills from the feet up while the player
// holds a matching T-pose for 1 s. The player's live skeleton is drawn inside the silhouette so they can see
// themselves line up; each arm lights when it matches. Distance guidance (step back / forward, move left /
// right) comes from the 2D keypoint bounds, with a mini camera-view map. On success the motion pipeline re-runs
// its standing calibration (floor, facing, player size) while the player is still standing in the pose.
import { h, uiButton, freshFrame, drawSkeleton, measureDistance, DISTANCE_TEXT, kpBounds, kpIsSelfie, clamp01 } from './body.js';

const HOLD_S = 1.0;
// T-pose silhouette in a 400 x 460 box (front view; the player's left is screen left like a mirror)
const SIL = {
  head: 'M200 18a30 34 0 1 1 -0.1 0z',
  body: 'M168 84 Q200 76 232 84 L236 150 Q240 200 232 236 L226 250 L174 250 L168 236 Q160 200 164 150 Z',
  armL: 'M168 88 L60 92 Q22 94 14 100 Q22 112 60 112 L170 118 Z',
  armR: 'M232 88 L340 92 Q378 94 386 100 Q378 112 340 112 L230 118 Z',
  legL: 'M176 246 L198 248 L196 340 L192 440 L166 444 L164 340 Z',
  legR: 'M224 246 L202 248 L204 340 L208 440 L234 444 L236 340 Z',
};
const SIL_BOX = { x: 14, y: 18, w: 372, h: 426, cx: 200, top: 18, bottom: 444 };

export function calibrateScreen(ctx, ui, { onDone, recalibrate = true } = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 400 460');
  svg.setAttribute('class', 'bl-sil');
  const all = Object.values(SIL).join(' ');
  svg.innerHTML = `
    <defs>
      <linearGradient id="blSilFill" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0" stop-color="#ff4fd8"/><stop offset=".55" stop-color="#8b5cff"/><stop offset="1" stop-color="#4ff3ff"/>
      </linearGradient>
      <clipPath id="blSilClip"><rect class="bl-sil-cliprect" x="0" y="460" width="400" height="460"/></clipPath>
      <filter id="blSilGlow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    </defs>
    <path d="${all}" class="bl-sil-base"/>
    <g clip-path="url(#blSilClip)"><path d="${all}" fill="url(#blSilFill)" class="bl-sil-fill"/></g>
    <path d="${SIL.armL}" class="bl-sil-part p-armL"/><path d="${SIL.armR}" class="bl-sil-part p-armR"/>
    <path d="${SIL.head} ${SIL.body} ${SIL.legL} ${SIL.legR}" class="bl-sil-part p-body"/>
    <path d="${all}" class="bl-sil-line" filter="url(#blSilGlow)"/>`;
  const clipRect = svg.querySelector('.bl-sil-cliprect');
  const parts = { armL: svg.querySelector('.p-armL'), armR: svg.querySelector('.p-armR'), body: svg.querySelector('.p-body') };
  const live = h('canvas', { class: 'bl-sil-live', width: 400, height: 460 });
  const lg = live.getContext('2d');
  const pct = h('div', { class: 'bl-calib-pct' }, '0');
  const state = h('div', { class: 'bl-calib-state' }, 'SEARCHING FOR YOU…');
  const guide = h('div', { class: 'bl-calib-guide' });
  const mini = h('canvas', { class: 'bl-calib-mini', width: 192, height: 120 });
  const mg = mini.getContext('2d');
  const checks = {
    frame: h('li', {}, 'Whole body in view'),
    armL: h('li', {}, 'Left arm straight out'),
    armR: h('li', {}, 'Right arm straight out'),
    still: h('li', {}, 'Hold it for 1 second'),
  };
  const node = h('div', { class: 'bl-calib' },
    h('div', { class: 'bl-calib-side' },
      h('div', { class: 'bl-kicker' }, 'CALIBRATION'),
      h('h1', { class: 'bl-h1' }, 'STRIKE', h('br'), 'THE POSE'),
      h('p', { class: 'bl-calib-text' }, 'Stand tall, arms straight out to the sides. Match the glowing silhouette and hold.'),
      h('ul', { class: 'bl-checks' }, Object.values(checks)),
      h('div', { class: 'bl-calib-minibox' }, h('span', {}, 'CAMERA VIEW'), mini)),
    h('div', { class: 'bl-calib-stage' }, svg, live, h('div', { class: 'bl-calib-meter' }, pct, h('small', {}, '%')), state),
    guide,
    h('div', { class: 'bl-calib-skip' }, (() => { const b = uiButton('SKIP', () => finish(true), { cls: 'is-small', id: 'calib-skip' }); b.setAttribute('data-ui-mouseonly', ''); return b; })()));

  let progress = 0, done = false, t = 0, guideState;
  const upperOnly = () => !!ctx.settings?.upperBodyOnly;

  function finish(skipped = false) {
    if (done) return;
    done = true;
    node.classList.add('is-done');
    state.textContent = skipped ? 'SKIPPED' : 'CALIBRATED!';
    if (!skipped) {
      try { ctx.audio?.sfx?.('perfect'); } catch { /* optional */ }
      if (recalibrate) { try { ctx.motion?.calibrate?.(); } catch (e) { console.error(e); } }
      svg.animate([{ filter: 'brightness(3) drop-shadow(0 0 30px #fff)' }, { filter: 'none' }], { duration: 700, easing: 'ease-out' });
    }
    setTimeout(() => onDone?.({ skipped }), skipped ? 0 : 900);
  }

  /** Per-arm T-pose match 0..1 from the 3D joints (player frame), using the torso's own left/right axis. */
  function match(J) {
    const sx = J.leftShoulder.x - J.rightShoulder.x, sy = J.leftShoulder.y - J.rightShoulder.y, sz = J.leftShoulder.z - J.rightShoulder.z;
    const sl = Math.hypot(sx, sy, sz) || 1;
    const out = { x: sx / sl, y: 0, z: sz / sl };
    const arm = (side, sg) => {
      const S = J[side + 'Shoulder'], E = J[side + 'Elbow'], W = J[side + 'Wrist'];
      if (!S || !E || !W) return 0;
      const d = (a, b) => { const x = b.x - a.x, y = b.y - a.y, z = b.z - a.z, l = Math.hypot(x, y, z) || 1; return (x * out.x + z * out.z) * sg / l; };
      return clamp01((d(S, E) - 0.72) / 0.22) * clamp01((d(E, W) - 0.68) / 0.24) * clamp01((d(S, W) - 0.8) / 0.15);
    };
    const hip = J.leftHip && J.rightHip ? { x: (J.leftHip.x + J.rightHip.x) / 2, y: (J.leftHip.y + J.rightHip.y) / 2, z: (J.leftHip.z + J.rightHip.z) / 2 } : null;
    let upright = 1;
    if (hip) { const ux = (J.leftShoulder.x + J.rightShoulder.x) / 2 - hip.x, uy = (J.leftShoulder.y + J.rightShoulder.y) / 2 - hip.y, uz = (J.leftShoulder.z + J.rightShoulder.z) / 2 - hip.z; upright = clamp01((uy / (Math.hypot(ux, uy, uz) || 1) - 0.85) / 0.1); }
    return { l: arm('left', 1), r: arm('right', -1), upright };
  }

  function drawLive(f) {
    lg.clearRect(0, 0, 400, 460);
    if (!f?.kp2d?.length) return;
    const b = kpBounds(f);
    if (b.n < 5) return;
    // fit the player's keypoints to the silhouette: uniform scale by height, centred on the mean x
    const asp = kpIsSelfie(f) ? 2.4 / 2.2 : ui.videoAspect || 16 / 9;
    let mx = 0, n = 0;
    for (const p of f.kp2d) if ((p.c ?? 1) >= 0.45) { mx += kpIsSelfie(f) ? p.x : 1 - p.x; n++; }
    mx /= n || 1;
    const bh = Math.max(0.05, b.maxY - b.minY);
    const fullBody = !upperOnly();
    const silH = (SIL_BOX.bottom - SIL_BOX.top) * (fullBody ? 0.9 : 0.55);
    const s = silH / bh;
    const map = (x, y) => [SIL_BOX.cx + (x - mx) * s * asp, SIL_BOX.top + 30 + (y - b.minY) * s];
    drawSkeleton(lg, { source: 'synthetic' }, f.kp2d.map((p) => (kpIsSelfie(f) ? p : { x: 1 - p.x, y: p.y, c: p.c })), f.edges, map, { width: 4, glow: 16, color: '#ffffff', core: '#fff6c8' });
  }

  function drawMini(f, dist) {
    const W = mini.width, H = mini.height;
    mg.clearRect(0, 0, W, H);
    mg.fillStyle = 'rgba(12,8,32,.8)'; mg.fillRect(0, 0, W, H);
    mg.strokeStyle = 'rgba(160,140,255,.35)'; mg.lineWidth = 1; mg.setLineDash([4, 4]);
    mg.strokeRect(W * 0.28, H * 0.04, W * 0.44, H * 0.92); mg.setLineDash([]);
    if (!f) return;
    drawSkeleton(mg, f, f.kp2d, f.edges, (x, y) => [x * W, y * H], { width: 1.6, glow: 6, color: dist ? '#ffb02e' : '#4ff3ff', joints: false });
    const b = kpBounds(f);
    if (b.n >= 5) {
      mg.strokeStyle = dist ? '#ffb02e' : '#7dffb0'; mg.lineWidth = 1.5;
      mg.strokeRect(b.minX * W - 3, b.minY * H - 3, (b.maxX - b.minX) * W + 6, (b.maxY - b.minY) * H + 6);
    }
  }

  function setGuide(d) {
    if (d === guideState) return;
    guideState = d;
    if (!d) { guide.classList.remove('is-on'); return; }
    const D = DISTANCE_TEXT[d];
    guide.innerHTML = `<i class="bl-guide-arrow a-${D.arrow}"></i><b>${D.title}</b><span>${D.sub}</span>`;
    guide.classList.add('is-on');
  }

  return {
    node,
    get progress() { return progress; },
    finish,
    update(dt) {
      t += dt;
      if (done) return;
      const f = freshFrame(ctx.motion, 600);
      let m = { l: 0, r: 0, upright: 0 }, dist = null;
      if (f) {
        m = match(f.joints);
        dist = measureDistance(f, { upperBodyOnly: upperOnly() });
        // the detector's own T-pose state also counts (it is what gameplay uses)
        if (ctx.motion?.actions?.state?.tPose) { m.l = Math.max(m.l, 0.7); m.r = Math.max(m.r, 0.7); }
      }
      setGuide(f ? dist : null);
      drawLive(f); drawMini(f, dist);
      const okFrame = !!f && (!dist || dist === 'too-far');
      const score = Math.min(m.l, m.r) * m.upright;
      const matched = okFrame && score > 0.55;
      progress = matched ? Math.min(1, progress + dt / HOLD_S) : Math.max(0, progress - dt * 1.6);
      clipRect.setAttribute('y', (460 - 460 * (0.04 + progress * 0.96)).toFixed(1));
      parts.armL.classList.toggle('is-ok', m.l > 0.55); parts.armR.classList.toggle('is-ok', m.r > 0.55);
      parts.body.classList.toggle('is-ok', okFrame && m.upright > 0.5);
      node.classList.toggle('is-matching', matched);
      pct.textContent = Math.round(progress * 100);
      // the player's left arm is on screen-left in this mirror-style view
      checks.frame.classList.toggle('is-ok', okFrame && !dist);
      checks.armL.classList.toggle('is-ok', m.l > 0.55);
      checks.armR.classList.toggle('is-ok', m.r > 0.55);
      checks.still.classList.toggle('is-ok', progress > 0.5);
      const txt = !f ? 'SEARCHING FOR YOU…' : dist && dist !== 'too-far' ? DISTANCE_TEXT[dist].title : matched ? 'HOLD IT!' : dist ? 'STEP FORWARD' : score > 0.25 ? 'ALMOST… ARMS STRAIGHT' : 'ARMS OUT TO THE SIDES';
      if (state.textContent !== txt) state.textContent = txt;
      if (progress >= 1) finish(false);
    },
  };
}
