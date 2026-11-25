// Character light rig (anime-rendering.md 5.1). The hero renders in its own scene (composited over the arena by
// render/post.js) so arena lighting never wrecks the face:
//   key   - directional, follows the camera azimuth, 35 deg to the camera's left and 40 deg up, NEUTRAL white
//           (QA v3 r1 P0-2: a warm key + warm ground + warm grade stacked and turned the authored hair/skin orange)
//   fill  - hemisphere (pale cool sky / neutral grey-beige ground), MToon's GI term reads it through giEqualization
//   rim   - a cool back light from behind the hero, opposite the camera and to its right (P2-3, separation from the
//           warm deck). Not a THREE light: MToon would add its shade term everywhere. vrm/mtoonPatch.js draws it as a
//           crisp fresnel edge on the surfaces facing it; this object only carries its direction / colour.
//   shadow- a zero-intensity directional along the arena sun that only casts the hero's shadow, caught by a
//           ShadowMaterial plane on the deck (tinted, like the contact blob). Tight ortho frustum follows the hero.
import * as THREE from 'three';

export const KEY_LIGHT = { yawDeg: 35, pitchDeg: 40, intensity: 3.0, color: '#fffcf8' };
export const RIM_LIGHT = { yawDeg: 145, pitchDeg: 28, intensity: 0.85, color: '#bcd4ff' };

export function createHeroLights(heroScene, { sunDirection = new THREE.Vector3(4, 9, 6).normalize() } = {}) {
  const key = new THREE.DirectionalLight(KEY_LIGHT.color, KEY_LIGHT.intensity);
  key.name = 'heroKey';
  const fill = new THREE.HemisphereLight('#e4eeff', '#d9d3cc', 0.7);
  fill.name = 'heroFill';
  heroScene.add(key, key.target, fill);

  const shadow = new THREE.DirectionalLight('#ffffff', 0);
  shadow.name = 'heroShadowCaster';
  shadow.castShadow = true;
  shadow.shadow.mapSize.set(2048, 2048);
  shadow.shadow.bias = -0.0004;
  shadow.shadow.normalBias = 0.02;
  shadow.shadow.radius = 2.5;
  heroScene.add(shadow, shadow.target);

  const catcherMat = new THREE.ShadowMaterial({ color: '#2a2350', opacity: 0.34, depthWrite: false });
  const catcher = new THREE.Mesh(new THREE.PlaneGeometry(7, 7), catcherMat);
  catcher.name = 'heroShadowCatcher';
  catcher.rotation.x = -Math.PI / 2;
  catcher.position.y = 0.004;
  catcher.receiveShadow = true;
  catcher.renderOrder = -1;
  heroScene.add(catcher);

  const sunDir = sunDirection.clone().normalize();
  const _c = new THREE.Vector3();
  let extent = 1.2;
  let yaw = THREE.MathUtils.degToRad(KEY_LIGHT.yawDeg), pitch = THREE.MathUtils.degToRad(KEY_LIGHT.pitchDeg);
  const rimYaw = THREE.MathUtils.degToRad(RIM_LIGHT.yawDeg), rimPitch = THREE.MathUtils.degToRad(RIM_LIGHT.pitchDeg);
  const rim = { direction: new THREE.Vector3(0, 0.4, -1).normalize(), color: new THREE.Color(RIM_LIGHT.color), intensity: RIM_LIGHT.intensity };

  return {
    key, fill, shadow, catcher, rim,
    /** Size the shadow frustum for the hero height (m). */
    setHeroHeight(h) {
      extent = Math.max(0.9, h * 0.75);
      const c = shadow.shadow.camera;
      c.left = -extent; c.right = extent; c.top = extent * 1.25; c.bottom = -extent * 0.9;
      c.near = 0.5; c.far = 12; c.updateProjectionMatrix();
    },
    setShadows(on, mapSize = 2048) {
      shadow.castShadow = !!on;
      catcher.visible = !!on;
      if (on && shadow.shadow.mapSize.x !== mapSize) {
        shadow.shadow.mapSize.set(mapSize, mapSize);
        shadow.shadow.map?.dispose(); shadow.shadow.map = null;
      }
    },
    setKeyAngle(yawDeg, pitchDeg) { yaw = THREE.MathUtils.degToRad(yawDeg); pitch = THREE.MathUtils.degToRad(pitchDeg); },
    /**
     * @param {THREE.Camera} camera
     * @param {THREE.Vector3} heroCenter  world position the key aims at (hips/chest)
     */
    update(camera, heroCenter) {
      const az = Math.atan2(camera.position.x - heroCenter.x, camera.position.z - heroCenter.z);
      const a = az - yaw; // camera's left
      _c.set(Math.sin(a) * Math.cos(pitch), Math.sin(pitch), Math.cos(a) * Math.cos(pitch)).multiplyScalar(6);
      key.position.copy(heroCenter).add(_c);
      key.target.position.copy(heroCenter);
      // back rim: behind the hero, to the camera's right (world direction toward the light)
      const r = az + rimYaw;
      rim.direction.set(Math.sin(r) * Math.cos(rimPitch), Math.sin(rimPitch), Math.cos(r) * Math.cos(rimPitch)).normalize();
      shadow.target.position.set(heroCenter.x, 0, heroCenter.z);
      shadow.position.copy(shadow.target.position).addScaledVector(sunDir, 6);
      catcher.position.x = heroCenter.x; catcher.position.z = heroCenter.z;
      key.target.updateMatrixWorld(); shadow.target.updateMatrixWorld();
    },
  };
}
