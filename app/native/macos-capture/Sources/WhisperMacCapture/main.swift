import Darwin
import Dispatch
import Foundation
import WhisperMacCaptureCore

private let launchdWorkerOption = "--launchd-worker"

private final class CaptureApplication: @unchecked Sendable {
    private enum State {
        case idle
        case running
        case ending
    }

    private let options: CommandLineOptions
    private let standardOutput: BoundedOutput
    private let controlFileDescriptor: Int32
    private let cleanupHandler: @Sendable () -> Void
    private let lifecycleQueue = DispatchQueue(label: "whisper.mac.capture.lifecycle")
    private let backlogBudget = AudioBacklogBudget()
    private var state = State.idle
    private var signalSources: [DispatchSourceSignal] = []
    private var controlSource: DispatchSourceRead?

    private lazy var writer = FrameWriter(
        backlogBudget: backlogBudget,
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
        backlogBudget: backlogBudget,
        sampleHandler: { [weak self] samples in
            self?.outputPipeline.receive(samples: samples)
        },
        errorHandler: { [weak self] error in
            self?.scheduleFailure(message: error.localizedDescription)
        }
    )

    init(
        options: CommandLineOptions,
        standardOutput: BoundedOutput,
        controlFileDescriptor: Int32,
        cleanupHandler: @escaping @Sendable () -> Void
    ) {
        self.options = options
        self.standardOutput = standardOutput
        self.controlFileDescriptor = controlFileDescriptor
        self.cleanupHandler = cleanupHandler
    }

    func run() -> Never {
        installSignalHandlers()
        installControlMonitor()
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
        writer.finishStopped { [self] in
            terminate(EXIT_SUCCESS)
        }
    }

    private func fail(message: String) {
        guard state != .ending else { return }
        state = .ending
        capture.stop()
        outputPipeline.stop()
        fputs("whisper-mac-capture: \(message)\n", stderr)
        writer.finishError(message: message) { [self] in
            terminate(EX_SOFTWARE)
        }
    }

    private func outputWriteFailed(_ error: Error) {
        fputs(
            "whisper-mac-capture: worker socket write failed: "
                + "\(error.localizedDescription)\n",
            stderr
        )
        capture.stop()
        terminate(EX_IOERR)
    }

    private func terminate(_ code: Int32) -> Never {
        controlSource?.cancel()
        controlSource = nil
        cleanupHandler()
        Darwin.exit(code)
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

    private func installControlMonitor() {
        let source = DispatchSource.makeReadSource(
            fileDescriptor: controlFileDescriptor,
            queue: lifecycleQueue
        )
        source.setEventHandler { [weak self] in
            guard let self else { return }
            var byte = UInt8(0)
            let count = Darwin.read(controlFileDescriptor, &byte, 1)
            if count > 0 || count == 0 {
                stop()
            } else if errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR {
                stop()
            }
        }
        source.resume()
        controlSource = source
    }
}

private enum CaptureSupervisorError: Error, LocalizedError {
    case launchctlFailed(Int32)
    case workerPIDUnavailable
    case workerStreamRead(Int32)
    case invalidWorkerStream

    var errorDescription: String? {
        switch self {
        case .launchctlFailed(let status):
            return "Unable to launch the native capture worker (exit \(status))."
        case .workerPIDUnavailable:
            return "Unable to identify the native capture worker."
        case .workerStreamRead(let code):
            return "Unable to read the native capture worker (errno \(code))."
        case .invalidWorkerStream:
            return "The native capture worker returned an invalid protocol stream."
        }
    }
}

private final class LaunchdCaptureSupervisor: @unchecked Sendable {
    private let options: CommandLineOptions
    private let standardOutput: BoundedOutput
    private let lifecycleQueue = DispatchQueue(label: "whisper.mac.capture.supervisor")
    private let proxyQueue = DispatchQueue(label: "whisper.mac.capture.proxy")
    private let signalQueue = DispatchQueue(label: "whisper.mac.capture.signals")
    private let stateLock = NSLock()
    private let identifier = UUID().uuidString
        .lowercased()
        .replacingOccurrences(of: "-", with: "")
    private var connectedDescriptor = Int32(-1)
    private var stopRequested = false
    private var server: UnixSocketServer?
    private var signalSources: [DispatchSourceSignal] = []

    private var label: String {
        "com.whispermaxxing.capture.\(getpid()).\(identifier.prefix(12))"
    }

    private var socketPath: String {
        "\(privateDirectory)/capture.sock"
    }

    private var workerErrorPath: String {
        "\(privateDirectory)/worker.err"
    }

