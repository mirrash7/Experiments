// BREAKLIGHT CV: draws the neon silhouette into a small standalone WebGL2 canvas (the DOM element used by the
// calibration guide, the pour animation and the results replay). Its own tiny context: one texture upload per new cutout
// plus one full-canvas draw. Falls back to a plain 2D-canvas look when WebGL2 isn't available.
import { NEON_UNIFORMS, NEON_FUNCS, HOLO_FUNCS, hexRGB } from './neon.js';

const VS = `#version 300 es
in vec2 aPos; out vec2 vUv;
void main() { vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5); gl_Position = vec4(aPos, 0.0, 1.0); }`;
const FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 outColor;
${NEON_UNIFORMS}
${NEON_FUNCS}
${HOLO_FUNCS}
uniform float uHolo;
void main() { outColor = uHolo > 0.5 ? holoShade(vUv) : neonShade(vUv); }`;

const NAMES = ['uTex', 'uGhost', 'uGhostAmt', 'uColA', 'uColB', 'uTime', 'uPulse', 'uIntensity', 'uMirror', 'uDetail', 'uFill', 'uPour', 'uLod', 'uDotGrid', 'uLines', 'uCrop', 'uReveal', 'uSkel', 'uHolo'];

export function createStylizer({ width = 640, height = 360 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  canvas.className = 'blcv-silhouette';
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true, depth: false, stencil: false });
  if (!gl) return create2DFallback(canvas);
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
  gl.bindAttribLocation(prog, 0, 'aPos');
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  const U = {}; for (const n of NAMES) U[n] = gl.getUniformLocation(prog, n);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const mkTex = () => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); return t; };
  const tex = mkTex(), ghost = mkTex();
  let texSrc = null, texVer = -1, ghostVer = -1, texW = 1;

  function upload(t, img) {
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  return {
    canvas, gl: true,
    /**
     * frame: segmenter frame { image, w, h, version, kind }. u: { palette {a,b}, time, pulse, intensity, mirror, detail,
     * fill, pour, crop [x,y,w,h], ghost frame|null, ghostAmt, style 'holo' (default: the calibration hologram) | 'neon'
     * (the r1 halftone look; also used whenever pour > 0), reveal 0..1 }.
     */
    render(frame, u) {
      if (gl.isContextLost()) return;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      if (!frame?.image) return;
      try {
        if (frame.version !== texVer || frame.image !== texSrc) { upload(tex, frame.image); texVer = frame.version; texSrc = frame.image; texW = frame.w; }
        if (u.ghost && u.ghostAmt > 0 && u.ghost.version !== ghostVer) { upload(ghost, u.ghost.image); ghostVer = u.ghost.version; }
      } catch { return; }   // a closed bitmap: skip this draw
      gl.useProgram(prog); gl.bindVertexArray(vao);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(U.uTex, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, ghost); gl.uniform1i(U.uGhost, 1);
      const A = hexRGB(u.palette.a), B = hexRGB(u.palette.b);
      gl.uniform3f(U.uColA, A[0], A[1], A[2]); gl.uniform3f(U.uColB, B[0], B[1], B[2]);
      gl.uniform1f(U.uTime, u.time || 0); gl.uniform1f(U.uPulse, u.pulse || 0); gl.uniform1f(U.uIntensity, u.intensity ?? 1);
      gl.uniform1f(U.uMirror, u.mirror === false ? 0 : 1); gl.uniform1f(U.uDetail, u.detail ?? 1); gl.uniform1f(U.uFill, u.fill ?? 0.85);
      gl.uniform1f(U.uPour, u.pour || 0);
      gl.uniform1f(U.uHolo, u.style === 'neon' || u.pour > 0 ? 0 : 1); gl.uniform1f(U.uReveal, u.reveal ?? 1); gl.uniform1f(U.uSkel, frame.kind === 'skeleton' ? 1 : 0); gl.uniform1f(U.uGhostAmt, u.ghost ? u.ghostAmt || 0 : 0);
      const crop = u.crop || [0, 0, 1, 1];
      gl.uniform4f(U.uCrop, crop[0], crop[1], crop[2], crop[3]);
      // glow radius ~ constant fraction of the person: base LOD from the source resolution
      gl.uniform1f(U.uLod, Math.max(0.5, Math.log2(Math.max(1, texW * crop[2]) / 120)));
      gl.uniform2f(U.uDotGrid, canvas.width / (u.dotPx || 5), canvas.height / (u.dotPx || 5));
      gl.uniform1f(U.uLines, canvas.height / (u.linePx || (u.style === 'neon' ? 4 : 5)));
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    resize(w, h) { canvas.width = w; canvas.height = h; },
    clear() { if (!gl.isContextLost()) { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); } },
    dispose() { gl.getExtension('WEBGL_lose_context')?.loseContext(); },
  };
}

/** No WebGL2: tinted cutout with a canvas blur glow (slower, still on-brand). */
function create2DFallback(canvas) {
  const ctx = canvas.getContext('2d');
  return {
    canvas, gl: false,
    render(frame, u) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!frame?.image) return;
      const c = u.crop || [0, 0, 1, 1];
      ctx.save();
      if (u.mirror !== false) { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); }
      const sx = c[0] * frame.w, sy = c[1] * frame.h, sw = c[2] * frame.w, sh = c[3] * frame.h;
      ctx.filter = 'blur(8px)'; ctx.globalAlpha = 0.9 * (u.intensity ?? 1);
      ctx.drawImage(frame.image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = 'source-in'; ctx.filter = 'none';
      ctx.fillStyle = u.palette.a; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = (u.fill ?? 0.85) * (u.intensity ?? 1);
      ctx.drawImage(frame.image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      ctx.restore();
    },
    resize(w, h) { canvas.width = w; canvas.height = h; },
    clear() { ctx.clearRect(0, 0, canvas.width, canvas.height); },
    dispose() {},
  };
}
