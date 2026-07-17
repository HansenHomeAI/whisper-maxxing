import Foundation

public enum WorkerProtocolStreamError: Error, LocalizedError, Equatable {
    case unknownType(UInt8)
    case oversizedPayload(Int)
    case invalidFrame(String)
    case truncatedFrame(Int)
    case missingTerminalFrame
    case frameAfterTerminal

    public var errorDescription: String? {
        switch self {
        case .unknownType(let type):
            return "The native capture worker returned unknown frame type \(type)."
        case .oversizedPayload(let length):
            return "The native capture worker returned an oversized \(length)-byte frame."
        case .invalidFrame(let reason):
            return "The native capture worker returned an invalid frame: \(reason)."
        case .truncatedFrame(let byteCount):
            return "The native capture worker stopped with \(byteCount) partial frame bytes."
        case .missingTerminalFrame:
            return "The native capture worker stopped without a terminal frame."
        case .frameAfterTerminal:
            return "The native capture worker returned data after its terminal frame."
        }
    }
}

public struct WorkerProtocolTerminal: Equatable, Sendable {
    public let type: CaptureProtocol.MessageType
    public let frame: Data
}

public struct WorkerProtocolStreamDecoder: Sendable {
    private var storage = Data()
    private var readySeen = false
    private var terminalFrame: Data?
    public private(set) var terminalType: CaptureProtocol.MessageType?

    public init() {}

    public mutating func append(_ data: Data) throws -> [Data] {
        guard terminalType == nil || data.isEmpty else {
            throw WorkerProtocolStreamError.frameAfterTerminal
        }
        storage.append(data)
        var frames: [Data] = []
        var readIndex = 0
        while storage.count - readIndex >= 5 {
            let rawType = storage[readIndex]
            let length = Int(storage[readIndex + 1])
                | (Int(storage[readIndex + 2]) << 8)
                | (Int(storage[readIndex + 3]) << 16)
                | (Int(storage[readIndex + 4]) << 24)
            guard length <= CaptureProtocol.maximumPayloadBytes else {
                throw WorkerProtocolStreamError.oversizedPayload(length)
            }
            let frameLength = 5 + length
            guard storage.count - readIndex >= frameLength else { break }
            guard let type = CaptureProtocol.MessageType(rawValue: rawType) else {
                throw WorkerProtocolStreamError.unknownType(rawType)
            }
            let payloadStart = readIndex + 5
            let payload = storage.subdata(
                in: payloadStart..<(payloadStart + length)
            )
            let frame = storage.subdata(
                in: readIndex..<(readIndex + frameLength)
            )
            try validate(type: type, payload: payload)
            if type == .error || type == .stopped {
                terminalFrame = frame
            } else {
                frames.append(frame)
            }
            readIndex += frameLength
        }
        if readIndex > 0 {
            storage = Data(storage.dropFirst(readIndex))
        }
        guard terminalType == nil || storage.isEmpty else {
            throw WorkerProtocolStreamError.frameAfterTerminal
        }
        return frames
    }

    public mutating func finish() throws -> WorkerProtocolTerminal {
        guard storage.isEmpty else {
            throw WorkerProtocolStreamError.truncatedFrame(storage.count)
        }
        guard let terminalType, let terminalFrame else {
            throw WorkerProtocolStreamError.missingTerminalFrame
        }
        return WorkerProtocolTerminal(type: terminalType, frame: terminalFrame)
    }

    private mutating func validate(
        type: CaptureProtocol.MessageType,
        payload: Data
    ) throws {
        guard terminalType == nil else {
            throw WorkerProtocolStreamError.frameAfterTerminal
        }
        switch type {
        case .ready:
            guard !readySeen,
                  let value = try? JSONDecoder().decode(
                      CaptureProtocol.ReadyPayload.self,
                      from: payload
                  ),
                  value.protocolVersion == CaptureProtocol.version,
                  value.sampleRateHz == CaptureProtocol.sampleRateHz,
                  value.channels == CaptureProtocol.channels,
                  value.sampleFormat == CaptureProtocol.sampleFormat
            else {
                throw WorkerProtocolStreamError.invalidFrame("ready payload")
            }
            readySeen = true
        case .pcm:
            guard readySeen,
                  payload.count == CaptureProtocol.samplesPerFrame
                    * MemoryLayout<Int16>.size
            else {
                throw WorkerProtocolStreamError.invalidFrame("PCM payload")
            }
        case .error:
            guard let value = try? JSONDecoder().decode(
                CaptureProtocol.ErrorPayload.self,
                from: payload
            ), !value.message.isEmpty else {
                throw WorkerProtocolStreamError.invalidFrame("error payload")
            }
            terminalType = .error
        case .stopped:
            guard payload.isEmpty else {
                throw WorkerProtocolStreamError.invalidFrame("stopped payload")
            }
            terminalType = .stopped
        }
    }
}
