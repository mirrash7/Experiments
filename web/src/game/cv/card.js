// BREAKLIGHT CV: the shareable photo-booth card (1080 x 1350, 4:5). Graphic dusk background (synthwave sun, rays,
// halftone, energy slashes), the player's segmented cutout with a neon rim next to the hero rendered in the same pose,
// rank / score / body stats, and a local-only privacy footer. Pure 2D canvas; drawn once per capture.
import { PALETTES } from './neon.js';

export const CARD_W = 1080, CARD_H = 1350;

const font = (px, kind = 'display') => {
  const fam = kind === 'display'
    ? (document.fonts?.check?.(`${px}px Bangers`) ? 'Bangers, Impact, sans-serif' : 'Impact, "Arial Black", sans-serif')
    : (document.fonts?.check?.(`800 ${px}px Inter`) ? 'Inter, system-ui, sans-serif' : 'system-ui, -apple-system, sans-serif');
  return kind === 'display' ? `${px}px ${fam}` : `800 ${px}px ${fam}`;
};

/** Deterministic PRNG so a card's decoration doesn't flicker between redraws. */
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

/**
 * Draw the card into ctx (canvas CARD_W x CARD_H).
 * player: { image, w, h, bbox, kind: 'seg'|'skeleton' } | null; hero: { canvas, bbox } | null (bbox in px of canvas)
 * stats: normalised (see normaliseStats); opts: { pose label, palette, mirror, date, seed }
 */
