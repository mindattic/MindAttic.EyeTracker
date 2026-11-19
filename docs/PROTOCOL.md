# Bridge protocol, version 1

The bridge (`bridge/server.mjs`) connects **trackers** to **displays**.

- A **tracker** owns a camera and produces gaze. Today that is the tracker page (`/tracker/`) running
  in a browser on a computer or a phone.
- A **display** shows something and consumes gaze: a browser game, a Unity game, an Unreal game.

Every client opens a WebSocket to `ws://<host>:8787/gaze` (or `wss://<host>:8788/gaze`) and sends
one `hello`. After that the bridge forwards every text frame a tracker sends to all displays in the
same room, and every text frame a display sends to all trackers in the same room. The bridge does
not interpret those frames, so the protocol can grow without changing it.

All messages are JSON objects in a text frame, with a string `type`. Unknown types and unknown
fields must be ignored.

## Coordinates

Gaze is a point in **normalized display space**: `(0, 0)` is the top-left corner of the display's
play area and `(1, 1)` the bottom-right, `x` to the right and `y` downward. The display decides what
that area is (usually its whole window) by where it draws the calibration targets. Unity and Unreal
clients convert to their own conventions (Unity's screen space has `y` upward).

## Messages

### `hello` (client to bridge, first frame)

```json
{ "type": "hello", "v": 1, "role": "display", "room": "default", "name": "MindPuck" }
```

`role` is `"tracker"` or `"display"`. `room` is optional (default `"default"`); use it to run more
than one tracker/display pair on a network. `name` is optional and only used in the bridge's log.

### `welcome` (bridge to the client that said hello)

```json
{ "type": "welcome", "v": 1, "id": "3", "room": "default", "trackers": 1, "displays": 1 }
```

### `peers` (bridge to everyone in the room, when someone joins or leaves)

```json
{ "type": "peers", "trackers": 1, "displays": 2 }
```

A display should show "waiting for a tracker" while `trackers` is zero.

### `gaze` (tracker to displays, once per camera frame, about 30 a second)

```json
{ "type": "gaze", "t": 81234.5, "x": 0.42, "y": 0.61, "rawX": 0.43, "rawY": 0.6,
  "confidence": 0.93, "face": true, "blink": false, "calibrated": true }
```

| Field | Meaning |
| --- | --- |
| `t` | Capture time in milliseconds on the tracker's clock. Only differences are meaningful. |
| `x`, `y` | Smoothed gaze point, clamped to 0..1. |
| `rawX`, `rawY` | Unsmoothed, unclamped estimate. Outside 0..1 when the user looks past the edge. |
| `confidence` | 0..1. Zero when no face is visible or during a blink. |
| `face` | A face was found in this frame. |
| `blink` | The eyes are closed; `x` and `y` repeat the last open-eye value. |
| `calibrated` | A fitted calibration is in use. `false` means the rough built-in mapping. |

A display should hold its last good point while `confidence` is zero rather than jump to the
repeated value's "new" timestamp.

### Calibration (display to trackers, and the answers)

The display draws the targets, because only it knows its own screen. The tracker collects the eye
samples, because only it has the camera.

1. `{ "type": "calib", "op": "begin" }` starts a new calibration.
2. For each target, the display draws it, waits about 700 ms for the eye to land, then sends
   `{ "type": "calib", "op": "collect", "id": 7, "x": 0.08, "y": 0.08, "ms": 900 }`.
   The tracker samples for `ms` milliseconds and answers
   `{ "type": "calib.collected", "id": 7, "samples": 26 }`. The display keeps the target visible
   until the answer arrives (allow `ms` plus a few seconds, then move on).
3. `{ "type": "calib", "op": "finish", "id": 8 }` fits the model. The tracker answers
   ```json
   { "type": "calib.result", "id": 8, "ok": true, "targets": 9, "samples": 190,
     "fitError": 0.021, "crossError": 0.034 }
   ```
   or `"ok": false` with a `reason`. `crossError` is the expected error on points the fit was not
   trained on, in display units (0.03 means about 3% of the screen).
4. `{ "type": "calib", "op": "clear" }` drops the calibration.

`id` is any number the display chooses; the answer carries it back. Nine targets is the default
pattern: the centre, the four corners and the four edge midpoints, each 8% in from the edge.

## Versioning

`v` in `hello` is the protocol version the client speaks. Additions that old clients can ignore do
not change the version. A change that breaks old clients will.
