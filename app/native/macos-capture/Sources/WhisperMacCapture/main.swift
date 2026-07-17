import Darwin
import Dispatch
import Foundation
import WhisperMacCaptureCore

private let launchdWorkerOption = "--launchd-worker"

private enum BoundedCommandError: Error, LocalizedError {
    case timedOut(String)

    var errorDescription: String? {
        switch self {
        case .timedOut(let command):
            return "Timed out running bounded command: \(command)."
        }
    }
}

private struct BoundedCommandResult {
    let status: Int32
    let output: Data
}

private func terminateBoundedProcess(_ process: Process) {
    process.terminate()
    let terminateDeadline = DispatchTime.now().uptimeNanoseconds + 10_000_000
    while process.isRunning,
          DispatchTime.now().uptimeNanoseconds < terminateDeadline {
        usleep(1_000)
    }
    if process.isRunning {
        Darwin.kill(process.processIdentifier, SIGKILL)
    }
    let killDeadline = DispatchTime.now().uptimeNanoseconds + 50_000_000
    while process.isRunning,
          DispatchTime.now().uptimeNanoseconds < killDeadline {
        usleep(1_000)
    }
    if !process.isRunning {
        process.waitUntilExit()
    }
}

private func runBoundedCommand(
    executable: String,
    arguments: [String],
    timeoutMilliseconds: Int,
    captureOutput: Bool = false,
    cancellationCheck: @escaping @Sendable () -> Bool = { false }
) throws -> BoundedCommandResult {
    precondition(timeoutMilliseconds > 0)
    let process = Process()
    let output = captureOutput ? Pipe() : nil
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.standardOutput = output?.fileHandleForWriting
        ?? FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    let deadline = DispatchTime.now().uptimeNanoseconds
        + UInt64(timeoutMilliseconds) * 1_000_000
    while process.isRunning {
        if cancellationCheck() {
            terminateBoundedProcess(process)
            throw LaunchdTransportError.cancelled
        }
        if DispatchTime.now().uptimeNanoseconds >= deadline {
            terminateBoundedProcess(process)
            throw BoundedCommandError.timedOut(
                ([executable] + arguments).joined(separator: " ")
            )
        }
        usleep(5_000)
    }
    process.waitUntilExit()
    output?.fileHandleForWriting.closeFile()
    let data = output?.fileHandleForReading.readDataToEndOfFile() ?? Data()
    return BoundedCommandResult(
        status: process.terminationStatus,
        output: data
    )
}

private func removeLaunchdJobChecked(label: String) throws {
    try ensureLaunchdJobRemoved(
        label: label,
        verificationAttempts: 2,
        operations: LaunchdRemovalOperations(
            remove: { label in
                try runBoundedCommand(
                    executable: "/bin/launchctl",
                    arguments: ["remove", label],
                    timeoutMilliseconds: 100
                ).status
            },
            isLoaded: { label in
                try runBoundedCommand(
                    executable: "/bin/launchctl",
                    arguments: [
                        "print",
                        "gui/\(getuid())/\(label)",
                    ],
                    timeoutMilliseconds: 75
                ).status == 0
            },
            backoff: { usleep(10_000) }
        )
    )
}

private func forceTerminateLaunchdJob(label: String) throws {
#if WMC_RUNTIME_TEST_HOOKS
    if ProcessInfo.processInfo.environment["WMC_TEST_CLEANUP_COMMAND"]
        == "hang" {
        _ = try runBoundedCommand(
            executable: try ExecutablePathResolver.current.resolve(),
            arguments: ["--runtime-test-hang"],
            timeoutMilliseconds: 100
        )
        return
    }
#endif
    _ = try runBoundedCommand(
        executable: "/bin/launchctl",
        arguments: [
            "kill",
            "SIGKILL",
            "gui/\(getuid())/\(label)",
        ],
        timeoutMilliseconds: 100
    )
}

private final class CaptureApplication: @unchecked Sendable {
    private enum State {
        case idle
        case running
        case ending
    }

    private let options: CommandLineOptions
    private let standardOutput: BoundedOutput
    private let controlFileDescriptor: Int32
    private let cleanupHandler: @Sendable () -> Error?
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
        cleanupHandler: @escaping @Sendable () -> Error?
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
        if let cleanupError = cleanupHandler() {
            fputs(
                "whisper-mac-capture: cleanup failed: "
                    + "\(cleanupError.localizedDescription)\n",
                stderr
            )
            Darwin.exit(EX_SOFTWARE)
        }
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
    case controlSignal(Int32)

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
        case .controlSignal(let code):
            return "Unable to signal the native capture worker (errno \(code))."
        }
    }
}

