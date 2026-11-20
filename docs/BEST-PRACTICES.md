# Best practices

## Setting up the camera

- **Put the camera on the screen's edge, facing the user.** It does not have to be centred: the
  calibration works out where it is. Nearer the middle of an edge is still better than a far
  corner, because the camera sees both eyes more squarely. A laptop's built-in webcam is fine. A
  phone can be propped against the bottom edge of the monitor or stood at its top.
- **Do not move the camera after calibrating.** Its position is part of what was calibrated.
- **Light the face from the front.** A window or lamp behind the user turns the face into a
  silhouette and the irises disappear. A lamp behind the screen is ideal.
- **Sit at arm's length**, with the face filling a good part of the frame. The tracker's
  confidence drops when the face is small in the image.
- **Glasses** usually work. Strong reflections on the lenses (from the screen itself, in a dark
  room) hide the iris; raise the room light or lower the screen brightness.
- **Use the highest camera resolution that still gives 30 frames a second.** The iris is only a
  few dozen pixels wide. The library asks for 1280x720 by default.

## Calibrating

- Calibrate **in the posture you will use**. Leaning back afterwards changes everything.
- For the nine dots, keep the head still and **move only the eyes**. The dots are placed so each
  one is a clear jump from the last.
- When the dot starts to glide, **follow it with your eyes** and keep your head still. Stay on it
  the whole way; this part does the most for accuracy.
- For the three amber dots that follow, do the opposite: **keep your eyes on the dot and move
  your head**. Turn it left and right, nod, lean in and back, shift side to side, slowly, about as
  far as you would while playing. This is what lets the tracker allow for head movement later;
  the more of your natural range it sees, the better.
- Look at the dot's **centre** until it finishes filling. The first 700 ms at each dot are not
  recorded, to give the eyes time to arrive.
- Calibrate **over the area you will look at**. If the app runs in a window, calibrate in that
  window. Calibrating fullscreen on a very wide monitor and then using a small window spends the
  accuracy on parts of the screen you never look at. The window may be moved or resized
  afterwards; the browser library allows for that.
- Check the reported error. Under 5% of the screen is good. Over 10% usually means poor light, a
  moving head or a camera far off to one side; fix that and calibrate again.
- **Recalibrate when things change**: a different seat, a moved camera, a different person.
  Calibration takes fifteen seconds; offer it freely (a key, a button) instead of hiding it.

## What accuracy to expect

A webcam sees each iris as a few dozen pixels, and a one-pixel error in placing its centre moves
the gaze point by roughly a degree. With good light and a careful calibration, expect the gaze
point to land within one to three degrees of where you are looking: at arm's length that is a
circle two to six centimetres across on the screen, 50 to 200 pixels on a typical monitor. It will
not be pixel-accurate; purpose-built infrared eye trackers, with their own illumination and far
more pixels on the eye, reach about half a degree. Use the gaze lab's accuracy check to see what
your own setup gives, and its report to see whether the error is a steady offset (fixable by
calibrating again or by learning) or scatter (helped by more light and a higher camera resolution).

## Designing for webcam accuracy

Webcam gaze is good to a few percent of the screen, and it wanders. Design around that.

- **Make targets big.** Anything the user selects or steers by looking should be at least a tenth
  of the screen across, with space between targets.
- **Use gaze as an area, not a pointer.** Effects that fall off smoothly with distance from the
  gaze point (a field, a spotlight, a region highlight) forgive error. A crosshair that must hit
  a small thing does not.
- **Prefer direction to position.** MindPuck pushes the puck away from the gaze point. A gaze
  point three units behind the puck that is half a unit off still pushes in almost the right
  direction.
- **Never trigger on a glance.** Eyes dart everywhere without their owner deciding to. Require the
  gaze to stay (a dwell of half a second or more), or combine gaze with a key or a click.
- **Show the user where the system thinks they are looking**, at least while they learn. People
  adapt quickly to a small constant offset when they can see it.
- **Respect `confidence`.** At zero (a blink, a turned head, no face) hold the last state or do
  nothing. Do not act on the repeated point.
- **Give the eyes a rest.** Controlling something with your eyes is tiring in a way a mouse is
  not. Keep rounds short and make pausing easy.
- **Always offer another way in.** A pointer fallback (`MouseGazeSource`) costs nothing and makes
  the thing usable by people without a camera, in bad light, or who cannot be tracked reliably.

## Privacy

- Camera frames are processed on the device that owns the camera and are never stored or sent.
  Say so to your users.
- Ask for the camera at the moment the user chooses eye tracking, not on page load. The library's
  `start()` is what triggers the browser's permission prompt.
- Only gaze points cross the bridge, and the bridge only listens on the local network. Do not put
  it on the internet.
- A gaze trace is personal data: it shows what someone looked at. If you record it, treat it that
  way.

## Integrating

- **Depend on `GazeSource`**, not on `EyeTracker`. Then the same code takes a webcam, a phone
  through the bridge, or the pointer.
- **Pause your game or app during calibration.** The user is looking at dots, not at your content.
- **One calibration per arrangement.** `EyeTracker` stores its model under a `storageKey`; use a
  different key for each screen-and-camera setup you support.
- **Handle failure in words.** `start()` rejects with a browser error; `tracker.status.error`
  holds a sentence fit to show (permission refused, no camera, camera busy).
- **On a single computer with a native game**, keep the tracker page's window visible, not
  minimized. Browsers and the operating system slow down pages they consider out of sight.
- **Serve over https** anywhere but `localhost`. Browsers do not give the camera to insecure
  pages. The bridge provides a self-signed https port for phones for this reason.
