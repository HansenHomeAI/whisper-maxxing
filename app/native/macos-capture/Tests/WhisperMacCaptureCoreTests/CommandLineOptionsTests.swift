#if canImport(Testing)
import Testing
@testable import WhisperMacCaptureCore

@Suite("Command line options")
struct CommandLineOptionsTests {
    @Test("parses capture device arguments without shell interpretation")
    func captureArguments() throws {
        try expectSharedSuite("CommandLineOptions.captureArguments")
    }

    @Test("parses standalone helper modes")
    func helperModes() throws {
        try expectSharedSuite("CommandLineOptions.helperModes")
    }

    @Test("rejects unknown, incomplete, and conflicting arguments")
    func rejectsInvalidArguments() throws {
        try expectSharedSuite("CommandLineOptions.rejectsInvalidArguments")
    }
}
#endif
