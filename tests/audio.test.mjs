import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createLoader, plain, deferred, tick } from './load-ts.mjs'

function voiceFixture(transcribe = async () => 'old transcript', nativeStart, options = {}) {
  const handlers = new Map()
  const commands = []
  const answers = []
  let stopAck = true
  let retire
  const load = createLoader(
    {
      electron: {
        ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
        session: {},
        desktopCapturer: {}
      },
      './settings': {
        settings: {
          voice: {
            audioSource: 'system',
            audioAppId: 'A',
            audioDeviceId: '',
            vad: {},
            autoOpenPage: true,
            stt: { apiBaseURL: 'mock', apiKey: 'mock', model: 'mock' }
          }
        },
        onCaptureTargetChange: (fn) => {
          retire = fn
        }
      },
      './ai': {
        getVoiceProviderConfig: () => ({ apiKey: 'mock-only', model: 'mock-model' }),
        getVoiceAnswerStream: (messages) => {
          answers.push(plain(messages))
          return (async function* () {
            yield 'voice answer'
          })()
        }
      },
      './stt': { transcribeAudio: transcribe },
      './app-audio': { listAudioApps: async () => [], startAppCapture: nativeStart }
    },
    {
      setTimeout: (fn, ms) => setTimeout(fn, options.fastStop && ms === 5000 ? 5 : ms),
      global: {
        mainWindow: {
          isDestroyed: () => false,
          webContents: {
            send: (name, payload) => {
              if (name === 'voice-capture-command') {
                commands.push(plain(payload))
                if (payload.type === 'stop' && stopAck)
                  handlers.get('voice:captureStopped')({}, payload.sessionId, payload.requestId)
                if (payload.type === 'flush')
                  handlers.get('voice:flushed')({}, payload.sessionId, payload.requestId)
              }
            }
          }
        }
      }
    }
  )
  const voice = load('src/main/voice.ts')
  return {
    voice,
    commands,
    answers,
    setStopAck: (enabled) => {
      stopAck = enabled
    },
    retire: () => retire(),
    call: (name, ...args) => handlers.get(name)({}, ...args),
    snapshot: () => handlers.get('voice:getSnapshot')()
  }
}

test('saved target retirement preserves accepted transcript jobs; stale start/error events cannot corrupt replacement', async () => {
  const stt = deferred()
  const f = voiceFixture(() => stt.promise)
  f.voice.startListening()
  const old = f.commands.at(-1).sessionId
  f.call('voice:captureStarted', old)
  f.call('voice:pushSegment', {
    sessionId: old,
    seq: 1,
    wav: new Uint8Array([0]),
    startedAt: 0,
    durationMs: 1000
  })
  assert.equal(f.snapshot().segments.length, 1)
  await f.retire()
  assert.equal(f.snapshot().captureState, 'idle')
  assert.equal(f.snapshot().segments.length, 1)
  assert.equal(f.voice.startListening(), true)
  const next = f.commands.at(-1).sessionId
  f.call('voice:captureStarted', old)
  await f.call('voice:captureError', old, 'late failure')
  assert.equal(f.snapshot().captureState, 'starting')
  f.call('voice:captureStarted', next)
  stt.resolve('old transcript')
  await tick()
  assert.equal(f.snapshot().captureState, 'listening')
  assert.equal(f.snapshot().segments[0].text, 'old transcript')
  f.call('voice:pushSegment', {
    sessionId: old,
    seq: 2,
    wav: new Uint8Array([0]),
    startedAt: 0,
    durationMs: 1000
  })
  assert.equal(f.snapshot().segments.length, 1)
  await f.retire()
})

test('test/formal ownership is exclusive and repeated start shortcuts do not enqueue new starts', async () => {
  const f = voiceFixture()
  await f.call('voice:reserveCapture', 'test-1', 'test')
  assert.equal(f.voice.startListening(), false)
  await f.call('voice:releaseCapture', 'test-1')
  assert.equal(f.voice.startListening(), true)
  assert.equal(f.voice.startListening(), false)
  assert.equal(f.commands.filter((c) => c.type === 'start').length, 1)
  assert.throws(() => f.call('voice:reserveCapture', 'test-2', 'test'), /停止正式监听/)
  await f.retire()
})

