using System;
using System.Collections;
using System.Threading.Tasks;
using UnityEngine;

namespace MindAttic.EyeTracker
{
    /// <summary>
    /// Runs the nine-point calibration: draws each target over the whole screen with IMGUI, waits for the
    /// eye to land, asks the tracker to collect, then asks it to fit. The Unity twin of runCalibration in
    /// src/calibrationUI.ts. The gaze this produces is relative to the screen the targets covered, so
    /// calibrate again after resizing the window.
    /// </summary>
    [AddComponentMenu("MindAttic/Gaze Calibrator")]
    public sealed class GazeCalibrator : MonoBehaviour
    {
        public GazeTracker tracker;
        [Tooltip("Time to let the eye land on a target before sampling starts.")]
        public float settleSeconds = 0.7f;
        [Tooltip("Time spent sampling each target, in milliseconds.")]
        public int collectMs = 900;
        [Tooltip("How far in from the edge the outer targets sit, as a fraction of the screen.")]
        public float margin = 0.08f;
        [TextArea]
        public string intro = "Look at each dot until it fills. Keep your head still and move only your eyes.";

        private enum Phase
        {
            Idle,
            Intro,
            Targets,
            Message,
        }

        private Phase phase = Phase.Idle;
        private bool startRequested;
        private bool cancelled;
        private Vector2 target;
        private float fill;
        private string message = "";
        private Texture2D white;
        private Texture2D ring;
        private Texture2D disc;
        private GUIStyle textStyle;
        private GUIStyle hintStyle;

        /// <summary>Raised when a calibration ends, whether it worked, failed or was cancelled.</summary>
        public event Action<GazeCalibrationResult> Completed;

        public bool IsRunning
        {
            get { return phase != Phase.Idle; }
        }

        /// <summary>The result of the last calibration that ended.</summary>
        public GazeCalibrationResult LastResult { get; private set; }

        public bool HasResult { get; private set; }

        /// <summary>The default pattern: the centre, the four corners and the four edge midpoints.</summary>
        public static Vector2[] Pattern(float margin = 0.08f)
        {
            float lo = margin;
            float hi = 1f - margin;
            const float mid = 0.5f;
            return new[]
            {
                new Vector2(mid, mid),
                new Vector2(lo, lo),
                new Vector2(hi, hi),
                new Vector2(hi, lo),
                new Vector2(lo, hi),
                new Vector2(mid, lo),
                new Vector2(mid, hi),
                new Vector2(lo, mid),
                new Vector2(hi, mid),
            };
        }

        /// <summary>Show the intro and start. Does nothing if a calibration is already running.</summary>
        public void Begin()
        {
            if (IsRunning) return;
            if (tracker == null) tracker = GetComponent<GazeTracker>();
            StartCoroutine(Run());
        }

        /// <summary>Stop a running calibration. It ends with ok false and the reason "cancelled".</summary>
        public void Cancel()
        {
            cancelled = true;
        }

        private void OnDisable()
        {
            // The coroutine dies with the component; do not leave the overlay up.
            phase = Phase.Idle;
        }

        private IEnumerator Run()
        {
            cancelled = false;
            startRequested = false;
            message = intro;
            phase = Phase.Intro;
            while (!startRequested && !cancelled) yield return null;
            if (cancelled)
            {
                Finish(GazeCalibrationResult.Failed("cancelled"));
                yield break;
            }

            GazeBridgeClient client = tracker != null ? tracker.Client : null;
            if (client == null || !tracker.HasTracker)
            {
                GazeCalibrationResult none = GazeCalibrationResult.Failed("no tracker is connected");
                yield return ShowMessage("Calibration failed: " + none.reason + ".", 2.2f);
                Finish(none);
                yield break;
            }

            client.BeginCalibration();
            phase = Phase.Targets;
            foreach (Vector2 point in Pattern(margin))
            {
                target = point;
                fill = 0f;
                float settled = Time.unscaledTime + settleSeconds;
                while (Time.unscaledTime < settled && !cancelled) yield return null;
                if (cancelled) break;

                // The target stays up until the tracker answers (or the client gives up waiting).
                Task<int> collect = client.CollectAsync(point.x, point.y, collectMs);
                float began = Time.unscaledTime;
                while (!collect.IsCompleted && !cancelled)
                {
                    fill = Mathf.Clamp01((Time.unscaledTime - began) / (collectMs / 1000f));
                    yield return null;
                }
                if (cancelled) break;
            }
            if (cancelled)
            {
                Finish(GazeCalibrationResult.Failed("cancelled"));
                yield break;
            }

            message = "Working it out...";
            phase = Phase.Message;
            Task<GazeCalibrationResult> finish = client.FinishAsync();
            while (!finish.IsCompleted) yield return null;
            GazeCalibrationResult result = finish.IsFaulted
                ? GazeCalibrationResult.Failed("the connection failed")
                : finish.Result;
            string text = result.ok
                ? "Calibrated. Typical error: about " + Mathf.RoundToInt(result.crossError * 100f) + "% of the screen."
                : "Calibration failed: " + (string.IsNullOrEmpty(result.reason) ? "unknown reason" : result.reason) + ".";
            yield return ShowMessage(text, result.ok ? 1.1f : 2.2f);
            Finish(result);
        }

