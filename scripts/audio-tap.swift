// Per-application audio capture helper for macOS 13+ (ScreenCaptureKit).
//
//   audio-tap list                  → JSON array of apps that own an on-screen window
//   audio-tap capture <bundleId>    → raw 32-bit float PCM of that app's audio on stdout
//
// Status/errors go to stderr as one JSON object per line:
//   {"event":"format","sampleRate":16000,"channels":1}
//   {"event":"error","message":"..."}
// The helper exits when stdin reaches EOF, so it never outlives the parent process.
//
// Build (universal): see scripts/build-audio-tap.sh

import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

let stderr = FileHandle.standardError
let stdout = FileHandle.standardOutput

func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
  stderr.write(data)
  stderr.write("\n".data(using: .utf8)!)
}

func fail(_ message: String) -> Never {
  emit(["event": "error", "message": message])
  exit(1)
}

// Bounds a ScreenCaptureKit call: on timeout the process reports why and exits instead of
// hanging until the parent kills it (a killed helper surfaces only as "Command failed").
func withDeadline<T>(
  _ seconds: Double, _ operation: @escaping () async -> T, onTimeout: @escaping () -> Never
) async -> T {
  let timer = DispatchSource.makeTimerSource(queue: .global())
  timer.schedule(deadline: .now() + seconds)
  timer.setEventHandler { onTimeout() }
  timer.resume()
  let value = await operation()
  timer.cancel()
  return value
}

func loadContent() async -> SCShareableContent {
  await withDeadline(20, {
    do {
      return try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    } catch {
      fail("无法读取可共享内容（请在「系统设置 → 隐私与安全性 → 屏幕录制」中允许 DreamCode）：\(error.localizedDescription)")
    }
  }, onTimeout: {
    fail("读取屏幕内容超时：请在「系统设置 → 隐私与安全性 → 屏幕录制」中允许 DreamCode，并重新打开应用后重试")
  })
}

func listApps() async {
  let content = await loadContent()
  var seen = Set<String>()
  var apps: [[String: Any]] = []
  for window in content.windows {
    guard window.isOnScreen, window.windowLayer == 0, let app = window.owningApplication else {
      continue
    }
    let bundleId = app.bundleIdentifier
    if bundleId.isEmpty || seen.contains(bundleId) { continue }
    seen.insert(bundleId)
    apps.append([
      "id": bundleId,
      "name": app.applicationName.isEmpty ? bundleId : app.applicationName,
      "pid": Int(app.processID)
    ])
  }
  guard let data = try? JSONSerialization.data(withJSONObject: apps) else { exit(1) }
  stdout.write(data)
  stdout.write("\n".data(using: .utf8)!)
  exit(0)
}

final class AudioOutput: NSObject, SCStreamOutput, SCStreamDelegate {
  private var reportedFormat = false

  func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .audio, sampleBuffer.isValid else { return }
    guard let description = sampleBuffer.formatDescription,
      let asbdPointer = CMAudioFormatDescriptionGetStreamBasicDescription(description)
    else { return }
    let asbd = asbdPointer.pointee

    // We only ever request float PCM; anything else would be garbage on the other side.
    guard asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0, asbd.mBitsPerChannel == 32 else {
      fail("不支持的音频格式")
    }
    let channels = Int(asbd.mChannelsPerFrame)
    let interleaved = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved == 0

    if !reportedFormat {
      reportedFormat = true
      emit(["event": "format", "sampleRate": asbd.mSampleRate, "channels": channels])
    }

    var blockBuffer: CMBlockBuffer?
    var sizeNeeded = 0
    CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
      sampleBuffer, bufferListSizeNeededOut: &sizeNeeded, bufferListOut: nil, bufferListSize: 0,
      blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: nil)
    let rawList = UnsafeMutableRawPointer.allocate(
      byteCount: sizeNeeded, alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { rawList.deallocate() }
    let listPointer = rawList.bindMemory(to: AudioBufferList.self, capacity: 1)
    let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
      sampleBuffer, bufferListSizeNeededOut: nil, bufferListOut: listPointer,
      bufferListSize: sizeNeeded, blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
      flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
      blockBufferOut: &blockBuffer)
    guard status == noErr else { return }

    let buffers = UnsafeMutableAudioBufferListPointer(listPointer)
    if interleaved || buffers.count == 1 {
      // Already interleaved (or mono): forward as-is.
      guard let data = buffers[0].mData else { return }
      stdout.write(Data(bytes: data, count: Int(buffers[0].mDataByteSize)))
      return
    }

    // Planar multi-channel: interleave so the reader only deals with one layout.
    let frames = Int(buffers[0].mDataByteSize) / MemoryLayout<Float>.size
    var interleavedSamples = [Float](repeating: 0, count: frames * buffers.count)
    for (channel, buffer) in buffers.enumerated() {
      guard let data = buffer.mData else { continue }
      let samples = data.assumingMemoryBound(to: Float.self)
      for frame in 0..<frames {
        interleavedSamples[frame * buffers.count + channel] = samples[frame]
      }
    }
    interleavedSamples.withUnsafeBytes { stdout.write(Data($0)) }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    fail("音频采集已停止：\(error.localizedDescription)")
  }
}

let output = AudioOutput()
var activeStream: SCStream?

func capture(bundleId: String) async {
  // A capture session ends when the parent closes our stdin (normal stop, or the parent died).
  // Only capture watches stdin: `list` is a one-shot query that must finish even if the
  // caller never opens its stdin pipe.
  DispatchQueue.global().async {
    while true {
      let chunk = FileHandle.standardInput.availableData
      if chunk.isEmpty { exit(0) }
    }
  }

  let content = await loadContent()
  guard let app = content.applications.first(where: { $0.bundleIdentifier == bundleId }) else {
    fail("找不到正在运行的应用：\(bundleId)")
  }
  guard let display = content.displays.first else { fail("找不到显示器") }

  // Audio follows the filter: only apps included here are captured.
  let filter = SCContentFilter(display: display, including: [app], exceptingWindows: [])
  let config = SCStreamConfiguration()
  config.capturesAudio = true
  config.sampleRate = 16000
  config.channelCount = 1
  config.excludesCurrentProcessAudio = true
  // Video is mandatory for SCStream; keep it as cheap as possible.
  config.width = 2
  config.height = 2
  config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
  config.queueDepth = 3

  let stream = SCStream(filter: filter, configuration: config, delegate: output)
  do {
    try stream.addStreamOutput(output, type: .audio, sampleHandlerQueue: DispatchQueue(label: "audio-tap.audio"))
    try await stream.startCapture()
  } catch {
    fail("启动音频采集失败：\(error.localizedDescription)")
  }
  activeStream = stream
  emit(["event": "started"])
}

let arguments = CommandLine.arguments
Task {
  switch arguments.count > 1 ? arguments[1] : "" {
  case "list":
    await listApps()
  case "capture" where arguments.count > 2:
    await capture(bundleId: arguments[2])
  default:
    fail("usage: audio-tap list | audio-tap capture <bundleId>")
  }
}

dispatchMain()
