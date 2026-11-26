# BREAKLIGHT real-webcam playtest: how to run it

This page turns a playtest into **measurable regression data**: every session is recorded and can be replayed through
the current detector later. The plan and bars come from `qa-design-r3.md` (P0-1, P1-2).

## 1. Set up

- Use the target laptop and its own webcam, at chest height. The screen should be the only light source in a normally lit room.
- Mark 2 to 2.5 m of floor with tape. Put a phone on a tripod behind and to the side, so the video shows both the player and the screen.
- Start the game. Pick **one** tracker per player and write it on the sheet:

| Tracker | URL |
|---|---|
| InstantHMR (local server on port 8791, `server/`) | `/game.html?kiosk=1&record=1&debug=1&tracker=hmr` |
| MediaPipe (in-browser, no server) | `/game.html?kiosk=1&record=1&debug=1&tracker=mediapipe` |

- `record=full` also stores the raw 70-point InstantHMR keypoints, which makes files about 2x bigger. Use it only if you want the hand classification replayed too.
- `recordMB=128` raises the memory cap. The default is 64 MB, about 20 minutes. When the cap is reached, the oldest frames are dropped first.

When recording is on, a small **● REC m:ss · size · R save** badge shows at the top right.

## 2. Privacy

The recording holds only **body-pose numbers and game events**: joint positions, keypoints, MHR pose parameters, judgements and fps. It never contains camera images or audio.

- It stays in the browser's memory and is saved only as a local download on this machine. Nothing is uploaded.
- It still counts as body data, so tell each player it is recorded and delete the files when you are done.
- Never commit the files. If you keep them under `web/public/recordings/`, add that folder to `.gitignore`.

## 3. Per player (~6 min). Don't coach; answer only safety questions

1. The player walks up to the title. Note whether they find NEW PLAYER / PLAY with the hand cursor without help.
2. They go through the flash notice, calibrate, clear-space, the Awakening, the demo run and the results. Note whether they notice the booth.
3. Ask one question: *"What did you think the game measured about you?"*
4. For 2 players: walk out of frame mid-Act 2 for 30 s, then let someone else step in. This checks the abandoned-run reset.

**Saving.** Each results screen saves `breaklight-session-<date_time>.json.gz` to Downloads automatically. That file covers one player, from the previous save to their results. Press **R** at any time to save everything so far, for example before a reload or when someone abandons a run. The console prints a one-line summary for each save.

Rename each file `P<n>-<tracker>.json.gz`. You can also mark moments from the console: `blRecorder.mark('tripped on cable')`.

## 4. Write down by hand (the recording can't see these)

| Item | Note |
|---|---|
| Player | Height, clothes (loose or dark), glasses or long hair, seated? |
| Misses | For a sample of misses on video: did they **do the move** (not detected) or **not do it**? |
| Phantoms | A hit or judgement while the player was doing something else (a guard, a lean, waving) |
| Awakening | Where they looked lost; anything that read as confusing |
| Session | Did they reach and beat the boss? Did the booth trigger, and was the photo good? |
| Discomfort | Fatigue, dizziness, a flash complaint, bumping into anything |
| Title → run | Unprompted, without touching the keyboard? |
| "What did it measure?" | Their answer, word for word |

The recording captures the rest:

- the Awakening waits, with seconds and how each resolved;
- judgements per move, with errors;
- distance warnings, pauses and their reasons;
- knockdowns, session time, fps and tracker latency.

## 5. After the session: replay the recordings

```bash
node web/src/motion/replayBench.js ~/Downloads/P1-hmr.json.gz ~/Downloads/P2-mediapipe.json.gz
node web/src/motion/replayBench.js P1.json.gz --detector=path/to/candidate/actions.js   # A/B a detector change
node web/src/motion/replayBench.js P1.json.gz --notes --json=p1.json   # per-note table + machine-readable output
node web/src/motion/replayBench.js P1.json.gz --pipeline               # also run the full motion pipeline (jitter / skate metrics)
```

The bench feeds the recorded frames to a fresh detector, at the same timing as live, and prints:

- **detector parity**: the live detector events reproduced by the replay. It should be about 100 % when `actions.js` is unchanged. After a change, it shows how many events were gained and lost.
- **self-check**: the offline judge, run on the *live* events, must reproduce the live judge log.
- **per move**: notes, live hit rate and replay hit rate, plus the replay misses split into:
  - *not detected*: the limb clearly moved;
  - *not attempted*: nothing moved;
  - *untracked*: no body in the frame;
  - *wrong side*.

  It also prints the timing error (mean ± sd) and its shift against live.
- **phantoms**: strikes in play that no note used. *Stray* strikes per minute is the phantom rate.
- the **Awakening** waits (live seconds and how each resolved, and when the replayed detector first saw the exact move), fps, latency, pauses, knockdowns, and whether the player reached the boss.

The miss split is a heuristic. Check a sample against the phone video before you trust a "not detected" count.

To **watch a session again**:

- **Motion lab:** `/motion-lab.html?source=session&session=/recordings/P1.json.gz&from=60&to=120`
- **Game:** `/game.html?play=/recordings/P1.json.gz&tracker=demo&skip=title&notice=0` (only once the `?play=` wiring is in `main.js`)

In both cases, put the file under `web/public/recordings/` first. The game replay is visual only: it is a fresh run, not synchronised with the recorded chart.

## 6. Pass criteria (all must hold)

| Metric | Bar | Where from |
|---|---|---|
| Intended punches registered (video-verified) | ≥ 90 % | replayBench `punch` replay hit / (notes − not attempted − untracked), then video |
| Intended kicks, knees, ducks, jumps, dodges | ≥ 85 % each | same, per move |
| Phantom hits | ≤ 1 / min of play | replayBench stray/min, then video |
| Awakening median | ≤ 90 s | replayBench `awakening` |
| Awakening waits reaching *auto* (15 s) | ≤ 1 per player | replayBench `reached auto` |
| Players who reach the boss | 100 % | replayBench `reached boss` |
| Players who beat the Warden | ≥ 90 % | sheet and results |
| Unprompted title → run without the keyboard | ≥ 80 % | sheet |
| Demo session time | ≤ 5 min median | replayBench session seconds |
| Frame rate during the boss | ≥ 45 fps | replayBench `boss median` |
| Safety incidents (bumps, flash complaints) | 0 | sheet |
| "What did it measure?" mentions the body, skeleton or pose | ≥ 70 % | sheet |

## 7. After the bars

- **A move under its bar:** retune `web/src/actions.js` against these recordings. Re-run `node web/src/motion/triggerTest.js`, then `replayBench.js` on every session with `--detector=`, and compare gained and lost per move and the stray phantoms per minute. Keep the files as the regression set.
- **An Awakening wait that keeps reaching loose:** rewrite that section's coaching.
- Then repeat with 3 new people.
