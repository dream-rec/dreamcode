// Per-application audio capture helper for macOS 13+.
// Stable Chrome on 14.4+: positive Core Audio process taps; other targets: ScreenCaptureKit.
//
//   audio-tap list                  → JSON array of running apps (NSWorkspace on 14.4+)
//   audio-tap capture <bundleId>    → raw 32-bit float PCM of that app's audio on stdout
//
// Status/errors go to stderr as one JSON object per line:
//   {"event":"format","sampleRate":16000,"channels":1}
//   {"event":"error","message":"..."}
// The helper exits when stdin reaches EOF, so it never outlives the parent process.
//
// Build (universal): see scripts/build-audio-tap.sh

import AppKit
import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

let stderr = FileHandle.standardError
let stdout = FileHandle.standardOutput
private let eventLock = NSLock()

func emit(_ object: [String: Any]) {
  guard var data = try? JSONSerialization.data(withJSONObject: object) else { return }
  data.append(0x0A)
  eventLock.lock()
  defer { eventLock.unlock() }
  stderr.write(data)
}

func fail(_ message: String) -> Never {
  emit(["event": "error", "message": message])
  exit(1)
}

func emitStartupError(_ error: Error) -> Never {
  let message = error.localizedDescription
  if message.localizedCaseInsensitiveContains("not permitted") ||
    message.localizedCaseInsensitiveContains("permission") {
    fail("无法启动音频采集：请在「系统设置 → 隐私与安全性 → 屏幕与系统音频录制」中允许 DreamCode Audio Capture，然后重试")
  }
  fail("启动音频采集失败：\(message)")
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

func loadContent(onScreenWindowsOnly: Bool = true) async -> SCShareableContent {
  await withDeadline(20, {
    do {
      return try await SCShareableContent.excludingDesktopWindows(
        false, onScreenWindowsOnly: onScreenWindowsOnly)
    } catch {
      fail("无法读取可共享内容（请在「系统设置 → 隐私与安全性 → 屏幕与系统音频录制」中允许 DreamCode Audio Capture）：\(error.localizedDescription)")
    }
  }, onTimeout: {
    fail("读取屏幕内容超时：请在「系统设置 → 隐私与安全性 → 屏幕与系统音频录制」中允许 DreamCode Audio Capture，然后重试")
  })
}

func listApps() async {
  if #available(macOS 14.4, *) {
    // Do not touch ScreenCaptureKit for modern enumeration: windows/displays and playback
    // have no bearing on whether a running application can be selected.
    var seen = Set<String>()
    let apps: [[String: Any]] = NSWorkspace.shared.runningApplications.compactMap { app in
      guard !app.isTerminated, app.activationPolicy != .prohibited,
            let id = app.bundleIdentifier, !id.isEmpty, !seen.contains(id) else { return nil }
      seen.insert(id)
      return ["id": id, "name": app.localizedName ?? id, "pid": Int(app.processIdentifier)]
    }
    writeAppList(apps)
  }
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
  writeAppList(apps)
}

func writeAppList(_ apps: [[String: Any]]) -> Never {
  guard var data = try? JSONSerialization.data(withJSONObject: apps) else { exit(1) }
  data.append(0x0A)
  stdout.write(data)
  exit(0)
}

final class AudioOutput: NSObject, SCStreamOutput {
  private var announcedRate = 0
  private var announcedChannels = 0

  /// The reader interprets raw samples using the most recent format line, so the format must reach
  /// it before any sample does.
  func announce(sampleRate: Int, channels: Int) {
    announcedRate = sampleRate
    announcedChannels = channels
    emit(["event": "format", "sampleRate": sampleRate, "channels": channels])
  }

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

    // ScreenCaptureKit can hand back a different format than requested; correct the reader once.
    let rate = Int(asbd.mSampleRate.rounded())
    if rate != announcedRate || channels != announcedChannels {
      announce(sampleRate: rate, channels: channels)
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

}

final class CaptureSession: NSObject, SCStreamDelegate {
  private let output = AudioOutput()
  private var stream: SCStream?