test('retiring pending native startup aborts it before resolution', async () => {
  let signal
  const f = voiceFixture(undefined, (_app, _callbacks, abortSignal) => {
    signal = abortSignal
    return new Promise((_resolve, reject) =>
      abortSignal.addEventListener('abort', () => reject(new Error('cancelled')))
    )
  })
  f.voice.startListening()
  const id = f.commands.at(-1).sessionId
  const start = f.call('voice:appCaptureStart', 'A', id)
  const rejected = assert.rejects(start, /cancelled/)
  await f.retire()
  await rejected
  assert.equal(signal.aborted, true)
  assert.equal(f.snapshot().captureState, 'idle')
})

test('settings save waits for retirement before applying B', async () => {
  const handlers = new Map()
  const gate = deferred()
  let persisted = 0
  const load = createLoader(
    {
      electron: { ipcMain: { handle: (name, fn) => handlers.set(name, fn) } },
      './config': {
        loadConfig: () => ({}),
        saveConfig: () => {
          persisted++
        }
      }
    },
    { global: {} }
  )
  const { defaultConfig } = load('src/shared/settings.ts')
  const settingsModule = load('src/main/settings.ts')
  Object.assign(settingsModule.settings, structuredClone(defaultConfig))
  settingsModule.settings.voice.audioAppId = 'A'
  settingsModule.onCaptureTargetChange(() => gate.promise)
  const incoming = { voice: { ...settingsModule.settings.voice, audioAppId: 'B' } }
  let settled = false
  const saving = handlers
    .get('updateAppSettings')({}, incoming)
    .then(() => {
      settled = true
    })
  await tick()
  assert.equal(settled, false)
  assert.equal(settingsModule.settings.voice.audioAppId, 'A')
  gate.resolve()
  await saving
  assert.equal(settingsModule.settings.voice.audioAppId, 'B')
  assert.equal(persisted, 1)
})

test('renderer cancellation disposes a pending native session, removes subscriptions, and rejects its late success', async () => {
  const gate = deferred()
  const released = []
  const subscriptions = new Map()
  const api = {
    voiceEnsureCapturePermission: async () => true,
    voiceReserveCapture: async () => {},
    voiceReleaseCapture: async (id) => {
      released.push(id)
    },
    voiceAppCaptureStart: () => gate.promise,
    onVoiceAppAudio: (id, pcm, ended) => {
      subscriptions.set(id, { pcm, ended })
      return () => subscriptions.delete(id)
    }
  }
  const load = createLoader({}, { window: { api }, document: { baseURI: 'https://test.invalid/' } })
  const { AudioCaptureSession } = load('src/renderer/src/voice/audio/capture.ts')
  const controller = new AbortController()
  const starting = AudioCaptureSession.start(
    { source: 'system', appId: 'A', vad: {} },
    { onSegment: () => undefined, onLevel: () => undefined, onEnded: () => undefined },
    { id: 'session-A', owner: 'voice', signal: controller.signal }
  )
  const rejected = assert.rejects(starting, /取消/)
  await tick()
  assert.equal(subscriptions.has('session-A'), true)
  controller.abort()
  await tick()
  assert.deepEqual(released, ['session-A'])
  assert.equal(subscriptions.size, 0)
  gate.resolve()
  await rejected
})

