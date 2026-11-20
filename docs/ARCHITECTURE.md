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
      |                            where the head points, its distance and roll
      v
  featureVector                    21 numbers, each scaled to about -1..1
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
the unit, so the numbers do not change when the face moves in the image or comes closer. Then:

- **Iris x**: how far the iris centre is along that line from its midpoint. This is the balance of
  eye-white on either side of the iris, and it is the main signal for looking left and right.
- **Iris y**: how far the iris centre is above or below the line. The signal for up and down, and a
  weaker one, because the eye opening is only about a third as tall as it is wide.
- **Upper lid**: the eyelid rides up and down with vertical gaze, which helps where iris y is weak.
- **Opening**: lid to lid. Used to detect blinks, not as a regression input.

Those say how the eyes are turned **in the head**. Where the gaze lands also depends on where the
head is and which way it faces, so the head is measured too:

- **Head point** (`hx`, `hy`): the spot, in centimetres on the plane the camera sits in, that a
  line straight out of the face would hit. It comes from MediaPipe's head-pose matrix: the face's
  position and its outward direction in camera space, followed to that plane. It moves when the
  head turns and when the head shifts.
- **Distance** (`dist`): camera to face, in centimetres.
- **Roll**: the slope of the eye line.

(When there is no matrix, the same three are estimated from the landmarks: distance from how far
apart the eyes appear, direction from where the nose tip sits between them. That is cruder, and
the simulations below show it.)

### The geometry behind the model

Looking at a screen works like this: the gaze point is where the head points, plus how far the
eyes are turned in the head multiplied by the distance to the screen. `featureVector` is laid out
to match:

- the head point enters directly;
- every eye term is multiplied by the distance;
- eye offsets are measured along the eye line, which rolls with the head, so they are turned back
  to the camera's axes first;
- second- and third-order eye terms cover the fact that the eye turns through an angle (a wide
  screen needs them), and head-times-eye terms cover the two acting together.

That gives 21 numbers, each scaled by a fixed constant to about -1..1. The scales are constants,
not statistics of the calibration data, so a feature that happened not to move during calibration
cannot blow up when it moves later.

### Where the camera is

Nothing above assumes the camera is at the centre of the screen, or level, or in front of the face.
The head point is measured on the camera's own plane, in the camera's own axes. Moving the camera
to a corner of the monitor shifts every head point by a constant; tilting it scales and shears
them. A constant and a linear map are exactly what the fit solves for: the bias absorbs the
camera's offset from the screen, and the weights absorb its angle and the screen's size. They are
found once at calibration and applied to every frame afterwards.

Put another way: the lens and the face are two planes. The head-pose matrix gives the face plane's
distance from the lens plane and the angle between them for every frame (the gaze lab shows both
live, as "Distance" and "Face vs lens"). The screen is a third plane, fixed to the lens. The
discrepancy between lens and screen is constant, so the fit finds it once; the discrepancy between
face and lens changes all the time, so it is measured every frame and fed through the same
constants. Learning in use (below) keeps refining those constants.

### Calibration

Calibration has three parts, about a minute in all.

1. **Dots.** The user looks at nine known points with the head still. This anchors the fit.
2. **Follow the dot.** A dot glides round the whole area for 24 seconds and the user follows it
   with their eyes. Nine dots sample nine places; this samples everywhere, which matters because
   the model has 21 terms and nine places leave it free to bend between them. The path goes out
   and back in every direction, so the eyes' small lag behind the dot cancels out instead of
   pulling the fit one way. In simulation it cuts the error on unseen points to between a quarter
   and a half of what the dots alone give.
3. **Head movement.** The user keeps looking at one dot while turning, nodding and leaning (three
   dots, about fifteen seconds). The gaze point does not change but every feature does. This is
   what pins down the head terms: without it the fit has never seen the head move and can only
   guess how to allow for it.

`CalibrationSession.fit` then:

1. For the dots, drops the fifth of each target's samples farthest from that target's median: the
   frames where the eye was still arriving or a blink had begun. Samples from the moving parts are
   all kept, since they differ on purpose, but each counts for 0.35 of a still sample: there are
   many more of them and each is less certain, and they must not outvote the dots.
2. Fits two ridge regressions, one for x and one for y. The penalty is per feature: nearly nothing
   on the eye terms, a little more on the head terms, so that if the head-movement part was skipped
   they stay small instead of fitting noise.
3. Measures two errors on the still dots. `fitError` is the error on the samples it trained on.
   `crossError` is leave-one-dot-out: fit without one dot, predict it, for each in turn. It is the more
   honest number and the one shown to the user. It is pessimistic for corner targets, which the
   other targets do not surround.

### What a simulation shows

`src/testing/syntheticFace.ts` builds the scene from real geometry: a screen of a given size, a
camera somewhere on its edge, a head at a given place and angle, and eyes that turn to look at a
point; the landmarks are that scene through a pinhole camera, with jitter. Root-mean-square error
as a percentage of the screen, 1% landmark jitter, horizontal / vertical:

| Camera | Head still | Head moving, dots only | Head moving, with the head-movement step |
| --- | --- | --- | --- |
| Above the screen, centred | 1.1 / 2.1 | 6.6 / 10.7 | 1.9 / 3.1 |
| Bottom-left corner, tilted up | 2.2 / 3.4 | 9.6 / 17.8 | 6.0 / 8.5 |
| Off the right-hand side | 2.4 / 2.4 | 10.0 / 11.8 | 5.8 / 4.1 |
| 120 cm ultrawide, camera a third of the way along | 1.8 / 4.0 | 6.4 / 10.3 | 4.6 / 7.6 |

"Head moving" means anywhere within 7 cm sideways, 4 cm up or down, 10 cm nearer or farther, and
turned up to 14 degrees. These are a model eye, not a person: real numbers will be worse, but the
pattern holds. Camera placement costs little once calibrated; head movement costs a lot unless the
calibration has seen it; and a camera far off to one side is harder than one near the middle.

### Before calibration

`builtInModel` maps iris position straight to the screen with typical gains. It can tell left from
right and up from down. It is there so something sensible happens before calibration, and samples
from it carry `calibrated: false`.

### Blinks and lost faces

The pipeline tracks the widest recent eye opening. When the opening drops below 45% of that, the
frame is a blink: the gaze point is held and `confidence` is zero. With no face in the frame, the
same. Consumers should treat zero confidence as "no new information".

### Steadying

Each estimate carries random error, so a fixed gaze shows up as a cloud of points around the true
spot. Two stages deal with it.

**Fixation averaging** (`filters/fixation.ts`). The centre of the cloud is a far better answer
than any point in it. While the eyes rest on one spot the filter reports the running average of
the estimates (up to a second's worth), which settles on the centre and gets steadier the longer
the look lasts. To tell a real eye movement from the cloud's own scatter it compares the average
of the last four estimates with the long average: when those four agree that the gaze is somewhere
else, the long average is dropped and restarted there. One stray estimate is ignored.

**One Euro filter** (`filters/oneEuro.ts`) then smooths what is left, lightly when the point is
moving and harder when it is still.

In simulation, at typical webcam noise, a steady look jitters by 2% of the screen raw, 0.7% with
the One Euro filter alone and 0.14% with both. A jump to a new spot is followed in five or six
frames (about a fifth of a second). The cost is that a slowly moving gaze, such as eyes following
a moving object, trails by a few percent of the screen. `rawX` and `rawY` carry the unsmoothed
estimate for anyone who wants to filter differently, and `fixation: null` in the pipeline options
turns the averaging off.

### Learning in use

A calibration is fifteen to thirty seconds of data. The tracker can keep adding to it.

The model is solved from sums over its samples (`learning.ts`), and the sums are stored with the
model. So a new sample, "the user was looking at this point when the features were these", can be
added at any time and the model solved again in well under a millisecond. Where do such samples
come from after calibration?

- **Clicks and taps.** People look at what they click. `EyeTracker` listens for pointer presses
  and treats each as a calibration point (`learnFromClicks`, on by default).
- **Hints from the app.** `tracker.hint(x, y)` says "the user is looking here now". An app calls it
  when it has good reason to know: a prompt the user must read, a target they must acquire.

Each is added at half the weight of a calibration sample, and only if the current estimate is
within 30% of the screen of it, so a click made without looking does not teach the model
something false. The updated model is saved, so the learning carries over to the next visit. In
simulation, a calibration that was 11% off improved to 6% after thirty clicks and 4% after three
hundred.

What it cannot do is learn from nothing. Without clicks or hints there is no ground truth, and
averaging the gaze over time would only reinforce whatever error is already there.

## Display space

A gaze point handed to an app is normalized to a rectangle: (0, 0) top-left, (1, 1) bottom-right.

In a browser that rectangle is the page's viewport, as it is at that moment. The eyes look at the
screen, not at a window, so the tracker fits its model in **screen space**: each calibration target
is converted from its place in the viewport to its place on the monitor (`screenSpace.ts`), and
each gaze estimate is converted back to the viewport using the window's current position and size.
A calibration made in a small window, a large one or fullscreen therefore gives the same gaze
point on the glass, and moving or resizing the window afterwards does not spoil it. (An earlier
version fitted in viewport space; calibrating fullscreen on a 5120x1440 monitor and then playing
in a 1920x1080 window squeezed the vertical range to half the window.)

Accuracy is a fraction of the area the targets covered. Calibrate over the area you will look at:
if the app runs in a window, calibrate in that window, not fullscreen on a much larger monitor.

A tracker page that is only the camera for a display elsewhere uses `space: 'display'`: no
conversion, because it knows nothing about the display's screen. The display converts instead
(`RemoteGazeSource` does this in a browser). In Unity and Unreal the rectangle is the game window.

Moving the camera, or the person shifting a lot, still means calibrating again.

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
calibration never saw and reports the error in pixels. **Copy report** puts everything measured in
the session on the clipboard as JSON: the calibration result, and for every check target the
signed error in x and y and the jitter. A constant offset, a wrong scale and plain noise look
different in those numbers, which is what makes tuning possible.
