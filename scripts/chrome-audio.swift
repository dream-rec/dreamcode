// Stable Chrome only. Never construct an empty, global, or exclusion-derived tap.
import AppKit
import AVFoundation
import CoreAudio
import CoreMedia
import Foundation
import ScreenCaptureKit

struct NativeAudioError: LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

func checkAudio(_ status: OSStatus, _ operation: String) throws {
  guard status == noErr else {
    throw NativeAudioError(message: "\(operation)失败（Core Audio OSStatus \(status)）。如系统提示需要授权，请在「隐私与安全性 → 屏幕与系统音频录制」中允许音频采集；不会扩大采集范围。")
  }
}

func audioAddress(_ selector: AudioObjectPropertySelector,
                  scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}

func audioValue<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, initial: T) throws -> T {
  var address = audioAddress(selector)
  var value = initial
  var size = UInt32(MemoryLayout<T>.size)
  try withUnsafeMutablePointer(to: &value) {
    try checkAudio(AudioObjectGetPropertyData(object, &address, 0, nil, &size, $0), "读取音频属性")
  }
  guard size == MemoryLayout<T>.size else { throw NativeAudioError(message: "音频属性长度不符") }
  return value
}

func audioString(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) throws -> String {
  let string: CFString? = try audioValue(object, selector, initial: Optional<CFString>.none)
  guard let string else { throw NativeAudioError(message: "音频对象身份缺失") }
  return string as String
}

// 采集链路诊断默认关闭，只有 DREAMCODE_AUDIO_DIAG=1 时才把事实写进 stderr：
// 成员/设备/格式/图更新结果与 IO 计数，用于现场区分「没选中成员 / 没有回调 / 全丢弃 / 全零」。
// 只输出元数据与计数，不输出任何音频内容，也不改变采集行为。
let audioDiagnosticsEnabled = ProcessInfo.processInfo.environment["DREAMCODE_AUDIO_DIAG"] == "1"

func diagnostic(_ fields: [String: Any]) {
  guard audioDiagnosticsEnabled else { return }
  var payload = fields
  payload["event"] = "diagnostic"
  emit(payload)
}

func describeMembers(_ members: [AudioObjectID: ProcessIdentity]) -> [[String: Any]] {
  members.sorted { $0.key < $1.key }.map { object, identity in
    ["object": Int(object), "pid": Int(identity.pid),
     "executable": (identity.executable as NSString).lastPathComponent]
  }
}

func describeDevice(_ device: AudioObjectID) -> [String: Any] {
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

func describeFormat(_ format: AudioStreamBasicDescription) -> [String: Any] {
  ["sampleRate": format.mSampleRate, "channels": Int(format.mChannelsPerFrame),
   "bytesPerFrame": Int(format.mBytesPerFrame), "bytesPerPacket": Int(format.mBytesPerPacket),
   "framesPerPacket": Int(format.mFramesPerPacket), "flags": Int(format.mFormatFlags),
   "bitsPerChannel": Int(format.mBitsPerChannel)]
}

func audioProcesses() throws -> [AudioObjectID] {
  var address = audioAddress(kAudioHardwarePropertyProcessObjectList)
  let system = AudioObjectID(kAudioObjectSystemObject)
  // A helper may appear between the size query and the read. Retry only this bounded snapshot
  // race, never create a wider tap or schedule silence-driven capture retries.
  for _ in 0..<3 {
    var size: UInt32 = 0
    try checkAudio(AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size), "读取音频进程列表长度")
    guard size % UInt32(MemoryLayout<AudioObjectID>.size) == 0, size <= 1_048_576 else {
      throw NativeAudioError(message: "音频进程列表长度无效")
    }
    if size == 0 { return [] }
    var objects = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    let status = try objects.withUnsafeMutableBytes { bytes -> OSStatus in
      guard let pointer = bytes.baseAddress else { throw NativeAudioError(message: "音频进程缓冲区为空") }
      return AudioObjectGetPropertyData(system, &address, 0, nil, &size, pointer)
    }
    if status == kAudioHardwareBadPropertySizeError { continue }
    try checkAudio(status, "读取音频进程列表")
    guard Int(size) <= objects.count * MemoryLayout<AudioObjectID>.size,
          size % UInt32(MemoryLayout<AudioObjectID>.size) == 0 else {
      throw NativeAudioError(message: "音频进程列表快照无效")
    }
    return Array(objects.prefix(Int(size) / MemoryLayout<AudioObjectID>.size))
  }
  throw NativeAudioError(message: "音频进程列表持续变化，已停止本次采集，请稍后重试")
}

func canonicalPath(_ path: String) -> String {
  URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path
}

struct ProcessIdentity: Equatable {
  let pid: Int32
  let parentPID: Int32
  let startSeconds: UInt64
  let startMicroseconds: UInt64
  let executable: String

  static func read(_ pid: Int32) -> ProcessIdentity? {
    var raw = DCProcessIdentity()
    guard dc_process_identity(pid, &raw) else { return nil }
    let path = withUnsafePointer(to: &raw.executable) {
      $0.withMemoryRebound(to: CChar.self, capacity: 4096) { String(cString: $0) }
    }
    return ProcessIdentity(pid: pid, parentPID: raw.parent_pid, startSeconds: raw.start_seconds,
                           startMicroseconds: raw.start_microseconds, executable: canonicalPath(path))
  }
}

struct ChromeApplicationIdentity {
  let root: ProcessIdentity
  let bundlePath: String
  let bundleID: String
  let executable: String
}

struct ChromeTarget {
  static let bundleID = "com.google.Chrome"
  // Exact bundle identities, not executable names (Chrome also ships Helper (Aperitif), etc.).
  static let helperIDs: Set<String> = ["com.google.Chrome.helper", "com.google.Chrome.helper.renderer",
                                      "com.google.Chrome.helper.plugin", "com.google.Chrome.helper.alerts"]
  let roots: [ProcessIdentity]
  let bundlePath: String

