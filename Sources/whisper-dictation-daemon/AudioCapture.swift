@preconcurrency import AVFoundation
import Darwin
import Foundation
import WhisperDictationCore

struct StoppedCapture {
    let sessionId: String
    let transcriptionProfile: TranscriptionProfile
    let startedAt: Date
    let stoppedAt: Date
    let prebufferMilliseconds: Double
    let samples: [Int16]
    let signalMetrics: AudioSignalMetrics
}

struct AudioSignalMetrics: Sendable {
    let peakDecibels: Double
    let rmsDecibels: Double
    let probablySilent: Bool
}

enum AudioCaptureError: Error, LocalizedError {
    case startupTimedOut
    case captureRecovering
    case converterInitializationFailed
    case alreadyRecording
    case noActiveSession

    var errorDescription: String? {
        switch self {
        case .startupTimedOut:
            return "Audio capture did not become ready in time."
        case .captureRecovering:
            return "Audio input is recovering. Try dictation again in a moment."
        case .converterInitializationFailed:
            return "Unable to initialize the audio converter."
        case .alreadyRecording:
            return "A recording is already active."
        case .noActiveSession:
            return "There is no active recording session."
        }
    }
}

private final class ActiveCaptureSession {
    let sessionId: String
    let transcriptionProfile: TranscriptionProfile
    let startedAt: Date
    let prebufferMilliseconds: Double
    var samples: [Int16]

    init(
        sessionId: String,
        transcriptionProfile: TranscriptionProfile,
        startedAt: Date,
        prebufferMilliseconds: Double,
        samples: [Int16]
    ) {
        self.sessionId = sessionId
        self.transcriptionProfile = transcriptionProfile
        self.startedAt = startedAt
        self.prebufferMilliseconds = prebufferMilliseconds
        self.samples = samples
    }
}

private final class ConverterFeedState: @unchecked Sendable {
    var used = false
}

final class AudioCaptureEngine: @unchecked Sendable {
    private static let silentPeakThresholdDecibels = -50.0
    private static let silentRMSThresholdDecibels = -55.0
    private static let restartRetryDelaySeconds = 1.0

