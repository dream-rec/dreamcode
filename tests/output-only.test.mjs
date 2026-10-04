import test from 'node:test'
import assert from 'node:assert/strict'
import { createLoader, plain, deferred, tick } from './load-ts.mjs'

const { defaultConfig, defaultVoiceConfig, normalizeVoiceConfig, normalizeConfig } =
  createLoader()('src/shared/settings.ts')

function legacyVoice(overrides = {}) {
  return {
    ...plain(defaultVoiceConfig),
    audioSource: 'microphone',
    audioDeviceId: 'old-input-device',
    audioAppId: 'com.google.Chrome',
    audioAppName: 'Stale Chrome target',
    stt: { ...plain(defaultVoiceConfig.stt), apiKey: 'offline-key', model: 'saved-stt' },
    llmMode: 'custom',
    llm: { ...plain(defaultVoiceConfig.llm), model: 'saved-llm' },
    vad: { ...plain(defaultVoiceConfig.vad), silenceMs: 1200 },
    answerPrompt: 'saved prompt',
    autoOpenPage: false,
    ...overrides
  }
}

test('legacy input configurations migrate to system output without resurrecting a stale app', () => {
  for (const overrides of [
    {},
    { audioDeviceId: '' },
    { audioSource: undefined },
    { audioSource: undefined, audioDeviceId: '' },
    { audioSource: 'unsupported' }
  ]) {
    const old = legacyVoice(overrides)
    const voice = normalizeVoiceConfig(old)
    assert.equal(voice.audioSource, 'system')
    assert.equal(voice.audioAppId, '')
    assert.equal(voice.audioAppName, '')
    assert.equal(Object.hasOwn(voice, 'audioDeviceId'), false)
    for (const field of ['stt', 'llm', 'llmMode', 'vad', 'answerPrompt', 'autoOpenPage']) {
      assert.deepEqual(plain(voice[field]), plain(old[field]))
    }
    assert.deepEqual(plain(normalizeVoiceConfig(voice)), plain(voice), 'migration is idempotent')
    assert.equal(old.audioAppId, 'com.google.Chrome', 'does not mutate its input')
  }
})

test('explicit output selections survive stale device fields and unrelated configuration is preserved', () => {
  for (const audioAppId of ['', 'com.google.Chrome', 'com.netease.163music']) {
    const voice = normalizeVoiceConfig(legacyVoice({ audioSource: 'system', audioAppId }))
    assert.equal(voice.audioAppId, audioAppId)
    assert.equal(Object.hasOwn(voice, 'audioDeviceId'), false)
  }
  const config = { ...plain(defaultConfig), autoCheckUpdate: false, voice: legacyVoice() }
  const migrated = plain(normalizeConfig(config))
  for (const key of Object.keys(config).filter((key) => key !== 'voice')) {
    assert.deepEqual(migrated[key], config[key])
  }
  assert.equal(migrated.voice.audioAppId, '')
  assert.deepEqual(plain(normalizeVoiceConfig(null)), plain(defaultVoiceConfig))
})

test('actual persisted-config load and settings IPC migrate without recording; saves await target retirement', async () => {
  const handlers = new Map()
  const writes = []
  const notifications = []
  const load = createLoader(
    {
      electron: {
        app: { getPath: () => '/offline-config' },
        ipcMain: { handle: (name, callback) => handlers.set(name, callback) }
      },
      'node:fs': {
        existsSync: () => true,
        readFileSync: () => JSON.stringify({ ...plain(defaultConfig), voice: legacyVoice() }),
        writeFileSync: (_path, content) => writes.push(JSON.parse(content))
      }
    },
    {
      global: {
        mainWindow: {
          isDestroyed: () => false,
          webContents: { send: (name) => notifications.push(name) }
        }
      }
    }
  )
  const main = load('src/main/settings.ts')
  let retired = 0
  let retirement = Promise.resolve()
  main.onCaptureTargetChange(() => {
    retired++
    return retirement
  })
  assert.equal(main.settings.voice.audioAppId, '')
  assert.equal(writes.length, 0)
  assert.deepEqual(notifications, [])

  const save = (voice) => handlers.get('updateAppSettings')({}, { voice })
  await save(legacyVoice())
  assert.equal(retired, 0, 'saving the migrated default is not a target change')
  assert.equal(writes[0].voice.audioDeviceId, undefined)
  await save(legacyVoice({ audioSource: 'system', audioAppId: 'selected-app' }))
  assert.equal(retired, 1)

  const gate = deferred()
  retirement = gate.promise
  const saving = save(legacyVoice())
  await tick()
  assert.equal(retired, 2)
  assert.equal(main.settings.voice.audioAppId, 'selected-app')
  assert.equal(writes.length, 2)
  gate.resolve()
  await saving
  assert.equal(main.settings.voice.audioAppId, '')
  assert.equal(main.settings.voice.stt.apiKey, 'offline-key')
  assert.ok(notifications.every((name) => name === 'app-settings-changed'))
})

