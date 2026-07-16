import Darwin
import Dispatch
import Foundation

public struct SelfTestResult: Sendable {
    public let frames: [Data]
    public let assertionCount: Int
}

public enum SelfTest {
    public static func run() throws -> SelfTestResult {
        let assertions = SelfTestAssertions()
        let samples = (0..<CaptureProtocol.samplesPerFrame).map { index in
            Int16((index % 200) + 1)
        }
        let frames = [
            try CaptureProtocol.readyFrame(defaultInputDeviceName: "Self-Test Input"),
            try CaptureProtocol.pcmFrame(samples: samples),
            try CaptureProtocol.stoppedFrame(),
        ]

        try verifyProtocol(frames: frames, assertions: assertions)
        try verifySampleChunking(assertions: assertions)
        try verifyCommandLine(assertions: assertions)
        try verifyFrameWriterOrdering(samples: samples, assertions: assertions)
        try verifyFrameWriterBound(samples: samples, assertions: assertions)
        try verifyPreReadyBound(samples: samples, assertions: assertions)
        try verifyBoundedOutput(assertions: assertions)

        return SelfTestResult(
            frames: frames,
            assertionCount: assertions.count
        )
    }

    private static func verifyProtocol(
        frames: [Data],
        assertions: SelfTestAssertions
    ) throws {
        let decoded = try frames.map(decode)
        try assertions.expect(decoded.map(\.type) == [1, 2, 4], "protocol frame order")
        try assertions.expect(decoded[1].payload.count == 640, "PCM payload length")
        try assertions.expect(decoded[2].payload.isEmpty, "stopped payload")
        let ready = try JSONDecoder().decode(
            CaptureProtocol.ReadyPayload.self,
            from: decoded[0].payload
        )
        try assertions.expect(ready.protocolVersion == 1, "protocol version")
        try assertions.expect(ready.sampleRateHz == 16_000, "sample rate")
        try assertions.expect(ready.channels == 1, "channel count")
        try assertions.expect(ready.sampleFormat == "s16le", "sample format")
        try assertions.expect(
            ready.defaultInputDeviceName == "Self-Test Input",
            "self-test device name"
        )
    }

    private static func verifySampleChunking(
        assertions: SelfTestAssertions
    ) throws {
        let collector = SelfTestChunkCollector()
        let chunker = SampleChunker { collector.append($0) }
        chunker.append(Array(0..<100).map(Int16.init))
        chunker.append(Array(100..<400).map(Int16.init))
        let chunks = collector.snapshot()
        try assertions.expect(chunks.count == 1, "sample chunk count")
        try assertions.expect(
            chunks.first == Array(0..<320).map(Int16.init),
            "sample chunk contents"
        )
        try assertions.expect(chunker.bufferedSampleCount == 80, "sample remainder")
    }

    private static func verifyCommandLine(
        assertions: SelfTestAssertions
    ) throws {
        let options = try CommandLineOptions.parse(arguments: [
            "--preferred-input-device",
            "Self-Test Microphone",
            "--enforce-preferred-input-device",
        ])
        try assertions.expect(
            options.preferredInputDevice == "Self-Test Microphone",
            "preferred device argument"
        )
        try assertions.expect(options.enforcePreferredInputDevice, "device enforcement")
        try expectCommandLineError(
            ["--preferred-input-device", "--self-test"],
            expected: .missingValue("--preferred-input-device"),
            assertions: assertions
        )
        try expectCommandLineError(
            ["--enforce-preferred-input-device"],
            expected: .enforcementRequiresPreferredInputDevice,
            assertions: assertions
        )
    }

    private static func verifyFrameWriterOrdering(
        samples: [Int16],
        assertions: SelfTestAssertions
    ) throws {
        let collector = SelfTestFrameCollector()
        let failures = SelfTestErrorCollector()
        let finished = DispatchSemaphore(value: 0)
        let writer = FrameWriter(
            sink: collector.append,
            writeFailureHandler: failures.append
        )
        try assertions.expect(
            writer.enqueueReady(defaultInputDeviceName: "Ordering") == .accepted,
            "ready enqueue"
        )
        try assertions.expect(
            writer.enqueuePCM(samples: samples) == .accepted,
            "PCM enqueue"
        )
        writer.finishStopped { finished.signal() }
        try assertions.expect(
            finished.wait(timeout: .now() + 1) == .success,
            "ordered writer completion"
        )
        try assertions.expect(failures.count == 0, "ordered writer failures")
        try assertions.expect(
            try collector.snapshot().map { try decode($0).type } == [1, 2, 4],
            "ordered writer frames"
        )
    }

    private static func verifyFrameWriterBound(
        samples: [Int16],
        assertions: SelfTestAssertions
    ) throws {
        let sink = SelfTestBlockingSink()
        let failures = SelfTestErrorCollector()
        let writer = FrameWriter(
            maximumPendingPCMFrames: 2,
            sink: sink.write,
            writeFailureHandler: failures.append
        )
        defer { sink.releaseAll() }
        try assertions.expect(
            writer.enqueuePCM(samples: samples) == .accepted,
            "bounded writer first frame"
        )
        try assertions.expect(
            sink.started.wait(timeout: .now() + 1) == .success,
            "bounded writer started"
        )
        try assertions.expect(
            writer.enqueuePCM(samples: samples) == .accepted,
            "bounded writer second frame"
        )
        try assertions.expect(
            writer.enqueuePCM(samples: samples) == .overflow,
            "bounded writer overflow"
        )
        try assertions.expect(failures.count == 0, "bounded writer failures")
    }