  static func resolve() throws -> ChromeTarget {
    let apps = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).filter { !$0.isTerminated }
    let identities = try apps.map { app -> ChromeApplicationIdentity in
      guard let bundleURL = app.bundleURL, let executableURL = app.executableURL,
            let root = ProcessIdentity.read(app.processIdentifier),
            canonicalPath(executableURL.path) == root.executable else {
        throw NativeAudioError(message: "无法验证所选 Chrome 的运行身份，已拒绝采集")
      }
      let path = canonicalPath(bundleURL.path)
      guard let bundle = Bundle(path: path), let id = bundle.bundleIdentifier,
            let executable = bundle.executableURL else {
        throw NativeAudioError(message: "无法验证所选 Chrome 的安装身份，已拒绝采集")
      }
      return ChromeApplicationIdentity(root: root, bundlePath: path, bundleID: id,
                                       executable: canonicalPath(executable.path))
    }
    return try resolve(identities)
  }

  // Several --user-data-dir instances can share one installation. Keep every verified root's
  // PID/start identity; never select an arbitrary instance or admit another installation.
  static func resolve(_ applications: [ChromeApplicationIdentity]) throws -> ChromeTarget {
    guard let first = applications.first,
          Set(applications.map { $0.bundlePath }).count == 1 else {
      throw NativeAudioError(message: "找不到唯一的稳定版 Chrome 安装，请只保留同一安装目录的 Chrome 运行后重试")
    }
    guard applications.allSatisfy({
      $0.bundleID == bundleID && $0.executable == $0.root.executable &&
        $0.root.executable.hasPrefix(first.bundlePath + "/Contents/")
    }), Set(applications.map { $0.root.pid }).count == applications.count else {
      throw NativeAudioError(message: "无法验证所选 Chrome 的安装身份，已拒绝采集")
    }
    return ChromeTarget(roots: applications.map { $0.root }, bundlePath: first.bundlePath)
  }

  func isAlive(process: (Int32) -> ProcessIdentity?) -> Bool {
    roots.contains { process($0.pid) == $0 }
  }

  // Kept independent of HAL/NSWorkspace so no-device tests exercise the real admission policy.
  func trusts(_ candidate: ProcessIdentity, halBundleID: String,
              bundleIdentity: (String) -> (id: String, executable: String)?,
              process: (Int32) -> ProcessIdentity?) -> Bool {
    guard candidate.executable.hasPrefix(bundlePath + "/Contents/") else { return false }
    if let root = roots.first(where: { $0.pid == candidate.pid }) {
      return candidate == root && process(root.pid) == root && halBundleID == Self.bundleID
    }
    guard Self.helperIDs.contains(halBundleID) else { return false }
    var url = URL(fileURLWithPath: candidate.executable).deletingLastPathComponent()
    while url.path != bundlePath && url.path != "/" && url.pathExtension != "app" {
      url.deleteLastPathComponent()
    }
    guard url.path != bundlePath, let bundle = bundleIdentity(url.path), bundle.id == halBundleID,
          bundle.executable == candidate.executable else { return false }
    var parent = candidate.parentPID
    var visited: Set<Int32> = [candidate.pid]
    for _ in 0..<64 {
      guard !visited.contains(parent), let identity = process(parent) else { return false }
      if let root = roots.first(where: { $0.pid == identity.pid }) {
        return identity == root && process(candidate.pid) == candidate
      }
      // Do not trust an unrelated intermediary merely because it eventually descends from Chrome.
      guard identity.executable.hasPrefix(bundlePath + "/Contents/") else { return false }
      visited.insert(parent)
      parent = identity.parentPID
    }
    return false
  }

  func members() throws -> [AudioObjectID: ProcessIdentity] {
    guard isAlive(process: ProcessIdentity.read) else { throw NativeAudioError(message: "被监听的 Chrome 已退出") }
    var members: [AudioObjectID: ProcessIdentity] = [:]
    for object in try audioProcesses() {
      // Process-list entries can disappear while being read; an unverifiable entry is never admitted.
      guard let pid: Int32 = try? audioValue(object, kAudioProcessPropertyPID, initial: Int32(0)),
            let identity = ProcessIdentity.read(pid),
            let bundle = try? audioString(object, kAudioProcessPropertyBundleID) else { continue }
      let trusted = trusts(identity, halBundleID: bundle, bundleIdentity: { path in
        guard let bundle = Bundle(path: path), let id = bundle.bundleIdentifier,
              let executable = bundle.executableURL else { return nil }
        return (id, canonicalPath(executable.path))
      }, process: ProcessIdentity.read)
      guard trusted, ProcessIdentity.read(pid) == identity,
            (try? audioValue(object, kAudioProcessPropertyPID, initial: Int32(0))) == pid else { continue }
      members[object] = identity
    }
    return members
  }
}

final class AudioGate {
  let pointer: OpaquePointer
  init() throws {
    guard let pointer = dc_gate_create() else { throw NativeAudioError(message: "无法分配音频会话状态") }
    self.pointer = pointer
  }
  var isOpen: Bool { dc_gate_is_open(pointer) }
  func close() { dc_gate_close(pointer) }
  deinit { dc_gate_destroy(pointer) }
}

final class AudioPropertyObservation {
  let object: AudioObjectID
  var address: AudioObjectPropertyAddress
  let queue: DispatchQueue
  let listener: AudioObjectPropertyListenerBlock
  private var isRemoved = false

  init(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector,
       queue: DispatchQueue, changed: @escaping () -> Void) throws {
    self.object = object
    self.address = audioAddress(selector)
    self.queue = queue
    self.listener = { _, _ in changed() }
    try checkAudio(AudioObjectAddPropertyListenerBlock(object, &address, queue, listener), "监听音频变化")
  }
  func remove() throws {
    guard !isRemoved else { return }
    try checkAudio(AudioObjectRemovePropertyListenerBlock(object, &address, queue, listener), "移除音频监听")
    isRemoved = true
  }
}

