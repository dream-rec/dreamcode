// No devices, process taps, permissions, microphones, browsers, providers or network calls.
// Compiles the production ownership/reconciliation/converter/ring/lifecycle code unchanged.
import AVFoundation
import CoreAudio
import Foundation

func emit(_ object: [String: Any]) { /* The graph is never opened in these tests. */ }

struct TestFailure: Error { let message: String }
func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
  if !condition() { throw TestFailure(message: message) }
}

let installation = "/Applications/Google Chrome.app"
func identity(_ pid: Int32, parent: Int32 = 1, start: UInt64 = 1, path: String) -> ProcessIdentity {
  ProcessIdentity(pid: pid, parentPID: parent, startSeconds: start, startMicroseconds: 42, executable: path)
}

func testOwnership() throws {
  let root = identity(100, path: installation + "/Contents/MacOS/Google Chrome")
  let helperBundle = installation + "/Contents/Frameworks/Google Chrome Framework.framework/Versions/154/Helpers/Google Chrome Helper (Aperitif).app"
  let helper = identity(200, parent: 100, path: helperBundle + "/Contents/MacOS/Google Chrome Helper (Aperitif)")
  let target = ChromeTarget(roots: [root], bundlePath: installation)
  var processes = [root.pid: root, helper.pid: helper]
  func admits(_ candidate: ProcessIdentity, bundle: String = "com.google.Chrome.helper",
              bundleMatches: Bool = true) -> Bool {
    target.trusts(candidate, halBundleID: bundle, bundleIdentity: { path in
      path == helperBundle && bundleMatches ? (bundle, helper.executable) : nil
    }, process: { processes[$0] })
  }
  try expect(admits(root, bundle: ChromeTarget.bundleID), "main process is trusted")
  try expect(admits(helper), "silent helper with version-specific name is trusted without output-state gating")
  try expect(!admits(helper, bundle: "com.google.Chrome.helper.attacker"), "bundle prefixes are not identities")
  try expect(!admits(helper, bundle: "com.electron.app"), "unrelated Electron process excluded")
  try expect(!admits(helper, bundleMatches: false), "HAL bundle alone is insufficient")
  let foreign = identity(300, parent: 100, path: "/Applications/Google Chrome.app.evil/Contents/MacOS/Helper")
  processes[300] = foreign
  try expect(!admits(foreign), "sibling prefix path excluded")
  let secondInstall = identity(400, parent: 100, path: "/tmp/Google Chrome.app/Contents/MacOS/Helper")
  processes[400] = secondInstall
  try expect(!admits(secondInstall), "another Chrome installation excluded")
  processes[200] = identity(200, parent: 999, path: helper.executable)
  try expect(!admits(processes[200] ?? root), "unverified parent excluded")
  processes[200] = identity(200, parent: 100, start: 2, path: helper.executable)
  try expect(!admits(helper), "PID reuse invalidates a stale candidate")
  processes[100] = identity(100, start: 2, path: root.executable)
  try expect(!admits(root, bundle: ChromeTarget.bundleID), "root PID reuse means application exit")
  processes.removeValue(forKey: 100)
  try expect(!admits(helper), "full application exit invalidates helpers")
  try expect(ProcessIdentity.read(getpid())?.pid == getpid(), "real libproc identity bridge reads only this test process")
}

