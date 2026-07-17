import CoreAudio
import Foundation
import WhisperDictationCore

public enum AudioCaptureError: Error, LocalizedError {
    case deviceFailure(String, OSStatus)
    case inputBufferTooLarge(UInt32)
    case invalidInputBuffer
    case unsupportedInputFormat(String)
    case inputConversionBacklogExceeded
    case inputConfigurationChanged
    case unableToReadDefaultInput(OSStatus)

    public var errorDescription: String? {
        switch self {
        case .deviceFailure(let operation, let status):
            return "\(operation) failed (OSStatus \(status))."
        case .inputBufferTooLarge(let frameCount):
            return "Core Audio requested an oversized input buffer of \(frameCount) frames."
        case .invalidInputBuffer:
            return "Core Audio returned an invalid input buffer."
        case .unsupportedInputFormat(let description):
            return "The Core Audio input format is unsupported: \(description)."
        case .inputConversionBacklogExceeded:
            return "Core Audio input conversion could not keep up."
        case .inputConfigurationChanged:
            return "The default audio input configuration changed."
        case .unableToReadDefaultInput(let status):
            return "Unable to read the default Core Audio input device (OSStatus \(status))."
        }
    }
}

private let maximumDirectInputFrames = UInt32(4_096)

private func directInputIOProc(
    _ deviceID: AudioObjectID,
    _ currentTime: UnsafePointer<AudioTimeStamp>,
    _ inputData: UnsafePointer<AudioBufferList>,
    _ inputTime: UnsafePointer<AudioTimeStamp>,
    _ outputData: UnsafeMutablePointer<AudioBufferList>,
    _ outputTime: UnsafePointer<AudioTimeStamp>,
    _ clientData: UnsafeMutableRawPointer?
) -> OSStatus {
    _ = deviceID
    _ = currentTime
    _ = inputTime
    _ = outputData
    _ = outputTime
    guard let clientData else { return kAudio_ParamError }
    return Unmanaged<AudioCaptureEngine>
        .fromOpaque(clientData)
        .takeUnretainedValue()
        .capture(inputData: inputData)
}

private func directDefaultInputDeviceListener(
    _ objectID: AudioObjectID,
    _ addressCount: UInt32,
    _ addresses: UnsafePointer<AudioObjectPropertyAddress>,
    _ clientData: UnsafeMutableRawPointer?
) -> OSStatus {
    _ = objectID
    _ = addressCount
    _ = addresses
    guard let clientData else { return kAudio_ParamError }
    Unmanaged<AudioCaptureEngine>
        .fromOpaque(clientData)
        .takeUnretainedValue()
        .defaultInputDeviceChanged()
    return noErr
}

public final class AudioCaptureEngine: @unchecked Sendable {
    public typealias ErrorHandler = @Sendable (Error) -> Void

    private let preferredInputDevice: String?
    private let enforcePreferredInputDevice: Bool
    private let errorHandler: ErrorHandler
    private let backlogBudget: AudioBacklogBudget
    private let chunker: SampleChunker
    private let callbackLock = NSLock()
    private let stateLock = NSLock()
    private var deviceID = AudioDeviceID(kAudioObjectUnknown)
    private var ioProcID: AudioDeviceIOProcID?
    private var inputFormat = AudioStreamBasicDescription()
    private var conversionWorker: PCMConversionWorker?
    private var listenerInstalled = false
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
        let selectedDeviceID = try currentDefaultInputDeviceID()
        let selectedFormat = try readInputFormat(deviceID: selectedDeviceID)
        try validateInputFormat(selectedFormat)
        deviceID = selectedDeviceID
        inputFormat = selectedFormat
        stateLock.lock()
        stopped = false
        reportedError = false
        stateLock.unlock()

