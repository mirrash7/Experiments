// Hero v2 dimensions: every number from docs/character-art-spec.md section 2, as frozen constants.
// Owner: WP0. Units: metres, radians where noted (angles named *Deg are degrees).
// Frame: rest T-pose, character faces +Z, Y up, feet on y = 0, character's LEFT = +X.
// Do not hard-code these numbers in package code: import them from here so a proportion change is one edit.

const f = (o) => Object.freeze(o);

/** Rest joint offsets, LOCAL to the parent joint (identity rest rotations, so local == world delta). */
export const JOINT_OFFSETS = f({
  hips: [0, 0.920, 0],          // from root (world origin)
  spine: [0, 0.10, 0],
  chest: [0, 0.21, 0],
  neck: [0, 0.19, 0],           // base of neck, clavicle line
  head: [0, 0.075, 0],          // jaw/skull pivot
  headTop: [0, 0.255, 0],       // marker: skull top (hair rises to ~1.79)
  shoulder: [0.045, 0.125, 0],  // from chest; x is mirrored (+left / -right)
  upperArm: [0.120, 0, 0],      // from shoulder (QA r1 shoulder decision: was 0.130, see SHOULDER_DECISION)
  foreArm: [0.275, 0, 0],       // from upperArm (= upper arm length)
  hand: [0.250, 0, 0],          // from foreArm (= forearm length)
  handTip: [0.175, 0, 0],       // marker, from hand (= hand length)
  thigh: [0.088, -0.055, 0],    // from hips
  shin: [0, -0.400, 0],         // from thigh (= thigh length)
  foot: [0, -0.395, 0],         // from shin (= shin length), ankle at y 0.070
  toe: [0, -0.055, 0.170],      // marker, from foot
});

/** Segment lengths (bone origin -> child origin). */
export const LENGTHS = f({
  upperArm: 0.275, foreArm: 0.250, hand: 0.175,
  thigh: 0.400, shin: 0.395, ankleHeight: 0.070, footLength: 0.235,
  clavicle: 0.120, spine: 0.10, chest: 0.21, neck: 0.19, headPivot: 0.075, skull: 0.255,
});

/** Rest WORLD positions (root at origin) of every contract bone and marker. Checked by the rig at build. */
export const JOINT_WORLD = f({
  hips: [0, 0.920, 0], spine: [0, 1.020, 0], chest: [0, 1.230, 0], neck: [0, 1.420, 0], head: [0, 1.495, 0], headTop: [0, 1.750, 0],
  leftShoulder: [0.045, 1.355, 0], leftUpperArm: [0.165, 1.355, 0], leftForeArm: [0.440, 1.355, 0], leftHand: [0.690, 1.355, 0], leftHandTip: [0.865, 1.355, 0],
  rightShoulder: [-0.045, 1.355, 0], rightUpperArm: [-0.165, 1.355, 0], rightForeArm: [-0.440, 1.355, 0], rightHand: [-0.690, 1.355, 0], rightHandTip: [-0.865, 1.355, 0],
  leftThigh: [0.088, 0.865, 0], leftShin: [0.088, 0.465, 0], leftFoot: [0.088, 0.070, 0], leftToe: [0.088, 0.015, 0.170],
  rightThigh: [-0.088, 0.865, 0], rightShin: [-0.088, 0.465, 0], rightFoot: [-0.088, 0.070, 0], rightToe: [-0.088, 0.015, 0.170],
});

export const INFO = f({ height: 1.75, shoulderWidth: 0.33, hipWidth: 0.176 });   // shoulderWidth = 2 x upper-arm joint x

/**
 * QA round 1, P0-6 / B2: shoulder-width decision (WP0, settled).
 * The spec asked for a 0.42 skin shoulder width but also put the upper-arm joint at x 0.175 with a 0.052
 * deltoid radius: 2 x (0.175 + 0.052) = 0.454 before any muscle modulation, and the built body measured
 * ~0.474 arms-down (deltoid cap + joint bulge). Resolution:
 *   - upper-arm (gleno-humeral) joint moved medially 0.010 to x 0.165 (clavicle 0.130 -> 0.120); all arm
 *     joints shift with it, segment lengths are unchanged (retarget uses directions only);
 *   - deltoid radius 0.052 -> 0.048 (upperArm profile rows t 0 / 0.12);
 *   - body traps/arm-root rows follow the joint (body.js reads JOINT_WORLD).
 * Target skin width (deltoid outer, arms down) = 0.435 +/- 0.01, i.e. 2 x (0.165 + 0.048) = 0.426 plus the
 * deltoid cap. The shirt target (0.45 +/- 0.02) is unchanged: the costume shrink-wraps to the new body.
 */