// The same ordered/idempotent cleanup is used by the real graph and native tests. A failed stop
// must not free a buffer/IOProc still used by HAL. The caller reports the error and exits instead.
final class AudioResources {
  var stopIO: (() throws -> Void)?
  var destroyIO: (() throws -> Void)?
  var destroyAggregate: (() throws -> Void)?
  var destroyTap: (() throws -> Void)?
  func stop() throws { if let stopIO { try stopIO(); self.stopIO = nil } }
  func close() throws {
    try stop()
    if let destroyIO { try destroyIO(); self.destroyIO = nil }
    if let destroyAggregate { try destroyAggregate(); self.destroyAggregate = nil }
    if let destroyTap { try destroyTap(); self.destroyTap = nil }
  }
}

// Only this serial queue may start/stop/destroy a graph. Discovery, SIGTERM and EOF never wait
// on AudioDeviceStart. Cancellation gates output immediately, but destruction waits for start.
final class AudioGraphExecutor {
  private let queue = DispatchQueue(label: "audio-tap.graph")
  func perform(_ work: @escaping () -> Void) { queue.async(execute: DispatchWorkItem(block: work)) }
}

final class TapPCMConverter {
  static let capacity: AVAudioFrameCount = 8192
  let input: AVAudioPCMBuffer
  private let output: AVAudioPCMBuffer
  private let converter: AVAudioConverter

  init(asbd: AudioStreamBasicDescription) throws {
    var description = asbd
    guard asbd.mFormatID == kAudioFormatLinearPCM, asbd.mSampleRate >= 8000, asbd.mSampleRate <= 192000,
          (1...2).contains(asbd.mChannelsPerFrame), asbd.mBytesPerFrame > 0,
          let format = AVAudioFormat(streamDescription: &description),
          let destination = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000,
                                          channels: 1, interleaved: true),
          let converter = AVAudioConverter(from: format, to: destination),
          let input = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: Self.capacity),
          let output = AVAudioPCMBuffer(pcmFormat: destination, frameCapacity: Self.capacity * 2) else {
      throw NativeAudioError(message: "Chrome 音频格式无法安全转换为 16 kHz 单声道")
    }
    self.input = input
    self.output = output
    self.converter = converter
    converter.downmix = true
    converter.sampleRateConverterQuality = AVAudioQuality.high.rawValue
  }

  func reset() { converter.reset() }

  func convert(frames: AVAudioFrameCount, write: (UnsafeRawPointer, UInt32) throws -> Void) throws {
    input.frameLength = frames
    var supplied = false
    // Stateful conversion: provide each packet exactly once; retain resampling state between packets.
    for _ in 0..<8 {
      var error: NSError?
      let status = converter.convert(to: output, error: &error) { _, state in
        if supplied { state.pointee = .noDataNow; return nil }
        supplied = true
        state.pointee = .haveData
        return self.input
      }
      if status == .error { throw error ?? NativeAudioError(message: "音频重采样失败") as NSError }
      let buffer = output.audioBufferList.pointee.mBuffers
      if output.frameLength > 0, let bytes = buffer.mData {
        try write(UnsafeRawPointer(bytes), output.frameLength * UInt32(MemoryLayout<Float>.size))
      }
      if status == .inputRanDry || status == .endOfStream { return }
    }
    throw NativeAudioError(message: "音频转换器未消费有界输入")
  }
}

@available(macOS 14.4, *)
func chromeTapDescription(_ members: [AudioObjectID], uuid: UUID) throws -> CATapDescription {
  guard !members.isEmpty else { throw NativeAudioError(message: "不能建立空的 Chrome 进程 tap") }
  let description = CATapDescription(stereoMixdownOfProcesses: members)
  description.uuid = uuid
  description.name = "DreamCode Chrome only"
  description.isPrivate = true
  description.isExclusive = false
  description.muteBehavior = .unmuted
  return description
}

func chromeAggregateDescription(tapUUID: UUID) -> [String: Any] {
  // Tap-only: no physical subdevice input streams. The sole tap is the clock, with no second
  // clock to drift-compensate. Never wait for first playback in the ready handshake.
  [kAudioAggregateDeviceNameKey: "DreamCode Chrome Audio",
   kAudioAggregateDeviceUIDKey: UUID().uuidString,
   kAudioAggregateDeviceIsPrivateKey: true,
   kAudioAggregateDeviceTapAutoStartKey: false,
   kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: tapUUID.uuidString,
                                     kAudioSubTapDriftCompensationKey: false]]]
}

@available(macOS 14.4, *)
final class ChromeTapGraph {
  let resources = AudioResources()
  private var tap: AudioObjectID = 0
  private var aggregate: AudioObjectID = 0
  private var ioProc: AudioDeviceIOProcID?
  private let tapUUID = UUID()
  private var format = AudioStreamBasicDescription()
  private var ring: OpaquePointer?
  private var converter: TapPCMConverter?
  private let worker = DispatchQueue(label: "audio-tap.pcm")
  private var timer: DispatchSourceTimer?
  private var statsTimer: DispatchSourceTimer?
  private var statsFrames: UInt64 = 0
  private var statsNonzeroFrames: UInt64 = 0
  private var statsPeak: Float = 0
  // 采集盲区监控：成员进程声称在输出、而 tap 连续只有全零时，这是可判定的事实而非静音猜测。
  private var lastAudible = Date()
  private var watchTimer: DispatchSourceTimer?
  private let onBlind: ([AudioObjectID]) -> Void
  private var observations: [AudioPropertyObservation] = []
  private var gate: AudioGate
  private let changed: () -> Void
  private let failed: (Error) -> Void
  private var droppedOutput: Int64 = 0
  let outputDevice: AudioObjectID
  private let memberObjects: [AudioObjectID]

