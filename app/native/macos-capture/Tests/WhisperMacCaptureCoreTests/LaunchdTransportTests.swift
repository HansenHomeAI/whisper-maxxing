import Darwin
import Dispatch
import Foundation
import Testing
@testable import WhisperMacCaptureCore

private final class ConnectionResult: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Result<Int32, Error>?

    func store(_ result: Result<Int32, Error>) {
        lock.lock()
        value = result
        lock.unlock()
    }

    func take() -> Result<Int32, Error>? {
        lock.lock()
        defer { lock.unlock() }
        return value
    }
}

@Suite("Launchd worker transport")
struct LaunchdTransportTests {
    @Test("retries with a fresh socket until the supervisor appears")
    func retriesConnection() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("wmc-transport-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700]
        )
        defer { try? FileManager.default.removeItem(at: directory) }
        let path = directory.appendingPathComponent("capture.sock").path
        let result = ConnectionResult()
        let finished = DispatchSemaphore(value: 0)

        DispatchQueue.global().async {
            result.store(Result {
                try connectUnixSocket(path: path, timeoutMilliseconds: 2_000)
            })
            finished.signal()
        }
        usleep(150_000)

        let server = try UnixSocketServer(path: path)
        let accepted = try server.accept(
            expectedPeerPID: getpid(),
            timeoutMilliseconds: 2_000
        )
        #expect(finished.wait(timeout: .now() + 2) == .success)
        let connected = try #require(result.take()).get()
        Darwin.close(connected)
        Darwin.close(accepted)
        server.close()
    }

    @Test("canonicalizes the current executable path source")
    func canonicalizesExecutablePath() throws {
        let resolver = ExecutablePathResolver {
            "/bin/../bin/launchctl"
        }
        #expect(try resolver.resolve() == "/bin/launchctl")
    }
}
