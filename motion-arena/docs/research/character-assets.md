# Character Assets: Getting a Polished, Original Anime Hero

Researched 2026-11-25. This is the companion to [anime-rendering.md](anime-rendering.md), which covers shaders and post-processing; that material is not repeated here. Stack: three.js r170 (`web/package.json` pins `^0.170.0`) + Vite, Apple Silicon Mac, webcam pose tracking, headless Blender in a Linux cloud sandbox with no GPU.

Conventions: every factual claim has a source link. Lines marked **Rec:** are our engineering judgement, not sourced facts. Prices change often, so re-check them before buying anything.

> **IP guardrail (project rule):** the hero must be an original character *in the style of* the reference: no X scar, no hat, no name, and no copying of the reference's exact outfit layout. **Rec:** the brief (open red short shirt + yellow sash + blue rolled shorts + sandals) is already very close to one famous character. Change at least two signature elements, for example a different shirt colour or cut, a belt or wrap instead of the sash, a different hair silhouette, and an accessory of our own (wrist wraps, a scarf, a tattoo-like emblem). Judge the result at thumbnail size: if it reads as "that character" from 10 m away, it is too close.

---

## 0. TL;DR / top recommendation

1. **Format: VRM 1.0 + `@pixiv/three-vrm` 3.6.0.** It gives MToon, spring bones (now with angle limits), expressions, look-at and a normalized humanoid skeleton that a pose-tracking retargeter can drive directly. The peer range `three >=0.137` covers r170 ([npm](https://registry.npmjs.org/@pixiv/three-vrm/latest), [v3.6.0 release, 2026-11-24](https://github.com/pixiv/three-vrm/releases/tag/v3.6.0)). Don't hand-roll a glTF rig.
2. **Primary pipeline: VRoid Studio (user, GUI, native macOS) → headless Blender + VRM Add-on (automated polish) → three-vrm.** VRoid is free, has a native macOS build, exports VRM 1.0 with expressions, spring-bone hair and MToon, and lets you sell or use the output commercially when the presets carry no special clause ([vroid.com/studio](https://vroid.com/en/studio), [guidelines](https://vroid.com/en/studio/guidelines), [v1.20.2 VRM 1.0 export](https://vroid.com/en/studio/notice/62qSFvhlfsQMgFY7xzqeIH)). The cloud Blender stage scripts the work VRoid can't do: MToon tuning, extra accessory meshes, atlasing, spring-bone tuning and validation.
3. **Fallback pipeline: original concept art → Meshy (paid) image-to-3D → Meshy auto-rig (Mixamo skeleton) → headless Blender converts it to VRM** (auto bone mapping has a Mixamo preset; MToon conversion is one operator). It is faster for a novel silhouette, but faces and hair come out worse and there are no expressions without extra work.
4. **Placeholder today:** `VRM1_Constraint_Twist_Sample.vrm` (pixiv; VRM Public License 1.0; commercial use OK, redistribution and modification OK, no credit required). It is already the model three-vrm's own examples use (section 4).

---

## 1. Character format and runtime

### 1.1 VRM vs glTF + custom rig

| | VRM 1.0 + three-vrm | Plain glTF + custom rig |
|---|---|---|
| Toon material | MToon built in (see anime-rendering.md) | Write your own |
| Secondary motion | `VRMC_springBone` (hair, cloth), plus `VRMC_springBone_limit` angle limits in 3.6.0 ([release](https://github.com/pixiv/three-vrm/releases/tag/v3.6.0)) | Write your own |
| Face | Preset expressions (happy/angry/sad/relaxed/surprised, aa/ih/ou/ee/oh visemes, blink L/R, look up/down/left/right) bound to morphs, material colours or UV transforms (names from the [VRM Add-on property group](https://github.com/saturday06/VRM-Addon-for-Blender/blob/main/src/io_scene_vrm/editor/vrm1/property_group.py)) | Ad-hoc morph names |
| Skeleton | Standard humanoid bone map plus normalized bones, so mocap and pose data retarget without per-model work | Per-model mapping |
| Animation clips | `.vrma` (VRM Animation) through `@pixiv/three-vrm-animation` 3.6.0 ([npm](https://registry.npmjs.org/@pixiv/three-vrm-animation/latest)). The Blender add-on can author it ([add-on docs](https://vrm-addon-for-blender.info/en-us/animation)) | glTF clips, retargeted by hand |
| Tooling | VRoid, the Blender VRM Add-on, UniVRM, BOOTH and VRoid Hub ecosystem | Generic |
| Licence metadata | Embedded in the file (`meta.commercialUsage`, `allowRedistribution`, …) ([VRM Public License 1.0](https://vrm.dev/en/licenses/1.0)) | None |

**Rec:** VRM 1.0. A VRM file is a glTF 2.0 binary with extensions, so we lose nothing and can still post-process it with glTF tools.

### 1.2 VRM 0.x vs 1.0

- VRoid Studio exports VRM 1.0 (v1.20.x and later re-enabled 1.0 export) ([VRoid notice](https://vroid.com/en/studio/notice/62qSFvhlfsQMgFY7xzqeIH)).
- three-vrm loads both. For 0.x it ships `VRMUtils.rotateVRM0`, because 0.x models face the other way ([VRMUtils source dir](https://github.com/pixiv/three-vrm/tree/dev/packages/three-vrm/src/VRMUtils)).
- 1.0 adds node constraints, the springBone_limit extension, `isBinary`/override rules for expressions, and clearer licence fields (see the [VRM spec samples](https://github.com/vrm-c/vrm-specification/blob/master/samples/README.md)).
- **Rec:** author and ship 1.0. Load 0.x only for placeholders (the CC0 VRoid alpha samples are 0.x, see section 4).

### 1.3 three-vrm status

- `@pixiv/three-vrm` **3.6.0**, published 2026-11-24, peer dependency `three >=0.137`. The `-materials-mtoon`, `-springbone` and `-animation` sub-packages are also 3.6.0 ([npm registry](https://registry.npmjs.org/@pixiv/three-vrm/latest)). It saw roughly monthly patch releases through 2026 (3.5.1 in Mar → 3.5.5 in Jul → 3.6.0 in Nov) ([npm time data](https://registry.npmjs.org/@pixiv/three-vrm)). MIT, about 2.3k stars, pushed 2026-11-24 ([GitHub](https://github.com/pixiv/three-vrm)).
- Performance helpers in `VRMUtils`: `combineSkeletons`, `combineMorphs`, `removeUnnecessaryVertices`, `removeUnnecessaryJoints`, `deepDispose`, `rotateVRM0` ([source](https://github.com/pixiv/three-vrm/tree/dev/packages/three-vrm/src/VRMUtils)).
- Outline cost: every outlined primitive is drawn twice (see anime-rendering.md §2). **Rec:** budget about 30–60k triangles and at most ~8–12 material primitives for the hero, so outlines don't double into 20+ draw calls.

---

## 2. Getting a high-quality ORIGINAL anime character

### 2.0 Ranking

| Rank | Route | Quality for our style | User effort | Cost | Licence | Automatable |
|---|---|---|---|---|---|---|
| 1 | **VRoid Studio + Blender polish** | High: clean topology, proper eyes and mouth, expressions, strand hair with spring bones | 2–6 h of GUI work by the user (hair and outfit editing) | Free | Your own textures and hair are yours. pixiv presets: commercial OK unless an item has a special clause ([guidelines](https://vroid.com/en/studio/guidelines)) | Polish stage only; VRoid itself is GUI-only |
| 2 | **AI image-to-3D (Meshy / Tripo) + auto-rig + Blender→VRM** | Medium: good silhouette and colours; faces and hair are blobby or baked; no expressions | Low (pick or approve concept art; maybe 1–2 h of review) | ~$20 for one month of Meshy Pro, or Tripo API credits | Paid tiers: private, commercial. Free tiers: CC BY 4.0 | Mostly (REST APIs + bpy) |
| 3 | **Commission a VRoid/Blender artist** (BOOTH / VGen / Skeb market) | Highest | Briefing and review | Not researched; varies widely | Negotiated | No |
| 4 | **Buy a ready-made VRM** (BOOTH / VRoid Hub) | High, but **not our character** | Low | Varies | Per-model; often bans redistribution, which a web game effectively does (§2.2) | n/a |
| 5 | Open-weights 3D generation (Hunyuan3D 2.1, TRELLIS.2) on a rented GPU | Medium, same failure modes as rank 2 | High (GPU setup) | GPU rental | TRELLIS.2: MIT. Hunyuan3D 2.1: territory-restricted | Yes, but needs a CUDA GPU |

### 2.1 VRoid Studio

- **Platform:** free download for Windows **and macOS**, plus an iPad version ([vroid.com/studio](https://vroid.com/en/studio)).
- **Style fit:** body shape, face and eye sliders; hair drawn as strokes with per-chunk bounce (spring bones); outfits built by combining and editing templates; texture painting with layers in 3D or on the UV map ([vroid.com/studio](https://vroid.com/en/studio)). v2.0 added a dress-up feature and the XWear format ([notice](https://vroid.com/en/studio/notice/3rgHw1j8oCVkdWM0LKHBH6)). **Rec:** messy black spiky hair, big eyes and a lean teen body are VRoid's home turf. A wide toothy grin needs a custom mouth texture or a custom "happy" expression. Fur cuffs and a sash are easier to add as small meshes in Blender (§2.5) than to fake with VRoid templates.
- **Export:** VRM 1.0, with per-section polygon reduction, material reduction and (since v2.0) texture-quality settings in the export dialog. These are reported in community guides, so confirm the labels in the app ([knbyo guide](https://knbyo.neocities.org/posts/vroid-vrchat-optimisation-guide), [Bakin tutorial](https://meringue-rouge.itch.io/guide-rpg-developer-bakin-vrm-models-animations-rigging-and-more), [v2.0.0 notice](https://vroid.com/en/studio/notice/3rgHw1j8oCVkdWM0LKHBH6)). One guide warns that reducing bones at export can trigger an inverse-bind-matrix error ([Steam discussion](https://steamcommunity.com/app/1486350/discussions/0/6320322606663662869)).
- **Scriptable?** No CLI or scripting API was found; it is a GUI app (**Rec:** treat it as a user step). The user can make the character on their Mac and upload the `.vrm` to the repo or sandbox.
- **Licence:** textures and hair meshes you make yourself belong to you. pixiv's base models, clothing meshes and presets are *not* CC0, but individuals and companies may use and sell them commercially (including in games) unless an item shows a special clause ([VRoid Studio Guidelines](https://vroid.com/en/studio/guidelines)). Sample models have their own conditions (same page).
- **BOOTH textures and outfits:** terms are per seller. Common patterns: a separate, more expensive commercial tier; "games OK"; redistribution of texture data (even modified) banned; credit sometimes required ([examples](https://booth.pm/en/items/8340743), [2](https://booth.pm/en/items/3552516), [3](https://booth.pm/en/items/5330923)). Many use the VN3 licence template, where corporate or commercial use often needs permission and the Japanese text governs ([VN3 example](https://auzlex.github.io/vn3-license-solarialabs/license), [MoguraVR on VN3](https://www.moguravr.com/?p=140066)). **Rec:** avoid BOOTH textures for the hero. A browser game ships the `.vrm` to every player, which many "no redistribution" clauses arguably forbid, and our repo is public. Paint our own textures in VRoid, or generate them.

### 2.2 VRoid Hub / BOOTH ready-made models

- VRoid Hub: the author keeps copyright and sets per-model conditions. Corporate use and individual commercial use are separate switches, and redistribution and alteration are separate settings ([developer.vroid.com conditions](https://developer.vroid.com/en/guidelines/conditions_of_use.html)). The VRM's embedded "commercial use allowed" flag is set only when both corporate and individual profit use are allowed ([MoguraVR, JP](https://www.moguravr.com/?p=92176)).
- **Finding CC0 or commercial-OK models:** check the model's conditions dialog and the embedded VRM `meta` (`commercialUsage`, `allowRedistribution`, `modification`), which follow the [VRM Public License 1.0](https://vrm.dev/en/licenses/1.0). Curated CC0 registries: [ToxSam/open-source-avatars](https://github.com/toxsam/open-source-avatars) (300+ avatars, licence per collection in `projects.json`) and Polygonal Mind's [100avatars](https://github.com/gfodor/100avatars). These are mostly low-poly stylised, not anime.
- **pixiv AvatarSample models:** current AvatarSample A–C come under "more restrictive terms". Only the old alpha-era samples (D–G, base male/female, hair samples, Sakurada Fumiriya, Sendagaya Shino) were explicitly CC0, and VRoid has ended distribution of them ([OpenGameArt mirror, CC0](https://opengameart.org/content/vroid-studio-cc0-models), [BOOTH note](https://booth.pm/en/items/3094418)). The official terms page (vroid.pixiv.help article 4402614652569) returned 403 to our fetcher, so check it in a browser.
- **Rec:** good for placeholders only. A bought model can't become "our" original hero.

### 2.3 AI image/text-to-3D (2025–2026)

| Tool | What you get | Rigging | API / pricing | Output licence |
|---|---|---|---|---|
| **Meshy** (meshy-7.1 / meshy-6) | Image/multi-image/text to 3D with PBR textures; remesh (quad option); UV unwrap | Auto-rig API: humanoid or quadruped, **textured** mesh required, ≤380k tris, GLB input, face toward +Z. Returns FBX + GLB with walk/run clips. Skeleton templates include `mixamo`, `unity_humanoid`, `ue5_mannequin`, `blender_rigify_basic_human` ([rigging docs](https://docs.meshy.ai/api/rigging)) | Image-to-3D 20–35 credits, rigging 5, animation 3/action, remesh 5 ([API pricing](https://docs.meshy.ai/api/pricing.md)). Pro $20/mo = 1,000 credits incl. API ([meshy.ai/pricing](https://meshy.ai/pricing)). Free = 100 credits/mo ([docs](https://docs.meshy.ai/pricing)) | Free: **CC BY 4.0** (commercial with attribution). Paid: private, full commercial ([docs](https://docs.meshy.ai/pricing)) |
| **Tripo** | Image/multiview to 3D, texture, format convert | Auto-rig 25 credits, retarget 10/animation, 100+ preset motions ([developers.tripo3d.ai](https://developers.tripo3d.ai/)) | 1 credit = $0.01 on the API. Image-to-3D 20–30 credits ([same](https://developers.tripo3d.ai/)). API and Studio are billed separately ([Tripo guide](https://www.tripo3d.ai/getting-started/zero-to-3d-getting-started-credits-pricing-guide)) | Secondary sources: free tier CC BY 4.0, non-commercial; paid commercial ([costbench](https://www.costbench.com/software/ai-3d-generation/tripo-ai/free-plan/)). Official pricing page returned 403, so verify |
| **Rodin / Hyper3D** (Gen-2 / 2.5) | High-detail meshes; T/A-pose control | Rigging docs appeared Oct 2026 (secondary source) ([picassoia](https://blog.picassoia.com/rodin-gen-2-5-hyper3d-image-to-3d-pricing-and-quality)) | Full API on the Business plan ([hyper3d.ai/pricing](https://hyper3d.ai/pricing)). Resellers charge ~$0.3–0.4/generation ([Runware](https://runware.ai/docs/models/hyper3d-rodin-gen-2/schema.json)) | Commercial licence clear on Business; sources conflict on Creator |
| **Hunyuan3D 2.1** (open weights) | Shape + PBR texture | None | Self-host. 2.0 README: 6 GB VRAM for shape, 16 GB with texture ([repo](https://github.com/Tencent/Hunyuan3D-2)). Apple Silicon only via community MPS forks ([fork](https://raw.githubusercontent.com/VladimirTalyzin/hunyuan3d-2.1-mac/main/README.md)) | Tencent community licence: **not valid in the EU, UK or South Korea**; >1M MAU needs a separate licence; outputs may not be used to train other models ([LICENSE](https://raw.githubusercontent.com/Tencent-Hunyuan/Hunyuan3D-2.1/main/LICENSE)) |
| **TRELLIS.2** (Microsoft, 4B) | Image to 3D, 512³–1536³ | None | NVIDIA ≥24 GB, Linux-tested ([HF card](https://huggingface.co/microsoft/TRELLIS.2-4B/blob/main/README.md), [repo](https://github.com/microsoft/TRELLIS.2)) | **MIT** code and weights; nvdiffrast has its own licence |
| **Stable Fast 3D** | Fast single-image object mesh | None | Self-host | Stability Community Licence: free under $1M revenue, registration + "Powered by Stability AI" needed for commercial use ([LICENSE](https://raw.githubusercontent.com/Stability-AI/stable-fast-3d/main/LICENSE.md)). Repo idle since Jan 2025 |
| **TripoSG** (open) | Shape only | None | Self-host | MIT ([repo](https://github.com/VAST-AI-Research/TripoSG)) |

**Quality for stylised anime characters:**
- Even vendor and sponsored material admits raw output can have a "pixelated face… dirty textures" ([MoguraVR sponsored Tripo post](https://www.moguravr.com/?p=379073)).
- AI meshes deform badly in expressions because of dense or disordered topology ([Tripo blog](https://www.tripo3d.ai/media-production/fix-ai-blendshape-errors-animated-short-rigging)).
- General generators don't output VRM or facial blendshapes ([Neural4D, competitor](https://blog.neural4d.com/?p=2754); [Tripo VRM guide](https://www.tripo3d.ai/blog/vrm-model-generator)).

**Rec:** expect one fused mesh with lighting baked into the albedo. That fights MToon's two-tone shading, so you have to flatten the textures. There are no separate eye or mouth meshes, so you get no blink or grin unless you rebuild the face. That is why it ranks below VRoid for a hero who is on screen and close up all the time.

### 2.4 Auto-rigging

| Tool | Status | Headless? | Notes |
|---|---|---|---|
| Mixamo | Still live, free with an Adobe ID, biped only ([Adobe FAQ](https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html)); intermittent auto-rig breakage reported Aug and Dec 2025 ([forum](https://community.adobe.com/questions-696/mixamo-auto-rigging-not-working-1614892)) | **No**: web UI, no public API | Official Blender plugin unsupported; community fork updated Apr 2026 ([extensions.blender.org](https://extensions.blender.org/add-ons/mixamo-rig/)) |
| AccuRIG 2 (Reallusion) | Free, ActorCore account needed; **Windows only** (Mac only through CrossOver) ([CGChannel](https://www.cgchannel.com/2025/07/rig-and-animate-3d-characters-for-free-with-accurig-2-0/), [CodeWeavers](https://www.codeweavers.com/compatibility/crossover/accurig-2)) | No (GUI) | Commercial use OK per staff ([forum](https://forum.reallusion.com/551972/reallusion-Accu-Rig-Free)); ActorCore motions only inside AccuRIG |
| Meshy rigging API | Live | **Yes** (REST) | See §2.3; Mixamo skeleton template available |
| Tripo rig/retarget API | Live | **Yes** (REST) | See §2.3 |
| UniRig (VAST) | MIT; skeleton + skinning checkpoints released (trained on Articulation-XL2.0); Rig-XL/VRoid checkpoints "planned"; successor SkinTokens ([README](https://raw.githubusercontent.com/VAST-AI-Research/UniRig/main/README.md)) | Yes, but needs a CUDA GPU with >8 GB ([HF](https://huggingface.co/VAST-AI/UniRig)) | Ships a modified VRM add-on for .vrm I/O |
| Rigify / Auto-Rig Pro | Blender add-ons | Rigify is scriptable in bpy but expects you to fit a metarig; ARP is paid and GUI-oriented | **Rec:** not worth it when the target is a VRM humanoid |

**Rec:** for the AI route use the **Meshy rig API with `skeleton_template: "mixamo"`**. The VRM Add-on's auto bone assignment has a Mixamo mapping (§2.5).

### 2.5 Headless Blender pipeline (cloud sandbox)

**Versions.** The VRM Add-on for Blender (saturday06) is at **v4.10.5 (2026-11-11)**, MIT/GPL-3.0, with `blender_version_min = 4.2.0` and `blender_version_max = 5.4.0` ([manifest](https://raw.githubusercontent.com/saturday06/VRM-Addon-for-Blender/main/src/io_scene_vrm/blender_manifest.toml), [releases](https://github.com/saturday06/VRM-Addon-for-Blender/releases)). Current Blender Linux builds include 4.5.17, 5.2.5 and 5.3.0 ([download.blender.org](https://download.blender.org/release/)). **Rec:** pin Blender 4.5.x (or 5.2.x) plus add-on 4.10.5 in the sandbox setup script, and don't float either.

**Install from the CLI (no GUI):**
```bash
wget https://download.blender.org/release/Blender4.5/blender-4.5.17-linux-x64.tar.xz && tar xf blender-4.5.17-linux-x64.tar.xz
wget https://github.com/saturday06/VRM-Addon-for-Blender/releases/download/v4.10.5/VRM_Addon_for_Blender-Extension-4_10_5.zip
./blender-4.5.17-linux-x64/blender -b --command extension install-file -r user_default --enable VRM_Addon_for_Blender-Extension-4_10_5.zip
```
`install-file [-h] -r REPO [-e] [--no-prefs] FILE` is the documented syntax ([Blender manual](https://docs.blender.org/manual/en/4.3/advanced/command_line/extension_arguments.html)). Headless Linux may also need `apt install libxi6 libxkbcommon0 libsm6 libgl1` (**Rec**: the usual missing libs on slim images).

**Python API (all verified in the add-on source or docs):**
- Import / export: `bpy.ops.import_scene.vrm(filepath=...)` and `bpy.ops.export_scene.vrm(filepath=...)`; check for `{"FINISHED"}` ([scripting API](https://vrm-addon-for-blender.info/en-us/scripting-api/)). Export options include `export_invisibles`, `export_only_selections`, `export_all_influences`, `export_lights`, `export_gltf_animations`, `export_try_sparse_sk` ([export_scene.py](https://github.com/saturday06/VRM-Addon-for-Blender/blob/main/src/io_scene_vrm/exporter/export_scene.py)). glTF/GLB/FBX inputs come in through Blender's bundled importers (`bpy.ops.import_scene.gltf`, `import_scene.fbx`).
- Spec version: `armature.data.vrm_addon_extension.spec_version = "1.0"` ([scripting API](https://vrm-addon-for-blender.info/en-us/scripting-api/)).
- **Humanoid mapping:** manually with `ext.vrm1.humanoid.human_bones.hips.node.bone_name = "..."` ([scripting API](https://vrm-addon-for-blender.info/en-us/scripting-api/)), or automatically with `bpy.ops.vrm.assign_vrm1_humanoid_human_bones_automatically(armature_object_name=arm.name)` ([ops.py](https://github.com/saturday06/VRM-Addon-for-Blender/blob/main/src/io_scene_vrm/editor/vrm1/ops.py)). The mapper ships presets for **Mixamo, Reallusion (AccuRIG/CC), Rigify meta-rig, Unreal, Ready Player Me, VRoid, MMD, Rocketbox, MPFB**, plus a structure-based fallback ([human_bone_mapper dir](https://github.com/saturday06/VRM-Addon-for-Blender/tree/main/src/io_scene_vrm/common/human_bone_mapper)). Also available: `vrm.make_estimated_humanoid_t_pose`, `vrm.apply_humanoid_t_pose`, `vrm.show_vrm1_bone_assignment_diagnostics` (same source tree).
- **MToon:** `bpy.ops.vrm.convert_material_to_mtoon1` (converts a Principled BSDF material), or set `material.vrm_addon_extension.mtoon1.enabled = True`, then `mtoon1.pbr_metallic_roughness.base_color_factor` and `mtoon1.extensions.vrmc_materials_mtoon.*` (shade, rim, outline, UV animation) ([scripting API](https://vrm-addon-for-blender.info/en-us/scripting-api/), [ops source](https://github.com/saturday06/VRM-Addon-for-Blender/tree/main/src/io_scene_vrm/editor)).
- **Expressions:** `ext.vrm1.expressions.preset.{happy, aa, blink, …}` and `expressions.custom` (each holds morph-target, material-colour and texture-transform binds). Ops: `vrm.add_vrm1_expression_morph_target_bind`, `vrm.assign_vrm1_expressions_automatically`, and `vrm.assign_vrm1_expressions_from_arkit` / `_from_vrchat` / `_from_mmd` / `_from_ready_player_me` ([property_group.py](https://github.com/saturday06/VRM-Addon-for-Blender/blob/main/src/io_scene_vrm/editor/vrm1/property_group.py), [ops.py](https://github.com/saturday06/VRM-Addon-for-Blender/blob/main/src/io_scene_vrm/editor/vrm1/ops.py)).
- **Spring bones:** `ext.spring_bone1.{colliders, collider_groups, springs}`. Each spring has `joints` (`node`, `hit_radius`, `stiffness`, `gravity_power`, `gravity_dir`, `drag_force`, plus the `vrmc_spring_bone_limit` cone/hinge/spherical limits) and `collider_groups`. Ops: `vrm.add_spring_bone1_spring`, `vrm.add_spring_bone1_collider`, … ([spring_bone1 property_group.py](https://github.com/saturday06/VRM-Addon-for-Blender/blob/main/src/io_scene_vrm/editor/spring_bone1/property_group.py)). The add-on's tests and docs don't cover spring bones or expressions via script ([scripting API page](https://vrm-addon-for-blender.info/en-us/scripting-api/)), so **Rec:** read these property groups and test round-trips.
- **Cleanup headless (Rec, standard bpy):** Decimate modifier and `bpy.ops.object.quadriflow_remesh` (CPU) for AI meshes; Cycles **CPU** baking to flatten or re-bake textures onto a new UV atlas (EEVEE needs an OpenGL/EGL context, so don't rely on it headless); Smart UV Project for atlas UVs; `bpy.ops.object.data_transfer` to copy skin weights onto new accessory meshes (sash, fur cuffs) from the body.
- **Gotchas (Rec unless sourced):** add-on and Blender version pairing (the manifest max is 5.4.0); the add-on's export validation warnings (the GUI shows a dialog; check stdout in headless runs); VRoid models arrive with many materials (atlas in Blender or with VRoid's export reduction); a Mixamo rig's `mixamorig:` prefixes are handled by the mapper; Meshy rigs are in centimetres for the default template and metres for others ([Meshy docs](https://docs.meshy.ai/api/rigging)), so apply scale before VRM export; and no GPU means slow Cycles bakes (minutes per 2K map, which is acceptable).

---

## 3. Recommended pipeline

### Primary: VRoid → headless Blender polish → three-vrm

| Step | Who | What | Time (Rec) |
|---|---|---|---|
| 0 | Claude | Write a 1-page original character sheet: silhouette, palette, and the differences from the reference listed in the IP guardrail. Optionally make concept art with any image model | 30 min |
| 1 | **User** (Mac GUI) | Install VRoid Studio (free). Male base, lean body sliders, big eyes; draw messy spiky black hair (enable bounce); top / shorts / shoes from templates; paint flat colours. Export **VRM 1.0** with moderate reduction. Set license meta: our own copyright | 2–6 h (less with a step-by-step checklist from Claude) |
| 2 | Claude (cloud bpy) | Import → add accessory meshes (sash/belt knot, fur cuffs, sandal straps) procedurally, transfer weights from the body, assign MToon → tune shade colours, `screenCoordinates` outlines, rim → add or tune spring bones for hair, sash tails and cuffs with colliders → build a custom "grin" expression (morph from VRoid's mouth shapes plus a mouth-texture UV swap) → atlas to ≤8–10 materials → export VRM 1.0 → validate by loading with three-vrm in CI (node + headless) | 0.5–1 day of iteration |
| 3 | Claude | Integrate in the game: humanoid normalized bones driven by InstantHMR pose; expressions on events; spring-bone tuning on device; perf tiers (anime-rendering.md §5) | 0.5 day |
| 4 | User | Visual sign-off; loop back to step 1 or 2 for tweaks | — |

Cost: **$0**. The risk is the user's GUI time in VRoid. **Rec:** Claude can drive VRoid via computer-use on the Mac with the user's permission, but strand-hair drawing is fiddly, so the user doing it is faster and better.

### Fallback: AI concept → Meshy → Blender → VRM

1. Claude makes an original front-facing T/A-pose concept (Meshy text-to-image, 3–9 credits ([pricing](https://docs.meshy.ai/api/pricing.md)), or any image model). **User approves it.**
2. **User:** sign up for Meshy Pro ($20/mo, 1,000 credits, private licence) and give Claude an API key via an env var ([meshy.ai/pricing](https://meshy.ai/pricing)).
3. Claude: image-to-3D with meshy-7.1 (30 credits incl. textures) → remesh to ~40–60k tris (5) → rig with the Mixamo template (5) ([API pricing](https://docs.meshy.ai/api/pricing.md)). Do 3–5 variations for about 200 credits.
4. Cloud bpy: import the GLB → apply scale → `assign_vrm1_humanoid_human_bones_automatically` → split or flatten the baked albedo → `convert_material_to_mtoon1` → face: replace with a separate eye/mouth decal mesh, or accept a static face and use UV-swap expressions → spring bones on the hair → export VRM 1.0.
5. Expect it to look noticeably worse than VRoid at face distance. **Rec:** use it if the user can't spend the VRoid time, or as a body/outfit base whose head comes from VRoid (head swap in Blender is feasible but fiddly).

Cost: about $20 and a day of Claude iteration. Tripo (API credits at $0.01, rig 25) is an equivalent alternative ([developers.tripo3d.ai](https://developers.tripo3d.ai/)).

### Not recommended now
- Self-hosting Hunyuan3D, TRELLIS.2 or UniRig: they need a CUDA GPU the sandbox doesn't have, give the same face and hair problems as Meshy, and Hunyuan has territory restrictions (§2.3).
- Mixamo or AccuRIG: no headless path, and AccuRIG is Windows-only (§2.4).

---

## 4. Placeholders usable today

The repo is public, so only use files whose licence allows redistribution.

| Model | Licence (verified from embedded `meta`) | Stats | URL |
|---|---|---|---|
| **VRM1_Constraint_Twist_Sample** (pixiv, VRoid-style girl) | VRM Public License 1.0; `commercialUsage: corporation`, `allowRedistribution: true`, `modification: allowModificationRedistribution`, `creditNotation: unnecessary` ([README](https://github.com/vrm-c/vrm-specification/tree/master/samples/VRM1_Constraint_Twist_Sample)) | VRM 1.0, ~36.5k tris, 13 materials, 10.8 MB; MToon, spring bones, expressions, look-at bones | [download](https://raw.githubusercontent.com/vrm-c/vrm-specification/master/samples/VRM1_Constraint_Twist_Sample/vrm/VRM1_Constraint_Twist_Sample.vrm) (also in [three-vrm examples](https://github.com/pixiv/three-vrm/tree/dev/packages/three-vrm/examples/models)) |
| **Seed-san** (VirtualCast) | VRM Public License 1.0; corporation commercial, redistribution and modification OK, **credit required** ("VirtualCast, Inc.") ([README](https://github.com/vrm-c/vrm-specification/tree/master/samples/Seed-san)) | VRM 1.0, ~45k tris, 17 materials, 10.9 MB; MToon + PBR, constraints, UV-transform expressions | [download](https://raw.githubusercontent.com/vrm-c/vrm-specification/master/samples/Seed-san/vrm/Seed-san.vrm) |
| **VRoid alpha CC0 set**: `base_male`, `sakurada_fumiriya` (male), `avatarsample_d`–`g`, etc. | **CC0** (VRoid Project; mirrored by a third party) ([OpenGameArt](https://opengameart.org/content/vroid-studio-cc0-models)) | VRM 0.x, unoptimised exports | e.g. [base_male.zip](https://opengameart.org/sites/default/files/base_male.zip), [sakurada_fumiriya.zip](https://opengameart.org/sites/default/files/sakurada_fumiriya.zip) |

**Rec:** use `VRM1_Constraint_Twist_Sample.vrm` today to prove the three-vrm runtime (loading, MToon, spring bones, expressions, pose retarget). It is VRM 1.0, needs no credit and is redistributable. Use `base_male` (CC0, male, VRM 0.x → `VRMUtils.rotateVRM0`) to check a male proportion and as a fallback base. Both licence checks above came from parsing the JSON chunk of the downloaded files on 2026-11-25.
