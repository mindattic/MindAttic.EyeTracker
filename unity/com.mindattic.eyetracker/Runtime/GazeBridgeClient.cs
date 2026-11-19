using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;

namespace MindAttic.EyeTracker
{
    /// <summary>
    /// A display's connection to the bridge (docs/PROTOCOL.md, version 1). Plain C#: it owns a
    /// ClientWebSocket on a background task, says hello as a display, reconnects by itself, and keeps
    /// the latest gaze sample where any thread can read it. The C# twin of RemoteGazeSource in src/remote.ts.
    ///
    /// ClientWebSocket is not available in WebGL builds.
    /// </summary>
    public sealed class GazeBridgeClient : IDisposable
    {
        public const int ProtocolVersion = 1;
        private const int MaxQueued = 256;

        private readonly Uri uri;
        private readonly string room;
        private readonly string name;
        private readonly int reconnectMs;
        private readonly object gate = new object();
        private readonly SemaphoreSlim sendLock = new SemaphoreSlim(1, 1);
        private readonly ConcurrentQueue<GazeSample> queue = new ConcurrentQueue<GazeSample>();
        private readonly Dictionary<int, TaskCompletionSource<CalibDto>> waiting = new Dictionary<int, TaskCompletionSource<CalibDto>>();

        private CancellationTokenSource cts;
        private ClientWebSocket socket;
        private volatile bool connected;
        private volatile int trackers;
        private volatile int displays;
        private GazeSample latest;
        private bool hasSample;
        private long sampleCount;
        private int nextId = 1;

        /// <param name="url">For example ws://localhost:8787/gaze.</param>
        /// <param name="room">The bridge room. Trackers and displays in the same room see each other.</param>
        /// <param name="name">Only used in the log of the bridge.</param>
        /// <param name="reconnectMs">Milliseconds between reconnection attempts. Zero turns reconnection off.</param>
        public GazeBridgeClient(string url, string room = "default", string name = "Unity", int reconnectMs = 1500)
        {
            uri = new Uri(url);
            this.room = string.IsNullOrEmpty(room) ? "default" : room;
            this.name = name ?? "Unity";
            this.reconnectMs = reconnectMs;
        }

        /// <summary>The socket is open and hello has been sent.</summary>
        public bool Connected
        {
            get { return connected; }
        }

        /// <summary>How many trackers share the room. Show "waiting for a tracker" while this is zero.</summary>
        public int Trackers
        {
            get { return trackers; }
        }

        public int Displays
        {
            get { return displays; }
        }

        /// <summary>How many gaze samples have arrived since Start.</summary>
        public long SampleCount
        {
            get { return Interlocked.Read(ref sampleCount); }
        }

        /// <summary>The most recent gaze sample, from any thread. False until the first one arrives.</summary>
        public bool TryGetLatest(out GazeSample sample)
        {
            lock (gate)
            {
                sample = latest;
                return hasSample;
            }
        }

        /// <summary>
        /// Take the next sample that has not been handed out yet, oldest first. For raising one event per
        /// sample on the main thread. The queue keeps at most a few seconds; older samples are dropped.
        /// </summary>
        public bool TryDequeue(out GazeSample sample)
        {
            return queue.TryDequeue(out sample);
        }

        /// <summary>Open the connection and keep it open. Safe to call once; call Dispose to stop.</summary>
        public void Start()
        {
            if (cts != null) return;
            cts = new CancellationTokenSource();
            CancellationToken token = cts.Token;
            Task.Run(() => RunAsync(token));
        }

        public void Dispose()
        {
            CancellationTokenSource source = cts;
            if (source == null) return;
            cts = null;
            try
            {
                source.Cancel();
            }
            catch (Exception)
            {
            }
            ClientWebSocket ws = socket;
            if (ws != null)
            {
                try
                {
                    ws.Abort();
                }
                catch (Exception)
                {
                }
            }
            connected = false;
            trackers = 0;
            FailWaiting();
        }

        // ---- calibration: the display draws the targets, the tracker collects the eye samples ----

        /// <summary>Start a new calibration on every tracker in the room.</summary>
        public void BeginCalibration()
        {
            Send("{\"type\":\"calib\",\"op\":\"begin\"}");
        }

