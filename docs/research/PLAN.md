# Hero v3 plan: pro-quality character, motion and rendering

Based on `character-assets.md`, `motion-quality.md` and `anime-rendering.md` in this folder.

## The shift

- **Character:** stop generating the hero in code. Use a professionally modelled, rigged anime character in **VRM 1.0** (the VTuber avatar standard), loaded with `@pixiv/three-vrm` 3.6.0. That gives MToon anime shading, spring-bone hair and cloth physics, expression blendshapes, eye look-at and a standard humanoid skeleton.
- **Spike result (2026-11-25):** a free pixiv sample VRM loads in 206 ms with 36k triangles, 13 meshes, 57 spring joints and 17 expressions, at 0.6 ms per frame (`web/vrm-spike.html`).

## 1. Character creation

| Path | Who does what | Cost | Quality |
|---|---|---|---|
| **A. VRoid Studio (recommended)** | Claude writes an original character sheet. You build the base model in VRoid Studio (free, native macOS GUI, about 2–6 h): face, hair, body, outfit base. Claude then polishes it with headless Blender in a cloud session on `mirrash7/Experiments`: sash with tail, fur cuffs, sandal straps, MToon tuning, spring bones, a custom grin expression, merged materials, VRM 1.0 export. | $0 | Best: clean anime face, real expressions, layered hair physics |
| B. AI image-to-3D (Meshy) | You sign up for Meshy Pro and provide an API key. Claude generates concept art, then the model, then auto-rigs it, then converts it to VRM in cloud Blender. | about $20 for one month | Faster, but weaker face and hair (one fused mesh, baked lighting, no expressions) |

Placeholder until then: the pixiv `VRM1_Constraint_Twist_Sample` (VRM Public License: commercial use and modification allowed, no credit needed).

**IP:** the research recommends changing at least two signature elements on top of the existing rule (no scar, no hat, no name). Options are in `docs/ip-distinctiveness.md`.

## 2. Motion pipeline (replaces `retarget.js`)

1. **Joint rotations, not directions.** Send InstantHMR's MHR pose parameters (Euler joint angles with built-in limb twist and joint limits) and port MHR forward kinematics to JS. Retarget rotations onto the VRM humanoid with a one-time rest-pose offset, then validate the result against InstantHMR's 3D joints. MediaPipe keeps a keypoint solver as its fallback.
2. **Filter once, then predict.** Keep only the server's angle filter. Remove the client one-euro and slerp stages, extrapolate each joint to render time from its capture timestamp (capped at about 60 ms), and follow it with a critically damped "tracking spring".
3. **Feet and hands:** foot contact detection, foot locking and two-bone leg IK (Holden's MIT method), a calibrated floor plane, and two-bone arm IK so punches reach full extension.
4. **Layers:** an authored idle/stance base, then the tracked pose weighted by confidence (fading with hysteresis), then short authored accents on detected actions (punch, kick, jump, landing squash), then IK, look-at and spring bones. When the legs leave the frame, the upper body stays tracked and the lower body goes procedural.
5. **Face (optional):** MediaPipe Face Landmarker in a Worker drives VRM expressions (blink, mouth shapes, happy) and head rotation. Hand states (fist, open, point) come from InstantHMR's hand keypoints.
6. **Gestures** run on a lightly filtered copy of the stream, so they fire earlier.

## 3. Rendering

1. MToon parameter pass, a key light locked to the camera, screen-space outlines, tone mapping and a colour LUT. This is about 70% of the visual gain.
2. Spring-bone tuning (limits, colliders), plus hit-stop, camera shake and impact frames.
3. An SDF face shadow map, baked per model.
4. VFX: slash trails, hit sparks, landing dust and bloom.
5. Hair specular band and depth rim on the High preset. Low/Medium/High presets with automatic down-tuning keep 60 fps alongside tracking.

## 4. Build order

| Phase | Work | Blocked on |
|---|---|---|
| 1 | Swap the game to a VRM hero (placeholder model), rendering stack steps 1–2 | nothing |
| 2 | Motion pipeline: MHR rotations, prediction, foot/arm IK, layering, confidence blending | nothing |
| 3 | Character sheet; you build in VRoid (or Meshy run); cloud Blender polish → final hero | your choice of path A/B |
| 4 | Face shadow map, VFX, hair spec, presets; art-director QA rounds on the real hero | phase 3 |

Phases 1 and 2 can run in parallel now, and phase 3 can run alongside them.
