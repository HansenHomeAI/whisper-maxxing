import AudioToolbox
import Dispatch
import Foundation

enum PCMRateConverterError: Error, LocalizedError {
    case invalidSampleRate(Double)
    case converterFailure(String, OSStatus)
    case invalidOutput(UInt32, UInt32)

    var errorDescription: String? {
        switch self {
        case .invalidSampleRate(let sampleRate):
            return "Core Audio reported an invalid input sample rate of \(sampleRate) Hz."
        case .converterFailure(let operation, let status):
            return "\(operation) failed (OSStatus \(status))."
        case .invalidOutput(let frameCount, let byteCount):
            return "Core Audio conversion returned \(frameCount) frames in \(byteCount) bytes."
        }
    }
}

private final class PCMConverterInput {
    private let samples: UnsafeMutablePointer<Int16>
    private let count: Int
    private var offset = 0

    init(_ input: [Int16]) {
        count = input.count
        samples = .allocate(capacity: max(count, 1))
        if count > 0 {
            input.withUnsafeBufferPointer { source in
                samples.initialize(from: source.baseAddress!, count: count)
            }
        }
    }

    deinit {
        if count > 0 {
            samples.deinitialize(count: count)
        }
        samples.deallocate()
    }

    func provide(
        packetCount: UnsafeMutablePointer<UInt32>,
        data: UnsafeMutablePointer<AudioBufferList>,
        packetDescriptions: UnsafeMutablePointer<
            UnsafeMutablePointer<AudioStreamPacketDescription>?
        >?
    ) -> OSStatus {
        packetDescriptions?.pointee = nil
        let provided = min(Int(packetCount.pointee), count - offset)
        guard provided > 0 else {
            packetCount.pointee = 0
            data.pointee.mNumberBuffers = 1
            data.pointee.mBuffers.mNumberChannels = 1
            data.pointee.mBuffers.mDataByteSize = 0
            data.pointee.mBuffers.mData = nil
            return noErr
        }

        packetCount.pointee = UInt32(provided)
        data.pointee.mNumberBuffers = 1
        data.pointee.mBuffers.mNumberChannels = 1
        data.pointee.mBuffers.mDataByteSize = UInt32(
            provided * MemoryLayout<Int16>.size
        )
        data.pointee.mBuffers.mData = UnsafeMutableRawPointer(
            samples.advanced(by: offset)
        )
        offset += provided
        return noErr
    }
}

private func pcmConverterInputCallback(
    _ converter: AudioConverterRef,
    _ packetCount: UnsafeMutablePointer<UInt32>,
    _ data: UnsafeMutablePointer<AudioBufferList>,
    _ packetDescriptions: UnsafeMutablePointer<
        UnsafeMutablePointer<AudioStreamPacketDescription>?
    >?,
    _ userData: UnsafeMutableRawPointer?
) -> OSStatus {
    _ = converter
    guard let userData else {
        packetCount.pointee = 0
        return kAudio_ParamError
    }
    return Unmanaged<PCMConverterInput>
        .fromOpaque(userData)
        .takeUnretainedValue()
        .provide(
            packetCount: packetCount,
            data: data,
            packetDescriptions: packetDescriptions
        )
}

final class PCMRateConverter: @unchecked Sendable {
    private let converter: AudioConverterRef
    private let inputSampleRate: Double
    private let outputSampleRate: Double
    private var pendingInput: [Int16] = []
    private var totalInputFrames: Int64 = 0
    private var totalOutputFrames: Int64 = 0
    private var lastInputSample = Int16(0)

    init(inputSampleRate: Double, outputSampleRate: Double) throws {
        guard inputSampleRate.isFinite, inputSampleRate > 0 else {
            throw PCMRateConverterError.invalidSampleRate(inputSampleRate)
        }
        guard outputSampleRate.isFinite, outputSampleRate > 0 else {
            throw PCMRateConverterError.invalidSampleRate(outputSampleRate)
        }
        self.inputSampleRate = inputSampleRate
        self.outputSampleRate = outputSampleRate

        var inputFormat = Self.linearPCMFormat(sampleRate: inputSampleRate)
        var outputFormat = Self.linearPCMFormat(sampleRate: outputSampleRate)
        var optionalConverter: AudioConverterRef?
        let status = AudioConverterNew(
            &inputFormat,
            &outputFormat,
            &optionalConverter
        )
        guard status == noErr, let optionalConverter else {
            throw PCMRateConverterError.converterFailure(
                "Creating the Core Audio sample-rate converter",
                status
            )
        }
        converter = optionalConverter

        var primeMethod = UInt32(kConverterPrimeMethod_None)
        let primeStatus = withUnsafeBytes(of: &primeMethod) { bytes in
            AudioConverterSetProperty(
                optionalConverter,
                kAudioConverterPrimeMethod,
                UInt32(bytes.count),
                bytes.baseAddress!
            )
        }
        guard primeStatus == noErr else {
            AudioConverterDispose(optionalConverter)
            throw PCMRateConverterError.converterFailure(
                "Configuring the Core Audio sample-rate converter",
                primeStatus
            )
        }
    }

