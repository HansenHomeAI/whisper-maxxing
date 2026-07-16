import Foundation

public enum SelfTest {
    public static func frames() throws -> [Data] {
        let samples = (0..<CaptureProtocol.samplesPerFrame).map { index in
            Int16((index % 200) + 1)
        }
        return [
            try CaptureProtocol.readyFrame(defaultInputDeviceName: "Self-Test Input"),
            try CaptureProtocol.pcmFrame(samples: samples),
            try CaptureProtocol.stoppedFrame(),
        ]
    }
}
