# Hero v2 — package contracts (WP0)

Spec: `docs/character-art-spec.md`. Code against this file. If it doesn't cover something, ask WP0. Don't guess, and don't edit the shared files.

## 1. Ownership

| Path (under `web/src/hero/`) | Owner | Notes |
|---|---|---|
| `index.js`, `rig.js`, `dims.js`, `palette.js`, `contracts.js`, `geo/*`, `CONTRACTS.md` | WP0 | shared; change only via a note to WP0 |
| `materials/index.js` (keep the exports), `materials/toon.js`, `outline.js`, `hair.js`, `faceShadow.js`, `characterLight.js` | WP1 | |
| `body/body.js` (keep `buildBody`), `body/loft.js`, `hands.js`, `weights.js`, `detailAtlas.js` | WP2 | |
| `head/head.js` (keep `buildHead`), `head/faceAtlas.js`, `faceRig.js`, `head/hair.js` (keep `buildHair`) | WP3 | |
| `costume/index.js` (keep `buildCostume`), `costume/sdf.js`, `shirt.js`, `shorts.js`, `accessories.js` | WP4 | |
| `dynamics/*` | WP5 | |
| `web/src/main.js`, `character-preview.*`, `web/src/render/*` | WP6 | |

Rules:
- Only edit files you own. If you need a change in a shared file (a new bone, a dims value, an attribute, a ctx field, a facade hook), write a note to WP0. Put it at the top of your entry file as `// REQUEST(WP0): ...`, or send it directly.
- `retarget.js`, `tests.js`, `actions.js` and `main.js` stay unmodified. Never touch `server/`, `vendor/` or the tracking code.
- Take every number from `dims.js` and every colour from `palette.js`. No magic numbers.
- `character.js` is a re-export of `hero/index.js`. `character_v1.js` is the frozen v1, kept for comparison only (`character-preview.html?v=1`).

## 2. Coordinates

- Units are metres. Y is up and the character faces **+Z**. The character's **left is +X**. The rest pose is a T-pose.
- Feet sit on y = 0, the lowest sole point (`dims.SOLE_Y`). `headTop` is at 1.75.
- Every bone has an **identity rest rotation** and unit scale, so a bone's local axes equal root axes at rest. Arm bones point along ±X, leg bones along −Y and the foot→toe along +Z/−Y.
- All geometry is authored in **root-space rest coordinates** (the world coordinates when the root is at the origin). Never author geometry in bone-local space.

## 3. Bones (`rig.js`)

`hero.bones` contains exactly 19 contract bones and 5 markers, all `THREE.Bone`. Only the retargeter or the preview writes them, and it writes them **before** `hero.update()`.

| Bone | Parent | Rest world position |
|---|---|---|
| hips | root | (0, 0.920, 0) |
| spine | hips | (0, 1.020, 0) |
| chest | spine | (0, 1.230, 0) |
| neck | chest | (0, 1.420, 0) |
| head | neck | (0, 1.495, 0) |
| *headTop* (marker) | head | (0, 1.750, 0) |
| left/rightShoulder | chest | (±0.045, 1.355, 0) |
| left/rightUpperArm | Shoulder | (±0.165, 1.355, 0) (QA r1: was 0.175, see `dims.SHOULDER_DECISION`) |
| left/rightForeArm | UpperArm | (±0.440, 1.355, 0) |
| left/rightHand | ForeArm | (±0.690, 1.355, 0) |
| *left/rightHandTip* (marker) | Hand | (±0.865, 1.355, 0) |
| left/rightThigh | hips | (±0.088, 0.865, 0) |
| left/rightShin | Thigh | (±0.088, 0.465, 0) |
| left/rightFoot | Shin | (±0.088, 0.070, 0) (ankle) |
| *left/rightToe* (marker) | Foot | (±0.088, 0.015, 0.170) |

The same table is in `dims.JOINT_WORLD`. The local offsets are in `dims.JOINT_OFFSETS`, and `rig.restWorld[name]` gives each one as a Vector3. Markers are **not** in the skeleton, so never skin to them.