    private let config: AppConfig
    private let ringBuffer: Int16RingBuffer
    private var engine = AVAudioEngine()
    private let outputFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: 16_000,
        channels: 1,
        interleaved: true
    )!
    private var converter: AVAudioConverter?
    private var converterInputFormat: AVAudioFormat?
    private let sessionLock = NSLock()
    private let converterLock = NSLock()
    private let lifecycleQueue = DispatchQueue(label: "whisper.dictation.capture.lifecycle")
    private var activeSession: ActiveCaptureSession?
    private var startupSemaphore = DispatchSemaphore(value: 0)
    private var startupSignaled = false
    private var configurationObserver: NSObjectProtocol?
    private var restartInFlight = false
    private var deferredRestartReason: String?
    private var restartRetryWorkItem: DispatchWorkItem?
    private var lastBufferAt: Date?
    private var consecutiveRestartFailures = 0
    private var tapInstalled = false
    private var engineRunningSnapshot = false
    private var startupInProgress = false

    private(set) var engineStartupMilliseconds: Double?
    private(set) var defaultInputDeviceName: String?

    init(config: AppConfig) {
        self.config = config
        let ringCapacity = Int(Double(config.prebufferMilliseconds) * 16.0)
        self.ringBuffer = Int16RingBuffer(capacity: ringCapacity)
        installConfigurationObserver()
    }

    deinit {
        if let configurationObserver {
            NotificationCenter.default.removeObserver(configurationObserver)
        }
    }

    func start() throws {
        try lifecycleQueue.sync {
            try startEngineLocked()
        }
    }

    func startAsync() {
        lifecycleQueue.async { [weak self] in
            guard let self else { return }
            do {
                try self.startEngineLocked()
            } catch {
                fputs("whisper-dictation-daemon: audio capture start failed: \(error.localizedDescription)\n", stderr)
            }
        }
    }

    func stop() {
        lifecycleQueue.sync {
            stopEngineLocked()
        }
    }

    func startSession(profile: TranscriptionProfile) throws -> (sessionId: String, prebufferMilliseconds: Double) {
        guard readinessAssessment().ready else {
            scheduleRestart(reason: "session-start-not-ready")
            throw AudioCaptureError.captureRecovering
        }

        try lifecycleQueue.sync {
            let readiness = captureReadinessLocked(now: Date())
            guard !readiness.ready else {
                return
            }

            fputs(
                "whisper-dictation-daemon: capture not ready at session start (\(readiness.reason ?? "unknown")); restarting audio capture\n",
                stderr
            )
            guard restartNowLocked(reason: "session-start-not-ready") else {
                throw AudioCaptureError.captureRecovering
            }
        }

        sessionLock.lock()
        defer { sessionLock.unlock() }

        guard activeSession == nil else {
            throw AudioCaptureError.alreadyRecording
        }

        let prebufferSamples = ringBuffer.snapshot()
        let prebufferMilliseconds = Double(prebufferSamples.count) / 16.0
        let sessionId = UUID().uuidString.lowercased()

        activeSession = ActiveCaptureSession(
            sessionId: sessionId,
            transcriptionProfile: profile,
            startedAt: Date(),
            prebufferMilliseconds: prebufferMilliseconds,
            samples: prebufferSamples
        )

        fputs(
            "whisper-dictation-daemon: capture session started id=\(sessionId) profile=\(profile.rawValue) prebuffer_ms=\(Int(prebufferMilliseconds))\n",
            stderr
        )

        return (sessionId: sessionId, prebufferMilliseconds: prebufferMilliseconds)
    }

    func stopSession(discard: Bool) throws -> StoppedCapture? {
        var capture: StoppedCapture?
        let stoppedAt = Date()

        sessionLock.lock()
        defer { sessionLock.unlock() }

        guard let session = activeSession else {
            throw AudioCaptureError.noActiveSession
        }

        activeSession = nil
        guard !discard else {
            return nil
        }

        let signalMetrics = Self.analyze(samples: session.samples)
        let audioDurationMilliseconds = Double(session.samples.count) / 16.0
        let wallClockMilliseconds = stoppedAt.timeIntervalSince(session.startedAt) * 1000.0
        let activeAudioMilliseconds = max(audioDurationMilliseconds - session.prebufferMilliseconds, 0)
        let droppedMilliseconds = max(wallClockMilliseconds - activeAudioMilliseconds, 0)
        fputs(
            "whisper-dictation-daemon: capture session stopped id=\(session.sessionId) wall_ms=\(Int(wallClockMilliseconds)) audio_ms=\(Int(audioDurationMilliseconds)) prebuffer_ms=\(Int(session.prebufferMilliseconds)) dropped_ms=\(Int(droppedMilliseconds))\n",
            stderr
        )

        capture = StoppedCapture(
            sessionId: session.sessionId,
            transcriptionProfile: session.transcriptionProfile,
            startedAt: session.startedAt,
            stoppedAt: stoppedAt,
            prebufferMilliseconds: session.prebufferMilliseconds,
            samples: session.samples,
            signalMetrics: signalMetrics
        )

        if signalMetrics.probablySilent {
            let reason = String(
                format: "silent capture detected (peak %.1f dBFS, rms %.1f dBFS)",
                signalMetrics.peakDecibels,
                signalMetrics.rmsDecibels
            )
            scheduleRestart(reason: reason)
        } else {
            restartAfterSessionIfNeeded()
        }

        return capture
    }

    func isRecording() -> Bool {
        sessionLock.lock()
        defer { sessionLock.unlock() }
        return activeSession != nil
    }

    func currentRecordingProfile() -> TranscriptionProfile? {
        sessionLock.lock()
        defer { sessionLock.unlock() }
        return activeSession?.transcriptionProfile
    }

    func prebufferAvailableMilliseconds() -> Double {
        ringBuffer.availableMilliseconds
    }

    func readinessAssessment() -> CaptureReadinessAssessment {
        captureReadinessLocked(now: Date())
    }

    private func handle(buffer: AVAudioPCMBuffer) {
        converterLock.lock()
        if converter == nil || !Self.formatsMatch(converterInputFormat, buffer.format) {
            converter = AVAudioConverter(from: buffer.format, to: outputFormat)
            converterInputFormat = buffer.format
        }

        guard let converter else {
            converterLock.unlock()
            return
        }
        converterLock.unlock()

        let ratio = outputFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
        guard let convertedBuffer = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else {
            return
        }

        var conversionError: NSError?
        let feedState = ConverterFeedState()
        let inputBlock: AVAudioConverterInputBlock = { _, status in
            if feedState.used {
                status.pointee = .noDataNow
                return nil
            }

            feedState.used = true
            status.pointee = .haveData
            return buffer
        }

        converter.convert(to: convertedBuffer, error: &conversionError, withInputFrom: inputBlock)
        guard conversionError == nil, convertedBuffer.frameLength > 0 else {
            return
        }

        guard let channelPointer = convertedBuffer.int16ChannelData?.pointee else {
            return
        }

        let sampleCount = Int(convertedBuffer.frameLength)
        let sampleBuffer = UnsafeBufferPointer(start: channelPointer, count: sampleCount)

        ringBuffer.append(sampleBuffer)

        sessionLock.lock()
        if let session = activeSession {
            session.samples.append(contentsOf: sampleBuffer)
        }
        sessionLock.unlock()

        markBufferReceived()
    }

    private func markBufferReceived() {
        converterLock.lock()
        lastBufferAt = Date()
        if !startupSignaled {
            startupSignaled = true
            let semaphore = startupSemaphore
            converterLock.unlock()
            semaphore.signal()
            return
        }
        converterLock.unlock()
    }

    private func startEngineLocked() throws {
        setStartupInProgress(true)
        defer { setStartupInProgress(false) }

        defaultInputDeviceName = try CoreAudioDevice.ensurePreferredInputDevice(
            named: config.preferredInputDevice,
            enforceAsDefault: config.enforcePreferredInputDevice
        )

        rebuildEngineLocked()
        setStartupInProgress(true)

        let inputNode = engine.inputNode

        let startupSemaphore = DispatchSemaphore(value: 0)
        converterLock.lock()
        self.converter = nil
        self.converterInputFormat = nil
        self.startupSemaphore = startupSemaphore
        self.startupSignaled = false
        converterLock.unlock()

        let startNs = DispatchTime.now().uptimeNanoseconds
        inputNode.installTap(
            onBus: 0,
            bufferSize: AVAudioFrameCount(config.audioBufferSizeFrames),
            format: nil
        ) { [weak self] buffer, _ in
            self?.handle(buffer: buffer)
        }
        tapInstalled = true

        do {
            try engine.start()
        } catch {
            stopEngineLocked()
            throw error
        }
        setEngineRunningSnapshot(true)

        guard startupSemaphore.wait(timeout: .now() + .seconds(2)) == .success else {
            stopEngineLocked()
            throw AudioCaptureError.startupTimedOut
        }

        let endNs = DispatchTime.now().uptimeNanoseconds
        engineStartupMilliseconds = Double(endNs - startNs) / 1_000_000.0
        restartRetryWorkItem?.cancel()
        restartRetryWorkItem = nil
        consecutiveRestartFailures = 0
    }

    private func stopEngineLocked() {
        stopCurrentEngineLocked()

        converterLock.lock()
        converter = nil
        converterInputFormat = nil
        startupSemaphore = DispatchSemaphore(value: 0)
        startupSignaled = false
        lastBufferAt = nil
        engineRunningSnapshot = false
        startupInProgress = false
        converterLock.unlock()
    }

    private func rebuildEngineLocked() {
        if let configurationObserver {
            NotificationCenter.default.removeObserver(configurationObserver)
            self.configurationObserver = nil
        }

        stopEngineLocked()
        engine = AVAudioEngine()
        installConfigurationObserver()
    }

    private func stopCurrentEngineLocked() {
        if tapInstalled {
            engine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        if engine.isRunning {
            engine.stop()
        }
        setEngineRunningSnapshot(false)
        engine.reset()
        ringBuffer.clear()
    }

    private func installConfigurationObserver() {
        configurationObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: engine,
            queue: nil
        ) { [weak self] _ in
            self?.scheduleRestart(reason: "audio engine configuration changed")
        }
    }

    private func scheduleRestart(reason: String) {
        lifecycleQueue.async { [weak self] in
            guard let self else { return }
            if self.sessionIsActive() {
                self.deferredRestartReason = reason
                fputs(
                    "whisper-dictation-daemon: deferring audio capture restart until session stops (\(reason))\n",
                    stderr
                )
                return
            }

            _ = self.restartNowLocked(reason: reason)
        }
    }

    private func restartAfterSessionIfNeeded() {
        lifecycleQueue.async { [weak self] in
            guard let self, let reason = self.deferredRestartReason else { return }
            self.deferredRestartReason = nil
            _ = self.restartNowLocked(reason: "deferred: \(reason)")
        }
    }

    @discardableResult
    private func restartNowLocked(reason: String) -> Bool {
        guard !restartInFlight else { return false }
        deferredRestartReason = nil
        restartInFlight = true
        defer { restartInFlight = false }

        fputs("whisper-dictation-daemon: restarting audio capture (\(reason))\n", stderr)

        do {
            try startEngineLocked()
            return true
        } catch {
            consecutiveRestartFailures += 1
            fputs("whisper-dictation-daemon: audio capture restart failed: \(error.localizedDescription)\n", stderr)
            handleRestartFailureLocked()
            return false
        }
    }

    private func handleRestartFailureLocked() {
        let decision = CaptureRestartPolicy.assess(consecutiveFailureCount: consecutiveRestartFailures)
        switch decision.action {
        case .retry:
            scheduleRestartRetryLocked(reason: decision.reason)
        case .restartProcess:
            fputs(
                "whisper-dictation-daemon: audio capture restart failed \(consecutiveRestartFailures) times; exiting for launchd recovery\n",
                stderr
            )
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.1) {
                Darwin.exit(EX_TEMPFAIL)
            }
        }
    }

    private func scheduleRestartRetryLocked(reason: String) {
        restartRetryWorkItem?.cancel()

        let item = DispatchWorkItem { [weak self] in
            guard let self else { return }
            if self.sessionIsActive() {
                self.deferredRestartReason = reason
                return
            }

            _ = self.restartNowLocked(reason: reason)
        }
        restartRetryWorkItem = item
        lifecycleQueue.asyncAfter(
            deadline: .now() + Self.restartRetryDelaySeconds,
            execute: item
        )
    }

    private func sessionIsActive() -> Bool {
        sessionLock.lock()
        defer { sessionLock.unlock() }
        return activeSession != nil
    }

    private func captureReadinessLocked(now: Date) -> CaptureReadinessAssessment {
        converterLock.lock()
        let engineRunning = engineRunningSnapshot
        let startupInProgress = startupInProgress
        let startupSignaled = self.startupSignaled
        let secondsSinceLastBuffer = lastBufferAt.map { now.timeIntervalSince($0) }
        converterLock.unlock()

        return CaptureReadiness.assess(
            engineRunning: engineRunning || startupInProgress,
            startupSignaled: startupSignaled && !startupInProgress,
            secondsSinceLastBuffer: secondsSinceLastBuffer
        )
    }

    private func setEngineRunningSnapshot(_ running: Bool) {
        converterLock.lock()
        engineRunningSnapshot = running
        converterLock.unlock()
    }

    private func setStartupInProgress(_ inProgress: Bool) {
        converterLock.lock()
        startupInProgress = inProgress
        converterLock.unlock()
    }

    private static func analyze(samples: [Int16]) -> AudioSignalMetrics {
        guard !samples.isEmpty else {
            return AudioSignalMetrics(
                peakDecibels: -.infinity,
                rmsDecibels: -.infinity,
                probablySilent: true
            )
        }

        var peakMagnitude = 0.0
        var meanSquare = 0.0

        for sample in samples {
            let normalized = Double(abs(Int(sample))) / Double(Int16.max)
            peakMagnitude = max(peakMagnitude, normalized)
            meanSquare += normalized * normalized
        }

        let rmsMagnitude = sqrt(meanSquare / Double(samples.count))
        let peakDecibels = decibels(for: peakMagnitude)
        let rmsDecibels = decibels(for: rmsMagnitude)

        return AudioSignalMetrics(
            peakDecibels: peakDecibels,
            rmsDecibels: rmsDecibels,
            probablySilent: peakDecibels <= silentPeakThresholdDecibels && rmsDecibels <= silentRMSThresholdDecibels
        )
    }

    private static func decibels(for normalizedMagnitude: Double) -> Double {
        guard normalizedMagnitude > 0 else {
            return -.infinity
        }

        return 20.0 * log10(normalizedMagnitude)
    }

    private static func formatsMatch(_ lhs: AVAudioFormat?, _ rhs: AVAudioFormat) -> Bool {
        guard let lhs else {
            return false
        }

        return lhs.sampleRate == rhs.sampleRate
            && lhs.channelCount == rhs.channelCount
            && lhs.commonFormat == rhs.commonFormat
            && lhs.isInterleaved == rhs.isInterleaved
    }
}
