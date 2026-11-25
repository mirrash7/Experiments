// Stylised island arena: toon platform, sky gradient dome, animated sea, a few props. No game logic.
import * as THREE from 'three';

function toonGradient() {
  const data = new Uint8Array([110, 185, 255]); // 3-step ramp, shade band lifted to sit next to MToon
  const tex = new THREE.DataTexture(data, 3, 1, THREE.RedFormat);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

export function buildArena(scene) {
  const grad = toonGradient();
  const toon = (color) => new THREE.MeshToonMaterial({ color, gradientMap: grad });

  // sky dome: saturated anime-game gradient (deep zenith -> cyan -> pale horizon haze -> warm sea line).
  // Colours are authored sRGB; the shader converts to the output colour space and skips tone mapping so
  // the sky keeps its saturation under the Neutral curve (render/pipeline.js).
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(180, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, toneMapped: false, fog: false,
      uniforms: {
        top: { value: new THREE.Color('#1260e0') }, mid: { value: new THREE.Color('#4fb4ff') },
        hor: { value: new THREE.Color('#c8ecff') }, bot: { value: new THREE.Color('#ffe6b8') },
      },
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }',
      fragmentShader: `uniform vec3 top; uniform vec3 mid; uniform vec3 hor; uniform vec3 bot; varying vec3 vP;
        void main(){
          float h = vP.y;
          vec3 c = h > 0.0 ? mix(hor, mid, smoothstep(0.0, 0.22, h)) : mix(bot, hor, smoothstep(-0.06, 0.0, h));
          c = mix(c, top, smoothstep(0.22, 0.75, h));
          gl_FragColor = vec4(c, 1.);
          #include <colorspace_fragment>
        }`,
    }),
  );
  scene.add(sky);
  scene.fog = new THREE.Fog('#c8ecff', 45, 170);

  // lights (arena only: the hero's toon materials use a camera-locked key light, spec 2.8; the sun
  // still gives the hero its real cast shadow on the deck)
  scene.add(new THREE.HemisphereLight('#d6efff', '#e8c890', 1.25));
  const sun = new THREE.DirectionalLight('#fff6e6', 2.3);
  sun.position.set(4, 9, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -6; sun.shadow.camera.right = 6; sun.shadow.camera.top = 6; sun.shadow.camera.bottom = -6;
  sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 3;
  scene.add(sun);
  const rim = new THREE.DirectionalLight('#9fd8ff', 0.6);
  rim.position.set(-5, 4, -6);
  scene.add(rim);

  // sea
  const seaGeo = new THREE.PlaneGeometry(400, 400, 80, 80);
  seaGeo.rotateX(-Math.PI / 2);
  const sea = new THREE.Mesh(seaGeo, new THREE.MeshToonMaterial({ color: '#14a5d8', gradientMap: grad, transparent: true, opacity: 0.95 }));
  sea.position.y = -0.6;
  scene.add(sea);
  const seaBase = seaGeo.attributes.position.array.slice();

  // island
  const sand = new THREE.Mesh(new THREE.CylinderGeometry(9, 11, 1.2, 40), toon('#f4dcaa'));
  sand.position.y = -0.62; sand.receiveShadow = true;
  scene.add(sand);
  // wooden deck stage
  const deck = new THREE.Group();
  const plankMat = [toon('#c4925e'), toon('#b98654'), toon('#cc9c68')];
  for (let i = -6; i <= 6; i++) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.12, 6.4), plankMat[(i + 6) % 3]);
    p.position.set(i * 0.5, -0.06, 0); p.receiveShadow = true; deck.add(p);
  }
  scene.add(deck);
  // QA v3 r1 P2-3: a soft, slightly darker and cooler pool on the deck around the hero ring, so the warm hero
  // doesn't sit on an equally warm, equally bright ground (figure/ground contrast). One draw, no lighting.
  const poolTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.55, 'rgba(255,255,255,0.85)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const pool = new THREE.Mesh(new THREE.CircleGeometry(2.6, 48),
    new THREE.MeshBasicMaterial({ color: '#3b3552', map: poolTex, transparent: true, opacity: 0.22, depthWrite: false }));
  pool.rotation.x = -Math.PI / 2; pool.position.y = 0.003; pool.renderOrder = -2;
  scene.add(pool);

  // stage ring markers (calibration spot)
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.5, 48), new THREE.MeshBasicMaterial({ color: '#ffd23f', transparent: true, opacity: 0.7 }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.005;
  scene.add(ring);
  const lane = new THREE.Mesh(new THREE.RingGeometry(1.95, 2.0, 64), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.35 }));
  lane.rotation.x = -Math.PI / 2; lane.position.y = 0.004;
  scene.add(lane);

  // props: palms, barrels, crates, a mast with a flag
  const props = new THREE.Group();
  const palm = (x, z, s = 1) => {
    const g = new THREE.Group();
    const segs = 7;
    for (let i = 0; i < segs; i++) {
      const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.13 - i * 0.008, 0.15 - i * 0.008, 0.6, 8), toon(i % 2 ? '#8b5a2b' : '#9c6b38'));
      seg.position.set(Math.sin(i * 0.25) * 0.25 * i * 0.3, 0.3 + i * 0.55, 0); seg.rotation.z = -i * 0.05; seg.castShadow = true; g.add(seg);
    }
    const top = new THREE.Vector3(Math.sin(segs * 0.25) * 0.25 * segs * 0.3, 0.3 + segs * 0.55, 0);
    for (let k = 0; k < 7; k++) {
      const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.28, 2.0, 4, 1), toon(k % 2 ? '#22a84a' : '#3cc45c'));
      leaf.geometry.translate(0, 1.0, 0);
      leaf.position.copy(top); leaf.rotation.set(0, (k / 7) * Math.PI * 2, 1.15 + (k % 2) * 0.2, 'YXZ');
      leaf.scale.set(1, 1, 0.25); leaf.castShadow = true; g.add(leaf);
    }
    g.position.set(x, 0, z); g.scale.setScalar(s); props.add(g);
    return g;
  };
  palm(-5.5, -3.5, 1.1); palm(6.2, -2.5, 0.95); palm(-7.2, 2.2, 0.85); palm(5.4, -6, 1.2);
  const barrel = (x, z) => {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.8, 14), toon('#8d5524'));
    b.position.set(x, 0.4, z); b.castShadow = b.receiveShadow = true; props.add(b);
    for (const y of [-0.25, 0.25]) {
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.325, 0.025, 6, 20), toon('#444'));
      band.rotation.x = Math.PI / 2; band.position.set(x, 0.4 + y, z); props.add(band);
    }
  };
  barrel(-3.8, -1.8); barrel(-3.3, -2.5); barrel(4.0, 1.2);
  const crate = (x, z, r) => {
    const c = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.7), toon('#c69c6d'));
    c.position.set(x, 0.35, z); c.rotation.y = r; c.castShadow = c.receiveShadow = true; props.add(c);
  };
  crate(3.6, -2.2, 0.3); crate(3.9, -1.4, -0.2); crate(-4.2, 1.6, 0.5);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 6, 10), toon('#6b4226'));
  mast.position.set(-2.8, 3, -4.5); mast.castShadow = true; props.add(mast);
  const flagGeo = new THREE.PlaneGeometry(1.6, 1.0, 16, 8);
  flagGeo.translate(0.8, 0, 0);
  const flag = new THREE.Mesh(flagGeo, new THREE.MeshToonMaterial({ color: '#e63946', gradientMap: grad, side: THREE.DoubleSide }));
  flag.position.set(-2.8, 5.4, -4.5); props.add(flag);
  const flagBase = flagGeo.attributes.position.array.slice();
  scene.add(props);

  // distant islands
  for (const [x, z, s] of [[-40, -70, 8], [55, -90, 12], [90, -40, 6], [-80, -30, 7]]) {
    const isl = new THREE.Mesh(new THREE.ConeGeometry(s, s * 0.9, 7), toon('#5aa86a'));
    isl.position.set(x, s * 0.45 - 0.6, z); scene.add(isl);
  }
  // clouds
  const clouds = new THREE.Group();
  const cloudMat = new THREE.MeshToonMaterial({ color: '#ffffff', gradientMap: grad });
  for (let i = 0; i < 9; i++) {
    const c = new THREE.Group();
    for (let k = 0; k < 4; k++) {
      const p = new THREE.Mesh(new THREE.SphereGeometry(2 + Math.random() * 2, 10, 8), cloudMat);
      p.position.set(k * 2.6 - 4, Math.random(), Math.random() * 1.5); c.add(p);
    }
    const a = (i / 9) * Math.PI * 2;
    c.position.set(Math.cos(a) * 90, 28 + Math.random() * 12, Math.sin(a) * 90 - 20);
    clouds.add(c);
  }
  scene.add(clouds);

  return {
    sun,
    /** Direction toward the sun (the hero's shadow caster in render/heroLights.js uses the same one). */
    sunDirection: sun.position.clone().normalize(),
    /** Quality presets: Low turns the shadow maps off. */
    setShadows(on) { sun.castShadow = !!on; },
    update(dt, t) {
      const p = seaGeo.attributes.position.array;
      for (let i = 0; i < p.length; i += 3) {
        const x = seaBase[i], z = seaBase[i + 2];
        p[i + 1] = Math.sin(x * 0.15 + t * 1.1) * 0.12 + Math.cos(z * 0.2 + t * 0.8) * 0.1;
      }
      seaGeo.attributes.position.needsUpdate = true;
      const f = flagGeo.attributes.position.array;
      for (let i = 0; i < f.length; i += 3) {
        const x = flagBase[i];
        f[i + 2] = Math.sin(x * 3 - t * 6) * 0.12 * x;
      }
      flagGeo.attributes.position.needsUpdate = true;
      clouds.rotation.y = t * 0.005;
      ring.material.opacity = 0.5 + Math.sin(t * 3) * 0.2;
    },
  };
}