func testMultipleProfiles() throws {
  let executable = installation + "/Contents/MacOS/Google Chrome"
  let root = identity(100, path: executable)
  let profile = identity(101, start: 2, path: executable)
  let first = ChromeApplicationIdentity(root: root, bundlePath: installation,
                                        bundleID: ChromeTarget.bundleID, executable: executable)
  let second = ChromeApplicationIdentity(root: profile, bundlePath: installation,
                                         bundleID: ChromeTarget.bundleID, executable: executable)
  let target = try ChromeTarget.resolve([first, second])
  let helperBundle = installation + "/Contents/Frameworks/Helper.app"
  let helper = identity(200, parent: root.pid, path: helperBundle + "/Contents/MacOS/Helper")
  let profileHelper = identity(201, parent: profile.pid, start: 3, path: helper.executable)
  var processes = [root.pid: root, profile.pid: profile, helper.pid: helper, profileHelper.pid: profileHelper]
  func admits(_ candidate: ProcessIdentity, bundle: String = "com.google.Chrome.helper") -> Bool {
    target.trusts(candidate, halBundleID: bundle, bundleIdentity: {
      $0 == helperBundle ? ("com.google.Chrome.helper", helper.executable) : nil
    }, process: { processes[$0] })
  }
  try expect(target.roots.count == 2, "same-install profiles retain both real root identities")
  try expect(admits(root, bundle: ChromeTarget.bundleID) && admits(profile, bundle: ChromeTarget.bundleID),
             "both verified root audio clients are included")
  try expect(admits(helper) && admits(profileHelper), "each helper belongs to its own verified profile root")
  processes.removeValue(forKey: root.pid)
  try expect(target.isAlive(process: { processes[$0] }), "one profile exiting does not stop a remaining profile")
  try expect(!admits(helper) && admits(profileHelper), "exit removes only that root's helpers")
  processes[profile.pid] = identity(profile.pid, start: 99, path: executable)
  try expect(!target.isAlive(process: { processes[$0] }) && !admits(profileHelper),
             "PID reuse cannot resurrect a selected profile")
  let otherPath = "/tmp/Google Chrome.app"
  let other = ChromeApplicationIdentity(root: identity(300, path: otherPath + "/Contents/MacOS/Google Chrome"),
                                        bundlePath: otherPath, bundleID: ChromeTarget.bundleID,
                                        executable: otherPath + "/Contents/MacOS/Google Chrome")
  let wrongExecutable = ChromeApplicationIdentity(root: profile, bundlePath: installation,
                                                   bundleID: ChromeTarget.bundleID, executable: helper.executable)
  let wrongBundle = ChromeApplicationIdentity(root: profile, bundlePath: installation,
                                               bundleID: "com.google.Chrome.beta", executable: executable)
  for invalid in [[], [first, other], [first, wrongExecutable], [first, wrongBundle], [first, first]] {
    do {
      _ = try ChromeTarget.resolve(invalid)
      throw TestFailure(message: "empty, ambiguous or unverifiable installations were admitted")
    } catch is NativeAudioError { }
  }
}

func testMembership() throws {
  var state = ChromeMembershipState()
  let helper = identity(200, parent: 100, path: installation + "/Contents/Helper")
  try expect(state.update([:], device: 1, rate: 48000)?.shouldWait == true, "empty initial membership waits")
  for _ in 0..<100 {
    try expect(state.update([:], device: 1, rate: 48000) == nil, "no retry storm while waiting")
  }
  try expect(state.update([113: helper], device: 1, rate: 48000)?.shouldWait == false, "late helper activates capture")
  try expect(state.update([113: helper], device: 1, rate: 48000) == nil, "silence does not rebuild a graph")
  try expect(state.update([:], device: 1, rate: 48000)?.shouldWait == true, "helper disappearance removes graph")
  let replacement = identity(201, parent: 100, start: 2, path: helper.executable)
  try expect(state.update([114: replacement], device: 1, rate: 48000)?.deviceChanged == false, "helper restart updates positive membership")
  try expect(state.update([114: replacement], device: 2, rate: 48000)?.deviceChanged == true, "output-device change rebuilds")
  try expect(state.update([114: replacement], device: 2, rate: 44100)?.deviceChanged == true, "output format change rebuilds")
  try expect(state.update([114: replacement], device: 0, rate: 0)?.shouldWait == true, "missing output device waits")
  try expect(state.update([114: replacement], device: 2, rate: 44100)?.shouldWait == false, "output device recovery resumes")
  state.invalidate()
  try expect(state.update([114: replacement], device: 2, rate: 44100)?.deviceChanged == true, "tap format change forces rebuild")
}

