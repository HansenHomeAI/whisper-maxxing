import Darwin
import Dispatch
import Foundation
import MachO

public enum LaunchdTransportError: Error, LocalizedError {
    case socketCreation(Int32)
    case socketPathTooLong
    case bind(Int32)
    case listen(Int32)
    case acceptTimedOut
    case accept(Int32)
    case peerIdentity(Int32)
    case unexpectedPeer(pid_t, pid_t)
    case connectTimedOut(Int32)
    case executablePath(Int32)

    public var errorDescription: String? {
        switch self {
        case .socketCreation(let code):
            return "Unable to create the native capture socket (errno \(code))."
        case .socketPathTooLong:
            return "The native capture socket path is too long."
        case .bind(let code):
            return "Unable to bind the native capture socket (errno \(code))."
        case .listen(let code):
            return "Unable to listen on the native capture socket (errno \(code))."
        case .acceptTimedOut:
            return "Timed out waiting for the launchd capture worker."
        case .accept(let code):
            return "Unable to accept the launchd capture worker (errno \(code))."
        case .peerIdentity(let code):
            return "Unable to verify the launchd capture worker (errno \(code))."
        case .unexpectedPeer(let expected, let actual):
            return "The native capture worker identity did not match (expected \(expected), received \(actual))."
        case .connectTimedOut(let code):
            return "Unable to connect to the native capture supervisor (errno \(code))."
        case .executablePath(let code):
            return "Unable to resolve the native capture executable (errno \(code))."
        }
    }
}

public final class UnixSocketServer: @unchecked Sendable {
    public let path: String
    private let lock = NSLock()
    private var descriptor: Int32
    private var removedPath = false

    public init(path: String) throws {
        self.path = path
        descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else {
            throw LaunchdTransportError.socketCreation(errno)
        }
        do {
            _ = Darwin.unlink(path)
            let bindStatus = try withUnixSocketAddress(path: path) { address, size in
                Darwin.bind(descriptor, address, size)
            }
            guard bindStatus == 0 else {
                throw LaunchdTransportError.bind(errno)
            }
            guard Darwin.listen(descriptor, 1) == 0 else {
                throw LaunchdTransportError.listen(errno)
            }
        } catch {
            Darwin.close(descriptor)
            descriptor = -1
            _ = Darwin.unlink(path)
            throw error
        }
    }

    deinit {
        close()
    }

    public func accept(
        expectedPeerPID: pid_t,
        timeoutMilliseconds: Int
    ) throws -> Int32 {
        precondition(timeoutMilliseconds > 0)
        precondition(expectedPeerPID > 0)
        lock.lock()
        let listeningDescriptor = descriptor
        lock.unlock()
        guard listeningDescriptor >= 0 else {
            throw LaunchdTransportError.accept(EBADF)
        }

        let deadline = DispatchTime.now().uptimeNanoseconds
            + UInt64(timeoutMilliseconds) * 1_000_000
        var pollDescriptor = pollfd(
            fd: listeningDescriptor,
            events: Int16(POLLIN),
            revents: 0
        )
        var unexpectedPeerPID: pid_t?
        while true {
            let now = DispatchTime.now().uptimeNanoseconds
            guard now < deadline else {
                if let unexpectedPeerPID {
                    throw LaunchdTransportError.unexpectedPeer(
                        expectedPeerPID,
                        unexpectedPeerPID
                    )
                }
                throw LaunchdTransportError.acceptTimedOut
            }
            let remainingMilliseconds = Int32(
                min(
                    UInt64(Int32.max),
                    (deadline - now + 999_999) / 1_000_000
                )
            )
            let result = poll(&pollDescriptor, 1, remainingMilliseconds)
            if result > 0 {
                let connectedDescriptor = Darwin.accept(
                    listeningDescriptor,
                    nil,
                    nil
                )
                guard connectedDescriptor >= 0 else {
                    if errno == EINTR { continue }
                    throw LaunchdTransportError.accept(errno)
                }
                do {
                    let peerPID = try unixSocketPeerPID(connectedDescriptor)
                    guard peerPID == expectedPeerPID else {
                        unexpectedPeerPID = peerPID
                        Darwin.close(connectedDescriptor)
                        continue
                    }
                    removePath()
                    return connectedDescriptor
                } catch {
                    Darwin.close(connectedDescriptor)
                    throw error
                }
            }
            if result == 0 {
                throw LaunchdTransportError.acceptTimedOut
            }
            if errno != EINTR {
                throw LaunchdTransportError.accept(errno)
            }
        }
    }

