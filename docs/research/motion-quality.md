# Webcam-Driven Avatar Motion Quality

Researched 2026-11-25. Target: three.js r170 + Vite, VRM hero via `@pixiv/three-vrm`, InstantHMR (local Python, 70 keypoints + MHR parameters at about 25 fps) or MediaPipe Pose in the browser, Apple Silicon Mac. Companion to [anime-rendering.md](anime-rendering.md).

Conventions: every factual claim has a source link. Lines marked **Rec:** are our engineering recommendations, not sourced facts. "Our code" claims cite file and line numbers in this repo as of commit `f036279`.

---

## 0. TL;DR: top recommendations

1. **Use InstantHMR's MHR joint rotations instead of solving bones from keypoints.** MHR is a 127-joint skeleton with Euler-XYZ joint angles and limb twist joints. Its forward kinematics (FK) is a linear parameter map followed by a short FK loop, Apache-2.0, in ~350 lines of pure PyTorch ([paper](https://arxiv.org/html/2511.15586v3), [`mhr/_torch_rig.py`](https://github.com/facebookresearch/MHR/blob/main/mhr/_torch_rig.py)). Our server already has `mhr_params` but sends only `j3d` ([server/hmr_server.py:173](../../server/hmr_server.py)). Send the 204 floats and port the FK to JS, or run FK in Python and send about 22 global quaternions. Then retarget to VRM with the same rest-pose delta formula pixiv uses for Mixamo ([loadMixamoAnimation.js](https://github.com/pixiv/three-vrm/blob/dev/packages/three-vrm/examples/humanoidAnimation/loadMixamoAnimation.js)). This gives real forearm/wrist/head twist, which minimal-swing-from-directions cannot recover (section 3).
2. **Filter once, then predict.** Today the pose goes through three smoothers in a row: InstantHMR's one-euro on MHR params (server default `--pose-filter one-euro`, [hmr_server.py:295](../../server/hmr_server.py)), a client one-euro on every joint ([pose.js:91-108](../../web/src/pose.js)), and an exponential slerp in `Retargeter.update` ([retarget.js:158-165](../../web/src/retarget.js)). Each adds lag. Keep the server's rotation filter (tuned, under half a frame of lag per [InstantHMR smoothing.py](https://github.com/Naturalpad-studio/InstantHMR/blob/main/instanthmr/smoothing.py)). On the client, replace the other two with timestamp-aware extrapolation to render time plus a "tracking spring" ([Holden](https://theorangeduck.com/page/perfect-tracking-springs)), with prediction clipped to about 50-60 ms (section 4.1).
3. **Add a real IK/contact layer after FK.** Use per-foot contact detection, world-space foot locking, analytic two-bone leg IK and pelvis height correction, following Holden's 2026 foot-locking method. It has MIT reference code ([article](https://theorangeduck.com/page/inverse-kinematics-foot-locking), [GenoView-InverseKinematics](https://github.com/orangeduck/GenoView-InverseKinematics)). Use two-bone arm IK for punches, with bone-length-normalised reach targets. This replaces today's "shift the whole body so the lowest foot is on the floor" ([retarget.js:173-181](../../web/src/retarget.js)), which causes feet to slide and the body to pop up and down.
4. **Make it a game character, not a puppet.** Shipped Kinect titles rarely mapped motion 1:1, because players want the hero to follow their *intent* ([NaturalMotion via MCV, 2011](https://www.mcvuk.com/development/kinect-retargeting)). Layer the tracked pose over an authored/procedural base: idle breathing, stance, landing squash, hit reactions, fists/open-hand poses. Let detected actions (punch, jump, kick) blend in short authored "accent" clips with inertialization, so moves read as anime-strong even when the player's motion is weak or partly occluded (section 4.8).
5. **Confidence is a blend weight, not a switch.** Today a limb snaps to a fallback direction when confidence drops below 0.35 ([retarget.js:141-150](../../web/src/retarget.js)). Instead, fade per-joint weight with hysteresis toward the last good pose, then the procedural layer. Default to "upper body tracked, lower body procedural" when legs leave the frame.
6. **Hands and face:** Start with cheap, robust options. For hands, classify MHR/InstantHMR hand keypoints into a few authored hand poses (fist, open, point). For the face, run only MediaPipe Face Landmarker in the browser (blendshapes → VRM `blink*`, `aa`/`oh`, `happy`; head rotation from its transform matrix). Add MediaPipe hand landmarks only if per-finger fidelity matters, and benchmark first. No official M-series numbers exist (section 5).

---

## 1. Diagnosis of the current pipeline (our code)

| Symptom the user will see | Cause in our code | Fix (section) |
|---|---|---|
| Laggy, "floaty" motion even though tracking latency is ~30 ms | Triple smoothing: server one-euro on MHR params ([hmr_server.py:295](../../server/hmr_server.py)), client one-euro per joint position (strength 0.35 gives minCutoff ≈ 4.0 Hz, beta ≈ 1.3, [pose.js:285-286](../../web/src/pose.js)), and slerp with rate `lerp(40,7,0.5)` ≈ 23.5/s, so τ ≈ 43 ms ([retarget.js:158](../../web/src/retarget.js)). At 25 Hz input the renderer also holds each sample for ~40 ms. | 4.1 |
| Dead wrists and forearms, "candy-wrapper" skin, hands pointing but never rotating | Limbs use `setFromUnitVectors` minimal swing from the parent's frame ([retarget.js:151](../../web/src/retarget.js)). Bone *twist* is never observed, so it is inherited from the parent. The hand direction comes from wrist→hand only. | 3, 4.6 |
| Torso looks stiff and bends at the wrong joint | Spine is a fixed 50 % slerp between the hip basis and chest basis ([retarget.js:108](../../web/src/retarget.js)). The neck/head uses a hand-tuned −0.32 rad pitch offset ([retarget.js:13](../../web/src/retarget.js)). | 3, 4.6 |
| Feet slide, body pops vertically, knees never really bend for squats | The root moves by the tracked hip offset ([retarget.js:96-100](../../web/src/retarget.js)), but legs are FK from directions on a rig with different bone lengths. Then one global Y shift puts the lowest foot marker on the floor ([retarget.js:175-180](../../web/src/retarget.js)). Nothing pins an individual foot. | 4.3, 4.4 |
| Limbs snap when partly out of frame | Binary threshold `c >= 0.35` with a hard fallback direction ([retarget.js:141-150](../../web/src/retarget.js)) | 4.7 |
| Front/back jitter | Monocular depth goes straight into root Z (scale 0.8, [retarget.js:72](../../web/src/retarget.js)) | 4.4 |
| Gesture triggers late | Action detection runs on the *filtered* joints ([main.js:228-229](../../web/src/main.js)) | 6 |

Also: the web app pins `@mediapipe/tasks-vision ^0.10.18` ([web/package.json](../../web/package.json)), which cannot resolve to the 1.x line. 1.x has been current since 2026-07 (1.2.3 on 2026-11-11, per `npm view`). Its release notes say PoseLandmarker and HolisticLandmarker were migrated to the Tasks C API, and option/result names were unified with compatibility aliases kept ([mediapipe releases](https://github.com/google-ai-edge/mediapipe/releases)). **Rec:** upgrade and re-check behaviour.

---

## 2. Libraries and approaches: webcam → humanoid

| Project | What it does | Status / licence | Verdict for us |
|---|---|---|---|
| **Kalidokit** | MediaPipe landmarks → Euler rotations for VRM-style bones (arms, hands, spine, hips; legs flagged "WIP") ([README](https://github.com/yeemachine/kalidokit)) | README: "officially deprecated and solutions will be directly integrated into MediaPipe" ([repo](https://github.com/yeemachine/kalidokit)). Last npm release 1.1.5 in 2022 (`npm view kalidokit`). MIT. | Reference only. Same swing-from-direction approach we already have, with weak legs. |
| **XR Animator / System Animator Online** | Browser and desktop full-body capture with MediaPipe. Face via ARKit-compatible 52 blendshapes ("Perfect Sync"). Any VRM/MMD model. Cites "60fps visual rendering and 30fps body pose detection on a mediocre PC" with workers/OffscreenCanvas, and 20+ fps pose+finger on a GTX 1650 ([README](https://github.com/ButzYung/SystemAnimatorOnline)) | Active (pushed 2026-11-22). Code is **CC BY-NC-SA 4.0** ([readme.txt](https://www.github.com/ButzYung/SystemAnimatorOnline/blob/master/readme.txt)). | Best-in-class *web* reference for what is achievable. Try the [web version](https://sao.animetheme.com/XR_Animator.html) as a quality benchmark. Do not copy code (non-commercial, share-alike). |
| **three-vrm** | VRM loader. Humanoid exposes *normalized* bones with identity rest orientation and syncs them to raw bones on `vrm.update` ([three-vrm docs via search](https://docsearch.algolia.com/mcp/docs/repo/pixiv/three-vrm)). Ships a Mixamo→VRM retarget example ([humanoidAnimation](https://github.com/pixiv/three-vrm/tree/dev/packages/three-vrm/examples/humanoidAnimation)). | v3.6.0, 2026-11-24, MIT ([releases](https://github.com/pixiv/three-vrm/releases)) | **Use.** Drive normalized bones only. Use `VRMUtils.rotateVRM0` for VRM 0.x models as the example does ([main.js](https://github.com/pixiv/three-vrm/blob/dev/packages/three-vrm/examples/humanoidAnimation/main.js)). |
| **MiKaPo** | Webcam → MMD via MediaPipe HolisticLandmarker, landmarks → bone quaternions ([search summary](https://awesome.ecosyste.ms/projects/github.com%2Famyangxyz%2Fmikapo)) | GPL-3.0, active (2026-10) | Read for ideas only (GPL). |
| **Warudo / VSeeFace** | VTuber apps. Warudo's built-in MediaPipe tracker is mainly upper body: wrist/fingers plus face. Pose tracking is customised through blueprints ([Warudo MediaPipe docs](https://docs.warudo.app/docs/mocap/mediapipe), [body tracking](https://docs.warudo.app/docs/mocap/body-tracking)). | Closed source | The pattern to copy: upper body tracked, lower body procedural, idle layer underneath. |
| **Rokoko Vision** | Webcam and dual-camera recording removed. AI capture is now upload-only, and Rokoko notes that post-processing makes real-time hard ([product page](https://www.rokoko.com/products/video)). | Commercial | Not usable for real-time. |
| **FreeMoCap** | Multi-camera markerless capture | AGPL-3.0, FAQ says not real-time ([FAQ](https://freemocap.github.io/documentation/frequently-asked-questions-faq.html)) | Not suitable. |
| **Mixamo-style retarget** | Copy rotations as *world-space deltas from rest pose*. pixiv's loader computes `parentRestWorld * q * inverse(restWorld)` per bone and scales hips translation by the VRM/source hip-height ratio ([loadMixamoAnimation.js](https://github.com/pixiv/three-vrm/blob/dev/packages/three-vrm/examples/humanoidAnimation/loadMixamoAnimation.js)) | MIT | **Use this exact formula** for MHR → VRM (section 3). |

**Rec, best for full-body game control:** No off-the-shelf browser library is current and good enough. XR Animator is the quality bar but cannot be reused. Build on three-vrm + MHR rotations + our own IK/contact/layer code (sections 3-6). Keep MediaPipe Pose as a no-server fallback that uses landmark-to-bone solving with the same post-FK layers.

---

## 3. MHR pose parameters directly vs solving from keypoints

### 3.1 What MHR gives you

- 127 joints and 204 parameters: 136 per-frame pose parameters and 68 skeleton-scale parameters fixed per performer ([MHR paper](https://arxiv.org/html/2511.15586v3)).
- A linear map turns model parameters into per-joint parameters, Θj = Tp·Θp, with 7 values per joint: 3 translation, 3 rotation as **Euler XYZ**, and 1 uniform scale ([paper](https://arxiv.org/html/2511.15586v3)).
- The map lets one parameter drive several joints, which is how **limb twist joints** get fractions of the main joint's rotation to reduce LBS candy-wrapping ([paper](https://arxiv.org/html/2511.15586v3)).
- FK per joint: `T_world = T_parent · T_offset · T_translation · T_prerot · T_rot · T_scale`. Pre-rotations make each joint's local **x-axis point along the bone**, so x rotation is twist ([paper](https://arxiv.org/html/2511.15586v3)).
- The pure-PyTorch rig ([`_torch_rig.py`](https://github.com/facebookresearch/MHR/blob/main/mhr/_torch_rig.py)) does exactly this. It produces a skeleton state per joint of `[tx,ty,tz, qx,qy,qz,qw, s]`, from `rig.npz` arrays `joint_offsets`, `joint_prerotations`, `joint_parents`, `parameter_transform`, `joint_names`, `parameter_names`. It also carries **joint limits** (`limit_min`, `limit_max`, `limit_parameter_index`) we can reuse.
- Tooling: glTF export of a 127-joint skinned skeleton plus animation ([mhr_export](https://github.com/facebookresearch/MHR/tree/main/tools/mhr_export)), and SMPL/SMPL-X conversion (`tools/mhr_smpl_conversion`, [README](https://github.com/facebookresearch/MHR)). Apache-2.0 ([repo](https://github.com/facebookresearch/MHR)).

### 3.2 What InstantHMR gives you (vendored code)

- `HMRPrediction.mhr_params` is `(204,)` and `shape_params` is `(45,)` ([vendor/InstantHMR/instanthmr/inference.py:35](../../vendor/InstantHMR/instanthmr/inference.py)). The bundled `mhr-body.onnx` takes exactly `mhr_params[batch,204]` + `shape_params[batch,45]` and outputs only `joints_3d[70]` and `vertices`. It does not output joint transforms (checked locally with onnxruntime on the cached `mhr-body.onnx`). So the 204-vector is MHR's model-parameter vector.
- Index layout used by InstantHMR's own filter: `3:6` = root rotation, `6:68` = body angles, in radians ([smoothing.py:28](../../vendor/InstantHMR/instanthmr/smoothing.py)). By MHR's 136/68 split, the rest of the pose block (presumably 68:136) holds hands and other angles, and 136:204 the skeleton scales. This is an inference: verify against `parameter_names` in `rig.npz`.
- The pose filter (one-euro or alpha-beta on angles, with wrap-around) is applied to `mhr_params` *before* the body graph, so keypoints, mesh and parameters stay consistent. It cuts jitter 27-35 % with "under half a frame of lag" ([smoothing.py docstring](../../vendor/InstantHMR/instanthmr/smoothing.py), [InstantHMR README](https://github.com/Naturalpad-studio/InstantHMR)).
- The kinematic fit (`--fit`, we run `--fit 1`) refines the pose against the 2D keypoints *through the MHR skeleton*, so the rotations already agree with the image ([README](https://github.com/Naturalpad-studio/InstantHMR)).
- Joints are in the camera frame (x right, y down, z forward) ([README](https://github.com/Naturalpad-studio/InstantHMR)). Our `camToThree` flips y and z ([pose.js:235-238](../../web/src/pose.js)).
- Licence caveat: all InstantHMR weights are under the SAM License, and all but `medium-commercial` are non-commercial ([README](https://github.com/Naturalpad-studio/InstantHMR)).

### 3.3 Mapping MHR → VRM normalized humanoid

**Rec (method):**

1. **Server:** add `"mhr": r4(p.mhr_params)` to each person in the WebSocket JSON (about 204 floats, ~1.5 KB/frame). Optionally add `shape_params` once per calibration.
2. **FK:** either
   (a) port `_Skeleton.forward` + `_ParameterTransform` to JS (an 889×204 matrix, mostly sparse; precompute non-zeros), loading the rig arrays once as a JSON/binary asset, or
   (b) run MHR's torch FK in the server and send global quaternions for the ~22 joints we need.
   (a) keeps the server thin and lets us filter/predict in parameter space on the client. (b) is quicker to prototype.
3. **Pick joints:** map MHR joint names to VRM `hips, spine, chest, upperChest, neck, head, {l,r}{Shoulder, UpperArm, LowerArm, Hand, UpperLeg, LowerLeg, Foot, Toes}` and optional fingers. VRM finger names are Thumb Metacarpal/Proximal/Distal and Index…Little Proximal/Intermediate/Distal ([VRM 1.0 humanoid](https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm-1.0/humanoid.md)).
4. **Frame conversion:** camera frame → three.js is a 180° rotation about X, so `q' = C·q·C⁻¹` with `C = (1,0,0,0)` (x,y,z,w).
5. **Mirror mode:** reflect across X (quaternion `(x,−y,−z,w)`) and swap left/right joint names.
6. **Rest alignment (once):** run FK with zero pose to get the MHR rest world rotations `R0_j` and rest joint positions. VRM normalized bones have identity rest rotation in a T-pose. For each bone, compute `A_j` = the rotation taking the VRM rest bone direction onto the MHR rest bone direction (twist from the MHR frame's side axis), to absorb the T-pose vs MHR rest-pose difference.
7. **Per frame:** `W_j = R_j · R0_j⁻¹ · A_j` (world target), then `local_j = W_parent⁻¹ · W_j`, written to `vrm.humanoid.getNormalizedBoneNode(name).quaternion`. This is pixiv's Mixamo formula ([loadMixamoAnimation.js](https://github.com/pixiv/three-vrm/blob/dev/packages/three-vrm/examples/humanoidAnimation/loadMixamoAnimation.js)) with an added rest-pose offset.
8. **Twist:** VRM has no twist bones, so composite MHR's twist joints into the main bone. Use the global rotation of the *last* twist joint before the wrist for `lowerArm`, then split about 50 % of the hand's twist (about the forearm axis) back into `lowerArm` to soften wrist candy-wrap (section 4.6).
9. **Root:** horizontal from the MHR root translation + `cam_trans`. Height = calibrated standing hip height × (VRM hips height / player hips height), the same hip-height scaling pixiv uses ([loadMixamoAnimation.js](https://github.com/pixiv/three-vrm/blob/dev/packages/three-vrm/examples/humanoidAnimation/loadMixamoAnimation.js)). Then foot IK (4.3).
10. **Validate:** run JS FK on recorded `mhr_params` and compare joint positions with InstantHMR's `joints_3d` for the joints that exist in both (wrists, elbows, knees, ankles). Errors over ~1 cm mean a convention bug.

**Why rotations beat keypoints here:**

- Twist (forearm pronation, head roll, thigh rotation) and a consistent spine distribution come for free.
- Bone-length mismatch disappears from FK, because we copy rotations, not positions.
- Joint limits are available in parameter space.

**Keep the keypoints for:** foot contact, IK end-effector targets, root translation and action detection, which are position-type signals.

**MediaPipe path:** it has no rotations, so keep landmark→bone solving. Improve it with:
- wrist twist from hand landmarks (wrist, index MCP, pinky MCP), if the hand model runs,
- foot orientation from heel/toe landmarks,
- spine distribution weights,
- the same post-FK layers.

MediaPipe world landmarks are metres with the origin at the hip midpoint ([Pose Landmarker docs](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker)). They give no absolute depth, so root motion comes from 2D image position plus scale.

---

## 4. Motion-quality techniques

### 4.1 Low-latency filtering and latency hiding

- **One-euro filter:** adaptive low-pass whose cutoff rises with speed: low jitter when still, low lag when fast. It is the right default for both positions and angles ([Casiez et al., CHI 2012, repo](https://github.com/casiez/OneEuroFilter)). InstantHMR already applies it in angle space with wrap-around ([smoothing.py](../../vendor/InstantHMR/instanthmr/smoothing.py)).
- **Prediction:** LaViola showed double-exponential-smoothing predictors match Kalman/EKF predictive tracking at ~135× lower cost, evaluated at 50-100 ms prediction horizons ([EGVE 2003 paper](https://www.eecs.ucf.edu/~jjl/pubs/vr2003_laviola.pdf), [IEEE VR 2003 experiment](https://www.eecs.ucf.edu/~jjl/pubs/kfvsexp_final_laviola.pdf)). InstantHMR's `alpha-beta` mode is a constant-velocity predictor-corrector of the same family ([smoothing.py](../../vendor/InstantHMR/instanthmr/smoothing.py)).
- **Tracking spring:** a spring that blends toward target position, velocity and acceleration reproduces the input exactly when it is clean and removes discontinuities when it isn't. A dt-invariant exact-damper form exists ([Holden, Perfect Tracking with Springs](https://theorangeduck.com/page/perfect-tracking-springs)). Background on damper/spring half-life parameterisation is in [Spring-It-On](https://theorangeduck.com/page/spring-roll-call).
- **Learned smoothing** (SmoothNet) needs a sliding window of future frames. The authors say this limits real-time use, though the repo provides 8-frame windows ([paper](https://arxiv.org/abs/2112.13715), [repo](https://github.com/cure-lab/SmoothNet), Apache-2.0). An 8-frame window is 320 ms at 25 fps, so it is unusable for us.
- **Timestamps:** `requestVideoFrameCallback` metadata exposes `captureTime` for local camera frames ([MDN](https://developer.mozilla.org/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback)). Chromium's own tests consider it too unreliable to test ([WPT](https://chromium.googlesource.com/external/w3c/web-platform-tests/+/refs/tags/merge_pr_45876/video-rvfc/request-video-frame-callback-webrtc.https.html)), so fall back to `now`/`mediaTime` when it is missing. Our camera source already uses rVFC ([camera.js:52-53](../../web/src/sources/camera.js)).

**Rec (client pipeline per joint, in rotation space):**

1. Take the server-filtered MHR params, keeping the server one-euro.
2. Estimate angular velocity from the last two samples, using the exponential-map difference ([Holden, exp map & angular velocity](https://theorangeduck.com/page/exponential-map-angle-axis-angular-velocity)).
3. At render time `t`, extrapolate to `t + display_lead` from `tCapture`. Clip the horizon to ≤ 60 ms and the angular speed to a per-joint max, to avoid overshoot on reversals such as the end of a punch.
4. Feed that target to a critically damped tracking spring with a short half-life: ~20-30 ms for hands, ~40-60 ms for spine/root.
5. Remove the client positional `PoseFilter` and the exponential slerp for the HMR path.

Expected effect: perceived lag drops from roughly "tracker + 40 ms hold + ~40 ms smoothing" to roughly "tracker − prediction". Measure it (section 7).

### 4.2 Two-bone IK for arms and legs

- Analytic two-joint IK is closed-form: solve the elbow/knee angle from the law of cosines, then rotate the root joint toward the target. It needs no iteration. Holden's version gives clean code and a pole/side-vector choice ([Simple Two Joint IK](https://theorangeduck.com/page/simple-two-joint)).
- In his foot-locking solver he softly clamps the target to max extension with a "softening" distance to prevent the hyper-extension snap ([IK & foot locking](https://theorangeduck.com/page/inverse-kinematics-foot-locking)).
- three.js ships `CCDIKSolver` (iterative, one bone at a time; fewer iterations are faster but less precise) ([docs](https://threejs.org/docs/pages/CCDIKSolver.html)). Use analytic IK for limbs instead.

**Rec:**
- Analytic two-bone IK on both legs (foot locking) and both arms.
- Arm targets = shoulder + (tracked wrist − tracked shoulder) × (avatar arm length / player arm length). This makes a full-extension punch reach full extension on the hero.
- Pole = the tracked elbow/knee direction from FK, so IK only corrects reach, not style.
- Keep wrist orientation from FK.

### 4.3 Foot locking and ground contact

Holden's 2026 method ([article](https://theorangeduck.com/page/inverse-kinematics-foot-locking), [MIT code](https://github.com/orangeduck/GenoView-InverseKinematics)):

- Contact = toe speed below ~0.1-0.5 m/s **and** toe height under ~0.1 m, cleaned with a ~5-frame majority filter.
- Lock the toe at the input position projected to ground height.
- Release when contact ends or output drifts beyond `unlockDistance`.
- Blend lock/unlock offsets with cubic inertialization over `blendTime`.
- Solve hip-knee two-bone IK to the heel, then orient the heel toward the toe and keep the toe above ground. Lock the toe rather than the heel.

PhysCap shows learned contact detection from 2D keypoints (heel and forefoot), fed to a PD-controlled simulated character, removes jitter, foot sliding and floor penetration at 25 fps ([PhysCap](https://vcai.mpi-inf.mpg.de/projects/PhysCap/), [arXiv](https://arxiv.org/abs/2008.08880)).

**Rec:**
- Port the GenoView solver to JS.
- Contact signals: InstantHMR heel and big-toe keypoints (indices 15, 17, 18, 20 per [skeleton.py](../../vendor/InstantHMR/instanthmr/skeleton.py)), using velocity in camera space and height above a **calibrated floor plane**. Fit the plane from both feet during the calibration hold, and refine it slowly while both feet are in contact.
- Force both feet unlocked during a detected jump.
- If a locked foot is out of reach, lower the pelvis first (bent knees look better than stretched legs), then release the lock.
- This replaces [retarget.js:173-181](../../web/src/retarget.js).

### 4.4 Root motion and hip height

- **Rec, horizontal:** tracked hip (x, z) relative to calibration × arena scale. Apply a dead-zone and heavier filtering on z, because monocular depth is the noisiest axis. InstantHMR's own filter gives `cam_trans` a lower cutoff (0.6 Hz) than joints ([smoothing.py FIELDS](../../vendor/InstantHMR/instanthmr/smoothing.py)).
- **Rec, vertical:** use the *relative* hip drop/rise × hip-height ratio for squats and jumps, then let foot IK decide the final pelvis height while grounded. During airtime, follow the tracked hip curve, optionally exaggerated (anime hang-time) by a gameplay curve.
- **Rec, stepping:** pass side steps through as root motion, with locked feet producing visible steps. If legs are untracked, synthesize the steps procedurally or with motion matching (4.9).

### 4.5 Bone-length normalization

- Rotation-copy retargeting is already length-invariant. Only position signals need scaling: root, IK targets, contact heights.
- pixiv scales hip translation by the hip-height ratio ([loadMixamoAnimation.js](https://github.com/pixiv/three-vrm/blob/dev/packages/three-vrm/examples/humanoidAnimation/loadMixamoAnimation.js)).
- NaturalMotion's Kinect retargeter used an "offset rig" that moves rig joints to where the tracker's joints really are (Kinect "hips" sit in the abdomen), then retargets ([MCV](https://www.mcvuk.com/development/kinect-retargeting)).

**Rec:**
- Measure the player's segment lengths during calibration. Better still, use the MHR skeleton-scale parameters 136:204 and `shape_params`, which encode them.
- Store per-chain ratios against the VRM.
- Mind the keypoint-vs-joint offset: InstantHMR "hip" keypoints are surface/landmark points, not MHR joint centres. Use MHR joints for rotations and keypoints only for contacts and targets.

### 4.6 Joint limits and twist distribution

- Express rotations relative to the reference pose. Use swing-twist decomposition (twist about the bone axis plus swing) for tighter, more natural limits, and softly project out-of-range rotations with a tanh falloff ([Holden, Joint Limits](https://theorangeduck.com/page/joint-limits)).
- MHR ships per-parameter limits in `rig.npz` ([_torch_rig.py](https://github.com/facebookresearch/MHR/blob/main/mhr/_torch_rig.py)).
- NaturalMotion distributed a single tracked torso rotation across spine joints with user weights. It also shifted rotation from hips to spine so the hips don't rotate when the spine should bend ([MCV](https://www.mcvuk.com/development/kinect-retargeting)).

**Rec:**
- Clamp in MHR parameter space with its own limits, then apply swing-twist limits on VRM elbows/knees (hinge, no hyper-extension) and the neck.
- Split twist: forearm gets ~50 % of wrist twist; upperArm keeps shoulder twist.
- Spine: distribute chest-relative-to-hips rotation over `spine/chest/upperChest` at about 0.3/0.35/0.35 when using keypoints. MHR's own spine joints already do this.

### 4.7 Low-confidence and occluded joints

- NaturalMotion transitioned to default animation on poor tracking and ignored sudden large joint jumps ([MCV](https://www.mcvuk.com/development/kinect-retargeting)).

**Rec:**
- Per-joint weight `w = smoothstep(c_lo, c_hi, conf)` with hysteresis.
- Low weight → hold the last good *local* rotation, decaying over ~0.3 s toward the procedural/idle layer.
- Reject single-frame angular jumps above a per-joint max speed (outlier gate) before the filter.
- Legs out of frame for more than 0.5 s: switch the lower body to procedural mode (4.8/4.9) and inertialize the switch.
- InstantHMR always outputs a full plausible MHR pose, so its legs degrade more gracefully than MediaPipe's. Still gate on keypoint confidence and image bounds.

### 4.8 Layering tracked pose with authored and procedural animation

- **Intent over imitation:** "gamers don't always want hero characters to track their motions – they want them to track their intentions" ([MCV/NaturalMotion](https://www.mcvuk.com/development/kinect-retargeting)).
- Dance Central-style designs teach the gesture with visual and audio feedback rather than mapping raw motion ([Engadget via search](https://www.engadget.com/tag/montreal-international-games-summit/), [Tom's Hardware GDC 2011](https://www.tomshardware.com/reviews/game-developers-conference-gdc-2011-world-of-warcraft,2882-2.html)).
- **Inertialization:** blend between sources by decaying the offset at the switch, rather than cross-fading two live poses ([Holden, inertialization transition cost](https://theorangeduck.com/page/inertialization-transition-cost), [inertial easing](https://theorangeduck.com/page/inertial-easing)).

**Rec, layer stack (bottom → top):**
1. Base: authored idle/stance/locomotion. Breathing and weight shift keep the hero alive when the player stands still.
2. Tracked: MHR → VRM rotations, per-bone weight = confidence × mask (e.g. arms 1.0, spine 0.8, legs 1.0 when visible, else 0).
3. Action accents: on `punchLeft` etc., blend in an authored punch arc *additively* or by short override (~150-250 ms), inertialized in and out. The same goes for kick snaps, jump take-off/landing (squash on landing, hang-time), and fists.
4. IK/contacts: foot locks, punch reach, and gameplay targets such as hitting an enemy.
5. Procedural/secondary: hit reactions (additive spring impulses on spine/head), hit-stop, look-at, VRM spring bones (hair/cloth, with v3.6.0 angle limits per [three-vrm releases](https://github.com/pixiv/three-vrm/releases)).

### 4.9 Motion matching and physics

- **Motion matching:** searches a pose/feature database each frame for the clip segment best matching the current state plus desired trajectory ([Clavet, GDC 2016](https://www.gdcvault.com/play/1022985/Motion-Matching-and-The-Road)). It has been applied to VR avatars driven by sparse tracking ([Ponton et al. 2023](https://arxiv.org/pdf/2310.05215)). Holden's MIT reference implementation covers learned motion matching ([orangeduck/Motion-Matching](https://github.com/orangeduck/Motion-Matching), [article](https://theorangeduck.com/page/learned-motion-matching)).
  **Rec:** phase 3 only, for the lower body when legs are untracked: query on tracked hip velocity, side-step intent and foot-contact phase. A small database (idle, side-step, back-step, crouch, jump) is enough.
- **Physics characters:**
  - PhysCap (PD-controlled character, 25 fps) and Neural PhysCap (learned PD gains) fix contacts and jitter ([PhysCap](https://vcai.mpi-inf.mpg.de/projects/PhysCap/), [Neural PhysCap](https://arxiv.org/pdf/2105.01057)).
  - PHC drives a simulated humanoid from a live 30 fps webcam pipeline and recovers from falls, but uses an RL policy in a GPU simulator ([paper](https://arxiv.org/abs/2305.06456), [repo](https://www.github.com/ZhengyiLuo/PHC)).
  - In the browser, Rapier JS exposes joint motors as PD controllers (`configureMotorPosition(target, stiffness, damping)`) and multibody joints ([Rapier docs](https://rapier.rs/docs/user_guides/javascript/joints)), Apache-2.0 (`npm view @dimforge/rapier3d-compat`).

  **Rec:** do not run full-body tracking through an active ragdoll; it adds lag and instability. Use physics only for knock-downs and big hit reactions (ragdoll or PD blend for ~0.5-1 s), then inertialize back to tracked.

---

## 5. Hands and face from webcam

### 5.1 What MediaPipe offers (web, `@mediapipe/tasks-vision`)

| Task | Output | Notes |
|---|---|---|
| Hand Landmarker | 21 landmarks per hand plus world landmarks (metres, origin at hand centre), and handedness. Handedness is from the subject's view, so mirrored input flips it. In video mode, palm detection reruns only when tracking is lost. | Pixel 6 pipeline: 17.1 ms CPU / 12.3 ms GPU ([docs](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker)) |
| Face Landmarker | 478 landmarks, **52 blendshapes** (`outputFaceBlendshapes`), 4×4 facial transformation matrix (`outputFacialTransformationMatrixes`). `*Left/*Right` are from the subject's view. | No latency table published ([docs](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker)) |
| Holistic Landmarker | Pose 33 + world, face 478 (+ optional 52 blendshapes), 21 per hand + world. Web supports IMAGE/VIDEO modes only. | No latency table ([docs](https://developers.google.com/edge/mediapipe/solutions/vision/holistic_landmarker)) |
| Pose Landmarker | 33 landmarks + world landmarks (metres, hip-midpoint origin), visibility and presence. Lite/full/heavy models. | No current latency table ([docs](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker)). Original BlazePose paper era: lite fastest, heavy slowest ([TF blog](https://blog.tensorflow.org/2021/05/high-fidelity-pose-tracking-with-mediapipe-blazepose-and-tfjs.html)) |

### 5.2 Mapping to VRM

- **VRM 1.0 expression presets:**
  - emotions: `happy, angry, sad, relaxed, surprised`
  - lip sync: `aa, ih, ou, ee, oh`
  - blink: `blink, blinkLeft, blinkRight`
  - gaze: `lookUp/Down/Left/Right`
  - `neutral`

  It also has custom expressions, `overrideBlink/LookAt/Mouth` (none/block/blend), and `isBinary` ([VRM 1.0 expressions spec](https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm-1.0/expressions.md)). Models with "Perfect Sync" carry all 52 ARKit shapes as custom expressions; XR Animator supports these ([README](https://github.com/ButzYung/SystemAnimatorOnline)).
- **Rec, face mapping:**
  - `blinkLeft/Right` ← `eyeBlinkLeft/Right` (swap if mirrored)
  - `aa` ← `jawOpen`
  - `ou`/`oh` ← `mouthPucker`/`mouthFunnel`
  - `ee`/`ih` ← `mouthStretch*`/`mouthSmile*` mix
  - `happy` ← `mouthSmile*` average
  - `surprised` ← `browInnerUp` + `eyeWide*`
  - Gaze ← `eyeLook*` into `vrm.lookAt`.
  - Head/neck rotation from the face transform matrix, blended 50/50 into neck/head on top of the body pose. It is much more stable than nose/ear landmarks ([retarget.js:113-132](../../web/src/retarget.js)).
  - Pass each channel through a one-euro filter with remapped ranges (dead-zone + gain), because anime faces read better with snappier, exaggerated expressions.
- **Rec, fingers:** per finger, compute flexion at each joint from the angle between consecutive segments of the 21 hand landmarks. Rotate the VRM finger bones about their local bend axis, with limits of 0-90° for proximal/intermediate and 0-70° for distal; the thumb needs its own two-axis mapping. For a fighting game, **classifying hand state** (fist / open / point / V) and blending authored hand poses looks better and survives motion blur. InstantHMR already outputs 20 hand keypoints per hand plus wrists ([skeleton.py](../../vendor/InstantHMR/instanthmr/skeleton.py)), and MHR has hand parameters, so start there before adding a browser hand model.

### 5.3 Cost of pose + hands + face in-browser on Apple Silicon

- No official per-device web latency numbers exist for any of these tasks on M-series Macs: the docs above publish none for pose, face or holistic.
- The closest real-world data point: XR Animator reaches "60fps visual rendering and 30fps body pose detection on a mediocre PC" using workers/OffscreenCanvas, and 20+ fps for pose+fingers on a GTX 1650 ([README](https://github.com/ButzYung/SystemAnimatorOnline)).
- **Rec:** with InstantHMR doing the body, run **Face Landmarker only** in the browser (GPU delegate, in a Worker, 30 fps), plus Hand Landmarker on demand. Benchmark on this Mac before committing: log `detectForVideo` ms and frame-drop rate for (a) pose full, (b) face, (c) hands ×2, (d) holistic, each alone and combined, while the three.js scene renders.

---

## 6. Recommended architecture

```
camera (rVFC, tCapture)
 ├─► InstantHMR server (25 fps): detector → HMR + fit → one-euro on mhr_params → JSON {j3d, j2d, mhr[204], conf}
 └─► Browser Worker: Face Landmarker (30 fps) [+ Hand Landmarker on demand]

main thread, per tracker frame:
  A. decode → outlier gate → keep raw copy for ActionDetector (light 1€ on positions only, high cutoff)
  B. JS MHR FK → ~22 world quats → camera→three → (mirror) → rest-align → per-joint confidence weights
  C. contact detector (toe/heel speed + height vs calibrated floor), floor-plane refine

per render frame (60-120 Hz):
  1. predict each joint rotation to now+lead (≤60 ms, speed-clamped) from last two filtered samples
  2. tracking spring per joint (half-life 20-60 ms by joint group)
  3. joint limits (MHR param limits → VRM swing-twist limits)
  4. layer blend: base idle/locomotion ◄ tracked (weights) ◄ action accents (inertialized)
  5. root: horizontal from tracked hips (deadzone on z), vertical relative × hip ratio
  6. IK: arm reach (two-bone, length-normalised), foot locking + leg two-bone IK + pelvis drop
  7. face: blendshapes → VRM expressions, face matrix → neck/head additive; hand-state → hand poses
  8. procedural: hit reactions, look-at; vrm.update(dt) (spring bones) → render
```

**Latency budget (Rec, targets to measure against):**

| Stage | Budget |
|---|---|
| Camera exposure + USB + decode | Measure with rVFC `captureTime` where available |
| Encode + WS + InstantHMR + WS back | ~30 ms capture-to-screen today (project measurement) |
| Client filtering | ≤ 10 ms equivalent lag (spring) minus ~40-60 ms prediction lead |
| Render | 1 frame (8-16 ms) |
| **Goal** | Perceived motion-to-photon ≤ 50 ms for hands, and action events fired ≤ 1 tracker frame after the motion peak |

**Reusable open-source code:**

| Code | Use | Licence |
|---|---|---|
| [`@pixiv/three-vrm`](https://github.com/pixiv/three-vrm) v3.6.0 + humanoidAnimation example | VRM, normalized bones, retarget formula, spring bones, expressions | MIT |
| [MHR `_torch_rig.py` + `rig.npz`](https://github.com/facebookresearch/MHR) | FK, parameter transform, joint names, limits → port to JS | Apache-2.0 (code; check the asset terms when downloading) |
| [InstantHMR `smoothing.py`](../../vendor/InstantHMR/instanthmr/smoothing.py) | Angle one-euro/alpha-beta (already in use server-side) | See [vendor/InstantHMR/LICENSE](../../vendor/InstantHMR/LICENSE); weights are SAM License |
| [orangeduck/GenoView-InverseKinematics](https://github.com/orangeduck/GenoView-InverseKinematics) | Foot contact, locking, inertialization, two-bone IK (C → port) | MIT |
| [orangeduck/Motion-Matching](https://github.com/orangeduck/Motion-Matching) | Springs, inertialization, motion matching reference | MIT |
| [`@mediapipe/tasks-vision`](https://www.npmjs.com/package/@mediapipe/tasks-vision) 1.2.3 | Face/hand/pose landmarkers | Apache-2.0 |
| [`@dimforge/rapier3d-compat`](https://rapier.rs/docs/user_guides/javascript/joints) 0.21 | Optional ragdoll/PD for hit reactions | Apache-2.0 |
| three.js `CCDIKSolver` | Only if a long chain is needed (tail, cloth) | MIT (three.js) |
| Kalidokit / XR Animator / MiKaPo | Read for ideas only | MIT (deprecated) / CC BY-NC-SA 4.0 / GPL-3.0 |

**Rec, build order:**
1. Server sends `mhr`. Build JS FK plus the validation test (3.3 step 10). Load a VRM and drive it with MHR rotations, without IK.
2. Remove the client double-smoothing and add prediction + tracking springs. Feed actions from the lightly filtered stream.
3. Foot contact + locking + leg IK + pelvis. Add arm reach IK.
4. Confidence weights, idle base layer, upper-body-only mode.
5. Action accents + hit reactions + hand-state poses. Face Landmarker → expressions.
6. Optional: motion matching for lower body, ragdoll for knock-downs, MediaPipe hands.

---

## 7. How to judge "acceptable" (measurable checks)

**Rec:**

- **Latency:** wave a hand in front of a 240 fps phone camera pointed at both the player and the screen, and count frames between the real and avatar hand peaks. Also log per-stage timings (we already have a timing HUD, [main.js:395-423](../../web/src/main.js)).
- **Jitter:** with the player standing still for 5 s, measure RMS angular velocity of the head, hands and hips on the avatar. Use the same metric InstantHMR used to tune its filters ([smoothing.py](../../vendor/InstantHMR/instanthmr/smoothing.py)).
- **Foot skate:** while a foot is in contact, measure its horizontal world speed on the avatar. Target ≈ 0.
- **Overshoot:** in a punch-and-stop test, measure peak wrist overshoot beyond the tracked stop position. This bounds the prediction horizon.
- **Fidelity:** on recorded sessions, compute JS FK joints vs InstantHMR `joints_3d` error (convention check) and avatar wrist-direction error vs the tracked direction.
- **Visual A/B:** record the same session through old and new pipelines side by side, plus XR Animator on the same footage as a reference bar.

---

## 8. Open questions / to verify

- The exact index layout of the 204 MHR parameters (hands, face, scales) from `rig.npz` `parameter_names`. We only have InstantHMR's `3:6` root and `6:68` body ([smoothing.py](../../vendor/InstantHMR/instanthmr/smoothing.py)).
- MHR rest pose (A-pose vs T-pose) is not stated in the paper ([paper](https://arxiv.org/html/2511.15586v3)). Measure it from FK with zero pose.
- The licence of the MHR *asset* files (rig/LOD npz) vs the Apache-2.0 code: check the download terms.
- Whether MediaPipe 1.x changed web result field names in practice. The release notes say aliases are preserved ([releases](https://github.com/google-ai-edge/mediapipe/releases)).
- Real M-series costs for Face/Hand/Holistic in a Worker alongside our renderer (section 5.3 benchmark).
