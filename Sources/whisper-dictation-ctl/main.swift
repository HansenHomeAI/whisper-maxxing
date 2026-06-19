import Foundation
import WhisperDictationCore

enum CLIError: Error, LocalizedError {
    case unknownCommand(String)
    case daemonDidNotStart
    case launchAgentStartFailed(String)

    var errorDescription: String? {
        switch self {
        case .unknownCommand(let command):
            return "Unknown command '\(command)'"
        case .daemonDidNotStart:
            return "The dictation daemon did not start in time."
        case .launchAgentStartFailed(let details):
            return details
        }
    }
}

let startedAt = DispatchTime.now().uptimeNanoseconds
let launchAgentLabel = "com.hansenhomeai.whisper-dictation"
let launchAgentPlistPath =
    (NSHomeDirectory() as NSString).appendingPathComponent(
        "Library/LaunchAgents/\(launchAgentLabel).plist"
    )

do {
    let args = Array(CommandLine.arguments.dropFirst())
    let commandName = args.first ?? "status"
    let config = try AppConfig.load()
    let command = try parseCommand(commandName)
    let requestedSessionId = command == .nextResult ? args.dropFirst().first : nil

    let coldBootMilliseconds = try ensureDaemonIfNeeded(for: command, config: config)
    var response = try JSONSocketClient.send(
        ControlRequest(command: command, sessionId: requestedSessionId),
        host: config.controlHost,
        port: config.controlPort
    )

    let endedAt = DispatchTime.now().uptimeNanoseconds
    response.clientObservedMilliseconds = Double(endedAt - startedAt) / 1_000_000.0
    response.coldBootMilliseconds = coldBootMilliseconds

    let json = try JSONEncoder().encode(response)
    FileHandle.standardOutput.write(json)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    exit(response.ok ? EXIT_SUCCESS : EXIT_FAILURE)
} catch {
    var response = ControlResponse(ok: false, error: error.localizedDescription)
    let endedAt = DispatchTime.now().uptimeNanoseconds
    response.clientObservedMilliseconds = Double(endedAt - startedAt) / 1_000_000.0
    let json = try JSONEncoder().encode(response)
    FileHandle.standardOutput.write(json)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    exit(EXIT_FAILURE)
}

func parseCommand(_ raw: String) throws -> ControlCommand {
    switch raw {
    case "warmup":
        return .warmup
    case "start":
        return .start
    case "start-robust":
        return .startRobust
    case "retry-robust":
        return .retryRobust
    case "stop":
        return .stop
    case "cancel":
        return .cancel
    case "next-result":
        return .nextResult
    case "status":
        return .status
    case "shutdown":
        return .shutdown
    default:
        throw CLIError.unknownCommand(raw)
    }
}

func ensureDaemonIfNeeded(for command: ControlCommand, config: AppConfig) throws -> Double? {
    if command == .shutdown {
        return nil
    }

    if daemonIsReachable(config: config) {
        return nil
    }

    let coldStartStart = DispatchTime.now().uptimeNanoseconds
    try launchDaemon(config: config)

    let deadline = Date().addingTimeInterval(15.0)
    while Date() < deadline {
        if daemonIsReachable(config: config) {
            let coldStartEnd = DispatchTime.now().uptimeNanoseconds
            return Double(coldStartEnd - coldStartStart) / 1_000_000.0
        }
        Thread.sleep(forTimeInterval: 0.01)
    }

    throw CLIError.daemonDidNotStart
}

func daemonIsReachable(config: AppConfig) -> Bool {
    do {
        _ = try JSONSocketClient.send(
            ControlRequest(command: .status),
            host: config.controlHost,
            port: config.controlPort,
            timeoutMilliseconds: 150
        )
        return true
    } catch {
        return false
    }
}

func launchDaemon(config: AppConfig) throws {
    if FileManager.default.fileExists(atPath: launchAgentPlistPath) {
        try launchDaemonViaLaunchAgent()
        return
    }

    try launchStandaloneDaemon(config: config)
}

func launchDaemonViaLaunchAgent() throws {
    let domain = "gui/\(getuid())"
    let service = "\(domain)/\(launchAgentLabel)"

    do {
        try runLaunchctl(["kickstart", "-k", service])
        return
    } catch {
        try? runLaunchctl(["bootout", service])
        try? runLaunchctl(["bootout", domain, launchAgentPlistPath])
        try runLaunchctl(["bootstrap", domain, launchAgentPlistPath])
    }
}

func launchStandaloneDaemon(config: AppConfig) throws {
    let daemonURL = URL(fileURLWithPath: config.daemonBinaryPath)
    let process = Process()
    process.executableURL = daemonURL
    process.arguments = ["--config", AppConfig.defaultConfigPath]
    process.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)

    let logURL = URL(fileURLWithPath: config.daemonLogPath)
    let fm = FileManager.default
    try fm.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    if !fm.fileExists(atPath: logURL.path) {
        fm.createFile(atPath: logURL.path, contents: nil)
    }
    let logHandle = try FileHandle(forWritingTo: logURL)
    try logHandle.seekToEnd()
    process.standardOutput = logHandle
    process.standardError = logHandle

    try process.run()
}

func runLaunchctl(_ arguments: [String]) throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    process.arguments = arguments

    let stderrPipe = Pipe()
    process.standardError = stderrPipe

    try process.run()
    process.waitUntilExit()

    guard process.terminationStatus == 0 else {
        let stderr = String(
            data: stderrPipe.fileHandleForReading.readDataToEndOfFile(),
            encoding: .utf8
        )?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let details = stderr.isEmpty ? "launchctl \(arguments.joined(separator: " ")) failed" : stderr
        throw CLIError.launchAgentStartFailed(details)
    }
}
