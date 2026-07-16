import Testing
@testable import WhisperMacCaptureCore

@Suite("Command line options")
struct CommandLineOptionsTests {
    @Test("parses capture device arguments without shell interpretation")
    func captureArguments() throws {
        let options = try CommandLineOptions.parse(arguments: [
            "--preferred-input-device",
            "Microphone $(touch /tmp/never-run)",
            "--enforce-preferred-input-device",
        ])
        #expect(options == CommandLineOptions(
            mode: .capture,
            preferredInputDevice: "Microphone $(touch /tmp/never-run)",
            enforcePreferredInputDevice: true
        ))
    }

    @Test("parses standalone helper modes")
    func helperModes() throws {
        #expect(try CommandLineOptions.parse(
            arguments: ["--self-test"]
        ).mode == .selfTest)
        #expect(try CommandLineOptions.parse(
            arguments: ["--version"]
        ).mode == .version)
    }

    @Test("rejects unknown, incomplete, and conflicting arguments")
    func rejectsInvalidArguments() {
        #expect(throws: CommandLineError.unknownOption("--wat")) {
            try CommandLineOptions.parse(arguments: ["--wat"])
        }
        #expect(throws: CommandLineError.missingValue("--preferred-input-device")) {
            try CommandLineOptions.parse(arguments: ["--preferred-input-device"])
        }
        #expect(throws: CommandLineError.missingValue("--preferred-input-device")) {
            try CommandLineOptions.parse(arguments: [
                "--preferred-input-device",
                "--self-test",
            ])
        }
        #expect(throws: CommandLineError.enforcementRequiresPreferredInputDevice) {
            try CommandLineOptions.parse(arguments: [
                "--enforce-preferred-input-device",
            ])
        }
        #expect(throws: CommandLineError.conflictingModes) {
            try CommandLineOptions.parse(arguments: ["--self-test", "--version"])
        }
    }
}
