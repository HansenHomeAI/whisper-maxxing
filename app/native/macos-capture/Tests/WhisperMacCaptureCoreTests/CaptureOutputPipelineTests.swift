#if canImport(Testing)
import Testing
@testable import WhisperMacCaptureCore

@Suite("Capture output pipeline")
struct CaptureOutputPipelineTests {
    @Test("fails visibly when the pre-ready queue reaches its bound")
    func boundsPreReadyAudio() throws {
        try expectSharedSuite("CaptureOutputPipeline.boundsPreReadyAudio")
    }
}
#endif
