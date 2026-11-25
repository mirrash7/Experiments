// Action expressions built from what each VRM actually has (QA v3 r2 P1-5).
//
// The VRM presets are whole-face ("angry" = brows + squint + mouth), so blending them for a fighter's face gave a
// wince / smirk with bared teeth (angry 0.45 + happy 0.12: VRoid Joy opens the mouth). Instead we register a few
// PARTIAL expressions on the model's expression manager and compose the game faces from those:
//
//   arenaBrowDown   brows only (focus / frown), no eyes, no mouth
//   arenaSquint     a slight eye narrowing (eyes only when the model allows it)
//
// Each is resolved per model, in order:
//   1. named morph targets (VRoid 1.0 "Fcl_BRW_Angry" / "Fcl_EYE_Angry", Seed-san "eye_brow_down" / "eye_angry")
//   2. the "angry" preset's morph binds restricted to the brow primitives (VRoid 0.x exports strip the morph names,
//      but the brows are their own primitive: material "...FaceBrow...")
//   3. nothing: the game faces fall back to small weights of the whole presets (see gameExpressionPresets)
import { VRMExpression, VRMExpressionMorphTargetBind } from '@pixiv/three-vrm';

const NAMED = {
  arenaBrowDown: /(BRW_Angry|eye_?brow_?down|brow_?down(er)?)$/i,
  arenaSquint: /(EYE_Angry|eye_?angry|eye_?squint|squint)$/i,
};

/** Map morph-name regex -> [{primitives, index}] over every morph-target mesh in the VRM. */
function findNamed(vrm, re) {
  const byIndex = new Map();
  vrm.scene.traverse((o) => {
    const dict = o.isMesh && o.morphTargetDictionary;
    if (!dict) return;
    for (const [name, index] of Object.entries(dict)) {
      if (!re.test(name) || /_(L|R)$/i.test(name)) continue;
      const key = name + '#' + index;
      if (!byIndex.has(key)) byIndex.set(key, { index, primitives: [] });
      byIndex.get(key).primitives.push(o);
      break; // one match per mesh
    }
  });
  return [...byIndex.values()];
}

/** The angry preset's morph binds, keeping only primitives whose material name matches `matRe`. */
function presetSplit(expr, presetName, matRe) {
  const ex = expr.getExpression(presetName);
  if (!ex?._binds) return [];
  const out = [];
  for (const b of ex._binds) {
    if (!(b instanceof VRMExpressionMorphTargetBind) || !b.primitives) continue;
    const prims = b.primitives.filter((p) => [].concat(p.material).some((m) => m && matRe.test(m.name)));
    if (prims.length) out.push({ index: b.index, primitives: prims, weight: b.weight });
  }
  return out;
}

/**
 * Register the partial expressions on vrm.expressionManager.
 * @returns {{ has: Set<string>, source: object }}  which partial expressions exist, and how each was built
 */
export function registerPartialExpressions(vrm) {
  const expr = vrm.expressionManager;
  const has = new Set(), source = {};
  if (!expr) return { has, source };
  for (const name of Object.keys(NAMED)) {
    let binds = findNamed(vrm, NAMED[name]).map((b) => ({ ...b, weight: 1 }));
    let how = binds.length ? 'named' : null;
    if (!binds.length && name === 'arenaBrowDown') {
      binds = presetSplit(expr, 'angry', /brow/i);
      if (binds.length) how = 'angry-preset:brows';
    }
    if (!binds.length) continue;
    const e = new VRMExpression(name);
    for (const b of binds) e.addBind(new VRMExpressionMorphTargetBind({ primitives: b.primitives, index: b.index, weight: b.weight }));
    expr.registerExpression(e);
    has.add(name); source[name] = how;
  }
  return { has, source };
}

/**
 * Game expression presets for this model. Each: { w: {expr: weight}, attack, hold, release } (seconds).
 *   determined  punches: frown + barely narrowed eyes, mouth closed (no teeth, no blink > 0.3)
 *   kiai        kick snap: determined + a short open-mouth effort, brief
 *   jump        happy + a small "aa"
 *   happy       hands up / celebration
 */
export function gameExpressionPresets(vrm, has) {
  const ex = (n) => !!vrm.expressionManager?.getExpression(n);
  const binary = (n) => !!vrm.expressionManager?.getExpression(n)?.isBinary;
  const brow = has.has('arenaBrowDown'), squint = has.has('arenaSquint');
  // focus without the brow-only expression: a small whole-face angry (VRoid's angry mouth is closed); binary
  // (texture-swap) presets cannot be faded, skip them
  const angryLow = ex('angry') && !binary('angry') ? { angry: 0.22 } : {};
  const determined = brow
    ? { arenaBrowDown: 0.85, ...(squint ? { arenaSquint: 0.18 } : ex('angry') && !binary('angry') ? { angry: 0.1 } : {}) }
    : angryLow;
  const aa = ex('aa') ? 'aa' : null;
  const happy = ex('happy') ? { happy: 0.8 } : ex('relaxed') ? { relaxed: 0.8 } : {};
  return {
    neutral: { w: {}, attack: 0.08, hold: 0, release: 0.25 },
    idle: { w: {}, attack: 0.08, hold: 0, release: 0.25 },
    determined: { w: determined, attack: 0.08, hold: 0.4, release: 0.3 },
    kiai: { w: { ...determined, ...(aa ? { [aa]: 0.3 } : {}) }, attack: 0.06, hold: 0.28, release: 0.25 },
    get effort() { return this.kiai; }, // procedural-hero name for the same face
    jump: { w: { ...happy, ...(aa ? { [aa]: 0.18 } : {}) }, attack: 0.1, hold: 0.5, release: 0.35 },
    happy: { w: happy, attack: 0.12, hold: 1.0, release: 0.4 },
    angry: { w: ex('angry') ? { angry: 0.8 } : {}, attack: 0.1, hold: 1.0, release: 0.4 },
    surprised: { w: ex('surprised') ? { surprised: 0.8 } : ex('Surprised') ? { Surprised: 0.8 } : {}, attack: 0.08, hold: 0.8, release: 0.4 },
    sad: { w: ex('sad') ? { sad: 0.7 } : {}, attack: 0.15, hold: 1.2, release: 0.5 },
    relaxed: { w: ex('relaxed') ? { relaxed: 0.7 } : {}, attack: 0.15, hold: 1.2, release: 0.5 },
  };
}