  func start(bundleId: String) async {
    var content = await loadContent()
    var application = content.applications.first(where: { $0.bundleIdentifier == bundleId })
    if application == nil {
      // A minimized or otherwise off-screen app never shows up in the on-screen listing, but it is
      // exactly the kind of app a user wants captured in the background.
      content = await loadContent(onScreenWindowsOnly: false)
      application = content.applications.first(where: { $0.bundleIdentifier == bundleId })
    }
    guard let app = application else {
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

    let stream = SCStream(filter: filter, configuration: config, delegate: self)
    do {
      try stream.addStreamOutput(output, type: .audio, sampleHandlerQueue: DispatchQueue(label: "audio-tap.audio"))
      try await stream.startCapture()
    } catch {
      emitStartupError(error)
    }
    self.stream = stream
    output.announce(sampleRate: config.sampleRate, channels: config.channelCount)
    emit(["event": "started"])
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    fail("音频采集已停止：\(error.localizedDescription)")
  }
}

func waitForInputClose() {
  while true {
    let chunk = FileHandle.standardInput.availableData
    if chunk.isEmpty { exit(0) }
  }
}

// 诊断：列出 HAL 认定的音频进程对象及其正在使用的设备。
// 用于回答“某个应用在出声，但为什么它的音频没进 tap”：能看到进程对象是否存在、是否在输出、接到哪个设备。
// 只读元数据，不建立 tap、不输出音频。
func dumpProcessObjects(bundleId: String?) {
  guard #available(macOS 14.4, *) else { fail("procs 需要 macOS 14.4+") }
  var admitted: Set<Int32> = []
  if bundleId == ChromeTarget.bundleID, let target = try? ChromeTarget.resolve(),
     let members = try? target.members() {
    admitted = Set(members.values.map { $0.pid })
  }
  let processes = (try? audioProcesses()) ?? []
  for object in processes.sorted() {
    guard let pid: Int32 = try? audioValue(object, kAudioProcessPropertyPID, initial: Int32(0)) else { continue }
    let bundle = (try? audioString(object, kAudioProcessPropertyBundleID)) ?? ""
    let running: UInt32 = (try? audioValue(object, kAudioProcessPropertyIsRunning, initial: UInt32(0))) ?? 0
    let output: UInt32 = (try? audioValue(object, kAudioProcessPropertyIsRunningOutput, initial: UInt32(0))) ?? 0
    let input: UInt32 = (try? audioValue(object, kAudioProcessPropertyIsRunningInput, initial: UInt32(0))) ?? 0
    emit(["event": "process", "object": Int(object), "pid": Int(pid), "bundle": bundle,
          "executable": ProcessIdentity.read(pid)?.executable ?? "", "running": running,
          "runningOutput": output, "runningInput": input, "devices": processDevices(object),
          "admitted": admitted.contains(pid)])
  }
}

// 诊断：对指定（默认全部）HAL 进程对象建立一次私有 tap，只统计每秒峰值/非零帧，
// 不输出、不保存、不转发任何音频。用途：在采集盲区里逐组试 tap，定位到底哪个对象承载目标应用的音频。
@available(macOS 14.4, *)
func probeObjects(objects: [AudioObjectID], seconds: Double, deviceUID: String? = nil) {
  do {
    let members = objects.isEmpty ? try audioProcesses() : objects
    guard !members.isEmpty else { fail("没有可探测的音频进程对象") }
    let uuid = UUID()
    var tap = AudioObjectID(0)
    var aggregate = AudioObjectID(0)
    var ioProc: AudioDeviceIOProcID?
    var ring: OpaquePointer?
    defer {
      if let ioProc, aggregate != 0 { _ = AudioDeviceStop(aggregate, ioProc) }
      if let ioProc, aggregate != 0 { _ = AudioDeviceDestroyIOProcID(aggregate, ioProc) }
      if let ring { dc_ring_destroy(ring) }
      if aggregate != 0 { _ = AudioHardwareDestroyAggregateDevice(aggregate) }
      if tap != 0 { _ = AudioHardwareDestroyProcessTap(tap) }
    }
    let description = try chromeTapDescription(members, uuid: uuid)
    if let deviceUID { description.deviceUID = deviceUID }
    try checkAudio(AudioHardwareCreateProcessTap(description, &tap), "创建诊断 tap")
    let format = try audioValue(tap, kAudioTapPropertyFormat, initial: AudioStreamBasicDescription())
    emit(["event": "probe-start", "objects": members.map { Int($0) }, "format": describeFormat(format),
          "deviceUID": deviceUID ?? ""])
    let specification = chromeAggregateDescription(tapUUID: uuid)
    try checkAudio(AudioHardwareCreateAggregateDevice(specification as CFDictionary, &aggregate), "创建诊断聚合设备")
    let converter = try TapPCMConverter(asbd: format)
    let buffers = UnsafeMutableAudioBufferListPointer(converter.input.mutableAudioBufferList)
    guard let first = buffers.first,
          let createdRing = dc_ring_create(UInt32(buffers.count), first.mNumberChannels,
                                           format.mBytesPerFrame, TapPCMConverter.capacity, 32) else {
      throw NativeAudioError(message: "无法分配诊断缓冲区")
    }
    ring = createdRing
    emit(["event": "probe-ring", "buffers": buffers.count, "channels": first.mNumberChannels,
          "bytesPerFrame": format.mBytesPerFrame, "capacity": TapPCMConverter.capacity])
    try checkAudio(dc_create_io(aggregate, createdRing, &ioProc), "创建诊断 IOProc")
    guard let startedIO = ioProc else { throw NativeAudioError(message: "诊断 IOProc 缺失") }
    dc_ring_enable(createdRing, true)
    try checkAudio(AudioDeviceStart(aggregate, startedIO), "启动诊断 IO")
    let work = DispatchQueue(label: "audio-tap.probe")
    var ticks = 0
    var totalPeak: Float = 0
    var totalNonzero: UInt64 = 0
    var totalFrames: UInt64 = 0
    var windowPeak: Float = 0
    var windowNonzero: UInt64 = 0
    var windowFrames: UInt64 = 0
    var windowPops: UInt64 = 0
    var windowPopFrames: UInt64 = 0
    var windowConversionErrors: UInt64 = 0
    let lock = NSLock()
    // 与产品路径一致：10ms 拉取一次，避免环形缓冲在 1 秒粒度里被填满。
    let pump = DispatchSource.makeTimerSource(queue: work)
    pump.schedule(deadline: .now(), repeating: .milliseconds(10))
    pump.setEventHandler {
      lock.lock()
      defer { lock.unlock() }
      var popped = 0
      while popped < 32 {
        let count = dc_ring_pop(createdRing, converter.input.mutableAudioBufferList, TapPCMConverter.capacity)
        if count == 0 { break }
        popped += 1
        windowPops += 1
        windowPopFrames += UInt64(count)
        // 走产品路径的同一个转换器读数据（16 kHz 单声道 Float32），避免直接解释 ABL 的歧义。
        do {
          try converter.convert(frames: count) { bytes, size in
            let samples = bytes.assumingMemoryBound(to: Float.self)
            let sampleCount = Int(size) / MemoryLayout<Float>.size
            var audible = false
            for index in 0..<sampleCount {
              let value = abs(samples[index])
              if value > windowPeak { windowPeak = value }
              if value > 1e-4 { audible = true }
            }
            if audible { windowNonzero += UInt64(sampleCount) }
            windowFrames += UInt64(sampleCount)
          }
        } catch {
          windowConversionErrors += 1
        }
      }
    }
    pump.resume()
    let timer = DispatchSource.makeTimerSource(queue: work)
    timer.schedule(deadline: .now() + 1, repeating: 1)
    timer.setEventHandler {
      lock.lock()
      defer { lock.unlock() }
      ticks += 1
      let peak = windowPeak, nonzero = windowNonzero, frames = windowFrames
      let pops = windowPops, popFrames = windowPopFrames
      let errors = windowConversionErrors
      windowPeak = 0
      windowNonzero = 0
      windowFrames = 0
      windowPops = 0
      windowPopFrames = 0
      windowConversionErrors = 0
      totalPeak = max(totalPeak, peak)
      totalNonzero += nonzero
      totalFrames += frames
      var io: UInt64 = 0, accepted: UInt64 = 0, dropped: UInt64 = 0, rejected: UInt64 = 0
      dc_ring_stats(createdRing, &io, &accepted, &dropped, &rejected)
      let active = ((try? audioProcesses()) ?? []).compactMap { object -> [String: Any]? in
        let output: UInt32 = (try? audioValue(object, kAudioProcessPropertyIsRunningOutput, initial: UInt32(0))) ?? 0
        let input: UInt32 = (try? audioValue(object, kAudioProcessPropertyIsRunningInput, initial: UInt32(0))) ?? 0
        guard output != 0 || input != 0 else { return nil }
        let pid: Int32 = (try? audioValue(object, kAudioProcessPropertyPID, initial: Int32(0))) ?? 0
        return ["object": Int(object), "pid": Int(pid), "output": output, "input": input,
                "executable": ProcessIdentity.read(pid)?.executable ?? "",
                "devices": processDevices(object),
                "bundle": (try? audioString(object, kAudioProcessPropertyBundleID)) ?? ""]
      }
      emit(["event": "probe-tick", "second": ticks, "peak": peak, "nonzeroFrames": nonzero,
            "frames": frames, "pops": pops, "popFrames": popFrames, "convertErrors": errors,
            "ioCallbacks": io, "accepted": accepted, "dropped": dropped,
            "rejected": rejected, "active": active])
    }
    timer.resume()
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
      Thread.sleep(forTimeInterval: 0.2)
    }
    timer.cancel()
    pump.cancel()
    lock.lock()
    let peak = totalPeak, nonzero = totalNonzero, frames = totalFrames
    lock.unlock()
    emit(["event": "probe-summary", "seconds": seconds, "peak": peak,
          "nonzeroFrames": nonzero, "frames": frames])
    exit(0)
  } catch {
    fail("诊断探测失败：\(error.localizedDescription)")
  }
}

// 诊断：列出 HAL 设备（名称/UID/采样率/是否默认输出/是否聚合），
// 用于观察麦克风激活后应用是否把输出改到了别的（例如语音处理）设备。
func dumpAudioDevices() {
  let system = AudioObjectID(kAudioObjectSystemObject)
  var address = audioAddress(kAudioHardwarePropertyDevices)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr, size > 0 else {
    fail("无法读取音频设备列表")
  }
  let count = Int(size) / MemoryLayout<AudioObjectID>.size
  var ids = [AudioObjectID](repeating: 0, count: count)
  guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &ids) == noErr else {
    fail("无法读取音频设备")
  }
  let defaultOutput: AudioObjectID = (try? audioValue(system, kAudioHardwarePropertyDefaultOutputDevice,
                                                      initial: AudioObjectID(0))) ?? 0
  let list = ids.map { device -> [String: Any] in
    var info: [String: Any] = ["object": Int(device), "defaultOutput": device == defaultOutput]
    if let name: CFString = try? audioValue(device, kAudioObjectPropertyName, initial: Optional<CFString>.none) {
      info["name"] = name as String
    }
    if let uid: CFString = try? audioValue(device, kAudioDevicePropertyDeviceUID, initial: Optional<CFString>.none) {
      info["uid"] = uid as String
    }
    if let rate: Double = try? audioValue(device, kAudioDevicePropertyNominalSampleRate, initial: Double(0)) {
      info["rate"] = rate
    }
    if let alive: UInt32 = try? audioValue(device, kAudioDevicePropertyDeviceIsAlive, initial: UInt32(0)) {
      info["alive"] = alive
    }
    if let running: UInt32 = try? audioValue(device, kAudioDevicePropertyDeviceIsRunning, initial: UInt32(0)) {
      info["running"] = running
    }
    if let anywhere: UInt32 = try? audioValue(device, kAudioDevicePropertyDeviceIsRunningSomewhere,
                                             initial: UInt32(0)) {
      info["runningSomewhere"] = anywhere
    }
    return info
  }
  emit(["event": "devices", "count": list.count, "defaultOutput": Int(defaultOutput), "devices": list])
}

