#!/usr/bin/env node
/*
 * Local synthetic-output macOS smoke test. No capture without BOTH run/consent flags.
 * Optional target input: --target-microphone --microphone-test-consent (BOTH required).
 * Input tracks are held live only, never connected, processed, stored or uploaded.
 * Offline: node tests/manual/chrome-audio-smoke.mjs --self-test
 * Live (review first): node tests/manual/chrome-audio-smoke.mjs --run \
 *   --synthetic-only-consent --helper /absolute/path/to/audio-tap
 *
 * Close/pause ALL other Chrome audio first: the helper targets the Chrome bundle,
 * NOT just our profile. The script never controls existing browser targets.
 * Permission dialogs are for the user; no TCC changes or auto-approval occur.
 * Only aggregate metrics are persisted; PCM stays in a bounded in-memory window.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { Script } from 'node:vm'

const RATE = 16000
const WINDOW = 4000
const TARGET = 997
const INTERFERENCE = 1613
const GAIN = 0.025
const MIN_TARGET = 0.001
const MAX_LEAK = 0.0002
const MAX_RATIO = 0.01 // -40 dB amplitude relative to the target.
const SETTLE_MS = 2000
const MEASURE_MS = 4000
const DEFAULT_BACKEND = 'core-audio-process-tap'
const MICROPHONE_NOT_TESTED =
  '独立 Chrome 本地页面实际开麦时的输出采集（核心验收；需双标志显式授权）'

function assertMicrophoneLive(state) {
  if (
    state.status !== 'live' ||
    !state.active ||
    state.interrupted ||
    !state.tracks.length ||
    state.tracks.some((track) => track.readyState !== 'live' || !track.enabled || track.muted)
  ) {
    throw new Error(`核心麦克风并发测试未完成: ${JSON.stringify(state)}`)
  }
}

function toneAmplitude(samples, frequency) {
  const coefficient = 2 * Math.cos((2 * Math.PI * frequency) / RATE)
  let previous = 0
  let beforePrevious = 0
  let weightSum = 0
  for (let i = 0; i < samples.length; i++) {
    const weight = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (samples.length - 1)))
    const next = samples[i] * weight + coefficient * previous - beforePrevious
    beforePrevious = previous
    previous = next
    weightSum += weight
  }
  return (
    (2 *
      Math.sqrt(
        Math.max(0, previous ** 2 + beforePrevious ** 2 - coefficient * previous * beforePrevious)
      )) /
    weightSum
  )
}

function analyze(samples) {
  let energy = 0
  let peak = 0
  for (const sample of samples) {
    if (!Number.isFinite(sample)) throw new Error('非有限 PCM 样本')
    energy += sample * sample
    peak = Math.max(peak, Math.abs(sample))
  }
  return {
    target: toneAmplitude(samples, TARGET),
    interference: toneAmplitude(samples, INTERFERENCE),
    rms: Math.sqrt(energy / samples.length),
    peak
  }
}

function judge(blocks, wantsTarget, sampleCount, allowLeak = false) {
  const reasons = []
  if (wantsTarget && sampleCount < RATE * (MEASURE_MS / 1000) * 0.7) {
    reasons.push('有效 PCM 不足，不能以 started/静音补零证明采集成功')
  }
  if (sampleCount > RATE * (MEASURE_MS / 1000) * 1.3) reasons.push('PCM 速率异常或存在重叠输出')
  const audible = blocks.filter((block) => block.target >= MIN_TARGET).length
  if (wantsTarget && (blocks.length === 0 || audible / blocks.length < 0.8)) {
    reasons.push('997 Hz 目标音缺失或不连续')
  }
  if (blocks.some((block) => block.peak >= 0.99)) reasons.push('PCM 削波或格式异常')
  if (!allowLeak) {
    // 应用范围采集必须证明非目标音被隔离；系统回退后范围本为全系统，隔离断言不适用。
    if (blocks.some((block) => block.interference > MAX_LEAK))
      reasons.push('1613 Hz 非目标音绝对泄漏超标')
    if (
      wantsTarget &&
      blocks.some(
        (block) => block.target >= MIN_TARGET && block.interference / block.target > MAX_RATIO
      )
    ) {
      reasons.push('1613 Hz 相对泄漏超过 -40 dB')
    }
    if (!wantsTarget && blocks.some((block) => block.rms > MAX_LEAK || block.target > MAX_LEAK)) {
      reasons.push('目标静音时仍采入可测音频')
    }
  }
  return {
    status: reasons.length ? 'FAIL' : 'PASS',
    reasons,
    samples: sampleCount,
    blocks: blocks.length,
    audibleBlocks: audible,
    maxTargetAmplitude: Math.max(0, ...blocks.map((block) => block.target)),
    maxInterferenceAmplitude: Math.max(0, ...blocks.map((block) => block.interference)),
    maxRms: Math.max(0, ...blocks.map((block) => block.rms)),
    maxLeakRatio: Math.max(
      0,
      ...blocks
        .filter((block) => block.target >= MIN_TARGET)
        .map((block) => block.interference / block.target)
    ),
    evidence: allowLeak
      ? wantsTarget
        ? 'fallback-system-scope; target present, isolation not assertable'
        : 'fallback-system-scope; negative isolation not assertable'
      : wantsTarget
        ? 'measured-target-and-isolation'
        : 'negative-only; requires positive bracketing'
  }
}

// Decode across arbitrary pipe chunk boundaries; never retain a recording.
class Meter {
  buffer = new Float32Array(WINDOW)
  partial = Buffer.alloc(0)
  used = 0
  samples = 0
  blocks = []
  measuring = false

  reset() {
    this.used = 0
    this.samples = 0
    this.blocks = []
    this.measuring = true
  }

  accept(chunk) {
    const bytes = this.partial.length ? Buffer.concat([this.partial, chunk]) : chunk
    const complete = bytes.length - (bytes.length % 4)
    for (let offset = 0; offset < complete; offset += 4) {
      const sample = bytes.readFloatLE(offset)
      if (!Number.isFinite(sample)) throw new Error('非有限 PCM 样本')
      if (!this.measuring) continue
      this.samples++
      this.buffer[this.used++] = sample
      if (this.used === WINDOW) {
        if (this.blocks.length >= 64) throw new Error('测量窗口溢出/PCM 速率异常')
        this.blocks.push(analyze(this.buffer))
        this.used = 0
      }
    }
    this.partial = Buffer.from(bytes.subarray(complete))
  }

  finish(wantsTarget, allowLeak = false) {
    this.measuring = false
    // Include a sufficiently long final partial window in leak detection.
    if (this.used >= WINDOW / 2) this.blocks.push(analyze(this.buffer.subarray(0, this.used)))
    return judge(this.blocks, wantsTarget, this.samples, allowLeak)
  }
}

// This function is serialized into our local page, not evaluated in Node.
function testPage(allowMicrophone = false) {
  let microphoneStream
  let microphoneGeneration = 0
  let microphoneStatus = 'not-requested'
  let microphoneError
  let microphoneInterrupted = false
  const showMicrophone = (text) => {
    globalThis.document.getElementById('microphone').textContent = text
  }
  const stopMicrophone = () => {
    microphoneGeneration++
    microphoneStream?.getTracks().forEach((track) => track.stop())
    microphoneStream = undefined
    microphoneStatus = 'stopped'
    showMicrophone('麦克风已关闭')
  }
  globalThis.addEventListener('pagehide', stopMicrophone)
  let context
  let oscillator
  let gain
  let analyzer
  const frequency = globalThis.location.pathname.endsWith('/chrome') ? 997 : 1613
  globalThis.smoke = {
    startMicrophone() {
      if (!allowMicrophone) throw new Error('未显式允许目标页面开麦')
      stopMicrophone()
      const generation = microphoneGeneration
      microphoneStatus = 'requesting'
      microphoneInterrupted = false
      microphoneError = undefined
      showMicrophone('等待真实麦克风授权（最多 120 秒）；请自行决定 Chrome/系统弹窗')
      // Hold live input tracks only. Never connect, read, record or upload microphone samples.
      globalThis.navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then((stream) => {
          if (generation !== microphoneGeneration) {
            stream.getTracks().forEach((track) => track.stop())
            return
          }
          microphoneStream = stream
          microphoneStatus = 'live'
          for (const track of stream.getTracks()) {
            const interrupted = () => {
              microphoneInterrupted = true
            }
            track.addEventListener('ended', interrupted)
            track.addEventListener('mute', interrupted)
          }
          showMicrophone('正在使用真实麦克风；输入不处理、不播放、不保存、不上传')
        })
        .catch((error) => {
          if (generation !== microphoneGeneration) return
          microphoneStatus = 'error'
          microphoneError = String(error)
          showMicrophone(`麦克风测试失败：${microphoneError}`)
        })
    },
    stopMicrophone,
    microphoneState() {
      return {
        status: microphoneStatus,
        error: microphoneError,
        active: microphoneStream?.active ?? false,
        interrupted: microphoneInterrupted,
        tracks:
          microphoneStream?.getAudioTracks().map((track) => ({
            readyState: track.readyState,
            enabled: track.enabled,
            muted: track.muted
          })) ?? []
      }
    },
    async set(scene, active) {
      globalThis.document.getElementById('scene').textContent = scene
      if (active && !context) {
        context = new globalThis.AudioContext()
        oscillator = context.createOscillator()
        oscillator.type = 'sine'
        oscillator.frequency.value = frequency
        gain = context.createGain()
        gain.gain.value = 0
        analyzer = context.createAnalyser()
        analyzer.fftSize = 2048
        oscillator.connect(gain).connect(analyzer).connect(context.destination)
        oscillator.start()
      }
      if (context) {
        await context.resume()
        gain.gain.setTargetAtTime(active ? 0.025 : 0, context.currentTime, 0.01)
      }
      globalThis.document.getElementById('tone').textContent =
        `${frequency} Hz / ${active ? '低音量播放' : '静音'}`
    },
    state() {
      const samples = new Float32Array(2048)
      if (analyzer) analyzer.getFloatTimeDomainData(samples)
      return {
        frequency,
        state: context?.state ?? 'not-created',
        gain: gain?.gain.value ?? 0,
        rms: Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length)
      }
    }
  }
}

const pageHtml = (allowMicrophone) => `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>Chrome 定向音频：本地合成测试</title>
<style>body{font:22px system-ui;padding:32px;background:#19202a;color:#eee}p{max-width:650px}</style>
<h1>本地合成音测试</h1><h2 id="scene">尚未播放；等待脚本</h2><p id="tone">静音</p>
<p id="microphone">${allowMicrophone ? '已显式选择目标应用真实开麦测试；尚未开麦' : '本页禁止麦克风'}</p>
<p>输出只生成正弦波，不驱动浏览器原页面或使用在线服务。可选真实开麦场景只保留输入 track，
不处理、播放、保存或上传输入。关闭本窗口将中止测试并释放输入。
系统权限弹窗请自行决定；脚本不会操作权限。其他 Chrome 页面必须保持静音。</p>
<script>(${testPage.toString()})(${allowMicrophone})</script></html>`

// Temporary input to Electron, created only after explicit live-run consent.
const ELECTRON_MAIN = `
const { app, BrowserWindow, session } = require('electron')
const { createInterface } = require('node:readline')
let window
const url = process.argv[2]
const profile = process.argv[3]
app.setPath('userData', profile)
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
app.commandLine.appendSwitch('remote-debugging-port', '0')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.commandLine.appendSwitch('disable-background-networking')
app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith(new URL(url).origin + '/') })
  })
  window = new BrowserWindow({ width: 750, height: 500,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  await window.loadURL(url)
}).catch((error) => { process.stderr.write(String(error)); app.exit(1) })
app.on('window-all-closed', () => app.quit())
process.on('SIGTERM', () => app.quit())
createInterface({ input: process.stdin }).on('line', (command) => {
  if (command === 'focus' && window && !window.isDestroyed()) {
    window.show()
    app.focus({ steal: true })
    window.focus()
  }
})
process.stdin.resume()
process.stdin.on('end', () => app.quit())
`

async function bounded(promise, signal, milliseconds = 10000, label = '操作') {
  let timer
  let onAbort
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        onAbort = () => reject(signal.reason)
        if (signal.aborted) {
          onAbort()
          return
        }
        timer = setTimeout(
          () => reject(new Error(`${label}超时 (${milliseconds} ms)`)),
          milliseconds
        )
        signal.addEventListener('abort', onAbort, { once: true })
      })
    ])
  } finally {
    clearTimeout(timer)
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

async function until(check, signal, milliseconds, label) {
  const end = Date.now() + milliseconds
  while (Date.now() < end) {
    signal.throwIfAborted()
    const value = await check()
    if (value) return value
    await delay(100, undefined, { signal })
  }
  throw new Error(`${label}超时 (${milliseconds} ms)`)
}

class Cdp {
  pending = new Map()
  nextId = 0
  closing = false

  static async connect(url, scope) {
    const address = new URL(url)
    if (address.protocol !== 'ws:' || address.hostname !== '127.0.0.1')
      throw new Error('拒绝非本机 CDP')
    const connection = new Cdp()
    connection.scope = scope
    connection.socket = new WebSocket(url)
    scope.connections.push(connection)
    const socket = connection.socket
    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data))
        const request = connection.pending.get(message.id)
        if (!request) return
        connection.pending.delete(message.id)
        if (message.error) request.reject(new Error(`CDP: ${JSON.stringify(message.error)}`))
        else request.resolve(message.result)
      } catch (error) {
        scope.fail(error)
      }
    })
    socket.addEventListener('error', () => scope.fail(new Error('CDP WebSocket error')))
    socket.addEventListener('close', () => {
      for (const request of connection.pending.values()) request.reject(new Error('CDP 已关闭'))
      connection.pending.clear()
      if (!connection.closing) scope.fail(new Error('CDP 意外关闭'))
    })
    await bounded(
      new Promise((resolveOpen) => socket.addEventListener('open', resolveOpen, { once: true })),
      scope.signal
    )
    return connection
  }

  async call(method, params = {}, sessionId, signal = this.scope.signal) {
    const id = ++this.nextId
    try {
      return await bounded(
        new Promise((resolveCall, reject) => {
          this.pending.set(id, { resolve: resolveCall, reject })
          this.socket.send(
            JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })
          )
        }),
        signal,
        10000,
        method
      )
    } finally {
      this.pending.delete(id)
    }
  }

  async page(url) {
    const target = await until(
      async () => {
        const { targetInfos } = await this.call('Target.getTargets')
        return targetInfos.find((item) => item.type === 'page' && item.url === url)
      },
      this.scope.signal,
      20000,
      '自有测试页加载'
    )
    const { sessionId } = await this.call('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true
    })
    const page = {
      targetId: target.targetId,
      front: () => this.call('Page.bringToFront', {}, sessionId),
      evaluate: async (expression, signal = this.scope.signal) => {
        const result = await this.call(
          'Runtime.evaluate',
          { expression, awaitPromise: true, returnByValue: true },
          sessionId,
          signal
        )
        if (result.exceptionDetails)
          throw new Error(`测试页执行失败: ${JSON.stringify(result.exceptionDetails)}`)
        return result.result.value
      }
    }
    await until(
      () => page.evaluate('typeof globalThis.smoke === "object"'),
      this.scope.signal,
      10000,
      '测试页脚本就绪'
    )
    return page
  }

  close() {
    this.closing = true
    this.socket.close()
  }
}

function lines(stream, handler, scope) {
  let text = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    try {
      text += chunk
      if (text.length > 65536) throw new Error('stderr 控制行缓冲溢出')
      let newline
      while ((newline = text.indexOf('\n')) >= 0) {
        const line = text.slice(0, newline).trim()
        text = text.slice(newline + 1)
        if (line) handler(line)
      }
    } catch (error) {
      scope.fail(error)
    }
  })
  stream.on('end', () => {
    if (text.trim()) {
      try {
        handler(text.trim())
      } catch (error) {
        scope.fail(error)
      }
    }
  })
}

function ownChild(scope, executable, args, name, environment = process.env) {
  const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], env: environment })
  const owned = { child, name, stopping: false, stopPromise: null }
  const closed = new Promise((resolveClose) => {
    child.on('error', (error) => scope.fail(new Error(`${name}: ${error.message}`)))
    child.once('close', (code, signal) => {
      resolveClose()
      if (!owned.stopping)
        scope.fail(new Error(`${name} 意外退出 (code=${code}, signal=${signal})`))
    })
  })
  child.stdin.on('error', (error) => {
    if (!owned.stopping) scope.fail(error)
  })
  child.stdout.on('error', (error) => scope.fail(error))
  child.stderr.on('error', (error) => scope.fail(error))
  owned.stop = () => {
    if (owned.stopPromise) return owned.stopPromise
    owned.stopping = true
    owned.stopPromise = (async () => {
      child.stdin.end()
      child.kill('SIGTERM')
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 4000)
      try {
        await bounded(closed, new AbortController().signal, 7000, `${name} 退出`)
      } finally {
        clearTimeout(killTimer)
      }
    })()
    return owned.stopPromise
  }
  scope.children.push(owned)
  return owned
}

async function startHelper(scope, helper, expectedBackend, permissionMs, report) {
  const owned = ownChild(scope, helper, ['capture', 'com.google.Chrome'], 'audio-tap')
  const meter = new Meter()
  let started = false
  let format = false
  lines(
    owned.child.stderr,
    (line) => {
      // Native/macOS diagnostics may share stderr; never confuse them with readiness.
      if (!line.startsWith('{')) {
        report.nativeDiagnosticLines++
        return
      }
      const event = JSON.parse(line)
      if (event.event === 'error') throw new Error(`helper: ${String(event.message)}`)
      if (event.event === 'started') {
        if (event.backend !== expectedBackend)
          throw new Error(`backend 不符: ${String(event.backend)}; 预期 ${expectedBackend}`)
        started = true
        report.handshakes.push({ backend: event.backend, waiting: event.waiting ?? null })
      }
      if (event.event === 'format') {
        if (event.sampleRate !== RATE || event.channels !== 1)
          throw new Error(`format 不符: ${JSON.stringify(event)}`)
        if (event.encoding !== undefined && !['f32le', 'float32le'].includes(event.encoding)) {
          throw new Error(`encoding 不符: ${String(event.encoding)}`)
        }
        format = true
      }
      if (event.event === 'fallback') {
        // 双工盲区回退：采集范围切到全系统，之后的隔离断言自动放宽，只验证目标音存在。
        report.fallbacks.push({
          mode: typeof event.mode === 'string' ? event.mode : null,
          reason: typeof event.reason === 'string' ? event.reason : null,
          at: new Date().toISOString()
        })
        process.stdout.write(
          `helper 回退: mode=${String(event.mode)} reason=${String(event.reason)}（系统范围采集）\n`
        )
      }
    },
    scope
  )
  owned.child.stdout.on('data', (chunk) => {
    try {
      meter.accept(chunk)
    } catch (error) {
      scope.fail(error)
    }
  })
  process.stdout.write(
    '等待 helper armed；若出现系统授权弹窗，请自行决定。armed 不代表采音成功。\n'
  )
  await until(() => started, scope.signal, permissionMs, 'helper 授权/启动')
  return {
    meter,
    verifyFormat() {
      if (!format) throw new Error('缺少 16000 Hz mono format 控制事件')
    },
    async stop() {
      await owned.stop()
      if (meter.partial.length) throw new Error('helper 退出时留下非 Float32 对齐字节')
    }
  }
}

async function findElectron(explicit) {
  if (explicit) return explicit
  let directory = dirname(fileURLToPath(import.meta.url))
  while (true) {
    const candidate = join(
      directory,
      'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
    )
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      /* Try the parent checkout. */
    }
    const parent = dirname(directory)
    if (parent === directory)
      throw new Error('找不到 Electron；请指定 --electron /absolute/path/to/Electron')
    directory = parent
  }
}

