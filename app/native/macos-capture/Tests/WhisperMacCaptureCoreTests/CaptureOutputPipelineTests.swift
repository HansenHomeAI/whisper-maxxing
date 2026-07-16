import Foundation
import Testing
@testable import WhisperMacCaptureCore

private final class PipelineFailureCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var messages: [String] = []

    func append(_ message: String) {
        lock.lock()
        messages.append(message)
        lock.unlock()
    }

    func snapshot() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return messages
    }
}

@Suite("Capture output pipeline")
struct CaptureOutputPipelineTests {
    @Test("fails visibly when the pre-ready queue reaches its bound")
    func boundsPreReadyAudio() {
        let failures = PipelineFailureCollector()
        let writer = FrameWriter(
            sink: { _ in },
            writeFailureHandler: { _ in }
        )
        let pipeline = CaptureOutputPipeline(
            writer: writer,
            maximumBufferedChunks: 2,
            failureHandler: failures.append
        )
        let samples = Array(
            repeating: Int16(1),
            count: CaptureProtocol.samplesPerFrame
        )

        pipeline.receive(samples: samples)
        pipeline.receive(samples: samples)
        #expect(failures.snapshot().isEmpty)
        pipeline.receive(samples: samples)
        #expect(failures.snapshot() == [
            "Native capture pre-ready buffer overflowed.",
        ])
    }
}