func testDescriptions() throws {
  guard #available(macOS 14.4, *) else { return }
  let uuid = UUID()
  let description = try chromeTapDescription([111, 113, 114], uuid: uuid)
  try expect(description.isPrivate && !description.isExclusive, "tap is private and positive")
  try expect(description.muteBehavior == .unmuted && description.uuid == uuid, "tap never mutes or replaces its identity")
  try expect(description.processes == [111, 113, 114], "HAL object IDs, not OS PIDs, are passed unchanged")
  do {
    _ = try chromeTapDescription([], uuid: uuid)
    throw TestFailure(message: "empty tap was accepted")
  } catch is NativeAudioError { }
  let aggregate = chromeAggregateDescription(tapUUID: uuid)
  try expect(aggregate[kAudioAggregateDeviceSubDeviceListKey] == nil, "aggregate has no physical input/output devices")
  try expect(aggregate[kAudioAggregateDeviceIsPrivateKey] as? Bool == true, "aggregate is private")
  try expect(aggregate[kAudioAggregateDeviceTapAutoStartKey] as? Bool == false, "start does not deliberately wait for playback")
  let taps = aggregate[kAudioAggregateDeviceTapListKey] as? [[String: Any]]
  try expect(taps?.count == 1 && taps?.first?[kAudioSubTapUIDKey] as? String == uuid.uuidString, "only the trusted tap supplies input")
}

func testRing(interleaved: Bool) throws {
  guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: 2, interleaved: interleaved),
        let input = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 8),
        let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 8),
        let ring = dc_ring_create(interleaved ? 1 : 2, interleaved ? 2 : 1, interleaved ? 8 : 4, 8, 2) else {
    throw TestFailure(message: "ring fixture allocation failed")
  }
  defer { dc_ring_destroy(ring) }
  input.frameLength = 4
  for buffer in UnsafeMutableAudioBufferListPointer(input.mutableAudioBufferList) {
    guard let data = buffer.mData else { throw TestFailure(message: "missing buffer") }
    let count = Int(buffer.mDataByteSize) / 4
    for i in 0..<count { data.storeBytes(of: Float(i) / 10, toByteOffset: i * 4, as: Float.self) }
  }
  try expect(!dc_ring_push(ring, input.audioBufferList), "disabled ring rejects callbacks")
  dc_ring_enable(ring, true)
  try expect(dc_ring_push(ring, input.audioBufferList), "packet one copied")
  try expect(dc_ring_push(ring, input.audioBufferList), "packet two copied")
  try expect(!dc_ring_push(ring, input.audioBufferList) && dc_ring_dropped(ring) == 1, "bounded overflow drops whole packet")
  try expect(dc_ring_pop(ring, output.mutableAudioBufferList, 8) == 4, "whole frames returned")
  let source = UnsafeMutableAudioBufferListPointer(input.mutableAudioBufferList)
  let destination = UnsafeMutableAudioBufferListPointer(output.mutableAudioBufferList)
  for i in source.indices {
    guard let lhs = source[i].mData, let rhs = destination[i].mData else { throw TestFailure(message: "missing PCM") }
    try expect(memcmp(lhs, rhs, Int(source[i].mDataByteSize)) == 0, "planar/interleaved sample layout preserved")
  }
  _ = dc_ring_pop(ring, output.mutableAudioBufferList, 8)
  try expect(dc_ring_pop(ring, output.mutableAudioBufferList, 8) == 0, "no stale samples after drain")
  let malformed = input.mutableAudioBufferList
  malformed.pointee.mBuffers.mDataByteSize -= 1
  try expect(!dc_ring_push(ring, malformed), "partial Float32 frame rejected")
  malformed.pointee.mBuffers.mDataByteSize = interleaved ? 72 : 36
  try expect(!dc_ring_push(ring, malformed), "oversized packet is rejected before any memory copy")
  try expect(dc_ring_create(3, 1, 4, 8, 2) == nil, "unexpected physical/multistream input is rejected")
  dc_ring_enable(ring, false)
  try expect(!dc_ring_push(ring, input.audioBufferList), "retired callback cannot enqueue PCM")
}