async function live(options) {
  const abort = new AbortController()
  const scope = {
    signal: abort.signal,
    children: [],
    connections: [],
    fail(error) {
      if (!abort.signal.aborted)
        abort.abort(error instanceof Error ? error : new Error(String(error)))
    }
  }
  const report = {
    startedAt: new Date().toISOString(),
    status: 'FAIL',
    consent: 'synthetic-output-only; other Chrome audio confirmed paused by operator',
    targetMicrophone: {
      requested: options.targetMicrophone,
      consent: options.targetMicrophone
        ? 'local input tracks only; no processing/storage/upload'
        : null,
      status: options.targetMicrophone ? 'INCOMPLETE' : 'NOT_TESTED'
    },
    helper: options.helper,
    expectedBackend: options.backend,
    frequencies: { target: TARGET, interference: INTERFERENCE, generatorGain: GAIN },
    thresholds: {
      minimumTargetAmplitude: MIN_TARGET,
      maximumLeakAmplitude: MAX_LEAK,
      maximumLeakRatio: MAX_RATIO
    },
    waitSeconds: options.waitSeconds,
    nativeDiagnosticLines: 0,
    handshakes: [],
    fallbacks: [],
    scenarios: [],
    cleanupErrors: [],
    notTested: [
      MICROPHONE_NOT_TESTED,
      '牛客/真实面试页面开麦场景（未驱动用户页面；本地页面通过不代表其已验证）',
      '目标应用 fake-device 合成麦克风并发（本脚本未实现；不能替代物理双工验收）',
      '物理输出设备切换（未授权）',
      'Chrome 音频 helper 杀进程/重启（未授权）',
      '首次 HAL 音频服务创建/空进程集合：独立 profile 无法证明已有 Chrome 没有 HAL 客户端',
      'off-display / 多显示器',
      '完整 Chrome 退出：不会关闭用户已有 Chrome',
      '应用设置保存、formal/test lease、重复 stop：本脚本直连 native helper',
      'NetEase、system-loopback 回归；真实 STT/LLM'
    ]
  }
  const interrupted = () => scope.fail(new Error('用户中止测试'))
  process.on('SIGINT', interrupted)
  process.on('SIGTERM', interrupted)
  let directory
  let server
  let chromePage
  try {
    if (process.platform !== 'darwin') throw new Error('仅支持 macOS')
    if (typeof WebSocket === 'undefined')
      throw new Error('需要内置 WebSocket 的 Node.js 22+（推荐 22.15+）')
    const electron = await findElectron(options.electron)
    for (const executable of [options.helper, options.chrome, electron]) {
      if (!isAbsolute(executable)) throw new Error(`必须使用绝对路径: ${executable}`)
      await access(executable, constants.X_OK)
    }
    directory = await mkdtemp(join(tmpdir(), 'chrome-audio-smoke-'))
    const token = randomUUID()
    server = createServer((request, response) => {
      if (
        ![`/${token}/chrome`, `/${token}/electron`].includes(request.url) ||
        request.method !== 'GET'
      ) {
        response.writeHead(404).end()
        return
      }
      const allowMicrophone = options.targetMicrophone && request.url === `/${token}/chrome`
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy':
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; frame-ancestors 'none'",
        'Permissions-Policy': `microphone=${allowMicrophone ? '(self)' : '()'}, camera=(), display-capture=()`
      })
      response.end(pageHtml(allowMicrophone))
    })
    server.on('error', (error) => scope.fail(error))
    await bounded(
      new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen)),
      scope.signal
    )
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('HTTP 监听失败')
    const baseUrl = `http://127.0.0.1:${address.port}/${token}`
    const chromeUrl = `${baseUrl}/chrome`
    const electronUrl = `${baseUrl}/electron`
    const profile = join(directory, 'chrome-profile')
    const chrome = ownChild(
      scope,
      options.chrome,
      [
        `--user-data-dir=${profile}`,
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--disable-default-apps',
        '--disable-extensions',
        '--autoplay-policy=no-user-gesture-required',
        // 开麦场景已由双标志显式授权；此处只自动允许本机测试页的浏览器站点权限，
        // macOS TCC 系统授权仍完全由用户决定。
        '--use-fake-ui-for-media-stream',
        chromeUrl
      ],
      '独立 Chrome'
    )
    chrome.child.stdout.resume()
    chrome.child.stderr.resume()
    const endpoint = await until(
      async () => {
        try {
          const [port, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8'))
            .trim()
            .split('\n')
          if (!/^\d+$/.test(port) || !path?.startsWith('/devtools/browser/')) return null
          return `ws://127.0.0.1:${port}${path}`
        } catch (error) {
          if (error.code === 'ENOENT') return null
          throw error
        }
      },
      scope.signal,
      30000,
      '独立 Chrome 调试端点'
    )
    const chromeCdp = await Cdp.connect(endpoint, scope)
    chromePage = await chromeCdp.page(chromeUrl)
    const mainFile = join(directory, 'interference.cjs')
    await writeFile(mainFile, ELECTRON_MAIN)
    await mkdir(join(directory, 'electron-profile'))
    const environment = { ...process.env }
    delete environment.ELECTRON_RUN_AS_NODE
    const interferer = ownChild(
      scope,
      electron,
      [mainFile, electronUrl, join(directory, 'electron-profile')],
      '合成干扰 Electron',
      environment
    )
    interferer.child.stdout.resume()
    let electronEndpoint
    lines(
      interferer.child.stderr,
      (line) => {
        const match =
          /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[\w-]+)/.exec(line)
        if (match) electronEndpoint = match[1]
      },
      scope
    )
    await until(() => electronEndpoint, scope.signal, 30000, 'Electron 调试端点')
    const electronCdp = await Cdp.connect(electronEndpoint, scope)
    const electronPage = await electronCdp.page(electronUrl)

    const setScene = async (name, active, interfere = true) => {
      process.stdout.write(`场景: ${name}\n`)
      await chromePage.evaluate(`smoke.set(${JSON.stringify(name)}, ${active})`)
      await electronPage.evaluate(`smoke.set(${JSON.stringify(name)}, ${interfere})`)
    }
    const measure = async (capture, name, active, options = {}) => {
      await setScene(name, active)
      // 双工回退约需 3-4 秒生效（盲区判定 ≥2 秒 + 切换 SCK）；开麦场景给更长的稳定期。
      await delay(options.settleMs ?? SETTLE_MS, undefined, { signal: scope.signal })
      const chromeState = await chromePage.evaluate('smoke.state()')
      const electronState = await electronPage.evaluate('smoke.state()')
      if (
        electronState.state !== 'running' ||
        electronState.rms < 0.005 ||
        electronState.frequency !== INTERFERENCE
      ) {
        throw new Error('干扰源 WebAudio 未实际运行；不能宣称隔离通过')
      }
      if (
        active &&
        (chromeState.state !== 'running' ||
          chromeState.rms < 0.005 ||
          chromeState.frequency !== TARGET)
      ) {
        throw new Error('Chrome 合成音源未实际运行')
      }
      if (!active && chromeState.rms > MAX_LEAK) throw new Error('Chrome 合成音源没有静音')
      capture.meter.reset()
      await delay(MEASURE_MS, undefined, { signal: scope.signal })
      capture.verifyFormat()
      const result = {
        name,
        sourceState: { chrome: chromeState, electron: electronState },
        fallbackActive: report.fallbacks.length > 0,
        ...capture.meter.finish(active, report.fallbacks.length > 0)
      }
      report.scenarios.push(result)
      process.stdout.write(
        `${result.status}: ${name}; target=${result.maxTargetAmplitude.toFixed(6)}, leak=${result.maxInterferenceAmplitude.toFixed(6)}\n`
      )
      if (result.status !== 'PASS') throw new Error(`${name}: ${result.reasons.join('; ')}`)
    }

    await setScene('先监听后播放：保持无 AudioContext', false, false)
    assert.equal((await chromePage.evaluate('smoke.state()')).state, 'not-created')
    let capture = await startHelper(
      scope,
      options.helper,
      options.backend,
      options.permissionMs,
      report
    )
    await delay(options.waitSeconds * 1000, undefined, { signal: scope.signal })
    await chromePage.front()
    await measure(capture, '先监听 60 秒以上，再播放目标音 + 干扰音', true)
    await capture.stop()
    await chromePage.front()
    await setScene('目标音已播放，再启动新采集', true)
    await delay(SETTLE_MS, undefined, { signal: scope.signal })
    capture = await startHelper(
      scope,
      options.helper,
      options.backend,
      options.permissionMs,
      report
    )
    await measure(capture, '已播放后监听 + Electron 干扰', true)
    const { windowId } = await chromeCdp.call('Browser.getWindowForTarget', {
      targetId: chromePage.targetId
    })
    if (options.targetMicrophone) {
      try {
        await chromeCdp.call('Browser.setWindowBounds', {
          windowId,
          bounds: { windowState: 'normal' }
        })
        await setScene('请求 Chrome 真实麦克风；输入不处理/保存/上传，请自行授权', true)
        await chromePage.front()
        await chromePage.evaluate('smoke.startMicrophone()')
        const before = await until(
          async () => {
            const state = await chromePage.evaluate('smoke.microphoneState()')
            return state.status === 'requesting' ? null : state
          },
          scope.signal,
          120000,
          'Chrome/系统麦克风授权'
        )
        assertMicrophoneLive(before)
        await measure(
          capture,
          'Chrome 实际麦克风使用中，仍采到 997 Hz（进入双工才回退；本页为裸麦，报告记录 fallbacks）',
          true,
          { settleMs: 8000 }
        )
        const after = await chromePage.evaluate('smoke.microphoneState()')
        assertMicrophoneLive(after)
        report.targetMicrophone.before = before
        report.targetMicrophone.after = after
        // Keep the same microphone tracks live while replacing only the output capture.
        await capture.stop()
        capture = await startHelper(
          scope,
          options.helper,
          options.backend,
          options.permissionMs,
          report
        )
        assertMicrophoneLive(await chromePage.evaluate('smoke.microphoneState()'))
        await measure(
          capture,
          'Chrome 已开麦再启动监听，仍采到 997 Hz（进入双工才回退，见报告 fallbacks）',
          true,
          {
            settleMs: 8000
          }
        )
        const afterRestart = await chromePage.evaluate('smoke.microphoneState()')
        assertMicrophoneLive(afterRestart)
        report.targetMicrophone.afterCaptureRestart = afterRestart
      } catch (error) {
        report.targetMicrophone.status = 'FAIL'
        report.targetMicrophone.error = String(error)
        throw error
      } finally {
        await chromePage.evaluate('smoke.stopMicrophone()', new AbortController().signal)
      }
      report.targetMicrophone.fallbacks = report.fallbacks.length
      report.targetMicrophone.status = 'PASS'
      report.notTested = report.notTested.filter((item) => item !== MICROPHONE_NOT_TESTED)
    }
    // CDP Page.bringToFront cannot activate another macOS application.
    interferer.child.stdin.write('focus\n')
    await until(
      async () =>
        (await electronPage.evaluate('document.hasFocus()')) &&
        !(await chromePage.evaluate('document.hasFocus()')),
      scope.signal,
      10000,
      'Electron 前台且 Chrome 后台（未确认则不能宣称后台通过）'
    )
    await measure(capture, '后台 Chrome + 前台 Electron 干扰', true)
    await chromeCdp.call('Browser.setWindowBounds', {
      windowId,
      bounds: { windowState: 'minimized' }
    })
    await until(
      async () => {
        const { bounds } = await chromeCdp.call('Browser.getWindowBounds', { windowId })
        return bounds.windowState === 'minimized'
      },
      scope.signal,
      5000,
      'Chrome 最小化'
    )
    await measure(capture, '最小化 Chrome + Electron 干扰', true)
    await measure(capture, 'Chrome 静音，仅 Electron 1613 Hz 干扰', false)
    await measure(capture, '静音后恢复 Chrome 997 Hz', true)
    await chromeCdp.call('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
    await capture.stop()
    scope.signal.throwIfAborted()
    report.status = 'PASS'
  } catch (error) {
    report.error = String(scope.signal.aborted ? scope.signal.reason : error)
    process.stderr.write(`FAIL: ${report.error}\n`)
  } finally {
    if (options.targetMicrophone && chromePage) {
      // Use a fresh signal so Ctrl-C/native failure cannot skip releasing input tracks.
      try {
        await chromePage.evaluate('smoke.stopMicrophone()', new AbortController().signal)
      } catch (error) {
        report.cleanupErrors.push(`麦克风 track 清理: ${String(error)}`)
      }
    }
    for (const connection of scope.connections) {
      try {
        connection.close()
      } catch (error) {
        report.cleanupErrors.push(`CDP 关闭: ${String(error)}`)
      }
    }
    for (const child of [...scope.children].reverse()) {
      try {
        await child.stop()
      } catch (error) {
        report.cleanupErrors.push(`${child.name}: ${String(error)}`)
      }
    }
    if (server) {
      server.closeAllConnections()
      await bounded(
        new Promise((resolveClose) => server.close(resolveClose)),
        new AbortController().signal,
        5000,
        'HTTP 退出'
      ).catch((error) => report.cleanupErrors.push(String(error)))
    }
    if (directory && !report.cleanupErrors.length) {
      await rm(directory, { recursive: true, force: true }).catch((error) =>
        report.cleanupErrors.push(String(error))
      )
    }
    if (report.cleanupErrors.length) {
      report.status = 'FAIL'
      report.retainedTemporaryDirectory = directory
    }
    process.removeListener('SIGINT', interrupted)
    process.removeListener('SIGTERM', interrupted)
    report.finishedAt = new Date().toISOString()
    const reportPath = resolve(options.report ?? `chrome-audio-smoke-${Date.now()}.json`)
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    process.stdout.write(`${report.status}; 仅指标报告: ${reportPath}\n`)
    if (report.status !== 'PASS') process.exitCode = 1
  }
}