function captureFixture(options = {}) {
  const requests = []
  const released = []
  const subscriptions = new Map()
  const worklets = []
  const contexts = []
  const forbidden = []
  const video = {
    stopCount: 0,
    stop() {
      this.stopCount++
    }
  }
  const audio = {
    stopCount: 0,
    constraints: [],
    stop() {
      this.stopCount++
    },
    applyConstraints: async function (value) {
      this.constraints.push(plain(value))
    },
    addEventListener: () => {}
  }
  const stream = {
    getVideoTracks: () => [video],
    getAudioTracks: () => (options.noAudio ? [] : [audio]),
    getTracks: () => (options.noAudio ? [video] : [video, audio])
  }
  const noInput = (name) => () => {
    forbidden.push(name)
    throw new Error(`forbidden input API: ${name}`)
  }
  const navigator = {
    userAgent: 'Mac offline test',
    mediaDevices: {
      getUserMedia: noInput('getUserMedia'),
      enumerateDevices: noInput('enumerateDevices'),
      getDisplayMedia: async (request) => {
        requests.push(['display', plain(request)])
        if (options.displayError) throw options.displayError
        return options.pendingStream ? options.pendingStream.promise : stream
      }
    }
  }
  const api = {
    voiceEnsureCapturePermission: async () => options.permissionGranted ?? true,
    voiceReserveCapture: async (id, owner) => requests.push(['reserve', id, owner]),
    voiceReleaseCapture: async (id) => released.push(id),
    voiceAppCaptureStart: async (app, id) => requests.push(['app', app, id]),
    voiceListAudioApps: async () => {
      requests.push(['listApps'])
      return [{ id: 'com.google.Chrome', name: 'Chrome', pid: 1 }]
    },
    voiceTestTranscribe: noInput('real STT must not be called'),
    onVoiceAppAudio: (id, onPcm, onEnded) => {
      subscriptions.set(id, { onPcm, onEnded })
      return () => subscriptions.delete(id)
    }
  }
  class AudioContext {
    state = 'running'
    destination = {}
    audioWorklet = { addModule: async () => {} }
    constructor(config) {
      this.config = config
      this.closed = false
      contexts.push(this)
    }
    createMediaStreamSource(received) {
      assert.equal(received, stream)
      return { connect: () => {} }
    }
    createGain() {
      return { gain: { value: 1 }, connect: () => {} }
    }
    async close() {
      this.closed = true
    }
  }
  class AudioWorkletNode {
    port = { onmessage: null }
    constructor() {
      worklets.push(this)
    }
    connect() {
      this.connected = true
    }
    disconnect() {
      this.connected = false
    }
  }
  const globals = {
    window: { api },
    navigator,
    AudioContext,
    AudioWorkletNode,
    document: { baseURI: 'https://offline.invalid/' },
    Error,
    DOMException
  }
  const load = createLoader({}, globals)
  const { AudioCaptureSession } = load('src/renderer/src/voice/audio/capture.ts')
  const segments = [],
    levels = []
  const callbacks = {
    onSegment: (segment) => segments.push(segment),
    onLevel: (db) => levels.push(db),
    onEnded: () => {}
  }
  const config = (appId = '') => ({ source: 'system', appId, vad: plain(defaultVoiceConfig.vad) })
  return {
    AudioCaptureSession,
    requests,
    released,
    subscriptions,
    worklets,
    contexts,
    forbidden,
    video,
    audio,
    stream,
    globals,
    callbacks,
    config,
    segments,
    levels
  }
}

