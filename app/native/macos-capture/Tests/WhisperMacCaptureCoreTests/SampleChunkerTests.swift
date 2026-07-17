#if canImport(Testing)
import Testing
@testable import WhisperMacCaptureCore

@Suite("Sample chunker")
struct SampleChunkerTests {
    @Test("aggregates fragmented input into exact 20 ms chunks")
    func chunksFragmentedInput() throws {
        try expectSharedSuite("SampleChunker.chunksFragmentedInput")
    }
}
#endif
