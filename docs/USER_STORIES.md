---
codex: 1
project: MindAttic.Webcam
code: ET
layer: stories
status: living
updated: 2026-11-19
---
<!-- GENERATED from MindAttic.Tickets/data/Tickets.db by `tickets db render`. Do not edit: this file is rewritten from the database; change stories and tickets with the tickets CLI. -->

# MindAttic.Webcam — User Stories
> ✅ done (shipped & tested) · 🟡 partial · ⬜ planned. Every ✅ cites the test.

## Priority backlog
_Nothing recorded yet._


## Epic W — MindAttic.Webcam: core and modules
- **ET-US-W1 ⬜** As an app developer, I use one webcam library for camera access, face presence, head pose, gaze region and eye tracking, and get one integrity event stream, with no frames leaving the device.

## Tickets
> Permanent log of every change and fix — this repo's ticket system. Rows are append-only: never
> delete or reword one; only move its Status (open → closed / wont-do) and fill in Ref. Status is
> a word, not a glyph, so tickets don't count toward the story index. Keep this section last.

| ID | Date | Type | Status | Summary | Ref |
|---|---|---|---|---|---|
| ET-T1 | 2026-11-19 | docs | closed | Start the permanent ticket log in the ticket database | — |
| ET-T2 | 2026-11-19 | feature | closed | Webcam gaze library: MediaPipe iris/eye-white landmarks, calibration, smoothing, three.js demo, tests, a bridge server and Unity/Unreal clients (MAT-T160) | 194454e |
| ET-T3 | 2026-11-19 | fix | closed | Calibration ran fullscreen (5120x1440) but play happens in a 1920x1080 window, so vertical gaze only covered half the window: calibrate in screen space and map gaze into the current viewport; games calibrate over the window they play in | dd6968a |
| ET-T4 | 2026-11-19 | feature | closed | Gaze model that does not assume the camera is at the screen centre: 3D head pose (position, distance, direction) projected to the screen plane, camera offset and angle learned as constants at calibration, and a head-movement calibration step so head motion is compensated in real time | 699f85a |
| ET-T5 | 2026-11-19 | feature | closed | Remove jitter by averaging the samples of a steady look and centring on that; keep refining the calibration while in use (clicks and app hints are added to the fit), so accuracy improves the longer it runs | 0188123 |
| ET-T6 | 2026-11-19 | feature | closed | Expose and display the measured distance and angle between the face plane and the lens plane (gaze lab shows them live with the learned-sample count), and document how the model uses them | 196a12e |
| ET-T7 | 2026-11-19 | feature | closed | The gaze point does not land where the owner looks. Add a follow-the-dot (smooth pursuit) calibration pass that samples the whole screen densely, weight the head-movement samples so they cannot outvote the dots, and add an accuracy report in the gaze lab that can be copied out so tuning is driven by measurements | 10f8279 |
| ET-T8 | 2026-11-20 | fix | closed | gaze.test.ts: nine-dot calibration predicts unseen points to 0.059 error, over the 0.05 threshold (found by /tests) | test/gaze.test.ts > calibration with a still head > fits nine dots and predicts unseen points to within a few percent |
| ET-T9 | 2026-11-20 | fix | closed | gaze.test.ts: too-few-samples failure reason text no longer matches /targets/ (found by /tests) | test/gaze.test.ts > calibration with a still head > fails with a reason when too few targets had samples |
| ET-T10 | 2026-11-20 | fix | closed | gaze.test.ts: calibration error balloons to 0.199 (vs 0.06 threshold) when the head rests well off the camera axis (found by /tests) | test/gaze.test.ts > camera placement > copes with a head that rests well off the camera axis |
| ET-T11 | 2026-11-20 | fix | closed | steady.test.ts: FixationFilter no longer reports a small deliberate shift once several estimates agree on it (found by /tests) | test/steady.test.ts > FixationFilter > notices a small shift once several estimates agree on it |
| ET-T12 | 2026-11-20 | chore | closed | Rename the repo to MindAttic.Webcam: GitHub rename, local folder, ticket-database repo entry, npm name @mindattic/webcam (keep @mindattic/eyetracker as a compatibility re-export), update MindPuck references | 4eb07b3 |
| ET-T13 | 2026-11-20 | feature | closed | Restructure into a webcam core (device selection, permissions, frame loop, one shared MediaPipe FaceLandmarker) and modules; the existing calibration/gaze code becomes the subpath export @mindattic/webcam/eyetracking | 16dc996 |
| ET-T14 | 2026-11-20 | feature | closed | Presence module: face count, face absent, same-person-throughout check (in-memory landmark-geometry signature, never uploaded), lighting and framing quality warnings | f5bf66d |
| ET-T15 | 2026-11-20 | feature | closed | Calibration-free head pose and gaze-region module: on-screen versus off-screen left/right/up/down with dwell timing; brief upward or away glances are annotated as thinking, not suspicious | 9e5d865 |
| ET-T16 | 2026-11-20 | feature | closed | Unified integrity event stream (type, start, end, confidence, evidence summary) with a reading-pattern detector (repeated horizontal sweeps toward one off-screen region); privacy mode guarantees no frames leave the device | 89f84a2 |
| ET-T17 | 2026-11-20 | docs | open | docs/GAZE-AND-DECEPTION.md: what eye movement can and cannot tell (NLP eye-accessing cues debunked, gaze aversion as cognitive load, pupil limits on webcams, EU AI Act and BIPA constraints) and how the modules respect that | GAD-T25 |
