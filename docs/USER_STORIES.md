---
codex: 1
project: MindAttic.EyeTracker
code: ET
layer: stories
status: living
updated: 2026-11-19
---
<!-- GENERATED from MindAttic.Tickets/data/Tickets.db by `tickets db render`. Do not edit: this file is rewritten from the database; change stories and tickets with the tickets CLI. -->

# MindAttic.EyeTracker — User Stories
> ✅ done (shipped & tested) · 🟡 partial · ⬜ planned. Every ✅ cites the test.

## Priority backlog
_Nothing recorded yet._

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
| ET-T6 | 2026-11-19 | feature | open | Expose and display the measured distance and angle between the face plane and the lens plane (gaze lab shows them live with the learned-sample count), and document how the model uses them | — |
