// Small CORE-owned overlays that sit inside the UI root and reuse the UI's button look ([data-ui-button] + .bl-btn,
// so the hand cursor drives them): the clear-space check before the first run, and the mouse-only "skip intro"
// button during the Act 0 Awakening. The UI module may replace the space check with ui.screens.space(o) (same
// options); this is the fallback.

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style') Object.assign(e.style, v);
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v);
  }
  for (const k of kids) if (k) e.append(k);
  return e;
}
function button(label, onClick, { id, primary = false, mouseOnly = false, sub = null } = {}) {
  const b = el('button', { class: 'bl-btn' + (primary ? ' is-primary' : ''), 'data-ui-button': id || '', type: 'button' },
    el('span', { class: 'bl-btn-fill' }), el('span', { class: 'bl-btn-label' }, label, sub ? el('small', { text: sub }) : null));
  if (mouseOnly) b.setAttribute('data-ui-mouseonly', '');
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick?.(); });
  return b;
}

const CARD = {
  position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', zIndex: 40, pointerEvents: 'auto',
  width: 'min(620px, calc(100vw - 32px))', padding: '28px 32px 24px', boxSizing: 'border-box', textAlign: 'center',
  background: 'linear-gradient(160deg, rgba(22,14,44,.92), rgba(40,18,58,.92))', border: '1px solid rgba(170,150,255,.45)',
  borderRadius: '14px', boxShadow: '0 20px 60px rgba(0,0,0,.5), 0 0 40px rgba(255,79,216,.18)', color: '#fff',
  fontFamily: "'Chakra Petch', Inter, system-ui, sans-serif",
};

/**
 * Clear-space check: "clear a 2 m x 2 m space", plus a seated-mode toggle. Calls onDone({ seated }) on READY.
 * Returns { node, close() }.
 */
export function spaceCheck(parent, { seated = false, onDone, onSeated } = {}) {
  let isSeated = !!seated;
  const floor = el('div', { style: { margin: '18px auto 10px', width: '170px', height: '120px', position: 'relative', perspective: '400px' } },
    el('div', { style: { position: 'absolute', inset: '0', border: '2px dashed rgba(79,243,255,.8)', borderRadius: '6px', transform: 'rotateX(55deg)', background: 'radial-gradient(circle, rgba(79,243,255,.18), transparent 70%)' } }),
    el('div', { text: '2 m × 2 m', style: { position: 'absolute', left: '0', right: '0', top: '44px', fontWeight: '700', fontSize: '20px', color: '#4ff3ff', letterSpacing: '2px' } }));
  const seatBtn = button('', () => { isSeated = !isSeated; paint(); onSeated?.(isSeated); }, { id: 'space-seated' });
  const paint = () => {
    seatBtn.querySelector('.bl-btn-label').firstChild.textContent = isSeated ? 'SEATED MODE: ON' : 'SEATED MODE: OFF';
    sub.textContent = isSeated
      ? 'Seated: upper-body moves only. Punch, guard, lean to dodge and charge the blast. Keep your arms clear of the desk.'
      : 'You will punch, kick, jump, duck and dodge. Move the furniture, stand about 2 m from the camera, and keep kicks low and clear of the screen.';
  };
  const sub = el('p', { style: { margin: '6px 0 16px', fontSize: '15px', lineHeight: '1.45', color: 'rgba(255,255,255,.82)' } });
  const ready = button('READY', () => { close(); onDone?.({ seated: isSeated }); }, { id: 'space-ready', primary: true, sub: 'my space is clear' });
  const node = el('div', { class: 'bl-space', style: CARD },
    el('div', { text: 'SAFETY FIRST', style: { fontWeight: '600', fontSize: '13px', letterSpacing: '4px', color: '#ffd34f' } }),
    el('h2', { text: 'CLEAR A 2 × 2 m SPACE', style: { margin: '6px 0 0', font: "400 30px 'Dela Gothic One', Inter, sans-serif", letterSpacing: '1px' } }),
    floor, sub,
    el('div', { style: { display: 'flex', gap: '14px', justifyContent: 'center', flexWrap: 'wrap' } }, seatBtn, ready));
  seatBtn.querySelector('.bl-btn-label').prepend(document.createTextNode(''));
  paint();
  parent.append(node);
  function close() { node.remove(); }
  return { node, close };
}