  init(members: [AudioObjectID], outputDevice: AudioObjectID, gate: AudioGate,
       changed: @escaping () -> Void, blind: @escaping ([AudioObjectID]) -> Void,
       failed: @escaping (Error) -> Void) throws {
    guard !members.isEmpty else { throw NativeAudioError(message: "不能建立空的 Chrome 进程 tap") }
    self.gate = gate
    self.outputDevice = outputDevice
    self.memberObjects = members
    self.changed = changed
    self.onBlind = blind
    self.failed = failed
    do {
      let description = try chromeTapDescription(members, uuid: tapUUID)
      try checkAudio(AudioHardwareCreateProcessTap(description, &tap), "创建 Chrome 正向音频 tap")
      let tapID = tap
      resources.destroyTap = { try checkAudio(AudioHardwareDestroyProcessTap(tapID), "销毁音频 tap") }
      format = try audioValue(tap, kAudioTapPropertyFormat, initial: AudioStreamBasicDescription())
      diagnostic(["stage": "tap", "members": members.map { Int($0) }, "format": describeFormat(format)])
      let specification = chromeAggregateDescription(tapUUID: tapUUID)
      try checkAudio(AudioHardwareCreateAggregateDevice(specification as CFDictionary, &aggregate), "创建私有音频聚合设备")
      let aggregateID = aggregate
      resources.destroyAggregate = { try checkAudio(AudioHardwareDestroyAggregateDevice(aggregateID), "销毁音频聚合设备") }
      diagnostic(["stage": "aggregate", "aggregate": Int(aggregate),
                  "outputDevice": Int(outputDevice), "device": describeDevice(outputDevice)])
      try preparePCM()
      observations.append(try AudioPropertyObservation(tap, kAudioTapPropertyFormat, queue: worker, changed: changed))
      observations.append(try AudioPropertyObservation(outputDevice, kAudioDevicePropertyDeviceIsAlive, queue: worker, changed: changed))
      observations.append(try AudioPropertyObservation(outputDevice, kAudioDevicePropertyNominalSampleRate, queue: worker, changed: changed))
    } catch {
      try close()
      throw error
    }
  }

  private func preparePCM() throws {
    let converter = try TapPCMConverter(asbd: format)
    let buffers = UnsafeMutableAudioBufferListPointer(converter.input.mutableAudioBufferList)
    guard let first = buffers.first,
          let ring = dc_ring_create(UInt32(buffers.count), first.mNumberChannels, format.mBytesPerFrame,
                                    TapPCMConverter.capacity, 32) else {
      throw NativeAudioError(message: "无法分配有界音频缓冲区")
    }
    self.converter = converter
    self.ring = ring
    try checkAudio(dc_create_io(aggregate, ring, &ioProc), "创建音频 IOProc")
    guard let ioProc else { throw NativeAudioError(message: "音频 IOProc 缺失") }
    let aggregateID = aggregate
    resources.destroyIO = { try checkAudio(AudioDeviceDestroyIOProcID(aggregateID, ioProc), "销毁音频 IOProc") }
  }

  func start() throws {
    diagnostic(["stage": "io-start", "gateOpen": gate.isOpen, "hasIOProc": ioProc != nil,
                "hasRing": ring != nil, "members": memberObjects.map { Int($0) }])
    guard gate.isOpen, let ioProc, let ring else { return }
    dc_ring_enable(ring, true)
    let aggregateID = aggregate
    // Register stop *before* the potentially blocking start. Both execute on AudioGraphExecutor.
    resources.stopIO = { try checkAudio(AudioDeviceStop(aggregateID, ioProc), "停止音频 IO") }
    try checkAudio(AudioDeviceStart(aggregate, ioProc), "启动 Chrome 音频 IO")
    diagnostic(["stage": "io-started", "aggregate": Int(aggregate)])
    guard gate.isOpen else { dc_ring_enable(ring, false); return }
    let timer = DispatchSource.makeTimerSource(queue: worker)
    timer.schedule(deadline: .now(), repeating: .milliseconds(10))
    timer.setEventHandler { [weak self] in self?.drain() }
    self.timer = timer
    timer.resume()
    if audioDiagnosticsEnabled {
      let stats = DispatchSource.makeTimerSource(queue: worker)
      stats.schedule(deadline: .now() + 1, repeating: 1)
      stats.setEventHandler { [weak self] in self?.reportStats() }
      stats.resume()
      self.statsTimer = stats
    }
    // 盲区监控始终开启（不受诊断开关影响），它决定了是否需要用同一名单重建一次采集图。
    let watch = DispatchSource.makeTimerSource(queue: worker)
    watch.schedule(deadline: .now() + 1, repeating: 1)
    watch.setEventHandler { [weak self] in self?.checkBlind() }
    watch.resume()
    self.watchTimer = watch
  }

  // 只在“成员确实在输出”的前提下把连续全零当作证据；正常静音不会触发。
  private func checkBlind() {
    guard gate.isOpen, let ring else { return }
    var io: UInt64 = 0
    var accepted: UInt64 = 0
    var dropped: UInt64 = 0
    var rejected: UInt64 = 0
    dc_ring_stats(ring, &io, &accepted, &dropped, &rejected)
    guard accepted > 0 else { return }
    let silent = Date().timeIntervalSince(lastAudible)
    guard silent >= 2 else { return }
    let outputObjects = memberObjects.filter {
      ((try? audioValue($0, kAudioProcessPropertyIsRunningOutput, initial: UInt32(0))) ?? 0) != 0
    }
    guard !outputObjects.isEmpty else { return }
    onBlind(outputObjects)
  }

  private func reportStats() {
    guard let ring else { return }
    var io: UInt64 = 0
    var accepted: UInt64 = 0
    var dropped: UInt64 = 0
    var rejected: UInt64 = 0
    dc_ring_stats(ring, &io, &accepted, &dropped, &rejected)
    var running: UInt32 = 0
    var address = audioAddress(kAudioDevicePropertyDeviceIsRunning)
    var size = UInt32(MemoryLayout<UInt32>.size)
    _ = AudioObjectGetPropertyData(aggregate, &address, 0, nil, &size, &running)
    // 每个成员的“在出声”状态：tap 收到全零、但成员声称正在输出时，这是可判定的事实而不是静音猜测。
    let members = memberObjects.map { object -> [String: Any] in
      ["object": Int(object),
       "running": (try? audioValue(object, kAudioProcessPropertyIsRunning, initial: UInt32(0))) ?? 0,
       "output": (try? audioValue(object, kAudioProcessPropertyIsRunningOutput, initial: UInt32(0))) ?? 0,
       "input": (try? audioValue(object, kAudioProcessPropertyIsRunningInput, initial: UInt32(0))) ?? 0]
    }
    let defaultDevice: AudioObjectID = (try? audioValue(AudioObjectID(kAudioObjectSystemObject),
                                                       kAudioHardwarePropertyDefaultOutputDevice,
                                                       initial: AudioObjectID(0))) ?? 0
    diagnostic(["stage": "stats", "ioCallbacks": io, "accepted": accepted, "dropped": dropped,
                "rejected": rejected, "frames": statsFrames, "nonzeroFrames": statsNonzeroFrames,
                "peak": statsPeak, "running": running, "gateOpen": gate.isOpen,
                "members": members, "defaultDevice": defaultDevice == 0 ? 0 : Int(defaultDevice)])
  }

