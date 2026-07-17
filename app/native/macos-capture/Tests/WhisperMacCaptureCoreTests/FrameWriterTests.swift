#if canImport(Testing)
import Testing
@testable import WhisperMacCaptureCore

@Suite("Frame writer")
struct FrameWriterTests {
    @Test("preserves ready, PCM, and terminal frame order")
    func orderedFrames() throws {
        try expectSharedSuite("FrameWriter.orderedFrames")
    }

    @Test("bounds the serial PCM output queue")
    func queueIsBounded() throws {
        try expectSharedSuite("FrameWriter.queueIsBounded")
    }
}
#endif
