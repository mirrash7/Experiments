// Song sequencer: bar-line song switching, intensity layers, overdrive sweep, fades.
// Driven step by step (16th notes) by the realtime scheduler in index.js or by renderOffline().

import { BEAT, STEP } from './engine.js';
import { SONGS } from './songs.js';

export function createSequencer(G) {
  const st = { inten: 0.5, od: false };
  let song = null;
  let pending = null; // { id, step, startStep }
  let pendingOd = null;
  let baseCut = 20000;
  const retired = []; // { song, at }
  let markerDest = null;

  function retire(s, t, tc) {
    s.end(t, tc);
    retired.push({ song: s, at: t + tc * 10 + 0.3 });
  }

  function sweep(t, on) {
    const f = G.mFilter.frequency, q = G.mFilter.Q;
    if (on) {
      f.setTargetAtTime(420, t, 0.01);
      f.setTargetAtTime(baseCut, t + 0.09, BEAT * 0.9);
      q.setTargetAtTime(10, t, 0.01);
      q.setTargetAtTime(0.7, t + BEAT * 2, BEAT * 0.8);
    } else {
      f.setTargetAtTime(900, t, BEAT * 0.12);
      f.setTargetAtTime(baseCut, t + BEAT, BEAT * 0.5);
      q.setTargetAtTime(5, t, 0.05);
      q.setTargetAtTime(0.7, t + BEAT * 1.5, 0.25);
    }
  }

  function step(n, t) {
    if (n % 16 === 0 && pending && n >= pending.step) {
      if (song) retire(song, t, 0.025);
      const S = SONGS[pending.id];
      song = new S(G, pending.id, pending.startStep, st);
      song.start(t, st);
      baseCut = song.cut;
      G.mFilter.frequency.setTargetAtTime(baseCut, t, 0.05);
      const lv = G.songLevel.offset;
      lv.cancelScheduledValues(t);
      lv.setTargetAtTime(1, t, 0.008);
      pending = null;
    }
    if (song && song.stopAt !== null && t >= song.stopAt) { retire(song, t, 0.02); song = null; }
    if (n % 4 === 0 && pendingOd !== null) {
      const on = pendingOd;
      pendingOd = null;
      if (on !== st.od) { st.od = on; sweep(t, on); if (song) song.setOd(t, on); }
    }
    if (song) {
      song.tick(t);
      if ((n - song.startStep) % 16 === 0) song.bar(n, t, st);
      song.step(n, t, st);
    }
    if (markerDest && n % 4 === 0) {
      const m = new ConstantSourceNode(G.ctx, { offset: 1 });
      m.connect(markerDest);
      m.start(t);
      m.stop(t + 0.004);
    }
  }

  return {
    st,
    step,
    get song() { return song ? song.id : null; },
    get songStartStep() { return song ? song.startStep : pending ? pending.startStep : null; },
    get pending() { return pending; },
    request(id, switchStep, startBeat = 0) {
      if (!SONGS[id]) throw new Error(`unknown song '${id}'`);
      if (song && song.id === id && song.stopAt === null && !pending) return null;
      pending = { id, step: switchStep, startStep: switchStep - Math.round(startBeat * 4) };
      return pending;
    },
    stop(t, fadeS) {
      pending = null;
      if (!song) return;
      const lv = G.songLevel.offset;
      lv.cancelScheduledValues(t);
      lv.setValueAtTime(lv.value, t);
      lv.linearRampToValueAtTime(0, t + fadeS);
      song.stopAt = t + fadeS;
    },
    setOd(on) { pendingOd = !!on; },
    setMarker(node) { markerDest = node; },
    cleanup(now) {
      for (let i = retired.length - 1; i >= 0; i--) {
        if (retired[i].at < now) { retired[i].song.dispose(); retired.splice(i, 1); }
      }
    },
    disposeAll() {
      if (song) song.dispose();
      for (const r of retired) r.song.dispose();
      retired.length = 0;
      song = null;
    },
  };
}

export { STEP };