**Helper bones** live in `hero.helpers` / `rig.helpers`. They are never in `hero.bones` and the retargeter never writes them.

| Helper | Parent | Local offset | Driver |
|---|---|---|---|
| left/rightUpperArmTwist | UpperArm | (±0.110, 0, 0) (40%) | `rig.updateHelpers()`: cancels 50% of the upper-arm twist about local X |
| left/rightForeArmTwist | ForeArm | (±0.125, 0, 0) (50%) | `updateHelpers`: 50% of the hand twist about local X |
| left/rightElbowHelper | UpperArm | (±0.275, 0, 0) (elbow pivot) | `updateHelpers`: slerp(identity, foreArm.q, 0.5) |
| left/rightKneeHelper | Thigh | (0, −0.400, 0) (knee pivot) | `updateHelpers`: slerp(identity, shin.q, 0.5) |
| left/rightHipHelper | hips | (±0.088, −0.055, 0) | `updateHelpers`: slerp(identity, thigh.q, 0.5) |
| shirtHemL / shirtHemR / shirtHemBack | spine | (±0.13, −0.06, 0.03) / (0, −0.06, −0.09) | WP5 springs (identity until then) |
| sleeveCuffL / sleeveCuffR | ForeArm | (0, 0, 0) (elbow pivot) | WP5 |
| hairBangs / hairL / hairR / hairBack | head | (0, .17, .085) / (±.095, .15, .01) / (0, .14, −.09) | WP5 |

**Skeleton.** There is one `rig.skeleton` (38 bones) shared by every SkinnedMesh. The index order is `rig.boneOrder` (`SKELETON_BONES`): the 19 contract bones in table order (0..18), then the helpers in the order listed above (19..37). Always resolve indices by name with `rig.boneIndex[name]`. Never hard-code them. The bone budget is 48, so ask WP0 for new bones.

## 4. Geometry attributes (`geo/attributes.js`)

| Attribute | Type | Meaning |
|---|---|---|
| position, normal, uv | vec3, vec3, vec2 | root-space rest |
| outlineNormal | vec3 | smoothed normal for the hull (`computeOutlineNormals`) |
| matId | float | palette column, `palette.MAT.*` |
| shadeBias | float [−0.5, 0.5] | −0.3 in creases (armpit, under chin, sash and collar, inner thigh, inside sleeves); +0.15 on forehead and nose bridge |
| outlineWidth | float | hull multiplier (`dims.OUTLINE.width`): 1 default, 0.6 fingers and fur, 0.4 hair tips, 0 face front and eyes |
| skinIndex / skinWeight | Uint16 ×4 / Float32 ×4 | max 4 influences, normalized |
| hair only: tangent, clumpJitter | vec3, float | root→tip direction; per-clump jitter in [0, 1) |
| hair only: hairUV | vec2 | x = cosine across the clump section (-1..1 on the outer face; 2 marks the inner face), y = along clump root→tip (0..1); drives the angel-ring dash (materials/hair.js). Never use `uv` for this: `uv` samples the body detail atlas |

`tangent` is a vec3 by spec. Don't use a built-in normal-mapped material on hair, because three expects a vec4 tangent there.

Helpers:
- `ensureCharacterAttributes(geo, { matId, shadeBias, outlineWidth })` fills in any missing attributes and computes `outlineNormal`.
- `computeOutlineNormals(geo, tol)`
- `fillAttribute(geo, name, value, itemSize)`
- `allocSkin(geo)`
- `skinRigid(geo, rig, boneName)`
- `skinToSegments(geo, rig, { segments = rig.segments, bones: [names], power = 6, filter, useRadius })` weights by inverse distance to bone segments. `rig.segments` holds a default `{ bone, a, b, r }` for each deform bone. This is a placeholder-quality weighting; WP2's `weights.js` supersedes it for the body.
- `copySkinFromNearest(target, source)` (for buttons)
- `mergeCharacterGeometries(geos)` needs identical attribute sets on every input, and all inputs indexed or all not.
- `validateCharacterGeometry(geo)`
- `createSkinnedPair(geo, material, outlineMaterial|null, rig, { name })` returns `[mesh, hull]`, both bound.

