# Anime-Style Character Rendering for a three.js Motion Game

Researched 2026-11-25. Target: three.js r170 + Vite, VRM hero via `@pixiv/three-vrm` (MToon), small island arena, 60 fps+ while webcam pose tracking also runs.

Conventions: every factual claim has a source link. Lines marked **Rec:** are our engineering recommendation, not sourced facts. Fan reverse-engineering of shipped games is labelled as such; the studios have published little shader-level detail.

---

## 0. TL;DR

1. **Keep MToon as the base, don't replace it.** It already does a two-tone lit/shade split with a shade colour, adjustable toony edge, rim (fresnel + matcap), outlines (inverted hull), emission and UV scroll ([MToon 1.0 spec](https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_materials_mtoon-1.0/README.md)). It does **not** do SDF face shadows, anisotropic hair highlights, ramp-texture lookup, or screen-space depth rim. Add those as small, targeted shader patches only where they pay off: face first, hair second.
2. **Stay on WebGLRenderer plus pmndrs `postprocessing` for now.** v6.39.6 supports three `>=0.168 <0.188`, so it covers r170 and every release up to the current r187 ([package.json](https://raw.githubusercontent.com/pmndrs/postprocessing/main/package.json), [three.js releases](https://github.com/mrdoob/three.js/releases)). It has SMAA, Bloom/SelectiveBloom, ToneMapping, LUT grading, Vignette, ChromaticAberration and ShockWave ([docs](https://pmndrs.github.io/postprocessing/public/docs/)). The WebGPU/TSL route works (MToonNodeMaterial needs r167+), but its API is still moving: `PostProcessing` was renamed `RenderPipeline` in r183 ([search summary of three.js docs](https://threejs.org/docs/pages/ToonOutlinePassNode.html)).
3. **Outlines:** keep MToon's inverted hull for the character, using `screenCoordinates` mode so width stays the same at any zoom. Add an optional depth+normal post-process edge pass for inner lines and the environment on the High preset ([Omar Shehata, MIT](https://github.com/OmarShehata/webgl-outlines)).
4. **"Alive" factor:** spring bones are already in three-vrm (v3.6.0 adds angle limits), plus procedural squash/stretch, hit-stop, camera shake, and stylised VFX from three.quarks or hand-rolled sprite and trail meshes. Mind the version gate: three.quarks 0.18 needs three `>=0.182` ([package.json](https://raw.githubusercontent.com/Alchemist0823/three.quarks/master/packages/three.quarks/package.json)).
5. **Budget for pose tracking first.** Cap pixel ratio, use one shadow-casting light with a tight frustum, and use a 3-tier quality preset with auto-downgrade (section 5).

---

## 1. Techniques used by top anime games and how they map to WebGL

### 1.1 What the studios have said (primary or press sources)

| Game | Public info | Source |
|---|---|---|
| Guilty Gear Xrd / Strive (Arc System Works) | GDC 2015 talk: data is stored in vertex attributes (normals, vertex colours, UVs) because texture data depends heavily on resolution in close-ups. Inverted hull doesn't work for *inner* lines, so they need other techniques. Lines drawn into textures pixelate up close. Edited vertex normals control shading. | [GDC Vault](https://gdcvault.com/play/1022031/GuiltyGearXrd-s-Art-Style-The), [handout PDF](https://www.ggxrd.com/Motomura_Junya_GuiltyGearXrd.pdf), [ASW line-control deck](https://docswell.com/s/ASW_Academy/5LVY67-GG-Toonline-Eng) |
| Genshin Impact (miHoYo) | GDC 2021 "Crafting an Anime Style Open World" (art pillars, pipeline). Unity Japan talk by Zhenzhong Yi describes a PBR-based stylised pipeline. | [GDC Vault](https://gdcvault.com/play/1027538/-Genshin-Impact-Crafting-an), [Unity Dojo slides](https://www.docswell.com/s/UnityJapan/KWRPQ5-210617-unity-dojo20211mihoyozhenzhongyi) |
| Blue Protocol (Bandai Namco) | CEDEC 2020: outlines drawn as a **post-process** to save model data and normal-editing work. Anime camera effects (gradient overlays, flares) via post-process. CEDEC 2021: deferred PBR base, UE4. | [CGWORLD](https://cgworld.jp/feature/202011-cedec2020-bluep.html), [GameBusiness](https://www.gamebusiness.jp/article/2021/09/13/19051.html) |
| Wuthering Waves (Kuro) | Heavily customised UE4.26, deferred rendering to keep shader variants manageable, character brightness driven by curves to match time-of-day lighting. | [Unreal Engine interview](https://www.unrealengine.com/developer-interviews/exploring-the-post-apocalyptic-charm-of-asg-open-worlds-in-wuthering-waves), [AUTOMATON](https://automaton-media.com/en/column/even-from-a-developers-perspective-wuthering-waves-use-of-unreal-engine-is-borderline-perverse-a-ue4-game-decked-out-in-custom-technology/) |
| Hi-Fi Rush (Tango), useful comparison | GDC 2024 talk on a deferred toon renderer. | [GDC Vault](https://gdcvault.com/play/1034330/3D-Toon-Rendering-in-Hi), [80.lv](https://80.lv/articles/the-making-of-hi-fi-rush-s-3d-toon-rendering-style) |
| HSR / ZZZ | No HoYoverse rendering talk found for these. Only community re-creations exist (e.g. [StarRailNPRShader](https://awesome.ecosyste.ms/projects/github.com%2Fstalomeow%2FStarRailNPRShader), GPL-3.0, archived 2025). | ([search: no talk found](https://gdcvault.com/Content%20Creation/gdc-25/)) |

### 1.2 Technique catalogue

Feasibility column: **MToon** = built in; **Patch** = small shader addition to MToon (onBeforeCompile or fork); **Post** = post-process pass; **Asset** = needs authored textures.

| Technique | What it is | In MToon? | WebGL cost | Sources |
|---|---|---|---|---|
| Two-tone / toon step with shade colour | Lit vs shade colour with controllable edge sharpness and shift | **Yes**: `shadeColorFactor`, `shadeMultiplyTexture`, `shadingShiftFactor`/`shadingShiftTexture`, `shadingToonyFactor` | Free | [MToon 1.0 spec](https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_materials_mtoon-1.0/README.md) |
| Ramp texture (multi-band, per-material rows) | NdotL indexes a 1D/2D gradient; Genshin-style bodies pick a ramp row by material ID in the lightmap alpha, with a two-tier shadow (fan analysis) | **No** (MToon is a single smoothstep between two colours). The shade texture plus shift texture gets ~80% of the look. | Cheap (+1 texture fetch) | [HoyoToon wiki](https://github.com/Melioli/HoyoToon/wiki/Using-the-Genshin-Shader), [juejin analysis](https://juejin.cn/post/7207631397094948920) |
| "ILM"/lightmap texture (spec mask, AO/shadow bias, spec threshold, material ID) | RGBA masks painted per character. Fan docs for Genshin: R = spec/metal, G = painted shadow, B = spec threshold, A = material ID | Partial: `shadingShiftTexture` covers painted shadow bias. `rimMultiplyTexture` and `outlineWidthMultiplyTexture` cover masks. No material ID or spec. | Cheap | [HoyoToon wiki](https://github.com/Melioli/HoyoToon/wiki/Using-the-Genshin-Shader), [GG Xrd handout](https://www.ggxrd.com/Motomura_Junya_GuiltyGearXrd.pdf) |
| SDF face shadow map | A greyscale texture encodes the shadow threshold for light angles 0-180 deg on one side of the face (mirrored for the other). Compare the light's horizontal angle against the head's forward/right vectors to get a clean anime nose/cheek shadow. Needs head forward/right vectors passed as uniforms. | **No** | Very cheap (1 fetch + dot products). Needs one baked texture per face UV layout. | [NoiRC256 URP shader](https://github.com/NoiRC256/URPSimpleGenshinShaders), [NoiRCCC blog](https://noirccc.net/blog/posts/54), [face-shadow bake workflow](https://sydianandrewchen.github.io/projects/3-stylized-facial-shadow-workflow), [ChiliMilk URP_Toon (symmetry caveat)](https://github.com/ChiliMilk/URP_Toon) |
| Face normal fix (cheaper alternative) | Transfer or edit face normals toward a sphere/proxy so MToon's NdotL gives soft, anime-clean face shading. Same idea as GG Xrd's edited normals. | Asset-side; MToon uses whatever normals exist | Free at runtime | [GG Xrd handout](https://www.ggxrd.com/Motomura_Junya_GuiltyGearXrd.pdf) |
| Hair "angel ring" specular | A highlight band painted into the hair texture or a mask, shown only when lit and faded by fresnel. Optionally shifted along tangent/UV-V by view direction (Kajiya-Kay-like). | Partial: matcap (`matcapTexture`) can fake a view-dependent ring. MToon has no tangent-shift spec. | Cheap | [bjayers Genshin NPR blog](https://bjayers.artstation.com/blog/category/5), [Adrian Mendez breakdown](https://adrianmendez.artstation.com/projects/wJZ4Gg), [MToon spec (matcap)](https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_materials_mtoon-1.0/README.md) |
| Fresnel rim | View-angle rim colour | **Yes**: `parametricRimColorFactor`, `parametricRimFresnelPowerFactor`, `parametricRimLiftFactor`, `rimMultiplyTexture`, `rimLightingMixFactor` (three-vrm respects mix factor since v3.5.0) | Free | [MToon spec](https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_materials_mtoon-1.0/README.md), [three-vrm releases](https://github.com/pixiv/three-vrm/releases) |
| Screen-space depth-offset rim | Sample the depth buffer offset along the light/normal direction in screen space. Where the background is much farther, draw a constant-width rim. Gives the crisp, uniform-width rim seen in HoYo games. | **No** | Needs a depth pre-pass or depth texture (pmndrs `DepthPass`/`NormalPass`), plus a material patch or a post pass | [Unity CN toon tricks deck ("Depth Offset Rim Light")](https://plastichub.unity.cn/unity-tech-cn/UnityDa-Ka-Zuo-Ke-Qia-Tong-Xuan-Ran-Zhuan-Chang-PPT-Fen-Xiang/raw/branch/main...%e5%8d%a1%e9%80%9a%e6%b8%b2%e6%9f%93/%e8%b5%b0%e8%bf%91%e5%8d%a1%e9%80%9a%e6%b8%b2%e6%9f%93-%e5%85%b3%e4%ba%8eTrick%e7%9a%84%e4%b8%a4%e4%b8%89%e4%ba%8b%20%e9%9b%b7%e5%ae%87%e8%88%aa.pdf), [Bilibili code](https://www.bilibili.com/read/cv11841147), [Blender Studio screen-space rim](https://studio.blender.org/blog/cartoon-character-shading-with-geometry-nodes) |
| Inverted-hull outline | Back-face shell pushed along the normal | **Yes**: `outlineWidthMode` (`worldCoordinates`/`screenCoordinates`), `outlineWidthFactor`, `outlineWidthMultiplyTexture`, `outlineColorFactor`, `outlineLightingMixFactor` | **Doubles draw calls** for each outlined primitive: three-vrm clones the material as `isOutline`, `BackSide` and adds a second geometry group over the same buffer | [MToon spec](https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_materials_mtoon-1.0/README.md), [MToonMaterialLoaderPlugin.ts](https://raw.githubusercontent.com/pixiv/three-vrm/dev/packages/three-vrm-materials-mtoon/src/MToonMaterialLoaderPlugin.ts) |
| Post-process edge detection | Sobel/Roberts on depth + normals (+ surface IDs) finds inner creases and silhouettes for everything in one full-screen pass. Blue Protocol uses PP outlines. | No (post) | One full-screen pass plus a normal/depth buffer. Fill-rate bound, so scale with resolution. | [Omar Shehata article](https://omar-shehata.medium.com/better-outline-rendering-using-surface-ids-with-webgl-e13cdab1fd94), [repo (MIT)](https://github.com/OmarShehata/webgl-outlines), [three.js forum tutorial](https://discourse.threejs.org/t/how-to-render-full-outlines-as-a-post-process-tutorial/22674), [CGWORLD Blue Protocol](https://cgworld.jp/feature/202011-cedec2020-bluep.html) |
| Stockings / tights | Fresnel-driven opacity/darkening (denier effect): skin colour at facing angles, fabric colour at grazing | No, but can be approximated with parametric rim set to a dark colour plus `rimMultiplyTexture` mask. A proper version is a small patch. | Cheap | [juejin analysis (tights ramp)](https://juejin.cn/post/7207631397094948920), [MToon spec](https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_materials_mtoon-1.0/README.md) |
| Emission / glow parts | Emissive map plus bloom | **Yes** (emissive) | Bloom pass | [MToonMaterial API](https://pixiv.github.io/three-vrm/docs/classes/three-vrm-materials-mtoon.MToonMaterial.html) |
| Bloom (selective) | Threshold/luminance or per-object selective bloom | Post | pmndrs `BloomEffect`/`SelectiveBloomEffect`. WebGPU: MRT-tagged selective bloom example. | [pmndrs docs](https://pmndrs.github.io/postprocessing/public/docs/), [three.js webgpu selective bloom](https://threejs.org/examples/webgpu_postprocessing_bloom_selective.html) |
| Colour grading | LUT + tone mapping, vignette, gradient overlays (Blue Protocol "anime camera") | Post | `LUT3DEffect`, `ToneMappingEffect`, `VignetteEffect` | [pmndrs docs](https://pmndrs.github.io/postprocessing/public/docs/), [CGWORLD](https://cgworld.jp/feature/202011-cedec2020-bluep.html) |
| Character lighting rig | Character lit independently of the world (own key direction, clamped intensity, curve-driven brightness to match time of day) | MToon has `giEqualizationFactor` to flatten SH/IBL so ambient doesn't make the face patchy | Free | [MToon spec](https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_materials_mtoon-1.0/README.md), [WuWa interview (JP: curve-driven character brightness)](https://www.unrealengine.com/ja/developer-interviews/exploring-the-post-apocalyptic-charm-of-asg-open-worlds-in-wuthering-waves) |
| Screen-space contact shadows | Short ray-march in depth for contact shadows under chin/hair | No | A full-screen pass. Usually skipped on web; a hand-painted shadow texture plus a blob shadow on the ground is cheaper. | **Rec** (no web-specific source found) |
| UV-scroll effects | Flowing energy on clothes/weapons | **Yes** (`uvAnimation*`) | Free | [MToon spec](https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_materials_mtoon-1.0/README.md) |

**MToon limits to know** ([spec](https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_materials_mtoon-1.0/README.md)):

- It ignores vertex colours by default, so GG-style vertex-colour data isn't usable without a patch (`ignoreVertexColor` default true per the [API](https://pixiv.github.io/three-vrm/docs/classes/three-vrm-materials-mtoon.MToonMaterial.html)).
- UV animation does not affect matcap.
- The spec explicitly does not aim to replicate hand-drawn Japanese animation.

**Rec, priority order of additions:**

1. SDF face shadow, or at least face-normal editing.
2. Screen-space depth rim, or tuned parametric rim on Low.
3. Hair angel ring via matcap, then a real tangent-shift spec on High.
4. Ramp texture for skin/cloth warmth: a warm, saturated shade band at the terminator, as in Genshin-style skin.
5. Stockings fresnel only if the model has them.

---

## 2. three.js specifics

### 2.1 three-vrm / MToon

- **Versions.** `@pixiv/three-vrm` v3.6.0 (released 24 Nov), MIT, peer `three >=0.137` ([package.json](https://raw.githubusercontent.com/pixiv/three-vrm/dev/packages/three-vrm/package.json), [releases](https://github.com/pixiv/three-vrm/releases)). It works with r170. v3.6.0 adds `VRMC_springBone_limit` (angle limits on spring bones), which helps hair and skirts stay out of the body during fast mocap moves ([releases](https://github.com/pixiv/three-vrm/releases)).
- **Material API.** `MToonMaterial` is a ShaderMaterial exposing all spec params as properties, plus `v0CompatShade`, `fog`, `debugMode` ([API docs](https://pixiv.github.io/three-vrm/docs/classes/three-vrm-materials-mtoon.MToonMaterial.html)).
- **WebGPU.** `MToonNodeMaterial` from `@pixiv/three-vrm-materials-mtoon/nodes`, enabled via `materialType` on `MToonMaterialLoaderPlugin`. It requires r167+, and the README warns that compatibility breaks more often ([package README](https://github.com/pixiv/three-vrm/tree/dev/packages/three-vrm-materials-mtoon)).
- **Outline cost.** Each outlined primitive gets a cloned `BackSide` material plus a second geometry group, so its draw calls double ([MToonMaterialLoaderPlugin.ts](https://raw.githubusercontent.com/pixiv/three-vrm/dev/packages/three-vrm-materials-mtoon/src/MToonMaterialLoaderPlugin.ts)). **Rec:** disable outlines on small/hidden primitives (eyes, mouth interior, eyelashes) and use `screenCoordinates` mode.
- **Render order.** The loader sets `mesh.renderOrder` from `transparentWithZWrite` / `renderQueueOffsetNumber` ([source](https://raw.githubusercontent.com/pixiv/three-vrm/dev/packages/three-vrm-materials-mtoon/src/MToonMaterialLoaderPlugin.ts)). Don't override renderOrder blindly, or hair and eyebrow transparency will break.
- **Extending MToon.** For SDF face, hair spec and depth rim, **Rec:**
  - On WebGL: subclass or `onBeforeCompile` the face/hair materials only, injecting into MToon's fragment shader after the shading term. Keep the patch tiny and gate it with a `#define`.
  - On WebGPU: `MToonNodeMaterial` is node-based, so add the term as a TSL node.

### 2.2 Post-processing options

| Option | Status for r170 | Notes |
|---|---|---|
| **pmndrs `postprocessing` 6.39.6** (Zlib) | Supports three `>=0.168 <0.188` ([package.json](https://raw.githubusercontent.com/pmndrs/postprocessing/main/package.json)) | Merges effects into few passes. Has `SMAAEffect`, `FXAAEffect`, `BloomEffect`, `SelectiveBloomEffect`, `ToneMappingEffect`, `LUT3DEffect`, `VignetteEffect`, `ChromaticAberrationEffect`, `OutlineEffect` (selection outline), `ShockWaveEffect`, `NormalPass`, `DepthDownsamplingPass` ([docs](https://pmndrs.github.io/postprocessing/public/docs/)). Supports the six most recent three releases officially ([search summary](https://github.com/pmndrs/postprocessing)). v7 is alpha only. No WebGPU support. |
| three/examples `EffectComposer` | Ships with three | One pass per effect, so more full-screen passes. Fine for prototyping. `OutlineEffect` (toon hull for any material) is WebGL only ([docs](https://threejs.org/docs/pages/OutlineEffect.html)). |
| WebGPU + TSL (`three/webgpu`) | WebGPURenderer falls back to WebGL2 when WebGPU is missing ([manual](https://threejs.org/manual/en/webgpurenderer.html)). Some features (e.g. compute) need native WebGPU ([forum](https://discourse.threejs.org/t/r3f-webgpu-webgl2-fallback-tree-shaking/87188)). | `ToonOutlinePassNode` outlines only `MeshToonMaterial`/`MeshToonNodeMaterial`, **not MToon** ([docs](https://threejs.org/docs/pages/ToonOutlinePassNode.html)). MRT gives normals/emissive/bloom masks in one scene pass ([selective bloom example](https://threejs.org/examples/webgpu_postprocessing_bloom_selective.html)). The pipeline class was renamed `PostProcessing` -> `RenderPipeline` in r183, so expect churn. Official docs still mark it as maturing; blog claims of "production-ready since r171" are third-party ([utsubo](https://www.utsubo.com/blog/webgpu-threejs-migration-guide)). |

**Rec:** use pmndrs on WebGLRenderer now. Re-evaluate WebGPU once the project upgrades past r183 and three.quarks/three-vrm node paths settle.

### 2.3 Anti-aliasing

- With an EffectComposer, the canvas's built-in MSAA (`antialias: true`) doesn't apply to offscreen targets. pmndrs examples set `antialias: false` and do AA in effects ([docs](https://pmndrs.github.io/postprocessing/public/docs/)).
- **Rec, options in order:**
  1. **SMAA**: best quality per cost for toon edges and outlines.
  2. **MSAA on the composer render target** (pmndrs EffectComposer `multisampling` option, clamped by `getSafeSamples`; [docs](https://pmndrs.github.io/postprocessing/public/docs/)). Best for thin inverted-hull lines but costs bandwidth.
  3. **FXAA**: cheapest, softens line art.
- On Retina at DPR 2, SMAA is often unnecessary on High; spend the budget on DPR instead.

### 2.4 Performance

- **Measure.** Track draw calls with `renderer.info.render.calls` (set `info.autoReset=false` if you render multiple times per frame) ([forum](https://discourse.threejs.org/t/where-can-i-see-the-number-of-draw-calls-per-frame/4311/5)). Inspect with Spector.js ([three.js journey](https://www.threejs-journey.com/lessons/performance-tips)). Merge static meshes and instance repeated props ([three.js journey](https://www.threejs-journey.com/lessons/performance-tips)).
- **Compression.**
  - Environment: `gltf-transform optimize in.glb out.glb --compress meshopt --texture-compress ktx2`. At runtime, `GLTFLoader.setMeshoptDecoder(MeshoptDecoder)` plus `KTX2Loader.detectSupport(renderer)` (mandatory) ([guide](https://jvinhit.github.io/blog/threejs-16-gltf-compression-draco-meshopt-ktx2/), [meshoptimizer gltf README](https://raw.githubusercontent.com/zeux/meshoptimizer/master/gltf/README.md)).
  - **VRM caveat:** stock glTF-Transform does not know `VRMC_*` extensions and can lose them. Use [vrm-transform](https://github.com/mrxz/vrm-transform) (VRM 1.0 only, WIP) or register [gltf-transform-vrm-extensions](https://www.pkgstats.com/pkg:gltf-transform-vrm-extensions) before processing ([meshoptimizer discussion](https://github-users.yhajoa.workers.dev/zeux/meshoptimizer/discussions/857)).
- **Rec, sensible defaults (engineering judgement):**
  - Pixel ratio: `renderer.setPixelRatio(Math.min(devicePixelRatio, cap))`, with cap 2 / 1.5 / 1 by preset, plus dynamic resolution scaling driven by frame time.
  - Shadows: one directional light casting shadows for the character (and maybe large props), with a tight orthographic frustum that follows the hero. 1024-2048 PCF map. Static island geometry receives but doesn't cast, or uses baked AO/lightmaps. On Low, skip shadow maps and use a blob/decal shadow under the feet, which reads clearly in anime style anyway.
  - Self-shadowing on the character often looks dirty with toon shading. Many anime renderers rely on painted shadow/ramp instead. Consider `receiveShadow=false` on the face (see the face-map rationale in [NoiRCCC](https://noirccc.net/blog/posts/54)).
  - Textures: character 2K max for body/face atlases on High, 1K on Low. KTX2 (UASTC for face/normal maps, ETC1S for others).
  - Skinned mesh: keep the hero to ~5-15 materials or primitives (each primitive x2 with outline). Avoid morph-target-heavy expressions on Low. Merge accessory meshes in VRoid/Blender.
  - Run MediaPipe in a Web Worker if possible, so detection doesn't stall the render loop. Test both CPU and GPU delegates: GPU isn't always faster (one Apple M1 Pro report saw no difference, in Python) ([MediaPipe issue](https://github.com/google-ai-edge/mediapipe/issues/6041)). The `lite` model is aimed at latency-critical use ([MediaPipe guide](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker?hl=en), [TF blog](https://blog.tensorflow.org/2021/05/high-fidelity-pose-tracking-with-mediapipe-blazepose-and-tfjs.html?hl=fi)).

---

## 3. Animation polish beyond mocap

| Layer | Approach | Library / licence | Source |
|---|---|---|---|
| Secondary motion (hair, skirt, accessories) | VRM spring bones with colliders. Call `vrm.update(deltaTime)` every frame (seconds). v3.6.0 adds angle limits. For scaled models, scale collider radii. | three-vrm (MIT) | [VRMCore docs](https://pixiv.github.io/three-vrm/docs/classes/three-vrm.VRMCore.html), [scaled models doc](https://pixiv.github.io/three-vrm/docs/documents/spring-bones-on-scaled-models.html), [releases](https://github.com/pixiv/three-vrm/releases) |
| Mocap -> VRM solve | Kalidokit (MIT) solves MediaPipe landmarks to VRM bone rotations, but it is **deprecated**. Use it as reference code or write a small solver. | Kalidokit (MIT) | [80.lv](https://80.lv/articles/kalidokit-an-open-source-face-pose-and-hand-tracking-library), [README](https://cdn.jsdelivr.net/gh/yeemachine/kalidokit@main/README.md) |
| Filtering | One-Euro or critically damped spring on landmarks/rotations before retarget, so jitter doesn't look like twitching | Rec | – |
| Squash/stretch, anticipation, follow-through | Procedural: scale the hips/spine bone (or a root wrapper) briefly on jump take-off and landing. Add short anticipation poses blended over mocap at action triggers. Overshoot on hit recoil with a damped spring. | Rec (classic animation principles) | – |
| Hit-stop | Freeze or slow the attacker and target for a few frames on impact; Sakurai describes it as frozen frames that emphasise a hit's power, sometimes with screen shake | Rec | [Sakurai on hitstop](https://mynintendonews.com/2015/11/12/sakurai-talks-about-the-term-hitstop-used-in-fighting-games/), [channel](https://www.gamesradar.com/smash-bros-masahiro-sakurai-has-started-a-fascinating-youtube-game-design-series) |
| Screen shake and game feel | Trauma-based shake (noise, decays), bigger impacts, smoke for permanence, slow-mo | Rec | ["The Art of Screenshake", Vlambeer](https://gamedeveloper.com/design/vlambeer-co-founder-shares-advice-on-building-better-action-games) |
| Impact frames | 1-3 frame full-screen flash or inverted/high-contrast frame, radial speed lines, chromatic aberration pulse, `ShockWaveEffect` | pmndrs (Zlib) | [pmndrs docs](https://pmndrs.github.io/postprocessing/public/docs/) |
| Particles (sparks, dust, magic) | **three.quarks** (MIT): Unity-like emitters, batched renderer, trails. 0.18 is split into `quarks.core`/`three.quarks`/`quarks.nodes` (WebGPU) and **needs three >=0.182**, so pin an older three.quarks for r170 or upgrade three. Editor at quarks.art (licence unverified). | MIT | [npm/libraries.io](https://libraries.io/npm/three.quarks), [package.json](https://raw.githubusercontent.com/Alchemist0823/three.quarks/master/packages/three.quarks/package.json), [CHANGELOG](https://raw.githubusercontent.com/Alchemist0823/three.quarks/master/CHANGELOG.md) |
| Particles alt. | three-nebula (MIT, v10.0.3, reportedly little maintenance) | MIT | [npm](https://npmjs.com/package/three-nebula), [forum](https://discourse.threejs.org/t/best-particle-system/8038) |
| Authored VFX | EffekseerForWebGL (MIT, WASM runtime, three.js samples), author in the Effekseer editor. Last push ~2024. Adds WASM size. | MIT | [LICENSE](https://raw.githubusercontent.com/effekseer/EffekseerForWebGL/master/LICENSE), [index](https://awesome.ecosyste.ms/projects/github.com%2Feffekseer%2Feffekseerforwebgl) |
| Slash trails | three.quarks trails, or a custom ribbon mesh following the hand bone with a gradient/noise texture (cheapest, best art control). TrailRendererJS exists but **has no licence file**, so don't copy it. | – | [TrailRendererJS](https://github.com/mkkellogg/TrailRendererJS) |
| Landing dust / hit sparks | Flipbook sprite sheets (stylised, hand-drawn 4-8 frames) on camera-facing quads, pooled. Anime VFX reads better with hard-edged shapes and 2-3 flat colours than with soft particles. | Rec | – |

---

## 4. Open-source references

| Project | What to learn | Licence | Source |
|---|---|---|---|
| pixiv/three-vrm examples (`basic.html`, `webgpu-loader-plugin.html`, humanoid animation examples) | Correct loading, MToon, spring bones, WebGPU path | MIT | [repo](https://github.com/pixiv/three-vrm), [mtoon pkg](https://github.com/pixiv/three-vrm/tree/dev/packages/three-vrm-materials-mtoon) |
| pixiv/ChatVRM | Full app around a VRM (expressions, lip-sync). Archived May 2025. | MIT | [repo](https://github.com/pixiv/ChatVRM) |
| Kalidokit | Landmark -> VRM rig solving (deprecated) | MIT | [80.lv](https://80.lv/articles/kalidokit-an-open-source-face-pose-and-hand-tracking-library) |
| OmarShehata/webgl-outlines | Depth+normal+surface-ID post outlines in three.js | MIT | [LICENSE](https://raw.githubusercontent.com/OmarShehata/webgl-outlines/main/LICENSE) |
| hujiulong/toon-shading, mnmxmx/toon-shading, Faraz toon (ramp) | Simple three.js toon/ramp/outline shaders | check each repo | [hujiulong](https://github.com/hujiulong/toon-shading), [Faraz](https://github.com/Faraz-Portfolio/demo-2023-toon-shader) |
| NoiRC256/URPSimpleGenshinShaders | SDF face-shadow logic (Unity, port to GLSL) | check repo | [repo](https://github.com/NoiRC256/URPSimpleGenshinShaders) |
| stalomeow/StarRailNPRShader | Most complete HSR-style reference (ramp, face, hair, outline) | **GPL-3.0**: read for ideas only, don't copy code into a non-GPL project | [index](https://awesome.ecosyste.ms/projects/github.com%2Fstalomeow%2FStarRailNPRShader) |
| HoyoToon (Blender) | Documents lightmap channel meanings | check repo | [wiki](https://github.com/Melioli/HoyoToon/wiki/Using-the-Genshin-Shader) |
| babylon-mtoon-material | Another MToon port, useful for comparison | check repo | [repo](https://github.com/noppefoxwolf/babylon-mtoon-material) |

No maintained, permissively licensed "Genshin shader for three.js" repo was found ([search result summary](https://github.com/Tamicktom/genshin-like-shader)). Expect to write the face/hair patches ourselves, roughly 100-200 lines of GLSL.

**Model licensing:** VRM models carry their own VRM Public License terms (separate from code licences). Check redistribution and commercial flags before shipping a model ([VRM Public License 1.0](https://vrm.dev/en/licenses/1.0)).

---

## 5. Recommended stack and presets

### 5.1 Stack (Rec)

- **Renderer.** `WebGLRenderer({ antialias: false, powerPreference: 'high-performance' })`, `outputColorSpace = SRGB`. Tone mapping is done in the post chain.
- **Character.**
  - `@pixiv/three-vrm` 3.6 with MToon.
  - Tune per material: `shadingToonyFactor` ~0.9-0.95; `shadingShiftFactor` slightly negative; saturated warm `shadeColorFactor` on skin; `giEqualizationFactor` ~0.9; parametric rim with a light-tinted colour, `rimLightingMixFactor` ~0.5-1; outlines in `screenCoordinates`, dark desaturated version of the base colour, `outlineLightingMixFactor` ~1.
  - Patches (our code):
    - `faceSdf`: face material only; uniforms = head forward/right from the VRM head bone, plus the light direction.
    - `hairSpec`: hair materials; matcap ring on Low/Med, tangent-shifted band on High.
    - `depthRim`: High only; needs a depth texture from pmndrs `DepthPass` or a NormalPass.
- **Character light rig.**
  - One directional key light that follows the camera azimuth offset (e.g. 30-45 deg off camera, from above), so the face always reads well. Hemisphere/ambient fill.
  - The character can sit on a separate layer with its own light, so arena lighting changes don't wreck the face (Wuthering Waves drives character brightness separately: [UE interview JP](https://www.unrealengine.com/ja/developer-interviews/exploring-the-post-apocalyptic-charm-of-asg-open-worlds-in-wuthering-waves)).
- **Environment.** MToon or MeshToonMaterial with a 3-step gradient map for the island, so the world matches the character. Baked AO/lightmaps. Instanced foliage. Animated water via UV scroll.
- **Post (pmndrs).** RenderPass -> (High: NormalPass) -> one EffectPass containing [SMAA (Med/High) | SelectiveBloom or Bloom (luminance threshold ~0.9, mipmapBlur) | ToneMapping (AgX/ACES or Neutral; check the mode enum) | LUT3D grade | Vignette], plus a ChromaticAberration/ShockWave pulse only during impacts.
- **VFX.** three.quarks (pin a version compatible with our three; 0.18 requires >=0.182) or pooled flipbook quads, a custom ribbon slash trail, and a hit-stop + shake controller in the game loop.
- **Assets.**
  - Environment: gltf-transform meshopt + KTX2.
  - VRM: vrm-transform (VRM 1.0), or only resize/convert textures in VRoid/Blender before export.

### 5.2 Quality presets

| Setting | Low (integrated GPU / older laptops) | Medium (default, typical laptop) | High (Apple Silicon M-series Pro/Max, discrete GPU) |
|---|---|---|---|
| Pixel ratio cap | 1.0 (+ dynamic down to 0.75) | 1.5 | 2.0 |
| AA | FXAA | SMAA | SMAA (or MSAA 4x on composer if outlines shimmer) |
| Character outline | MToon hull, body/hair only | MToon hull, all major primitives | MToon hull + post depth/normal edges for inner lines and environment |
| Face shading | MToon + edited normals | SDF face shadow | SDF face shadow |
| Hair highlight | none / painted in texture | matcap angel ring | tangent-shifted spec band |
| Rim | parametric fresnel | parametric fresnel | screen-space depth rim (+ fresnel) |
| Shadows | blob/decal shadow | 1024 directional, character casts only | 2048 PCF soft, character + large props |
| Bloom | off | on, half-res | on, mipmapBlur, selective |
| Colour grade | tone mapping only | + LUT + vignette | + LUT + vignette + impact CA/shockwave |
| Particles budget | ~300 | ~1,000 | ~3,000 |
| Spring bones | hair only | all | all + collider refinement |
| Textures | 1K | 2K char / 1K env | 2K (4K face atlas optional) |
| MediaPipe model | lite | lite/full | full |

**Auto-tuning (Rec).** Keep a rolling frame-time average. If it stays above 17.5 ms for 2 s, step DPR down 0.1, then drop the preset tier. Step back up after 10 s under 13 ms. Treat pose-inference time as part of the budget (measure detection latency separately from render).

### 5.3 Implementation order (Rec)

1. MToon parameter pass, light rig, screen-space outlines, tone mapping and LUT. This gets roughly 70% of the visual gain for free.
2. Spring-bone tuning (limits, colliders), mocap filtering, and hit-stop/shake/impact frames. This gets most of the "feels alive" gain.
3. SDF face shadow (needs a baked face map per model).
4. VFX set: slash trail, hit spark flipbook, landing dust, bloom on emissive parts.
5. Hair spec and depth rim (High preset).
6. Post-process edge lines and environment polish.