func testConcurrentRing() throws {
  guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: 2, interleaved: true),
        let input = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 8),
        let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 8),
        let inputBytes = input.mutableAudioBufferList.pointee.mBuffers.mData,
        let outputBytes = output.mutableAudioBufferList.pointee.mBuffers.mData,
        let ring = dc_ring_create(1, 2, 8, 8, 4) else {
    throw TestFailure(message: "concurrent ring fixture allocation failed")
  }
  defer { dc_ring_destroy(ring) }
  input.frameLength = 8
  dc_ring_enable(ring, true)
  let group = DispatchGroup()
  let deadline = Date().addingTimeInterval(10)
  let packets = 20000
  var producerFailed = false
  var consumerFailed = false
  group.enter()
  DispatchQueue(label: "test.audio-producer").async {
    defer { group.leave() }
    for packet in 0..<packets {
      for sample in 0..<16 {
        inputBytes.storeBytes(of: Float(packet * 16 + sample), toByteOffset: sample * 4, as: Float.self)
      }
      while !dc_ring_push(ring, input.audioBufferList) {
        if Date() > deadline { producerFailed = true; return }
      }
    }
  }
  group.enter()
  DispatchQueue(label: "test.audio-consumer").async {
    defer { group.leave() }
    for packet in 0..<packets {
      var frames: UInt32 = 0
      while frames == 0 {
        frames = dc_ring_pop(ring, output.mutableAudioBufferList, 8)
        if Date() > deadline { consumerFailed = true; return }
      }
      if frames != 8 { consumerFailed = true; return }
      for sample in 0..<16 {
        if outputBytes.load(fromByteOffset: sample * 4, as: Float.self) != Float(packet * 16 + sample) {
          consumerFailed = true
          return
        }
      }
    }
  }
  group.wait() // Both threads leave before inspecting flags or freeing their shared C ring.
  try expect(!producerFailed && !consumerFailed, "concurrent wraparound preserves complete ordered stereo frames")
}

func testConversion(rate: Double, channels: AVAudioChannelCount, interleaved: Bool, pcm16: Bool = false) throws {
  guard let format = AVAudioFormat(commonFormat: pcm16 ? .pcmFormatInt16 : .pcmFormatFloat32,
                                  sampleRate: rate, channels: channels, interleaved: interleaved) else {
    throw TestFailure(message: "invalid conversion fixture")
  }
  let converter = try TapPCMConverter(asbd: format.streamDescription.pointee)
  let width = pcm16 ? 2 : 4
  var result: [Float] = []
  var position = 0
  while position < Int(rate) {
    let frames = min(257, Int(rate) - position) // deliberately not aligned to the 48k->16k ratio
    converter.input.frameLength = AVAudioFrameCount(frames)
    for buffer in UnsafeMutableAudioBufferListPointer(converter.input.mutableAudioBufferList) {
      guard let bytes = buffer.mData else { throw TestFailure(message: "missing conversion input") }
      for frame in 0..<frames {
        let sample = 0.2 * sin(2 * Double.pi * 440 * Double(position + frame) / rate)
        for channel in 0..<Int(buffer.mNumberChannels) {
          let offset = (frame * Int(buffer.mNumberChannels) + channel) * width
          if pcm16 { bytes.storeBytes(of: Int16(sample * 32767), toByteOffset: offset, as: Int16.self) }
          else { bytes.storeBytes(of: Float(sample), toByteOffset: offset, as: Float.self) }
        }
      }
    }
    try converter.convert(frames: AVAudioFrameCount(frames)) { bytes, size in
      try expect(size % 4 == 0, "output Float32 alignment")
      let samples = UnsafeBufferPointer(start: bytes.assumingMemoryBound(to: Float.self), count: Int(size) / 4)
      result.append(contentsOf: samples)
    }
    position += frames
  }
  try expect(abs(result.count - 16000) < 200, "stateful conversion retains fractional-rate continuity")
  try expect(result.allSatisfy { $0.isFinite }, "conversion output is finite")
  let stable = Array(result.dropFirst(500))
  let energy = stable.reduce(0.0) { $0 + Double($1 * $1) } / Double(stable.count)
  try expect(energy > 0.005 && energy < 0.05, "synthetic signal energy preserved")
  var real = 0.0, imaginary = 0.0
  for (i, value) in stable.enumerated() {
    let angle = 2 * Double.pi * 440 * Double(i) / 16000
    real += Double(value) * cos(angle)
    imaginary += Double(value) * sin(angle)
  }
  let amplitude = 2 * hypot(real, imaginary) / Double(stable.count)
  try expect(amplitude > 0.1, "synthetic 440Hz remains 440Hz at fixed 16kHz")
}

