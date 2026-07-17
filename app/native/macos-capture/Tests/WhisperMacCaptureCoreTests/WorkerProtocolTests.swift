#if canImport(Testing)
import Testing
@testable import WhisperMacCaptureCore

@Suite("Worker protocol stream")
struct WorkerProtocolTests {
    @Test("forwards only complete validated protocol frames")
    func forwardsCompleteFrames() throws {
        try expectSharedSuite("WorkerProtocol.forwardsCompleteFrames")
    }

    @Test("rejects a worker EOF in the middle of a frame")
    func rejectsPartialEOF() throws {
        try expectSharedSuite("WorkerProtocol.rejectsPartialEOF")
    }

    @Test("rejects terminal frames followed by one to four trailing bytes")
    func rejectsTerminalTrailingBytes() throws {
        try expectSharedSuite("WorkerProtocol.rejectsTerminalTrailingBytes")
    }
}
#endif