  private func drain() {
    guard gate.isOpen, let ring, let converter else { return }
    do {
      for _ in 0..<32 {
        guard gate.isOpen else { return }
        let frames = dc_ring_pop(ring, converter.input.mutableAudioBufferList, TapPCMConverter.capacity)
        if frames == 0 { return }
        noteFrames(frames: frames)
        try converter.convert(frames: frames) { bytes, count in
          guard self.gate.isOpen else { return }
          let dropped = dc_write_pcm(bytes, count)
          guard dropped >= 0 else { throw NativeAudioError(message: "音频输出管道已关闭或无法保持 Float32 对齐") }
          self.droppedOutput += dropped
        }
      }
    } catch {
      gate.close()
      failed(error)
    }
  }

  // 统计与“最后有声时刻”只在工作队列上按已弹出帧计算：实时 IO 回调只碰原子计数。
  private func noteFrames(frames _: AVAudioFrameCount) {
    guard let converter else { return }
    var peak = statsPeak
    var nonzero = statsNonzeroFrames
    var total: UInt64 = 0
    var audible = false
    let buffers = UnsafeMutableAudioBufferListPointer(converter.input.mutableAudioBufferList)
    for buffer in buffers {
      guard let data = buffer.mData else { continue }
      let samples = data.assumingMemoryBound(to: Float.self)
      let channels = max(1, Int(buffer.mNumberChannels))
      let frameCount = Int(buffer.mDataByteSize) / MemoryLayout<Float>.size / channels
      for frame in 0..<frameCount {
        var audibleFrame = false
        for channel in 0..<channels {
          let value = abs(samples[frame * channels + channel])
          if value > peak { peak = value }
          if value > 1e-4 { audibleFrame = true }
        }
        if audibleFrame { nonzero += 1; audible = true }
      }
      total += UInt64(frameCount)
    }
    statsPeak = peak
    statsNonzeroFrames = nonzero
    statsFrames += total
    if audible { lastAudible = Date() }
  }

  private func pause() throws {
    if let ring { dc_ring_enable(ring, false) }
    timer?.cancel()
    timer = nil
    statsTimer?.cancel()
    statsTimer = nil
    watchTimer?.cancel()
    watchTimer = nil
    try resources.stop()
    worker.sync {} // No in-flight conversion/write when replacing format, gate or buffers.
  }

  // A writable live description can be reused only if its actual format remains identical.
  // Otherwise the caller destroys this graph and rebuilds the same positive target set.
  func update(members: [AudioObjectID], gate: AudioGate) throws -> Bool {
    guard !members.isEmpty else { return false }
    diagnostic(["stage": "tap-update-begin", "members": members.map { Int($0) }])
    try pause()
    var address = audioAddress(kAudioTapPropertyDescription)
    var writable: DarwinBoolean = false
    guard AudioObjectIsPropertySettable(tap, &address, &writable) == noErr, writable.boolValue else { return false }
    var updated = try chromeTapDescription(members, uuid: tapUUID)
    let status = withUnsafePointer(to: &updated) {
      AudioObjectSetPropertyData(tap, &address, 0, nil, UInt32(MemoryLayout<CATapDescription>.size), $0)
    }
    guard status == noErr else { return false }
    let current = try audioValue(tap, kAudioTapPropertyFormat, initial: AudioStreamBasicDescription())
    guard sameAudioFormat(format, current) else { return false }
    // Discard the old generation's queued samples before allowing any new output.
    if let ring, let converter {
      while dc_ring_pop(ring, converter.input.mutableAudioBufferList, TapPCMConverter.capacity) > 0 {}
      converter.reset()
    }
    self.gate = gate
    try start()
    diagnostic(["stage": "tap-update", "result": "applied", "members": members.map { Int($0) }])
    return true
  }

  func formatChanged() throws -> Bool {
    !sameAudioFormat(format, try audioValue(tap, kAudioTapPropertyFormat, initial: AudioStreamBasicDescription()))
  }

  func close() throws {
    gate.close()
    try pause()
    diagnostic(["stage": "graph-closed", "frames": statsFrames, "peak": statsPeak])
    for observation in observations { try observation.remove() }
    observations.removeAll()
    try resources.close()
    if let ring {
      let dropped = dc_ring_dropped(ring)
      if dropped > 0 || droppedOutput > 0 {
        emit(["event": "diagnostic", "droppedPackets": dropped, "droppedOutputSamples": droppedOutput])
      }
      dc_ring_destroy(ring)
      self.ring = nil
    }
    converter = nil
  }
}

func sameAudioFormat(_ left: AudioStreamBasicDescription, _ right: AudioStreamBasicDescription) -> Bool {
  left.mSampleRate == right.mSampleRate && left.mFormatID == right.mFormatID &&
    left.mFormatFlags == right.mFormatFlags && left.mBytesPerPacket == right.mBytesPerPacket &&
    left.mFramesPerPacket == right.mFramesPerPacket && left.mBytesPerFrame == right.mBytesPerFrame &&
    left.mChannelsPerFrame == right.mChannelsPerFrame && left.mBitsPerChannel == right.mBitsPerChannel
}

// 盲区分派策略（纯逻辑，可无设备单测）：
// - 任一准入成员在使用麦克风输入 ⇒ VoiceProcessing 双工盲区 ⇒ 一次性系统声音回退；
// - 否则按陈旧图处理，同一名单有界重建（单次会话 ≤5 次、间隔 ≥15 秒）。
struct ChromeBlindPolicy {
  enum Action: Equatable {
    case none
    case rebuild(attempt: Int)
    case systemFallback
  }
  static let maximumRebuilds = 5
  static let minimumInterval: TimeInterval = 15
  private var attempts = 0
  private var lastAttemptAt = Date.distantPast

