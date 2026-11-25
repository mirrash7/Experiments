// WP1 QA page: palette swatch dE test, SDF face-shadow sweep, outline width measurement.
// Open /src/hero/materials/swatch.html. Results also land in window.wp1qa.
import * as THREE from 'three';
import palette from '../palette.js';
import dims from '../dims.js';
import { ensureCharacterAttributes } from '../geo/attributes.js';
import { createSharedMaterials } from './index.js';
import { drawFaceShadowMap } from './faceShadow.js';
import { createCharacter } from '../index.js';
import { configureRenderer } from '../../render/pipeline.js';

const $ = (id) => document.getElementById(id);
const glCanvas = document.createElement('canvas');
const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: false, preserveDrawingBuffer: true });
configureRenderer(renderer);
renderer.setPixelRatio(1);
const results = (window.wp1qa = {});

// ------------------------------------------------------------------ colour maths
const srgbToLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const hexRgb = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
function lab([r, g, b]) {
  const [R, G, B] = [r, g, b].map((v) => srgbToLin(v / 255));
  let x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047, y = R * 0.2126 + G * 0.7152 + B * 0.0722, z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  x = f(x); y = f(y); z = f(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const dE = (a, b) => { const A = lab(a), B = lab(b); return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]); };
const mixHex = (h1, h2, t) => { const a = hexRgb(h1), b = hexRgb(h2); return a.map((v, i) => Math.round(255 * linToSrgb(srgbToLin(v / 255) * (1 - t) + srgbToLin(b[i] / 255) * t))); };
const rgbHex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();

