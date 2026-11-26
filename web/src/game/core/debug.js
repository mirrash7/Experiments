// ?debug=1 overlay: fps / frame time, state, clock, tracker, spirits, score, and the judge log with timing errors.
const COL = { perfect: '#6ff', great: '#7f7', good: '#fe7', miss: '#f66' };

export function createDebugOverlay() {
  const el = document.createElement('div');
  el.id = 'bl-debug';
  el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:9999;font:11px/1.35 ui-monospace,Menlo,monospace;color:#dfe;'
    + 'background:#0b0d16d0;border:1px solid #fff2;border-radius:6px;padding:6px 8px;pointer-events:none;white-space:pre;min-width:250px';
  document.body.appendChild(el);
  let acc = 0;
  return {
    el,
    update(dt, g) {
      acc += dt;
      if (acc < 0.2) return;
      acc = 0;
      const s = g.snapshot();
      const lines = [
        `fps ${s.fps}  frame ${s.frameMs.toFixed(1)} ms (max ${s.frameMax.toFixed(1)})  ${s.quality}`,
        `state ${s.state}${s.act != null ? ' act ' + s.act : ''}   beat ${s.beat.toFixed(2)}  ${s.clockLive ? 'audio' : 'perf'} clock`,
        `tracker ${s.tracker} ${s.trackFps} fps  lat ${Math.round(s.trackLat)} ms  lost ${s.lostFor.toFixed(1)} s`,
        `spirits live ${s.live} pending ${s.pending}   draws ${s.draws} tris ${(s.tris / 1000).toFixed(0)}k`,
        `score ${s.score}  combo ${s.combo} x${s.mult}  hp ${s.health}  flow ${(s.flow * 100) | 0}%${s.overdrive ? ' OD' : ''}`,
        `mode ${s.mode}  knockdowns ${s.knockdowns}${s.awaken ? `  awaken lag ${s.awaken.offset.toFixed(1)}b${s.awaken.waiting ? ' WAIT ' + s.awaken.waiting : ''}` : ''}${s.boss ? `  boss stage ${s.boss.stage + 1} blasts ${s.boss.blasts} tries ${s.boss.tries}` : ''}`,
        `P/G/g/M ${s.j.perfect}/${s.j.great}/${s.j.good}/${s.j.miss}  mean err ${s.meanErr.toFixed(0)} ms  sd ${s.sdErr.toFixed(0)}`,
        `core ${s.coreMs.toFixed(2)} ms  motion ${s.motionMs.toFixed(2)} ms  charge ${(s.charge * 100) | 0}%`,
        s.bot ? `bot delays ${JSON.stringify(s.bot)}` : '',
        '— judge log —',
      ];
      el.innerHTML = lines.filter(Boolean).join('\n') + '\n' + g.judge.log.map((e) =>
        `<span style="color:${COL[e.kind]}">${e.kind.padEnd(7)}</span> ${(e.type + (e.side !== 'center' ? ' ' + e.side[0].toUpperCase() : '') + (e.react ? ' REACT' : '')).padEnd(13)} ${Number.isFinite(e.errMs) ? (e.errMs >= 0 ? '+' : '') + Math.round(e.errMs) + ' ms' : ''}`).join('\n');
    },
    dispose() { el.remove(); },
  };
}