  mutating func decide(duplex: Bool, now: Date) -> Action {
    if duplex { return .systemFallback }
    guard attempts < Self.maximumRebuilds,
          now.timeIntervalSince(lastAttemptAt) >= Self.minimumInterval else { return .none }
    attempts += 1
    lastAttemptAt = now
    return .rebuild(attempt: attempts)
  }
}

// VPIO 双工盲区的回退后端：用 ScreenCaptureKit 采集整个系统输出（产品「全部系统声音」的
// 原生等价物）。只在会话判定为双工盲区后启动一次，PCM 约定与 tap 路径相同（16 kHz 单声道
// Float32、stdout 非阻塞写、格式变化先发 format 事件）。自包含实现：不引用 audio-tap.swift
// 的符号，保证原生无设备测试可单独编译本文件。
final class SystemAudioFallback: NSObject, SCStreamOutput, SCStreamDelegate {
  private let queue = DispatchQueue(label: "audio-tap.fallback")
  private let gate: AudioGate
  private let failed: (Error) -> Void
  private var stream: SCStream?
  private var announcedRate = 16000
  private var announcedChannels = 1

  init(gate: AudioGate, failed: @escaping (Error) -> Void) {
    self.gate = gate
    self.failed = failed
  }

  // 有界加载共享内容：SCK 回调缺失时按失败处理，绝不静默挂起。
  static func loadContent(completion: @escaping (Result<SCShareableContent, Error>) -> Void) {
    let state = DispatchQueue(label: "audio-tap.fallback-load")
    var settled = false
    let settle: (Result<SCShareableContent, Error>) -> Void = { result in
      var first = false
      state.sync { first = !settled; settled = true }
      if first { completion(result) }
    }
    Task {
      do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        settle(.success(content))
      } catch {
        settle(.failure(error))
      }
    }
    state.asyncAfter(deadline: .now() + 20) {
      settle(.failure(NativeAudioError(message: "读取系统音频内容超时（请检查屏幕与系统音频录制权限）")))
    }
  }

  func start(display: SCDisplay, completion: @escaping (Error?) -> Void) {
    // 不添加应用过滤：双工盲区下按应用归属不可见，只有系统级采集能继续收到目标声音。
    let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
    let configuration = SCStreamConfiguration()
    configuration.capturesAudio = true
    configuration.sampleRate = 16000
    configuration.channelCount = 1
    configuration.excludesCurrentProcessAudio = true
    configuration.width = 2
    configuration.height = 2
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
    configuration.queueDepth = 3
    let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
    do {
      try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
    } catch {
      completion(error)
      return
    }
    self.stream = stream
    stream.startCapture { error in completion(error) }
  }

  // 幂等停止：先关 gate（不再写出），再请求 SCK 停止；重复调用安全。
  func stop() {
    gate.close()
    stream?.stopCapture { _ in }
    stream = nil
  }

  private func fail(_ error: Error) {
    guard gate.isOpen else { return }
    gate.close()
    failed(error)
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
              of type: SCStreamOutputType) {
    guard gate.isOpen, type == .audio, sampleBuffer.isValid else { return }
    guard let description = sampleBuffer.formatDescription,
      let asbdPointer = CMAudioFormatDescriptionGetStreamBasicDescription(description) else { return }
    let asbd = asbdPointer.pointee
    guard asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0, asbd.mBitsPerChannel == 32 else {
      fail(NativeAudioError(message: "系统声音回退收到不支持的音频格式"))
      return
    }
    let channels = Int(asbd.mChannelsPerFrame)
    let interleaved = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved == 0
    // 实际格式与请求（16 kHz 单声道）不同时，先纠正读取端再写样本。
    let rate = Int(asbd.mSampleRate.rounded())
    if rate != announcedRate || channels != announcedChannels {
      announcedRate = rate
      announcedChannels = channels
      emit(["event": "format", "sampleRate": rate, "channels": channels])
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
      guard let first = buffers.first, let data = first.mData else { return }
      write(UnsafeRawPointer(data), Int(first.mDataByteSize))
      return
    }
    let frames = Int(buffers[0].mDataByteSize) / MemoryLayout<Float>.size
    var interleavedSamples = [Float](repeating: 0, count: frames * buffers.count)
    for (channel, buffer) in buffers.enumerated() {
      guard let data = buffer.mData else { continue }
      let samples = data.assumingMemoryBound(to: Float.self)
      for frame in 0..<frames {
        interleavedSamples[frame * buffers.count + channel] = samples[frame]
      }
    }
    interleavedSamples.withUnsafeBytes { bytes in
      if let base = bytes.baseAddress { write(base, bytes.count) }
    }
  }

  private func write(_ bytes: UnsafeRawPointer, _ size: Int) {
    let dropped = dc_write_pcm(bytes, UInt32(size))
    if dropped < 0 {
      fail(NativeAudioError(message: "音频输出管道已关闭或无法保持 Float32 对齐"))
    }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    fail(error)
  }
}

struct ChromeMembershipState {
  private(set) var members: [AudioObjectID: ProcessIdentity]?
  private(set) var outputDevice: AudioObjectID = 0
  private(set) var outputRate: Double = 0

  // Nil means unchanged, including long periods of silence/empty membership. No timed retries.
  mutating func update(_ members: [AudioObjectID: ProcessIdentity], device: AudioObjectID,
                       rate: Double) -> (deviceChanged: Bool, shouldWait: Bool)? {
    let deviceChanged = self.members == nil || outputDevice != device || outputRate != rate
    guard self.members != members || deviceChanged else { return nil }
    self.members = members
    outputDevice = device
    outputRate = rate
    return (deviceChanged, members.isEmpty || device == 0)
  }
  mutating func invalidate() { members = nil }
}

