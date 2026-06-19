-- Low-latency whisper dictation hotkey via a native capture daemon.

local function directoryIsWritable(path)
  if not hs.fs.attributes(path) then
    return false
  end

  local probe = string.format("%s/.hammerspoon-write-test-%d", path, os.time())
  local file = io.open(probe, "w")
  if not file then
    return false
  end

  file:close()
  os.remove(probe)
  return true
end

if hs.ipc and not hs.ipc.cliStatus()
    and directoryIsWritable("/usr/local/bin")
    and directoryIsWritable("/usr/local/share/man/man1") then
  hs.ipc.cliInstall()
end

hs.alert.defaultStyle = {
  fillColor       = { white = 0.08, alpha = 0.65 },
  strokeColor     = { white = 1.0, alpha = 0.10 },
  strokeWidth     = 0,
  radius          = 26,
  atScreenEdge    = 0,
  textColor       = { white = 1.0, alpha = 0.95 },
  textFont        = ".AppleSystemUIFont",
  textSize        = 22,
  padding         = 14,
  fadeInDuration  = 0.08,
  fadeOutDuration = 0.08,
}

local configPath = os.getenv("HOME") .. "/Library/Application Support/WhisperDictation/config.json"
local replacementWindowSeconds = 15
local replacementPasteDelaySeconds = 0.08
local config = nil
local controlBin = nil
local activeTasks = {}
local pendingCount = 0
local recordState = "idle"
local recordProfile = "fast"
local resultPoller = nil
local recordingOverlay = nil
local lastHealthWarningAt = 0
local pendingSessionIds = {}
local replacementTargets = {}
local lastDictationPaste = nil
local statusWatchdog = nil

local function alert(message)
  hs.alert.show(message, 0.95)
end

local function frontmostBundleID()
  local app = hs.application.frontmostApplication()
  if not app then
    return nil
  end

  return app:bundleID()
end

local function isRobustProfile(profile)
  return profile == "robust"
end

local function recordingLabel(profile)
  return isRobustProfile(profile) and "Robust Recording" or "Recording"
end

local function transcriptReadyLabel(profile)
  return isRobustProfile(profile) and "Large Model Transcript Ready" or "Transcript Ready"
end

local function processingLabel(profile)
  return isRobustProfile(profile) and "Retranscribing Audio" or "Processing Audio"
end

local function loadConfig()
  local file = io.open(configPath, "r")
  if not file then
    return nil, "Dictation config not installed"
  end

  local raw = file:read("*a")
  file:close()

  local decoded = hs.json.decode(raw)
  if not decoded then
    return nil, "Failed to parse dictation config"
  end

  return decoded, nil
end

local function showRecordingOverlay(profile)
  if recordingOverlay then
    recordingOverlay:delete()
    recordingOverlay = nil
  end

  local screen = hs.screen.mainScreen()
  local frame = screen:frame()
  local label = recordingLabel(profile)
  local width, height = isRobustProfile(profile) and 228 or 150, 42
  local x = frame.x + (frame.w - width) / 2
  local y = frame.y + frame.h - height - 20
  local canvas = hs.canvas.new({x = x, y = y, w = width, h = height})

  canvas:appendElements({
    action = "fill",
    type = "rectangle",
    fillColor = {white = 0.08, alpha = 0.85},
    roundedRectRadii = {xRadius = height/2, yRadius = height/2},
  }, {
    action = "fill",
    type = "circle",
    center = {x = 22, y = height/2},
    radius = 7.2,
    fillColor = {red = 1, green = 0.2, blue = 0.2, alpha = 0.9},
    strokeColor = {red = 1, green = 0.2, blue = 0.2, alpha = 1},
    strokeWidth = 0,
  }, {
    action = "fill",
    type = "text",
    text = label,
    textFont = hs.alert.defaultStyle.textFont,
    textSize = 19,
    textColor = hs.alert.defaultStyle.textColor,
    textAlignment = "center",
    frame = {x = 32, y = 10, w = width - 44, h = height - 18},
  })

  canvas:show()
  recordingOverlay = canvas
end