        private IEnumerator ShowMessage(string text, float seconds)
        {
            message = text;
            phase = Phase.Message;
            float until = Time.unscaledTime + seconds;
            while (Time.unscaledTime < until) yield return null;
        }

        private void Finish(GazeCalibrationResult result)
        {
            phase = Phase.Idle;
            LastResult = result;
            HasResult = true;
            Action<GazeCalibrationResult> handler = Completed;
            if (handler != null) handler(result);
        }

        private void OnGUI()
        {
            if (phase == Phase.Idle) return;
            EnsureResources();
            GUI.depth = -1000;

            Event e = Event.current;
            if (e.type == EventType.KeyDown)
            {
                if (e.keyCode == KeyCode.Escape) cancelled = true;
                else if (phase == Phase.Intro && (e.keyCode == KeyCode.Space || e.keyCode == KeyCode.Return)) startRequested = true;
                e.Use();
            }
            else if (e.type == EventType.MouseDown)
            {
                if (phase == Phase.Intro) startRequested = true;
                e.Use();
            }
            if (e.type != EventType.Repaint) return;

            float w = Screen.width;
            float h = Screen.height;
            float scale = Mathf.Max(1f, h / 900f);
            Color old = GUI.color;
            GUI.color = new Color(0.02f, 0.027f, 0.05f, 1f);
            GUI.DrawTexture(new Rect(0, 0, w, h), white);

            if (phase == Phase.Targets)
            {
                float size = 44f * scale;
                var centre = new Vector2(target.x * w, target.y * h);
                GUI.color = new Color(0.5f, 0.83f, 1f, 1f);
                GUI.DrawTexture(new Rect(centre.x - size / 2, centre.y - size / 2, size, size), ring);
                float dot = 8f * scale * Mathf.Lerp(1f, 4.6f, fill);
                GUI.color = Color.white;
                GUI.DrawTexture(new Rect(centre.x - dot / 2, centre.y - dot / 2, dot, dot), disc);
            }
            else
            {
                textStyle.fontSize = Mathf.RoundToInt(22f * scale);
                hintStyle.fontSize = Mathf.RoundToInt(16f * scale);
                GUI.color = new Color(0.91f, 0.93f, 0.99f, 1f);
                float boxW = Mathf.Min(w - 48f, 640f * scale);
                var box = new Rect((w - boxW) / 2, h * 0.28f, boxW, h * 0.2f);
                GUI.Label(box, message, textStyle);
                if (phase == Phase.Intro)
                {
                    GUI.color = new Color(0.91f, 0.93f, 0.99f, 0.6f);
                    GUI.Label(new Rect(box.x, box.yMax, box.width, 40f * scale), "Click or press Space to begin. Esc cancels.", hintStyle);
                }
            }
            GUI.color = old;
        }

        private void EnsureResources()
        {
            if (white == null)
            {
                white = new Texture2D(1, 1, TextureFormat.RGBA32, false);
                white.SetPixel(0, 0, Color.white);
                white.Apply();
                white.hideFlags = HideFlags.HideAndDontSave;
            }
            if (ring == null) ring = Circle(96, 0.86f);
            if (disc == null) disc = Circle(96, 0f);
            if (textStyle == null)
            {
                textStyle = new GUIStyle(GUI.skin.label) { alignment = TextAnchor.MiddleCenter, wordWrap = true };
                textStyle.normal.textColor = Color.white;
                hintStyle = new GUIStyle(textStyle) { alignment = TextAnchor.UpperCenter };
            }
        }

        /// <summary>A white circle on transparent, smooth at the edge. inner is the hole, as a fraction of the radius.</summary>
        private static Texture2D Circle(int size, float inner)
        {
            var texture = new Texture2D(size, size, TextureFormat.RGBA32, false);
            texture.hideFlags = HideFlags.HideAndDontSave;
            texture.wrapMode = TextureWrapMode.Clamp;
            var pixels = new Color32[size * size];
            float radius = size / 2f;
            float soft = 1.5f;
            for (int y = 0; y < size; y++)
            {
                for (int x = 0; x < size; x++)
                {
                    float d = Mathf.Sqrt((x + 0.5f - radius) * (x + 0.5f - radius) + (y + 0.5f - radius) * (y + 0.5f - radius));
                    float a = Mathf.Clamp01((radius - d) / soft);
                    if (inner > 0f) a *= Mathf.Clamp01((d - radius * inner) / soft);
                    pixels[y * size + x] = new Color(1f, 1f, 1f, a);
                }
            }
            texture.SetPixels32(pixels);
            texture.Apply();
            return texture;
        }

        private void OnDestroy()
        {
            if (white != null) Destroy(white);
            if (ring != null) Destroy(ring);
            if (disc != null) Destroy(disc);
        }
    }
}
