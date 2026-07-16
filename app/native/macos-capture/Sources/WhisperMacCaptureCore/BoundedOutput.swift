import Darwin
import Dispatch
import Foundation

public enum BoundedOutputError: Error, LocalizedError, Equatable {
    case unableToReadFlags(Int32)
    case unableToSetNonblocking(Int32)
    case timedOut
    case closed
    case writeFailed(Int32)

    public var errorDescription: String? {
        switch self {
        case .unableToReadFlags(let code):
            return "unable to read stdout flags (errno \(code))."
        case .unableToSetNonblocking(let code):
            return "unable to make stdout nonblocking (errno \(code))."
        case .timedOut:
            return "stdout write timed out."
        case .closed:
            return "stdout closed while writing."
        case .writeFailed(let code):
            return "stdout write failed (errno \(code))."
        }
    }
}

public final class BoundedOutput: @unchecked Sendable {
    private let fileDescriptor: Int32
    private let writeTimeoutNanoseconds: UInt64

    public init(
        fileDescriptor: Int32 = STDOUT_FILENO,
        writeTimeoutMilliseconds: Int = 250
    ) throws {
        precondition(writeTimeoutMilliseconds > 0)
        let flags = fcntl(fileDescriptor, F_GETFL)
        guard flags >= 0 else {
            throw BoundedOutputError.unableToReadFlags(errno)
        }
        guard fcntl(fileDescriptor, F_SETFL, flags | O_NONBLOCK) >= 0 else {
            throw BoundedOutputError.unableToSetNonblocking(errno)
        }
        self.fileDescriptor = fileDescriptor
        writeTimeoutNanoseconds = UInt64(writeTimeoutMilliseconds) * 1_000_000
    }

    public func write(_ data: Data) throws {
        let deadline = DispatchTime.now().uptimeNanoseconds + writeTimeoutNanoseconds
        try data.withUnsafeBytes { bytes in
            guard let baseAddress = bytes.baseAddress else { return }
            var offset = 0
            while offset < bytes.count {
                let written = Darwin.write(
                    fileDescriptor,
                    baseAddress.advanced(by: offset),
                    bytes.count - offset
                )
                if written > 0 {
                    offset += written
                    continue
                }
                if written == 0 {
                    throw BoundedOutputError.closed
                }

                let code = errno
                if code == EINTR {
                    continue
                }
                if code == EPIPE {
                    throw BoundedOutputError.closed
                }
                if code == EAGAIN || code == EWOULDBLOCK {
                    try waitUntilWritable(deadline: deadline)
                    continue
                }
                throw BoundedOutputError.writeFailed(code)
            }
        }
    }

    private func waitUntilWritable(deadline: UInt64) throws {
        var descriptor = pollfd(
            fd: fileDescriptor,
            events: Int16(POLLOUT),
            revents: 0
        )

        while true {
            let now = DispatchTime.now().uptimeNanoseconds
            guard now < deadline else {
                throw BoundedOutputError.timedOut
            }
            let remainingNanoseconds = deadline - now
            let timeoutMilliseconds = max(
                1,
                min(
                    Int32.max,
                    Int32((remainingNanoseconds + 999_999) / 1_000_000)
                )
            )
            descriptor.revents = 0
            let result = poll(&descriptor, 1, timeoutMilliseconds)
            if result > 0 {
                if descriptor.revents & Int16(POLLNVAL) != 0
                    || descriptor.revents & Int16(POLLERR) != 0
                    || descriptor.revents & Int16(POLLHUP) != 0
                {
                    throw BoundedOutputError.closed
                }
                return
            }
            if result == 0 {
                throw BoundedOutputError.timedOut
            }
            if errno != EINTR {
                throw BoundedOutputError.writeFailed(errno)
            }
        }
    }
}
