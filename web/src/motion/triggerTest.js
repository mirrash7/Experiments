// Trigger regression test: drives the ActionDetector with the synthetic player on a simulated clock (no render,
// no wall time) and counts the events per synthetic phase. Runs in node and in the browser:
//   node web/src/motion/triggerTest.js            (prints the table, exits 1 on failure)
//   lab.triggerTest()                              (motion lab, same result object)
// Expectations per 4 s move: 0 guard: nothing, 1 jab/cross: 8 punches alternating L/R and never both inside
// 150 ms, 2 kicks: exactly 1 kickLeft + 1 kickRight, 3 squats: no punches/kicks, 4 jumps: 0 punches,
// 5 T-pose: 0 punches, 6 wave: 0 punches. Phase changes teleport the synthetic pose (e.g. guard -> hands up), which
// the light filter turns into a very fast arm raise: exactly the case that used to fire phantom double punches.
// The second part (runRobustness, moveBench.js) runs every game move under realistic monocular noise.
import { ActionDetector } from '../actions.js';
import { SyntheticSource, SYN_PHASES } from '../sources/syntheticSource.js';
import { runMoveBench, mergeBench, formatBench, benchFails } from './moveBench.js';

const IMPULSES = ['punchLeft', 'punchRight', 'kickLeft', 'kickRight', 'jump'];

/** Run `loops` synthetic loops (28 s each) at `rate` Hz with `noise` m keypoint noise. */
export function runTriggerTest({ loops = 2, rate = 30, noise = 0, seed = 1, latencyMs = 20, Detector = ActionDetector } = {}) {
  const src = new SyntheticSource({ rate, noise: 0 });
  const det = new Detector();
  let now = 0;
  det.clock = () => now;
  const events = [];
  det.on((name, info) => events.push({ name, t: info.t }));
  let rnd = seed;
  const rand = () => { rnd = (rnd * 16807) % 2147483647; return rnd / 2147483647; };
  const g = () => { let s = 0; for (let i = 0; i < 6; i++) s += rand(); return (s - 3) * Math.SQRT2; };
  const N = SYN_PHASES.length, T = loops * N * 4;
  for (let i = 0; i * 1000 / rate < T * 1000; i++) {
    const tCap = i * 1000 / rate;
    now = tCap + latencyMs;
    const { joints } = src.pose(tCap / 1000);
    const conf = {};
    for (const k of Object.keys(joints)) {
      joints[k].z -= 2.5;
      if (noise > 0) { joints[k].x += g() * noise; joints[k].y += g() * noise; joints[k].z += g() * noise; }
      conf[k] = 1;
    }
    det.pushFrame({ joints, conf, tCapture: tCap });
  }
  // per-phase counts (phase of the capture time; events carry t = clock = capture + latency)
  const perPhase = SYN_PHASES.map((name) => ({ phase: name, ...Object.fromEntries(IMPULSES.map((k) => [k, 0])), states: {} }));
  for (const e of events) {
    const tc = (e.t - latencyMs) / 1000, p = Math.floor(tc / 4) % N;
    if (IMPULSES.includes(e.name)) perPhase[p][e.name]++;
    else perPhase[p].states[e.name] = (perPhase[p].states[e.name] ?? 0) + 1;
  }
  // doubles: L+R punches within 150 ms, same-side kicks within 1.2 s
  let doublePunches = 0, doubleKicks = 0;
  const punches = events.filter((e) => e.name.startsWith('punch'));
  for (let i = 1; i < punches.length; i++) if (punches[i].name !== punches[i - 1].name && punches[i].t - punches[i - 1].t < 150) doublePunches++;
  for (const k of ['kickLeft', 'kickRight']) {
    const ks = events.filter((e) => e.name === k);
    for (let i = 1; i < ks.length; i++) if (ks[i].t - ks[i - 1].t < 1200) doubleKicks++;
  }
  const L = loops, fails = [];
  const P = (n) => perPhase[SYN_PHASES.indexOf(n)];
  const punchesIn = (n) => P(n).punchLeft + P(n).punchRight, kicksIn = (n) => P(n).kickLeft + P(n).kickRight;
  for (const n of ['guard', 'squat', 'jump', 'tpose', 'wave']) if (punchesIn(n)) fails.push(`${n}: ${punchesIn(n)} punches (want 0)`);
  for (const n of ['guard', 'punch', 'squat', 'jump', 'tpose', 'wave']) if (kicksIn(n)) fails.push(`${n}: ${kicksIn(n)} kicks (want 0)`);
  if (P('punch').punchLeft !== 4 * L || P('punch').punchRight !== 4 * L) fails.push(`punch: L ${P('punch').punchLeft} R ${P('punch').punchRight} (want ${4 * L} each)`);
  if (P('kick').kickLeft !== L || P('kick').kickRight !== L) fails.push(`kick: L ${P('kick').kickLeft} R ${P('kick').kickRight} (want ${L} each)`);
  if (P('jump').jump !== 3 * L) fails.push(`jump: ${P('jump').jump} jumps (want ${3 * L})`);
  if (doublePunches) fails.push(`${doublePunches} L+R punch pairs within 150 ms`);
  if (doubleKicks) fails.push(`${doubleKicks} repeated kicks within 1.2 s`);
  return { ok: fails.length === 0, fails, perPhase, doublePunches, doubleKicks, loops, noise, rate };
}

