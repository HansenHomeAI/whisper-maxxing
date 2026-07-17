#if canImport(XCTest)
import XCTest
@testable import WhisperMacCaptureCore

final class SharedInventoryXCTests: XCTestCase {
    func testPinnedNativeHelperInventory() throws {
        let result = try SelfTest.run(includeFilesystemSocketTest: false)
        XCTAssertEqual(result.suites.count, 22)
        XCTAssertEqual(result.suites.map(\.name), [
            "CaptureProtocol.readyFrame",
            "CaptureProtocol.pcmIsLittleEndian",
            "CaptureProtocol.rejectsInvalidFrames",
            "SampleChunker.chunksFragmentedInput",
            "PCMRateConverter.converts44100Hz",
            "PCMRateConverter.converts48000Hz",
            "PCMRateConverter.queueBoundAndStop",
            "PCMRateConverter.rejectsInvalidRate",
            "CommandLineOptions.captureArguments",
            "CommandLineOptions.helperModes",
            "CommandLineOptions.rejectsInvalidArguments",
            "FrameWriter.orderedFrames",
            "FrameWriter.queueIsBounded",
            "CaptureOutputPipeline.boundsPreReadyAudio",
            "BoundedOutput.timesOut",
            "LaunchdTransport.canonicalizesExecutablePath",
            "LaunchdTransport.retriesFreshDescriptors",
            "WorkerProtocol.forwardsCompleteFrames",
            "WorkerProtocol.rejectsPartialEOF",
            "LaunchdWorker.rejectsInvalidIdentity",
            "AudioBacklogBudget.boundsTwoSeconds",
            "AudioBacklogBudget.surfacesOverload",
        ])
        XCTAssertTrue(result.suites.allSatisfy { $0.assertionCount > 0 })
        XCTAssertEqual(
            result.assertionCount,
            result.suites.reduce(0) { $0 + $1.assertionCount }
        )
        for (index, suite) in result.suites.enumerated() {
            print(
                "Test \(index + 1)/\(result.suites.count): \(suite.name) "
                    + "passed (\(suite.assertionCount) assertions)"
            )
        }
        print(
            "NATIVE HELPER TEST HARNESS PASSED: \(result.suites.count) tests, "
                + "\(result.assertionCount) assertions, 0 failures"
        )
    }
}
#endif
