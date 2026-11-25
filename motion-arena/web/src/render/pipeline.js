// Colour pipeline shared by the game and the preview (spec 2.11). Owner: WP6.
//
// Character materials are `toneMapped: false`: the authored sRGB palette is final and never goes
// through a tone curve. The arena (MeshToonMaterial etc.) does go through the renderer's tone mapping,
// so we use Neutral (Khronos PBR Neutral): it keeps hue and saturation below ~0.8 and only rolls off
// highlights, unlike ACES which desaturates and shifts toon colours (banned by 2.11).
import * as THREE from 'three';

export const PIPELINE = {
  toneMapping: THREE.NeutralToneMapping,
  exposure: 1.0,
};

/** Apply the project-wide renderer settings. Keep the preview and the game identical so swatch tests match. */
export function configureRenderer(renderer, { shadows = true } = {}) {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = PIPELINE.toneMapping;
  renderer.toneMappingExposure = PIPELINE.exposure;
  if (shadows) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }
  return renderer;
}

/**
 * Size a renderer from its canvas' CSS box (not window.innerWidth/innerHeight). Under devtools / pane
 * viewport emulation innerWidth can disagree with the laid-out canvas, which rendered the preview
 * off-centre. Returns a disposer.
 */
export function autoResize(renderer, camera, { onResize } = {}) {
  const canvas = renderer.domElement;
  const apply = () => {
    const w = Math.max(1, Math.round(canvas.clientWidth || innerWidth));
    const h = Math.max(1, Math.round(canvas.clientHeight || innerHeight));
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(w, h, false); // CSS size is owned by the stylesheet (fixed, inset 0)
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    onResize?.(w, h);
  };
  const ro = new ResizeObserver(apply);
  ro.observe(canvas);
  addEventListener('resize', apply);
  apply();
  return () => { ro.disconnect(); removeEventListener('resize', apply); };
}