local function hideRecordingOverlay()
  if recordingOverlay then
    recordingOverlay:delete()
    recordingOverlay = nil
  end
end

local function normalizeTranscript(text)
  if not text then
    return nil
  end

  local trimmed = text:gsub("^%s+", ""):gsub("%s+$", "")
  if trimmed == "" then
    return nil
  end

  local marker = trimmed:upper():gsub("[%s_%-]", ""):gsub("[%[%]%(%)]+", "")
  if marker == "BLANKAUDIO" or marker == "NOSPEECH" or marker == "SILENCE" then
    return nil
  end

  local cleaned = trimmed
  local placeholderPatterns = {
    "%[%s*BLANK[_%- ]AUDIO%s*%]",
    "%(%s*BLANK[_%- ]AUDIO%s*%)",
    "%[%s*NO[_%- ]SPEECH%s*%]",
    "%(%s*NO[_%- ]SPEECH%s*%)",
    "%[%s*NOSPEECH%s*%]",
    "%(%s*NOSPEECH%s*%)",
    "%[%s*SILENCE%s*%]",
    "%(%s*SILENCE%s*%)",
  }

  for _, pattern in ipairs(placeholderPatterns) do
    cleaned = cleaned:gsub(pattern, " ")
  end

  local lines = {}
  for line in cleaned:gsub("\r\n", "\n"):gsub("\r", "\n"):gmatch("[^\n]+") do
    local normalizedLine = line
      :gsub("[ \t][ \t]+", " ")
      :gsub("^%s+", "")
      :gsub("%s+$", "")
      :gsub("%s+([,%.!%?;:])", "%1")

    if normalizedLine ~= "" then
      table.insert(lines, normalizedLine)
    end
  end

  cleaned = table.concat(lines, "\n")
  if cleaned == "" or not cleaned:match("[%w]") then
    return nil
  end

  return cleaned
end

local function rememberDictationPaste(sessionId, profile)
  lastDictationPaste = {
    sessionId = sessionId,
    profile = profile or "fast",
    pastedAt = hs.timer.secondsSinceEpoch(),
    bundleID = frontmostBundleID(),
  }
end

local function replacementTargetForLastPaste()
  if not lastDictationPaste then
    return nil
  end

  local now = hs.timer.secondsSinceEpoch()
  if (now - lastDictationPaste.pastedAt) > replacementWindowSeconds then
    return nil
  end

  local currentBundleID = frontmostBundleID()
  if lastDictationPaste.bundleID and currentBundleID and lastDictationPaste.bundleID ~= currentBundleID then
    return nil
  end

  return {
    originalSessionId = lastDictationPaste.sessionId,
    originalProfile = lastDictationPaste.profile,
    pastedAt = lastDictationPaste.pastedAt,
    bundleID = lastDictationPaste.bundleID,
    requestedAt = now,
  }
end

local function canReplaceLastPaste(target)
  if not target then
    return false
  end

  local currentBundleID = frontmostBundleID()
  if target.bundleID and currentBundleID and target.bundleID ~= currentBundleID then
    return false
  end

  return true
end

local function pasteTranscript(text, profile, sessionId, replacementTarget)
  text = normalizeTranscript(text)
  if not text then
    alert("No Output")
    return
  end

  local function pasteNow()
    hs.pasteboard.setContents(text)
    hs.eventtap.keyStroke({"cmd"}, "v", 0)
    rememberDictationPaste(sessionId, profile)
    local label = transcriptReadyLabel(profile)
    alert(pendingCount > 0 and string.format("%s (%d)", label, pendingCount) or label)
  end

  if canReplaceLastPaste(replacementTarget) then
    hs.eventtap.keyStroke({"cmd"}, "z", 0)
    hs.timer.doAfter(replacementPasteDelaySeconds, pasteNow)
  else
    pasteNow()
  end
end

local function maybeWarnAboutStatus(status)
  if not status then
    return
  end

  local message = status.lowDiskSpaceMessage
  if not message and status.engineReady == false then
    message = status.engineHealthMessage or "Audio Input Not Ready"
  end
  if not message then
    return
  end

  local now = hs.timer.secondsSinceEpoch()
  if (now - lastHealthWarningAt) < 300 then
    return
  end

  lastHealthWarningAt = now
  alert(message)
