# MindAttic Eye Tracker for Unreal

A runtime plugin that gives an Unreal game the gaze point from MindAttic.EyeTracker.

The camera stays in the browser: the tracker page (`/tracker/`) finds the eyes and sends the gaze
point to the bridge, and the bridge relays it to every display in the same room. This plugin is a
display. It speaks version 1 of the wire format in [`docs/PROTOCOL.md`](../../docs/PROTOCOL.md) over
a WebSocket, using the engine's own WebSockets module. It needs no third-party code.

Built against Unreal Engine 5.8.

## Add it to a project

Either copy `MindAtticEyeTracker/` into the project's `Plugins/` folder, or point the project at
this folder in its `.uproject`:

```json
"Plugins": [{ "Name": "MindAtticEyeTracker", "Enabled": true }],
"AdditionalPluginDirectories": ["../MindAttic.EyeTracker/unreal"]
```

C++ modules that use it add `"MindAtticEyeTracker"` to their `Build.cs` dependencies.

## Run the other half

```
cd D:\Projects\MindAttic\MindAttic.EyeTracker
npm run build
npm run bridge
```

Then open `http://localhost:8787/tracker/` in a browser and allow the camera. A phone on the same
network can be the tracker too; the bridge prints its address.

## Use it

`UGazeTrackerSubsystem` is a game instance subsystem, so it is there in every game without setup.
Everything below is callable from Blueprint as well.

```cpp
#include "GazeTrackerSubsystem.h"

UGazeTrackerSubsystem* Gaze = GetGameInstance()->GetSubsystem<UGazeTrackerSubsystem>();
Gaze->Connect();                      // ws://localhost:8787/gaze, room "default"

// Each frame:
if (Gaze->IsTracking())               // a tracker is present, the sample is fresh, confidence > 0
{
    FVector2D Normalized = Gaze->GetGazePoint();     // 0..1, origin top-left, Y down
    FVector2D Pixels = Gaze->GetViewportPoint();     // the same point in viewport pixels
}
```

| Call | What it does |
| --- | --- |
| `Connect(Url, Room)` | Connects and stays connected. If the bridge is not running yet, or the connection drops, it tries again every `ReconnectSeconds` (1.5 by default). |
| `Disconnect()` | Closes the connection and stops reconnecting. |
| `IsConnected()` | The WebSocket to the bridge is open. |
| `GetTrackerCount()` | Trackers in the room. Show "waiting for a tracker" while it is zero. |
| `GetLatest()` | The last `FGazeSample`, exactly as received. |
| `IsTracking(MaxAge)` | The eyes are tracked right now. |
| `GetGazePoint()` | The gaze point, normalized. It holds the last good point while the confidence is zero (a blink, or no face). |
| `GetViewportPoint()` | `GetGazePoint` in viewport pixels. |

Delegates: `OnGaze` (every sample), `OnPeersChanged` (trackers, displays), `OnConnectionChanged`,
`OnCalibrationResult`.

The gaze point covers whatever area the calibration targets covered. Draw the targets across the
whole viewport and the point maps to the whole viewport.

## Calibration

The game draws the targets, because only it knows its own screen. The tracker collects the eye
samples, because only it has the camera.

`UGazeCalibrator` runs the standard flow (nine targets, 700 ms for the eye to land, 900 ms of
sampling each, then the fit). It draws nothing itself; the game's HUD reads the current target every
frame.

```cpp
#include "GazeCalibrator.h"

// Keep it in a UPROPERTY so it is not collected.
Calibrator = NewObject<UGazeCalibrator>(this);
Calibrator->Start(Gaze);

// In the HUD, each frame:
if (Calibrator->IsActive())
{
    // Cover the game and pause it.
    if (Calibrator->HasTarget())
    {
        FVector2D Target = Calibrator->GetCurrentTarget();      // 0..1, multiply by the viewport size
        double Fill = Calibrator->GetCollectProgress();         // 0..1, grow the dot's centre with it
    }
    else
    {
        FString Text = Calibrator->GetStatusText();             // "Working it out...", then the outcome
    }
}
```

`OnFinished` fires with the `FGazeCalibrationResult`. `CrossError` is the expected error in display
units: 0.03 means about 3% of the screen.

To run the steps yourself, the subsystem has `CalibBegin`, `CalibCollect(X, Y, Ms, OnCollected)`,
`CalibFinish` and `CalibClear`. Each `collect` and `finish` carries an id and waits for the answer
with that id: `Ms` plus 3 seconds for a collect (then it reports zero samples), 8 seconds for a
finish (then it reports a failure). C++ callers can use `CalibCollectNative` and `CalibFinishNative`
with lambdas.

## Files

| File | Contents |
| --- | --- |
| `Public/GazeTypes.h` | `FGazeSample`, `FGazeCalibrationResult` |
| `Public/GazeTrackerSubsystem.h` | The connection, the latest sample, the calibration calls |
| `Public/GazeCalibrator.h` | The nine-point flow |

## Limits

- Text frames only, protocol version 1. Unknown message types and fields are ignored.
- `ws://` to a bridge on the same machine or network. `wss://` goes through the engine's WebSockets
  module and its certificate checks; the bridge's self-signed certificate will be refused unless
  the engine is told to trust it.
- Resizing the window after calibrating makes the calibration wrong. Calibrate again.