private struct RuntimeTestCleanupError: Error, LocalizedError {
    let operation: String

    var errorDescription: String? {
        "Injected \(operation) cleanup failure."
    }
}

private final class LaunchdCaptureSupervisor: @unchecked Sendable {
    private let options: CommandLineOptions
    private let standardOutput: BoundedOutput
    private let lifecycleQueue = DispatchQueue(label: "whisper.mac.capture.supervisor")
    private let proxyQueue = DispatchQueue(label: "whisper.mac.capture.proxy")
    private let signalQueue = DispatchQueue(label: "whisper.mac.capture.signals")
    private let stateLock = NSLock()
    private let outputLock = NSLock()
    private let lifecycle = CaptureSupervisorLifecycle()
    private let identifier = UUID().uuidString
        .lowercased()
        .replacingOccurrences(of: "-", with: "")
    private var connectedDescriptor = Int32(-1)
    private var forcedStopScheduled = false
    private var controlSignalFailure: Error?
    private var privateDirectoryCreated = false
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
            try checkCancellation()
            try createPrivateDirectory()
            try checkCancellation()
            let newServer = try UnixSocketServer(path: socketPath)
            stateLock.lock()
            server = newServer
            stateLock.unlock()
            try checkCancellation()
            try pauseForRuntimeTest(phase: "before-submit")
            _ = lifecycle.transition(to: .submitting)
            try submitWorker()
            try checkCancellation()
            try pauseForRuntimeTest(phase: "after-submit-before-connect")
            _ = lifecycle.transition(to: .awaitingWorkerPID)
            let workerPID = try readWorkerPID()
            try checkCancellation()
            _ = lifecycle.transition(to: .awaitingConnection)
            let descriptor = try newServer.accept(
                expectedPeerPID: workerPID,
                timeoutMilliseconds: 10_000,
                cancellationCheck: lifecycle.isStopRequested
            )
            newServer.close()
            stateLock.lock()
            server = nil
            connectedDescriptor = descriptor
            stateLock.unlock()
            let shouldStop = lifecycle.transition(to: .connected)
            if shouldStop {
                sendStopRequest(descriptor: descriptor)
            }
            proxyQueue.async { [self] in
                proxyWorker(descriptor: descriptor)
            }
        } catch LaunchdTransportError.cancelled {
            finishStopped(exitCode: EXIT_SUCCESS)
        } catch {
            fatal(message: error.localizedDescription, exitCode: EX_SOFTWARE)
        }
    }

    private func checkCancellation() throws {
        if lifecycle.isStopRequested() {
            throw LaunchdTransportError.cancelled
        }
    }

    private func createPrivateDirectory() throws {
        stateLock.lock()
        defer { stateLock.unlock() }
        try FileManager.default.createDirectory(
            atPath: privateDirectory,
            withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700]
        )
        privateDirectoryCreated = true
    }

    private func pauseForRuntimeTest(phase: String) throws {
#if WMC_RUNTIME_TEST_HOOKS
        guard ProcessInfo.processInfo.environment["WMC_TEST_PAUSE_PHASE"] == phase
        else { return }
        let marker = "\(privateDirectory)/runtime-test-\(phase)"
        guard FileManager.default.createFile(atPath: marker, contents: Data())
        else {
            throw RuntimeTestCleanupError(operation: "phase-marker")
        }
        let deadline = DispatchTime.now().uptimeNanoseconds + 15_000_000_000
        while !lifecycle.isStopRequested(),
              DispatchTime.now().uptimeNanoseconds < deadline {
            usleep(2_000)
        }
        try checkCancellation()
#endif
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
#if WMC_RUNTIME_TEST_HOOKS
        if ProcessInfo.processInfo.environment["WMC_TEST_WORKER_MODE"]
            == "unresponsive" {
            workerArguments.append("--runtime-test-unresponsive")
        }
#endif

        let result = try runBoundedCommand(
            executable: "/bin/launchctl",
            arguments: [
                "submit",
                "-l", label,
                "-o", "/dev/null",
                "-e", workerErrorPath,
                "--", executablePath,
            ] + workerArguments,
            timeoutMilliseconds: 2_000,
            cancellationCheck: lifecycle.isStopRequested
        )
        guard result.status == 0 else {
            throw CaptureSupervisorError.launchctlFailed(result.status)
        }
    }

    private func readWorkerPID() throws -> pid_t {
        let deadline = DispatchTime.now().uptimeNanoseconds + 5_000_000_000
        while DispatchTime.now().uptimeNanoseconds < deadline {
            try checkCancellation()
            do {
                let result = try runBoundedCommand(
                    executable: "/bin/launchctl",
                    arguments: [
                        "print",
                        "gui/\(getuid())/\(label)",
                    ],
                    timeoutMilliseconds: 150,
                    captureOutput: true,
                    cancellationCheck: lifecycle.isStopRequested
                )
                let description = String(decoding: result.output, as: UTF8.self)
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
            } catch LaunchdTransportError.cancelled {
                throw LaunchdTransportError.cancelled
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
                        try writeNonterminal(frame)
                    }
                    continue
                }
                if count == 0 { break }
                if errno == EINTR { continue }
                throw CaptureSupervisorError.workerStreamRead(errno)
            }
            let terminal = try decoder.finish()
            let exitCode = terminal.type == .stopped
                ? EXIT_SUCCESS
                : EX_SOFTWARE
            finish(terminalFrame: terminal.frame, exitCode: exitCode)
        } catch let error as BoundedOutputError {
            fputs(
                "whisper-mac-capture: stdout write failed: "
                    + "\(error.localizedDescription)\n",
                stderr
            )
            finishAfterOutputFailure(exitCode: EX_IOERR)
        } catch {
            if lifecycle.snapshot().terminalClaimed { return }
            fatal(message: error.localizedDescription, exitCode: EX_SOFTWARE)
        }
    }

    private func requestStop() {
        _ = lifecycle.requestStop()
        stateLock.lock()
        let descriptor = connectedDescriptor
        let shouldScheduleForcedStop = !forcedStopScheduled
        forcedStopScheduled = true
        stateLock.unlock()
        if descriptor >= 0 {
            sendStopRequest(descriptor: descriptor)
        }
        if shouldScheduleForcedStop {
            signalQueue.asyncAfter(
                deadline: .now() + .milliseconds(
                    CaptureSupervisorLifecycle.forcedCleanupDelayMilliseconds
                )
            ) { [weak self] in
                self?.forceCancellation()
            }
        }
    }

    private func sendStopRequest(descriptor: Int32) {
        var byte = UInt8(1)
        let written = Darwin.send(descriptor, &byte, 1, MSG_DONTWAIT)
        guard written == 1 else {
            let code = written < 0 ? errno : EIO
            let error = CaptureSupervisorError.controlSignal(code)
            stateLock.lock()
            if controlSignalFailure == nil {
                controlSignalFailure = error
            }
            stateLock.unlock()
            fputs("whisper-mac-capture: \(error.localizedDescription)\n", stderr)
            return
        }
    }

    private func forceCancellation() {
        stateLock.lock()
        let failed = controlSignalFailure != nil
        stateLock.unlock()
        finishStopped(exitCode: failed ? EX_SOFTWARE : EXIT_SUCCESS)
    }

    private func fatal(message: String, exitCode: Int32) -> Never {
        fputs("whisper-mac-capture: \(message)\n", stderr)
        do {
            finish(
                terminalFrame: try CaptureProtocol.errorFrame(message: message),
                exitCode: exitCode
            )
        } catch {
            finishAfterOutputFailure(exitCode: EX_IOERR)
        }
    }

    private func finishStopped(exitCode: Int32) -> Never {
        do {
            finish(
                terminalFrame: try CaptureProtocol.stoppedFrame(),
                exitCode: exitCode
            )
        } catch {
            finishAfterOutputFailure(exitCode: EX_IOERR)
        }
    }

    private func finish(
        terminalFrame: Data,
        exitCode: Int32
    ) -> Never {
        guard lifecycle.claimTerminal() else {
            waitForWinningFinisher()
        }
        var finalExitCode = exitCode
        outputLock.lock()
        do {
            try standardOutput.write(terminalFrame)
        } catch {
            fputs(
                "whisper-mac-capture: stdout write failed: "
                    + "\(error.localizedDescription)\n",
                stderr
            )
            finalExitCode = EX_IOERR
        }
        outputLock.unlock()
        finalExitCode = cleanup(exitCode: finalExitCode)
        Darwin.exit(finalExitCode)
    }

    private func finishAfterOutputFailure(exitCode: Int32) -> Never {
        guard lifecycle.claimTerminal() else {
            waitForWinningFinisher()
        }
        Darwin.exit(cleanup(exitCode: exitCode))
    }

    private func writeNonterminal(_ frame: Data) throws {
        outputLock.lock()
        defer { outputLock.unlock() }
        guard !lifecycle.snapshot().terminalClaimed else { return }
        try standardOutput.write(frame)
    }

    private func cleanup(exitCode: Int32) -> Int32 {
        var finalExitCode = exitCode
        stateLock.lock()
        let descriptor = connectedDescriptor
        connectedDescriptor = -1
        let currentServer = server
        server = nil
        let controlFailure = controlSignalFailure
        let shouldRemovePrivateDirectory = privateDirectoryCreated
        privateDirectoryCreated = false
        stateLock.unlock()
        if descriptor >= 0 {
            _ = Darwin.shutdown(descriptor, SHUT_RDWR)
            Darwin.close(descriptor)
        }
        currentServer?.close()
        if let controlFailure {
            fputs(
                "whisper-mac-capture: cleanup followed control failure: "
                    + "\(controlFailure.localizedDescription)\n",
                stderr
            )
            finalExitCode = EX_SOFTWARE
        }
        if lifecycle.isStopRequested() {
            do {
                try forceTerminateLaunchdJob(label: label)
            } catch {
                fputs(
                    "whisper-mac-capture: forced cleanup failed: "
                        + "\(error.localizedDescription)\n",
                    stderr
                )
                finalExitCode = EX_SOFTWARE
            }
        }
        do {
            try removeLaunchdJobChecked(label: label)
            try injectRuntimeTestCleanupFailure(operation: "launchd-removal")
        } catch {
            fputs(
                "whisper-mac-capture: cleanup failed: "
                    + "\(error.localizedDescription)\n",
                stderr
            )
            finalExitCode = EX_SOFTWARE
        }
        forwardWorkerErrors()
        do {
            if shouldRemovePrivateDirectory {
                try removeCapturePrivateDirectory(
                    path: privateDirectory,
                    remover: { path in
                        try FileManager.default.removeItem(atPath: path)
                    }
                )
                try injectRuntimeTestCleanupFailure(
                    operation: "private-directory"
                )
            }
        } catch {
            fputs(
                "whisper-mac-capture: cleanup failed: "
                    + "\(error.localizedDescription)\n",
                stderr
            )
            finalExitCode = EX_SOFTWARE
        }
        return finalExitCode
    }

    private func injectRuntimeTestCleanupFailure(operation: String) throws {
#if WMC_RUNTIME_TEST_HOOKS
        if ProcessInfo.processInfo.environment["WMC_TEST_CLEANUP_FAILURE"]
            == operation {
            throw RuntimeTestCleanupError(operation: operation)
        }
#endif
    }

    private func waitForWinningFinisher() -> Never {
        while true { usleep(100_000) }
    }

    private func forwardWorkerErrors() {
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

    func run() -> Error? {
        lock.lock()
        guard !cleaned else {
            lock.unlock()
            return nil
        }
        cleaned = true
        lock.unlock()

        _ = Darwin.shutdown(descriptor, SHUT_RDWR)
        Darwin.close(descriptor)
        return nil
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
    var optionArguments = Array(arguments.dropFirst())
    var runtimeTestUnresponsive = false
#if WMC_RUNTIME_TEST_HOOKS
    if let testOptionIndex = optionArguments.firstIndex(
        of: "--runtime-test-unresponsive"
    ) {
        runtimeTestUnresponsive = true
        optionArguments.remove(at: testOptionIndex)
    }
#endif
    let options: CommandLineOptions
    do {
        options = try CommandLineOptions.parse(
            arguments: optionArguments
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
        if let cleanupError = cleanup.run() {
            printError("cleanup failed: \(cleanupError.localizedDescription)")
            Darwin.exit(EX_SOFTWARE)
        }
        Darwin.exit(EX_IOERR)
    }
#if WMC_RUNTIME_TEST_HOOKS
    if runtimeTestUnresponsive {
        while true { pause() }
    }
#endif

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
    do {
        try removeLaunchdJobChecked(label: label)
    } catch {
        printError("cleanup failed: \(error.localizedDescription)")
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

let rawArguments = Array(CommandLine.arguments.dropFirst())
#if WMC_RUNTIME_TEST_HOOKS
if rawArguments == ["--runtime-test-hang"] {
    Darwin.signal(SIGTERM, SIG_IGN)
    Darwin.signal(SIGINT, SIG_IGN)
    while true { pause() }
}
#endif
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
