// Camera-locked character key light (spec 2.8). Owner: WP1.
//
// The character is lit by ONE key direction that is fixed relative to the camera: 35 deg to the camera's
// left, 40 deg above the horizontal, coming from slightly behind the camera (dims.SHADING.keyLight). Scene
// lights only light the arena; the character only reads the arena *shadow map* (thresholded, see toon.js).
//
// The light state lives in plain uniform objects shared by every hero material, so one update per frame (or
// per camera) relights all of them. It is recomputed lazily from whichever camera is rendering (material
// onBeforeRender), unless a camera was pinned with setCamera(). No per-frame allocations.

import * as THREE from 'three';
import dims from '../dims.js';

const DEG = Math.PI / 180;

export function createCharacterLight({ shading = dims.SHADING } = {}) {
  const uniforms = {
    uKeyDir: { value: new THREE.Vector3(0, 1, 1).normalize() }, // world space, points TOWARD the light
    uHeadLight: { value: new THREE.Vector3(0, 0, 1) },          // key dir in head-bone local space (face SDF)
  };
  const camSpace = new THREE.Vector3();
  const state = {
    camera: null,        // pinned camera (setCamera); null = use the rendering camera
    yawOffset: 0,        // radians, extra yaw around the camera up axis (preview light-angle slider)
    pitchOffset: 0,
    worldDir: null,      // THREE.Vector3 override (world space) or null
    lastCam: null, lastFrame: -1,
  };
  const _q = new THREE.Quaternion();
  const _m = new THREE.Matrix4();
  const _headDir = new THREE.Vector3();
  let headRef = null;   // head bone (or rigid head object): uHeadLight is recomputed with uKeyDir, same frame

  function computeCamSpace() {
    const az = (shading.keyLight.leftOfCameraDeg * DEG) + state.yawOffset;
    const el = (shading.keyLight.elevationDeg * DEG) + state.pitchOffset;
    // camera space: -X = screen left, +Y up, +Z = behind the camera (toward the viewer)
    camSpace.set(-Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).normalize();
  }
  computeCamSpace();

  /** Recompute uKeyDir from a camera (uses camera.matrixWorld; renderer updates it before drawing). */
  function updateFromCamera(camera) {
    if (state.worldDir) { uniforms.uKeyDir.value.copy(state.worldDir).normalize(); return; }
    const cam = state.camera || camera;
    if (!cam) return;
    uniforms.uKeyDir.value.copy(camSpace).transformDirection(cam.matrixWorld);
  }

  /** Per-draw hook (cheap): recompute once per (frame, camera). */
  function onRender(renderer, camera) {
    const frame = renderer.info.render.frame;
    const cam = state.camera || camera;
    if (frame === state.lastFrame && cam === state.lastCam) return false;
    state.lastFrame = frame; state.lastCam = cam;
    updateFromCamera(cam);
    // same frame, same camera: the head-local light follows the key immediately (QA round 1, P0-9: no lag).
    // renderer.render() has already run scene.updateMatrixWorld(), so the head's matrixWorld is current.
    if (headRef) headFromMatrix(headRef);
    return true;
  }

  function headFromMatrix(obj) {
    _q.setFromRotationMatrix(_m.extractRotation(obj.matrixWorld)).invert();
    _headDir.copy(uniforms.uKeyDir.value).applyQuaternion(_q);
    uniforms.uHeadLight.value.copy(_headDir);
  }

  /** Head-local key direction for the SDF face shadow. headBone: THREE.Bone (world matrix up to date).
   *  Also remembers it, so every later light update (onRender) recomputes uHeadLight in the same pass. */
  function updateHead(headBone) {
    if (!headBone) return;
    headRef = headBone;
    headFromMatrix(headBone);
  }

  return {
    uniforms,
    updateFromCamera, onRender, updateHead,
    /** Pin the key light to this camera (facade hero.setCamera). null = follow the rendering camera. */
    setCamera(cam) { state.camera = cam || null; state.lastFrame = -1; },
    /** Preview tooling: rotate the key around the camera up axis / tilt it (degrees). */
    setAngleOffset(yawDeg = 0, pitchDeg = 0) { state.yawOffset = yawDeg * DEG; state.pitchOffset = pitchDeg * DEG; computeCamSpace(); state.lastFrame = -1; },
    /** Preview tooling (render/debugViews.js setKeyLightAngle): ABSOLUTE yaw/pitch in degrees (default 35/40). */
    setKeyLight(yawDeg = shading.keyLight.leftOfCameraDeg, pitchDeg = shading.keyLight.elevationDeg) {
      this.setAngleOffset(yawDeg - shading.keyLight.leftOfCameraDeg, pitchDeg - shading.keyLight.elevationDeg);
    },
    /** Preview tooling: force a world-space key direction (Vector3 toward the light) or null to unlock. */
    setWorldDirection(v) { state.worldDir = v ? v.clone() : null; state.lastFrame = -1; },
    get camera() { return state.camera; },
    get head() { return headRef; },
    /** Force the next onRender to recompute (e.g. after the head frame was found). */
    setDirty() { state.lastFrame = -1; },
    /** Key direction in camera space (x right, y up, z toward the viewer); read-only. */
    camSpace,
  };
}
