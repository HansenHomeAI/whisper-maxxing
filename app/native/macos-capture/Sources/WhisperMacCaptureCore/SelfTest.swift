import Darwin
import Dispatch
import Foundation

public struct SelfTestResult: Sendable {
    public let frames: [Data]
    public let assertionCount: Int
    public let suites: [SelfTestSuiteResult]
}

public struct SelfTestSuiteResult: Sendable {
    public let name: String
    public let assertionCount: Int
}

public enum SelfTest {
    public static func run(
        onlySuiteNamed: String? = nil,
        includeFilesystemSocketTest: Bool = true
    ) throws -> SelfTestResult {
        let assertions = SelfTestAssertions()
        let samples = (0..<CaptureProtocol.samplesPerFrame).map { index in
            Int16((index % 200) + 1)
        }
        let frames = [
            try CaptureProtocol.readyFrame(defaultInputDeviceName: "Self-Test Input"),
            try CaptureProtocol.pcmFrame(samples: samples),
            try CaptureProtocol.stoppedFrame(),
        ]
        var suites: [SelfTestSuiteResult] = []

        func runSuite(
            _ name: String,
            _ body: () throws -> Void
        ) throws {
            guard onlySuiteNamed == nil || onlySuiteNamed == name else { return }
            let previousCount = assertions.count
            try body()
            let suiteAssertionCount = assertions.count - previousCount
            guard suiteAssertionCount > 0 else {
                throw SelfTestFailure("test suite executed zero assertions: \(name)")
            }
            suites.append(SelfTestSuiteResult(
                name: name,
                assertionCount: suiteAssertionCount
            ))
        }

        try runSuite("CaptureProtocol.readyFrame") {
            try verifyReadyFrame(frames[0], assertions: assertions)
        }
        try runSuite("CaptureProtocol.pcmIsLittleEndian") {
            try verifyPCMFrame(frames[1], assertions: assertions)
        }
        try runSuite("CaptureProtocol.rejectsInvalidFrames") {
            try verifyProtocolRejections(assertions: assertions)
        }
        try runSuite("SampleChunker.chunksFragmentedInput") {
            try verifySampleChunking(assertions: assertions)
        }
        try runSuite("PCMRateConverter.converts44100Hz") {
            try verifyRateConversion(
                inputSampleRate: 44_100,
                assertions: assertions
            )
        }
        try runSuite("PCMRateConverter.converts48000Hz") {
            try verifyRateConversion(
                inputSampleRate: 48_000,
                assertions: assertions
            )
        }
        try runSuite("PCMRateConverter.queueBoundAndStop") {
            try verifyConversionQueue(assertions: assertions)
        }
        try runSuite("PCMRateConverter.rejectsInvalidRate") {
            try verifyInvalidRate(assertions: assertions)
        }
        try runSuite("CommandLineOptions.captureArguments") {
            try verifyCaptureArguments(assertions: assertions)
        }
        try runSuite("CommandLineOptions.helperModes") {
            try verifyHelperModes(assertions: assertions)
        }
        try runSuite("CommandLineOptions.rejectsInvalidArguments") {
            try verifyCommandLineRejections(assertions: assertions)
        }
        try runSuite("FrameWriter.orderedFrames") {
            try verifyFrameWriterOrdering(samples: samples, assertions: assertions)
        }
        try runSuite("FrameWriter.queueIsBounded") {
            try verifyFrameWriterBound(samples: samples, assertions: assertions)
        }
        try runSuite("CaptureOutputPipeline.boundsPreReadyAudio") {
            try verifyPreReadyBound(samples: samples, assertions: assertions)
        }
        try runSuite("BoundedOutput.timesOut") {
            try verifyBoundedOutput(assertions: assertions)
        }
        try runSuite("LaunchdTransport.canonicalizesExecutablePath") {
            try verifyExecutablePath(assertions: assertions)
        }
        try runSuite("LaunchdTransport.retriesFreshDescriptors") {
            try verifyInjectedConnectionRetry(assertions: assertions)
            if includeFilesystemSocketTest {
                try verifySocketRetry(assertions: assertions)
            }
        }
        try runSuite("WorkerProtocol.forwardsCompleteFrames") {
            try verifyCompleteWorkerFrames(assertions: assertions)
        }
        try runSuite("WorkerProtocol.rejectsPartialEOF") {
            try verifyPartialWorkerEOF(assertions: assertions)
        }
        try runSuite("WorkerProtocol.rejectsTerminalTrailingBytes") {
            try verifyTerminalTrailingBytes(assertions: assertions)
        }
        try runSuite("LaunchdWorker.rejectsInvalidIdentity") {
            try verifyWorkerIdentity(assertions: assertions)
        }
        try runSuite("AudioBacklogBudget.boundsTwoSeconds") {
            try verifyAudioBacklogDuration(assertions: assertions)
        }
        try runSuite("AudioBacklogBudget.surfacesOverload") {
            try verifyAudioBacklogOverload(assertions: assertions)
        }

        let expectedSuiteCount = onlySuiteNamed == nil ? 23 : 1
        guard suites.count == expectedSuiteCount else {
            throw SelfTestFailure(
                "test inventory mismatch: expected \(expectedSuiteCount), executed \(suites.count)"
            )
        }

        return SelfTestResult(
            frames: frames,
            assertionCount: assertions.count,
            suites: suites
        )
    }