    private static func verifyPreReadyBound(
        samples: [Int16],
        assertions: SelfTestAssertions
    ) throws {
        let failures = SelfTestStringCollector()
        let writer = FrameWriter(
            sink: { _ in },
            writeFailureHandler: { _ in }
        )
        let pipeline = CaptureOutputPipeline(
            writer: writer,
            failureHandler: failures.append
        )
        for _ in 0..<CaptureProtocol.maximumQueuedPCMFrames {
            pipeline.receive(samples: samples)
        }
        try assertions.expect(failures.count == 0, "pre-ready capacity")
        pipeline.receive(samples: samples)
        try assertions.expect(failures.count == 1, "pre-ready overflow count")
        try assertions.expect(
            failures.first == "Native capture pre-ready buffer overflowed.",
            "pre-ready overflow message"
        )
        pipeline.stop()
    }

    private static func verifyBoundedOutput(
        assertions: SelfTestAssertions
    ) throws {
        var descriptors = [Int32](repeating: 0, count: 2)
        let pipeStatus = descriptors.withUnsafeMutableBufferPointer { buffer in
            Darwin.pipe(buffer.baseAddress!)
        }
        try assertions.expect(pipeStatus == 0, "bounded output pipe")
        guard pipeStatus == 0 else { return }
        let readDescriptor = descriptors[0]
        let writeDescriptor = descriptors[1]
        defer {
            Darwin.close(readDescriptor)
            Darwin.close(writeDescriptor)
        }

        let flags = fcntl(writeDescriptor, F_GETFL)
        guard flags >= 0,
              fcntl(writeDescriptor, F_SETFL, flags | O_NONBLOCK) >= 0
        else {
            throw SelfTestFailure("unable to configure bounded output pipe")
        }
        let fill = [UInt8](repeating: 1, count: 4_096)
        try fill.withUnsafeBytes { bytes in
            while true {
                let written = Darwin.write(
                    writeDescriptor,
                    bytes.baseAddress!,
                    bytes.count
                )
                if written > 0 || (written < 0 && errno == EINTR) {
                    continue
                }
                try assertions.expect(
                    written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK),
                    "bounded output pipe filled"
                )
                break
            }
        }

        let output = try BoundedOutput(
            fileDescriptor: writeDescriptor,
            writeTimeoutMilliseconds: 20
        )
        do {
            try output.write(Data([1]))
            throw SelfTestFailure("blocked output unexpectedly accepted data")
        } catch let error as BoundedOutputError {
            try assertions.expect(error == .timedOut, "bounded output timeout")
        }
    }

    private static func expectCommandLineError(
        _ arguments: [String],
        expected: CommandLineError,
        assertions: SelfTestAssertions
    ) throws {
        do {
            _ = try CommandLineOptions.parse(arguments: arguments)
            throw SelfTestFailure("command line unexpectedly succeeded")
        } catch let error as CommandLineError {
            try assertions.expect(error == expected, "command line rejection")
        }
    }

    private static func decode(_ frame: Data) throws -> (type: UInt8, payload: Data) {
        guard frame.count >= 5 else {
            throw SelfTestFailure("truncated frame")
        }
        let bytes = [UInt8](frame)
        let length = Int(bytes[1])
            | (Int(bytes[2]) << 8)
            | (Int(bytes[3]) << 16)
            | (Int(bytes[4]) << 24)
        guard length <= CaptureProtocol.maximumPayloadBytes,
              bytes.count == 5 + length
        else {
            throw SelfTestFailure("invalid frame length")
        }
        return (bytes[0], Data(bytes[5...]))
    }
}

private struct SelfTestFailure: Error, LocalizedError {
    let message: String

    init(_ message: String) {
        self.message = message
    }

    var errorDescription: String? { message }
}

private final class SelfTestAssertions {
    private(set) var count = 0

    func expect(
        _ condition: @autoclosure () throws -> Bool,
        _ description: String
    ) throws {
        guard try condition() else {
            throw SelfTestFailure("self-test assertion failed: \(description)")
        }
        count += 1
    }
}

private final class SelfTestChunkCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var chunks: [[Int16]] = []

    func append(_ chunk: [Int16]) {
        lock.lock()
        chunks.append(chunk)
        lock.unlock()
    }

    func snapshot() -> [[Int16]] {
        lock.lock()
        defer { lock.unlock() }
        return chunks
    }
}

private final class SelfTestFrameCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var frames: [Data] = []

    func append(_ frame: Data) {
        lock.lock()
        frames.append(frame)
        lock.unlock()
    }

    func snapshot() -> [Data] {
        lock.lock()
        defer { lock.unlock() }
        return frames
    }
}

private final class SelfTestErrorCollector: @unchecked Sendable {
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

private final class SelfTestStringCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String] = []

    func append(_ value: String) {
        lock.lock()
        values.append(value)
        lock.unlock()
    }

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return values.count
    }

    var first: String? {
        lock.lock()
        defer { lock.unlock() }
        return values.first
    }
}

private final class SelfTestBlockingSink: @unchecked Sendable {
    let started = DispatchSemaphore(value: 0)
    private let release = DispatchSemaphore(value: 0)

    func write(_ data: Data) {
        _ = data
        started.signal()
        release.wait()
    }

    func releaseAll() {
        release.signal()
        release.signal()
    }
}