@available(macOS 14.4, *)
final class ChromeAudioSession {
  private let control = DispatchQueue(label: "audio-tap.discovery")
  private let executor = AudioGraphExecutor()
  private var target: ChromeTarget?
  private var observations: [AudioPropertyObservation] = []
  private var processTimer: DispatchSourceTimer?
  private var inputSource: DispatchSourceRead?
  private var signalSource: DispatchSourceSignal?
  private var isStopping = false
  private var currentGate: AudioGate?
  private var membership = ChromeMembershipState()
  // Accessed only on executor; never destroy a graph concurrently with AudioDeviceStart.
  private var graph: ChromeTapGraph?
  // 盲区分派：普通盲区（陈旧图）沿用同一名单有界重建；成员正在使用麦克风的盲区是
  // VoiceProcessing 双工状态（重建已实测无效），一次性切换系统声音回退。
  private var blindPolicy = ChromeBlindPolicy()
  // 回退状态只在 control 队列访问；启动后保持到会话结束（双工状态持续到 Chrome 重启）。
  private var fallbackEngaged = false
  private var fallback: SystemAudioFallback?

  func start() {
    control.async {
      do {
        self.armCancellation()
        self.target = try ChromeTarget.resolve()
        diagnostic(["stage": "target", "bundlePath": self.target?.bundlePath ?? "",
                    "roots": (self.target?.roots ?? []).map {
                      ["pid": Int($0.pid), "executable": ($0.executable as NSString).lastPathComponent]
                    }])
        guard dc_prepare_stdout() == 0 else { throw NativeAudioError(message: "无法配置非阻塞音频输出") }
        let system = AudioObjectID(kAudioObjectSystemObject)
        // Subscribe before initial reconciliation, so a just-launched audio service cannot be missed.
        self.observations.append(try AudioPropertyObservation(system, kAudioHardwarePropertyProcessObjectList,
                                                              queue: self.control) { [weak self] in self?.reconcile() })
        self.observations.append(try AudioPropertyObservation(system, kAudioHardwarePropertyDefaultOutputDevice,
                                                              queue: self.control) { [weak self] in self?.reconcile(force: true) })
        let timer = DispatchSource.makeTimerSource(queue: self.control)
        timer.schedule(deadline: .now() + 1, repeating: 1)
        timer.setEventHandler { [weak self] in self?.reconcile() }
        self.processTimer = timer
        timer.resume()
        emit(["event": "format", "sampleRate": 16000, "channels": 1])
        emit(["event": "started", "backend": "core-audio-process-tap", "waiting": true])
        self.reconcile()
      } catch { self.stop(error: error) }
    }
  }

  private func armCancellation() {
    // Main closes stdin AND sends SIGTERM. Handle both on the same queue and retire just once.
    signal(SIGTERM, SIG_IGN)
    signal(SIGPIPE, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: control)
    source.setEventHandler { [weak self] in self?.stop() }
    source.resume()
    signalSource = source
    let input = DispatchSource.makeReadSource(fileDescriptor: STDIN_FILENO, queue: control)
    input.setEventHandler { [weak self] in
      var bytes = [UInt8](repeating: 0, count: 64)
      let count = read(STDIN_FILENO, &bytes, bytes.count)
      if count == 0 { self?.stop() }
      else if count < 0 && errno != EINTR && errno != EAGAIN { self?.stop(error: NativeAudioError(message: "音频控制管道读取失败")) }
    }
    input.resume()
    inputSource = input
  }

  private func reconcile(force: Bool = false) {
    guard !isStopping, let target else { return }
    if fallbackEngaged {
      // 回退模式不再维护 tap 图；只保留目标存活监督，全部根退出即结束会话。
      if !target.isAlive(process: ProcessIdentity.read) {
        stop(error: NativeAudioError(message: "被监听的 Chrome 已退出"))
      }
      return
    }
    do {
      let members = try target.members()
      let device: AudioObjectID = try audioValue(AudioObjectID(kAudioObjectSystemObject),
                                                kAudioHardwarePropertyDefaultOutputDevice, initial: AudioObjectID(0))
      let alive: UInt32 = device == 0 ? 0 : (try audioValue(device, kAudioDevicePropertyDeviceIsAlive, initial: UInt32(0)))
      let outputDevice = alive == 0 ? 0 : device
      let outputRate: Double = outputDevice == 0 ? 0 :
        (try audioValue(outputDevice, kAudioDevicePropertyNominalSampleRate, initial: Double(0)))
      guard let transition = membership.update(members, device: outputDevice, rate: outputRate) else {
        // Some HAL implementations notify even when the format is unchanged. Do not rebuild in
        // response to our own description update, and never treat silence as a recovery trigger.
        if force, let gate = currentGate {
          executor.perform { [self] in
            guard gate.isOpen else { return }
            do {
              if try graph?.formatChanged() == true {
                diagnostic(["stage": "format-changed"])
                control.async { self.membership.invalidate(); self.reconcile() }
              }
            } catch { control.async { self.stop(error: error) } }
          }
        }
        return
      }
      diagnostic(["stage": "membership", "members": describeMembers(members),
                  "device": describeDevice(outputDevice), "deviceChanged": transition.deviceChanged,
                  "shouldWait": transition.shouldWait])
      currentGate?.close()
      let gate = try AudioGate()
      currentGate = gate
      executor.perform { [self] in
        guard gate.isOpen else { return }
        do {
          // Revalidate at execution time as a previous start may have waited for playback.
          guard target.isAlive(process: ProcessIdentity.read) else {
            throw NativeAudioError(message: "被监听的 Chrome 已退出")
          }
          let freshMembers = try target.members()
          diagnostic(["stage": "revalidate", "same": freshMembers == members,
                      "fresh": describeMembers(freshMembers)])
          guard freshMembers == members else {
            control.async { self.membership.invalidate(); self.reconcile() }
            return
          }
          guard !transition.shouldWait else {
            try graph?.close()
            graph = nil
            return
          }
          let ids = members.keys.sorted()
          if let existing = graph, !transition.deviceChanged, existing.outputDevice == outputDevice,
             try !existing.formatChanged(), try existing.update(members: ids, gate: gate) { return }
          try graph?.close()
          graph = nil
          guard gate.isOpen else { return }
          diagnostic(["stage": "graph-create", "members": ids.map { Int($0) }])
          let created = try ChromeTapGraph(members: ids, outputDevice: outputDevice, gate: gate,
            changed: { [weak self] in self?.control.async { self?.reconcile(force: true) } },
            blind: { [weak self] output in self?.control.async { self?.recoverBlind(output) } },
            failed: { [weak self] error in self?.control.async { self?.stop(error: error) } })
          graph = created
          try created.start()
        } catch {
          control.async { self.stop(error: error) }
        }
      }
    } catch { stop(error: error) }
  }