    private var privateDirectory: String {
        "/tmp/wmc-\(getpid())-\(identifier.prefix(12))"
    }

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
        do {
            try FileManager.default.createDirectory(
                atPath: privateDirectory,
                withIntermediateDirectories: false,
                attributes: [.posixPermissions: 0o700]
            )
            let newServer = try UnixSocketServer(path: socketPath)
            server = newServer
            try submitWorker()
            let workerPID = try readWorkerPID()
            let descriptor = try newServer.accept(
                expectedPeerPID: workerPID,
                timeoutMilliseconds: 10_000
            )
            newServer.close()
            server = nil

            stateLock.lock()
            connectedDescriptor = descriptor
            let shouldStop = stopRequested
            stateLock.unlock()
            if shouldStop {
                sendStopRequest()
            }
            proxyQueue.async { [self] in
                proxyWorker(descriptor: descriptor)
            }
        } catch {
            fatal(message: error.localizedDescription, exitCode: EX_SOFTWARE)
        }
    }

    private func submitWorker() throws {
        let executablePath = try ExecutablePathResolver.current.resolve()
        var workerArguments = [
            launchdWorkerOption,
            socketPath,
        ]
        if let preferredInputDevice = options.preferredInputDevice {
            workerArguments.append(contentsOf: [
                "--preferred-input-device",
                preferredInputDevice,
            ])
        }
        if options.enforcePreferredInputDevice {
            workerArguments.append("--enforce-preferred-input-device")
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = [
            "submit",
            "-l", label,
            "-o", "/dev/null",
            "-e", workerErrorPath,
            "--", executablePath,
        ] + workerArguments
        try process.run()
        process.waitUntilExit()
        guard process.terminationReason == .exit,
              process.terminationStatus == 0
        else {
            throw CaptureSupervisorError.launchctlFailed(process.terminationStatus)
        }
    }

    private func readWorkerPID() throws -> pid_t {
        let deadline = DispatchTime.now().uptimeNanoseconds + 5_000_000_000
        while DispatchTime.now().uptimeNanoseconds < deadline {
            let process = Process()
            let output = Pipe()
            process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
            process.arguments = [
                "print",
                "gui/\(getuid())/\(label)",
            ]
            process.standardOutput = output
            process.standardError = FileHandle.nullDevice
            do {
                try process.run()
                process.waitUntilExit()
                let data = output.fileHandleForReading.readDataToEndOfFile()
                let description = String(decoding: data, as: UTF8.self)
                for line in description.split(separator: "\n") {
                    let fields = line.trimmingCharacters(in: .whitespaces)
                        .split(separator: "=", maxSplits: 1)
                    if fields.count == 2,
                       fields[0].trimmingCharacters(in: .whitespaces) == "pid",
                       let pid = pid_t(fields[1].trimmingCharacters(in: .whitespaces)),
                       pid > 0 {
                        return pid
                    }
                }
            } catch {}
            usleep(50_000)
        }
        throw CaptureSupervisorError.workerPIDUnavailable
    }

    private func proxyWorker(descriptor: Int32) {
        var decoder = WorkerProtocolStreamDecoder()
        var bytes = [UInt8](repeating: 0, count: 8_192)
        do {
            while true {
                let count = Darwin.read(descriptor, &bytes, bytes.count)
                if count > 0 {
                    let data = Data(bytes[0..<count])
                    for frame in try decoder.append(data) {
                        try standardOutput.write(frame)
                    }
                    continue
                }
                if count == 0 { break }
                if errno == EINTR { continue }
                throw CaptureSupervisorError.workerStreamRead(errno)
            }
            let terminalType = try decoder.finish()
            let exitCode = terminalType == .stopped
                ? EXIT_SUCCESS
                : EX_SOFTWARE
            finish(exitCode: exitCode)
        } catch let error as BoundedOutputError {
            fputs(
                "whisper-mac-capture: stdout write failed: "
                    + "\(error.localizedDescription)\n",
                stderr
            )
            finish(exitCode: EX_IOERR)
        } catch {
            fatal(message: error.localizedDescription, exitCode: EX_SOFTWARE)
        }
    }

    private func requestStop() {
        stateLock.lock()
        stopRequested = true
        let descriptor = connectedDescriptor
        stateLock.unlock()
        if descriptor >= 0 {
            sendStopRequest()
        }
    }

    private func sendStopRequest() {
        stateLock.lock()
        let descriptor = connectedDescriptor
        stateLock.unlock()
        guard descriptor >= 0 else { return }
        var byte = UInt8(1)
        _ = Darwin.write(descriptor, &byte, 1)
    }

    private func fatal(message: String, exitCode: Int32) -> Never {
        fputs("whisper-mac-capture: \(message)\n", stderr)
        do {
            try standardOutput.write(try CaptureProtocol.errorFrame(message: message))
        } catch {
            finish(exitCode: EX_IOERR)
        }
        finish(exitCode: exitCode)
    }

    private func finish(exitCode: Int32) -> Never {
        stateLock.lock()
        let descriptor = connectedDescriptor
        connectedDescriptor = -1
        stateLock.unlock()
        if descriptor >= 0 {
            _ = Darwin.shutdown(descriptor, SHUT_RDWR)
            Darwin.close(descriptor)
        }
        server?.close()
        server = nil
        removeWorkerJob()
        forwardWorkerErrors()
        try? FileManager.default.removeItem(atPath: privateDirectory)
        Darwin.exit(exitCode)
    }

    private func removeWorkerJob() {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = ["remove", label]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        fflush(stderr)
        do {
            try process.run()
            process.waitUntilExit()
        } catch {}
    }

    private func forwardWorkerErrors() {
        defer { _ = Darwin.unlink(workerErrorPath) }
        guard let data = FileManager.default.contents(atPath: workerErrorPath),
              !data.isEmpty
        else { return }
        FileHandle.standardError.write(data)
    }

    private func installSignalHandlers() {
        for signalNumber in [SIGTERM, SIGINT] {
            Darwin.signal(signalNumber, SIG_IGN)
            let source = DispatchSource.makeSignalSource(
                signal: signalNumber,
                queue: signalQueue
            )
            source.setEventHandler { [weak self] in
                self?.requestStop()
            }
            source.resume()
            signalSources.append(source)
        }
    }
}

private final class WorkerCleanup: @unchecked Sendable {
    private let descriptor: Int32
    private let lock = NSLock()
    private var cleaned = false