// ------------------------------------------------------------------ 1. swatches
function swatchTest() {
  const mats = createSharedMaterials({ palette });
  mats.light.setWorldDirection(new THREE.Vector3(1, 0, 0));
  const used = Object.values(palette.MAT);
  const CW = 60, RH = 90, W = CW * used.length, H = RH * 4;
  const quads = [], hull = [];
  // base: N tilted toward L (lit, no rim, no gold spec); shade/deep: tilted away; deep adds shadeBias -0.3
  const NL = [0.3, 0, Math.sqrt(1 - 0.09)], NS = [-0.3, 0, Math.sqrt(1 - 0.09)];
  used.forEach((m, i) => {
    const x0 = i * CW - W / 2, x1 = x0 + CW;
    const row = (r) => [H / 2 - r * RH, H / 2 - (r + 1) * RH];
    quads.push({ m, x0, x1, y: row(0), n: NL, bias: 0 });
    quads.push({ m, x0, x1, y: row(1), n: NS, bias: 0 });
    quads.push({ m, x0, x1, y: row(2), n: NS, bias: -0.3 });
    hull.push({ m, x0, x1, y: row(3) });
  });
  const build = (list, back) => {
    const pos = [], nor = [], mid = [], bias = [];
    for (const q of list) {
      const [yt, yb] = q.y;
      const p = back ? [[q.x0, yb], [q.x0, yt], [q.x1, yt], [q.x0, yb], [q.x1, yt], [q.x1, yb]]
        : [[q.x0, yb], [q.x1, yb], [q.x1, yt], [q.x0, yb], [q.x1, yt], [q.x0, yt]];
      for (const [x, y] of p) { pos.push(x, y, 0); nor.push(...(q.n || [0, 0, 1])); mid.push(q.m); bias.push(q.bias || 0); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('matId', new THREE.Float32BufferAttribute(mid, 1));
    g.setAttribute('shadeBias', new THREE.Float32BufferAttribute(bias, 1));
    ensureCharacterAttributes(g, { outlineWidth: 0 });
    return g;
  };
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#202020');
  scene.add(new THREE.Mesh(build(quads, false), mats.body));
  scene.add(new THREE.Mesh(build(hull, true), mats.outline));
  const cam = new THREE.OrthographicCamera(-W / 2, W / 2, H / 2, -H / 2, -10, 10);
  renderer.setSize(W, H, false);
  renderer.render(scene, cam);
  const gl = renderer.getContext(), px = new Uint8Array(4);
  const read = (x, y) => { gl.readPixels(x, H - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); return [px[0], px[1], px[2]]; };
  $('sw').width = W; $('sw').height = H;
  $('sw').getContext('2d').drawImage(glCanvas, 0, 0);
  let worst = 0, rows = '<tr><th>matId</th><th>name</th><th>base exp/got dE</th><th>shade exp/got dE</th><th>deep(mix .6) exp/got dE</th><th>outline exp/got dE</th></tr>';
  const all = [];
  used.forEach((m, i) => {
    const P = palette.PALETTE[m];
    const exp = [hexRgb(P.base), hexRgb(P.shade), mixHex(P.shade, P.deep, dims.SHADING.deepMix), hexRgb(P.outline)];
    let cells = '';
    exp.forEach((e, r) => {
      const got = read(i * CW + CW / 2, r * RH + RH / 2);
      const d = dE(e, got); worst = Math.max(worst, d);
      all.push({ m, row: ['base', 'shade', 'deep', 'outline'][r], exp: rgbHex(e), got: rgbHex(got), dE: +d.toFixed(2) });
      cells += `<td><span class="chip" style="background:${rgbHex(e)}"></span>${rgbHex(e)} <span class="chip" style="background:${rgbHex(got)}"></span>${rgbHex(got)} <span class="${d < 2 ? 'ok' : 'bad'}">${d.toFixed(2)}</span></td>`;
    });
    rows += `<tr><td>${m}</td><td>${P.name}</td>${cells}</tr>`;
  });
  $('tbl').innerHTML = rows;
  results.swatch = { worstDE: +worst.toFixed(2), entries: all };
  mats.dispose();
  return worst;
}

// ------------------------------------------------------------------ 2. face sweep
const hero = createCharacter({ parts: ['head', 'hair'] });
const fScene = new THREE.Scene();
fScene.background = new THREE.Color('#9fc6e8');
fScene.add(hero.root);
const heroLight = (() => { let l = null; hero.root.traverse((o) => { if (!l && o.material?.userData?.env) l = o.material.userData.env.light; }); return l; })();
const fCam = new THREE.PerspectiveCamera(30, 0.75, 0.05, 10);
fCam.position.set(0, 1.63, 0.78); fCam.lookAt(0, 1.62, 0);
const _dir = new THREE.Vector3();
function faceAt(yawDeg, elevDeg = 20) {
  const y = THREE.MathUtils.degToRad(yawDeg), e = THREE.MathUtils.degToRad(elevDeg);
  heroLight.setWorldDirection(_dir.set(Math.sin(y) * Math.cos(e), Math.sin(e), Math.cos(y) * Math.cos(e)));
  hero.update(0);
  renderer.render(fScene, fCam);
}
function faceSweep() {
  const angles = [0, 15, 30, 45, 60, 75, 90, -45];
  const PW = 150, PH = 200, g = $('face').getContext('2d');
  renderer.setSize(PW, PH, false);
  angles.forEach((a, i) => {
    faceAt(a); g.drawImage(glCanvas, i * PW, 0);
    g.fillStyle = '#000'; g.fillText(`${a}°`, i * PW + 6, 14);
  });
}
function faceLive(yaw) {
  renderer.setSize(360, 360, false);
  fCam.aspect = 1; fCam.updateProjectionMatrix();
  faceAt(yaw);
  $('faceLive').getContext('2d').drawImage(glCanvas, 0, 0);
  fCam.aspect = 0.75; fCam.updateProjectionMatrix();
  drawFaceShadowMap($('mapSweep'), { size: 256, sweep: Math.abs(yaw) / 90 });
}
drawFaceShadowMap($('map'), { size: 256 });

// ------------------------------------------------------------------ 3. outline width
function outlineTest() {
  const mats = createSharedMaterials({ palette });
  const geo = new THREE.SphereGeometry(0.1, 64, 48);
  ensureCharacterAttributes(geo, { matId: palette.MAT.SKIN });
  const box = new THREE.BoxGeometry(0.12, 0.12, 0.12);
  ensureCharacterAttributes(box, { matId: palette.MAT.SHIRT });
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0, 1, 0);
  const s = new THREE.Mesh(geo, mats.body), sh = new THREE.Mesh(geo, mats.outline);
  const b = new THREE.Mesh(box, mats.body), bh = new THREE.Mesh(box, mats.outline);
  scene.add(s, sh, b, bh);
  const rt = new THREE.WebGLRenderTarget(3840, 2160);
  const buf = new Uint8Array(3840 * 4);
  const outLin = new THREE.Color(palette.PALETTE[palette.MAT.SKIN].outline);
  const cases = [
    { name: 'game cam (0,1.30,4.9) fov 34', pos: [0, 1.30, 4.9], look: [0, 0.98, 0], target: [0, 1.0, 0] },
    { name: 'face cam (0,1.65,0.75)', pos: [0, 1.65, 0.75], look: [0, 1.62, 0], target: [0, 1.62, 0] },
    { name: 'far (0,1.5,9)', pos: [0, 1.5, 9], look: [0, 1, 0], target: [0, 1.0, 0] },
  ];
  let html = '<tr><th>camera</th><th>measured px @1080p</th><th>target</th></tr>';
  results.outline = [];
  const cam = new THREE.PerspectiveCamera(34, 16 / 9, 0.05, 100);
  for (const c of cases) {
    s.position.set(...c.target); sh.position.copy(s.position);
    b.position.set(c.target[0] + 0.4, c.target[1], c.target[2]); b.rotation.set(0.5, 0.7, 0); bh.position.copy(b.position); bh.rotation.copy(b.rotation);
    cam.position.set(...c.pos); cam.lookAt(...c.look); cam.updateMatrixWorld();
    renderer.setRenderTarget(rt); renderer.render(scene, cam); renderer.setRenderTarget(null);
    const p = s.position.clone().project(cam);
    const row = Math.round((p.y * 0.5 + 0.5) * 2160);
    renderer.readRenderTargetPixels(rt, 0, row, 3840, 1, buf);
    // count outline-coloured pixels on the left silhouette
    let x = 0, n = 0;
    while (x < 3840 && buf[x * 4 + 1] > 240 && buf[x * 4] < 20) x++;
    const isOut = (i) => Math.abs(buf[i * 4] / 255 - outLin.r) < 0.06 && Math.abs(buf[i * 4 + 1] / 255 - outLin.g) < 0.06 && Math.abs(buf[i * 4 + 2] / 255 - outLin.b) < 0.06;
    while (x < 3840 && isOut(x)) { n++; x++; }
    const px1080 = n / 2;
    const target = c.name.startsWith('game') ? '2.2 ± 0.4' : c.name.startsWith('face') ? '≤ 3.5' : '< 2.2';
    results.outline.push({ camera: c.name, px1080 });
    html += `<tr><td>${c.name}</td><td>${px1080.toFixed(1)}</td><td>${target}</td></tr>`;
  }
  $('otbl').innerHTML = html;
  rt.dispose(); geo.dispose(); box.dispose(); mats.dispose();
}

// ------------------------------------------------------------------ run
const worst = swatchTest();
faceSweep();
faceLive(45);
outlineTest();
$('summary').innerHTML = `swatch worst dE = <span class="${worst < 2 ? 'ok' : 'bad'}">${worst.toFixed(2)}</span> | outline px: ${results.outline.map((o) => o.px1080).join(' / ')}`;
$('yaw').addEventListener('input', (e) => { $('yawv').textContent = e.target.value; faceLive(+e.target.value); });
