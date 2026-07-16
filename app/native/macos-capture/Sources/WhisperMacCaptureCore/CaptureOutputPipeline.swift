import Foundation

public final class CaptureOutputPipeline: @unchecked Sendable {
    public typealias FailureHandler = @Sendable (String) -> Void

    private enum State {
        case waitingForReady
        case active
        case failed
        case stopped
    }

    private let writer: FrameWriter
    private let failureHandler: FailureHandler
    private let maximumBufferedChunks: Int
    private let lock = NSLock()
    private var state = State.waitingForReady
    private var bufferedChunks: [[Int16]] = []

    public init(
        writer: FrameWriter,
        maximumBufferedChunks: Int = CaptureProtocol.maximumQueuedPCMFrames,
        failureHandler: @escaping FailureHandler
    ) {
        precondition(maximumBufferedChunks > 0)
        self.writer = writer
        self.maximumBufferedChunks = maximumBufferedChunks
        self.failureHandler = failureHandler
    }

    public func receive(samples: [Int16]) {
        lock.lock()
        switch state {
        case .waitingForReady:
            if bufferedChunks.count < maximumBufferedChunks {
                bufferedChunks.append(samples)
                lock.unlock()
                return
            }
            state = .failed
            lock.unlock()
            failureHandler("Native capture pre-ready buffer overflowed.")
        case .active:
            lock.unlock()
            deliver(samples)
        case .failed, .stopped:
            lock.unlock()
        }
    }

    public func activate() {
        lock.lock()
        guard state == .waitingForReady else {
            lock.unlock()
            return
        }
        var failureMessage: String?
        for chunk in bufferedChunks {
            switch writer.enqueuePCM(samples: chunk) {
            case .accepted:
                continue
            case .overflow:
                failureMessage = "Native capture output queue overflowed."
            case .closed:
                failureMessage = "Native capture output closed unexpectedly."
            }
            break
        }
        bufferedChunks.removeAll(keepingCapacity: false)
        state = failureMessage == nil ? .active : .failed
        lock.unlock()

        if let failureMessage {
            failureHandler(failureMessage)
        }
    }

    public func stop() {
        lock.lock()
        state = .stopped
        bufferedChunks.removeAll(keepingCapacity: false)
        lock.unlock()
    }

    private func deliver(_ samples: [Int16]) {
        switch writer.enqueuePCM(samples: samples) {
        case .accepted:
            return
        case .overflow:
            fail("Native capture output queue overflowed.")
        case .closed:
            fail("Native capture output closed unexpectedly.")
        }
    }

    private func fail(_ message: String) {
        lock.lock()
        guard state != .failed && state != .stopped else {
            lock.unlock()
            return
        }
        state = .failed
        bufferedChunks.removeAll(keepingCapacity: false)
        lock.unlock()
        failureHandler(message)
    }
}
