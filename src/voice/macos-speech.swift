import AVFoundation
import Foundation
import Speech

struct SpeechEvent: Encodable {
  let type: String
  let text: String?
  let is_final: Bool?
  let message: String?
}

func emit(_ event: SpeechEvent) {
  let encoder = JSONEncoder()
  guard let data = try? encoder.encode(event), let line = String(data: data, encoding: .utf8) else {
    return
  }
  print(line)
  fflush(stdout)
}

func fail(_ message: String) -> Never {
  emit(SpeechEvent(type: "error", text: nil, is_final: nil, message: message))
  exit(1)
}

func argValue(_ name: String, fallback: String) -> String {
  let args = CommandLine.arguments
  guard let index = args.firstIndex(of: name), index + 1 < args.count else {
    return fallback
  }
  return args[index + 1]
}

func requestSpeechAuthorization() {
  let semaphore = DispatchSemaphore(value: 0)
  var status: SFSpeechRecognizerAuthorizationStatus = .notDetermined
  SFSpeechRecognizer.requestAuthorization { nextStatus in
    status = nextStatus
    semaphore.signal()
  }
  semaphore.wait()

  switch status {
  case .authorized:
    return
  case .denied:
    fail("macOS speech recognition permission was denied")
  case .restricted:
    fail("macOS speech recognition is restricted on this Mac")
  case .notDetermined:
    fail("macOS speech recognition permission was not granted")
  @unknown default:
    fail("macOS speech recognition authorization failed")
  }
}

func requestMicrophoneAuthorization() {
  let semaphore = DispatchSemaphore(value: 0)
  var granted = false
  AVCaptureDevice.requestAccess(for: .audio) { ok in
    granted = ok
    semaphore.signal()
  }
  semaphore.wait()
  if !granted {
    fail("microphone permission was denied")
  }
}

let localeId = argValue("--lang", fallback: "zh-CN")
let recognitionMode = argValue("--mode", fallback: "auto")
guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId)) else {
  fail("macOS speech recognizer is unavailable for locale \(localeId)")
}

if !recognizer.isAvailable {
  fail("macOS speech recognizer is currently unavailable")
}

requestSpeechAuthorization()
requestMicrophoneAuthorization()

let audioEngine = AVAudioEngine()
let request = SFSpeechAudioBufferRecognitionRequest()
request.shouldReportPartialResults = true
request.taskHint = .dictation
request.contextualStrings = [
  "API", "ASR", "TTS", "Mac", "macOS", "OpenAI", "DeepSeek", "MiniMax",
  "Claude", "Gemini", "ChatGPT", "GPT", "Agent", "Bailongma", "Longma",
  "GitHub", "Electron", "JavaScript", "TypeScript", "Python", "Swift",
  "WebSocket", "HTTP", "localhost", "prompt", "token", "model",
]

if #available(macOS 10.15, *) {
  // 仅当用户显式要求离线(local/on-device)时才尝试 on-device 识别。
  // supportsOnDeviceRecognition 仅表示 API 支持，不代表离线 asset 已下载——
  // 盲信它会在 "支持但未下载中文离线包" 的系统上静默无结果（No Assistant asset for language zh-CN）。
  // auto（默认）与 online 一律走在线识别，立即可用、不依赖系统离线包下载。
  if recognitionMode == "local" || recognitionMode == "on-device" {
    if recognizer.supportsOnDeviceRecognition {
      request.requiresOnDeviceRecognition = true
    } else {
      fail("on-device speech recognition is not available for locale \(localeId)")
    }
  } else {
    request.requiresOnDeviceRecognition = false
  }
}

let inputNode = audioEngine.inputNode
let format = inputNode.outputFormat(forBus: 0)

var lastFinalText = ""
let task = recognizer.recognitionTask(with: request) { result, error in
  if let result = result {
    let text = result.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
    if !text.isEmpty && text != lastFinalText {
      emit(SpeechEvent(type: "transcript", text: text, is_final: result.isFinal, message: nil))
      if result.isFinal {
        lastFinalText = text
      }
    }
  }

  if let error = error {
    emit(SpeechEvent(type: "error", text: nil, is_final: nil, message: error.localizedDescription))
    audioEngine.stop()
    inputNode.removeTap(onBus: 0)
    exit(1)
  }
}

inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
  request.append(buffer)
}

do {
  audioEngine.prepare()
  try audioEngine.start()
} catch {
  task.cancel()
  fail("failed to start microphone capture: \(error.localizedDescription)")
}

let modeLabel: String
if #available(macOS 10.15, *) {
  modeLabel = request.requiresOnDeviceRecognition ? "on-device" : "system"
} else {
  modeLabel = "system"
}
emit(SpeechEvent(type: "ready", text: nil, is_final: nil, message: "macOS \(modeLabel) speech recognition ready"))

RunLoop.main.run()
