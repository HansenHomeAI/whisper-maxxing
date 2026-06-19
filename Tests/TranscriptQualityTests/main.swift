import Foundation
import WhisperDictationCore

private func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else {
        fputs("FAIL: \(message)\n", stderr)
        exit(EXIT_FAILURE)
    }
}

private func makeResult(sessionId: String, text: String) -> SessionResultPayload {
    let metrics = SessionMetrics(
        sessionId: sessionId,
        prebufferMilliseconds: 0,
        audioDurationMilliseconds: 100,
        transcriptionMode: "test",
        transcriptionMilliseconds: 1,
        queueWaitMilliseconds: 0,
        completedAtISO8601: nil
    )

    return SessionResultPayload(
        sessionId: sessionId,
        text: text,
        metrics: metrics,
        salvagePath: nil,
        errorMessage: nil
    )
}

private func testLongAudioWithTinyTranscriptNeedsSecondPass() {
    let assessment = TranscriptQuality.assess(
        text: "Okay. Go ahead.",
        audioDurationMilliseconds: 45_000
    )

    expect(assessment.requiresSecondPass, "long audio with tiny transcript should require a second pass")
    expect(assessment.reason == "long-audio-short-transcript", "expected long-audio-short-transcript reason")
}

private func testLongAudioWithExpectedWordVolumeDoesNotNeedSecondPass() {
    let text = Array(repeating: "voice typing should preserve the full task clearly", count: 8)
        .joined(separator: " ")

    let assessment = TranscriptQuality.assess(
        text: text,
        audioDurationMilliseconds: 45_000
    )

    expect(!assessment.requiresSecondPass, "normal long transcript should not require a second pass")
    expect(assessment.reason == nil, "normal long transcript should not have a quality reason")
}

private func testShortAudioWithShortTranscriptDoesNotNeedSecondPass() {
    let assessment = TranscriptQuality.assess(
        text: "Yes.",
        audioDurationMilliseconds: 1_200
    )

    expect(!assessment.requiresSecondPass, "short dictation should not require a second pass")
    expect(assessment.reason == nil, "short dictation should not have a quality reason")
}

private func testReportedLongTaskFailureNeedsSecondPass() {
    let badTranscript = """
    Okay we need to basically go from our standard right now we are space for a I'll see in.
    Much as possible.
    The best is can you please investigate and. Yeah. Go ahead and. Come with a good game plan.
    """

    let assessment = TranscriptQuality.assess(
        text: badTranscript,
        audioDurationMilliseconds: 60_000
    )

    expect(assessment.requiresSecondPass, "reported long-task failure should require a second pass")
    expect(assessment.reason == "long-audio-short-transcript", "reported failure should have the expected reason")
}

private func testCaptureWithLargeDurationGapIsRejected() {
    let assessment = CaptureIntegrity.assess(
        capturedAudioMilliseconds: 21_300,
        prebufferMilliseconds: 1_000,
        captureWallClockMilliseconds: 60_000
    )

    expect(assessment.requiresFailure, "large capture duration gap should fail instead of pasting a partial transcript")
    expect(assessment.reason == "capture-duration-gap", "expected capture-duration-gap reason")
}

private func testCaptureWithFullCoverageIsAccepted() {
    let assessment = CaptureIntegrity.assess(
        capturedAudioMilliseconds: 61_000,
        prebufferMilliseconds: 1_000,
        captureWallClockMilliseconds: 60_000
    )

    expect(!assessment.requiresFailure, "full capture coverage should be accepted")
    expect(assessment.reason == nil, "full capture coverage should not have a reason")
}

private func testShortCaptureDurationGapIsNotOverPoliced() {
    let assessment = CaptureIntegrity.assess(
        capturedAudioMilliseconds: 2_600,
        prebufferMilliseconds: 1_000,
        captureWallClockMilliseconds: 3_000
    )

    expect(!assessment.requiresFailure, "short captures should not be failed by small timing gaps")
    expect(assessment.reason == nil, "short captures should not have a reason")
}

private func testPrebufferOnlyCaptureIsRejectedEvenWhenShort() {
    let assessment = CaptureIntegrity.assess(
        capturedAudioMilliseconds: 1_000,
        prebufferMilliseconds: 1_000,
        captureWallClockMilliseconds: 2_300
    )

    expect(assessment.requiresFailure, "prebuffer-only captures should fail instead of surfacing as no output")
    expect(assessment.reason == "capture-stalled", "expected capture-stalled reason")
}