    init(descriptor: Int32) {
        self.descriptor = descriptor
    }

    func run() {
        lock.lock()
        guard !cleaned else {
            lock.unlock()
            return
        }
        cleaned = true
        lock.unlock()

        _ = Darwin.shutdown(descriptor, SHUT_RDWR)
        Darwin.close(descriptor)
        guard let label = ProcessInfo.processInfo.environment["XPC_SERVICE_NAME"],
              label.hasPrefix("com.whispermaxxing.capture.")
        else { return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = ["remove", label]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        fflush(stderr)
        do {
            try process.run()
            process.waitUntilExit()
        } catch {}
    }
}

private func runLaunchdWorker(arguments: [String]) -> Never {
    guard let socketPath = arguments.first, !socketPath.hasPrefix("--") else {
        printError("Missing launchd worker socket path.")
        Darwin.exit(EX_USAGE)
    }
    let identity: LaunchdWorkerIdentity
    do {
        identity = try LaunchdWorkerIdentity(
            parentPID: getppid(),
            serviceName: ProcessInfo.processInfo.environment["XPC_SERVICE_NAME"]
        )
    } catch {
        printError(error.localizedDescription)
        Darwin.exit(EX_NOPERM)
    }
    let options: CommandLineOptions
    do {
        options = try CommandLineOptions.parse(
            arguments: Array(arguments.dropFirst())
        )
        guard options.mode == .capture else {
            throw CommandLineError.modeDoesNotAcceptCaptureOptions
        }
    } catch {
        printError(error.localizedDescription)
        Darwin.exit(EX_USAGE)
    }

    let descriptor: Int32
    do {
        descriptor = try connectUnixSocket(path: socketPath)
        try validateUnixSocketPeer(descriptor, identity: identity)
    } catch {
        printError(error.localizedDescription)
        removeCurrentLaunchdJob()
        Darwin.exit(EX_UNAVAILABLE)
    }
    let cleanup = WorkerCleanup(descriptor: descriptor)
    let output: BoundedOutput
    do {
        output = try BoundedOutput(fileDescriptor: descriptor)
    } catch {
        printError("worker socket setup failed: \(error.localizedDescription)")
        cleanup.run()
        Darwin.exit(EX_IOERR)
    }

    CaptureApplication(
        options: options,
        standardOutput: output,
        controlFileDescriptor: descriptor,
        cleanupHandler: cleanup.run
    ).run()
}

private func removeCurrentLaunchdJob() {
    guard let label = ProcessInfo.processInfo.environment["XPC_SERVICE_NAME"],
          label.hasPrefix("com.whispermaxxing.capture.")
    else { return }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    process.arguments = ["remove", label]
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    fflush(stderr)
    do {
        try process.run()
        process.waitUntilExit()
    } catch {}
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

let rawArguments = Array(CommandLine.arguments.dropFirst())
if rawArguments.first == launchdWorkerOption {
    runLaunchdWorker(arguments: Array(rawArguments.dropFirst()))
}

let options: CommandLineOptions
do {
    options = try CommandLineOptions.parse(arguments: rawArguments)
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
                + "(protocol, conversion, CLI, ordering, queue bounds, bounded output)\n",
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
    LaunchdCaptureSupervisor(
        options: options,
        standardOutput: standardOutput
    ).run()
}
