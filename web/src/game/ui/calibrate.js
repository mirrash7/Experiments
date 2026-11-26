// Calibration screen: "Strike the pose". A smooth, glowing T-pose silhouette (filled SVG body parts) fills from the
// feet up while the player holds a matching T-pose for 1 s; each limb lights up as it matches, and one clean ring
// gauge shows the hold progress. Inside the guide the player sees themselves: the live camera silhouette from the CV
// team (`silhouetteCanvas`, fitted to the guide by the tracked keypoints) and/or the glowing tracked skeleton.
// Distance guidance (step back / forward, move left / right) comes from the 2D keypoint bounds, with a mini camera
// view. On success the motion pipeline re-runs its standing calibration while the player still holds the pose.
//
//   screens.calibrate({ onDone, recalibrate = true, silhouetteCanvas?, silhouetteMirrored = true, seated? })
//   handle: { progress, finish(), setSilhouetteCanvas(canvas|null, { mirrored }) }
//   silhouetteCanvas: any canvas/video/img covering the FULL camera frame (same framing as the tracker's kp2d).
//   mirrored = true means it is already in selfie view (the player's left on screen left).
import { h, uiButton, freshFrame, drawSkeleton, measureDistance, DISTANCE_TEXT, kpBounds, kpIsSelfie, clamp01 } from './body.js';

const HOLD_S = 1.0;
const mirror = (d) => d.replace(/(-?[\d.]+),(-?[\d.]+)/g, (_, x, y) => `${+(400 - x).toFixed(1)},${y}`);
// T-pose silhouette in a 400 x 460 box (front view, the player's left on screen left like a mirror)
const ARM_L = 'M156,94 C130,95 100,97 72,99 L46,100 C35,99 25,100 18,103 C11,106 11,116 18,118 C25,120 35,120 46,118 L72,118 C100,120 128,125 152,131 Z';
const LEG_L = 'M160,250 C157,282 160,312 166,342 C169,372 171,402 173,428 C169,435 160,441 155,445 C153,451 170,453 187,451 C191,447 193,440 193,430 C195,400 197,370 198,342 C200,312 200,290 200,262 Z';
const SIL = {
  head: 'M200,12 C217,12 227,27 227,44 C227,63 215,75 200,75 C185,75 173,63 173,44 C173,27 183,12 200,12 Z',
  body: 'M189,72 L211,72 L213,86 C226,88 240,90 252,96 C259,101 259,113 256,125 C250,142 244,162 240,186 C238,200 236,210 238,222 C242,236 245,250 243,264 L157,264 C155,250 158,236 162,222 C164,210 162,200 160,186 C156,162 150,142 144,125 C141,113 141,101 148,96 C160,90 174,88 187,86 Z',
  armL: ARM_L, armR: mirror(ARM_L), legL: LEG_L, legR: mirror(LEG_L),
};
const SIL_BOX = { cx: 200, top: 12, bottom: 452 };