test('actual system-output renderer path requests display loopback only and retains VAD/cleanup', async () => {
  const f = captureFixture()
  const session = await f.AudioCaptureSession.start(f.config(), f.callbacks, {
    id: 'system',
    owner: 'voice'
  })
  assert.deepEqual(f.requests, [
    ['reserve', 'system', 'voice'],
    ['display', { video: true, audio: true }]
  ])
  assert.equal(f.video.stopCount, 1)
  assert.deepEqual(f.audio.constraints, [
    { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
  ])
  assert.equal(f.contexts[0].config.sampleRate, 16000)
  for (let i = 0; i < 12; i++)
    f.worklets[0].port.onmessage({ data: new Float32Array(320).fill(0.5) })
  session.flush()
  assert.equal(f.segments.length, 1)
  assert.equal(f.segments[0].durationMs, 240)
  assert.equal(f.levels.length, 2)
  await Promise.all([session.stop(), session.stop()])
  assert.deepEqual(f.released, ['system'])
  assert.equal(f.audio.stopCount, 1)
  assert.equal(f.contexts[0].closed, true)
  assert.equal(f.subscriptions.size, 0)
  assert.deepEqual(f.forbidden, [])
})

test('actual application-output renderer path uses only ID-scoped native capture and the same VAD', async () => {
  const f = captureFixture()
  const session = await f.AudioCaptureSession.start(f.config('com.google.Chrome'), f.callbacks, {
    id: 'chrome',
    owner: 'test'
  })
  assert.deepEqual(f.requests, [
    ['reserve', 'chrome', 'test'],
    ['app', 'com.google.Chrome', 'chrome']
  ])
  f.subscriptions.get('chrome').onPcm(new Float32Array(320 * 12).fill(0.5))
  session.flush()
  assert.equal(f.segments.length, 1)
  assert.equal(f.segments[0].durationMs, 240)
  assert.equal(f.contexts.length, 0)
  await session.stop()
  assert.deepEqual(f.released, ['chrome'])
  assert.deepEqual(f.forbidden, [])
})

test('denied system-audio permission blocks capture before any source is opened', async () => {
  const f = captureFixture({ permissionGranted: false })
  await assert.rejects(
    f.AudioCaptureSession.start(f.config('com.google.Chrome'), f.callbacks, {
      id: 'chrome',
      owner: 'voice'
    }),
    /系统音频录制权限/
  )
  assert.deepEqual(f.requests, [])
  assert.deepEqual(f.released, [])
  assert.deepEqual(f.forbidden, [])
})

test('unsupported stale capture commands fail closed without opening input or broadening to output', async () => {
  const f = captureFixture()
  await assert.rejects(
    f.AudioCaptureSession.start(
      { ...f.config('stale-app'), source: 'microphone', deviceId: 'old-input' },
      f.callbacks
    ),
    /仅支持系统或指定应用输出/
  )
  assert.deepEqual(f.requests, [])
  assert.deepEqual(f.forbidden, [])
})

test('output failures never fall back to an input device', async () => {
  for (const options of [
    { noAudio: true },
    { displayError: new DOMException('denied', 'NotAllowedError') }
  ]) {
    const f = captureFixture(options)
    await assert.rejects(
      f.AudioCaptureSession.start(f.config(), f.callbacks, { id: 'failure' }),
      /系统音频|系统声音/
    )
    assert.deepEqual(f.released, ['failure'])
    assert.equal(f.subscriptions.size, 0)
    assert.deepEqual(f.forbidden, [])
  }
})

test('cancelled pending output acquisition disposes its late stream without starting Web Audio', async () => {
  const pendingStream = deferred()
  const f = captureFixture({ pendingStream })
  const controller = new AbortController()
  const starting = f.AudioCaptureSession.start(f.config(), f.callbacks, {
    id: 'cancel',
    signal: controller.signal
  })
  const rejected = assert.rejects(starting, /取消/)
  await tick()
  controller.abort()
  pendingStream.resolve(f.stream)
  await rejected
  assert.deepEqual(f.released, ['cancel'])
  assert.equal(f.audio.stopCount, 1)
  assert.equal(f.contexts.length, 0)
  assert.deepEqual(f.forbidden, [])
})

// Isolated hook host: execute real settings and test-button effects, without a DOM or devices.
function hookView() {
  const slots = []
  let index = 0
  const effects = []
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
  const hooks = {
    useState(initial) {
      const i = index++
      if (!(i in slots)) slots[i] = initial
      return [
        slots[i],
        (value) => {
          slots[i] = typeof value === 'function' ? value(slots[i]) : value
        }
      ]
    },
    useRef(initial) {
      return (slots[index++] ??= { current: initial })
    },
    useCallback(fn, deps) {
      const i = index++
      if (!same(slots[i]?.deps, deps)) slots[i] = { deps, fn }
      return slots[i].fn
    },
    useEffect(fn, deps) {
      const i = index++
      if (same(slots[i]?.deps, deps)) return
      effects.push(() => {
        slots[i]?.cleanup?.()
        slots[i] = { deps, cleanup: fn() }
      })
    }
  }
  return {
    hooks,
    render(component, props) {
      index = 0
      const tree = component(props)
      effects.splice(0).forEach((run) => run())
      return tree
    },
    close() {
      slots.forEach((slot) => slot?.cleanup?.())
    }
  }
}
function elements(tree, predicate) {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap((child) => elements(child, predicate))
  return [
    ...(predicate(tree) ? [tree] : []),
    ...elements(tree.props?.children, predicate),
    ...elements(tree.props?.control, predicate)
  ]
}

test('real settings mount, app refresh, selections and test button have no input-device calls or automatic capture', async (t) => {
  const f = captureFixture()
  const settingsView = hookView(),
    testView = hookView()
  t.after(() => {
    settingsView.close()
    testView.close()
  })
  let currentHooks = settingsView.hooks
  const react = Object.fromEntries(
    Object.keys(currentHooks).map((name) => [name, (...args) => currentHooks[name](...args)])
  )
  const stubs = {
    react,
    'lucide-react': {
      AudioLines: 'AudioLines',
      Check: 'Check',
      Eye: 'Eye',
      EyeOff: 'EyeOff',
      RefreshCw: 'RefreshCw',
      Square: 'Square'
    },
    '@/lib/utils/env': { isMac: true, isWindows: false },
    '@/voice/LevelMeter': { LevelMeter: 'LevelMeter' },
    '@/voice/audio/capture': {
      AudioCaptureSession: f.AudioCaptureSession,
      CAPTURE_SAMPLE_RATE: 16000
    },
    '@/voice/audio/wav': createLoader()('src/renderer/src/voice/audio/wav.ts')
  }
  for (const component of ['Button', 'Input', 'Slider', 'Switch', 'Textarea']) {
    stubs[`@/components/ui/${component.toLowerCase()}`] = { [component]: component }
  }
  const { VoiceSettings } = createLoader(
    stubs,
    f.globals
  )('src/renderer/src/settings/VoiceSettings.tsx')
  let config = plain(defaultVoiceConfig)
  const props = () => ({
    value: config,
    onChange: (value) => {
      config = value
    }
  })
  let tree = settingsView.render(VoiceSettings, props())
  await tick()
  tree = settingsView.render(VoiceSettings, props())
  assert.deepEqual(f.requests, [['listApps']])
  assert.equal(elements(tree, (e) => e.props?.source === 'microphone').length, 0)
  const refresh = elements(tree, (e) => e.props?.title === '刷新正在运行的软件列表')[0]
  await refresh.props.onClick()
  const select = elements(tree, (e) => e.props?.id === 'voice-output-target')[0]
  select.props.onChange({ target: { value: 'com.google.Chrome' } })
  assert.equal(config.audioAppId, 'com.google.Chrome')
  assert.equal(config.audioSource, 'system')
  select.props.onChange({ target: { value: '' } })
  assert.equal(config.audioAppId, '')
  assert.equal(config.audioAppName, '')
  assert.deepEqual(f.requests, [['listApps'], ['listApps']])

  const captureTest = elements(tree, (e) => e.type?.name === 'CaptureTest')[0]
  assert.ok(captureTest)
  currentHooks = testView.hooks
  let testTree = testView.render(captureTest.type, { config })
  assert.equal(f.requests.length, 2, 'mounting the test does not capture')
  const button = () => elements(testTree, (e) => e.type === 'Button')[0]
  await button().props.onClick()
  assert.ok(f.requests.some(([kind]) => kind === 'display'))
  testTree = testView.render(captureTest.type, { config })
  button().props.onClick()
  await tick()
  assert.equal(f.released.length, 1)
  assert.deepEqual(f.forbidden, [])
})

test('real main display-media handler selects output loopback rather than a physical input', async () => {
  let displayHandler
  const sources = []
  const load = createLoader({
    electron: {
      ipcMain: { handle: () => {} },
      session: {
        defaultSession: {
          setDisplayMediaRequestHandler: (fn) => {
            displayHandler = fn
          }
        }
      },
      desktopCapturer: {
        getSources: async (request) => {
          sources.push(plain(request))
          return [{ id: 'screen:0' }]
        }
      }
    },
    './settings': { settings: plain(defaultConfig), onCaptureTargetChange: () => {} },
    './ai': {},
    './stt': {},
    './app-audio': {}
  })
  load('src/main/voice.ts').initVoice()
  const result = await new Promise((resolve) => displayHandler({}, resolve))
  assert.deepEqual(plain(result), { video: { id: 'screen:0' }, audio: 'loopback' })
  assert.deepEqual(sources, [{ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }])
})