func testBlindPolicy() throws {
  var policy = ChromeBlindPolicy()
  let start = Date()
  try expect(policy.decide(duplex: true, now: start) == .systemFallback,
             "duplex blind escalates to system fallback immediately")
  try expect(policy.decide(duplex: false, now: start) == .rebuild(attempt: 1),
             "stale-graph blind rebuilds the same trusted membership")
  try expect(policy.decide(duplex: false, now: start.addingTimeInterval(1)) == .none,
             "rebuild interval is enforced")
  try expect(policy.decide(duplex: false, now: start.addingTimeInterval(15)) == .rebuild(attempt: 2),
             "rebuild resumes after the interval")
  var bounded = ChromeBlindPolicy()
  var lastAttempt = 0
  for index in 0..<10 {
    if case .rebuild(let attempt) = bounded.decide(duplex: false, now: start.addingTimeInterval(Double(index) * 15)) {
      lastAttempt = attempt
    }
  }
  try expect(lastAttempt == ChromeBlindPolicy.maximumRebuilds, "rebuilds are bounded at five")
  try expect(bounded.decide(duplex: false, now: start.addingTimeInterval(10_000)) == .none,
             "exhausted policy never rebuilds again")
  try expect(bounded.decide(duplex: true, now: start.addingTimeInterval(10_000)) == .systemFallback,
             "duplex still escalates after rebuilds are exhausted")
}

func testCleanup() throws {
  let resources = AudioResources()
  var calls: [String] = []
  resources.stopIO = { calls.append("stop") }
  resources.destroyIO = { calls.append("ioProc") }
  resources.destroyAggregate = { calls.append("aggregate") }
  resources.destroyTap = { calls.append("tap") }
  try resources.close()
  try resources.close()
  try expect(calls == ["stop", "ioProc", "aggregate", "tap"], "safe idempotent cleanup order")
  let failed = AudioResources()
  failed.stopIO = { throw NativeAudioError(message: "mock stop failure") }
  failed.destroyIO = { calls.append("unsafe free") }
  do { try failed.close(); throw TestFailure(message: "stop failure swallowed") } catch is NativeAudioError { }
  try expect(!calls.contains("unsafe free"), "failed stop never frees an in-flight IOProc")
  failed.stopIO = {}
  try failed.close()
}

func testBlockedStart() throws {
  let executor = AudioGraphExecutor()
  let gate = try AudioGate()
  let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
  let cleaned = DispatchSemaphore(value: 0)
  let resources = AudioResources()
  var emitted = false
  executor.perform {
    entered.signal()
    release.wait() // Models an AudioDeviceStart that has not yet returned.
    if gate.isOpen { emitted = true }
  }
  try expect(entered.wait(timeout: .now() + 2) == .success, "start began")
  gate.close()
  gate.close()
  executor.perform {
    resources.stopIO = { cleaned.signal() }
    do { try resources.close() } catch { fatalError("unexpected mock cleanup error: \(error)") }
  }
  try expect(!gate.isOpen, "cancellation is immediate despite blocked start")
  try expect(cleaned.wait(timeout: .now() + 0.05) == .timedOut, "cleanup does not race start")
  release.signal()
  try expect(cleaned.wait(timeout: .now() + 2) == .success, "cleanup runs once start releases")
  try expect(!emitted, "cancelled generation never emits after late start")
}

@main
enum NativeAudioTests {
  static func main() throws {
    try testOwnership()
    try testMultipleProfiles()
    try testMembership()
    try testDescriptions()
    try testBlindPolicy()
    try testRing(interleaved: true)
    try testRing(interleaved: false)
    try testConcurrentRing()
    try testConversion(rate: 48000, channels: 2, interleaved: true)
    try testConversion(rate: 44100, channels: 2, interleaved: false)
    try testConversion(rate: 16000, channels: 1, interleaved: true)
    try testConversion(rate: 48000, channels: 2, interleaved: true, pcm16: true)
    try testCleanup()
    try testBlockedStart()
    print("Native audio: 14 no-device scenarios passed (not a real capture/permission test)")
  }
}
