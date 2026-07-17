#if canImport(Testing)
import Testing
@testable import WhisperMacCaptureCore

@Suite("Bounded output")
struct BoundedOutputTests {
    @Test("times out instead of blocking forever")
    func timesOut() throws {
        try expectSharedSuite("BoundedOutput.timesOut")
    }
}
#endif