        /// <summary>
        /// Ask the tracker to sample for ms milliseconds while the user looks at (x, y), a normalized
        /// display point. Completes with the number of samples collected, or 0 when the tracker did not
        /// answer within ms plus three seconds.
        /// </summary>
        public async Task<int> CollectAsync(double x, double y, int ms)
        {
            int id = Interlocked.Increment(ref nextId);
            Task<CalibDto> answer = Request(id);
            string json = "{\"type\":\"calib\",\"op\":\"collect\",\"id\":" + id.ToString(CultureInfo.InvariantCulture) +
                ",\"x\":" + Number(x) + ",\"y\":" + Number(y) + ",\"ms\":" + ms.ToString(CultureInfo.InvariantCulture) + "}";
            if (!Send(json))
            {
                Forget(id);
                return 0;
            }
            CalibDto reply = await Await(answer, id, ms + 3000).ConfigureAwait(false);
            return reply != null && reply.type == "calib.collected" ? reply.samples : 0;
        }

        /// <summary>Fit the model from the collected targets. Allows the tracker eight seconds to answer.</summary>
        public async Task<GazeCalibrationResult> FinishAsync()
        {
            int id = Interlocked.Increment(ref nextId);
            Task<CalibDto> answer = Request(id);
            if (!Send("{\"type\":\"calib\",\"op\":\"finish\",\"id\":" + id.ToString(CultureInfo.InvariantCulture) + "}"))
            {
                Forget(id);
                return GazeCalibrationResult.Failed("not connected to the bridge");
            }
            CalibDto reply = await Await(answer, id, 8000).ConfigureAwait(false);
            if (reply == null || reply.type != "calib.result") return GazeCalibrationResult.Failed("the tracker did not answer");
            return new GazeCalibrationResult
            {
                ok = reply.ok,
                reason = reply.reason,
                targets = reply.targets,
                samples = reply.samples,
                fitError = reply.fitError,
                crossError = reply.crossError,
            };
        }

        /// <summary>Drop the calibration; the tracker goes back to its rough built-in mapping.</summary>
        public void ClearCalibration()
        {
            Send("{\"type\":\"calib\",\"op\":\"clear\"}");
        }

        private Task<CalibDto> Request(int id)
        {
            var source = new TaskCompletionSource<CalibDto>(TaskCreationOptions.RunContinuationsAsynchronously);
            lock (gate)
            {
                waiting[id] = source;
            }
            return source.Task;
        }

        private void Forget(int id)
        {
            lock (gate)
            {
                waiting.Remove(id);
            }
        }

        private async Task<CalibDto> Await(Task<CalibDto> answer, int id, int timeoutMs)
        {
            Task first = await Task.WhenAny(answer, Task.Delay(timeoutMs)).ConfigureAwait(false);
            if (first == answer) return answer.Result;
            Forget(id);
            return null;
        }

        private void FailWaiting()
        {
            TaskCompletionSource<CalibDto>[] pending;
            lock (gate)
            {
                pending = new TaskCompletionSource<CalibDto>[waiting.Count];
                waiting.Values.CopyTo(pending, 0);
                waiting.Clear();
            }
            foreach (TaskCompletionSource<CalibDto> source in pending) source.TrySetResult(null);
        }

        // ---- the socket ----

        private bool Send(string json)
        {
            ClientWebSocket ws = socket;
            CancellationTokenSource source = cts;
            if (ws == null || source == null || !connected || ws.State != WebSocketState.Open) return false;
            Task ignored = SendAsync(ws, json, source.Token);
            return true;
        }