export function drawCard(ctx, { player, hero, stats, poseLabel = 'VICTORY', palette = PALETTES.overdrive, mirror = true, date = new Date(), seed = 7 }) {
  const W = CARD_W, H = CARD_H, R = rng(seed);
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  // ---------------------------------------------------------------- background: dusk gradient
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#0d0624'); bg.addColorStop(0.38, '#3a0f5c'); bg.addColorStop(0.66, '#b0246e'); bg.addColorStop(0.86, '#ff7a3d'); bg.addColorStop(1, '#ffc35a');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  // rays from the sun
  const sunX = W * 0.5, sunY = H * 0.58;
  ctx.save(); ctx.globalCompositeOperation = 'screen'; ctx.translate(sunX, sunY);
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2 + 0.05;
    ctx.rotate(Math.PI * 2 / 28);
    ctx.fillStyle = `rgba(255, ${170 + (i % 3) * 25}, 140, ${0.05 + 0.04 * (i % 2)})`;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(W * 1.2, -26 - 10 * Math.sin(a * 3)); ctx.lineTo(W * 1.2, 26 + 10 * Math.sin(a * 3)); ctx.closePath(); ctx.fill();
  }
  ctx.restore();
  // synthwave sun with cut stripes (own layer, so the cuts don't punch through the sky)
  {
    const sr = W * 0.34, pad = 110;
    const L = document.createElement('canvas'); L.width = L.height = Math.ceil(sr * 2 + pad * 2);
    const l = L.getContext('2d'), c0 = L.width / 2;
    const sg = l.createLinearGradient(0, c0 - sr, 0, c0 + sr);
    sg.addColorStop(0, '#fff3b0'); sg.addColorStop(0.5, '#ffb347'); sg.addColorStop(1, '#ff3d7f');
    l.fillStyle = sg; l.beginPath(); l.arc(c0, c0, sr, 0, Math.PI * 2); l.fill();
    l.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 9; i++) { const y = c0 + sr * 0.05 + i * i * 4.2 + i * 14; l.fillRect(c0 - sr, y, sr * 2, 3 + i * 1.6); }
    ctx.save();
    ctx.shadowColor = 'rgba(255, 170, 80, 0.8)'; ctx.shadowBlur = 90;
    ctx.drawImage(L, sunX - c0, sunY - c0);
    ctx.restore();
  }
  // horizon grid floor
  ctx.save();
  const hy = H * 0.74;
  const fl = ctx.createLinearGradient(0, hy, 0, H); fl.addColorStop(0, 'rgba(20, 4, 40, 0.92)'); fl.addColorStop(1, 'rgba(10, 2, 24, 0.98)');
  ctx.fillStyle = fl; ctx.fillRect(0, hy, W, H - hy);
  ctx.strokeStyle = 'rgba(255, 90, 220, 0.55)'; ctx.lineWidth = 2; ctx.shadowColor = '#ff52d9'; ctx.shadowBlur = 12;
  for (let i = -12; i <= 12; i++) { ctx.beginPath(); ctx.moveTo(W / 2 + i * 26, hy); ctx.lineTo(W / 2 + i * 190, H); ctx.stroke(); }
  for (let k = 0; k < 9; k++) { const y = hy + (H - hy) * Math.pow(k / 8, 1.8); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  ctx.restore();
  // halftone dots, top-left corner fade
  ctx.save(); ctx.fillStyle = 'rgba(255, 255, 255, 0.07)';
  for (let y = 0; y < H * 0.55; y += 18) for (let x = 0; x < W; x += 18) {
    const r = Math.max(0, 5.5 - (Math.hypot(x - W, y) / W) * 5.5);
    if (r > 0.4) { ctx.beginPath(); ctx.arc(x + ((y / 18) % 2) * 9, y, r, 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.restore();
  // energy slashes
  ctx.save(); ctx.globalCompositeOperation = 'screen';
  for (let i = 0; i < 7; i++) {
    const x = R() * W, y = H * (0.15 + R() * 0.55), len = 220 + R() * 380;
    const g = ctx.createLinearGradient(x, y, x + len, y - len * 0.35);
    g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, i % 2 ? palette.a : '#7ef9ff'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.strokeStyle = g; ctx.globalAlpha = 0.35 + R() * 0.3; ctx.lineWidth = 2 + R() * 5;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + len, y - len * 0.35); ctx.stroke();
  }
  ctx.restore();

  // ---------------------------------------------------------------- figures
  const figTop = 250, figBottom = H * 0.8, figH = figBottom - figTop;
  // ground glow
  ctx.save(); ctx.globalCompositeOperation = 'screen';
  const gg = ctx.createRadialGradient(W / 2, figBottom - 10, 10, W / 2, figBottom - 10, W * 0.5);
  gg.addColorStop(0, 'rgba(255, 230, 160, 0.75)'); gg.addColorStop(1, 'rgba(255, 120, 60, 0)');
  ctx.fillStyle = gg; ctx.save(); ctx.translate(W / 2, figBottom - 10); ctx.scale(1, 0.18); ctx.translate(-W / 2, -(figBottom - 10));
  ctx.beginPath(); ctx.arc(W / 2, figBottom - 10, W * 0.5, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  ctx.restore();

  const boxes = { you: { cx: W * 0.29, w: W * 0.54 }, hero: { cx: W * 0.71, w: W * 0.5 } };
  if (hero?.canvas) drawFigure(ctx, hero.canvas, hero.bbox, boxes.hero, figBottom, figH * 0.98, { glow: '#7ef9ff', mirror: false, kind: 'hero' });
  if (player?.image) drawFigure(ctx, player.image, pxBox(player), boxes.you, figBottom, figH, { glow: palette.a, mirror, kind: player.kind, palette });
  else drawNoCamera(ctx, boxes.you, figBottom, figH, palette);
  // sparkles
  ctx.save(); ctx.globalCompositeOperation = 'screen';
  for (let i = 0; i < 46; i++) {
    const x = W * (0.08 + R() * 0.84), y = figTop + R() * figH * 0.9, r = 1.5 + R() * 4.5;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r * 5); g.addColorStop(0, 'rgba(255,250,220,0.95)'); g.addColorStop(1, 'rgba(255,200,120,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 5, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
  // labels
  label(ctx, 'YOU', boxes.you.cx, figBottom + 50, palette.a);
  label(ctx, 'YOUR HERO', boxes.hero.cx, figBottom + 50, '#7ef9ff');

  // ---------------------------------------------------------------- header
  ctx.save();
  ctx.translate(60, 128); ctx.transform(1, 0, -0.14, 1, 0, 0);
  ctx.font = font(124); ctx.textBaseline = 'alphabetic';
  ctx.lineWidth = 14; ctx.strokeStyle = '#1a0538'; ctx.strokeText('BREAKLIGHT', 0, 0);
  const lg = ctx.createLinearGradient(0, -100, 0, 10); lg.addColorStop(0, '#fff6c8'); lg.addColorStop(0.55, '#ffc046'); lg.addColorStop(1, '#ff5a3c');
  ctx.shadowColor = 'rgba(255, 160, 60, 0.9)'; ctx.shadowBlur = 30; ctx.fillStyle = lg; ctx.fillText('BREAKLIGHT', 0, 0);
  ctx.restore();
  ctx.save();
  ctx.font = font(30, 'ui'); ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.letterSpacing = '6px';
  ctx.fillText(`VICTORY POSE · ${poseLabel.replace(/!+$/, '')}`, 66, 182);
  ctx.restore();
  // rank badge
  const rank = stats.rank || '—';
  const rx = W - 150, ry = 128;
  ctx.save();
  const rc = { S: ['#fff2a8', '#ffb020'], A: ['#ffd1f4', '#ff52d9'], B: ['#c8f9ff', '#3fd0ff'], C: ['#e6dcff', '#9b7bff'] }[rank] || ['#ffffff', '#aaaaaa'];
  ctx.shadowColor = rc[1]; ctx.shadowBlur = 40;
  ctx.fillStyle = 'rgba(20, 6, 40, 0.85)'; ctx.beginPath(); ctx.arc(rx, ry, 92, 0, Math.PI * 2); ctx.fill();
  ctx.lineWidth = 8; ctx.strokeStyle = rc[1]; ctx.stroke();
  ctx.shadowBlur = 20; ctx.font = font(150); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const rg = ctx.createLinearGradient(0, ry - 70, 0, ry + 70); rg.addColorStop(0, rc[0]); rg.addColorStop(1, rc[1]);
  ctx.fillStyle = rg; ctx.fillText(rank, rx, ry + 8);
  ctx.shadowBlur = 0; ctx.font = font(22, 'ui'); ctx.fillStyle = '#fff'; ctx.fillText('RANK', rx, ry + 112);
  ctx.restore();

  // ---------------------------------------------------------------- score + stats
  const panelY = H - 168;
  ctx.save();
  ctx.fillStyle = 'rgba(12, 4, 28, 0.78)'; roundRect(ctx, 36, panelY - 18, W - 72, 148, 26); ctx.fill();
  ctx.strokeStyle = 'rgba(255, 210, 120, 0.45)'; ctx.lineWidth = 2; ctx.stroke();
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.font = font(22, 'ui'); ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.fillText('SCORE', 66, panelY + 22);
  ctx.font = font(78); ctx.fillStyle = '#ffd36b'; ctx.shadowColor = 'rgba(255,170,60,0.8)'; ctx.shadowBlur = 18;
  ctx.fillText(Number(stats.score || 0).toLocaleString('en-US'), 62, panelY + 98);
  ctx.shadowBlur = 0;
  const chips = statChips(stats);
  const cx0 = 420, cw = (W - 66 - cx0) / chips.length;
  chips.forEach(([k, v, u], i) => {
    const x = cx0 + i * cw;
    ctx.font = font(15, 'ui'); ctx.fillStyle = 'rgba(255,255,255,0.65)'; ctx.fillText(k, x, panelY + 22);
    ctx.font = font(50); ctx.fillStyle = '#ffffff'; ctx.fillText(v, x, panelY + 86);
    const vw = ctx.measureText(v).width;
    ctx.font = font(20, 'ui'); ctx.fillStyle = '#7ef9ff'; ctx.fillText(u, x + vw + 6, panelY + 86);
  });
  ctx.restore();
  // footer
  ctx.save();
  ctx.font = font(18, 'ui'); ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.textAlign = 'center';
  ctx.fillText(`${date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })} · made on this device · never uploaded`, W / 2, H - 14);
  ctx.restore();
  ctx.restore();
}

function pxBox(p) {
  const b = p.bbox;
  if (!b) return null;
  return { x: b.x0 * p.w, y: b.y0 * p.h, w: (b.x1 - b.x0) * p.w, h: (b.y1 - b.y0) * p.h };
}

/** Fit a cutout (cropped to bbox) into a column, feet on `bottom`, with a neon rim glow. */
function drawFigure(ctx, img, bb, col, bottom, maxH, { glow, mirror, kind, palette }) {
  const iw = img.width, ih = img.height;
  let sx = 0, sy = 0, sw = iw, sh = ih;
  if (bb && bb.w > 4 && bb.h > 4) {
    const pad = bb.h * 0.06;
    sx = Math.max(0, bb.x - pad); sy = Math.max(0, bb.y - pad); sw = Math.min(iw - sx, bb.w + pad * 2); sh = Math.min(ih - sy, bb.h + pad * 2);
  }
  const s = Math.min(maxH / sh, col.w / sw);
  const dw = sw * s, dh = sh * s;
  const dx = col.cx - dw / 2, dy = bottom - dh;
  // composite the figure on its own layer so the rim/grade only touches the person
  const L = document.createElement('canvas'); L.width = Math.ceil(dw) + 120; L.height = Math.ceil(dh) + 120;
  const l = L.getContext('2d');
  l.save();
  if (mirror) { l.translate(L.width, 0); l.scale(-1, 1); }
  if (kind === 'skeleton') {
    l.drawImage(img, sx, sy, sw, sh, 60, 60, dw, dh);
    l.globalCompositeOperation = 'source-in';
    const g = l.createLinearGradient(0, 60, 0, 60 + dh); g.addColorStop(0, palette?.a || glow); g.addColorStop(1, palette?.b || '#ff6a2a');
    l.fillStyle = g; l.fillRect(0, 0, L.width, L.height);
  } else {
    l.filter = kind === 'hero' ? 'none' : 'contrast(1.12) saturate(1.2) brightness(1.05)';
    l.drawImage(img, sx, sy, sw, sh, 60, 60, dw, dh);
    l.filter = 'none';
    if (kind !== 'hero') {
      // dusk grade + scanlines, clipped to the person
      l.globalCompositeOperation = 'source-atop';
      const g = l.createLinearGradient(0, 60, 0, 60 + dh); g.addColorStop(0, 'rgba(126, 249, 255, 0.10)'); g.addColorStop(1, 'rgba(255, 82, 217, 0.22)');
      l.fillStyle = g; l.fillRect(0, 0, L.width, L.height);
      l.fillStyle = 'rgba(0, 0, 0, 0.10)';
      for (let y = 0; y < L.height; y += 4) l.fillRect(0, y, L.width, 1.5);
    }
  }
  l.restore();
  ctx.save();
  ctx.shadowColor = glow; ctx.shadowBlur = 44; ctx.globalAlpha = 0.9;
  ctx.drawImage(L, dx - 60, dy - 60);
  ctx.shadowBlur = 14; ctx.globalAlpha = 1;
  ctx.drawImage(L, dx - 60, dy - 60);
  ctx.restore();
}

function drawNoCamera(ctx, col, bottom, h, palette) {
  ctx.save();
  ctx.strokeStyle = palette.a; ctx.lineWidth = 3; ctx.setLineDash([12, 10]);
  roundRect(ctx, col.cx - 170, bottom - h * 0.85, 340, h * 0.85, 30); ctx.stroke();
  ctx.setLineDash([]); ctx.font = font(26, 'ui'); ctx.fillStyle = '#fff'; ctx.textAlign = 'center';
  ctx.fillText('NO CAMERA', col.cx, bottom - h * 0.42);
  ctx.restore();
}

function label(ctx, text, x, y, color) {
  ctx.save(); ctx.font = font(40); ctx.textAlign = 'center'; ctx.letterSpacing = '3px';
  ctx.lineWidth = 8; ctx.strokeStyle = '#14052c'; ctx.strokeText(text, x, y);
  ctx.shadowColor = color; ctx.shadowBlur = 16; ctx.fillStyle = '#fff'; ctx.fillText(text, x, y);
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); }

/** Accepts score.results() ({score, rank, accuracy, maxCombo, body: {...}}) or a flat object. */
export function normaliseStats(s = {}) {
  const b = s.body || {};
  return {
    score: s.score ?? 0, rank: s.rank ?? '—', accuracy: s.accuracy ?? null, maxCombo: s.maxCombo ?? null,
    punch: s.punchSpeed ?? b.fastestPunch ?? b.punchSpeed ?? null,
    jump: s.jumpHeight ?? b.maxJumpCm ?? b.jumpHeight ?? null,
    reaction: s.reactionMs ?? b.bestReactionMs ?? b.reactionMs ?? null,
    timing: s.timingMs ?? s.meanErrorMs ?? null,
    kcal: s.kcal ?? b.kcal ?? null,
  };
}

function statChips(s) {
  const out = [];
  if (s.punch) out.push(['PUNCH', s.punch.toFixed(1), 'm/s']);
  if (s.jump) out.push(['JUMP', String(Math.round(s.jump)), 'cm']);
  if (s.reaction) out.push(['REACTION', String(Math.round(s.reaction)), 'ms']);
  if (s.timing != null) out.push(['TIMING', `±${Math.round(Math.abs(s.timing))}`, 'ms']);
  else if (s.accuracy != null) out.push(['ACCURACY', String(Math.round(s.accuracy * 100)), '%']);
  if (out.length < 4 && s.maxCombo) out.push(['COMBO', String(s.maxCombo), 'x']);
  if (out.length < 4 && s.kcal) out.push(['ENERGY', String(Math.round(s.kcal)), 'kcal']);
  return out.slice(0, 4);
}
