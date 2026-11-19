# MindAttic.EyeTracker

Webcam eye tracking: where on the screen is this person looking?

It needs no special hardware. An ordinary webcam or a phone's front camera watches the eyes. The
library finds the irises and the eye corners (so, in effect, how much white shows on each side of
each iris), runs a short calibration, and from then on reports a gaze point about thirty times a
second.

It works in three places:

| Where | How |
| --- | --- |
| **Browser** | `@mindattic/eyetracker`, the TypeScript library in `src/`. Camera, tracking and calibration all run in the page. |
| **Unity** | The UPM package in `unity/com.mindattic.eyetracker`. The game receives gaze from a tracker page through the bridge. |
| **Unreal** | The plugin in `unreal/MindAtticEyeTracker`. Same arrangement. |

The first game built on it is [MindPuck](https://github.com/mindattic/MindPuck), with
[Unity](https://github.com/mindattic/MindPuck.Unity) and
[Unreal](https://github.com/mindattic/MindPuck.Unreal) versions.

## Try it

PowerShell:

```powershell
cd D:\Projects\MindAttic\MindAttic.EyeTracker
npm install
npm start
```

`npm start` builds the library, starts the bridge and opens the gaze lab at
`http://localhost:8787/demo/`. In the lab:

1. **Use this camera** and allow the camera. A preview shows your irises and eye corners marked.
2. **Calibrate** and look at each of the nine dots until it fills.
3. Look around. The tiles you look at lift toward you.
4. **Check accuracy** shows eight new targets and reports the average error in pixels.

**Use a phone** does the same with a phone's camera: the lab prints the address to open on the
phone. **Simulate with the mouse** runs everything with the pointer in place of your eyes.

The bridge prints its addresses when it starts:

```
  On this computer
    Tracker page (uses this computer's webcam):  http://localhost:8787/tracker/
    Demo and accuracy check:                     http://localhost:8787/demo/
    Games connect to:                            ws://localhost:8787/gaze

  On a phone on the same Wi-Fi (accept the certificate warning once)
    https://192.168.1.20:8788/tracker/
```

## Use it in a web page

```ts
import { EyeTracker, runCalibration } from '@mindattic/eyetracker';

const tracker = new EyeTracker();
await tracker.start();               // asks for the camera, loads the face model
await runCalibration(tracker);       // nine dots, about fifteen seconds

tracker.on('gaze', (g) => {
  // g.x and g.y run from 0 to 1 across the viewport, y downward.
  if (g.confidence > 0) moveSomethingTo(g.x * innerWidth, g.y * innerHeight);
});
```

The calibration is saved in `localStorage` and reused on the next visit.

To take gaze from a phone or another window instead, swap the source. Everything else stays the same,
because both are a `GazeSource`:

```ts
import { RemoteGazeSource, runCalibration } from '@mindattic/eyetracker';

const tracker = new RemoteGazeSource('ws://localhost:8787/gaze');
await runCalibration(tracker);       // the dots show here; the phone collects the samples
tracker.on('gaze', (g) => { /* same as above */ });
```

`MouseGazeSource` is a third `GazeSource` driven by the pointer, for when there is no camera.

Without a bundler, import the single-file build the bridge serves:
`import { EyeTracker } from 'http://localhost:8787/dist/eyetracker.browser.js'`.

## Use it in Unity or Unreal

Start the bridge (`npm run bridge`), open the tracker page on the computer or a phone and start its
camera, then run the game. The game connects to `ws://localhost:8787/gaze` as a display, draws the
calibration targets itself and reads gaze samples. See `unity/com.mindattic.eyetracker/README.md`
and `unreal/MindAtticEyeTracker/README.md`.

Any other engine or language can join the same way: the wire format is a handful of JSON messages,
described in [docs/PROTOCOL.md](docs/PROTOCOL.md).

## What is in the repo

| Path | What |
| --- | --- |
| `src/` | The library. `core.ts` exports the part with no camera and no DOM; `index.ts` adds the browser part. |
| `bridge/server.mjs` | The local server: serves the pages, relays gaze between trackers and displays. |
| `tracker/` | The page that owns a camera and publishes gaze to the bridge. |
| `demo/` | The gaze lab: a three.js scene and an accuracy check. |
| `unity/`, `unreal/` | The engine clients. |
| `test/` | Unit tests (vitest). They drive the whole pipeline with a synthetic face, so no camera is needed. |
| `docs/` | [ARCHITECTURE.md](docs/ARCHITECTURE.md), [PROTOCOL.md](docs/PROTOCOL.md), [BEST-PRACTICES.md](docs/BEST-PRACTICES.md). |

## Commands

| Command | Does |
| --- | --- |
| `npm run build` | Typechecks, emits `dist/`, bundles `dist/eyetracker.browser.js` |
| `npm run bridge` | Starts the bridge on ports 8787 (http, ws) and 8788 (https, wss) |
| `npm start` | Build, start the bridge, open the gaze lab |
| `npm test` | Runs the unit tests |

Bridge options: `--port`, `--tls-port`, `--no-tls`, `--open`, `--open-path /play/`, and
`--mount /play=path\to\folder` to serve another folder (a game build) from the same address.

## What to expect

A webcam is not a laboratory eye tracker. After a good calibration, with decent light and a still
head, expect the gaze point to land within a few percent of the screen's size of where you are
looking: enough to tell which region of the screen has your attention, not which word you are
reading. [docs/BEST-PRACTICES.md](docs/BEST-PRACTICES.md) covers how to get the most from it and
how to design for that accuracy.

Video never leaves the device that owns the camera. Only the gaze point is sent to a game, and the
bridge only relays on your own network.

## Credits

Face and iris landmarks come from Google's
[MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker).
Smoothing is the [One Euro filter](https://gery.casiez.net/1euro/) by Casiez, Roussel and Vogel.