test('preload delivers PCM and ended only to the matching capture ID', () => {
  const ipcRenderer = new EventEmitter()
  ipcRenderer.invoke = async () => {}
  const world = {}
  const load = createLoader(
    {
      electron: {
        ipcRenderer,
        contextBridge: {
          exposeInMainWorld: (name, value) => {
            world[name] = value
          }
        },
        webFrame: {
          setZoomFactor: () => undefined,
          setZoomLevel: () => undefined,
          setVisualZoomLevelLimits: () => undefined
        }
      },
      '@electron-toolkit/preload': { electronAPI: {} }
    },
    { process: { ...process, contextIsolated: true }, window: world }
  )
  load('src/preload/index.ts')
  let pcm = 0,
    ended = 0
  const unsubscribe = world.api.onVoiceAppAudio(
    'B',
    () => {
      pcm++
    },
    () => {
      ended++
    }
  )
  ipcRenderer.emit('voice-app-pcm', {}, { id: 'A', samples: new Float32Array(320) })
  ipcRenderer.emit('voice-app-ended', {}, { id: 'A', reason: 'old' })
  assert.equal(pcm + ended, 0)
  ipcRenderer.emit('voice-app-pcm', {}, { id: 'B', samples: new Float32Array(320) })
  ipcRenderer.emit('voice-app-ended', {}, { id: 'B', reason: 'current' })
  assert.equal(pcm, 1)
  assert.equal(ended, 1)
  unsubscribe()
  assert.equal(ipcRenderer.listenerCount('voice-app-pcm'), 0)
})

function nativeFixture(options = {}) {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  let kills = 0
  child.kill = () => {
    kills++
    if (!options.deferClose) setImmediate(() => child.emit('close', 0))
    return true
  }
  const load = createLoader(
    {
      electron: { app: { isPackaged: false, on: () => undefined } },
      'node:child_process': { execFile: (_a, _b, _c, cb) => cb?.(null, ''), spawn: () => child }
    },
    { process: { ...process, platform: 'darwin' }, ...options.globals }
  )
  return { child, kills: () => kills, api: load('src/main/app-audio.ts') }
}

test('native helper parses a started JSON line split across pipe chunks', async () => {
  const f = nativeFixture()
  const starting = f.api.startAppCapture('A', { onPcm: () => undefined, onEnded: () => undefined })
  f.child.stderr.write('{"event":"sta')
  f.child.stderr.write('rted"}\n')
  const capture = await starting
  await capture.stop()
  assert.equal(f.kills(), 1)
})

test('native helper cancellation kills and waits for close even before started', async () => {
  const f = nativeFixture()
  const controller = new AbortController()
  const starting = f.api.startAppCapture(
    'A',
    { onPcm: () => undefined, onEnded: () => undefined },
    controller.signal
  )
  const rejected = assert.rejects(starting, /取消/)
  controller.abort()
  await rejected
  assert.equal(f.kills(), 1)
})

test('Chrome armed handshake survives silence beyond native startup timeout and preserves fixed PCM framing', async () => {
  const timers = new Map()
  let now = 0
  const received = []
  const f = nativeFixture({
    globals: {
      setTimeout: (fn, ms) => {
        const timer = { fn, at: now + ms }
        timers.set(timer, timer)
        return timer
      },
      clearTimeout: (timer) => timers.delete(timer),
      setInterval: () => 0,
      clearInterval: () => undefined
    }
  })
  const starting = f.api.startAppCapture('com.google.Chrome', {
    onPcm: (samples) => received.push(...samples),
    onEnded: () => assert.fail('waiting is not an ended capture')
  })
  f.child.stderr.write('{"event":"format","sampleRate":16000,"channels":1}\n{"event":"sta')
  f.child.stderr.write('rted","backend":"core-audio-process-tap","waiting":true}\n')
  const capture = await starting
  now = 120_000
  for (const timer of [...timers.values()]) if (timer.at <= now) timer.fn()
  assert.equal(f.kills(), 0)
  assert.equal(received.length, 0, 'armed does not imply real PCM')
  const bytes = Buffer.alloc(12)
  ;[0.25, -0.5, 0.75].forEach((value, index) => bytes.writeFloatLE(value, index * 4))
  f.child.stdout.write(bytes.subarray(0, 3))
  f.child.stdout.write(bytes.subarray(3, 9))
  f.child.stdout.write(bytes.subarray(9))
  assert.deepEqual(received, [0.25, -0.5, 0.75])
  await capture.stop()
  assert.equal(timers.size, 0)
})