    deinit {
        AudioConverterDispose(converter)
    }

    func convert(_ input: [Int16]) throws -> [Int16] {
        guard !input.isEmpty else { return [] }
        lastInputSample = input[input.count - 1]
        pendingInput.append(contentsOf: input)
        totalInputFrames += Int64(input.count)
        let targetOutputFrames = Int64(
            floor(
                Double(totalInputFrames) * outputSampleRate / inputSampleRate
                    + 0.000_001
            )
        )
        let outputCapacity = Int(targetOutputFrames - totalOutputFrames)
        guard outputCapacity > 0 else { return [] }
        return try convertPendingInput(outputCapacity: outputCapacity)
    }

    func finish() throws -> [Int16] {
        let targetOutputFrames = Int64(
            floor(
                Double(totalInputFrames) * outputSampleRate / inputSampleRate
                    + 0.000_001
            )
        )
        let outputCapacity = Int(targetOutputFrames - totalOutputFrames)
        guard outputCapacity > 0 else { return [] }
        pendingInput.append(
            contentsOf: repeatElement(lastInputSample, count: 256)
        )
        return try convertPendingInput(outputCapacity: outputCapacity)
    }

    private func convertPendingInput(
        outputCapacity: Int
    ) throws -> [Int16] {
        var output = [Int16](repeating: 0, count: outputCapacity)
        let inputContext = PCMConverterInput(pendingInput)
        var outputFrameCount = UInt32(outputCapacity)
        var outputByteCount = UInt32(outputCapacity * MemoryLayout<Int16>.size)
        let status = output.withUnsafeMutableBufferPointer { buffer in
            var outputData = AudioBufferList(
                mNumberBuffers: 1,
                mBuffers: AudioBuffer(
                    mNumberChannels: 1,
                    mDataByteSize: outputByteCount,
                    mData: buffer.baseAddress
                )
            )
            let conversionStatus = AudioConverterFillComplexBuffer(
                converter,
                pcmConverterInputCallback,
                Unmanaged.passUnretained(inputContext).toOpaque(),
                &outputFrameCount,
                &outputData,
                nil
            )
            outputByteCount = outputData.mBuffers.mDataByteSize
            return conversionStatus
        }
        guard status == noErr else {
            throw PCMRateConverterError.converterFailure(
                "Converting Core Audio input to 16 kHz",
                status
            )
        }
        pendingInput.removeAll(keepingCapacity: true)
        let expectedBytes = outputFrameCount * UInt32(MemoryLayout<Int16>.size)
        guard outputFrameCount <= UInt32(outputCapacity),
              outputByteCount == expectedBytes
        else {
            throw PCMRateConverterError.invalidOutput(
                outputFrameCount,
                outputByteCount
            )
        }
        totalOutputFrames += Int64(outputFrameCount)
        return Array(output.prefix(Int(outputFrameCount)))
    }

    private static func linearPCMFormat(
        sampleRate: Double
    ) -> AudioStreamBasicDescription {
        AudioStreamBasicDescription(
            mSampleRate: sampleRate,
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
            mBytesPerPacket: UInt32(MemoryLayout<Int16>.size),
            mFramesPerPacket: 1,
            mBytesPerFrame: UInt32(MemoryLayout<Int16>.size),
            mChannelsPerFrame: 1,
            mBitsPerChannel: UInt32(Int16.bitWidth),
            mReserved: 0
        )
    }
}

enum PCMConversionEnqueueResult: Equatable {
    case accepted
    case overflow
    case stopped
}

enum NativePCMStorage: Sendable {
    case float32([[Float]])
    case int16([[Int16]])
    case int32([[Int32]])
}

struct NativePCMInput: Sendable {
    let storage: NativePCMStorage
    let frameCount: Int
    let channels: Int
    let nonInterleaved: Bool

    func monoInt16() -> [Int16] {
        switch storage {
        case .float32(let buffers):
            return (0..<frameCount).map { frame in
                var sum = Float(0)
                for channel in 0..<channels {
                    sum += value(
                        buffers,
                        frame: frame,
                        channel: channel
                    )
                }
                let mono = max(-1, min(1, sum / Float(channels)))
                return Int16(
                    max(
                        Double(Int16.min),
                        min(Double(Int16.max), Double(mono) * Double(Int16.max))
                    )
                )
            }
        case .int16(let buffers):
            return (0..<frameCount).map { frame in
                var sum = Int64(0)
                for channel in 0..<channels {
                    sum += Int64(value(
                        buffers,
                        frame: frame,
                        channel: channel
                    ))
                }
                return Int16(sum / Int64(channels))
            }
        case .int32(let buffers):
            return (0..<frameCount).map { frame in
                var sum = Int64(0)
                for channel in 0..<channels {
                    sum += Int64(value(
                        buffers,
                        frame: frame,
                        channel: channel
                    ))
                }
                return Int16(clamping: sum / Int64(channels) >> 16)
            }
        }
    }

