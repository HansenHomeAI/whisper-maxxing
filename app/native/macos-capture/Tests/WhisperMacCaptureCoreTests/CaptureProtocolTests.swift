import Foundation
import Testing
@testable import WhisperMacCaptureCore

@Suite("Capture protocol")
struct CaptureProtocolTests {
    @Test("encodes the frozen ready payload and header")
    func readyFrame() throws {
        let frame = try CaptureProtocol.readyFrame(
            defaultInputDeviceName: "Test Microphone"
        )
        #expect(frame[0] == CaptureProtocol.MessageType.ready.rawValue)
        let payload = payload(from: frame)
        let ready = try JSONDecoder().decode(
            CaptureProtocol.ReadyPayload.self,
            from: payload
        )
        #expect(ready == CaptureProtocol.ReadyPayload(
            defaultInputDeviceName: "Test Microphone"
        ))
    }

    @Test("encodes signed PCM explicitly as little endian")
    func pcmIsLittleEndian() throws {
        var samples = Array(
            repeating: Int16(0),
            count: CaptureProtocol.samplesPerFrame
        )
        samples[0] = 1
        samples[1] = -2
        samples[2] = .max
        samples[3] = .min
        let frame = try CaptureProtocol.pcmFrame(samples: samples)
        #expect(frame[0] == CaptureProtocol.MessageType.pcm.rawValue)
        #expect(Array(payload(from: frame).prefix(8)) == [
            1, 0, 254, 255, 255, 127, 0, 128,
        ])
    }

    @Test("rejects frames that violate protocol limits")
    func rejectsInvalidFrames() {
        #expect(throws: CaptureProtocol.EncodingError.wrongSampleCount(1)) {
            try CaptureProtocol.pcmFrame(samples: [1])
        }
        #expect(throws: CaptureProtocol.EncodingError.payloadTooLarge(
            CaptureProtocol.maximumPayloadBytes + 1
        )) {
            try CaptureProtocol.frame(
                type: .error,
                payload: Data(
                    repeating: 0,
                    count: CaptureProtocol.maximumPayloadBytes + 1
                )
            )
        }
    }

    private func payload(from frame: Data) -> Data {
        let bytes = [UInt8](frame)
        #expect(bytes.count >= 5)
        let length = Int(bytes[1])
            | (Int(bytes[2]) << 8)
            | (Int(bytes[3]) << 16)
            | (Int(bytes[4]) << 24)
        #expect(bytes.count == 5 + length)
        return Data(bytes[5...])
    }
}
