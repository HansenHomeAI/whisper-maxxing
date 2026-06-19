import Foundation

public enum TranscriptionProfile: String, Codable, Sendable, Hashable {
    case fast
    case robust
}

public enum ControlCommand: String, Codable, Sendable {
    case warmup
    case start
    case startRobust
    case retryRobust
    case stop
    case cancel
    case nextResult
    case status
    case shutdown
}

public struct ControlRequest: Codable, Sendable {
    public let command: ControlCommand
    public let sessionId: String?

    public init(command: ControlCommand, sessionId: String? = nil) {
        self.command = command
        self.sessionId = sessionId
    }
}

public struct SessionMetrics: Codable, Sendable {
    public let sessionId: String
    public let transcriptionProfile: String?
    public let prebufferMilliseconds: Double
    public let audioDurationMilliseconds: Double
    public let captureStartedAtISO8601: String?
    public let captureStoppedAtISO8601: String?
    public let captureWallClockMilliseconds: Double?
    public let activeAudioMilliseconds: Double?
    public let captureDroppedMilliseconds: Double?
    public let captureCoverageRatio: Double?
    public let transcriptionMode: String?
    public let transcriptionMilliseconds: Double?
    public let queueWaitMilliseconds: Double?
    public let completedAtISO8601: String?

    public init(
        sessionId: String,
        transcriptionProfile: String? = nil,
        prebufferMilliseconds: Double,
        audioDurationMilliseconds: Double,
        captureStartedAtISO8601: String? = nil,
        captureStoppedAtISO8601: String? = nil,
        captureWallClockMilliseconds: Double? = nil,
        activeAudioMilliseconds: Double? = nil,
        captureDroppedMilliseconds: Double? = nil,
        captureCoverageRatio: Double? = nil,
        transcriptionMode: String?,
        transcriptionMilliseconds: Double?,
        queueWaitMilliseconds: Double?,
        completedAtISO8601: String?
    ) {
        self.sessionId = sessionId
        self.transcriptionProfile = transcriptionProfile
        self.prebufferMilliseconds = prebufferMilliseconds
        self.audioDurationMilliseconds = audioDurationMilliseconds
        self.captureStartedAtISO8601 = captureStartedAtISO8601
        self.captureStoppedAtISO8601 = captureStoppedAtISO8601
        self.captureWallClockMilliseconds = captureWallClockMilliseconds
        self.activeAudioMilliseconds = activeAudioMilliseconds
        self.captureDroppedMilliseconds = captureDroppedMilliseconds
        self.captureCoverageRatio = captureCoverageRatio
        self.transcriptionMode = transcriptionMode
        self.transcriptionMilliseconds = transcriptionMilliseconds
        self.queueWaitMilliseconds = queueWaitMilliseconds
        self.completedAtISO8601 = completedAtISO8601
    }
}

public struct SessionResultPayload: Codable, Sendable {
    public let sessionId: String
    public let text: String
    public let metrics: SessionMetrics
    public let salvagePath: String?
    public let errorMessage: String?

    public init(
        sessionId: String,
        text: String,
        metrics: SessionMetrics,
        salvagePath: String?,
        errorMessage: String?
    ) {
        self.sessionId = sessionId
        self.text = text
        self.metrics = metrics
        self.salvagePath = salvagePath
        self.errorMessage = errorMessage
    }
}

public struct StatusPayload: Codable, Sendable {
    public let recording: Bool
    public let recordingProfile: String?
    public let pendingCount: Int
    public let engineReady: Bool
    public let engineHealthMessage: String?
    public let engineStartupMilliseconds: Double?
    public let prebufferAvailableMilliseconds: Double
    public let preferredInputDevice: String?
    public let defaultInputDevice: String?
    public let serverState: String
    public let robustServerState: String?
    public let availableDiskSpaceBytes: Int64?
    public let lowDiskSpaceMessage: String?

    public init(
        recording: Bool,
        recordingProfile: String? = nil,
        pendingCount: Int,
        engineReady: Bool,
        engineHealthMessage: String? = nil,
        engineStartupMilliseconds: Double?,
        prebufferAvailableMilliseconds: Double,
        preferredInputDevice: String?,
        defaultInputDevice: String?,
        serverState: String,
        robustServerState: String? = nil,
        availableDiskSpaceBytes: Int64?,
        lowDiskSpaceMessage: String?
    ) {
        self.recording = recording
        self.recordingProfile = recordingProfile
        self.pendingCount = pendingCount
        self.engineReady = engineReady
        self.engineHealthMessage = engineHealthMessage
        self.engineStartupMilliseconds = engineStartupMilliseconds
        self.prebufferAvailableMilliseconds = prebufferAvailableMilliseconds
        self.preferredInputDevice = preferredInputDevice
        self.defaultInputDevice = defaultInputDevice
        self.serverState = serverState
        self.robustServerState = robustServerState
        self.availableDiskSpaceBytes = availableDiskSpaceBytes
        self.lowDiskSpaceMessage = lowDiskSpaceMessage
    }
}

public struct ControlResponse: Codable, Sendable {
    public var ok: Bool
    public var error: String?
    public var recording: Bool?
    public var pendingCount: Int?
    public var sessionId: String?
    public var resultAvailable: Bool?
    public var result: SessionResultPayload?
    public var status: StatusPayload?
    public var clientObservedMilliseconds: Double?
    public var coldBootMilliseconds: Double?

    public init(ok: Bool, error: String? = nil) {
        self.ok = ok
        self.error = error
    }
}
