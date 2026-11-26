// Move glyphs (48 x 48, stroke style, front/mirror view: the player's left is screen left) used by HUD prompts,
// the Act 0 "do the move" prompt and the tutorial. moveFromText() maps CORE's prompt strings to a glyph.
const S = (body) => `<svg viewBox="0 0 48 48" class="bl-glyph">${body}</svg>`;
const fig = (arms, legs = '<path d="M24 27 19 43M24 27l5 16"/>', extra = '') =>
  S(`<circle cx="24" cy="7" r="4.2" class="g-head"/><path d="M24 12v15"/>${arms}${legs}${extra}`);

export const GLYPHS = {
  punchLeft: fig('<path d="M24 15 30 20 28 14"/><path d="M24 15h-8l-6-1"/>', undefined, '<circle cx="9" cy="14" r="3.4" class="g-acc"/><path d="M3 9l-2-2M3 14H0M3 19l-2 2" class="g-fx"/>'),
  punchRight: fig('<path d="M24 15 18 20 20 14"/><path d="M24 15h8l6-1"/>', undefined, '<circle cx="39" cy="14" r="3.4" class="g-acc"/><path d="M45 9l2-2M45 14h3M45 19l2 2" class="g-fx"/>'),
  punch: fig('<path d="M24 15h-8l-6-1M24 15h8l6-1"/>', undefined, '<circle cx="9" cy="14" r="3.2" class="g-acc"/><circle cx="39" cy="14" r="3.2" class="g-acc"/>'),
  kickLeft: fig('<path d="M24 15 18 21M24 15l6 6"/>', '<path d="M24 27l5 16M24 27l-8 4-8-2"/>', '<circle cx="7" cy="29" r="3.2" class="g-acc"/>'),
  kickRight: fig('<path d="M24 15 18 21M24 15l6 6"/>', '<path d="M24 27l-5 16M24 27l8 4 8-2"/>', '<circle cx="41" cy="29" r="3.2" class="g-acc"/>'),
  kick: fig('<path d="M24 15 18 21M24 15l6 6"/>', '<path d="M24 27l-5 16M24 27l8 4 8-2"/>', '<circle cx="41" cy="29" r="3.2" class="g-acc"/>'),
  jump: S('<circle cx="24" cy="5" r="4" class="g-head"/><path d="M24 10v13M24 13l-8-6M24 13l8-6M24 23l-6 6 2 6M24 23l6 6-2 6"/><path d="M6 45h36" class="g-acc"/><path d="M24 38v5M20 40l4 4 4-4" class="g-fx"/>'),
  duck: S('<circle cx="24" cy="20" r="4" class="g-head"/><path d="M24 25v9M24 28l-7 3 4 4M24 28l7 3-4 4M24 34l-8 4 2 6M24 34l8 4-2 6"/><path d="M2 9h44" class="g-acc"/><path d="M24 11v5M20 13l4 4 4-4" class="g-fx"/>'),
  dodgeLeft: S('<g transform="rotate(-18 24 44)"><circle cx="24" cy="7" r="4.2" class="g-head"/><path d="M24 12v15M24 15l-5 6 3-7M24 15l5 6-3-7M24 27l-5 16M24 27l5 16"/></g><path d="M44 12h-9M38 8l-4 4 4 4" class="g-fx"/><circle cx="43" cy="22" r="3" class="g-acc"/>'),
  dodgeRight: S('<g transform="rotate(18 24 44)"><circle cx="24" cy="7" r="4.2" class="g-head"/><path d="M24 12v15M24 15l-5 6 3-7M24 15l5 6-3-7M24 27l-5 16M24 27l5 16"/></g><path d="M4 12h9M10 8l4 4-4 4" class="g-fx"/><circle cx="5" cy="22" r="3" class="g-acc"/>'),
  guard: fig('<path d="M24 15l-6 6 3-11M24 15l6 6-3-11"/>', undefined, '<path d="M10 4q14-6 28 0v14q0 12-14 18-14-6-14-18z" class="g-shield"/>'),
  charge: fig('<path d="M24 15l-5-7 2-7M24 15l5-7-2-7"/>', undefined, '<circle cx="24" cy="1" r="4" class="g-acc g-glow"/>'),
  blast: fig('<path d="M24 15l-3 6 6-3M24 15l3 6-6-3"/>', undefined, '<path d="M30 18l16-6v14z" class="g-acc g-glow"/>'),
  tpose: fig('<path d="M24 15H4M24 15h20"/>'),
};

export const MOVE_NAMES = {
  punchLeft: 'LEFT PUNCH', punchRight: 'RIGHT PUNCH', punch: 'PUNCH', kickLeft: 'LEFT KICK', kickRight: 'RIGHT KICK', kick: 'KICK',
  jump: 'JUMP', duck: 'DUCK', dodgeLeft: 'LEAN LEFT', dodgeRight: 'LEAN RIGHT', guard: 'GUARD', charge: 'HANDS UP · CHARGE', blast: 'PUSH · BLAST', tpose: 'T-POSE',
};
// aliases from the detector / chart vocabulary
const ALIAS = { squat: 'duck', scythe: 'duck', sweep: 'jump', leanLeft: 'dodgeLeft', leanRight: 'dodgeRight', stepLeft: 'dodgeLeft', stepRight: 'dodgeRight',
  handsUp: 'charge', brute: 'guard', core: 'charge', striker: 'punch', crawler: 'kick' };
export const normMove = (m) => (m && (GLYPHS[m] ? m : ALIAS[m])) || null;

/** Best-effort glyph for one of CORE's prompt strings ("DUCK!", "LEAN RIGHT ▶", "HANDS UP — CHARGE!", ...). */
export function moveFromText(t) {
  if (!t) return null;
  const s = String(t).toUpperCase();
  if (/PUNCH\s*×|PUNCH X/.test(s)) return 'punch';
  if (/LEFT PUNCH/.test(s)) return 'punchLeft';
  if (/RIGHT PUNCH/.test(s)) return 'punchRight';
  if (/LEFT KICK/.test(s)) return 'kickLeft';
  if (/RIGHT KICK/.test(s)) return 'kickRight';
  if (/KICK/.test(s)) return 'kick';
  if (/JUMP/.test(s)) return 'jump';
  if (/DUCK|SQUAT/.test(s)) return 'duck';
  if (/LEAN RIGHT|DODGE RIGHT|▶/.test(s)) return 'dodgeRight';
  if (/LEAN LEFT|DODGE LEFT|◀/.test(s)) return 'dodgeLeft';
  if (/GUARD|BLOCK/.test(s)) return 'guard';
  if (/PUSH|BLAST/.test(s)) return 'blast';
  if (/HANDS UP|CHARGE/.test(s)) return 'charge';
  if (/PUNCH/.test(s)) return 'punch';
  return null;
}