## 5. Binding to the skeleton

```js
const mesh = new THREE.SkinnedMesh(geo, ctx.materials.body); // geo in root-space rest coords
rig.bind(mesh);   // or use createSkinnedPair(), which does this for the mesh and its hull
```

`rig.bind` makes the mesh a child of `rig.root` with an identity transform. It sets `bindMode = 'attached'`, calls `mesh.bind(rig.skeleton, new Matrix4())` and sets `frustumCulled = false`.

Bone inverses were computed once, at rest, in root space. **Never** call `mesh.bind(skeleton)` without the explicit identity bindMatrix. **Never** call `skeleton.calculateInverses()` or `skeleton.pose()`. Either one would rebake the inverses from a posed rig.

Rigid decals and props may instead be plain `Mesh`es parented to a bone (head-local coordinates = world − bone rest position).

## 6. Materials (`materials/index.js`)

```js
createToonMaterial({ skinned = true, palette, detailAtlas = null, variant: 'body'|'face'|'hair' }) -> Material
createOutlineMaterial({ skinned = true, palette }) -> Material   // BackSide hull, reads outlineNormal/outlineWidth/matId
createSharedMaterials({ palette, detailAtlas }) -> { body, face, hair, outline, update(dt, ctx), setCamera(cam), dispose() }
```

`palette` is the palette module (`ctx.palette`). The colour comes from the per-vertex `matId`, not from a material parameter.

The WP0 stubs are `MeshToonMaterial` / `MeshBasicMaterial` patched through `onBeforeCompile`. They already use matId, outlineNormal and outlineWidth, have `toneMapped: false`, and give a world-space hull of 0.006 m.

WP1 replaces the internals, keeps these signatures and keeps reading the same attributes. The palette texture is `palette.createPaletteTexture()`: 32×8, with rows base, shade, deep, highlight, outline and the rest reserved.

## 7. Builders

Each package exports one builder:

```js
export function buildBody(ctx) | buildHead(ctx) | buildHair(ctx) | buildCostume(ctx)
  -> { meshes: (SkinnedMesh|Mesh)[], update?(dt, ctx), dispose(), api? }
```

`ctx` holds:

| Field | Meaning |
|---|---|
| `rig` | `{ root, bones, helpers, all, skeleton, boneIndex, boneOrder, restWorld, segments, bind, updateHelpers, resetPose }` |
| `dims` | the default export of `dims.js` |
| `palette` | the default export of `palette.js`: `{ MAT, PALETTE, PALETTE_ROWS, FACE_COLORS, color(), createPaletteTexture() }` |
| `materials` | `{ createToonMaterial, createOutlineMaterial, body, face, hair, outline }`. The four are **shared instances**: use them and don't dispose them. `outline` is `null` when outlines are off. |
| `options` | the `createCharacter` options |
| `parts` | results of the builders that already ran (order: body → head → hair → costume) |
| `camera` | the camera, or `null` |
| `dt`, `time` | set each frame |

- Bind skinned meshes with `rig.bind`. `meshes` must list everything you created. The facade adds any parentless mesh to `root`.
- `dispose()` must free every geometry, texture and material **you** created, and detach anything you parented to bones.
- The required APIs are routed by the facade:
  - **head api**: `{ expressions: string[], setExpression(name) -> name, blink(0..1), setMouthOpen(0..1), setGaze(x, y) }`. x and y run from −1 to 1, with +x toward the character's left and +y up. The head also owns auto-blink (2 to 5 s, 0.16 s) and expression smoothing.
  - **body api**: `{ setHandPose('relaxed'|'fist', 'left'|'right'|'both') }`
  - **costume api (for WP5)**: expose the attachment points (the sash knot Object3D, the collider definitions).

