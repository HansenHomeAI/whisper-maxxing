#if canImport(Testing)
import Testing
@testable import WhisperMacCaptureCore

@Suite("Audio backlog budget")
struct AudioBacklogBudgetTests {
    @Test("bounds queued audio to one hundred frames or two seconds")
    func boundsTwoSeconds() throws {
        try expectSharedSuite("AudioBacklogBudget.boundsTwoSeconds")
    }

    @Test("surfaces AVAudioEngine tap overload without blocking")
    func surfacesOverload() throws {
        try expectSharedSuite("AudioBacklogBudget.surfacesOverload")
    }
}
#endif
