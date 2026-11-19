# Architecture

## Why this design

There are two ways to make gaze tracking work on the web, in Unity and in Unreal.

One is to port the vision model to each platform. That means three machine-learning runtimes, three
camera stacks and three sets of bugs, and phones as cameras would need a fourth.

The other is to do the vision once, in the place that already has the best camera access and a
maintained face model, and send the result everywhere else. This library does that. The browser
owns the camera and runs the model. Engines receive a gaze point over a local WebSocket. A phone
becomes a camera by opening a web page.

The part that is specific to a display (which screen, where the targets go) stays with the display.
The part that is specific to a camera (the eyes, the model, the fit) stays with the tracker.

## The pieces

```
  camera frame
      |
      v
  MediaPipe Face Landmarker        478 face points, the last ten are the irises
      |
      v
  extractFeatures (features.ts)    where each iris sits between its eye's corners, eyelids,
      |                            head turn, tilt, roll, position, size
      v
  featureVector                    18 numbers, each scaled to about -1..1
      |
      v
  GazeModel (model.ts)             two weight vectors: x = wx . features, y = wy . features
      |
      v
  One Euro filter                  steady when the eye is still, quick when it jumps
      |
      v
  GazeSample                       x, y in 0..1 of the display, confidence, blink, ...
```

`GazePipeline` (pipeline.ts) is that whole column from landmarks down. It has no camera and no DOM.

`CameraLandmarkSource` (camera.ts) is the top: it opens the camera and runs the model on each new
video frame.

`EyeTracker` (eyeTracker.ts) joins the two, adds calibration and remembers the calibration in
`localStorage`.

## How the gaze point is computed

### Features

For each eye, take the two corners. The line between them is the eye's own x axis and its length is
the unit, so the numbers do not change when the face moves in the image, comes closer or rolls.
Then:

- **Iris x**: how far the iris centre is along that line from its midpoint. This is the balance of
  eye-white on either side of the iris, and it is the main signal for looking left and right.
- **Iris y**: how far the iris centre is above or below the line. The signal for up and down, and a
  weaker one, because the eye opening is only about a third as tall as it is wide.
- **Upper lid**: the eyelid rides up and down with vertical gaze, which helps where iris y is weak.
- **Opening**: lid to lid. Used to detect blinks, not as a regression input.

For the head: the nose tip's offset from the midpoint between the eyes (along the eye line for
turn, across it for tilt), the slope of the eye line (roll), where the face is in the image, and
the distance between the eyes (how close the face is).

`featureVector` scales each of these by a fixed constant and adds a few second-order terms (iris x
squared, iris x times head turn, and so on), giving 18 numbers. The scales are constants, not
statistics of the calibration data. If they were statistics, a feature that happened not to move
during calibration would be divided by nearly zero and explode the first time it moved afterward.

### Calibration

During calibration the user looks at known points while the tracker records feature vectors.
`CalibrationSession.fit` then:

1. Drops, for each target, the fifth of the samples farthest from that target's median. These are
   the frames where the eye was still arriving or a blink had begun.
2. Fits two ridge regressions, one for x and one for y. The penalty is per feature: nearly nothing
   on the iris terms, more on the head terms. If the head stayed still, the head terms have no
   evidence and stay near zero. If it moved, they earn weight and compensate for it.
3. Measures two errors. `fitError` is the error on the samples it trained on. `crossError` is
   leave-one-target-out: fit on eight targets, predict the ninth, for each in turn. That is the
   honest number, and the one shown to the user.

Nine targets is the default. Five is enough for a rough fit but gives a poor estimate of its own
accuracy. Thirteen adds four inner points and helps on large screens.

### Before calibration

`builtInModel` maps iris position straight to the screen with typical gains. It can tell left from
right and up from down. It is there so something sensible happens before calibration, and samples
from it carry `calibrated: false`.

### Blinks and lost faces

The pipeline tracks the widest recent eye opening. When the opening drops below 45% of that, the
frame is a blink: the gaze point is held and `confidence` is zero. With no face in the frame, the
same. Consumers should treat zero confidence as "no new information".

### Smoothing

Raw estimates jitter by a few percent of the screen from frame to frame. The One Euro filter
smooths hard when the estimate is still and lightly when it moves fast, so fixations are steady and
saccades are not dragged. `rawX` and `rawY` carry the unsmoothed estimate for anyone who wants to
filter differently.

## Display space

A gaze point is normalized to a rectangle: (0, 0) top-left, (1, 1) bottom-right. That rectangle is
whatever the calibration targets covered. In a browser it is the viewport. In an engine it is the
game window. Nothing in the library knows the screen's size in pixels or centimetres.

The consequence: if the window moves or is resized, or the camera or the person shifts a lot, the
mapping is stale and calibration should be run again.

## The bridge

`bridge/server.mjs` is a static file server and a WebSocket relay in one process.

- It serves the tracker page, the demo, the bundled library, MediaPipe's wasm files and the face
  model (downloaded once, then served locally, so everything works offline).
- Clients join a **room** as a **tracker** or a **display**. The bridge forwards each tracker
  message to the room's displays and each display message to the room's trackers. It does not
  look inside them.
- It listens on plain http for this machine (browsers allow the camera on `localhost`) and on
  https with a self-signed certificate for other devices, because a browser only gives a page the
  camera over a secure connection.

Calibration across the bridge: the display draws a target and asks the tracker to collect samples
for it; when all targets are done it asks the tracker to fit. The model lives on the tracker. See
PROTOCOL.md.

A browser stops running a page's animation callbacks when the page is hidden. On a single computer
the tracker page is usually behind the game, so the camera loop is also driven by a worker timer,
which keeps running. Even so, a tracker window that is minimized may be throttled by the operating
system; leave it visible, or use a phone.

## The engine clients

Both are thin, by design: connect, say hello as a display, parse `gaze` messages, and drive
calibration by drawing targets and sending `calib` messages.

- **Unity** (`unity/com.mindattic.eyetracker`): `GazeBridgeClient` is the socket, `GazeTracker` is
  the component a scene uses, `GazeCalibrator` draws the targets.
- **Unreal** (`unreal/MindAtticEyeTracker`): `UGazeTrackerSubsystem` is a game-instance subsystem
  usable from C++ and Blueprint, `UGazeCalibrator` runs the target sequence.

Unity's screen space has y pointing up; the clients convert.

## Testing without a camera

`src/testing/syntheticFace.ts` builds a face mesh for a simple model eye: the iris slides in the eye
opening in proportion to where the model person is looking, with some curvature and optional noise.
The tests calibrate against it and check the predictions, which exercises features, calibration,
the model and the pipeline end to end. The same generator is exported for consumers' own tests.

The gaze lab (`demo/`) is the test with a real camera: its accuracy check shows targets the
calibration never saw and reports the error in pixels.
