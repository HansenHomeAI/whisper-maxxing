import Foundation
import Testing
@testable import WhisperMacCaptureCore

private final class ConvertedSampleCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var samples: [Int16] = []

    func append(_ input: [Int16]) {
        lock.lock()
        samples.append(contentsOf: input)
        lock.unlock()
    }

    func snapshot() -> [Int16] {
        lock.lock()
        defer { lock.unlock() }
        return samples
    }
}

private final class ConversionErrorCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var errors: [Error] = []

    func append(_ error: Error) {
        lock.lock()
        errors.append(error)
        lock.unlock()
    }

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return errors.count
    }
}

@Suite("PCM sample-rate converter")
struct PCMRateConverterTests {
    @Test(
        "converts fragmented input to exact long-run 16 kHz PCM",
        arguments: [44_100, 48_000]
    )
    func convertsFragmentedInput(inputSampleRate: Int) throws {
        let converter = try PCMRateConverter(
            inputSampleRate: Double(inputSampleRate),
            outputSampleRate: 16_000
        )
        let input = (0..<inputSampleRate).map { index in
            Int16((index % 20_000) - 10_000)
        }
        var output: [Int16] = []
        for start in stride(from: 0, to: input.count, by: 511) {
            let end = min(start + 511, input.count)
            output.append(contentsOf: try converter.convert(Array(input[start..<end])))
        }
        output.append(contentsOf: try converter.finish())

        #expect(output.count == 16_000)
        #expect(output.contains { $0 != 0 })

        let collector = ConvertedSampleCollector()
        let chunker = SampleChunker { collector.append($0) }
        chunker.append(output)
        #expect(collector.snapshot().count == 16_000)
        #expect(chunker.bufferedSampleCount == 0)
    }

    @Test("conversion queue shares the output bound and drains before stop")
    func queueBoundAndStop() throws {
        let budget = AudioBacklogBudget(maximumPCMFrames: 1)
        let output = ConvertedSampleCollector()
        let errors = ConversionErrorCollector()
        let worker = try PCMConversionWorker(
            inputSampleRate: 48_000,
            outputSampleRate: 16_000,
            backlogBudget: budget,
            outputHandler: output.append,
            errorHandler: errors.append
        )
        let interleavedStereo = (0..<960).flatMap { _ in
            [Float(0.5), Float(0.25)]
        }
        let input = NativePCMInput(
            storage: .float32([interleavedStereo]),
            frameCount: 960,
            channels: 2,
            nonInterleaved: false
        )
        #expect(worker.enqueue(input) == .accepted)
        #expect([Int16(1)].withUnsafeBufferPointer(worker.enqueue) == .overflow)
        worker.waitUntilIdle()
        let converted = output.snapshot()
        #expect(converted.count == 320)
        #expect(converted.filter { $0 != 0 }.count >= 300)
        #expect(errors.count == 0)
        #expect(worker.pendingBufferCount == 0)

        worker.stop()
        #expect([Int16(1)].withUnsafeBufferPointer(worker.enqueue) == .stopped)
    }

    @Test("rejects an invalid hardware sample rate")
    func rejectsInvalidSampleRate() {
        #expect(throws: PCMRateConverterError.self) {
            try PCMRateConverter(
                inputSampleRate: 0,
                outputSampleRate: 16_000
            )
        }
    }
}