// 诊断：读出一个进程对象正在使用的设备（kAudioProcessPropertyDevices 是 AudioObjectID 数组，
// 必须用实际字节长度读，不能用固定大小的泛型读取）。
func processDevices(_ object: AudioObjectID) -> [[String: Any]] {
  for scope in [kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyScopeOutput] {
    var address = audioAddress(kAudioProcessPropertyDevices, scope: scope)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(object, &address, 0, nil, &size) == noErr, size > 0 else { continue }
    let count = Int(size) / MemoryLayout<AudioObjectID>.size
    var ids = [AudioObjectID](repeating: 0, count: count)
    guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &ids) == noErr else { continue }
    return ids.map { device -> [String: Any] in
      var info: [String: Any] = ["id": Int(device)]
      if let name: CFString = try? audioValue(device, kAudioObjectPropertyName, initial: Optional<CFString>.none) {
        info["name"] = name as String
      }
      if let uid: CFString = try? audioValue(device, kAudioDevicePropertyDeviceUID, initial: Optional<CFString>.none) {
        info["uid"] = uid as String
      }
      if let rate: Double = try? audioValue(device, kAudioDevicePropertyNominalSampleRate, initial: Double(0)) {
        info["rate"] = rate
      }
      return info
    }
  }
  return []
}

