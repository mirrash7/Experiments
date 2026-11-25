// Soft contact blob under the hero (spec 2.14: radial gradient decal, 0.35 opacity, under the hips'
// ground projection). Complements the real cast shadow. Owner: WP6.
import * as THREE from 'three';

function blobTexture(size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const r = size / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0.0, 'rgba(0,0,0,1)');
  grad.addColorStop(0.45, 'rgba(0,0,0,0.75)');
  grad.addColorStop(0.75, 'rgba(0,0,0,0.25)');
  grad.addColorStop(1.0, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * @param {object} [o]
 * @param {number} [o.radius=0.42]  blob radius (m) when standing
 * @param {number} [o.opacity=0.35]
 * @param {number} [o.groundY=0.004] decal height (above the deck, below the ring markers' z-fight band)
 * @param {THREE.Color|string} [o.color='#2a2350'] tinted, not pure black (anime-game ground shadow)
 */
export function createContactShadow({ radius = 0.42, opacity = 0.35, groundY = 0.003, color = '#2a2350' } = {}) {
  const tex = blobTexture();
  const mat = new THREE.MeshBasicMaterial({
    map: tex, color, transparent: true, opacity, depthWrite: false, toneMapped: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  mesh.name = 'heroContactBlob';
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = groundY;
  mesh.renderOrder = 1;
  mesh.scale.setScalar(radius);
  const _hips = new THREE.Vector3(), _l = new THREE.Vector3(), _r = new THREE.Vector3();

  return {
    mesh,
    /**
     * Follow the hero. Blob centres between the hips projection and the feet, shrinks and fades as the
     * hips rise (jumps) so the hero reads as airborne.
     * @param {object} hero  facade (bones.hips, bones.leftFoot, bones.rightFoot)
     */
    update(hero) {
      const B = hero.bones;
      B.hips.getWorldPosition(_hips);
      B.leftFoot.getWorldPosition(_l);
      B.rightFoot.getWorldPosition(_r);
      const footY = Math.min(_l.y, _r.y) - (hero.info?.ankleHeight ?? 0.07); // ankle height above sole (per model)
      const lift = Math.max(0, footY - groundY);
      const cx = _hips.x * 0.6 + (_l.x + _r.x) * 0.2, cz = _hips.z * 0.6 + (_l.z + _r.z) * 0.2;
      mesh.position.set(cx, groundY, cz);
      const spread = Math.min(0.5, Math.hypot(_l.x - _r.x, _l.z - _r.z) * 0.5);
      const k = 1 / (1 + lift * 2.5);
      const r = radius * (hero.info?.height ? hero.info.height / 1.75 : 1);
      mesh.scale.set((r + spread * 0.6) * k, (r + spread * 0.25) * k, 1);
      mat.opacity = opacity * k;
    },
    dispose() { mesh.geometry.dispose(); mat.dispose(); tex.dispose(); mesh.removeFromParent(); },
  };
}
