const { ipcRenderer } = require("electron");

let stream = null;
let context = null;
let sourceNode = null;
let workletNode = null;
let mainPort = null;
let transferStatusReported = false;

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
      void stopCapture()
        .then(() => mainPort?.postMessage({ type: "stopped" }))
        .catch((error) => {
          postError(error);
        });
    }
  };
  mainPort.start();
  mainPort.postMessage({ type: "connected" });
});

async function startCapture(options) {
  try {
    transferStatusReported = false;
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
    workletNode.onprocessorerror = () => {
      postError(new Error("Audio capture worklet processor failed."));
    };
    workletNode.port.onmessage = (workletEvent) => {
      try {
        const frame = workletEvent.data;
        const samples =
          frame.samples instanceof Int16Array
            ? frame.samples
            : new Int16Array(frame.samples);
        const senderBuffer = samples.buffer;
        const transferredBuffer = structuredClone(senderBuffer, {
          transfer: [senderBuffer],
        });
        mainPort?.postMessage({ ...frame, samples: transferredBuffer });
        if (!transferStatusReported) {
          transferStatusReported = true;
          mainPort?.postMessage({
            type: "transferStatus",
            detached: senderBuffer.byteLength === 0,
          });
        }
      } catch (error) {
        postError(error);
      }
    };
    sourceNode.connect(workletNode);
    workletNode.connect(context.destination);
    await context.resume();
    mainPort?.postMessage({
      type: "ready",
      defaultInputDeviceName: track.label || null,
    });
  } catch (error) {
    let surfacedError = error;
    try {
      await stopCapture();
    } catch (cleanupError) {
      surfacedError = new AggregateError(
        [toError(error), toError(cleanupError)],
        "Audio capture startup and renderer cleanup both failed.",
      );
    }
    postError(surfacedError);
  }
}

async function stopCapture() {
  const errors = [];
  try {
    workletNode?.disconnect();
  } catch (error) {
    errors.push(toError(error));
  }
  try {
    sourceNode?.disconnect();
  } catch (error) {
    errors.push(toError(error));
  }
  workletNode = null;
  sourceNode = null;
  for (const track of stream?.getTracks() ?? []) {
    try {
      track.stop();
    } catch (error) {
      errors.push(toError(error));
    }
  }
  stream = null;
  if (context) {
    try {
      await context.close();
    } catch (error) {
      errors.push(toError(error));
    }
    context = null;
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Audio capture renderer cleanup failed.");
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

function postError(error) {
  mainPort?.postMessage({
    type: "error",
    message: errorMessage(error),
  });
}

function errorMessage(error) {
  if (error instanceof AggregateError) {
    return `${error.message} ${error.errors.map(errorMessage).join("; ")}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function toError(error) {
  return error instanceof Error ? error : new Error(String(error));
}