// Keep either backend alive after its startup task returns.
var activeSession: AnyObject?

@main
enum AudioTapMain {
  static func main() {
    let arguments = CommandLine.arguments
    Task {
      switch arguments.count > 1 ? arguments[1] : "" {
      case "list":
        await listApps()
      case "capture" where arguments.count > 2:
        if #available(macOS 14.4, *), arguments[2] == ChromeTarget.bundleID {
          // Deliberately bypass all SCK window/content enumeration for stable Chrome.
          let session = ChromeAudioSession()
          activeSession = session
          session.start()
        } else {
          let session = CaptureSession()
          activeSession = session
          DispatchQueue.global().async { waitForInputClose() }
          await session.start(bundleId: arguments[2])
        }
      case "capture-sck" where arguments.count > 2:
        // 诊断专用：强制走 SCK 后端，用于对比 CATap 盲区时同一应用的音频是否仍能被 SCK 采到。
        let session = CaptureSession()
        activeSession = session
        DispatchQueue.global().async { waitForInputClose() }
        await session.start(bundleId: arguments[2])
      case "procs":
        dumpProcessObjects(bundleId: arguments.count > 2 ? arguments[2] : nil)
        exit(0)
      case "devices":
        dumpAudioDevices()
        exit(0)
      case "probe" where audioDiagnosticsEnabled:
        // 诊断专用：需要显式打开 DREAMCODE_AUDIO_DIAG。
        var seconds = 20.0
        var objects: [AudioObjectID] = []
        var device: String?
        for argument in arguments.dropFirst(2) {
          if argument.hasPrefix("--seconds=") {
            seconds = Double(argument.dropFirst("--seconds=".count)) ?? seconds
          } else if argument.hasPrefix("--device=") {
            device = String(argument.dropFirst("--device=".count))
          } else if let value = UInt32(argument) {
            objects.append(AudioObjectID(value))
          }
        }
        if #available(macOS 14.4, *) {
          probeObjects(objects: objects, seconds: seconds, deviceUID: device)
        } else {
          fail("probe 需要 macOS 14.4+")
        }
      default:
        fail("usage: audio-tap list | audio-tap capture <bundleId> | audio-tap capture-sck <bundleId> | audio-tap procs [bundleId] | audio-tap devices | audio-tap probe [--seconds=N] [--device=UID] [objectId...]")
      }
    }
    dispatchMain()
  }
}
