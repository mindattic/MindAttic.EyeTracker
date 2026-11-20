# MindAttic EyeTracker for Unity

A Unity display client for the MindAttic.EyeTracker bridge. The browser tracker page owns the webcam
and works out where you are looking. The bridge relays that over WebSocket. This package receives it
in Unity, so a game can use gaze without touching a camera.

It implements version 1 of the wire format in [`docs/PROTOCOL.md`](../../docs/PROTOCOL.md) and
mirrors the reference display client, `RemoteGazeSource` in `src/remote.ts`.

## Install

Add the package by path in `Packages/manifest.json`. From a sibling repo in the MindAttic workspace:

```json
"com.mindattic.eyetracker": "file:../../MindAttic.EyeTracker/unity/com.mindattic.eyetracker"
```

It needs Unity 6000.0 or later and no third-party packages. JSON is parsed with `JsonUtility`.

## Run

1. Start the bridge: `cd D:\Projects\MindAttic\MindAttic.EyeTracker; npm run build; npm run bridge`.
2. Open the tracker page, `http://localhost:8787/tracker/`, and allow the camera.
3. Press Play in Unity.

## Use

Add a `GazeTracker` to a GameObject. It connects while enabled.

```csharp
using MindAttic.EyeTracker;
using UnityEngine;

public class LookAtIt : MonoBehaviour
{
    public GazeTracker gaze;

    void Update()
    {
        if (gaze.Confidence <= 0f) return;                         // no face, or a blink
        Ray ray = Camera.main.ScreenPointToRay(gaze.ScreenPoint);  // Unity pixels, y up
        Vector2 n = gaze.Normalized;                               // 0..1, y down, as on the wire
    }
}
```

| Type | What it is |
| --- | --- |
| `GazeSample` | One `gaze` message: `t`, `x`, `y`, `rawX`, `rawY`, `confidence`, `face`, `blink`, `calibrated`. |
| `GazeBridgeClient` | Plain C#, no MonoBehaviour. A `ClientWebSocket` on a background task. Says `hello` as a `display`, reconnects every 1.5 seconds, keeps the latest sample and the tracker count where any thread can read them, and runs the calibration requests (`BeginCalibration`, `CollectAsync` with an optional `headMoving`, `FinishAsync`, `ClearCalibration`, `Hint`). |
| `GazeTracker` | MonoBehaviour. `url` (default `ws://localhost:8787/gaze`), `room`, `Latest`, `HasTracker`, `Connected`, `Confidence`, `Normalized`, `ScreenPoint`, a `Sample` event raised on the main thread in `Update`, and `Hint` / `HintScreenPoint`. |
| `GazeCalibrator` | MonoBehaviour. `Begin()` runs the nine-point calibration, the follow-the-dot pass and the head-movement steps over the whole screen with IMGUI and reports a `GazeCalibrationResult` (`ok`, `crossError`, ...) through `Completed` and `LastResult`. Esc cancels. |

### Coordinates

On the wire, gaze is a point in normalized display space: `(0, 0)` is the top-left corner and
`(1, 1)` the bottom-right, y downward. `GazeTracker.Normalized` is that point unchanged.
`GazeTracker.ScreenPoint` is the same point in Unity screen pixels, where y is upward.

`Normalized` holds its last good value while `Confidence` is zero, as the protocol asks. Check
`Confidence` before you act on the point.

### Mouse stand-in

With `useMouseFallback` on (the default), the mouse pointer plays the part of the gaze whenever no
tracker is connected, so a game stays playable without a camera. `UsingMouse` says when that is
happening. Turn it off to get no gaze at all until a tracker arrives.

### Calibration

The display draws the targets, because only it knows its own screen. The tracker collects the eye
samples, because only it has the camera. `GazeCalibrator` does the display's half: nine targets
(the centre, the four corners and the four edge midpoints, each 8% in from the edge), 700 ms for
the eye to land, then 900 ms of sampling on each.

After the dots comes a **follow-the-dot** pass, which improves accuracy more than anything else. The
dot moves slowly round the whole screen for 24 seconds, along x = 0.5 + 0.43 sin(2 pi t / 8 s),
y = 0.5 + 0.41 sin(2 pi t / 6 s + pi / 2), and the user follows it with their eyes, head still.
Every 200 ms the calibrator sends a `collect` of 200 ms with `"headMoving": true` at the position
the dot will have at the middle of that slice, and waits for the answer before sending the next.
Set `pursuit` to false to skip it, or change `pursuitSeconds`.

Then come three **head-movement steps**, drawn with an amber dot and an instruction on
screen: keep your eyes on the dot and move your head. They are (0.5, 0.5) for 6000 ms, then
(0.18, 0.22) and (0.82, 0.78) for 4000 ms each, with 1200 ms before each for the eye to arrive.
Each is sent as a `collect` with `"headMoving": true`. These steps teach the tracker where the
camera is and how to allow for head movement; without them the calibration drifts when the head
moves. Set `headMovement` to false to skip them.

### Hints

After a calibration, tell the tracker whenever you know where the user is looking, for example a
button they just clicked. The tracker adds the point to its fit and keeps improving.

```csharp
gaze.HintScreenPoint(Input.mousePosition);        // Unity pixels, y up
gaze.Hint(new Vector2(0.4f, 0.6f), 0.5f);         // normalized, y down, with a weight
```

This sends `{ "type": "calib", "op": "hint", ... }`. There is no answer.

The calibration is relative to the screen area the targets covered. Calibrate again after resizing
or moving the window.

## Limits

- **WebGL builds do not work.** `System.Net.WebSockets.ClientWebSocket` is not available in the
  browser. A WebGL build would need a JavaScript plugin that uses the browser's own WebSocket.
- The client speaks `ws://`. For `wss://` on port 8788 the bridge's certificate must be trusted by
  the machine running Unity.
- One tracker per room is assumed. With several, the latest sample is whichever arrived last.