private func testCaptureReadinessRejectsStaleBuffers() {
    let assessment = CaptureReadiness.assess(
        engineRunning: true,
        startupSignaled: true,
        secondsSinceLastBuffer: 3.5
    )

    expect(!assessment.ready, "stale capture buffers should not be considered ready")
    expect(assessment.reason == "capture-buffer-stale", "expected capture-buffer-stale reason")
}

private func testCaptureReadinessAcceptsFreshRunningEngine() {
    let assessment = CaptureReadiness.assess(
        engineRunning: true,
        startupSignaled: true,
        secondsSinceLastBuffer: 0.2
    )

    expect(assessment.ready, "fresh running capture engine should be ready")
    expect(assessment.reason == nil, "ready capture engine should not have a reason")
}

private func testRestartPolicyEscalatesAfterRepeatedFailures() {
    let decision = CaptureRestartPolicy.assess(consecutiveFailureCount: 3)

    expect(decision.action == .restartProcess, "repeated capture restart failures should restart the process")
    expect(decision.reason == "capture-restart-failed-repeatedly", "expected repeated-failure reason")
}

private func testRestartPolicyRetriesInitialFailures() {
    let decision = CaptureRestartPolicy.assess(consecutiveFailureCount: 1)

    expect(decision.action == .retry, "first capture restart failure should retry in-process")
    expect(decision.reason == "capture-restart-failed", "expected simple retry reason")
}

private func testSessionResultBufferCanReturnRequestedRecordingWithoutDiscardingEarlierResults() {
    let buffer = SessionResultBuffer()
    buffer.append(makeResult(sessionId: "recording-a", text: "transcript A"))
    buffer.append(makeResult(sessionId: "recording-b", text: "transcript B"))

    let result = buffer.popNext(sessionId: "recording-b")

    expect(result?.sessionId == "recording-b", "requesting recording B should not return stale recording A")
    expect(result?.text == "transcript B", "requesting recording B should return transcript B")
    expect(buffer.count() == 1, "requesting recording B should not discard recording A")

    let earlierResult = buffer.popNext()
    expect(earlierResult?.sessionId == "recording-a", "recording A should remain available after recording B is delivered")
    expect(earlierResult?.text == "transcript A", "recording A transcript should be preserved")
    expect(buffer.count() == 0, "buffer should be empty after both recordings are consumed")
}

private func testSessionResultBufferPreservesResultsWhileRequestedRecordingIsPending() {
    let buffer = SessionResultBuffer()
    buffer.append(makeResult(sessionId: "recording-a", text: "transcript A"))

    let result = buffer.popNext(sessionId: "recording-b")

    expect(result == nil, "missing requested recording should not return an unrelated result")
    expect(buffer.count() == 1, "unrelated results should stay buffered until the requested recording arrives")
}

private func legacyConfigJSON(controlHost: String = "127.0.0.1") -> Data {
    """
    {
      "controlHost": "\(controlHost)",
      "controlPort": 44123,
      "preferredInputDevice": null,
      "enforcePreferredInputDevice": false,
      "prebufferMilliseconds": 1000,
      "audioBufferSizeFrames": 128,
      "pollIntervalMilliseconds": 150,
      "whisperServerBinary": "/tmp/whisper-server",
      "whisperCliBinary": "/tmp/whisper-cli",
      "whisperModelPath": "/tmp/model.bin",
      "whisperVADModelPath": null,
      "whisperServerHost": "127.0.0.1",
      "whisperServerPort": 8177,
      "tempDirectory": "/tmp/WhisperDictation",
      "salvageDirectory": "/tmp/WhisperSalvage",
      "daemonLogPath": "/tmp/daemon.log",
      "whisperServerLogPath": "/tmp/whisper-server.log",
      "controlBinaryPath": "/tmp/whisper-dictation-ctl",
      "daemonBinaryPath": "/tmp/whisper-dictation-daemon",
      "warmServerOnLaunch": true,
      "whisperThreads": 4
    }
    """.data(using: .utf8)!
}

private func testAppConfigDefaultsPublicBetaFieldsForLegacyConfig() {
    let config = try! JSONDecoder().decode(AppConfig.self, from: legacyConfigJSON())

    expect(!config.persistRecentCaptures, "recent capture persistence should default off for legacy configs")
    expect(config.whisperRobustModelPath == nil, "robust model path should default nil for legacy configs")
    expect(
        config.robustWhisperServerPort == AppConfig.defaultRobustWhisperServerPort,
        "robust server port should default for legacy configs"
    )
    expect(
        !config.warmRobustServerOnLaunch,
        "robust server warmup should default off for legacy configs"
    )
    expect(
        config.serverRequestTimeoutSeconds == AppConfig.defaultServerRequestTimeoutSeconds,
        "server timeout should default for legacy configs"
    )
    expect(
        config.robustServerRequestTimeoutSeconds == AppConfig.defaultRobustServerRequestTimeoutSeconds,
        "robust server timeout should default for legacy configs"
    )
    expect(
        config.cliTimeoutSeconds == AppConfig.defaultCLITimeoutSeconds,
        "CLI timeout should default for legacy configs"
    )
}