    private static func verifyReadyFrame(
        _ frame: Data,
        assertions: SelfTestAssertions
    ) throws {
        let decoded = try decode(frame)
        try assertions.expect(
            decoded.type == CaptureProtocol.MessageType.ready.rawValue,
            "ready frame type"
        )
        let ready = try JSONDecoder().decode(
            CaptureProtocol.ReadyPayload.self,
            from: decoded.payload
        )
        try assertions.expect(
            ready == CaptureProtocol.ReadyPayload(
                defaultInputDeviceName: "Self-Test Input"
            ),
            "frozen ready payload"
        )
    }

    private static func verifyPCMFrame(
        _ unusedFrame: Data,
        assertions: SelfTestAssertions
    ) throws {
        _ = unusedFrame
        var samples = [Int16](
            repeating: 0,
            count: CaptureProtocol.samplesPerFrame
        )
        samples[0] = 1
        samples[1] = -2
        samples[2] = .max
        samples[3] = .min
        let decoded = try decode(CaptureProtocol.pcmFrame(samples: samples))
        try assertions.expect(
            decoded.type == CaptureProtocol.MessageType.pcm.rawValue,
            "PCM frame type"
        )
        try assertions.expect(
            Array(decoded.payload.prefix(8)) == [
                1, 0, 254, 255, 255, 127, 0, 128,
            ],
            "signed PCM little-endian encoding"
        )
    }

    private static func verifyProtocolRejections(
        assertions: SelfTestAssertions
    ) throws {
        do {
            _ = try CaptureProtocol.pcmFrame(samples: [1])
            throw SelfTestFailure("invalid PCM sample count unexpectedly succeeded")
        } catch let error as CaptureProtocol.EncodingError {
            try assertions.expect(
                error == .wrongSampleCount(1),
                "wrong PCM sample count rejection"
            )
        }
        do {
            _ = try CaptureProtocol.frame(
                type: .error,
                payload: Data(
                    repeating: 0,
                    count: CaptureProtocol.maximumPayloadBytes + 1
                )
            )
            throw SelfTestFailure("oversized protocol payload unexpectedly succeeded")
        } catch let error as CaptureProtocol.EncodingError {
            try assertions.expect(
                error == .payloadTooLarge(
                    CaptureProtocol.maximumPayloadBytes + 1
                ),
                "oversized payload rejection"
            )
        }
    }

    private static func verifySampleChunking(
        assertions: SelfTestAssertions
    ) throws {
        let collector = SelfTestChunkCollector()
        let chunker = SampleChunker { collector.append($0) }
        chunker.append(Array(0..<100).map(Int16.init))
        chunker.append(Array(100..<319).map(Int16.init))
        try assertions.expect(collector.snapshot().isEmpty, "fragment retained")
        chunker.append(Array(319..<700).map(Int16.init))
        let chunks = collector.snapshot()
        try assertions.expect(chunks.count == 2, "sample chunk count")
        try assertions.expect(
            chunks[0] == Array(0..<320).map(Int16.init),
            "first sample chunk contents"
        )
        try assertions.expect(
            chunks[1] == Array(320..<640).map(Int16.init),
            "second sample chunk contents"
        )
        try assertions.expect(chunker.bufferedSampleCount == 60, "sample remainder")
    }

