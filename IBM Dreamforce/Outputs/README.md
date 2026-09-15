# Missing video goes here

`REFERENCE-ONLY_instagram-reel_45s_2k_equalized.mp4` (45 s, 2560x1440, ~102 MB) belongs in
this folder. It is **not committed**: it is 102 MB (over GitHub's 100 MB file limit) and it is
third-party drone footage used for reference only, so it is not ours to redistribute.

Ask Alexei for the file, drop it here with exactly that name, and the post-storm flight works.
Everything else — the pre-storm clip, the five repair-plan renders, the detection caches — is
in the repo, so nothing needs re-running.

To use your own clip instead, point `video` in `app/flights.json` at it, then re-run:

    ./.venv/bin/python3 scripts/precompute.py --flight post-storm

...and update the timestamps in `app/scenes/post-storm.json` to match the new footage.