private func testAppConfigDecodesRobustFields() {
    let json = """
    {
      "controlHost": "127.0.0.1",
      "controlPort": 44123,
      "preferredInputDevice": null,
      "enforcePreferredInputDevice": false,
      "prebufferMilliseconds": 1000,
      "audioBufferSizeFrames": 128,
      "pollIntervalMilliseconds": 150,
      "whisperServerBinary": "/tmp/whisper-server",
      "whisperCliBinary": "/tmp/whisper-cli",
      "whisperModelPath": "/tmp/small.bin",
      "whisperVADModelPath": null,
      "whisperServerHost": "127.0.0.1",
      "whisperServerPort": 8177,
      "whisperRobustModelPath": "/tmp/large-v3.bin",
      "robustWhisperServerPort": 8178,
      "tempDirectory": "/tmp/WhisperDictation",
      "salvageDirectory": "/tmp/WhisperSalvage",
      "daemonLogPath": "/tmp/daemon.log",
      "whisperServerLogPath": "/tmp/whisper-server.log",
      "controlBinaryPath": "/tmp/whisper-dictation-ctl",
      "daemonBinaryPath": "/tmp/whisper-dictation-daemon",
      "warmServerOnLaunch": true,
      "warmRobustServerOnLaunch": false,
      "whisperThreads": 4,
      "persistRecentCaptures": false,
      "serverRequestTimeoutSeconds": 30,
      "robustServerRequestTimeoutSeconds": 120,
      "cliTimeoutSeconds": 90
    }
    """.data(using: .utf8)!

    let config = try! JSONDecoder().decode(AppConfig.self, from: json)
    let paths = AppPaths(config: config)

    expect(config.whisperRobustModelPath == "/tmp/large-v3.bin", "robust model path should decode")
    expect(config.robustWhisperServerPort == 8178, "robust server port should decode")
    expect(
        config.robustServerRequestTimeoutSeconds == 120,
        "robust server timeout should decode"
    )
    expect(
        paths.robustWhisperServerLogURL.lastPathComponent == "whisper-server-robust.log",
        "robust server log path should be derived from the fast server log"
    )
}

private func testAppConfigRejectsNonLoopbackControlHost() {
    do {
        _ = try JSONDecoder().decode(AppConfig.self, from: legacyConfigJSON(controlHost: "0.0.0.0"))
        expect(false, "non-loopback control hosts should be rejected")
    } catch {
        expect(true, "non-loopback control host rejected")
    }
}

private func testRetryRobustCommandRoundTrips() {
    let request = ControlRequest(command: .retryRobust, sessionId: nil)
    let encoded = try! JSONEncoder().encode(request)
    let decoded = try! JSONDecoder().decode(ControlRequest.self, from: encoded)

    expect(decoded.command == .retryRobust, "retry-robust control command should round-trip")
    expect(decoded.sessionId == nil, "retry-robust should not need an explicit session id")
}

testLongAudioWithTinyTranscriptNeedsSecondPass()
testLongAudioWithExpectedWordVolumeDoesNotNeedSecondPass()
testShortAudioWithShortTranscriptDoesNotNeedSecondPass()
testReportedLongTaskFailureNeedsSecondPass()
testCaptureWithLargeDurationGapIsRejected()
testCaptureWithFullCoverageIsAccepted()
testShortCaptureDurationGapIsNotOverPoliced()
testPrebufferOnlyCaptureIsRejectedEvenWhenShort()
testCaptureReadinessRejectsStaleBuffers()
testCaptureReadinessAcceptsFreshRunningEngine()
testRestartPolicyEscalatesAfterRepeatedFailures()
testRestartPolicyRetriesInitialFailures()
testSessionResultBufferCanReturnRequestedRecordingWithoutDiscardingEarlierResults()
testSessionResultBufferPreservesResultsWhileRequestedRecordingIsPending()
testAppConfigDefaultsPublicBetaFieldsForLegacyConfig()
testAppConfigDecodesRobustFields()
testAppConfigRejectsNonLoopbackControlHost()
testRetryRobustCommandRoundTrips()
print("TranscriptQualityTests passed")