test('Chrome errors after armed readiness use onEnded once and stop awaits child close', async () => {
  const reasons = []
  const f = nativeFixture({ deferClose: true })
  const starting = f.api.startAppCapture('com.google.Chrome', {
    onPcm: () => undefined,
    onEnded: (reason) => reasons.push(reason)
  })
  f.child.stderr.write('{"event":"started","backend":"core-audio-process-tap","waiting":true}\n')
  const capture = await starting
  f.child.stderr.write('{"event":"error","message":"public API rejected tap"}\n')
  f.child.stderr.write('{"event":"error","message":"duplicate shutdown event"}\n')
  const stopped = capture.stop()
  assert.equal(capture.stop(), stopped)
  let closed = false
  void stopped.then(() => {
    closed = true
  })
  await tick()
  assert.equal(closed, false)
  assert.equal(f.kills(), 1)
  assert.deepEqual(reasons, ['public API rejected tap'])
  f.child.emit('close', 1)
  await stopped
  assert.equal(closed, true)
})

test('legacy application helpers still accept bare started and resample SCK float PCM', async () => {
  const received = []
  const f = nativeFixture()
  const starting = f.api.startAppCapture('com.netease.163music', {
    onPcm: (samples) => received.push(...samples),
    onEnded: () => undefined
  })
  f.child.stderr.write('{"event":"format","sampleRate":48000,"channels":2}\n{"event":"started"}\n')
  const capture = await starting
  const bytes = Buffer.alloc(24)
  for (let index = 0; index < 6; index++) bytes.writeFloatLE(0.25, index * 4)
  f.child.stdout.write(bytes)
  assert.deepEqual(received, [0.25])
  await capture.stop()
})

test('cancelled A send cannot submit or remove replacement B transcript', async () => {
  const oldStt = deferred()
  let calls = 0
  const f = voiceFixture(() => (++calls === 1 ? oldStt.promise : Promise.resolve('B text')))
  f.voice.startListening()
  const a = f.commands.at(-1).sessionId
  f.call('voice:captureStarted', a)
  f.call('voice:pushSegment', {
    sessionId: a,
    seq: 1,
    wav: new Uint8Array([0]),
    startedAt: 0,
    durationMs: 1000
  })
  const sending = f.voice.sendNow()
  await tick()
  await f.voice.cancelListening()
  f.voice.startListening()
  const b = f.commands.at(-1).sessionId
  f.call('voice:captureStarted', b)
  f.call('voice:pushSegment', {
    sessionId: b,
    seq: 1,
    wav: new Uint8Array([0]),
    startedAt: 0,
    durationMs: 1000
  })
  await tick()
  oldStt.resolve('A text')
  await sending
  assert.equal(f.answers.length, 0)
  assert.equal(f.snapshot().segments.length, 1)
  assert.equal(f.snapshot().segments[0].text, 'B text')
  await f.retire()
})

test('voice send freezes segment IDs and leaves newly captured pending segments intact', async () => {
  const a = deferred(),
    b = deferred()
  let calls = 0
  const f = voiceFixture(() => (++calls === 1 ? a.promise : b.promise))
  f.voice.startListening()
  const id = f.commands.at(-1).sessionId
  f.call('voice:captureStarted', id)
  const segment = (seq) => ({
    sessionId: id,
    seq,
    wav: new Uint8Array([0]),
    startedAt: 0,
    durationMs: 1000
  })
  f.call('voice:pushSegment', segment(1))
  const sending = f.voice.sendNow()
  await tick()
  f.call('voice:pushSegment', segment(2))
  a.resolve('first batch')
  await sending
  assert.equal(f.answers.length, 1)
  assert.equal(f.answers[0].at(-1).content, 'first batch')
  assert.equal(f.snapshot().segments.length, 1)
  assert.equal(f.snapshot().segments[0].status, 'pending')
  b.resolve('next batch')
  await tick()
  assert.equal(f.snapshot().segments[0].text, 'next batch')
  await f.retire()
})