/** Mouse-only "SKIP INTRO" button (bottom-left) while the Awakening runs. Returns { close() }. */
export function skipButton(parent, onSkip) {
  const b = button('SKIP INTRO ▸', () => { close(); onSkip?.(); }, { id: 'awaken-skip', mouseOnly: true });
  const node = el('div', { class: 'bl-awaken-skip', style: { position: 'fixed', left: '24px', bottom: '24px', zIndex: 35, pointerEvents: 'auto', transform: 'scale(.8)', transformOrigin: 'left bottom' } }, b);
  parent.append(node);
  function close() { node.remove(); }
  return { close };
}

/**
 * Fallback letterbox for the results intro replay (used unless the UI sets ui.replayOverlay = true and draws its own
 * from the bus 'replay' events). Returns { progress(p), close() }.
 */
export function letterbox(parent, { label = 'BEST MOMENT', speed = 0.35 } = {}) {
  const bar = (top) => el('div', { style: { position: 'fixed', left: '0', right: '0', [top ? 'top' : 'bottom']: '0', height: '11vh', background: '#05030a', zIndex: 30, transition: 'transform .45s cubic-bezier(.2,.9,.2,1)', transform: `translateY(${top ? '-100%' : '100%'})` } });
  const top = bar(true), bot = bar(false);
  const tag = el('div', { style: { position: 'fixed', left: '4vw', top: 'calc(11vh + 18px)', zIndex: 31, color: '#fff', fontFamily: "'Chakra Petch', Inter, sans-serif", fontWeight: '700', letterSpacing: '4px', fontSize: '18px', textShadow: '0 2px 12px rgba(0,0,0,.6)', opacity: '0', transition: 'opacity .4s' } },
    el('span', { text: '● ', style: { color: '#ff4fd8' } }), `${label} · ${speed}×`);
  const hint = el('div', { text: 'click / Enter to skip', style: { position: 'fixed', right: '4vw', bottom: 'calc(11vh + 14px)', zIndex: 31, color: 'rgba(255,255,255,.55)', fontFamily: 'Inter, sans-serif', fontSize: '13px', letterSpacing: '1px' } });
  const prog = el('div', { style: { position: 'fixed', left: '0', bottom: '0', height: '3px', width: '0', background: 'linear-gradient(90deg,#ff4fd8,#ffd34f)', zIndex: 32 } });
  const node = el('div', { class: 'bl-letterbox', style: { pointerEvents: 'none' } }, top, bot, tag, hint, prog);
  parent.append(node);
  requestAnimationFrame(() => { top.style.transform = 'none'; bot.style.transform = 'none'; tag.style.opacity = '1'; });
  return {
    progress(p) { prog.style.width = `${Math.round(Math.min(1, Math.max(0, p)) * 100)}%`; },
    close() { node.remove(); },
  };
}

/** The CV mirror's canvas as a labelled inset (bottom-right) during the results replay. Returns { close() }. */
export function mirrorInset(parent, canvas, label = 'YOU') {
  const prevParent = canvas.parentNode, prevNext = canvas.nextSibling, prevStyle = canvas.getAttribute('style');
  const box = el('div', { class: 'bl-mirror-inset', style: { position: 'fixed', right: '3vw', bottom: 'calc(11vh + 40px)', width: '22vw', maxWidth: '360px', aspectRatio: '3 / 4', zIndex: 33, pointerEvents: 'none', borderRadius: '10px', overflow: 'hidden', border: '1px solid rgba(79,243,255,.5)', boxShadow: '0 0 30px rgba(255,79,216,.25)', background: 'rgba(5,3,10,.55)' } },
    el('div', { text: label, style: { position: 'absolute', left: '10px', top: '8px', zIndex: 1, color: '#4ff3ff', fontFamily: "'Chakra Petch', Inter, sans-serif", fontWeight: '700', letterSpacing: '3px', fontSize: '13px' } }));
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain';
  box.append(canvas);
  parent.append(box);
  return {
    close() {
      if (prevParent) { if (prevStyle == null) canvas.removeAttribute('style'); else canvas.setAttribute('style', prevStyle); prevParent.insertBefore(canvas, prevNext && prevNext.parentNode === prevParent ? prevNext : null); } else canvas.remove();
      box.remove();
    },
  };
}
