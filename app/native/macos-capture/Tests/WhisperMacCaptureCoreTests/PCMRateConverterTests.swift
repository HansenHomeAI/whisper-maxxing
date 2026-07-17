#if canImport(Testing)
import Testing
@testable import WhisperMacCaptureCore

@Suite("PCM sample-rate converter")
struct PCMRateConverterTests {
    @Test(
        "converts fragmented input to exact long-run 16 kHz PCM",
        arguments: [44_100, 48_000]
    )
    func convertsFragmentedInput(inputSampleRate: Int) throws {
        try expectSharedSuite(
            "PCMRateConverter.converts\(inputSampleRate)Hz"
        )
    }

    @Test("conversion queue shares the output bound and drains before stop")
    func queueBoundAndStop() throws {
        try expectSharedSuite("PCMRateConverter.queueBoundAndStop")
    }

    @Test("rejects an invalid hardware sample rate")
    func rejectsInvalidSampleRate() throws {
        try expectSharedSuite("PCMRateConverter.rejectsInvalidRate")
    }
}
#endif