    private static func verifyRateConversion(
        inputSampleRate: Int,
        assertions: SelfTestAssertions
    ) throws {
        let converter = try PCMRateConverter(
            inputSampleRate: Double(inputSampleRate),
            outputSampleRate: Double(CaptureProtocol.sampleRateHz)
        )
        let input = (0..<inputSampleRate).map { index in
            Int16((index % 20_000) - 10_000)
        }
        var output: [Int16] = []
        for start in stride(from: 0, to: input.count, by: 511) {
            let end = min(start + 511, input.count)
            output.append(
                contentsOf: try converter.convert(Array(input[start..<end]))
            )
        }
        output.append(contentsOf: try converter.finish())
        try assertions.expect(
            output.count == CaptureProtocol.sampleRateHz,
            "\(inputSampleRate) Hz conversion ratio (received \(output.count))"
        )
        try assertions.expect(
            output.contains { $0 != 0 },
            "\(inputSampleRate) Hz conversion content"
        )

        let collector = SelfTestChunkCollector()
        let chunker = SampleChunker { collector.append($0) }
        chunker.append(output)
        try assertions.expect(
            collector.snapshot().flatMap { $0 }.count == CaptureProtocol.sampleRateHz,
            "\(inputSampleRate) Hz conversion chunk contents"
        )
        try assertions.expect(
            chunker.bufferedSampleCount == 0,
            "\(inputSampleRate) Hz conversion chunk remainder"
        )
    }

    private static func verifyInvalidRate(
        assertions: SelfTestAssertions
    ) throws {
        do {
            _ = try PCMRateConverter(inputSampleRate: 0, outputSampleRate: 16_000)
            throw SelfTestFailure("invalid input sample rate unexpectedly succeeded")
        } catch is PCMRateConverterError {
            try assertions.expect(true, "invalid input sample rate rejection")
        }
    }

    private static func verifyConversionQueue(
        assertions: SelfTestAssertions
    ) throws {
        let budget = AudioBacklogBudget(maximumPCMFrames: 1)
        let output = SelfTestChunkCollector()
        let errors = SelfTestErrorCollector()
        let worker = try PCMConversionWorker(
            inputSampleRate: 48_000,
            outputSampleRate: Double(CaptureProtocol.sampleRateHz),
            backlogBudget: budget,
            outputHandler: output.append,
            errorHandler: errors.append
        )
        let interleavedStereo = (0..<960).flatMap { _ in
            [Float(0.5), Float(0.25)]
        }
        let nativeInput = NativePCMInput(
            storage: .float32([interleavedStereo]),
            frameCount: 960,
            channels: 2,
            nonInterleaved: false
        )
        let accepted = worker.enqueue(nativeInput)
        try assertions.expect(accepted == .accepted, "conversion queue acceptance")
        let overflow = [Int16(1)].withUnsafeBufferPointer(worker.enqueue)
        try assertions.expect(overflow == .overflow, "conversion queue shared bound")
        worker.waitUntilIdle()
        let converted = output.snapshot().flatMap { $0 }
        try assertions.expect(converted.count == 320, "conversion queue output ratio")
        try assertions.expect(
            converted.filter { $0 != 0 }.count >= 300,
            "conversion queue input preservation"
        )
        try assertions.expect(worker.pendingBufferCount == 0, "conversion queue drained")
        try assertions.expect(errors.count == 0, "conversion queue errors")
        worker.stop()
        let stopped = [Int16(1)].withUnsafeBufferPointer(worker.enqueue)
        try assertions.expect(stopped == .stopped, "conversion queue stop")
    }

    private static func verifyCaptureArguments(
        assertions: SelfTestAssertions
    ) throws {
        let options = try CommandLineOptions.parse(arguments: [
            "--preferred-input-device",
            "Microphone $(touch /tmp/never-run)",
            "--enforce-preferred-input-device",
        ])
        try assertions.expect(
            options == CommandLineOptions(
                mode: .capture,
                preferredInputDevice: "Microphone $(touch /tmp/never-run)",
                enforcePreferredInputDevice: true
            ),
            "literal capture device arguments"
        )
    }

