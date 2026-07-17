import Foundation

public final class FrameWriter: @unchecked Sendable {
    public typealias Sink = @Sendable (Data) throws -> Void
    public typealias WriteFailureHandler = @Sendable (Error) -> Void

    public enum EnqueueResult: Equatable, Sendable {
        case accepted
        case closed
        case overflow
    }

    private enum State {
        case open
        case finishing
        case finished
    }

    private let maximumPendingPCMFrames: Int
    private let sink: Sink
    private let writeFailureHandler: WriteFailureHandler
    private let backlogBudget: AudioBacklogBudget?
    private let outputQueue = DispatchQueue(label: "whisper.mac.capture.output")
    private let lock = NSLock()
    private var state = State.open
    private var pendingPCMFrames = 0
    private var reportedWriteFailure = false

    public init(
        maximumPendingPCMFrames: Int = CaptureProtocol.maximumQueuedPCMFrames,
        backlogBudget: AudioBacklogBudget? = nil,
        sink: @escaping Sink,
        writeFailureHandler: @escaping WriteFailureHandler
    ) {
        precondition(maximumPendingPCMFrames > 0)
        self.maximumPendingPCMFrames = maximumPendingPCMFrames
        self.backlogBudget = backlogBudget
        self.sink = sink
        self.writeFailureHandler = writeFailureHandler
    }

    public func enqueueReady(defaultInputDeviceName: String) -> EnqueueResult {
        do {
            return enqueueControl(
                try CaptureProtocol.readyFrame(
                    defaultInputDeviceName: defaultInputDeviceName
                )
            )
        } catch {
            reportWriteFailure(error)
            return .closed
        }
    }

    public func enqueuePCM(samples: [Int16]) -> EnqueueResult {
        let frame: Data
        do {
            frame = try CaptureProtocol.pcmFrame(samples: samples)
        } catch {
            reportWriteFailure(error)
            return .closed
        }

        lock.lock()
        guard state == .open else {
            lock.unlock()
            return .closed
        }
        guard pendingPCMFrames < maximumPendingPCMFrames else {
            lock.unlock()
            return .overflow
        }
        pendingPCMFrames += 1
        outputQueue.async { [self] in
            defer {
                backlogBudget?.releaseOutputSamples(
                    CaptureProtocol.samplesPerFrame
                )
                lock.lock()
                pendingPCMFrames -= 1
                lock.unlock()
            }
            write(frame)
        }
        lock.unlock()
        return .accepted
    }

    public func finishStopped(completion: @escaping @Sendable () -> Void) {
        finish(
            makeFrame: CaptureProtocol.stoppedFrame,
            completion: completion
        )
    }

    public func finishError(
        message: String,
        completion: @escaping @Sendable () -> Void
    ) {
        finish(
            makeFrame: { try CaptureProtocol.errorFrame(message: message) },
            completion: completion
        )
    }

    private func enqueueControl(_ frame: Data) -> EnqueueResult {
        lock.lock()
        guard state == .open else {
            lock.unlock()
            return .closed
        }
        outputQueue.async { [self] in
            write(frame)
        }
        lock.unlock()
        return .accepted
    }

    private func finish(
        makeFrame: () throws -> Data,
        completion: @escaping @Sendable () -> Void
    ) {
        let frame: Data
        do {
            frame = try makeFrame()
        } catch {
            reportWriteFailure(error)
            return
        }

        lock.lock()
        guard state == .open else {
            lock.unlock()
            return
        }
        state = .finishing
        outputQueue.async { [self] in
            write(frame)
            lock.lock()
            state = .finished
            let failed = reportedWriteFailure
            lock.unlock()
            if !failed {
                completion()
            }
        }
        lock.unlock()
    }

    private func write(_ frame: Data) {
        lock.lock()
        let alreadyFailed = reportedWriteFailure
        lock.unlock()
        guard !alreadyFailed else { return }

        do {
            try sink(frame)
        } catch {
            reportWriteFailure(error)
        }
    }

    private func reportWriteFailure(_ error: Error) {
        lock.lock()
        guard !reportedWriteFailure else {
            lock.unlock()
            return
        }
        reportedWriteFailure = true
        state = .finished
        lock.unlock()
        writeFailureHandler(error)
    }
}
