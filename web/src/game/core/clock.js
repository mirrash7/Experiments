// Game clock: a thin adapter over AUDIO's beat clock (the single source of truth for spawning and judging).
//
// The AudioContext clock does not advance while the context is suspended (no user gesture yet, autoplay policy,
// tab backgrounded). The game must never freeze on that, so while the audio clock is stalled this adapter runs on
// performance.now(), offset so the two timelines join continuously; as soon as the audio clock advances again it is
// used verbatim (and the fallback offset is re-anchored to it every frame).
//
// Beats: CORE's grid is beat = clock.beat() (AUDIO's fractional beat index). timeAtBeat()/beatAt() convert through
// an origin sampled each frame (origin = now - beat * beatDur), so a constant offset between AUDIO's song time and
// its beat index is handled.
export function createGameClock(audio) {
  const ac = () => audio.clock;
  let audioLive = false;
  let lastA = -1, lastAdvancePerf = -1e9;
  let off = -performance.now() / 1000;      // fallback: song = perf/1000 + off
  let origin = 0;                           // song time of beat 0
  let curNow = 0;
  const g = {
    get bpm() { return ac().bpm || 128; },
    get beatDur() { return ac().beatDur || 60 / (ac().bpm || 128); },
    get live() { return audioLive; },
    /** Call once per frame before anything reads the clock. */
    sample() {
      const p = performance.now();
      let a = NaN;
      try { a = ac().now(); } catch { /* audio not ready */ }
      if (Number.isFinite(a) && a !== lastA) { lastA = a; lastAdvancePerf = p; }
      audioLive = Number.isFinite(a) && p - lastAdvancePerf < 250;
      if (audioLive) {
        off = a - p / 1000;
        curNow = a;
        let b = NaN;
        try { b = ac().beat(); } catch { /* ignore */ }
        origin = Number.isFinite(b) ? a - b * g.beatDur : 0;
      } else {
        curNow = p / 1000 + off;
      }
      return curNow;
    },
    now() { return audioLive ? ac().now() : performance.now() / 1000 + off; },
    /** Clock time sampled at the start of this frame (stable for the whole frame). */
    get frameNow() { return curNow; },
    beat() { return (g.now() - origin) / g.beatDur; },
    get frameBeat() { return (curNow - origin) / g.beatDur; },
    beatAt(t) { return (t - origin) / g.beatDur; },
    timeAtBeat(b) { return origin + b * g.beatDur; },
    fromPerf(ms) { return audioLive ? ac().fromPerf(ms) : ms / 1000 + off; },
    toPerf(t) { return audioLive ? ac().toPerf(t) : (t - off) * 1000; },
    /** First bar line (multiple of 4 beats) at or after `minBeatsAhead` beats from now. */
    nextBar(minBeatsAhead = 1) { return Math.ceil((g.frameBeat + minBeatsAhead) / 4) * 4; },
  };
  return g;
}
