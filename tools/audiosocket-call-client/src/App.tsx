import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type CallStatus = "idle" | "requesting" | "connecting" | "live" | "stopping" | "error";

type RuntimeHandles = {
  audioContext: AudioContext;
  microphoneStream: MediaStream;
  socket: WebSocket;
  source: MediaStreamAudioSourceNode;
  captureNode: AudioWorkletNode;
  playbackNode: AudioWorkletNode;
  outputStream: MediaStreamAudioDestinationNode;
};

type SinkAudioElement = HTMLAudioElement & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

const DEFAULT_URL = "ws://localhost:8080";
const MAX_SOCKET_BACKLOG_BYTES = 1_000_000;

function assertWebSocketUrl(value: string) {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a valid ws:// or wss:// server URL.");
  }

  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("Browser calls require a ws:// or wss:// server URL.");
  }

  return url.toString();
}

function deviceLabel(device: MediaDeviceInfo, fallback: string) {
  return device.label || fallback;
}

export function App() {
  const [serverUrl, setServerUrl] = useState(DEFAULT_URL);
  const [inputDeviceId, setInputDeviceId] = useState("");
  const [outputDeviceId, setOutputDeviceId] = useState("");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [status, setStatus] = useState<CallStatus>("idle");
  const [message, setMessage] = useState("Ready to connect");
  const [sampleRate, setSampleRate] = useState<number | null>(null);
  const [framesSent, setFramesSent] = useState(0);
  const [framesReceived, setFramesReceived] = useState(0);
  const [outputSelectionSupported, setOutputSelectionSupported] = useState(false);
  const audioElementRef = useRef<SinkAudioElement | null>(null);
  const runtimeRef = useRef<RuntimeHandles | null>(null);

  const inputDevices = useMemo(
    () => devices.filter((device) => device.kind === "audioinput"),
    [devices]
  );
  const outputDevices = useMemo(
    () => devices.filter((device) => device.kind === "audiooutput"),
    [devices]
  );

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setMessage("This browser does not expose media device selection.");
      return;
    }

    const nextDevices = await navigator.mediaDevices.enumerateDevices();
    setDevices(nextDevices);
  }, []);

  useEffect(() => {
    void refreshDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshDevices);
    setOutputSelectionSupported(Boolean(audioElementRef.current?.setSinkId));

    return () => {
      navigator.mediaDevices?.removeEventListener?.("devicechange", refreshDevices);
    };
  }, [refreshDevices]);

  const stopCall = useCallback(async () => {
    const runtime = runtimeRef.current;
    runtimeRef.current = null;
    setStatus((current) => (current === "idle" ? current : "stopping"));

    if (runtime) {
      if (runtime.socket.readyState === WebSocket.OPEN) {
        runtime.socket.send(JSON.stringify({ type: "stop" }));
      }

      runtime.socket.close(1000, "Call ended");
      runtime.captureNode.disconnect();
      runtime.playbackNode.disconnect();
      runtime.source.disconnect();
      runtime.outputStream.disconnect();
      runtime.microphoneStream.getTracks().forEach((track) => track.stop());
      await runtime.audioContext.close();
    }

    if (audioElementRef.current) {
      audioElementRef.current.pause();
      audioElementRef.current.srcObject = null;
    }

    setStatus("idle");
    setMessage("Call ended");
    setSampleRate(null);
  }, []);

  const startCall = useCallback(async () => {
    if (runtimeRef.current) {
      return;
    }

    setStatus("requesting");
    setMessage("Requesting microphone access");
    setFramesSent(0);
    setFramesReceived(0);

    try {
      const normalizedUrl = assertWebSocketUrl(serverUrl.trim());
      const microphoneStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: inputDeviceId ? { exact: inputDeviceId } : undefined,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      await refreshDevices();

      const audioContext = new AudioContext({ sampleRate: 16000 });
      await audioContext.audioWorklet.addModule("/capture-worklet.js");
      await audioContext.audioWorklet.addModule("/playback-worklet.js");

      const source = audioContext.createMediaStreamSource(microphoneStream);
      const captureNode = new AudioWorkletNode(audioContext, "pcm-capture-processor");
      const playbackNode = new AudioWorkletNode(audioContext, "pcm-playback-processor");
      const outputStream = audioContext.createMediaStreamDestination();
      const socket = new WebSocket(normalizedUrl);

      socket.binaryType = "arraybuffer";
      setStatus("connecting");
      setMessage("Connecting to server");

      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error("Unable to connect to the AudioSocket bridge."));
      });

      socket.send(
        JSON.stringify({
          type: "start",
          codec: "pcm_s16le",
          sampleRate: audioContext.sampleRate,
          channels: 1
        })
      );

      captureNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        if (socket.readyState !== WebSocket.OPEN) {
          return;
        }

        if (socket.bufferedAmount > MAX_SOCKET_BACKLOG_BYTES) {
          return;
        }

        socket.send(event.data);
        setFramesSent((value) => value + 1);
      };

      socket.onmessage = async (event) => {
        if (typeof event.data === "string") {
          setMessage(event.data);
          return;
        }

        const payload = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data;
        playbackNode.port.postMessage(payload, [payload]);
        setFramesReceived((value) => value + 1);
      };

      socket.onclose = () => {
        if (runtimeRef.current?.socket === socket) {
          void stopCall();
        }
      };

      playbackNode.connect(outputStream);
      source.connect(captureNode);

      if (audioElementRef.current) {
        audioElementRef.current.srcObject = outputStream.stream;

        if (outputDeviceId && audioElementRef.current.setSinkId) {
          await audioElementRef.current.setSinkId(outputDeviceId);
        }

        await audioElementRef.current.play();
      }

      runtimeRef.current = {
        audioContext,
        microphoneStream,
        socket,
        source,
        captureNode,
        playbackNode,
        outputStream
      };

      setSampleRate(audioContext.sampleRate);
      setStatus("live");
      setMessage("Call in progress");
    } catch (error) {
      await stopCall();
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Unable to start call.");
    }
  }, [inputDeviceId, outputDeviceId, refreshDevices, serverUrl, stopCall]);

  const isLive = status === "live" || status === "connecting" || status === "requesting";

  return (
    <main className="app-shell">
      <section className="call-panel">
        <div className="brand-row">
          <div className="brand-mark">VG</div>
          <div>
            <p className="eyebrow">Voice gateway tool</p>
            <h1>AudioSocket call client</h1>
          </div>
        </div>

        <div className="status-strip" data-status={status}>
          <span className="status-dot" />
          <span>{message}</span>
        </div>

        <label className="field full-span">
          <span>AudioSocket server URL</span>
          <input
            value={serverUrl}
            onChange={(event) => setServerUrl(event.target.value)}
            placeholder="ws://localhost:8080"
            disabled={isLive}
          />
        </label>

        <div className="device-grid">
          <label className="field">
            <span>Input device</span>
            <select
              value={inputDeviceId}
              onChange={(event) => setInputDeviceId(event.target.value)}
              disabled={isLive}
            >
              <option value="">System default microphone</option>
              {inputDevices.map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {deviceLabel(device, `Microphone ${index + 1}`)}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Output device</span>
            <select
              value={outputDeviceId}
              onChange={(event) => setOutputDeviceId(event.target.value)}
              disabled={isLive || !outputSelectionSupported}
            >
              <option value="">System default speaker</option>
              {outputDevices.map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {deviceLabel(device, `Speaker ${index + 1}`)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="action-row">
          <button className="secondary-button" type="button" onClick={() => void refreshDevices()}>
            Refresh devices
          </button>
          <button
            className={isLive ? "danger-button" : "primary-button"}
            type="button"
            onClick={() => (isLive ? void stopCall() : void startCall())}
          >
            {isLive ? "End call" : "Start call"}
          </button>
        </div>

        <div className="metrics-grid" aria-label="Call metrics">
          <div>
            <span>Sent</span>
            <strong>{framesSent}</strong>
          </div>
          <div>
            <span>Received</span>
            <strong>{framesReceived}</strong>
          </div>
          <div>
            <span>Sample rate</span>
            <strong>{sampleRate ? `${sampleRate} Hz` : "Idle"}</strong>
          </div>
        </div>

        {!outputSelectionSupported && (
          <p className="support-note">
            Output device switching depends on browser support for speaker selection.
          </p>
        )}
      </section>

      <audio ref={audioElementRef} autoPlay />
    </main>
  );
}
