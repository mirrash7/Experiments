// Tiny event emitter shared by every module: bus.on(type, cb) -> off(), bus.emit(type, data).
// Listeners are isolated: a throwing listener is logged and never breaks the game loop.
//
// Events CORE emits (data in braces):
//   'state'    {from, to}                   state machine transition (boot/calibrate/title/tutorial/run/boss/results/pause)
//   'beat'     {beat, bar, downbeat}        every clock beat while a song plays
//   'act'      {act}                        0|1|2|'boss'
//   'spawn'    {note}                       a spirit / hazard entered the field
//   'judge'    {kind, errMs, note, pos}     'perfect'|'great'|'good'|'miss' (pos: world Vector3, reused - copy it)
//   'score'    {score, combo, mult, health, flow, overdrive}
//   'overdrive'{on}
//   'charge'   {level 0..1, charged}        charge-blast build-up
//   'blast'    {origin, dir, target}        Breaklight blast fired
//   'boss'     {phase, hp}                  boss script phase changes
//   'pause' / 'resume'
export function createBus() {
  const map = new Map();
  return {
    on(type, cb) {
      let s = map.get(type);
      if (!s) map.set(type, (s = new Set()));
      s.add(cb);
      return () => s.delete(cb);
    },
    once(type, cb) {
      const off = this.on(type, (d) => { off(); cb(d); });
      return off;
    },
    emit(type, data) {
      const s = map.get(type);
      if (!s) return;
      for (const cb of s) {
        try { cb(data); } catch (e) { console.warn(`[bus] listener for '${type}' threw`, e); }
      }
    },
    clear() { map.clear(); },
  };
}