export const SHOULDER_DECISION = f({ jointX: 0.165, deltoidR: 0.048, skinWidthTarget: 0.435, shirtWidthTarget: 0.45 });
export const SOLE_Y = 0;        // lowest point of the character (sandal sole bottom) at rest

/** 2.2 body proportions. Widths are full widths (W), depths full depths (D). */
export const BODY = f({
  visualHead: 0.30, skullHeight: 0.255, chinY: 1.490, skullTopY: 1.745,
  skullDepth: 0.215,
  skullWidth: f({ temples: 0.186, cheeks: 0.170, jaw: 0.138 }),   // QA r1 head refit (head.js HEAD_FIT), h/w 1.25
  neckVisible: f({ front: 0.05, back: 0.09 }), neckRadius: f({ w: 0.044, d: 0.040 }),
  shoulderWidthSkin: 0.435, shoulderWidthShirt: 0.45,
  chest: f({ y: 1.27, w: 0.30, d: 0.19 }),
  waist: f({ y: 1.03, w: 0.245, d: 0.165 }),
  pelvisSkin: f({ y: 0.90, w: 0.29, d: 0.19 }),
  pelvisShorts: f({ w: 0.34, d: 0.23 }),
  crotchY: 0.80, kneeY: 0.465, fingertipsRestY: 0.74,
});

/**
 * 2.2 limb radius profiles. Each row: [t, rWidth, rDepth, centreOffset[x,y,z] (bone-local, metres)].
 * t = 0 at the parent joint, 1 at the child joint. Interpolate with Catmull-Rom.
 * Width axis is the axis perpendicular to the bone in the frontal plane; depth is along Z (arms) / Z (legs).
 */
export const PROFILES = f({
  upperArm: [[0.0, 0.048, 0.048], [0.12, 0.046, 0.046], [0.35, 0.044, 0.046, [0, 0, 0.004]], [0.55, 0.041, 0.042], [0.80, 0.036, 0.037], [1.0, 0.034, 0.034]],
  foreArm: [[0.0, 0.035, 0.034], [0.18, 0.041, 0.036, [0, 0.004, 0]], [0.40, 0.037, 0.032], [0.70, 0.030, 0.025], [0.92, 0.025, 0.019], [1.0, 0.024, 0.018]],
  thigh: [[0.0, 0.085, 0.085], [0.25, 0.078, 0.080], [0.55, 0.068, 0.068], [0.80, 0.056, 0.058], [1.0, 0.050, 0.052]],
  shin: [[0.0, 0.050, 0.052, [0, 0, 0.006]], [0.08, 0.046, 0.048], [0.28, 0.051, 0.055, [0, 0, -0.010]], [0.55, 0.041, 0.042], [0.85, 0.030, 0.031], [1.0, 0.029, 0.030]],
});

export const HAND = f({
  length: 0.175, palm: f({ l: 0.085, w: 0.078, t: 0.026 }),
  fingerLength: 0.090, fingerThickness: [0.016, 0.018], fingerSegments: 3, pinkyScale: 0.8,
  thumb: f({ length: 0.060, rootFromWrist: 0.025, angleDeg: 40 }),  // rooted on +Z side, palm down
  relaxedCurlDeg: [15, 25, 15], minLengthToSkull: 0.69,
});

export const FOOT = f({ length: 0.235, ballWidth: 0.090, heelWidth: 0.060, instepHeight: 0.060, bigToeWidth: 0.022, toes: 5 });

/** 2.3 head shape. */
export const HEAD = f({
  sphereSegments: [56, 44], /* QA r1: head <= 6k tris */ faceClampKnee: 0.02, chinWidth: 0.050, chinWidthAboveChin: 0.012,
  chinForward: 0.008, backBulge: 0.11, noseRidge: 0.007,
  normalProxy: f({ rx: 0.10, ry: 0.13, rz: 0.11, blend: 0.8, frontFraction: 0.6 }),
});

