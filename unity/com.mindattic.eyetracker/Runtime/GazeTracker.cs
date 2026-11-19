using System;
using UnityEngine;

namespace MindAttic.EyeTracker
{
    /// <summary>
    /// Put this on a GameObject to receive gaze from the bridge. It connects while enabled, keeps the
    /// last good point, and raises one event per sample on the main thread. With the mouse stand-in on,
    /// the mouse pointer plays the part of the gaze whenever no tracker is connected.
    /// </summary>
    [AddComponentMenu("MindAttic/Gaze Tracker")]
    public sealed class GazeTracker : MonoBehaviour
    {
        [Tooltip("The bridge. A phone or another machine uses the bridge host's address instead of localhost.")]
        public string url = "ws://localhost:8787/gaze";
        [Tooltip("Trackers and displays in the same room see each other.")]
        public string room = "default";
        [Tooltip("Shown in the log of the bridge.")]
        public string displayName = "Unity";
        [Tooltip("Use the mouse pointer as the gaze point while no tracker is connected.")]
        public bool useMouseFallback = true;

        private GazeBridgeClient client;
        private GazeSample latest;
        private Vector2 normalized = new Vector2(0.5f, 0.5f);
        private bool hasPoint;
        private Vector2 guiMouse;

        /// <summary>Raised on the main thread, in Update, once for every sample (mouse samples included).</summary>
        public event Action<GazeSample> Sample;

        /// <summary>The connection, for calibration. Null while the component is disabled.</summary>
        public GazeBridgeClient Client
        {
            get { return client; }
        }

        /// <summary>The most recent sample, whatever its confidence.</summary>
        public GazeSample Latest
        {
            get { return latest; }
        }

        /// <summary>Connected to the bridge.</summary>
        public bool Connected
        {
            get { return client != null && client.Connected; }
        }

        /// <summary>At least one tracker shares the room.</summary>
        public bool HasTracker
        {
            get { return client != null && client.Connected && client.Trackers > 0; }
        }

        /// <summary>The mouse is standing in for the gaze right now.</summary>
        public bool UsingMouse
        {
            get { return useMouseFallback && !HasTracker; }
        }

        /// <summary>Confidence of the latest sample, 0..1. Zero means no face or a blink: apply no gaze.</summary>
        public float Confidence
        {
            get { return hasPoint ? latest.confidence : 0f; }
        }

        /// <summary>
        /// The last good gaze point in normalized display space, y down as in the protocol. It holds its
        /// value while confidence is zero.
        /// </summary>
        public Vector2 Normalized
        {
            get { return normalized; }
        }

        /// <summary>The same point in Unity screen pixels, y up, ready for Camera.ScreenPointToRay.</summary>
        public Vector2 ScreenPoint
        {
            get { return new Vector2(normalized.x * Screen.width, (1f - normalized.y) * Screen.height); }
        }

        private void OnEnable()
        {
            try
            {
                client = new GazeBridgeClient(url, room, displayName);
                client.Start();
            }
            catch (Exception e)
            {
                Debug.LogWarning("GazeTracker: cannot use the bridge address \"" + url + "\": " + e.Message);
                client = null;
            }
        }

        private void OnDisable()
        {
            if (client != null)
            {
                client.Dispose();
                client = null;
            }
        }

        private void Update()
        {
            if (UsingMouse)
            {
                // Drop anything a tracker sent before it left.
                GazeSample stale;
                while (client != null && client.TryDequeue(out stale))
                {
                }
                Vector2 mouse = MousePixels();
                float w = Mathf.Max(1, Screen.width);
                float h = Mathf.Max(1, Screen.height);
                var sample = new GazeSample
                {
                    t = Time.unscaledTimeAsDouble * 1000.0,
                    rawX = mouse.x / w,
                    rawY = 1f - mouse.y / h,
                    confidence = 1f,
                    face = true,
                    blink = false,
                    calibrated = true,
                };
                sample.x = Mathf.Clamp01(sample.rawX);
                sample.y = Mathf.Clamp01(sample.rawY);
                Accept(sample);
                return;
            }

            if (client == null) return;
            if (!HasTracker)
            {
                // No tracker and no stand-in: there is no gaze.
                latest.confidence = 0f;
                return;
            }
            GazeSample next;
            while (client.TryDequeue(out next)) Accept(next);
        }

        private void Accept(GazeSample sample)
        {
            latest = sample;
            if (sample.confidence > 0f)
            {
                normalized = new Vector2(sample.x, sample.y);
                hasPoint = true;
            }
            Action<GazeSample> handler = Sample;
            if (handler != null) handler(sample);
        }

        /// <summary>The mouse in Unity screen pixels, y up.</summary>
        private Vector2 MousePixels()
        {
#if ENABLE_LEGACY_INPUT_MANAGER
            return Input.mousePosition;
#else
            return guiMouse;
#endif
        }

#if !ENABLE_LEGACY_INPUT_MANAGER
        // Without the old Input Manager, IMGUI events are the dependency-free way to read the mouse.
        private void OnGUI()
        {
            Vector2 p = Event.current.mousePosition;
            guiMouse = new Vector2(p.x, Screen.height - p.y);
        }
#endif
    }
}