    private func value<Value>(
        _ buffers: [[Value]],
        frame: Int,
        channel: Int
    ) -> Value {
        if nonInterleaved {
            return buffers[channel][frame]
        }
        return buffers[0][frame * channels + channel]
    }
}

public final class AudioBacklogBudget: @unchecked Sendable {
    private let maximumOutputSamples: Double
    private let lock = NSLock()
    private var reservedOutputSamples = 0.0

    public init(
        maximumPCMFrames: Int = CaptureProtocol.maximumQueuedPCMFrames
    ) {
        precondition(maximumPCMFrames > 0)
        maximumOutputSamples = Double(
            maximumPCMFrames * CaptureProtocol.samplesPerFrame
        )
    }

    func reserveInputSamples(
        _ sampleCount: Int,
        inputSampleRate: Double
    ) -> Bool {
        precondition(sampleCount >= 0)
        precondition(inputSampleRate.isFinite && inputSampleRate > 0)
        let outputEquivalent = Double(sampleCount)
            * Double(CaptureProtocol.sampleRateHz)
            / inputSampleRate

        lock.lock()
        defer { lock.unlock() }
        guard reservedOutputSamples + outputEquivalent
                <= maximumOutputSamples + 0.000_001
        else {
            return false
        }
        reservedOutputSamples += outputEquivalent
        return true
    }

    func releaseOutputSamples(_ sampleCount: Int) {
        precondition(sampleCount >= 0)
        lock.lock()
        reservedOutputSamples = max(
            0,
            reservedOutputSamples - Double(sampleCount)
        )
        lock.unlock()
    }

    var reservedOutputSampleEquivalent: Double {
        lock.lock()
        defer { lock.unlock() }
        return reservedOutputSamples
    }
}

final class PCMConversionWorker: @unchecked Sendable {
    typealias OutputHandler = @Sendable ([Int16]) -> Void
    typealias ErrorHandler = @Sendable (Error) -> Void

    private let converter: PCMRateConverter
    private let inputSampleRate: Double
    private let backlogBudget: AudioBacklogBudget
    private let outputHandler: OutputHandler
    private let errorHandler: ErrorHandler
    private let queue = DispatchQueue(label: "whisper.mac.capture.sample-rate-converter")
    private let stateLock = NSLock()
    private var pendingBuffers = 0
    private var acceptingInput = true

    init(
        inputSampleRate: Double,
        outputSampleRate: Double,
        backlogBudget: AudioBacklogBudget,
        outputHandler: @escaping OutputHandler,
        errorHandler: @escaping ErrorHandler
    ) throws {
        converter = try PCMRateConverter(
            inputSampleRate: inputSampleRate,
            outputSampleRate: outputSampleRate
        )
        self.inputSampleRate = inputSampleRate
        self.backlogBudget = backlogBudget
        self.outputHandler = outputHandler
        self.errorHandler = errorHandler
    }

    func enqueue(_ input: UnsafeBufferPointer<Int16>) -> PCMConversionEnqueueResult {
        let copiedInput = Array(input)
        return enqueue(
            frameCount: input.count,
            makeMonoInput: { copiedInput }
        )
    }

    func enqueue(_ input: NativePCMInput) -> PCMConversionEnqueueResult {
        enqueue(
            frameCount: input.frameCount,
            makeMonoInput: input.monoInt16
        )
    }

    private func enqueue(
        frameCount: Int,
        makeMonoInput: @escaping @Sendable () -> [Int16]
    ) -> PCMConversionEnqueueResult {
        stateLock.lock()
        guard acceptingInput else {
            stateLock.unlock()
            return .stopped
        }
        guard backlogBudget.reserveInputSamples(
            frameCount,
            inputSampleRate: inputSampleRate
        ) else {
            stateLock.unlock()
            return .overflow
        }
        pendingBuffers += 1
        stateLock.unlock()

        queue.async { [self, makeMonoInput] in
            defer { completedBuffer() }
            do {
                let output = try converter.convert(makeMonoInput())
                if !output.isEmpty {
                    outputHandler(output)
                }
            } catch {
                errorHandler(error)
            }
        }
        return .accepted
    }

    func stop() {
        stateLock.lock()
        let wasAcceptingInput = acceptingInput
        acceptingInput = false
        stateLock.unlock()
        guard wasAcceptingInput else { return }
        queue.sync { [self] in
            do {
                let output = try converter.finish()
                if !output.isEmpty {
                    outputHandler(output)
                }
            } catch {
                errorHandler(error)
            }
        }
    }

    func waitUntilIdle() {
        queue.sync {}
    }

    var pendingBufferCount: Int {
        stateLock.lock()
        defer { stateLock.unlock() }
        return pendingBuffers
    }

    private func completedBuffer() {
        stateLock.lock()
        pendingBuffers -= 1
        stateLock.unlock()
    }
}
