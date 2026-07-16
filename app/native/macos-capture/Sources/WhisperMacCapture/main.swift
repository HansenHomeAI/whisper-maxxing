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
    private let standardOutput: BoundedOutput
    private let lifecycleQueue = DispatchQueue(label: "whisper.mac.capture.lifecycle")
    private var state = State.idle
    private var signalSources: [DispatchSourceSignal] = []

    private lazy var writer = FrameWriter(
        sink: { [standardOutput] data in
            try standardOutput.write(data)
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

    init(options: CommandLineOptions, standardOutput: BoundedOutput) {
        self.options = options
        self.standardOutput = standardOutput
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
        writer.finishStopped {
            Darwin.exit(EXIT_SUCCESS)
        }
    }

    private func fail(message: String) {
        guard state != .ending else { return }
        state = .ending
        capture.stop()
        outputPipeline.stop()
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
}

private func writeSelfTest(to output: BoundedOutput) throws -> Int {
    let result = try SelfTest.run()
    for frame in result.frames {
        try output.write(frame)
    }
    return result.assertionCount
}

private func printError(_ message: String) {
    fputs("whisper-mac-capture: \(message)\n", stderr)
}

Darwin.signal(SIGPIPE, SIG_IGN)

let options: CommandLineOptions
do {
    options = try CommandLineOptions.parse(
        arguments: Array(CommandLine.arguments.dropFirst())
    )
} catch {
    printError(error.localizedDescription)
    Darwin.exit(EX_USAGE)
}

let standardOutput: BoundedOutput
do {
    standardOutput = try BoundedOutput()
} catch {
    printError("stdout setup failed: \(error.localizedDescription)")
    Darwin.exit(EX_IOERR)
}

switch options.mode {
case .version:
    do {
        try standardOutput.write(Data("\(CaptureProtocol.version)\n".utf8))
    } catch {
        printError("stdout write failed: \(error.localizedDescription)")
        Darwin.exit(EX_IOERR)
    }
case .selfTest:
    do {
        let assertionCount = try writeSelfTest(to: standardOutput)
        fputs(
            "whisper-mac-capture: self-test assertions passed: \(assertionCount) "
                + "(protocol, chunking, CLI, ordering, queue bounds, bounded output)\n",
            stderr
        )
    } catch let error as BoundedOutputError {
        printError("stdout write failed: \(error.localizedDescription)")
        Darwin.exit(EX_IOERR)
    } catch {
        printError("self-test failed: \(error.localizedDescription)")
        Darwin.exit(EX_IOERR)
    }
case .capture:
    CaptureApplication(
        options: options,
        standardOutput: standardOutput
    ).run()
}
