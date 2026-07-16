@preconcurrency import AVFoundation
import Foundation
import WhisperDictationCore

public enum AudioCaptureError: Error, LocalizedError {
    case invalidInputFormat
    case converterInitializationFailed
    case conversionFailed(String)
    case missingConvertedSamples

    public var errorDescription: String? {
        switch self {
        case .invalidInputFormat:
            return "The default audio input has an invalid capture format."
        case .converterInitializationFailed:
            return "Unable to initialize the 16 kHz mono audio converter."
        case .conversionFailed(let detail):
            return "Audio conversion failed: \(detail)"
        case .missingConvertedSamples:
            return "Audio conversion produced an unreadable PCM buffer."
        }
    }
}

private final class ConverterFeedState: @unchecked Sendable {
    var suppliedInput = false
}

public final class AudioCaptureEngine: @unchecked Sendable {
    public typealias ErrorHandler = @Sendable (Error) -> Void

    private let preferredInputDevice: String?
    private let enforcePreferredInputDevice: Bool
    private let errorHandler: ErrorHandler
    private let chunker: SampleChunker
    private let engine = AVAudioEngine()
    private let callbackLock = NSLock()
    private let stateLock = NSLock()
    private let outputFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: Double(CaptureProtocol.sampleRateHz),
        channels: AVAudioChannelCount(CaptureProtocol.channels),
        interleaved: true
    )!
    private var converter: AVAudioConverter?
    private var converterInputFormat: AVAudioFormat?
    private var configurationObserver: NSObjectProtocol?
    private var tapInstalled = false
    private var stopped = true
    private var reportedError = false

    public init(
        preferredInputDevice: String?,
        enforcePreferredInputDevice: Bool,
        sampleHandler: @escaping SampleChunker.ChunkHandler,
        errorHandler: @escaping ErrorHandler
    ) {
        self.preferredInputDevice = preferredInputDevice
        self.enforcePreferredInputDevice = enforcePreferredInputDevice
        self.errorHandler = errorHandler
        chunker = SampleChunker(chunkHandler: sampleHandler)
    }

    public func start() throws -> String {
        let defaultInputDeviceName = try CoreAudioDevice.ensurePreferredInputDevice(
            named: preferredInputDevice,
            enforceAsDefault: enforcePreferredInputDevice
        )
        let inputNode = engine.inputNode
        let inputFormat = inputNode.inputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
            throw AudioCaptureError.invalidInputFormat
        }
        guard let converter = AVAudioConverter(
            from: inputFormat,
            to: outputFormat
        ) else {
            throw AudioCaptureError.converterInitializationFailed
        }
        self.converter = converter
        converterInputFormat = inputFormat

        stateLock.lock()
        stopped = false
        reportedError = false
        stateLock.unlock()

        inputNode.installTap(
            onBus: 0,
            bufferSize: 1_024,
            format: nil
        ) { [weak self] buffer, _ in
            self?.handle(buffer: buffer)
        }
        tapInstalled = true

        do {
            engine.prepare()
            try engine.start()
        } catch {
            stop()
            throw error
        }

        configurationObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: engine,
            queue: nil
        ) { [weak self] _ in
            self?.report(
                AudioCaptureError.conversionFailed(
                    "the audio input configuration changed."
                )
            )
        }

        return defaultInputDeviceName
    }

    public func stop() {
        stateLock.lock()
        let wasStopped = stopped
        stopped = true
        stateLock.unlock()
        guard !wasStopped else { return }

        if let configurationObserver {
            NotificationCenter.default.removeObserver(configurationObserver)
            self.configurationObserver = nil
        }
        if tapInstalled {
            engine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        if engine.isRunning {
            engine.stop()
        }
        engine.reset()

        callbackLock.lock()
        converter = nil
        converterInputFormat = nil
        callbackLock.unlock()
    }

    private func handle(buffer: AVAudioPCMBuffer) {
        callbackLock.lock()
        defer { callbackLock.unlock() }

        stateLock.lock()
        let isStopped = stopped
        stateLock.unlock()
        guard !isStopped else { return }

        guard
            let converter,
            let converterInputFormat,
            formatsMatch(converterInputFormat, buffer.format)
        else {
            report(AudioCaptureError.converterInitializationFailed)
            return
        }

        let ratio = outputFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * ratio)) + 32
        guard let converted = AVAudioPCMBuffer(
            pcmFormat: outputFormat,
            frameCapacity: capacity
        ) else {
            report(AudioCaptureError.converterInitializationFailed)
            return
        }

        let feedState = ConverterFeedState()
        var conversionError: NSError?
        let status = converter.convert(
            to: converted,
            error: &conversionError
        ) { _, inputStatus in
            if feedState.suppliedInput {
                inputStatus.pointee = .noDataNow
                return nil
            }
            feedState.suppliedInput = true
            inputStatus.pointee = .haveData
            return buffer
        }

        if let conversionError {
            report(AudioCaptureError.conversionFailed(conversionError.localizedDescription))
            return
        }
        if status == .error {
            report(AudioCaptureError.conversionFailed("AVAudioConverter returned an error."))
            return
        }
        guard converted.frameLength > 0 else { return }
        guard let samples = converted.int16ChannelData?.pointee else {
            report(AudioCaptureError.missingConvertedSamples)
            return
        }

        chunker.append(
            UnsafeBufferPointer(
                start: samples,
                count: Int(converted.frameLength)
            )
        )
    }

    private func report(_ error: Error) {
        stateLock.lock()
        guard !stopped, !reportedError else {
            stateLock.unlock()
            return
        }
        reportedError = true
        stateLock.unlock()
        errorHandler(error)
    }

    private func formatsMatch(_ lhs: AVAudioFormat, _ rhs: AVAudioFormat) -> Bool {
        lhs.sampleRate == rhs.sampleRate
            && lhs.channelCount == rhs.channelCount
            && lhs.commonFormat == rhs.commonFormat
            && lhs.isInterleaved == rhs.isInterleaved
    }
}