export function calibrateScreen(ctx, ui, { onDone, recalibrate = true, silhouetteCanvas = null, silhouetteMirrored = true, seated } = {}) {
  const upperOnly = () => !!(seated ?? ctx.settings?.seated) || !!ctx.settings?.upperBodyOnly;
  const isSeated = !!(seated ?? ctx.settings?.seated);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 400 460');
  svg.setAttribute('class', 'bl-sil');
  const upperD = [SIL.head, SIL.body, SIL.armL, SIL.armR].join(' ');
  const all = isSeated ? upperD : Object.values(SIL).join(' ');
  const part = (k, extra = '') => `<path d="${SIL[k]}" class="bl-sil-part p-${k} ${extra}"/>`;
  svg.innerHTML = `
    <defs>
      <linearGradient id="blSilFill" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0" stop-color="#ff4fd8"/><stop offset=".5" stop-color="#8b5cff"/><stop offset="1" stop-color="#4ff3ff"/>
      </linearGradient>
      <radialGradient id="blSilBase" cx=".5" cy=".35" r=".7"><stop offset="0" stop-color="#8b5cff" stop-opacity=".34"/><stop offset="1" stop-color="#2a1260" stop-opacity=".18"/></radialGradient>
      <clipPath id="blSilShape"><path d="${all}"/></clipPath>
      <clipPath id="blSilClip"><rect class="bl-sil-cliprect" x="0" y="460" width="400" height="460"/></clipPath>
      <filter id="blSilGlow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="7" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      <filter id="blSilSoft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="14"/></filter>
    </defs>
    <ellipse cx="200" cy="452" rx="92" ry="9" class="bl-sil-floor"/>
    <path d="${all}" class="bl-sil-halo" filter="url(#blSilSoft)"/>
    <path d="${all}" class="bl-sil-base"/>
    <g clip-path="url(#blSilClip)"><path d="${all}" fill="url(#blSilFill)" class="bl-sil-fill"/></g>
    <g clip-path="url(#blSilShape)"><rect class="bl-sil-scan" x="0" y="-40" width="400" height="40"/></g>
    ${part('head')}${part('body')}${part('armL')}${part('armR')}${part('legL', isSeated ? 'is-optional' : '')}${part('legR', isSeated ? 'is-optional' : '')}
    <path d="${all}" class="bl-sil-line" filter="url(#blSilGlow)"/>
    ${isSeated ? `<path d="${SIL.legL} ${SIL.legR}" class="bl-sil-legs-opt"/>` : ''}`;
  if (isSeated) svg.classList.add('is-seated');
  const clipRect = svg.querySelector('.bl-sil-cliprect');
  const P = (k) => svg.querySelector('.p-' + k);
  const parts = { head: P('head'), body: P('body'), armL: P('armL'), armR: P('armR'), legL: P('legL'), legR: P('legR') };
  const live = h('canvas', { class: 'bl-sil-live', width: 800, height: 920 });
  const lg = live.getContext('2d');
  lg.scale(2, 2);

  // ring gauge (one element: number + % inline)
  const R = 44, C = 2 * Math.PI * R;
  const ring = h('div', { class: 'bl-calib-ring', html: `<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="${R}" class="bl-ring-track"/><circle cx="50" cy="50" r="${R}" class="bl-ring-fill" stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${C.toFixed(2)}" transform="rotate(-90 50 50)"/></svg>` });
  const ringFill = ring.querySelector('.bl-ring-fill');
  const pctNum = h('b', {}, '0');
  ring.append(h('div', { class: 'bl-ring-label' }, h('span', { class: 'bl-ring-num' }, pctNum, h('i', {}, '%')), h('small', {}, 'HOLD')));

  const state = h('div', { class: 'bl-calib-state' }, 'SEARCHING FOR YOU…');
  const guide = h('div', { class: 'bl-calib-guide' });
  const mini = h('canvas', { class: 'bl-calib-mini', width: 192, height: 120 });
  const mg = mini.getContext('2d');
  const liveTag = h('div', { class: 'bl-calib-livetag' }, h('i'), 'LIVE MIRROR');
  const checks = {
    frame: h('li', {}, isSeated ? 'Head, arms and hips in view' : 'Whole body in view'),
    armL: h('li', {}, 'Left arm straight out'),
    armR: h('li', {}, 'Right arm straight out'),
    still: h('li', {}, 'Hold it for 1 second'),
  };
  const skip = uiButton('SKIP', () => finish(true), { cls: 'is-small', id: 'calib-skip' });
  skip.setAttribute('data-ui-mouseonly', '');
  const node = h('div', { class: 'bl-calib' + (isSeated ? ' is-seated' : '') },
    h('div', { class: 'bl-calib-side' },
      h('div', { class: 'bl-kicker' }, isSeated ? 'CALIBRATION · SEATED' : 'CALIBRATION'),
      h('h1', { class: 'bl-h1' }, 'STRIKE', h('br'), 'THE POSE'),
      h('p', { class: 'bl-calib-text' }, isSeated ? 'Sit tall, arms straight out to the sides. Match the glowing silhouette and hold.' : 'Stand tall, arms straight out to the sides. Match the glowing silhouette and hold.'),
      h('ul', { class: 'bl-checks' }, Object.values(checks)),
      h('div', { class: 'bl-calib-minibox' }, h('span', {}, 'CAMERA VIEW'), mini)),
    h('div', { class: 'bl-calib-stage' }, svg, live, liveTag, ring, state),
    guide,
    h('div', { class: 'bl-calib-skip' }, skip));

  let progress = 0, done = false, t = 0, guideState;
  let silCanvas = silhouetteCanvas, silMirrored = silhouetteMirrored;
  const setSil = (c, { mirrored = true } = {}) => { silCanvas = c || null; silMirrored = mirrored; node.classList.toggle('has-mirror', !!silCanvas); };
  setSil(silhouetteCanvas, { mirrored: silhouetteMirrored });

  function finish(skipped = false) {
    if (done) return;
    done = true;
    node.classList.add('is-done');
    state.textContent = skipped ? 'SKIPPED' : 'CALIBRATED!';
    if (!skipped) {
      progress = 1; setProgress(1);
      try { ctx.audio?.sfx?.('perfect'); } catch { /* optional */ }
      if (recalibrate) { try { ctx.motion?.calibrate?.(); } catch (e) { console.error(e); } }
      svg.animate([{ filter: 'brightness(2.6) drop-shadow(0 0 30px #fff)' }, { filter: 'none' }], { duration: 800, easing: 'ease-out' });
      ring.animate([{ transform: 'scale(1.25)' }, { transform: 'scale(1)' }], { duration: 400, easing: 'cubic-bezier(.2,1.6,.4,1)' });
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
    const b = f?.kp2d?.length ? kpBounds(f) : null;
    const haveKp = b && b.n >= 5;
    if (!haveKp) {
      if (silCanvas && (silCanvas.width || silCanvas.videoWidth)) {           // no keypoints: centre the mirror image
        const cw = silCanvas.videoWidth || silCanvas.width, ch = silCanvas.videoHeight || silCanvas.height;
        const s = Math.min(400 / cw, 440 / ch);
        drawSil(silCanvas, 200 - (cw * s) / 2, 10, cw * s, ch * s);
      }
      return;
    }
    // fit the player's keypoints to the silhouette: uniform scale by height, centred on the mean x
    const selfie = kpIsSelfie(f);
    const asp = selfie ? 2.4 / 2.2 : ui.videoAspect || 16 / 9;
    let mx = 0, n = 0;
    for (const p of f.kp2d) if ((p.c ?? 1) >= 0.45) { mx += selfie ? p.x : 1 - p.x; n++; }
    mx /= n || 1;
    const minY = b.minY, bh = Math.max(0.05, b.maxY - b.minY);
    // full body: eyes → ankles = 394 guide units. Seated / upper body (legs bent or out of frame): when the arms are
    // spread, wrist-to-wrist = 308 units; otherwise assume the visible span is about eyes → knees
    const bw = Math.max(0.02, (b.maxX - b.minX) * asp);
    const s = !upperOnly() ? 394 / bh : bw > bh * 0.75 ? 308 / bw : 300 / bh;
    const oy = 42;                                    // eye line of the guide's head
    if (silCanvas && (silCanvas.width || silCanvas.videoWidth)) drawSil(silCanvas, SIL_BOX.cx - mx * s * asp, oy - minY * s, s * asp, s);
    const map = (x, y) => [SIL_BOX.cx + (x - mx) * s * asp, oy + (y - minY) * s];
    drawSkeleton(lg, { source: 'synthetic' }, f.kp2d.map((p) => (selfie ? p : { x: 1 - p.x, y: p.y, c: p.c })), f.edges, map,
      silCanvas ? { width: 1.8, glow: 8, color: '#4ff3ff', core: '#ffffff', alpha: 0.7 } : { width: 2.4, glow: 12, color: '#bff9ff', core: '#ffffff', alpha: 0.85 });
  }
  function drawSil(c, x, y, w, hh) {
    lg.save();
    lg.globalAlpha = 0.85;
    lg.globalCompositeOperation = 'lighter';
    if (!silMirrored) { lg.translate(x + w, y); lg.scale(-1, 1); lg.drawImage(c, 0, 0, w, hh); } else lg.drawImage(c, x, y, w, hh);
    lg.restore();
  }

  function drawMini(f, dist) {
    const W = mini.width, H = mini.height;
    mg.clearRect(0, 0, W, H);
    mg.fillStyle = 'rgba(12,8,32,.8)'; mg.fillRect(0, 0, W, H);
    if (silCanvas && (silCanvas.width || silCanvas.videoWidth)) {
      mg.save(); mg.globalAlpha = 0.7;
      if (!silMirrored) { mg.translate(W, 0); mg.scale(-1, 1); }
      mg.drawImage(silCanvas, 0, 0, W, H); mg.restore();
    }
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
  let shownPct = -1;
  function setProgress(p) {
    clipRect.setAttribute('y', (460 - 460 * (0.03 + p * 0.97)).toFixed(1));
    ringFill.setAttribute('stroke-dashoffset', (C * (1 - p)).toFixed(2));
    const pc = Math.round(p * 100);
    if (pc !== shownPct) { shownPct = pc; pctNum.textContent = pc; }
  }

  return {
    node,
    get progress() { return progress; },
    finish,
    setSilhouetteCanvas: setSil,
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
      setProgress(progress);
      const bodyOk = okFrame && m.upright > 0.5;
      parts.armL.classList.toggle('is-ok', m.l > 0.55); parts.armR.classList.toggle('is-ok', m.r > 0.55);
      parts.body.classList.toggle('is-ok', bodyOk); parts.head.classList.toggle('is-ok', okFrame);
      parts.legL.classList.toggle('is-ok', bodyOk && !upperOnly()); parts.legR.classList.toggle('is-ok', bodyOk && !upperOnly());
      node.classList.toggle('is-matching', matched);
      node.classList.toggle('is-found', !!f);
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
