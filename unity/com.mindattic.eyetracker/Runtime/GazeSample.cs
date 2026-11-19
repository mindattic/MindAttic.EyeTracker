using System;

namespace MindAttic.EyeTracker
{
    /// <summary>
    /// One gaze message from a tracker, as described in docs/PROTOCOL.md. The point is in normalized
    /// display space: (0, 0) is the top-left corner of the play area, (1, 1) the bottom-right, y downward.
    /// </summary>
    [Serializable]
    public struct GazeSample
    {
        /// <summary>Capture time in milliseconds on the clock of the tracker. Only differences are meaningful.</summary>
        public double t;
        /// <summary>Smoothed gaze point, clamped to 0..1.</summary>
        public float x;
        public float y;
        /// <summary>Unsmoothed, unclamped estimate. Outside 0..1 when the user looks past the edge.</summary>
        public float rawX;
        public float rawY;
        /// <summary>0..1. Zero when no face is visible or during a blink.</summary>
        public float confidence;
        /// <summary>A face was found in this frame.</summary>
        public bool face;
        /// <summary>The eyes are closed; x and y repeat the last open-eye value.</summary>
        public bool blink;
        /// <summary>A fitted calibration is in use. False means the rough built-in mapping.</summary>
        public bool calibrated;
    }

    /// <summary>The answer to a calibration: the calib.result message without its type and id.</summary>
    [Serializable]
    public struct GazeCalibrationResult
    {
        public bool ok;
        /// <summary>Why it failed, when ok is false.</summary>
        public string reason;
        public int targets;
        public int samples;
        public float fitError;
        /// <summary>Expected error on points the fit was not trained on, in display units (0.03 is about 3% of the screen).</summary>
        public float crossError;

        public static GazeCalibrationResult Failed(string reason)
        {
            return new GazeCalibrationResult { ok = false, reason = reason };
        }
    }
}