/** 2.4 face layout. H = skull height, W = skull width at eye line; heights measured up from the chin. */
export const FACE = f({
  H: 0.255, W: 0.20,
  eye: f({ centreH: 0.40, spacingW: 0.43, width: 0.040, height: 0.046, irisFrac: 0.80, pupilFrac: 0.45, pupilSurprised: 0.30 }),
  highlight: f({ main: 0.30, secondary: 0.12, gazeShift: 0.10 }),
  lash: f({ outer: 0.0045, inner: 0.0015, flickLength: 0.006, flickDeg: 35 }), lowerLine: f({ fraction: 0.45, width: 0.0012 }),
  scleraLidBand: 0.22,
  brow: f({ lengthOfEye: 0.75, thickInner: 0.0040, thickOuter: 0.0015, centreH: 0.62, innerInset: 0.01 }),
  nose: f({ wedgeHeight: 0.008, tickH: 0.30 }),
  mouth: f({ centreH: 0.17, patchRadiusW: 0.95 }),
  ear: f({ topH: 0.50, bottomH: 0.28, h: 0.062, w: 0.032, d: 0.020, x: 0.098, z: -0.012, tiltBackDeg: 12 }), // x: nominal only, head.js derives the ear x from the skull surface (QA r1)
  blush: f({ w: 0.03, h: 0.012, opacity: 0.35 }),
  blinkDuration: 0.16, autoBlinkInterval: [2, 5],
  // mouth shapes: width as fraction of W, open height in metres
  mouths: f({
    neutral: f({ w: 0.20, h: 0, cornerUp: 0.002 }), smile: f({ w: 0.28, h: 0, cornerUp: 0.006 }),
    grin: f({ w: 0.46, h: 0.030, teeth: 0.008 }), laugh: f({ w: 0.52, h: 0.045 }), surprised: f({ w: 0.12, h: 0.030 }),
    determined: f({ w: 0.38, h: 0.018 }), effort: f({ w: 0.30, h: 0.026 }), shout: f({ w: 0.34, h: 0.050 }),
  }),
  eyeStates: ['open', 'half', 'closed', 'happyClosed', 'surprised', 'determined', 'wince'],
});

/** 2.5 hair. */
export const HAIR = f({
  widthOfSkull: 1.30, topAboveSkull: 0.045, backBehindSkull: 0.05, napeY: 1.48, tips: [7, 9], aspect: [1.2, 1.8], aspectMax: 2.0,
  capOffset: 0.012, hairlineH: f({ front: 0.70, temples: 0.55 }), clumpBury: 0.01,
  clumps: f({ bangs: 7, sidesPerSide: 3, crown: 7, back: 6, total: 26 }),
  bangs: f({ tipH: [0.60, 0.66], longest: 0.075, forwardCurl: 0.006 }),
  crown: f({ whorlYawDeg: 180, whorlElevDeg: 65, upDeg: [20, 40], length: [0.05, 0.08] }),
  clump: f({ aspect: 0.45, taperPow: 1.6, twistDeg: 15, rings: 6, sides: 8 }),
  normalProxyBlend: 0.65,
});

/** 2.6 costume. */
export const SHIRT = f({
  sdfK: 0.04, voxel: 0.012, smoothPasses: 3, innerOffset: -0.006,
  fit: f({ chest: 0.018, waist: 0.030, hem: 0.040 }), shoulderSeamDrop: 0.02,
  opening: f({ collar: 0.035, nipple: 0.090, hem: 0.120, placket: 0.012 }),
  hemTuck: 0.02, skirt: 0.04, backHemExtra: 0.03,
  collar: f({ stand: 0.022, fall: 0.028 }),
  sleeveEndForearmT: 0.24, cuff: f({ r0: 0.050, r1: 0.085, length: 0.085, scallops: 6, ampRadial: 0.010, ampAxial: 0.006, band: 0.010, maxR: 0.085 }),
  cuffWeights: f({ foreArm: 0.7, sleeveCuff: 0.3 }),
  buttons: f({ count: 4, diameter: 0.016, height: 0.005, inset: 0.012, belowCollar: 0.05, aboveSash: 0.05, spacing: 0.065 }),
  detailTex: 512, extraOffsetHighBend: 0.006,
});
export const SASH = f({
  width: 0.075, wraps: 2, foldOffset: 0.012, frontY: 0.935, backY: 0.950, offset: 0.008,
  knot: f({ yawDeg: 50, w: 0.070, h: 0.060, d: 0.030, wing: 0.045, wingDeg: 35 }),
  longTail: f({ length: 0.44, tipY: 0.49, w0: 0.072, w1: 0.060, cutDeg: 12, particles: 8, rings: 16 }),
  shortTail: f({ length: 0.24, w: 0.058, particles: 5 }),
  thickness: 0.006,
});
export const SHORTS = f({ sdfK: 0.05, openingR: 0.105, thighRAtHem: 0.056, hemThighT: 0.78, hemY: 0.555, roll: f({ h: 0.035, proud: 0.008 }) });
export const FUR = f({ lobes: 16, rows: 2, lobeR: [0.018, 0.026], tubeR: 0.022, ringR: 0.112, flareDeg: 8, backSquash: 0.10, outlineScale: 0.6, kneeClearDeg: 120 });
export const SANDAL = f({ sole: 0.016, outlineOffset: 0.010, toeSpringDeg: 6, strapW: 0.018, strapT: 0.004 });

