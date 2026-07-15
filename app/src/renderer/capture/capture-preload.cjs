const { ipcRenderer } = require("electron");

let stream = null;
let context = null;
let sourceNode = null;
let workletNode = null;
let mainPort = null;

ipcRenderer.on("capture:connect", (event) => {
  const [port] = event.ports;
  if (!port) {
    return;
  }
  mainPort = port;
  mainPort.onmessage = (portEvent) => {
    const message = portEvent.data;
    if (message?.type === "start") {
      void startCapture(message);
    } else if (message?.type === "stop") {
      void stopCapture();
    }
  };
  mainPort.start();
  mainPort.postMessage({ type: "connected" });
});

async function startCapture(options) {
  try {
    await stopCapture();
    let selectedStream = await navigator.mediaDevices.getUserMedia({
      audio: rawAudioConstraints(),
      video: false,
    });
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((device) => device.kind === "audioinput");
    const preferred = options.preferredInputDevice
      ? inputs.find((device) => device.label === options.preferredInputDevice)
      : null;

    if (
      options.preferredInputDevice &&
      !preferred &&
      options.enforcePreferredInputDevice
    ) {
      selectedStream.getTracks().forEach((track) => track.stop());
      throw new Error(
        `Preferred audio input device not found: ${options.preferredInputDevice}`,
      );
    }
    if (preferred) {
      selectedStream.getTracks().forEach((track) => track.stop());
      selectedStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...rawAudioConstraints(),
          deviceId: { exact: preferred.deviceId },
        },
        video: false,
      });
    }

    stream = selectedStream;
    const track = stream.getAudioTracks()[0];
    if (!track) {
      throw new Error("No audio input track is available.");
    }
    context = new AudioContext();
    await context.audioWorklet.addModule(
      new URL("./capture-worklet.js", document.baseURI).href,
    );
    sourceNode = context.createMediaStreamSource(stream);
    workletNode = new AudioWorkletNode(context, "whisper-capture");
    workletNode.port.onmessage = (workletEvent) => {
      const frame = workletEvent.data;
      mainPort?.postMessage(frame);
    };
    sourceNode.connect(workletNode);
    workletNode.connect(context.destination);
    await context.resume();
    mainPort?.postMessage({
      type: "ready",
      defaultInputDeviceName: track.label || null,
    });
  } catch (error) {
    await stopCapture();
    mainPort?.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function stopCapture() {
  workletNode?.disconnect();
  sourceNode?.disconnect();
  workletNode = null;
  sourceNode = null;
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  if (context) {
    await context.close();
    context = null;
  }
}

function rawAudioConstraints() {
  return {
    channelCount: 1,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
}