end

local function runControl(command, args, callback)
  if type(args) == "function" then
    callback = args
    args = {}
  end

  if not controlBin or not hs.fs.attributes(controlBin) then
    callback(nil, "Control binary not installed")
    return
  end

  local taskArgs = {command}
  for _, arg in ipairs(args or {}) do
    table.insert(taskArgs, arg)
  end

  local task = nil
  task = hs.task.new(controlBin, function(exitCode, stdout, stderr)
    activeTasks[tostring(task)] = nil

    if stderr and stderr ~= "" then
      hs.printf("dictation ctl stderr: %s", stderr)
    end

    local response = nil
    if stdout and stdout ~= "" then
      response = hs.json.decode(stdout)
    end

    if not response then
      callback(nil, "Invalid control response")
      return
    end

    if exitCode ~= 0 and (not response.ok) then
      callback(response, response.error or "Control command failed")
      return
    end

    callback(response, nil)
  end, taskArgs)

  if not task then
    callback(nil, "Failed to launch control binary")
    return
  end

  activeTasks[tostring(task)] = task
  task:start()
end

local function stopResultPolling()
  if resultPoller then
    resultPoller:stop()
    resultPoller = nil
  end
end

local function enqueuePendingSession(sessionId, profile)
  if sessionId and sessionId ~= "" then
    table.insert(pendingSessionIds, {sessionId = sessionId, profile = profile or "fast"})
  end
end

local function removePendingSession(sessionId)
  if not sessionId or sessionId == "" then
    return nil
  end

  for index, pending in ipairs(pendingSessionIds) do
    if pending.sessionId == sessionId then
      table.remove(pendingSessionIds, index)
      return pending.profile
    end
  end

  return nil
end

local function pollForResults()
  runControl("next-result", function(response, err)
    if err or not response then
      if err then
        hs.printf("dictation poll error: %s", err)
      end
      return
    end

    pendingCount = response.pendingCount or pendingCount

    if response.resultAvailable and response.result then
      local result = response.result
      local resultProfile = nil
      if result.metrics then
        resultProfile = result.metrics.transcriptionProfile
      end
      resultProfile = resultProfile or removePendingSession(result.sessionId) or "fast"
      local replacementTarget = replacementTargets[result.sessionId]
      replacementTargets[result.sessionId] = nil

      if result.text and result.text ~= "" then
        if result.salvagePath and result.salvagePath ~= "" then
          hs.printf("dictation salvage: %s", result.salvagePath)
        end
        pasteTranscript(result.text, resultProfile, result.sessionId, replacementTarget)
      elseif result.errorMessage and result.errorMessage ~= "" then
        alert(result.errorMessage)
        hs.printf("dictation error: %s", result.errorMessage)
        if result.salvagePath and result.salvagePath ~= "" then
          hs.printf("dictation salvage: %s", result.salvagePath)
        end
      elseif result.salvagePath then
        alert("Transcription Failed")
        hs.printf("dictation salvage: %s", result.salvagePath)
      else
        alert("No Output")
      end
    end

    if pendingCount <= 0 then
      stopResultPolling()
    end
  end)
end

local function ensureResultPolling()
  if resultPoller then
    return
  end

  resultPoller = hs.timer.doEvery(0.15, pollForResults)
end

local function warmupDaemon()
  runControl("warmup", function(_, err)
    if err then
      hs.printf("dictation warmup skipped: %s", err)
    end
  end)
end

local function restoreState()
  runControl("status", function(response, err)
    if err or not response or not response.status then
      return
    end

    pendingCount = response.pendingCount or 0
    if response.status.recording then
      recordState = "recording"
      recordProfile = response.status.recordingProfile or "fast"
      showRecordingOverlay(recordProfile)
    else
      recordState = "idle"
      recordProfile = "fast"
      hideRecordingOverlay()
    end

    maybeWarnAboutStatus(response.status)

    if pendingCount > 0 then
      ensureResultPolling()
    end
  end)
end