/** 2.8 / 2.10 / 2.11 shading, outline and colour pipeline. */
export const SHADING = f({
  keyLight: f({ leftOfCameraDeg: 35, elevationDeg: 40 }),
  rampFeather: 0.012, deepThreshold: -0.2, deepMix: 0.6,
  shadeBias: f({ crease: -0.3, forehead: 0.15, min: -0.5, max: 0.5 }),
  // QA r1 (WP1 materials pass, P0-12): edge0/edge1 retired. Materials still read local constants; this is the
  // documented single source of truth. backDir = [x, y] screen-space direction of the back rim (Behind cam).
  rim: f({ edge: 0.52, intensity: 0.7, hairIntensity: 0.45, litBias: 0.35, backDir: f([0.8, 0.6]), backEdge: 0.56, backPx: 1.25, backStrength: 0.85 }),
  faceTerminatorLeadDeg: f({ max: 20, fadeToZeroAtDeg: 90 }),   // QA r1 P0-9: face terminator lead, 20 deg max, 0 at 90 deg
  buttonSpec: f({ pow: 80, threshold: 0.5 }), maxFog: 0.15,
  paletteTex: f({ w: 32, h: 4 }), detailAtlas: 1024, faceShadowMap: 512,
  angelRing: f({ band: [0.0, 0.12], heightH: [0.62, 0.82] }),
});
export const OUTLINE = f({
  basePx: 2.2, refHeight: 1080, maxScale: 2, maxWorld: 0.004, closeUpPx: [2.5, 3.5], closeUpFloorPx: 2.6 /* QA r1 P2-1 */, faceSilhouetteRestore: 0.95 /* QA r1 P1-2 */, viewPushBack: 0.0015,
  width: f({ hairTip: 0.4, finger: 0.6, fur: 0.6, sashTail: 0.8, faceFront: 0.0, eyes: 0.0, default: 1.0 }),
});

/** 2.12 secondary motion. */
export const DYNAMICS = f({
  hz: 120, maxSubsteps: 4, velocityEmaMs: 60,
  sash: f({ gravity: 9.8, damping: 0.08, stiffness: 0.9, wind: 0.15, thighR: [0.075, 0.060] }),
  shirtHem: f({ k: 120, d: 12, maxDeg: 18 }), sleeveCuff: f({ k: 160, d: 14, maxDeg: 15 }),
  hair: f({ k: 220, d: 16, maxDeg: 6, bangsMaxDeg: 4 }), furSquash: 0.06,
});

/** 2.13 skin weights. */
export const WEIGHTS = f({ blendWindow: 1.2, smoothPasses: 2, maxInfluences: 4, capRing: 0.3, capHelperWeight: 0.4 });

/** 2.14 presentation, 2.15 budget. */
export const CAMERA = f({ front: f({ pos: [0, 1.30, 4.9], look: [0, 0.98, 0], fov: 34 }), heightFrac: [0.58, 0.65], faceMinPx: 80 });
export const BUDGET = f({ drawCalls: 14, shadowDrawCalls: 4, tris: 60000, bones: 48, updateMs: 0.4, loadMs: 400,
  tris_by: f({ bodyCloth: 30000, head: 6000, hair: 8000, hands: 6000, fur: 4000, misc: 6000 }) });

const dims = f({ JOINT_OFFSETS, LENGTHS, JOINT_WORLD, INFO, SHOULDER_DECISION, SOLE_Y, BODY, PROFILES, HAND, FOOT, HEAD, FACE, HAIR, SHIRT, SASH, SHORTS, FUR, SANDAL, SHADING, OUTLINE, DYNAMICS, WEIGHTS, CAMERA, BUDGET });
export default dims;
