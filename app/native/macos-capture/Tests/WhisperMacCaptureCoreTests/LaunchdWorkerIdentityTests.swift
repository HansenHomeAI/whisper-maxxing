#if canImport(Testing)
import Testing
@testable import WhisperMacCaptureCore

@Suite("Launchd worker identity")
struct LaunchdWorkerIdentityTests {
    @Test("rejects direct launch and supervisor peer mismatches")
    func rejectsInvalidIdentity() throws {
        try expectSharedSuite("LaunchdWorker.rejectsInvalidIdentity")
    }
}
#endif
