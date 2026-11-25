// Hero v2 palette (spec 2.7). Owner: WP0. All hex values are sRGB as authored and must render exactly
// (character materials use toneMapped: false). Shades are hue-shifted, never grey.
//
// Every vertex carries a `matId` float = one of MAT.*. Missing table cells fall back:
//   shade <- base, deep <- shade, highlight <- base, outline <- DEFAULT_OUTLINE.

import * as THREE from 'three';

/** Material IDs (stable: they index palette-texture columns). Max 32. */
export const MAT = Object.freeze({
  SKIN: 0, SKIN_LINE: 1, HAIR: 2, SHIRT: 3, SHIRT_INNER: 4, GOLD: 5, SASH: 6, SHORTS: 7,
  STITCH: 8, FUR: 9, SOLE: 10, STRAP: 11, IRIS: 12, SCLERA: 13, MOUTH: 14, TONGUE: 15,
  TEETH: 16, BLUSH: 17, EYE_LINE: 18,
});
export const MAT_COUNT = 32;
export const DEFAULT_OUTLINE = '#16101A';

/** Raw table: base, shade (1st), deep (crease/AO), highlight (or rim), outline, plus extras. */
const RAW = {
  [MAT.SKIN]: { name: 'skin', base: '#F7D2B2', shade: '#E39C7F', deep: '#C2705F', highlight: '#FFEBDA', outline: '#6B3428' },
  [MAT.SKIN_LINE]: { name: 'skinLine', base: '#CF8A6E' },
  [MAT.HAIR]: { name: 'hair', base: '#24232F', shade: '#13121D', deep: '#0A0A12', highlight: '#6E7BA6', outline: '#07070C', band: '#555C7C', rim: '#6E7BA6' },
  [MAT.SHIRT]: { name: 'shirt', base: '#D9262F', shade: '#A0152F', deep: '#6F0E2B', highlight: '#F2604F', outline: '#3F0814', line: '#8E1428' },
  [MAT.SHIRT_INNER]: { name: 'shirtInner', base: '#B01A2C', shade: '#7E1029', outline: '#3F0814' },
  [MAT.GOLD]: { name: 'gold', base: '#F4C84C', shade: '#B87D22', deep: '#7E5214', highlight: '#FFF6C8', outline: '#4A2E08', spec: '#FFF6C8' },
  [MAT.SASH]: { name: 'sash', base: '#F6D244', shade: '#D99B2B', deep: '#AE6D22', highlight: '#FFF1A6', outline: '#6B4410' },
  [MAT.SHORTS]: { name: 'shorts', base: '#3552B3', shade: '#22307C', deep: '#18205A', highlight: '#5E7CD8', outline: '#101840' },
  [MAT.STITCH]: { name: 'stitch', base: '#8FA6E8' },
  [MAT.FUR]: { name: 'fur', base: '#F8F6F0', shade: '#C3CAE0', deep: '#98A2C4', highlight: '#FFFFFF', outline: '#6E7692' },
  [MAT.SOLE]: { name: 'sole', base: '#7B4B2B', shade: '#4F2D19', deep: '#36200F', highlight: '#A4704A', outline: '#24130A' },
  [MAT.STRAP]: { name: 'strap', base: '#9C6B3B', shade: '#6A4322', highlight: '#C8955F', outline: '#2C1A0C' },
  [MAT.IRIS]: { name: 'iris', base: '#1A1418', shade: '#3B2A26', highlight: '#FFFFFF', ring: '#0C0A0E', pupil: '#07060A' },
  [MAT.SCLERA]: { name: 'sclera', base: '#FFFFFF', shade: '#CCD6EA', outline: '#16101A' },
  [MAT.MOUTH]: { name: 'mouth', base: '#7A1E2A', outline: '#3A1A1E' },
  [MAT.TONGUE]: { name: 'tongue', base: '#E5707A', outline: '#3A1A1E' },
  [MAT.TEETH]: { name: 'teeth', base: '#FFFFFF', shade: '#D9DEEA', outline: '#3A1A1E' },
  [MAT.BLUSH]: { name: 'blush', base: '#F29C8C', opacity: 0.35, hatch: '#E07A70' },
  [MAT.EYE_LINE]: { name: 'eyeLine', base: '#16101A', lowerLine: '#5A3A3A', brow: '#1E1C26', outline: '#16101A' },
};

/** Resolved entries: every id 0..MAT_COUNT-1 has { name, base, shade, deep, highlight, outline, ...extras } (hex strings). */
export const PALETTE = Object.freeze(Array.from({ length: MAT_COUNT }, (_, i) => {
  const r = RAW[i] || { name: `unused${i}`, base: '#FF00FF' };
  const shade = r.shade ?? r.base;
  return Object.freeze({ ...r, shade, deep: r.deep ?? shade, highlight: r.highlight ?? r.base, outline: r.outline ?? DEFAULT_OUTLINE });
}));

/** Extra face colours (atlas painting, WP3). */
export const FACE_COLORS = Object.freeze({
  irisTop: '#1A1418', irisBottom: '#3B2A26', irisRing: '#0C0A0E', pupil: '#07060A', catchLight: '#FFFFFF', rimCrescent: '#6E5A6A',
  lash: '#16101A', lowerLine: '#5A3A3A', sclera: '#FFFFFF', lidBand: '#CCD6EA', brow: '#1E1C26',
  noseWedge: '#E3A285', earLine: '#C77D66', mouthLine: '#3A1A1E', mouthInterior: '#7A1E2A', tongue: '#E5707A', teeth: '#FFFFFF', teethShade: '#D9DEEA',
  blush: '#F29C8C', blushHatch: '#E07A70', skinLine: '#CF8A6E', stitch: '#8FA6E8', shirtLine: '#8E1428',
});

/** Rows of the palette texture, top to bottom. */
export const PALETTE_ROWS = ['base', 'shade', 'deep', 'highlight', 'outline'];

/** THREE.Color (linear working space, converted from sRGB) for a matId/row. */
export function color(matId, row = 'base') { return new THREE.Color(PALETTE[matId][row]); }

/**
 * Palette DataTexture: width MAT_COUNT, height 8 (rows = PALETTE_ROWS, rest reserved), sRGB bytes,
 * NearestFilter. Sample at uv = ((matId + 0.5) / 32, (row + 0.5) / 8). Caller owns/disposes it.
 */
export function createPaletteTexture() {
  const W = MAT_COUNT, H = 8;
  const data = new Uint8Array(W * H * 4);
  const c = new THREE.Color();
  PALETTE_ROWS.forEach((row, y) => {
    for (let x = 0; x < W; x++) {
      c.setStyle(PALETTE[x][row], THREE.NoColorSpace); // raw sRGB bytes
      const o = (y * W + x) * 4;
      data[o] = Math.round(c.r * 255); data[o + 1] = Math.round(c.g * 255); data[o + 2] = Math.round(c.b * 255); data[o + 3] = 255;
    }
  });
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = tex.minFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

const palette = Object.freeze({ MAT, MAT_COUNT, PALETTE, PALETTE_ROWS, FACE_COLORS, DEFAULT_OUTLINE, color, createPaletteTexture });
export default palette;