    public func close() {
        lock.lock()
        let descriptorToClose = descriptor
        descriptor = -1
        lock.unlock()
        if descriptorToClose >= 0 {
            Darwin.close(descriptorToClose)
        }
        removePath()
    }

    private func removePath() {
        lock.lock()
        let shouldRemove = !removedPath
        removedPath = true
        lock.unlock()
        if shouldRemove {
            _ = Darwin.unlink(path)
        }
    }
}

public struct ExecutablePathResolver: Sendable {
    public typealias RawPathProvider = @Sendable () throws -> String

    private let rawPathProvider: RawPathProvider

    public init(rawPathProvider: @escaping RawPathProvider) {
        self.rawPathProvider = rawPathProvider
    }

    public func resolve() throws -> String {
        let rawPath = try rawPathProvider()
        let absolutePath: String
        if rawPath.hasPrefix("/") {
            absolutePath = rawPath
        } else {
            absolutePath = URL(
                fileURLWithPath: FileManager.default.currentDirectoryPath
            ).appendingPathComponent(rawPath).path
        }
        guard let resolved = Darwin.realpath(absolutePath, nil) else {
            throw LaunchdTransportError.executablePath(errno)
        }
        defer { Darwin.free(resolved) }
        return String(cString: resolved)
    }

    public static let current = ExecutablePathResolver {
        var size = UInt32(0)
        _ = _NSGetExecutablePath(nil, &size)
        var buffer = [CChar](repeating: 0, count: Int(size))
        guard _NSGetExecutablePath(&buffer, &size) == 0 else {
            throw LaunchdTransportError.executablePath(ENAMETOOLONG)
        }
        return String(
            decoding: buffer.prefix { $0 != 0 }.map(UInt8.init(bitPattern:)),
            as: UTF8.self
        )
    }
}

public func connectUnixSocket(
    path: String,
    timeoutMilliseconds: Int = 5_000
) throws -> Int32 {
    precondition(timeoutMilliseconds > 0)
    let deadline = DispatchTime.now().uptimeNanoseconds
        + UInt64(timeoutMilliseconds) * 1_000_000
    var lastError = ECONNREFUSED

    while DispatchTime.now().uptimeNanoseconds < deadline {
        let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else {
            throw LaunchdTransportError.socketCreation(errno)
        }
        let status = try withUnixSocketAddress(path: path) { address, size in
            Darwin.connect(descriptor, address, size)
        }
        if status == 0 {
            return descriptor
        }
        lastError = errno
        Darwin.close(descriptor)
        guard [ENOENT, ECONNREFUSED, EINTR].contains(lastError) else {
            throw LaunchdTransportError.connectTimedOut(lastError)
        }
        usleep(50_000)
    }

    throw LaunchdTransportError.connectTimedOut(lastError)
}

private func withUnixSocketAddress<Result>(
    path: String,
    body: (UnsafePointer<sockaddr>, socklen_t) throws -> Result
) throws -> Result {
    let pathBytes = Array(path.utf8CString)
    var address = sockaddr_un()
    let pathCapacity = MemoryLayout.size(ofValue: address.sun_path)
    guard pathBytes.count <= pathCapacity else {
        throw LaunchdTransportError.socketPathTooLong
    }
    address.sun_family = sa_family_t(AF_UNIX)
    withUnsafeMutableBytes(of: &address.sun_path) { destination in
        pathBytes.withUnsafeBytes { source in
            destination.copyBytes(from: source)
        }
    }
    return try withUnsafePointer(to: &address) { pointer in
        try pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            try body($0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
}

private func unixSocketPeerPID(_ descriptor: Int32) throws -> pid_t {
    var peerPID = pid_t(0)
    var size = socklen_t(MemoryLayout<pid_t>.size)
    let status = getsockopt(
        descriptor,
        SOL_LOCAL,
        LOCAL_PEERPID,
        &peerPID,
        &size
    )
    guard status == 0, peerPID > 0 else {
        throw LaunchdTransportError.peerIdentity(errno)
    }
    return peerPID
}