        private async Task SendAsync(ClientWebSocket ws, string json, CancellationToken token)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(json);
            try
            {
                // A WebSocket allows one send at a time.
                await sendLock.WaitAsync(token).ConfigureAwait(false);
            }
            catch (Exception)
            {
                return;
            }
            try
            {
                await ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, token).ConfigureAwait(false);
            }
            catch (Exception)
            {
                // The receive loop notices the broken socket and reconnects.
            }
            finally
            {
                sendLock.Release();
            }
        }

        private async Task RunAsync(CancellationToken token)
        {
            var buffer = new byte[8192];
            var segment = new ArraySegment<byte>(buffer);
            var message = new MemoryStream();
            string hello = "{\"type\":\"hello\",\"v\":" + ProtocolVersion.ToString(CultureInfo.InvariantCulture) +
                ",\"role\":\"display\",\"room\":" + Quote(room) + ",\"name\":" + Quote(name) + "}";

            while (!token.IsCancellationRequested)
            {
                var ws = new ClientWebSocket();
                try
                {
                    await ws.ConnectAsync(uri, token).ConfigureAwait(false);
                    socket = ws;
                    await SendAsync(ws, hello, token).ConfigureAwait(false);
                    connected = true;
                    message.SetLength(0);
                    while (ws.State == WebSocketState.Open && !token.IsCancellationRequested)
                    {
                        WebSocketReceiveResult result = await ws.ReceiveAsync(segment, token).ConfigureAwait(false);
                        if (result.MessageType == WebSocketMessageType.Close) break;
                        message.Write(buffer, 0, result.Count);
                        if (!result.EndOfMessage) continue;
                        if (result.MessageType == WebSocketMessageType.Text)
                        {
                            Handle(Encoding.UTF8.GetString(message.GetBuffer(), 0, (int)message.Length));
                        }
                        message.SetLength(0);
                    }
                }
                catch (Exception)
                {
                    // Refused, dropped or cancelled: fall through to the reconnect wait.
                }
                finally
                {
                    socket = null;
                    connected = false;
                    trackers = 0;
                    FailWaiting();
                    try
                    {
                        ws.Abort();
                    }
                    catch (Exception)
                    {
                    }
                    ws.Dispose();
                }

                if (reconnectMs <= 0) break;
                try
                {
                    await Task.Delay(reconnectMs, token).ConfigureAwait(false);
                }
                catch (Exception)
                {
                    break;
                }
            }
        }

        /// <summary>Runs on the socket's background task. Unknown types and unknown fields are ignored.</summary>
        private void Handle(string json)
        {
            try
            {
                // The type decides which fields to read: "id" is a string in welcome and a number in the
                // calibration answers, so one catch-all class cannot hold both.
                TypeDto head = JsonUtility.FromJson<TypeDto>(json);
                if (head == null || head.type == null) return;
                switch (head.type)
                {
                    case "gaze":
                    {
                        GazeDto g = JsonUtility.FromJson<GazeDto>(json);
                        var sample = new GazeSample
                        {
                            t = g.t,
                            x = g.x,
                            y = g.y,
                            rawX = g.rawX,
                            rawY = g.rawY,
                            confidence = g.confidence,
                            face = g.face,
                            blink = g.blink,
                            calibrated = g.calibrated,
                        };
                        lock (gate)
                        {
                            latest = sample;
                            hasSample = true;
                        }
                        Interlocked.Increment(ref sampleCount);
                        queue.Enqueue(sample);
                        GazeSample dropped;
                        while (queue.Count > MaxQueued && queue.TryDequeue(out dropped))
                        {
                        }
                        break;
                    }
                    case "peers":
                    case "welcome":
                    {
                        PeersDto p = JsonUtility.FromJson<PeersDto>(json);
                        trackers = p.trackers;
                        displays = p.displays;
                        break;
                    }
                    case "calib.collected":
                    case "calib.result":
                    {
                        CalibDto c = JsonUtility.FromJson<CalibDto>(json);
                        TaskCompletionSource<CalibDto> source;
                        lock (gate)
                        {
                            if (!waiting.TryGetValue(c.id, out source)) return;
                            waiting.Remove(c.id);
                        }
                        source.TrySetResult(c);
                        break;
                    }
                }
            }
            catch (Exception)
            {
                // Not JSON, or not a shape this client knows: ignore it, as the protocol asks.
            }
        }

        private static string Number(double value)
        {
            return value.ToString("R", CultureInfo.InvariantCulture);
        }

        private static string Quote(string value)
        {
            var text = new StringBuilder(value.Length + 2);
            text.Append('"');
            foreach (char c in value)
            {
                if (c == '"' || c == '\\') text.Append('\\').Append(c);
                else if (c < ' ') text.Append(' ');
                else text.Append(c);
            }
            text.Append('"');
            return text.ToString();
        }

        [Serializable]
        private sealed class TypeDto
        {
            public string type;
        }

        [Serializable]
        private sealed class PeersDto
        {
            public int trackers;
            public int displays;
        }

        [Serializable]
        private sealed class GazeDto
        {
            public double t;
            public float x;
            public float y;
            public float rawX;
            public float rawY;
            public float confidence;
            public bool face;
            public bool blink;
            public bool calibrated;
        }

        [Serializable]
        private sealed class CalibDto
        {
            public string type;
            public int id;
            public int samples;
            public bool ok;
            public string reason;
            public int targets;
            public float fitError;
            public float crossError;
        }
    }
}