async function selfTest() {
  const wave = (target, interference) =>
    Float32Array.from(
      { length: RATE * 4 },
      (_, index) =>
        target * Math.sin((2 * Math.PI * TARGET * index) / RATE) +
        interference * Math.sin((2 * Math.PI * INTERFERENCE * index) / RATE)
    )
  const evaluate = (samples, active) => {
    const meter = new Meter()
    const bytes = Buffer.alloc(samples.length * 4)
    samples.forEach((sample, index) => bytes.writeFloatLE(sample, index * 4))
    meter.reset()
    for (let offset = 0; offset < bytes.length; offset += 997)
      meter.accept(bytes.subarray(offset, offset + 997))
    assert.equal(meter.partial.length, 0)
    return meter.finish(active)
  }
  const positive = evaluate(wave(GAIN, 0), true)
  assert.equal(positive.status, 'PASS')
  assert.ok(Math.abs(positive.maxTargetAmplitude - GAIN) < 0.00001)
  assert.equal(evaluate(wave(GAIN, GAIN), true).status, 'FAIL')
  assert.equal(evaluate(wave(0, GAIN), false).status, 'FAIL')
  assert.equal(evaluate(wave(0, 0), true).status, 'FAIL')
  assert.equal(evaluate(wave(0, 0), false).status, 'PASS')
  assert.equal(judge([], true, 0).status, 'FAIL')
  assert.equal(evaluate(wave(GAIN, 0.0001), true).status, 'PASS')
  assert.equal(evaluate(wave(0.001, 0.0001), true).status, 'FAIL')
  assert.equal(evaluate(wave(1, 0), true).status, 'FAIL')
  assert.equal(evaluate(wave(GAIN, 0).subarray(0, WINDOW), true).status, 'FAIL')
  for (const value of [NaN, Infinity, -Infinity])
    assert.throws(() => evaluate(Float32Array.of(value), true), /非有限/)
  new Script(ELECTRON_MAIN)
  const page = (allowed, getUserMedia) => {
    const listeners = {}
    const host = {
      location: { pathname: '/chrome' },
      document: { getElementById: () => ({ textContent: '' }) },
      addEventListener: (name, callback) => {
        listeners[name] = callback
      },
      navigator: { mediaDevices: { getUserMedia } }
    }
    new Script(`(${testPage.toString()})(${allowed})`).runInNewContext(host)
    return { api: host.smoke, listeners }
  }
  const fakeStream = () => {
    const listeners = {}
    const track = {
      readyState: 'live',
      enabled: true,
      muted: false,
      stop() {
        this.readyState = 'ended'
      },
      addEventListener(name, callback) {
        listeners[name] = callback
      }
    }
    return {
      stream: { active: true, getTracks: () => [track], getAudioTracks: () => [track] },
      track,
      listeners
    }
  }
  let calls = 0
  const disabled = page(false, () => {
    calls++
    throw new Error('不应调用')
  })
  assert.throws(() => disabled.api.startMicrophone(), /未显式允许/)
  assert.equal(calls, 0)
  const input = fakeStream()
  const enabled = page(true, async (constraints) => {
    assert.equal(JSON.stringify(constraints), '{"audio":true}')
    return input.stream
  })
  enabled.api.startMicrophone()
  await delay(0)
  assertMicrophoneLive(enabled.api.microphoneState())
  input.listeners.mute()
  assert.throws(() => assertMicrophoneLive(enabled.api.microphoneState()), /未完成/)
  enabled.listeners.pagehide()
  enabled.api.stopMicrophone()
  assert.equal(input.track.readyState, 'ended')
  assert.equal(enabled.api.microphoneState().active, false)
  const late = fakeStream()
  let grant
  const pending = page(
    true,
    () =>
      new Promise((resolveGrant) => {
        grant = resolveGrant
      })
  )
  pending.api.startMicrophone()
  pending.api.stopMicrophone()
  grant(late.stream)
  await delay(0)
  assert.equal(late.track.readyState, 'ended')
  const denied = page(true, async () => {
    throw new Error('permission denied')
  })
  denied.api.startMicrophone()
  await delay(0)
  assert.equal(denied.api.microphoneState().status, 'error')
  assert.throws(() => assertMicrophoneLive(denied.api.microphoneState()), /permission denied/)
  process.stdout.write(
    'PASS --self-test: Goertzel 幅度/隔离、PCM 边界与嵌入脚本；麦克风默认拒绝、track 存活/中断、重复释放、页面退出、取消后延迟授权释放、授权拒绝（全部 mock，无真实设备）；未启动音频/浏览器/helper。\n'
  )
}

