// Stand-ins for the AUDIO, VISUAL and UI modules (same interfaces as docs/game/CONTRACTS.md), so the game runs
// before / without the real modules: beeps, simple meshes, plain DOM. main.js uses the real modules when they load
// and fills any member they do not (yet) implement from these (see fillMissing()).
import * as THREE from 'three';

// ================================================================================================ AUDIO (beeps)
export function createStubAudio() {
  const bpm = 128, beatDur = 60 / bpm;
  const t0 = performance.now();
  let ctx = null, master = null;
  const vol = { master: 0.9, music: 0.8, sfx: 0.9 };
  const beatCbs = new Set();
  let song = null, intensity = 0, overdrive = false, lastBeat = -1;
  const clock = {
    bpm, beatDur,
    now: () => (performance.now() - t0) / 1000,
    beat: () => clock.now() / beatDur,
    toPerf: (s) => t0 + s * 1000,
    fromPerf: (ms) => (ms - t0) / 1000,
    onBeat(cb) { beatCbs.add(cb); return () => beatCbs.delete(cb); },
  };
  function tone(freq, dur, type = 'square', gain = 0.06, when = 0, bus = 'sfx') {
    if (!ctx || ctx.state !== 'running' || vol.master <= 0) return;
    const t = ctx.currentTime + when;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(gain * vol[bus], t); g.gain.exponentialRampToValueAtTime(1e-4, t + dur);
    o.connect(g).connect(master); o.start(t); o.stop(t + dur + 0.02);
  }
  const SFX = { perfect: [1320, 0.12], great: [990, 0.1], good: [770, 0.08], miss: [140, 0.2, 'sawtooth'], punchHit: [220, 0.06], kickHit: [160, 0.08],
    shatter: [1800, 0.05, 'triangle'], block: [300, 0.1], dodge: [600, 0.06, 'sine'], jumpOver: [700, 0.08, 'sine'], duckUnder: [500, 0.08, 'sine'],
    blast: [90, 0.6, 'sawtooth'], hurt: [110, 0.25, 'sawtooth'], combo: [1100, 0.08], overdrive: [880, 0.4, 'triangle'], uiHover: [1500, 0.03, 'sine'],
    uiSelect: [1000, 0.06, 'sine'], countdown: [660, 0.12, 'sine'], go: [990, 0.25, 'sine'], bossRoar: [70, 0.9, 'sawtooth'], bossHit: [200, 0.15],
    victory: [880, 0.6, 'triangle'], defeat: [180, 0.6, 'triangle'], whoosh: [400, 0.05, 'sine'] };
  // main-thread beat ticker (the real AUDIO schedules on the audio thread)
  setInterval(() => {
    const b = Math.floor(clock.beat());
    if (b === lastBeat) return;
    lastBeat = b;
    if (song) {
      tone(b % 4 === 0 ? 70 : 55, 0.12, 'sine', 0.22, 0, 'music');
      if (intensity > 0.3 && b % 2 === 1) tone(3000, 0.03, 'square', 0.02, 0, 'music');
      if (overdrive) tone(440 * (1 + (b % 4) / 4), 0.1, 'triangle', 0.03, 0, 'music');
    }
    for (const cb of beatCbs) { try { cb(b); } catch (e) { console.warn(e); } }
  }, 10);
  return {
    stub: true,
    clock,
    async unlock() {
      try {
        if (!ctx) { ctx = new AudioContext(); master = ctx.createGain(); master.gain.value = vol.master; master.connect(ctx.destination); }
        if (ctx.state !== 'running') await ctx.resume();
      } catch { /* no audio */ }
    },
    playSong(id) { song = id; },
    setIntensity(x) { intensity = x; },
    setOverdrive(on) { overdrive = on; },
    stopSong() { song = null; },
    sfx(name, o = {}) { const s = SFX[name]; if (s) tone(s[0] * (o.pitch ?? 1), s[1], s[2] || 'square', 0.06 * (o.gain ?? 1)); },
    sfxLoop(name) {
      if (!ctx || ctx.state !== 'running') return { stop() {} };
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sawtooth'; o.frequency.value = name === 'chargeHum' ? 110 : 220; g.gain.value = 0.03 * vol.sfx;
      o.connect(g).connect(master); o.start();
      return { stop() { try { g.gain.setTargetAtTime(0, ctx.currentTime, 0.05); o.stop(ctx.currentTime + 0.3); } catch { /* */ } } };
    },
    setVolume(v) { Object.assign(vol, v); if (master) master.gain.value = vol.master; },
    get latencyMs() { return ctx ? ((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000 : 0; },
  };
}

// ================================================================================================ VISUAL (meshes)
const SPIRIT_STYLE = {
  striker: { color: 0xff8a2a, geo: () => new THREE.OctahedronGeometry(0.16) },
  crawler: { color: 0x2ee6ff, geo: () => new THREE.BoxGeometry(0.3, 0.14, 0.34) },
  sweep: { color: 0xff2a3a, geo: () => new THREE.BoxGeometry(3.2, 0.06, 0.08) },
  scythe: { color: 0xb04bff, geo: () => new THREE.BoxGeometry(3.2, 0.06, 0.08) },
  volley: { color: 0xffe14a, geo: () => new THREE.SphereGeometry(0.13, 12, 8) },
  brute: { color: 0xffc23a, geo: () => new THREE.BoxGeometry(0.7, 1.5, 0.5) },
  core: { color: 0xfff3d0, geo: () => new THREE.IcosahedronGeometry(0.25, 1) },
};

export async function createStubVisuals(ctx) {
  const { worldScene } = ctx;
  const stageObj = new THREE.Group(); stageObj.name = 'StubStage';
  const ground = new THREE.Mesh(new THREE.CircleGeometry(6, 48), new THREE.MeshStandardMaterial({ color: 0x5a5068, roughness: 0.9 }));
  ground.rotation.x = -Math.PI / 2; stageObj.add(ground);
  const ring = new THREE.Mesh(new THREE.RingGeometry(1.0, 1.08, 48), new THREE.MeshBasicMaterial({ color: 0xffb060, toneMapped: false }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.01; stageObj.add(ring);
  const rift = new THREE.Vector3(0, 3.5, 34);
  const riftMesh = new THREE.Mesh(new THREE.TorusGeometry(1.4, 0.08, 8, 32), new THREE.MeshBasicMaterial({ color: 0xc070ff, toneMapped: false }));
  riftMesh.position.copy(rift); stageObj.add(riftMesh);
  stageObj.add(new THREE.HemisphereLight(0xffd0a0, 0x302040, 1.2));
  const sun = new THREE.DirectionalLight(0xffe0c0, 1.5); sun.position.set(-4, 8, 10); stageObj.add(sun);
  const SKY = { 0: 0xe08a5a, 1: 0xa0407a, 2: 0x3a2a6a, boss: 0x140c2a, title: 0xd07a60, results: 0x50306a };
  let pulse = 0;
  worldScene.background = new THREE.Color(SKY.title);

  // spirits: pooled per type
  const pools = {};
  const geos = {}, mats = {};
  function makeView(type) {
    const st = SPIRIT_STYLE[type] ?? SPIRIT_STYLE.striker;
    geos[type] ??= st.geo();
    mats[type] ??= new THREE.MeshBasicMaterial({ color: st.color, toneMapped: false, transparent: true });
    const mesh = new THREE.Mesh(geos[type], mats[type].clone());
    const tele = new THREE.Mesh(new THREE.RingGeometry(0.22, 0.25, 24), new THREE.MeshBasicMaterial({ color: st.color, toneMapped: false, transparent: true, side: THREE.DoubleSide }));
    const object = new THREE.Group(); object.add(mesh, tele);
    const view = {
      type, object, side: 'center', hitPoint: new THREE.Vector3(), _dead: 0, _active: false,
      setTelegraph(t) { tele.scale.setScalar(1 + (1 - t) * 3); tele.material.opacity = 0.2 + 0.8 * t; },
      update(dt) {
        mesh.rotation.y += dt * 2;
        if (view._dead > 0) {
          view._dead -= dt; const k = Math.max(0, view._dead / 0.3);
          mesh.scale.setScalar(1 + (1 - k) * 1.5); mesh.material.opacity = k; tele.visible = false;
          if (view._dead <= 0) view.release();
        }
        object.getWorldPosition(view.hitPoint);
      },
      hit() { view._dead = 0.3; },
      dodged() { view._dead = 0.3; },
      strikeHero() { view._dead = 0.3; mesh.material.color.set(0xffffff); },
      release() {
        if (!view._active) return;
        view._active = false; object.removeFromParent(); activeViews.delete(view);
        (pools[type] ??= []).push(view);
      },
    };
    return view;
  }
  const activeViews = new Set();
  const spirits = {
    create(type, opts = {}) {
      const v = (pools[type] ??= []).pop() ?? makeView(type);
      v._active = true; v._dead = 0; v.side = opts.side ?? 'center';
      v.object.children[0].scale.setScalar(1); v.object.children[0].material.opacity = 1;
      v.object.children[0].material.color.set(SPIRIT_STYLE[type]?.color ?? 0xffffff);
      v.object.children[1].visible = true;
      worldScene.add(v.object);
      activeViews.add(v);
      return v;
    },
    update(dt) { for (const v of activeViews) v.update(dt); },
  };

  // boss: a tall box far out with a weak point sphere
  const bossObj = new THREE.Group(); bossObj.visible = false;
  const bossBody = new THREE.Mesh(new THREE.BoxGeometry(6, 14, 3), new THREE.MeshStandardMaterial({ color: 0x40306a, emissive: 0x201040 }));
  bossBody.position.y = 4; bossObj.add(bossBody);
  const weakMesh = new THREE.Mesh(new THREE.SphereGeometry(0.9, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
  weakMesh.position.set(0, 7, -1.6); weakMesh.visible = false; bossObj.add(weakMesh);
  bossObj.position.set(0, -2, 26);
  worldScene.add(bossObj);
  let bossShake = 0;
  const boss = {
    object: bossObj, weakPoint: new THREE.Vector3(0, 5, 24.4),
    show() { bossObj.visible = true; }, hide() { bossObj.visible = false; },
    update(dt) { bossShake = Math.max(0, bossShake - dt); bossBody.position.x = Math.sin(performance.now() * 0.05) * bossShake * 0.4; },
    telegraph(attack, t) { bossBody.material.emissive.setRGB(0.12 + t * 0.5, 0.06, 0.25); },
    attack() { bossShake = 0.3; bossBody.material.emissive.setHex(0x201040); },
    stagger() { bossShake = 0.8; }, openWeakPoint(on) { weakMesh.visible = !!on; }, hit() { bossShake = 0.4; },
    defeat() { bossShake = 2; setTimeout(() => (bossObj.visible = false), 2000); },
  };

  // vfx
  const aura = new THREE.Mesh(new THREE.SphereGeometry(0.9, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffd060, transparent: true, opacity: 0.0, depthWrite: false, toneMapped: false }));
  aura.position.y = 0.9; ctx.heroScene.add(aura);
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 1, 12, 1, true), new THREE.MeshBasicMaterial({ color: 0xfff0c0, transparent: true, opacity: 0, depthWrite: false, toneMapped: false }));
  worldScene.add(beam);
  let beamT = 0, auraTarget = 0;
  const _up = new THREE.Vector3(0, 1, 0), _d = new THREE.Vector3();
  const vfx = {
    aura(on, o = {}) { auraTarget = on ? (o.strength ?? 0.5) * 0.35 : 0; if (o.color != null) aura.material.color.set(o.color); },
    blast(origin, dir) {
      const len = 40; beamT = 0.6;
      beam.scale.set(1, len, 1); _d.copy(dir).normalize();
      beam.quaternion.setFromUnitVectors(_up, _d);
      beam.position.copy(origin).addScaledVector(_d, len / 2);
    },
    judgement() {}, shockwave() { pulse = 1; },
    update(dt) {
      aura.material.opacity += (auraTarget - aura.material.opacity) * Math.min(1, dt * 6);
      aura.visible = aura.material.opacity > 0.01;
      if (ctx.hero) { aura.position.x = ctx.hero.root.position.x; aura.position.z = ctx.hero.root.position.z; }
      beamT = Math.max(0, beamT - dt); beam.material.opacity = beamT; beam.visible = beamT > 0;
    },
  };
  return {
    stub: true,
    stage: {
      object: stageObj, rift,
      update(dt, s = {}) {
        pulse = Math.max(0, pulse - dt * 3);
        ring.scale.setScalar(1 + pulse * 0.25);
        ring.material.color.setHex(s.overdrive ? 0xffe040 : 0xffb060);
        riftMesh.rotation.z += dt * 0.6;
      },
      setAct(a) { worldScene.background = new THREE.Color(SKY[a] ?? SKY.title); },
      pulse(s = 1) { pulse = Math.max(pulse, s); },
    },
    spirits, boss, vfx,
    dispose() { stageObj.removeFromParent(); bossObj.removeFromParent(); aura.removeFromParent(); beam.removeFromParent(); },
  };
}

// ================================================================================================ UI (plain DOM)
const CSS = `
#stubui{position:fixed;inset:0;pointer-events:none;font:600 15px Inter,system-ui,sans-serif;color:#fff;text-shadow:0 2px 6px #000a;z-index:10}
#stubui .scr{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:#0008;pointer-events:auto}
#stubui .scr h1{font:900 64px Inter,sans-serif;margin:0;letter-spacing:4px}
#stubui button{font:800 20px Inter,sans-serif;padding:12px 28px;border-radius:10px;border:2px solid #fff6;background:#ff7a3a;color:#fff;cursor:pointer}
#stubui .hud{position:absolute;left:18px;top:14px;line-height:1.5}
#stubui .hud b{font-size:28px}
#stubui .flow{width:220px;height:10px;background:#fff3;border-radius:5px;overflow:hidden}#stubui .flow i{display:block;height:100%;background:#ffd23f;width:0}
#stubui .banner{position:absolute;top:22%;width:100%;text-align:center;font:900 54px Inter,sans-serif;opacity:0;transition:opacity .3s}
#stubui .banner small{display:block;font-size:20px}
#stubui .prompt{position:absolute;bottom:18%;width:100%;text-align:center;font:900 40px Inter,sans-serif;color:#ffd23f}
#stubui .judge{position:absolute;font:900 30px Inter,sans-serif;transform:translate(-50%,-50%);animation:sj .7s forwards}
@keyframes sj{to{transform:translate(-50%,-140%);opacity:0}}
#stubui table{border-collapse:collapse;background:#0006}#stubui td{padding:3px 12px}
#stubui .pip{position:absolute;right:16px;bottom:16px;width:220px;height:124px;background:#000a;border:2px solid #fff4;border-radius:8px;overflow:hidden}
#stubui .pip video,#stubui .pip canvas{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform:scaleX(-1)}
`;

export function createStubUI(ctx) {
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
  const root = document.createElement('div'); root.id = 'stubui'; document.body.appendChild(root);
  root.innerHTML = `<div class="hud" style="display:none"><div>SCORE <b class="sc">0</b></div><div>COMBO <b class="co">0</b> <span class="mu"></span></div>
    <div class="he"></div><div class="flow"><i></i></div></div><div class="banner"></div><div class="prompt"></div>
    <div class="pip" style="display:none"><canvas></canvas></div><div class="layer"></div>`;
  const q = (s) => root.querySelector(s);
  const hudEl = q('.hud'), layer = q('.layer'), bannerEl = q('.banner'), promptEl = q('.prompt');
  const pipCanvas = q('.pip canvas');
  let screen = null, bannerT = 0, cdEl = null;
  const JCOL = { perfect: '#7affff', great: '#7aff7a', good: '#ffe07a', miss: '#ff6060' };
  function show(html, wire) {
    hide(); screen = document.createElement('div'); screen.className = 'scr'; screen.innerHTML = html;
    layer.appendChild(screen); wire?.(screen);
  }
  function hide() { screen?.remove(); screen = null; }
  const btn = (scr, sel, fn) => { const b = scr.querySelector(sel); if (b) b.onclick = () => { ctx.audio?.sfx?.('uiSelect'); fn(); }; };
  return {
    stub: true,
    root,
    cursor: { enable() {}, update() {} },
    screens: {
      boot({ onTracker }) {
        show(`<h1>BREAKLIGHT</h1><div>Choose a tracker</div><div><button data-t="auto">Auto</button> <button data-t="hmr">InstantHMR</button>
          <button data-t="mediapipe">MediaPipe</button> <button data-t="demo">Demo player</button></div>`, (s) => {
          s.querySelectorAll('button').forEach((b) => (b.onclick = () => onTracker(b.dataset.t)));
        });
      },
      calibrate({ onDone }) {
        show('<h1>STRIKE THE POSE</h1><div>Hold a T-pose for 1 second</div><div class="cal">0%</div><button>Skip</button>', (s) => btn(s, 'button', onDone));
        let held = 0, last = performance.now();
        const tick = () => {
          if (!screen || !screen.querySelector('.cal')) return;
          const now = performance.now(), dt = (now - last) / 1000; last = now;
          held = ctx.motion?.actions?.state?.tPose ? held + dt : Math.max(0, held - dt);
          screen.querySelector('.cal').textContent = `${Math.round(Math.min(1, held) * 100)}%`;
          if (held >= 1) { onDone(); return; }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      },
      title({ onPlay, onTutorial, onSettings }) {
        show('<h1>BREAKLIGHT</h1><div><button class="p">Play</button> <button class="t">Tutorial</button> <button class="s">Settings</button></div>', (s) => {
          btn(s, '.p', onPlay); btn(s, '.t', onTutorial); btn(s, '.s', onSettings);
        });
      },
      tutorial({ steps, onDone }) {
        show(`<h1>TUTORIAL</h1><div>${steps.map((x) => x.label ?? x.id).join(' · ')}</div><button>Done</button>`, (s) => btn(s, 'button', onDone));
      },
      settings({ settings, onClose }) {
        show(`<h1>SETTINGS</h1><label><input type="checkbox" ${settings.upperBodyOnly ? 'checked' : ''}/> Upper body only</label><button>Close</button>`, (s) => {
          s.querySelector('input').onchange = (e) => { settings.upperBodyOnly = e.target.checked; settings.save?.(); };
          btn(s, 'button', onClose);
        });
      },
      pause({ reason }) { show(`<h1>PAUSED</h1><div>${reason || 'Step back into view'}</div>`); },
      countdown(n) {
        hide();
        cdEl?.remove(); cdEl = document.createElement('div'); cdEl.className = 'banner'; cdEl.style.opacity = 1; cdEl.style.fontSize = '120px';
        cdEl.textContent = n > 0 ? String(n) : 'GO!'; layer.appendChild(cdEl);
        const el = cdEl; setTimeout(() => el.remove(), 700);
      },
      results({ stats, onReplay, onAgain, onTitle }) {
        const rows = [['Rank', stats.rank], ['Score', stats.score], ['Max combo', stats.maxCombo],
          ['Perfect / Great / Good / Miss', `${stats.judgements.perfect} / ${stats.judgements.great} / ${stats.judgements.good} / ${stats.judgements.miss}`],
          ['Fastest punch', `${stats.body.fastestPunch.toFixed(1)} m/s`], ['Highest jump', `${Math.round(stats.body.maxJumpCm)} cm`],
          ['Best reaction', stats.body.bestReactionMs ? `${Math.round(stats.body.bestReactionMs)} ms` : '-'],
          ['Moves', stats.body.moves], ['Energy', `${stats.body.kcal.toFixed(1)} kcal`]];
        show(`<h1>${stats.cleared ? 'CLEAR!' : 'TRY AGAIN'}</h1><table>${rows.map((r) => `<tr><td>${r[0]}</td><td><b>${r[1]}</b></td></tr>`).join('')}</table>
          <div><button class="r">Replay</button> <button class="a">Play again</button> <button class="t">Title</button></div>`, (s) => {
          btn(s, '.r', onReplay); btn(s, '.a', onAgain); btn(s, '.t', onTitle);
        });
        screen.style.background = '#0004'; screen.style.alignItems = 'flex-start'; screen.style.paddingLeft = '40px';
      },
      hide,
    },
    hud: {
      show(on) { hudEl.style.display = on ? '' : 'none'; },
      setScore(n) { q('.sc').textContent = n; },
      setCombo(n, m) { q('.co').textContent = n; q('.mu').textContent = m > 1 ? `x${m}` : ''; },
      setHealth(h, max) { q('.he').textContent = '♥'.repeat(Math.max(0, h)) + '♡'.repeat(Math.max(0, max - h)); },
      setFlow(f, od) { const i = q('.flow i'); i.style.width = `${Math.round(f * 100)}%`; i.style.background = od ? '#fff' : '#ffd23f'; },
      banner(text, sub) { bannerEl.innerHTML = `${text}${sub ? `<small>${sub}</small>` : ''}`; bannerEl.style.opacity = 1; bannerT = 2.2; },
      judgement(pos, kind) {
        const el = document.createElement('div'); el.className = 'judge'; el.textContent = kind.toUpperCase(); el.style.color = JCOL[kind] ?? '#fff';
        el.style.left = `${pos.x}px`; el.style.top = `${pos.y}px`; layer.appendChild(el); setTimeout(() => el.remove(), 700);
      },
      prompt(text) { promptEl.textContent = text || ''; },
      pip: {
        setVideo(video) { const p = q('.pip'); if (!video) return; p.style.display = ''; if (!p.contains(video)) { video.style.display = ''; p.prepend(video); } },
        setSkeleton(kp, edges) {
          const p = q('.pip'); if (!kp) return; p.style.display = '';
          const c = pipCanvas, w = (c.width = 220), h = (c.height = 124), g = c.getContext('2d');
          g.clearRect(0, 0, w, h); g.strokeStyle = '#5fffc0'; g.lineWidth = 2; g.beginPath();
          for (const [a, b] of edges || []) { const A = kp[a], B = kp[b]; if (!A || !B) continue; g.moveTo(A.x * w, A.y * h); g.lineTo(B.x * w, B.y * h); }
          g.stroke();
        },
      },
      distance() {},
    },
    update(dt) {
      if (bannerT > 0 && (bannerT -= dt) <= 0) bannerEl.style.opacity = 0;
    },
  };
}

/**
 * Copy every function / object member the real module lacks from the stub (recursively for plain objects), so a
 * half-finished real module still runs. Returns the list of filled paths (logged once in debug).
 */
export function fillMissing(real, stub, path = '', filled = []) {
  if (!real || !stub) return filled;
  for (const k of Object.keys(stub)) {
    if (k === 'stub') continue;
    const sv = stub[k];
    let rv;
    try { rv = real[k]; } catch { continue; }
    if (rv === undefined || rv === null) {
      try { real[k] = sv; filled.push(path + k); } catch { /* getter-only */ }
    } else if (sv && typeof sv === 'object' && !sv.isObject3D && !sv.isVector3 && typeof rv === 'object' && !rv.isObject3D && !rv.isVector3) {
      fillMissing(rv, sv, path + k + '.', filled);
    }
  }
  return filled;
}
