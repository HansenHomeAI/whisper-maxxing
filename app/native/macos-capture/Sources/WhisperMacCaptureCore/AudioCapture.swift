@preconcurrency import AVFoundation
import Foundation
import WhisperDictationCore

public enum AudioCaptureError: Error, LocalizedError {
    case invalidInputFormat
    case invalidInputBuffer
    case inputConversionBacklogExceeded
    case inputConfigurationChanged

    public var errorDescription: String? {
        switch self {
        case .invalidInputFormat:
            return "The default audio input has an invalid capture format."
        case .invalidInputBuffer:
            return "Core Audio returned an invalid input buffer."
        case .inputConversionBacklogExceeded:
            return "Core Audio input conversion could not keep up."
        case .inputConfigurationChanged:
            return "The default audio input configuration changed."
        }
    }
}

public final class AudioCaptureEngine: @unchecked Sendable {
    public typealias ErrorHandler = @Sendable (Error) -> Void

    private let preferredInputDevice: String?
    private let enforcePreferredInputDevice: Bool
    private let errorHandler: ErrorHandler
    private let backlogBudget: AudioBacklogBudget
    private let chunker: SampleChunker
    private let engine = AVAudioEngine()
    private let stateLock = NSLock()
    private var conversionWorker: PCMConversionWorker?
    private var configurationObserver: NSObjectProtocol?
    private var tapInstalled = false
    private var stopped = true
    private var reportedError = false

    public init(
        preferredInputDevice: String?,
        enforcePreferredInputDevice: Bool,
        backlogBudget: AudioBacklogBudget,
        sampleHandler: @escaping SampleChunker.ChunkHandler,
        errorHandler: @escaping ErrorHandler
    ) {
        self.preferredInputDevice = preferredInputDevice
        self.enforcePreferredInputDevice = enforcePreferredInputDevice
        self.backlogBudget = backlogBudget
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
        guard inputFormat.sampleRate.isFinite,
              inputFormat.sampleRate > 0,
              inputFormat.channelCount > 0,
              [.pcmFormatFloat32, .pcmFormatInt16, .pcmFormatInt32]
                .contains(inputFormat.commonFormat)
        else {
            throw AudioCaptureError.invalidInputFormat
        }
        let worker = try PCMConversionWorker(
            inputSampleRate: inputFormat.sampleRate,
            outputSampleRate: Double(CaptureProtocol.sampleRateHz),
            backlogBudget: backlogBudget,
            outputHandler: { [chunker] samples in
                chunker.append(samples)
            },
            errorHandler: { [weak self] error in
                self?.report(error)
            }
        )

        stateLock.lock()
        conversionWorker = worker
        stopped = false
        reportedError = false
        stateLock.unlock()

        inputNode.installTap(
            onBus: 0,
            bufferSize: 1_024,
            format: inputFormat
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
            self?.report(AudioCaptureError.inputConfigurationChanged)
        }
        return defaultInputDeviceName
    }

    public func stop() {
        stateLock.lock()
        let wasStopped = stopped
        stopped = true
        let worker = conversionWorker
        conversionWorker = nil
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
        worker?.stop()
    }

    private func handle(buffer: AVAudioPCMBuffer) {
        stateLock.lock()
        let worker = stopped ? nil : conversionWorker
        stateLock.unlock()
        guard let worker else { return }

        do {
            switch worker.enqueue(try nativeInput(from: buffer)) {
            case .accepted:
                return
            case .overflow:
                report(AudioCaptureError.inputConversionBacklogExceeded)
            case .stopped:
                return
            }
        } catch {
            report(error)
        }
    }

    private func nativeInput(
        from buffer: AVAudioPCMBuffer
    ) throws -> NativePCMInput {
        let frameCount = Int(buffer.frameLength)
        let channels = Int(buffer.format.channelCount)
        let nonInterleaved = !buffer.format.isInterleaved
        let bufferCount = nonInterleaved ? channels : 1
        let samplesPerBuffer = frameCount * (nonInterleaved ? 1 : channels)
        guard frameCount > 0, channels > 0 else {
            throw AudioCaptureError.invalidInputBuffer
        }

        let storage: NativePCMStorage
        switch buffer.format.commonFormat {
        case .pcmFormatFloat32:
            guard let pointers = buffer.floatChannelData else {
                throw AudioCaptureError.invalidInputBuffer
            }
            storage = .float32((0..<bufferCount).map { index in
                Array(UnsafeBufferPointer(
                    start: pointers[index],
                    count: samplesPerBuffer
                ))
            })
        case .pcmFormatInt16:
            guard let pointers = buffer.int16ChannelData else {
                throw AudioCaptureError.invalidInputBuffer
            }
            storage = .int16((0..<bufferCount).map { index in
                Array(UnsafeBufferPointer(
                    start: pointers[index],
                    count: samplesPerBuffer
                ))
            })
        case .pcmFormatInt32:
            guard let pointers = buffer.int32ChannelData else {
                throw AudioCaptureError.invalidInputBuffer
            }
            storage = .int32((0..<bufferCount).map { index in
                Array(UnsafeBufferPointer(
                    start: pointers[index],
                    count: samplesPerBuffer
                ))
            })
        default:
            throw AudioCaptureError.invalidInputFormat
        }
        return NativePCMInput(
            storage: storage,
            frameCount: frameCount,
            channels: channels,
            nonInterleaved: nonInterleaved
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
}