The shared vocabulary is in `contracts.js`:
- `EXPRESSIONS`: happy (default), neutral, laugh, surprised, determined, effort, shout, wince. `EXPRESSION_HINTS` maps each one to eye, mouth and brow states.
- `HAND_POSES`
- `ACTION_PRESETS`: the `setAction` names from `actions.js` plus `success`, `miss`, `combo` and `idle`.

## 8. Frame order (`hero.update(dt, time)`)

1. The retargeter has already written `hero.bones`.
2. The action timer runs.
3. `rig.updateHelpers()` runs, then `root.updateMatrixWorld(true)`.
4. Each part's `update(dt, ctx)` runs in build order (WP5 dynamics will be called from here).
5. `materials.update(dt, ctx)` runs.

`dt` is clamped to [0, 0.1].

## 9. Facade API (`hero/index.js`)

v1 API: `root, bones, setExpression, blink, setMouthOpen, update(dt, t), dispose, info`.

v2 additions: `setGaze(x, y)`, `setHandPose(pose, side)`, `setAction(name)`, `setCamera(camera)`, `rig`, `helpers`, `skeleton`, `parts`.

`info` contains: `height` 1.75, `upperArm`, `foreArm`, `hand`, `thigh`, `shin`, `footHeight`, `shoulderWidth` 0.33 (QA r1), `hipWidth` 0.176, `expressions`, `handPoses`, `actions`.

`createCharacter` options: `{ outline, castShadow, expression, parts: ['body','head','hair','costume'], builders: { key: fn }, camera, dynamics }`.

**Async build (QA r1 P0-2).** `createCharacterAsync(options)` (import from `hero/index.js`) returns a Promise of the hero. `options.onShell(hero)` runs synchronously before the first yield: `bones`/`root` already exist, so the retargeter can be created and `update()` called while the parts build (a capsule placeholder stands in; `update` only runs helpers until ready). Parts build one per task with `yieldToBrowser()` between them; all meshes are swapped in at once when done (`hero.isReady`, `hero.ready`). Expression / hand pose / gaze / camera set while loading are re-applied. The costume uses `buildCostumeAsync(ctx, { yieldToBrowser })` when `costume/index.js` exports it. `hero.buildInfo = { mode, totalMs (wall), maxBlockMs, blocks[], parts{} }`.

**Neck seam (QA r1 P0-11).** `rig.neckSeamWeights(y)` (also exported from `rig.js`) returns `[neck, head]` with head = smoothstep(1.47, 1.55, y). The body neck and the head's seam vertices both use this window. Head yaw is split 40 % neck / 60 % head by the retargeter, and the QA presets do the same.

## 10. Previewing your package in isolation

`http://127.0.0.1:5173/src/character-preview.html`
- `?parts=body` (or `body,costume`, `head,hair`, ...) builds only those packages.
- `?outline=0` turns the outline hulls off.
- `?v=1` loads v1 for comparison.

In the console:
- `checkRig()` reports joint error against the table and any non-identity rest rotations.
- `hero` is the hero object and `B` is its bone map.
- `setMode('t'|'test'|'anim')` and `setView('front'|'side'|'back'|'face'|'far')` change the pose and the camera.

To try a builder that isn't wired in yet: `createCharacter({ parts: ['body'], builders: { body: myBuild } })`.

## Sash tails (QA round 2 update)
The simulated sash tails no longer have their own mesh. Their vertices live inside the merged costume mesh, and dynamics rewrites that vertex range every frame through `api.sash.ribbon` (see the `costume/index.js` header). They share the costume's draw, outline and single shadow draw. `hideStaticTails` is superseded. `createCharacter({ dynamics: false })` shows the same tails as a static drape. Long tail tapers 0.11 → 0.065 (S-bend, geometric folds, ~40° twist at the tip) and the ~0.115 knot overrides spec 2.6. Floor constraint + thigh drape above ~80° hip flexion (dynamics/index.js DRAPE_FLEX).
