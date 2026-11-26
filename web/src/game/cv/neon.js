// BREAKLIGHT CV: the "neon silhouette" look, shared by the DOM stylizer (raw WebGL2) and the 3D echo (three.js
// ShaderMaterial, GLSL3). Input: a person cutout texture (camera RGB, alpha = soft mask) with mipmaps (the glow is read
// from blurred mip levels). Output: premultiplied colour: posterised + halftone body, scanlines, inner rim light,
// outer glow, a travelling sweep band, and the "pour" melt used when calibration locks.

/** Act / state palettes: a = main neon, b = secondary (hex sRGB). */
export const PALETTES = {
  calibrate: { a: '#3ff0ff', b: '#7a5cff' },
  locked: { a: '#fff1c4', b: '#ffb040' },
  title: { a: '#ffc46b', b: '#ff5a8a' },
  0: { a: '#ffb347', b: '#ff4f7a' },
  1: { a: '#ff52d9', b: '#6a4cff' },
  2: { a: '#a77bff', b: '#3ff0ff' },
  boss: { a: '#ff4fa0', b: '#5a2cff' },
  overdrive: { a: '#ffd84a', b: '#ff6a2a' },
  results: { a: '#7ef9ff', b: '#ff52d9' },
};

export const NEON_UNIFORMS = `
uniform sampler2D uTex;
uniform sampler2D uGhost;
uniform float uGhostAmt;
uniform vec3 uColA;
uniform vec3 uColB;
uniform float uTime;
uniform float uPulse;
uniform float uIntensity;
uniform float uMirror;
uniform float uDetail;
uniform float uFill;
uniform float uPour;
uniform float uLod;
uniform vec2 uDotGrid;
uniform float uLines;
uniform vec4 uCrop;      // source rect (x, y, w, h) in texture uv
`;

export const NEON_FUNCS = `
float nHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

// uv: 0..1 with y = 0 at the TOP of the output.
vec4 neonShade(vec2 uv) {
  vec2 o = vec2(mix(uv.x, 1.0 - uv.x, uMirror), uv.y);
  // pour: columns melt downward at different speeds and squeeze toward the centre line
  if (uPour > 0.0) {
    float col = floor(o.x * 48.0);
    float n = nHash(vec2(col, 3.1));
    float p = uPour * uPour;
    o.y -= p * (0.35 + 0.9 * n) * (0.4 + o.y);
    o.x = mix(o.x, 0.5, p * 0.55);
  }
  vec2 s = uCrop.xy + o * uCrop.zw;
  if (o.y < 0.0 || o.y > 1.0) return vec4(0.0);
  vec4 c = textureLod(uTex, s, 0.0);   // explicit LOD: the pour's column offsets would break implicit derivatives
  float a = c.a;
  float g1 = textureLod(uTex, s, uLod).a;
  float g2 = textureLod(uTex, s, uLod + 1.5).a;
  float g3 = textureLod(uTex, s, uLod + 3.0).a;
  float glow = g1 * 0.5 + g2 * 0.35 + g3 * 0.35;
  float rim = clamp(a * (1.0 - g1) * 3.0, 0.0, 1.0);
  float outer = (1.0 - a) * glow;
  float L = dot(c.rgb, vec3(0.299, 0.587, 0.114));
  L = mix(0.7, clamp(L * 1.25, 0.0, 1.0), uDetail);
  float P = floor(L * 4.0 + 0.5) / 4.0;
  vec2 cell = o * uDotGrid;
  vec2 f = fract(cell) - 0.5;
  float r = sqrt(L) * 0.6 + 0.08;
  float dotm = 1.0 - smoothstep(r - 0.1, r + 0.1, length(f));
  float scan = 0.72 + 0.28 * sin(o.y * uLines * 6.2832 - uTime * 4.0);
  float sweep = smoothstep(0.06, 0.0, abs(fract(o.y - uTime * 0.22) - 0.5) - 0.44);
  vec3 body = mix(uColB * 0.3, uColA, P) * mix(0.45, 1.0, dotm) * scan;
  body += uColA * sweep * 0.6;
  vec3 colr = body * a * uFill
            + uColA * rim * (1.5 + uPulse)
            + mix(uColA, uColB, 0.45) * outer * (0.85 + 0.8 * uPulse);
  float alpha = clamp(a * uFill * 0.92 + rim + outer * 0.75, 0.0, 1.0);
  vec4 res = vec4(colr, alpha);
  if (uGhostAmt > 0.0) {
    float ga = textureLod(uGhost, s + vec2(0.0, 0.0), uLod * 0.5).a;
    float gg = textureLod(uGhost, s, uLod + 1.0).a;
    float edge = clamp(ga * (1.0 - gg) * 3.0, 0.0, 1.0) * (1.0 - a);
    res += vec4(uColB * edge * 1.2, edge * 0.6) * uGhostAmt;
  }
  if (uPour > 0.0) res.rgb = mix(res.rgb, vec3(1.0, 0.93, 0.75) * res.a * 1.3, clamp(uPour * 0.9, 0.0, 0.75));
  return res * uIntensity;
}
`;

/** Parse '#rrggbb' to [r, g, b] 0..1 (sRGB). */
export function hexRGB(h) {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
