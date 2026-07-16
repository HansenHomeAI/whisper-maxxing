import Darwin
import Dispatch
import Foundation
import WhisperMacCaptureCore

private final class CaptureApplication: @unchecked Sendable {
    private enum State {
        case idle
        case running
        case ending
    }

    private let options: CommandLineOptions
    private let lifecycleQueue = DispatchQueue(label: "whisper.mac.capture.lifecycle")
    private var state = State.idle
    private var signalSources: [DispatchSourceSignal] = []

    private lazy var writer = FrameWriter(
        sink: { data in
            try FileHandle.standardOutput.write(contentsOf: data)
        },
        writeFailureHandler: { [weak self] error in
            self?.scheduleOutputWriteFailure(error)
        }
    )

    private lazy var outputPipeline = CaptureOutputPipeline(
        writer: writer,
        failureHandler: { [weak self] message in
            self?.scheduleFailure(message: message)
        }
    )

    private lazy var capture = AudioCaptureEngine(
        preferredInputDevice: options.preferredInputDevice,
        enforcePreferredInputDevice: options.enforcePreferredInputDevice,
        sampleHandler: { [weak self] samples in
            self?.outputPipeline.receive(samples: samples)
        },
        errorHandler: { [weak self] error in
            self?.scheduleFailure(message: error.localizedDescription)
        }
    )

    init(options: CommandLineOptions) {
        self.options = options
    }

    func run() -> Never {
        installSignalHandlers()
        lifecycleQueue.async { [self] in
            start()
        }
        dispatchMain()
    }

    private func start() {
        guard state == .idle else { return }
        do {
            let defaultInputDeviceName = try capture.start()
            guard writer.enqueueReady(
                defaultInputDeviceName: defaultInputDeviceName
            ) == .accepted else {
                fail(message: "Unable to write the native capture ready frame.")
                return
            }
            state = .running
            outputPipeline.activate()
        } catch {
            fail(message: error.localizedDescription)
        }
    }

    private func stop() {
        guard state != .ending else { return }
        state = .ending
        capture.stop()
        outputPipeline.stop()
        cancelSignalHandlers()
        writer.finishStopped {
            Darwin.exit(EXIT_SUCCESS)
        }
    }

    private func fail(message: String) {
        guard state != .ending else { return }
        state = .ending
        capture.stop()
        outputPipeline.stop()
        cancelSignalHandlers()
        fputs("whisper-mac-capture: \(message)\n", stderr)
        writer.finishError(message: message) {
            Darwin.exit(EX_SOFTWARE)
        }
    }

    private func outputWriteFailed(_ error: Error) {
        fputs(
            "whisper-mac-capture: stdout write failed: \(error.localizedDescription)\n",
            stderr
        )
        capture.stop()
        Darwin.exit(EX_IOERR)
    }

    private func scheduleFailure(message: String) {
        lifecycleQueue.async { [self] in
            fail(message: message)
        }
    }

    private func scheduleOutputWriteFailure(_ error: Error) {
        lifecycleQueue.async { [self] in
            outputWriteFailed(error)
        }
    }

    private func installSignalHandlers() {
        for signalNumber in [SIGTERM, SIGINT] {
            Darwin.signal(signalNumber, SIG_IGN)
            let source = DispatchSource.makeSignalSource(
                signal: signalNumber,
                queue: lifecycleQueue
            )
            source.setEventHandler { [weak self] in
                self?.stop()
            }
            source.resume()
            signalSources.append(source)
        }
    }

    private func cancelSignalHandlers() {
        signalSources.forEach { $0.cancel() }
        signalSources.removeAll()
    }
}

private func writeSelfTest() throws {
    for frame in try SelfTest.frames() {
        try FileHandle.standardOutput.write(contentsOf: frame)
    }
}

private func printError(_ message: String) {
    fputs("whisper-mac-capture: \(message)\n", stderr)
}

let options: CommandLineOptions
do {
    options = try CommandLineOptions.parse(
        arguments: Array(CommandLine.arguments.dropFirst())
    )
} catch {
    printError(error.localizedDescription)
    Darwin.exit(EX_USAGE)
}

switch options.mode {
case .version:
    print(CaptureProtocol.version)
case .selfTest:
    do {
        try writeSelfTest()
    } catch {
        printError(error.localizedDescription)
        Darwin.exit(EX_IOERR)
    }
case .capture:
    CaptureApplication(options: options).run()
}