  // 成员进程声称在输出，而 tap 连续只有全零。分派：
  // - 任一准入成员在使用麦克风输入 → VoiceProcessing 双工盲区：重建已实测无效，
  //   一次性切换系统声音回退（范围扩大由 UI 提示与证据门槛包住）。
  // - 否则视为陈旧图：记录完整 HAL 进程清单，用同一可信名单重建，有界（≤5 次、≥15 秒）。
  private func recoverBlind(_ outputObjects: [AudioObjectID]) {
    guard !isStopping, !fallbackEngaged else { return }
    switch blindPolicy.decide(duplex: memberObjectsUsingInput(outputObjects), now: Date()) {
    case .none:
      return
    case .systemFallback:
      diagnostic(["stage": "blind", "action": "system-fallback", "reason": "duplex-input",
                  "silentObjects": outputObjects.map { Int($0) }])
      engageSystemFallback()
    case .rebuild(let attempt):
      if attempt <= 3, audioDiagnosticsEnabled {
        diagnostic(["stage": "blind-hal", "objects": halProcessInventory()])
      }
      diagnostic(["stage": "blind", "action": "rebuild", "attempt": attempt,
                  "silentObjects": outputObjects.map { Int($0) }])
      membership.invalidate()
      reconcile()
    }
  }

  // 双工判定：任一准入成员对象报告 runningInput ≠ 0（进程对象能力，macOS 14+）。
  private func memberObjectsUsingInput(_ outputObjects: [AudioObjectID]) -> Bool {
    var objects = Set(outputObjects)
    if let members = membership.members { objects.formUnion(members.keys) }
    return objects.contains {
      ((try? audioValue($0, kAudioProcessPropertyIsRunningInput, initial: UInt32(0))) ?? 0) != 0
    }
  }

  // 停掉 tap 图后启动系统声音采集。切换是单向的：双工状态直到 Chrome 重启才解除，
  // 而 Chrome 退出本身就结束本会话，不存在会话内回切 tap 的路径。
  private func engageSystemFallback() {
    guard !isStopping, !fallbackEngaged else { return }
    fallbackEngaged = true
    emit(["event": "fallback", "mode": "system", "reason": "chrome-duplex"])
    currentGate?.close()
    executor.perform { [self] in
      do {
        try graph?.close()
      } catch {
        // gate 已关，不会再写出 tap 数据；释放失败只记录，不阻塞回退。
        diagnostic(["stage": "fallback", "problem": "tap-close: \(error.localizedDescription)"])
      }
      graph = nil
      control.async { self.startSystemFallback() }
    }
  }

  private func startSystemFallback() {
    guard !isStopping, fallbackEngaged, fallback == nil else { return }
    guard let gate = try? AudioGate() else {
      stop(error: NativeAudioError(message: "无法分配回退音频会话状态"))
      return
    }
    let fallback = SystemAudioFallback(gate: gate, failed: { [weak self] error in
      self?.control.async { self?.stop(error: error) }
    })
    self.fallback = fallback
    SystemAudioFallback.loadContent { [weak self] result in
      guard let self else { return }
      self.control.async {
        guard !self.isStopping, self.fallback === fallback else { return }
        switch result {
        case .failure(let error):
          self.stop(error: error)
        case .success(let content):
          guard let display = content.displays.first else {
            self.stop(error: NativeAudioError(message: "找不到显示器，无法启动系统声音回退"))
            return
          }
          fallback.start(display: display) { error in
            self.control.async {
              guard !self.isStopping, self.fallback === fallback else { return }
              if let error { self.stop(error: error) }
              else { diagnostic(["stage": "fallback-started", "backend": "sck-system-wide"]) }
            }
          }
        }
      }
    }
  }

  // 只读一次 HAL 进程清单：用于回答“音频到底记在哪个进程对象上”。
  private func halProcessInventory() -> [[String: Any]] {
    var admitted: Set<AudioObjectID> = []
    if let target, let members = try? target.members() { admitted = Set(members.keys) }
    let processes = (try? audioProcesses()) ?? []
    return processes.sorted().map { object in
      let pid: Int32 = (try? audioValue(object, kAudioProcessPropertyPID, initial: Int32(0))) ?? 0
      return ["object": Int(object), "pid": Int(pid),
              "executable": ProcessIdentity.read(pid)?.executable ?? "",
              "bundle": (try? audioString(object, kAudioProcessPropertyBundleID)) ?? "",
              "running": (try? audioValue(object, kAudioProcessPropertyIsRunning, initial: UInt32(0))) ?? 0,
              "output": (try? audioValue(object, kAudioProcessPropertyIsRunningOutput, initial: UInt32(0))) ?? 0,
              "input": (try? audioValue(object, kAudioProcessPropertyIsRunningInput, initial: UInt32(0))) ?? 0,
              "admitted": admitted.contains(object)]
    }
  }

  private func stop(error: Error? = nil) {
    guard !isStopping else { return }
    diagnostic(["stage": "stop", "reason": error?.localizedDescription ?? "parent-close"])
    isStopping = true
    currentGate?.close()
    let activeFallback = fallback
    fallback = nil
    activeFallback?.stop()
    processTimer?.cancel()
    inputSource?.cancel()
    signalSource?.cancel()
    var finalError = error
    for observation in observations {
      do { try observation.remove() } catch { finalError = finalError ?? error }
    }
    observations.removeAll()
    let reportedError = finalError
    executor.perform { [self] in
      var cleanupError = reportedError
      do { try graph?.close(); graph = nil } catch { cleanupError = cleanupError ?? error }
      if let cleanupError { emit(["event": "error", "message": cleanupError.localizedDescription]) }
      exit(cleanupError == nil ? 0 : 1)
    }
  }
}
