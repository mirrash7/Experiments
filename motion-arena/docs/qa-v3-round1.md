# QA v3, round 1: VRM hero (Sakurada Fumiriya) + new render stack + motion pipeline

Reviewed 2026-11-25 by the art director / QA lead. Captures come from headless Chrome over CDP at 1440×900, DSF 1, Metal ANGLE, with Vite on :5173 and InstantHMR on :8791. Key evidence images are in `docs/qa-v3-round1/`.

Bar: a stylised anime hero that a publisher would accept for a vertical slice. That means Genshin / Star Rail polish adapted to a webcam browser game.

## Verdict

**Not at the publisher bar. Overall 4.6 / 10.** This is a big step up from the procedural hero. The face, eyes and topology are professional, the pipeline is fast, and the feet are planted. Three problems would still get it rejected:

1. **Our tuning damages the authored colours.** The hair becomes coral/salmon with an orange streak and a neon-violet nape. The authored look is a muted ash-pink "milk tea" with lavender shade.
2. **Combat poses don't read.** Punches land with open, flat palms and wrists bent back about 90°. The guard stance clasps the hands like a prayer, and the kick reads as a knee raise.
3. **The hero is a generic VRoid schoolboy.** He is 1.91 m tall and lanky, with no silhouette hook, signature colour or costume story. Even with perfect rendering he looks like a VTuber sample, not a game hero.

Fixes 1 and 2 are cheap: about a day of work, and the files that own them are named below. Fix 3 needs the custom model (PLAN path A).

## Scored rubric

