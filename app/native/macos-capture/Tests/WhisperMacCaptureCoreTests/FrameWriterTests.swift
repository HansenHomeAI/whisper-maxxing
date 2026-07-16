import Foundation
import Testing
@testable import WhisperMacCaptureCore

private final class FailureCollector: @unchecked Sendable {
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

@Suite("Frame writer")
struct FrameWriterTests {
    @Test("bounds the serial PCM output queue")
    func queueIsBounded() {
        let writeStarted = DispatchSemaphore(value: 0)
        let allowWrites = DispatchSemaphore(value: 0)
        let failures = FailureCollector()
        let writer = FrameWriter(
            maximumPendingPCMFrames: 2,
            sink: { _ in
                writeStarted.signal()
                allowWrites.wait()
            },
            writeFailureHandler: failures.append
        )
        let samples = Array(
            repeating: Int16(1),
            count: CaptureProtocol.samplesPerFrame
        )

        #expect(writer.enqueuePCM(samples: samples) == .accepted)
        writeStarted.wait()
        defer {
            allowWrites.signal()
            allowWrites.signal()
        }
        #expect(writer.enqueuePCM(samples: samples) == .accepted)
        #expect(writer.enqueuePCM(samples: samples) == .overflow)
        #expect(failures.count == 0)
    }
}
