import Foundation

public enum CaptureProtocol {
    public static let version = 1
    public static let sampleRateHz = 16_000
    public static let channels = 1
    public static let sampleFormat = "s16le"
    public static let samplesPerFrame = 320
    public static let maximumPayloadBytes = 262_144
    public static let maximumQueuedPCMFrames = 100

    public enum MessageType: UInt8, Sendable {
        case ready = 1
        case pcm = 2
        case error = 3
        case stopped = 4
    }

    public struct ReadyPayload: Codable, Equatable, Sendable {
        public let protocolVersion: Int
        public let sampleRateHz: Int
        public let channels: Int
        public let sampleFormat: String
        public let defaultInputDeviceName: String

        public init(defaultInputDeviceName: String) {
            protocolVersion = CaptureProtocol.version
            sampleRateHz = CaptureProtocol.sampleRateHz
            channels = CaptureProtocol.channels
            sampleFormat = CaptureProtocol.sampleFormat
            self.defaultInputDeviceName = defaultInputDeviceName
        }
    }

    public struct ErrorPayload: Codable, Equatable, Sendable {
        public let message: String

        public init(message: String) {
            self.message = message
        }
    }

    public enum EncodingError: Error, LocalizedError, Equatable {
        case payloadTooLarge(Int)
        case wrongSampleCount(Int)

        public var errorDescription: String? {
            switch self {
            case .payloadTooLarge(let count):
                return "Capture protocol payload is too large: \(count) bytes."
            case .wrongSampleCount(let count):
                return "PCM frame must contain exactly \(samplesPerFrame) samples, received \(count)."
            }
        }
    }

    public static func readyFrame(defaultInputDeviceName: String) throws -> Data {
        try jsonFrame(
            type: .ready,
            value: ReadyPayload(defaultInputDeviceName: defaultInputDeviceName)
        )
    }

    public static func errorFrame(message: String) throws -> Data {
        try jsonFrame(type: .error, value: ErrorPayload(message: message))
    }

    public static func pcmFrame(samples: [Int16]) throws -> Data {
        guard samples.count == samplesPerFrame else {
            throw EncodingError.wrongSampleCount(samples.count)
        }

        var payload = Data(capacity: samples.count * MemoryLayout<Int16>.size)
        for sample in samples {
            let bits = UInt16(bitPattern: sample)
            payload.append(UInt8(truncatingIfNeeded: bits))
            payload.append(UInt8(truncatingIfNeeded: bits >> 8))
        }
        return try frame(type: .pcm, payload: payload)
    }

    public static func stoppedFrame() throws -> Data {
        try frame(type: .stopped, payload: Data())
    }

    public static func frame(type: MessageType, payload: Data) throws -> Data {
        guard payload.count <= maximumPayloadBytes else {
            throw EncodingError.payloadTooLarge(payload.count)
        }

        var encoded = Data(capacity: 5 + payload.count)
        encoded.append(type.rawValue)
        let length = UInt32(payload.count)
        encoded.append(UInt8(truncatingIfNeeded: length))
        encoded.append(UInt8(truncatingIfNeeded: length >> 8))
        encoded.append(UInt8(truncatingIfNeeded: length >> 16))
        encoded.append(UInt8(truncatingIfNeeded: length >> 24))
        encoded.append(payload)
        return encoded
    }

    private static func jsonFrame<Value: Encodable>(
        type: MessageType,
        value: Value
    ) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try frame(type: type, payload: encoder.encode(value))
    }
}