| Area | Score | Notes |
|---|---|---|
| Character appeal | **4** | Clean VRoid base, but a plain school uniform with a navy/black mass and no accent shape or prop. Lanky at 1.91 m. Reads as a "default avatar". |
| Face | **6** | Good eyes and lashes, and the authored expressions work (a smile shows on jump). The face shading is flat: there is no SDF face shadow, and the toony 0.9 terminator gives hard blotches on the cheek at 3/4. Neutral resting expression. |
| Hair | **3** | Nice cut and ahoge. The colour has shifted to saturated coral. A hard orange shade band runs down the right bangs, and the nape is neon violet from behind. There is no spec band (angel ring). |
| Costume | **4** | The authored textures are fine, but the outfit has no design intent for a fighting game. Under the black outlines the trousers read as a black slab with warm glossy streaks. |
| Shading / colour fidelity | **3** | The MToon pass overrides authored values: toony 0.05–0.35 becomes 0.9, shift goes to −0.31, the hair shade colour is replaced, and the hair shade texture is replaced. On top of that come a warm key, a warm ground fill and a saturation-1.1 grade. The result drifts well away from the authored look (see the hair comparison). |
| Outlines / rim | **5** | The screen-space width is stable. The neutral near-black outline is heavier and colder than the authored maroon (#8d465a), and inner forms on dark cloth get lost. A thin pale halo sits inside the outline on dark fabric. |
| Lighting | **5** | The camera-locked key keeps the face lit from every view, which is good. But the key (#fff3e6), the hemisphere ground (#f0cfa8) and the grade highlight tint (#fff8ee) all push warm, which turns skin and hair orange. There is no back or separation light against the warm deck. |
| Secondary motion | **5** | The hair and ahoge bounce believably on jumps, and no hair or tie clipping showed up in the captured punches or jumps (limited coverage). The short hair gives little secondary motion. The tie barely moves. |
| Motion quality | **5** | See the breakdown below. |
| – responsiveness | 7 | Motion lag: MediaPipe 44 ms, synthetic 48 ms (100 ms in one hands-up window), InstantHMR p50 44 / p95 74 ms. |
| – smoothness | 6 | Jitter out/raw: HMR 0.71/1.33 (good), MediaPipe 0.10/0.12. Synthetic is 2.15/2.30 overall, and **4.27/1.97 during hands-up: the prediction stage amplified the noise.** |
| – foot contact | 7 | Skate is 0 cm/s after the lock on every source. But the squat and lean read as stiff diagonal "plank" legs with the knees going sideways. |
| – punch / kick / jump readability | 3 | Open palms on punches, wrists bent back, clasped guard, kick reads as a knee raise. The jump reads fine. |
| Game presentation | **5** | The hero is 58 % of viewport height with no HUD overlap. But the side panels cover about 37 % of the width during play. The warm arena matches the warm hero, so the hero doesn't pop. Action floaters ("LEFT KICK!") sit above the head and drift off the top edge. |
| Performance | **8** | 60 fps (vsync-capped) on the High preset at DPR 1. The hero costs 0.1–0.4 ms. About 120 draws and 170k triangles, of which the hero is 28 draws, 10 outline draws and 39.5k triangles. The motion solve is about 0.1 ms and the update 0.15–0.3 ms. |

## Suspicions checked

| # | Suspicion | Finding |
|---|---|---|
| a | Hair is coral in game but darker in the plain test page | **Confirmed: we shift it.** In the spike (unlit by our stack) the hair is a light ash-pink/beige with lavender shade. It isn't dark brown: the spike's white sun at intensity π plus ambient 0.6 makes it look brownish in the shaded areas. In the game it is saturated salmon. Root cause is in `mtoonTuning.js`, hair branch: `shade.setHSL(h, s*1.1+0.05, l*0.62)` is computed from `m.color`, which is a pale peach *tint* (#fcddcf), not the hair colour. The result is shade **#fe7e06 (pure orange)** in place of the authored **#aa95cb (lavender)**, and `shadeMultiplyTexture` is replaced by the lit map. A/B test: restoring the authored shade colours removes the orange streak and brings back the lavender shading (`qa-v3-round1/cmp_face.png`, middle panel). The remaining warmth comes from the warm key/fill and the grade: with saturation and contrast at 1.0 it gets closer again (right panel). |
| b | White halo around the silhouette | **Partly confirmed.** At 1× it shows as a thin beige/pale line just inside the outline on the dark trousers and vest (`cmp_edge.png`, panel 1). It is mainly the parametric rim: #b0aca6, mix 0.8, fresnel power 4, **lift 0.04**. The residual matcap at 0.18 adds to it. It goes from bright to faint when the rim is zeroed (panel 2) and fades further with matcap 0 (panel 3). It is not a compositing seam: with outlines off (panel 4) the edge is clean. |
| c | Reduced "sphere add" matcap: skin and cloth highlights | Skin now has no highlight at all, so arms and cheeks read flat and slightly plastic. Cloth keeps warm glossy streaks on the trousers, partly from the authored texture. Recommendation: matcap 0 on dark CLOTH. On skin, use a proper rim from the lit side, not the matcap. On hair, replace the matcap "sheen" with a real spec band. |
| d | Spring-bone hair / tie clipping | **Not observed** in the captured punches, crossed-arm guards and jumps from Front/Side/Behind. The colliders are added (head, chest capsule, upper arms; 38 joints). Coverage is limited, so re-check with InstantHMR on fast arm-overhead moves. |
| e | Hand poses / thumbs | **Fails.** Relaxed hands read as flat paddles: curls are 0.2–0.45 rad and the thumb lies straight alongside the index (`hand_r.png`). Punch frames show **open palms with the wrist bent back about 90°** (`mont_torso.png`, top row and bottom-left), and the idle/squat hands sit palm-up like a tray. No fist was visible in any captured punch frame. |
| f | Jitter and motion feel per source | InstantHMR is smooth (jitter halved) and planted, with p95 latency of 74 ms. MediaPipe is the smoothest and has the lowest lag. **Synthetic: the prediction stage raised the jitter above raw (4.27 vs 1.97 rad/s) and the motion lag to 100 ms during hands-up.** The fake-camera GIF barely moves, so it fired no actions in 8 s and can't test the triggers. |

## Defects

### P0: blocks showing the hero to anyone

| ID | View / pose / source | What's wrong | Fix | Owner |
|---|---|---|---|---|
| P0-1 | Any view, idle, close-up face and back of head | Hair colour has shifted to coral with an orange streak in the shade; the authored ash-pink with lavender shade is lost | In the hair branch, **keep the authored `shadeColorFactor` and `shadeMultiplyTexture`**. If the VRoid violet must be tamed, lerp the authored shade 30–40 % toward a darker, *desaturated* version of the texture's mean colour, never toward `m.color` (it's a tint). Cap shade saturation at the lit saturation. | `web/src/vrm/mtoonTuning.js` |
| P0-2 | Any view, everything warm | Key #fff3e6, hemisphere ground #f0cfa8 and grade highlight #fff8ee with saturation 1.1 all stack warm, so skin and hair go orange | Set the key to neutral white (#fffaf5 at most) and the hemisphere ground to a neutral grey-beige (#d9d3cc). Apply the AnimeGrade to the world only, or run saturation 1.0 / contrast 1.0 on the hero. Then compare against a neutral-light reference render of the authored materials. | `web/src/render/heroLights.js`, `web/src/render/post.js` |
| P0-3 | Front / Side / Orbit, synthetic punches (and any source's punch accent) | Punches show open flat palms with the wrist hyper-extended about 90°. No fist reads. | Hold `override='fist'` for the whole accent plus 150 ms with a faster blend in (tau about 0.04). Add **wrist limits** (flexion/extension ±45°, deviation ±25°) alongside the elbow/knee hinges. During a punch, align the wrist with the forearm (fist straight). Raise the relaxed curls to 0.35–0.7 rad and add thumb opposition (Y −0.5, Z 0.3). | `web/src/motion/hands.js`, `web/src/motion/layers.js`, `web/src/motion/ik.js` |

### P1: must fix before the next review

| ID | View / pose / source | What's wrong | Fix | Owner |
|---|---|---|---|---|
| P1-1 | Behind / Orbit-back, idle | Neon-violet nape: the HairBack and Hair_02 authored tint #bb83da multiplied by the lit map, plus saturation, reads as a purple patch | Desaturate the HairBack tint 50 % toward the main hair hue, or darken it to a lavender-grey under-layer | `mtoonTuning.js` |
| P1-2 | Front full body, dark cloth | Pale inner halo along the silhouette | Rim lift 0, fresnel power 5–6, mix 1.0, colour ≤ #2a2622 on cloth. Mask the rim to the lit side (N·L) or drop it on dark CLOTH. Matcap 0 on CLOTH. | `mtoonTuning.js` |
| P1-3 | All, toon terminator | Toony is forced to 0.9 and shift to −0.31 over authored values of 0.05–0.35, which gives hard, blotchy shade bands across hair strands and the cheek at 3/4 | Start from the authored toony and shift values. Raise toony only to about 0.7 on hair and cloth. On the face, keep the shift slightly positive until the SDF face shadow lands. | `mtoonTuning.js` |
| P1-4 | Mid-distance, all | Outlines are a cold neutral near-black and heavy (2.6 px). They flatten the navy/black uniform and fight the authored warm-maroon line. | Skin outline uses the authored #8d465a. Hair outline is hue-tinted at about 25 % lightness. Body width 0.0045, face 0.0035. Keep the authored "no outline" on hair fringe tips, or thin them. | `mtoonTuning.js` (`OUTLINE_WIDTH`) |
| P1-5 | Front, synthetic squat / lean | Legs go straight and diagonal like "planks", and the knees bend sideways in the squat | Take the knee pole from the tracked knee direction, blended toward the hero's forward direction, with a minimum knee bend when the pelvis drops. Allow the pelvis to shift laterally over the stance foot on a lean instead of tilting the rigid legs. | `web/src/motion/ik.js`, `web/src/motion/layers.js` |
| P1-6 | Front, synthetic hands-up | Prediction amplifies noise: jitter out 4.27 vs raw 1.97 rad/s, and motion lag rose to 100 ms | Lower the predictor gain when the joint's angular acceleration noise is high. Clamp the horizon to 40 ms for the hands and arms when overhead. Add a regression check in `lab.measure()`: out ≤ raw. | `web/src/motion/track.js`, `web/src/motion/metrics.js` |
| P1-7 | Side, synthetic kick / guard | The guard clasps both hands together at the chin like a prayer, and the kick reads as a knee raise with no extension | Base stance `guard` should use separated fists (about 25 cm apart, at chin height). The kick accent needs chamber → extension (knee then shin snap) → retract, with a hip pivot and the torso leaning back. | `web/src/motion/layers.js` |
| P1-8 | All | Character appeal: a generic VRoid schoolboy, 1.91 m and lanky | Proceed with PLAN path A: a custom VRoid hero with a signature silhouette, one accent colour and a game costume. Interim: Seed-san or another more stylised licence-clear model as an A/B. | `docs/character-art-spec.md`, `web/src/vrm/models.js` |

### P2: polish

| ID | Where | Issue | Fix | Owner |
|---|---|---|---|---|
| P2-1 | HUD during play | Side panels cover about 37 % of the width | Auto-collapse the setup and metrics panels after Start, with a small toggle | `web/index.html`, `web/src/style.css`, `web/src/main.js` |
| P2-2 | Floaters | "LEFT KICK!" / "RIGHT PUNCH!" drift off the top edge, and in Behind view they overlap the head | Anchor floaters beside the hero's shoulder in screen space and clamp them to the viewport | `web/src/main.js` |
| P2-3 | Arena vs hero | Warm hero on a warm deck: low figure–ground contrast | Add a cool back/rim light in the hero scene (from behind the camera's right, #bcd4ff, low intensity), plus a slightly darker deck tone around the hero ring | `heroLights.js` |
| P2-4 | Skin | Flat skin with no highlight after the matcap cut | Add a lit-side rim on skin (warm, power 3, masked by N·L) and a subtle nose/lip spec | `mtoonTuning.js` |
| P2-5 | Idle, squat | Palms face up (a "tray" hand) | Hand base orientation: palms toward the thighs in idle, fists in guard | `hands.js`, `layers.js` |
| P2-6 | Test page | `vrm-spike.html` raises the arms (wrong sign for 0.x), so it can't be used for colour A/B at rest | Use `±1.15` with `VRMUtils` 0.x sign handling, and add a neutral-light preset matching the game's key angle | `web/vrm-spike.html` |
| P2-7 | Console | `favicon.ico` 404 | Add a favicon | `web/public/` |

## The 3–5 highest-leverage improvements for appeal

1. **A custom hero with a silhouette** (PLAN path A). A memorable shape (asymmetric jacket, sash tail, a gloved hand), one accent colour, 1.6–1.7 m stylised proportions, and layered hair with real spring chains. No render tweak will make a stock schoolboy feel like a game hero.
2. **A colour pipeline that respects the authored look, plus two signature shaders.** Fix P0-1, P0-2 and P1-3 first. Then add an **SDF face shadow**: port `web/src/hero/materials/faceShadow.js` from the procedural hero and bake a map per model. Add a **hair spec band** (anisotropic angel ring on the High preset). These three effects are most of what makes Genshin / Star Rail faces look premium.
3. **Combat readability and juice.** Fists, wrist limits, a punch accent with an impact frame, **hit-stop of 50–80 ms**, light camera shake, slash/punch trails, hit sparks and landing dust. Readable, juicy hits matter more to players than any shading term.
4. **Idle and stance personality.** A fighting-stance base with breathing, weight shifts and occasional glances or blinks. Expressions tied to actions: determined on a punch, a grin on scoring, surprise on a near-miss. The authored VRM expressions already exist, so they only need wiring.
5. **Presentation pass.** Collapse the HUD during play, frame the hero at 65–70 % of viewport height, and add a cool back light for separation from the warm arena.

## Reproduction

- Colour A/B: in the game console, set the hair materials' `shadeColorFactor` to the authored values (#aa95cb for Hair_01, #848aca for Hair_02 and HairBack), then set `post.effects.grade.uniforms.get('saturation').value = 1`.
- Halo A/B: zero `parametricRimColorFactor` on every MToon material, then `matcapFactor` on everything except EYE/FACE materials.
- Metrics: use the `T.run(kind, warm, ms)` helper from the scratchpad (`integ/helper.js`). Numbers above come from 8 s windows after 3–8 s warm-up, with `?fakecam=1` for HMR and MediaPipe.