function main() {
  const { values } = parseArgs({
    options: {
      help: { type: 'boolean' },
      'self-test': { type: 'boolean' },
      run: { type: 'boolean' },
      'synthetic-only-consent': { type: 'boolean' },
      'target-microphone': { type: 'boolean' },
      'microphone-test-consent': { type: 'boolean' },
      helper: { type: 'string' },
      chrome: {
        type: 'string',
        default: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      },
      electron: { type: 'string' },
      backend: { type: 'string', default: DEFAULT_BACKEND },
      report: { type: 'string' },
      'wait-seconds': { type: 'string', default: '60' },
      'permission-timeout-seconds': { type: 'string', default: '120' }
    }
  })
  if (Boolean(values['target-microphone']) !== Boolean(values['microphone-test-consent'])) {
    throw new Error('--target-microphone 与 --microphone-test-consent 必须配套；未启动任何进程')
  }
  if (values['self-test']) {
    if (values.run || values['synthetic-only-consent'] || values['target-microphone'])
      throw new Error('--self-test 不能与实测标志混用')
    return selfTest()
  }
  if (values.help || !values.run) {
    process.stdout.write(
      `默认不录音。离线: --self-test\n实测: --run --synthetic-only-consent --helper /absolute/path/to/audio-tap\n` +
        `可选: --chrome PATH --electron PATH --backend NAME (默认 ${DEFAULT_BACKEND}) --report PATH\n` +
        '--wait-seconds 60 (最少 60) --permission-timeout-seconds 120\n' +
        '可选真实开麦并发: --target-microphone --microphone-test-consent（必须配套；默认禁止开麦）\n' +
        '开麦仅限独立 Chrome 本地页；输入不处理/播放/保存/上传；Chrome/系统授权由用户决定，最多等待 120 秒。\n' +
        '确认标志表示：仅允许本地合成音，其他 Chrome 音频已暂停。脚本从不触碰原有浏览器页面。\n' +
        '先监听/后播放、后台、最小化、静音恢复、仅干扰音。无需安装依赖；使用 Node.js 22+。\n'
    )
    return
  }
  if (!values['synthetic-only-consent'] || !values.helper)
    throw new Error('需要 --synthetic-only-consent 和绝对路径 --helper；未启动任何进程')
  const waitSeconds = Number(values['wait-seconds'])
  const permissionSeconds = Number(values['permission-timeout-seconds'])
  if (!Number.isFinite(waitSeconds) || waitSeconds < 60 || waitSeconds > 600)
    throw new Error('--wait-seconds 必须为 60–600')
  if (!Number.isFinite(permissionSeconds) || permissionSeconds < 10 || permissionSeconds > 600)
    throw new Error('--permission-timeout-seconds 必须为 10–600')
  return live({
    ...values,
    targetMicrophone: Boolean(values['target-microphone'] && values['microphone-test-consent']),
    waitSeconds,
    permissionMs: permissionSeconds * 1000
  })
}

Promise.resolve()
  .then(main)
  .catch((error) => {
    process.stderr.write(`FAIL: ${String(error)}\n`)
    process.exitCode = 1
  })