test('missing stop acknowledgement fails retirement and blocks replacement until a successful retry', async () => {
  const f = voiceFixture(undefined, undefined, { fastStop: true })
  f.voice.startListening()
  f.call('voice:captureStarted', f.commands.at(-1).sessionId)
  f.setStopAck(false)
  await assert.rejects(f.retire(), /停止确认超时/)
  assert.equal(f.snapshot().captureState, 'stopping')
  assert.equal(f.voice.startListening(), false)
  f.setStopAck(true)
  await f.retire()
  assert.equal(f.snapshot().captureState, 'idle')
  assert.equal(f.voice.startListening(), true)
  await f.retire()
})

test('concurrent target saves retire one at a time and confirm only the applied target', async () => {
  const handlers = new Map()
  const gates = [deferred(), deferred()]
  let retireCalls = 0
  const load = createLoader(
    {
      electron: { ipcMain: { handle: (name, fn) => handlers.set(name, fn) } },
      './config': { loadConfig: () => ({}), saveConfig: () => undefined }
    },
    { global: {} }
  )
  const { defaultConfig } = load('src/shared/settings.ts')
  const module = load('src/main/settings.ts')
  Object.assign(module.settings, structuredClone(defaultConfig))
  module.settings.voice.audioAppId = 'A'
  module.onCaptureTargetChange(() => gates[retireCalls++].promise)
  const save = (app) =>
    handlers.get('updateAppSettings')({}, { voice: { ...module.settings.voice, audioAppId: app } })
  const b = save('B'),
    c = save('C')
  await tick()
  assert.equal(retireCalls, 1)
  assert.equal(module.settings.voice.audioAppId, 'A')
  gates[0].resolve()
  await b
  await tick()
  assert.equal(retireCalls, 2)
  assert.equal(module.settings.voice.audioAppId, 'B')
  gates[1].resolve()
  await c
  assert.equal(module.settings.voice.audioAppId, 'C')
})

test('native helper reports a one-way system-audio fallback without ending capture', async () => {
  const fallbacks = []
  const ended = []
  const f = nativeFixture()
  const starting = f.api.startAppCapture('com.google.Chrome', {
    onPcm: () => undefined,
    onEnded: (reason) => ended.push(reason),
    onFallback: (info) => fallbacks.push(info)
  })
  f.child.stderr.write('{"event":"started","backend":"core-audio-process-tap","waiting":true}\n')
  const capture = await starting
  try {
    f.child.stderr.write('{"event":"fall')
    f.child.stderr.write('back","mode":"system","reason":"chrome-duplex"}\n')
    await tick()
    assert.deepEqual(plain(fallbacks), [{ mode: 'system', reason: 'chrome-duplex' }])
    assert.equal(ended.length, 0)
    f.child.stderr.write('{"event":"fallback","mode":42}\n')
    await tick()
    assert.deepEqual(plain(fallbacks.at(-1)), { mode: 'unknown', reason: '' })
    const bytes = Buffer.alloc(8)
    bytes.writeFloatLE(0.5, 0)
    bytes.writeFloatLE(-0.5, 4)
    f.child.stdout.write(bytes)
  } finally {
    await capture.stop()
  }
  assert.equal(f.kills(), 1)
})

test('system-audio fallback notice follows the listening session lifecycle', async () => {
  let nativeHandlers
  const f = voiceFixture(undefined, (_app, handlers) => {
    nativeHandlers = handlers
    return Promise.resolve({ stop: async () => undefined })
  })
  assert.equal(f.voice.startListening(), true)
  const id = f.commands.at(-1).sessionId
  await f.call('voice:appCaptureStart', 'com.google.Chrome', id)
  assert.equal(f.snapshot().captureNotice, null)
  nativeHandlers.onFallback()
  assert.equal(
    f.snapshot().captureNotice,
    '目标应用正在使用麦克风，已切换为采集全部系统声音（可能包含其他应用的声音）'
  )
  await f.retire()
  assert.equal(f.snapshot().captureNotice, null)
})
