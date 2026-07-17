#if canImport(Testing)
import Testing
@testable import WhisperMacCaptureCore

@Suite("Launchd worker transport")
struct LaunchdTransportTests {
    @Test("retries with a fresh socket until the supervisor appears")
    func retriesConnection() throws {
        try expectSharedSuite(
            "LaunchdTransport.retriesFreshDescriptors",
            includeFilesystemSocketTest: true
        )
    }

    @Test("canonicalizes the current executable path source")
    func canonicalizesExecutablePath() throws {
        try expectSharedSuite("LaunchdTransport.canonicalizesExecutablePath")
    }
}
#endif