        do {
            conversionWorker = try PCMConversionWorker(
                inputSampleRate: selectedFormat.mSampleRate,
                outputSampleRate: Double(CaptureProtocol.sampleRateHz),
                backlogBudget: backlogBudget,
                outputHandler: { [chunker] samples in
                    chunker.append(samples)
                },
                errorHandler: { [weak self] error in
                    self?.report(error)
                }
            )
            var newIOProcID: AudioDeviceIOProcID?
            try check(
                AudioDeviceCreateIOProcID(
                    selectedDeviceID,
                    directInputIOProc,
                    Unmanaged.passUnretained(self).toOpaque(),
                    &newIOProcID
                ),
                operation: "Creating the Core Audio device input callback"
            )
            guard let newIOProcID else {
                throw AudioCaptureError.deviceFailure(
                    "Creating the Core Audio device input callback",
                    kAudio_ParamError
                )
            }
            ioProcID = newIOProcID
            try installDefaultInputListener()
            try check(
                AudioDeviceStart(selectedDeviceID, newIOProcID),
                operation: "Starting Core Audio device input"
            )
        } catch {
            stop()
            throw error
        }

        return defaultInputDeviceName
    }

    public func stop() {
        stateLock.lock()
        let wasStopped = stopped
        stopped = true
        stateLock.unlock()
        guard !wasStopped else { return }

        removeDefaultInputListener()
        if let ioProcID {
            _ = AudioDeviceStop(deviceID, ioProcID)
        }

        callbackLock.lock()
        if let ioProcID {
            _ = AudioDeviceDestroyIOProcID(deviceID, ioProcID)
            self.ioProcID = nil
        }
        let worker = conversionWorker
        conversionWorker = nil
        worker?.stop()
        deviceID = AudioDeviceID(kAudioObjectUnknown)
        inputFormat = AudioStreamBasicDescription()
        callbackLock.unlock()
    }

    fileprivate func capture(
        inputData: UnsafePointer<AudioBufferList>
    ) -> OSStatus {
        callbackLock.lock()
        defer { callbackLock.unlock() }

        stateLock.lock()
        let isStopped = stopped
        stateLock.unlock()
        guard !isStopped, let conversionWorker else {
            return noErr
        }

        do {
            let input = try copyNativeInput(inputData)
            guard input.frameCount > 0 else { return noErr }
            let result = conversionWorker.enqueue(input)
            switch result {
            case .accepted:
                return noErr
            case .overflow:
                report(AudioCaptureError.inputConversionBacklogExceeded)
                return kAudio_ParamError
            case .stopped:
                return noErr
            }
        } catch {
            report(error)
            return kAudio_ParamError
        }
    }

    fileprivate func defaultInputDeviceChanged() {
        report(AudioCaptureError.inputConfigurationChanged)
    }

    private func copyNativeInput(
        _ inputData: UnsafePointer<AudioBufferList>
    ) throws -> NativePCMInput {
        let buffers = UnsafeMutableAudioBufferListPointer(
            UnsafeMutablePointer(mutating: inputData)
        )
        guard let firstBuffer = buffers.first,
              firstBuffer.mData != nil,
              inputFormat.mBytesPerFrame > 0
        else {
            throw AudioCaptureError.invalidInputBuffer
        }
        let frameCount = firstBuffer.mDataByteSize / inputFormat.mBytesPerFrame
        guard frameCount <= maximumDirectInputFrames else {
            throw AudioCaptureError.inputBufferTooLarge(frameCount)
        }

        let nonInterleaved = inputFormat.mFormatFlags
            & kAudioFormatFlagIsNonInterleaved != 0
        let channels = Int(inputFormat.mChannelsPerFrame)
        guard channels > 0 else {
            throw AudioCaptureError.invalidInputBuffer
        }

        let copiedBuffers: NativePCMStorage
        if inputFormat.mFormatFlags & kAudioFormatFlagIsFloat != 0 {
            copiedBuffers = .float32(
                try copyBuffers(
                    Float.self,
                    buffers: buffers,
                    frameCount: Int(frameCount),
                    channels: channels,
                    nonInterleaved: nonInterleaved
                )
            )
        } else if inputFormat.mBitsPerChannel == 16 {
            copiedBuffers = .int16(
                try copyBuffers(
                    Int16.self,
                    buffers: buffers,
                    frameCount: Int(frameCount),
                    channels: channels,
                    nonInterleaved: nonInterleaved
                )
            )
        } else if inputFormat.mBitsPerChannel == 32 {
            copiedBuffers = .int32(
                try copyBuffers(
                    Int32.self,
                    buffers: buffers,
                    frameCount: Int(frameCount),
                    channels: channels,
                    nonInterleaved: nonInterleaved
                )
            )
        } else {
            throw AudioCaptureError.unsupportedInputFormat(formatDescription(inputFormat))
        }
        return NativePCMInput(
            storage: copiedBuffers,
            frameCount: Int(frameCount),
            channels: channels,
            nonInterleaved: nonInterleaved
        )
    }

    private func copyBuffers<Value>(
        _ type: Value.Type,
        buffers: UnsafeMutableAudioBufferListPointer,
        frameCount: Int,
        channels: Int,
        nonInterleaved: Bool
    ) throws -> [[Value]] {
        _ = type
        let bufferCount = nonInterleaved ? channels : 1
        let samplesPerBuffer = frameCount * (nonInterleaved ? 1 : channels)
        let requiredBytes = samplesPerBuffer * MemoryLayout<Value>.size
        guard buffers.count >= bufferCount else {
            throw AudioCaptureError.invalidInputBuffer
        }
        return try (0..<bufferCount).map { index in
            let buffer = buffers[index]
            guard Int(buffer.mDataByteSize) >= requiredBytes,
                  let data = buffer.mData
            else {
                throw AudioCaptureError.invalidInputBuffer
            }
            return Array(
                UnsafeBufferPointer(
                    start: data.assumingMemoryBound(to: Value.self),
                    count: samplesPerBuffer
                )
            )
        }
    }

    private func currentDefaultInputDeviceID() throws -> AudioDeviceID {
        var currentDeviceID = AudioDeviceID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var address = defaultInputDeviceAddress()
        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            0,
            nil,
            &size,
            &currentDeviceID
        )
        guard status == noErr, currentDeviceID != kAudioObjectUnknown else {
            throw AudioCaptureError.unableToReadDefaultInput(status)
        }
        return currentDeviceID
    }

    private func readInputFormat(
        deviceID: AudioDeviceID
    ) throws -> AudioStreamBasicDescription {
        var format = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamFormat,
            mScope: kAudioDevicePropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain
        )
        try check(
            AudioObjectGetPropertyData(
                deviceID,
                &address,
                0,
                nil,
                &size,
                &format
            ),
            operation: "Reading the Core Audio device input format"
        )
        return format
    }

    private func validateInputFormat(
        _ format: AudioStreamBasicDescription
    ) throws {
        let isFloat32 = format.mFormatFlags & kAudioFormatFlagIsFloat != 0
            && format.mBitsPerChannel == 32
        let isSignedInteger = format.mFormatFlags
            & kAudioFormatFlagIsSignedInteger != 0
            && [16, 32].contains(format.mBitsPerChannel)
        guard format.mFormatID == kAudioFormatLinearPCM,
              format.mSampleRate.isFinite,
              format.mSampleRate > 0,
              format.mChannelsPerFrame > 0,
              format.mBytesPerFrame > 0,
              isFloat32 || isSignedInteger
        else {
            throw AudioCaptureError.unsupportedInputFormat(formatDescription(format))
        }
    }

    private func formatDescription(
        _ format: AudioStreamBasicDescription
    ) -> String {
        "format=\(format.mFormatID), flags=\(format.mFormatFlags), "
            + "rate=\(format.mSampleRate), channels=\(format.mChannelsPerFrame), "
            + "bits=\(format.mBitsPerChannel)"
    }

    private func installDefaultInputListener() throws {
        var address = defaultInputDeviceAddress()
        try check(
            AudioObjectAddPropertyListener(
                AudioObjectID(kAudioObjectSystemObject),
                &address,
                directDefaultInputDeviceListener,
                Unmanaged.passUnretained(self).toOpaque()
            ),
            operation: "Monitoring the default Core Audio input"
        )
        listenerInstalled = true
    }

    private func removeDefaultInputListener() {
        guard listenerInstalled else { return }
        var address = defaultInputDeviceAddress()
        _ = AudioObjectRemovePropertyListener(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            directDefaultInputDeviceListener,
            Unmanaged.passUnretained(self).toOpaque()
        )
        listenerInstalled = false
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

    private func check(_ status: OSStatus, operation: String) throws {
        guard status == noErr else {
            throw AudioCaptureError.deviceFailure(operation, status)
        }
    }

    private func defaultInputDeviceAddress() -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
    }
}
