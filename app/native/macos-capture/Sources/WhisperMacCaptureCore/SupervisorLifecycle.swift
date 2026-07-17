import Foundation

public enum CaptureSupervisorPhase: Equatable, Sendable {
    case beforeSubmit
    case submitting
    case awaitingWorkerPID
    case awaitingConnection
    case connected
    case finishing
}

public struct CaptureSupervisorSnapshot: Equatable, Sendable {
    public let phase: CaptureSupervisorPhase
    public let stopRequested: Bool
    public let terminalClaimed: Bool
}

public final class CaptureSupervisorLifecycle: @unchecked Sendable {
    public static let forcedCleanupDelayMilliseconds = 400

    private let lock = NSLock()
    private var phase = CaptureSupervisorPhase.beforeSubmit
    private var stopRequested = false
    private var terminalClaimed = false

    public init() {}

    @discardableResult
    public func transition(to phase: CaptureSupervisorPhase) -> Bool {
        lock.lock()
        self.phase = phase
        let shouldStop = stopRequested
        lock.unlock()
        return shouldStop
    }

    @discardableResult
    public func requestStop() -> CaptureSupervisorSnapshot {
        lock.lock()
        stopRequested = true
        let snapshot = CaptureSupervisorSnapshot(
            phase: phase,
            stopRequested: true,
            terminalClaimed: terminalClaimed
        )
        lock.unlock()
        return snapshot
    }

    public func isStopRequested() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return stopRequested
    }

    public func claimTerminal() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !terminalClaimed else { return false }
        terminalClaimed = true
        phase = .finishing
        return true
    }

    public func snapshot() -> CaptureSupervisorSnapshot {
        lock.lock()
        defer { lock.unlock() }
        return CaptureSupervisorSnapshot(
            phase: phase,
            stopRequested: stopRequested,
            terminalClaimed: terminalClaimed
        )
    }
}

public enum LaunchdCleanupError: Error, LocalizedError, Equatable {
    case removalFailed(label: String, status: Int32)
    case privateDirectoryRemovalFailed(path: String, detail: String)

    public var errorDescription: String? {
        switch self {
        case .removalFailed(let label, let status):
            return "Unable to remove launchd job \(label) (exit \(status)); the job is still loaded."
        case .privateDirectoryRemovalFailed(let path, let detail):
            return "Unable to remove native capture private directory \(path): \(detail)"
        }
    }
}

public struct LaunchdRemovalOperations: Sendable {
    public let remove: @Sendable (String) throws -> Int32
    public let isLoaded: @Sendable (String) throws -> Bool
    public let backoff: @Sendable () -> Void

    public init(
        remove: @escaping @Sendable (String) throws -> Int32,
        isLoaded: @escaping @Sendable (String) throws -> Bool,
        backoff: @escaping @Sendable () -> Void
    ) {
        self.remove = remove
        self.isLoaded = isLoaded
        self.backoff = backoff
    }
}

public func ensureLaunchdJobRemoved(
    label: String,
    verificationAttempts: Int = 3,
    operations: LaunchdRemovalOperations
) throws {
    precondition(verificationAttempts > 0)
    let status = try operations.remove(label)
    for attempt in 0..<verificationAttempts {
        if try !operations.isLoaded(label) { return }
        if attempt + 1 < verificationAttempts {
            operations.backoff()
        }
    }
    throw LaunchdCleanupError.removalFailed(label: label, status: status)
}

public func removeCapturePrivateDirectory(
    path: String,
    remover: @Sendable (String) throws -> Void
) throws {
    do {
        try remover(path)
    } catch {
        throw LaunchdCleanupError.privateDirectoryRemovalFailed(
            path: path,
            detail: error.localizedDescription
        )
    }
}
