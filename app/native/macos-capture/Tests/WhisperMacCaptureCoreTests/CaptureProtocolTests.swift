#if canImport(Testing)
import Testing
@testable import WhisperMacCaptureCore

@Suite("Capture protocol")
struct CaptureProtocolTests {
    @Test("encodes the frozen ready payload and header")
    func readyFrame() throws {
        try expectSharedSuite("CaptureProtocol.readyFrame")
    }

    @Test("encodes signed PCM explicitly as little endian")
    func pcmIsLittleEndian() throws {
        try expectSharedSuite("CaptureProtocol.pcmIsLittleEndian")
    }

    @Test("rejects frames that violate protocol limits")
    func rejectsInvalidFrames() throws {
        try expectSharedSuite("CaptureProtocol.rejectsInvalidFrames")
    }
}
#endif