    private static func verifyHelperModes(
        assertions: SelfTestAssertions
    ) throws {
        try assertions.expect(
            try CommandLineOptions.parse(arguments: ["--self-test"]).mode
                == .selfTest,
            "self-test mode"
        )
        try assertions.expect(
            try CommandLineOptions.parse(arguments: ["--version"]).mode
                == .version,
            "version mode"
        )
    }

    private static func verifyCommandLineRejections(
        assertions: SelfTestAssertions
    ) throws {
        try expectCommandLineError(
            ["--wat"],
            expected: .unknownOption("--wat"),
            assertions: assertions
        )
        try expectCommandLineError(
            ["--preferred-input-device"],
            expected: .missingValue("--preferred-input-device"),
            assertions: assertions
        )
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
        try expectCommandLineError(
            ["--self-test", "--version"],
            expected: .conflictingModes,
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

    private static func verifyInjectedConnectionRetry(
        assertions: SelfTestAssertions
    ) throws {
        let state = SelfTestRetryState(
            descriptors: [10, 11, 12],
            connectErrors: [ECONNREFUSED, ENOENT, 0]
        )
        let connected = try retryUnixSocketConnection(
            timeoutMilliseconds: 10,
            operations: UnixSocketConnectionOperations(
                descriptorFactory: state.makeDescriptor,
                connectAttempt: state.connect,
                descriptorCloser: state.close,
                clock: state.clock,
                backoff: state.backoff
            )
        )
        let snapshot = state.snapshot()
        try assertions.expect(connected == 12, "retry returns successful descriptor")
        try assertions.expect(
            snapshot.attemptedDescriptors == [10, 11, 12],
            "retry uses a fresh descriptor for every attempt"
        )
        try assertions.expect(
            snapshot.closedDescriptors == [10, 11],
            "retry closes every failed descriptor"
        )
    }

    private static func verifyCompleteWorkerFrames(
        assertions: SelfTestAssertions
    ) throws {
        let ready = try CaptureProtocol.readyFrame(
            defaultInputDeviceName: "Stream Test"
        )
        let pcm = try CaptureProtocol.pcmFrame(
            samples: [Int16](
                repeating: 7,
                count: CaptureProtocol.samplesPerFrame
            )
        )
        let stopped = try CaptureProtocol.stoppedFrame()
        var decoder = WorkerProtocolStreamDecoder()

        try assertions.expect(
            try decoder.append(Data(ready.prefix(3))).isEmpty,
            "partial ready frame is withheld"
        )
        var secondChunk = Data(ready.dropFirst(3))
        secondChunk.append(Data(pcm.prefix(7)))
        try assertions.expect(
            try decoder.append(secondChunk) == [ready],
            "only the byte-complete ready frame is forwarded"
        )
        var finalChunk = Data(pcm.dropFirst(7))
        finalChunk.append(stopped)
        try assertions.expect(
            try decoder.append(finalChunk) == [pcm],
            "complete PCM is forwarded while the terminal is withheld"
        )
        let terminal = try decoder.finish()
        try assertions.expect(
            terminal.type == .stopped && terminal.frame == stopped,
            "worker terminal is released only after byte-complete EOF"
        )
    }

    private static func verifyPartialWorkerEOF(
        assertions: SelfTestAssertions
    ) throws {
        let ready = try CaptureProtocol.readyFrame(
            defaultInputDeviceName: "Partial EOF Test"
        )
        let pcm = try CaptureProtocol.pcmFrame(
            samples: [Int16](
                repeating: 1,
                count: CaptureProtocol.samplesPerFrame
            )
        )
        var decoder = WorkerProtocolStreamDecoder()
        var bytes = ready
        bytes.append(Data(pcm.prefix(13)))
        try assertions.expect(
            try decoder.append(bytes) == [ready],
            "partial PCM bytes never leave the decoder"
        )
        do {
            _ = try decoder.finish()
            throw SelfTestFailure("partial worker EOF unexpectedly succeeded")
        } catch let error as WorkerProtocolStreamError {
            try assertions.expect(
                error == .truncatedFrame(13),
                "partial worker EOF is rejected"
            )
        }

        var missingTerminal = WorkerProtocolStreamDecoder()
        _ = try missingTerminal.append(ready)
        do {
            _ = try missingTerminal.finish()
            throw SelfTestFailure("unterminated worker stream unexpectedly succeeded")
        } catch let error as WorkerProtocolStreamError {
            try assertions.expect(
                error == .missingTerminalFrame,
                "missing worker terminal is rejected"
            )
        }
    }

    private static func verifyTerminalTrailingBytes(
        assertions: SelfTestAssertions
    ) throws {
        let stopped = try CaptureProtocol.stoppedFrame()
        for trailingByteCount in 1...4 {
            var decoder = WorkerProtocolStreamDecoder()
            var input = stopped
            input.append(Data(
                repeating: 0xa5,
                count: trailingByteCount
            ))
            var externallyWritten: [Data] = []
            do {
                externallyWritten.append(contentsOf: try decoder.append(input))
                externallyWritten.append(try decoder.finish().frame)
            } catch {
                externallyWritten.append(try CaptureProtocol.errorFrame(
                    message: error.localizedDescription
                ))
            }

            let decoded = try externallyWritten.map(decode)
            try assertions.expect(
                externallyWritten.count == 1,
                "terminal plus \(trailingByteCount) trailing bytes emits one frame"
            )
            try assertions.expect(
                decoded.map(\.type) == [CaptureProtocol.MessageType.error.rawValue],
                "terminal plus \(trailingByteCount) trailing bytes emits one error terminal"
            )
            try assertions.expect(
                decoded.filter {
                    $0.type == CaptureProtocol.MessageType.error.rawValue
                        || $0.type == CaptureProtocol.MessageType.stopped.rawValue
                }.count == 1,
                "terminal plus \(trailingByteCount) trailing bytes never emits two terminals"
            )
        }
    }

    private static func verifyWorkerIdentity(
        assertions: SelfTestAssertions
    ) throws {
        let identity = try LaunchdWorkerIdentity(
            parentPID: 1,
            serviceName: "com.whispermaxxing.capture.4242.012345abcdef"
        )
        try assertions.expect(identity.supervisorPID == 4242, "supervisor PID extraction")
        try identity.validateSupervisorPeer(4242)
        try assertions.expect(true, "matching supervisor peer")

        do {
            _ = try LaunchdWorkerIdentity(
                parentPID: 99,
                serviceName: "com.whispermaxxing.capture.4242.012345abcdef"
            )
            throw SelfTestFailure("non-launchd parent unexpectedly accepted")
        } catch let error as LaunchdWorkerIdentityError {
            try assertions.expect(
                error == .notLaunchdOwned(99),
                "non-launchd parent rejection"
            )
        }
        do {
            _ = try LaunchdWorkerIdentity(
                parentPID: 1,
                serviceName: "com.whispermaxxing.capture.4242.012345ABCDEF"
            )
            throw SelfTestFailure("invalid service nonce unexpectedly accepted")
        } catch let error as LaunchdWorkerIdentityError {
            try assertions.expect(
                error == .invalidServiceName(
                    "com.whispermaxxing.capture.4242.012345ABCDEF"
                ),
                "invalid service label rejection"
            )
        }
        do {
            try identity.validateSupervisorPeer(4343)
            throw SelfTestFailure("mismatched supervisor peer unexpectedly accepted")
        } catch let error as LaunchdWorkerIdentityError {
            try assertions.expect(
                error == .unexpectedSupervisorPeer(4242, 4343),
                "mismatched supervisor peer rejection"
            )
        }
    }

    private static func verifyAudioBacklogDuration(
        assertions: SelfTestAssertions
    ) throws {
        let budget = AudioBacklogBudget()
        try assertions.expect(
            budget.reserveInputSamples(96_000, inputSampleRate: 48_000),
            "two seconds of 48 kHz input fits the shared budget"
        )
        try assertions.expect(
            budget.reservedOutputSampleEquivalent == 32_000,
            "two-second input maps to one hundred output frames"
        )
        try assertions.expect(
            !budget.reserveInputSamples(1, inputSampleRate: 48_000),
            "shared budget rejects audio beyond two seconds"
        )
        budget.releaseOutputSamples(320)
        try assertions.expect(
            budget.reserveInputSamples(960, inputSampleRate: 48_000),
            "written output releases exactly one frame of shared capacity"
        )
    }

    private static func verifyAudioBacklogOverload(
        assertions: SelfTestAssertions
    ) throws {
        let budget = AudioBacklogBudget(maximumPCMFrames: 1)
        try assertions.expect(
            budget.reserveInputSamples(320, inputSampleRate: 16_000),
            "one output frame fills the configured budget"
        )
        try assertions.expect(
            !budget.reserveInputSamples(1, inputSampleRate: 16_000),
            "full shared budget reports overload without blocking"
        )
        try assertions.expect(
            AudioCaptureError.inputConversionBacklogExceeded.errorDescription
                == "Core Audio input conversion could not keep up.",
            "AVAudioEngine tap overload has a visible capture failure"
        )
    }

    private static func verifySocketRetry(
        assertions: SelfTestAssertions
    ) throws {
        let suffix = UUID().uuidString.prefix(8)
        let directory = URL(
            fileURLWithPath: "/tmp/wmc-st-\(getpid())-\(suffix)"
        )
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700]
        )
        defer { try? FileManager.default.removeItem(at: directory) }
        let path = directory.appendingPathComponent("capture.sock").path
        let connection = SelfTestConnectionResult()
        let finished = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            connection.store(Result {
                try connectUnixSocket(path: path, timeoutMilliseconds: 2_000)
            })
            finished.signal()
        }
        usleep(150_000)