/** Plain-text table of a result. */
export function formatTriggerTest(r) {
  const rows = r.perPhase.map((p) => `${String(SYN_PHASES.indexOf(p.phase)).padEnd(2)}${p.phase.padEnd(7)} ` +
    IMPULSES.map((k) => `${k}=${p[k]}`).join(' '));
  return [`loops=${r.loops} rate=${r.rate} noise=${r.noise}  ${r.ok ? 'PASS' : 'FAIL: ' + r.fails.join('; ')}`, ...rows].join('\n');
}

// ---------------------------------------------------------------------------------------- robustness bench
// Every game move under realistic single-webcam noise (moveBench.js): anisotropic keypoint noise, dropped frames,
// occlusions, 25-30 Hz. Targets: >= 97 % detection per move in every config, <= 1 phantom per 100 moves.
export const BENCH_CONFIGS = {
  mild: { sxy: 0.01, sz: 0.03, rate: 30 },                       // 1 cm x/y, 3 cm depth
  mid: { sxy: 0.015, sz: 0.05, rate: 30 },
  harsh: { sxy: 0.02, sz: 0.08, rate: 25 },                      // 2 cm x/y, 8 cm depth, 25 Hz
  upper: { sxy: 0.015, sz: 0.06, rate: 30, upperBody: true },    // legs never tracked
  seated: { sxy: 0.015, sz: 0.06, rate: 30, seated: true },     // detector.seated: head-drop ducks only, no legs
};

/** Run the bench for every config (seeds x reps per move). Returns {configs: {name: result}, all, fails}. */
export function runRobustness({ Detector = ActionDetector, seeds = [1, 2, 3], reps = 24, configs = BENCH_CONFIGS } = {}) {
  const out = {}, fails = [];
  for (const [name, cfg] of Object.entries(configs)) {
    out[name] = mergeBench(seeds.map((seed) => runMoveBench({ Detector, reps, seed, ...cfg })));
    for (const f of benchFails(out[name])) fails.push(`${name}: ${f}`);
  }
  return { configs: out, all: mergeBench(Object.values(out)), fails, ok: fails.length === 0 };
}

// node entry point:  node web/src/motion/triggerTest.js [--quick] [--full] [--detector=path/to/actions.js]
if (typeof process !== 'undefined' && process.argv?.[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
  const args = process.argv.slice(2);
  const detPath = args.find((a) => a.startsWith('--detector='))?.slice(11);
  const Detector = detPath ? (await import(new URL(detPath, 'file://' + process.cwd() + '/').href)).ActionDetector : ActionDetector;
  let ok = true;
  for (const cfg of [{ noise: 0 }, { noise: 0.005, seed: 3 }, { noise: 0.01, seed: 7 }, { rate: 25, noise: 0.005, seed: 11 }]) {
    const r = runTriggerTest({ loops: 2, ...cfg, Detector });
    console.log(formatTriggerTest(r) + '\n');
    ok &&= r.ok;
  }
  const rb = runRobustness({ Detector, seeds: args.includes('--quick') ? [1] : [1, 2, 3] });
  for (const [name, r] of Object.entries(rb.configs)) {
    if (args.includes('--full')) console.log(formatBench(r, `[${name}] ${JSON.stringify(BENCH_CONFIGS[name])}`) + '\n');
    else console.log(`[${name}] ${JSON.stringify(BENCH_CONFIGS[name])}: ${r.phantomsPer100.toFixed(2)} phantoms/100 moves`);
  }
  console.log('\n' + formatBench(rb.all, 'robustness, all configs'));
  console.log(rb.ok ? '\nrobustness PASS' : '\nrobustness FAIL: ' + rb.fails.join('; '));
  process.exit(ok && rb.ok ? 0 : 1);
}