local function watchDaemonStatus()
  if recordState == "starting" or recordState == "stopping" then
    return
  end

  runControl("status", function(response, err)
    if err or not response or not response.status then
      return
    end

    pendingCount = response.pendingCount or response.status.pendingCount or pendingCount or 0
    if response.status.recording then
      local observedProfile = response.status.recordingProfile or recordProfile or "fast"
      if recordState ~= "recording" or recordProfile ~= observedProfile or not recordingOverlay then
        showRecordingOverlay(observedProfile)
      end
      recordState = "recording"
      recordProfile = observedProfile
    elseif recordState == "recording" then
      recordState = "idle"
      recordProfile = "fast"
      hideRecordingOverlay()
    end

    maybeWarnAboutStatus(response.status)

    if pendingCount > 0 then
      ensureResultPolling()
    end
  end)
end

local function startRecording(profile)
  profile = profile or "fast"
  if recordState == "recording" then
    alert(recordingLabel(recordProfile))
    return
  end

  if recordState == "starting" or recordState == "stopping" then
    return
  end

  recordState = "starting"
  recordProfile = profile
  alert(isRobustProfile(profile) and "Starting Robust" or "Starting")

  local command = isRobustProfile(profile) and "start-robust" or "start"
  runControl(command, function(response, err)
    if err or not response or not response.ok then
      recordState = "idle"
      recordProfile = "fast"
      hideRecordingOverlay()
      alert(err or response.error or "Start failed")
      return
    end

    recordState = "recording"
    recordProfile = profile
    showRecordingOverlay(profile)
    maybeWarnAboutStatus(response.status)
    alert(recordingLabel(profile))
  end)
end

local function stopRecording(discard)
  if recordState ~= "recording" then
    alert("No Session")
    return
  end

  recordState = "stopping"
  local stoppedProfile = recordProfile
  hideRecordingOverlay()

  runControl(discard and "cancel" or "stop", function(response, err)
    recordState = "idle"
    recordProfile = "fast"
    if err or not response or not response.ok then
      alert(err or response.error or "Stop failed")
      return
    end

    pendingCount = response.pendingCount or pendingCount
    if discard then
      alert(isRobustProfile(stoppedProfile) and "Robust Recording Canceled" or "Recording Canceled")
      return
    end

    enqueuePendingSession(response.sessionId, stoppedProfile)
    maybeWarnAboutStatus(response.status)
    ensureResultPolling()
    alert(string.format("%s (%d)", processingLabel(stoppedProfile), pendingCount))
  end)
end

local function retryRobustTranscription()
  if recordState == "recording" then
    alert("Stop Recording First")
    return
  end

  if recordState == "starting" or recordState == "stopping" then
    return
  end

  local replacementTarget = replacementTargetForLastPaste()
  alert(replacementTarget and "Retrying, Will Replace" or "Retrying Last Audio")
  runControl("retry-robust", function(response, err)
    if err or not response or not response.ok then
      alert(err or response.error or "Retry failed")
      return
    end

    pendingCount = response.pendingCount or pendingCount
    enqueuePendingSession(response.sessionId, "robust")
    if response.sessionId and replacementTarget then
      replacementTargets[response.sessionId] = replacementTarget
    end
    maybeWarnAboutStatus(response.status)
    ensureResultPolling()
    alert(string.format("Retranscribing Audio (%d)", pendingCount))
  end)
end

config, err = loadConfig()
if config then
  controlBin = config.controlBinaryPath
  hs.timer.doAfter(0.05, warmupDaemon)
  hs.timer.doAfter(0.15, restoreState)
  statusWatchdog = hs.timer.doEvery(2.0, watchDaemonStatus)
  alert("Dictation Ready")
else
  alert(err or "Dictation config missing")
end

hs.hotkey.bind({"cmd"}, ".", function()
  if recordState == "recording" then
    stopRecording(false)
  else
    startRecording("fast")
  end
end)

hs.hotkey.bind({"cmd"}, ";", function()
  retryRobustTranscription()
end)

hs.hotkey.bind({"cmd"}, ",", function()
  stopRecording(true)
end)