        let server = try UnixSocketServer(path: path)
        defer { server.close() }
        let accepted = try server.accept(
            expectedPeerPID: getpid(),
            timeoutMilliseconds: 2_000
        )
        defer { Darwin.close(accepted) }
        try assertions.expect(
            finished.wait(timeout: .now() + 2) == .success,
            "launchd transport connection completed"
        )
        guard let connectionResult = connection.take() else {
            throw SelfTestFailure("launchd transport returned no result")
        }
        let connected = try connectionResult.get()
        defer { Darwin.close(connected) }
        try assertions.expect(connected >= 0, "launchd transport descriptor")

    }

    private static func verifyExecutablePath(
        assertions: SelfTestAssertions
    ) throws {
        let resolver = ExecutablePathResolver {
            "/bin/../bin/launchctl"
        }
        try assertions.expect(
            try resolver.resolve() == "/bin/launchctl",
            "canonical executable path"
        )
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

private final class SelfTestConnectionResult: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Result<Int32, Error>?

    func store(_ result: Result<Int32, Error>) {
        lock.lock()
        value = result
        lock.unlock()
    }

    func take() -> Result<Int32, Error>? {
        lock.lock()
        defer { lock.unlock() }
        return value
    }
}

private final class SelfTestRetryState: @unchecked Sendable {
    struct Snapshot {
        let attemptedDescriptors: [Int32]
        let closedDescriptors: [Int32]
    }

