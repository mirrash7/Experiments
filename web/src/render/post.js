// Post chain (pmndrs postprocessing 6.39.6, anime-rendering.md 5.1):
//   RenderPass(arena) -> RenderPass(hero scene, no clear: composited over the arena with shared depth)
//   -> EffectPass[ Bloom (subtle, threshold 0.92) | ToneMapping (Neutral) | AnimeGrade (sat/split-tone/contrast) | Vignette ]
//   -> EffectPass[ SMAA | FXAA ]
// HDR (half float) frame buffers; the renderer's own tone mapping is off (configureRenderer({postToneMapping:true})).
import * as THREE from 'three';
import {
  EffectComposer, RenderPass, EffectPass, BloomEffect, ToneMappingEffect, ToneMappingMode, VignetteEffect,
  SMAAEffect, SMAAPreset, EdgeDetectionMode, FXAAEffect, Effect, BlendFunction,
} from 'postprocessing';

const GRADE_FRAG = /* glsl */`
uniform float saturation;
uniform float contrast;
uniform vec3 shadowTint;
uniform vec3 highlightTint;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = max(inputColor.rgb, 0.0);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, saturation);
  c *= mix(shadowTint, highlightTint, smoothstep(0.04, 0.6, l));
  vec3 g = pow(max(c, 0.0), vec3(1.0 / 2.2));
  g = clamp((g - 0.5) * contrast + 0.5, 0.0, 1.0);
  outputColor = vec4(pow(g, vec3(2.2)), inputColor.a);
}`;

/**
 * Simple colour grade (stands in for a LUT): saturation, shadow / highlight tints, contrast.
 * QA v3 r1 P0-2: the grade runs over the composited frame (hero included), so it must keep the hero's authored
 * colours true: saturation and contrast 1.0, white highlights, only a faint cool lift in the deep shadows. The arena
 * carries its own saturation in its materials (arena.js) instead of getting it from the grade.
 */
export class AnimeGradeEffect extends Effect {
  constructor({ saturation = 1.0, contrast = 1.0, shadowTint = '#f3f5ff', highlightTint = '#ffffff' } = {}) {
    super('AnimeGradeEffect', GRADE_FRAG, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map([
        ['saturation', new THREE.Uniform(saturation)],
        ['contrast', new THREE.Uniform(contrast)],
        ['shadowTint', new THREE.Uniform(new THREE.Color(shadowTint))],
        ['highlightTint', new THREE.Uniform(new THREE.Color(highlightTint))],
      ]),
    });
  }
}

export function createPostChain(renderer, worldScene, heroScene, camera) {
  const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
  const worldPass = new RenderPass(worldScene, camera);
  const heroPass = new RenderPass(heroScene, camera);
  heroPass.clearPass.enabled = false;
  heroPass.ignoreBackground = true;
  // arena shadows are static (props/island): render them on demand only
  worldPass.skipShadowMapUpdate = true;

  const bloom = new BloomEffect({ mipmapBlur: true, luminanceThreshold: 0.92, luminanceSmoothing: 0.08, intensity: 0.32, radius: 0.62 });
  const toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.NEUTRAL });
  const grade = new AnimeGradeEffect();
  const vignette = new VignetteEffect({ offset: 0.32, darkness: 0.38 });
  const smaa = new SMAAEffect({ preset: SMAAPreset.HIGH, edgeDetectionMode: EdgeDetectionMode.COLOR });
  const fxaa = new FXAAEffect();

  composer.addPass(worldPass);
  composer.addPass(heroPass);
  let gradePass = null, aaPass = null;
  const state = { preset: null, worldShadowDirty: 2 };

  function rebuild(p) {
    if (gradePass) { composer.removePass(gradePass); gradePass.dispose(); }
    if (aaPass) { composer.removePass(aaPass); aaPass.dispose(); }
    const fx = [];
    if (p.bloom) { bloom.resolution.scale = p.bloomHalf ? 0.5 : 1; fx.push(bloom); }
    fx.push(toneMapping);
    if (p.grade) fx.push(grade);
    if (p.vignette) fx.push(vignette);
    gradePass = new EffectPass(camera, ...fx);
    composer.addPass(gradePass);
    aaPass = p.aa === 'smaa' ? new EffectPass(camera, smaa) : p.aa === 'fxaa' ? new EffectPass(camera, fxaa) : null;
    if (aaPass) composer.addPass(aaPass);
  }

  return {
    composer, worldPass, heroPass, effects: { bloom, toneMapping, grade, vignette, smaa, fxaa },
    setPreset(p) {
      const sig = JSON.stringify([p.bloom, p.bloomHalf, p.grade, p.vignette, p.aa]);
      if (sig !== state.preset) { state.preset = sig; rebuild(p); }
    },
    /** Request a re-render of the static arena shadow maps (after lights/props change). */
    invalidateWorldShadows() { state.worldShadowDirty = 2; },
    setSize(w, h) { composer.setSize(w, h, false); },
    render(dt) {
      if (state.worldShadowDirty > 0) { renderer.shadowMap.needsUpdate = true; state.worldShadowDirty--; }
      composer.render(dt);
    },
    dispose() { composer.dispose(); },
  };
}