    private let lock = NSLock()
    private var descriptors: [Int32]
    private var connectErrors: [Int32]
    private var attemptedDescriptors: [Int32] = []
    private var closedDescriptors: [Int32] = []
    private var now: UInt64 = 0

    init(descriptors: [Int32], connectErrors: [Int32]) {
        self.descriptors = descriptors
        self.connectErrors = connectErrors
    }

    func makeDescriptor() throws -> Int32 {
        lock.lock()
        defer { lock.unlock() }
        guard !descriptors.isEmpty else {
            throw SelfTestFailure("retry requested too many descriptors")
        }
        return descriptors.removeFirst()
    }

    func connect(_ descriptor: Int32) throws -> Int32 {
        lock.lock()
        defer { lock.unlock() }
        attemptedDescriptors.append(descriptor)
        guard !connectErrors.isEmpty else {
            throw SelfTestFailure("retry requested too many connect attempts")
        }
        return connectErrors.removeFirst()
    }

    func close(_ descriptor: Int32) {
        lock.lock()
        closedDescriptors.append(descriptor)
        lock.unlock()
    }

    func clock() -> UInt64 {
        lock.lock()
        defer { lock.unlock() }
        return now
    }

    func backoff() {
        lock.lock()
        now += 1_000_000
        lock.unlock()
    }

    func snapshot() -> Snapshot {
        lock.lock()
        defer { lock.unlock() }
        return Snapshot(
            attemptedDescriptors: attemptedDescriptors,
            closedDescriptors: closedDescriptors
        )
    }
}
