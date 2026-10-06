import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app, dialog, shell, systemPreferences } from 'electron'
import type { AudioApp } from '../shared/voice'

/**
 * Per-application audio capture ("only the meeting app, not the whole system").
 *
 * Chromium can only loop back the entire system mix, so this goes through small native helpers:
 *   - macOS 13+: resources/bin/audio-tap.app (ScreenCaptureKit for legacy targets;
 *     stable Chrome on 14.4+ uses positive Core Audio process taps, see scripts/chrome-audio.swift)
 *   - Windows 10 2004+: application-loopback's ApplicationLoopback.exe (WASAPI process loopback,
 *     captures the target process tree), 48 kHz stereo PCM16 on stdout.
 * Both are normalised to 16 kHz mono float32, the rate the renderer VAD works at.
 */

const execFileAsync = promisify(execFile)

export const APP_CAPTURE_SAMPLE_RATE = 16000
const PAD_TICK_MS = 50
/** How far the source may lag the wall clock before we assume it went quiet and pad silence. */
const PAD_LAG_MS = 150
const START_TIMEOUT_MS = 8000

/**
 * 现场诊断默认关闭：`DREAMCODE_AUDIO_DIAG=1 npm run dev` 时把采集链路事实打到开发终端，
 * 用来区分「helper 没选中成员 / 没有 IO 回调 / 收到全零 / 应用侧丢失」。
 * 只统计计数与峰值，不保存、不上传任何音频内容，也不改变采集行为。
 */
const diagEnabled = process.env.DREAMCODE_AUDIO_DIAG === '1'

function diag(message: string, detail?: unknown): void {
  if (!diagEnabled) return
  console.log(`[audio-diag] ${message}`, detail === undefined ? '' : detail)
}

export function isAppCaptureSupported(): boolean {
  return process.platform === 'darwin' || (process.platform === 'win32' && process.arch === 'x64')
}

const AUDIO_CAPTURE_SETTINGS =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
let permissionDialogShown = false

/**
 * macOS 上应用与系统输出采集都受「屏幕与系统音频录制」授权控制；未授权时系统只会给出静音。
 * 因此开始监听前先检查并引导用户授权，而不是让用户面对“没有声音”。
 * `not-determined` 不算未授权：首次使用时系统自己会弹授权对话框。
 */
async function promptCapturePermission(): Promise<void> {
  if (process.platform !== 'darwin') return
  const status = systemPreferences.getMediaAccessStatus('screen')
  if (status !== 'denied' && status !== 'restricted') return
  if (permissionDialogShown) return
  permissionDialogShown = true
  const mainWindow = global.mainWindow
  if (!mainWindow || mainWindow.isDestroyed()) return
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: '需要系统音频录制权限',
    message: 'DreamCode 无法采集应用或系统声音',
    detail:
      '请在“系统设置 → 隐私与安全性 → 屏幕与系统音频录制”中允许 DreamCode（使用 npm run dev 时请允许 Electron 与 DreamCode Audio Capture），然后完全退出并重新启动 DreamCode。\n\n未授权时监听会一直没有声音。',
    buttons: ['打开系统设置', '取消'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  })
  if (response === 0) await shell.openExternal(AUDIO_CAPTURE_SETTINGS)
}

/** 采集前的权限闸门：明确未授权时弹窗引导并拒绝启动。 */
export async function ensureCapturePermission(): Promise<boolean> {
  if (process.platform !== 'darwin') return true
  const status = systemPreferences.getMediaAccessStatus('screen')
  if (status !== 'denied' && status !== 'restricted') return true
  await promptCapturePermission()
  return false
}

function unpackedPath(path: string): string {
  // Executables cannot be spawned from inside app.asar; electron-builder unpacks them next to it.
  return path.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
}

function getMacHelperPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'bin', 'audio-tap.app', 'Contents', 'MacOS', 'audio-tap')
    : join(__dirname, 'bin', 'audio-tap.app', 'Contents', 'MacOS', 'audio-tap')
}

function getWindowsLoopbackPath(): string {
  return unpackedPath(
    join(
      app.getAppPath(),
      'node_modules',
      'application-loopback',
      'bin',
      'win32-x64',
      'ApplicationLoopback.exe'
    )
  )
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

function parseHelperError(stderr: string): string | null {
  for (const line of stderr.split('\n')) {
    try {
      const event = JSON.parse(line)
      if (event?.event === 'error' && typeof event.message === 'string') return event.message
    } catch {
      // not a status line
    }
  }
  return null
}

async function listMacApps(): Promise<AudioApp[]> {
  let stdout: string
  try {
    // The helper itself gives up after 20s; leave slack so its message wins over our kill.
    ;({ stdout } = await execFileAsync(getMacHelperPath(), ['list'], { timeout: 25_000 }))
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? ''
    throw new Error(parseHelperError(stderr) ?? `读取应用列表失败：${(error as Error).message}`)
  }
  if (!stdout.trim()) throw new Error('应用列表返回为空，请确认目标应用正在运行后重试')
  try {
    const apps = JSON.parse(stdout) as AudioApp[]
    return apps.filter((item) => item.pid !== process.pid && item.id !== 'com.dreamrec.dreamcode')
  } catch {
    throw new Error(`应用列表解析失败：${stdout.slice(0, 120)}`)
  }
}

const WINDOWS_LIST_SCRIPT = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } |',
  'Select-Object Id, ProcessName, Description, MainWindowTitle | ConvertTo-Json -Compress'
].join(' ')

interface WindowsProcessRow {
  Id: number
  ProcessName: string
  Description: string | null
  MainWindowTitle: string | null
}

async function listWindowsApps(): Promise<AudioApp[]> {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      WINDOWS_LIST_SCRIPT
    ],
    { timeout: 15_000, windowsHide: true, encoding: 'utf8' }
  )
  const trimmed = stdout.trim()
  if (!trimmed) return []
  const parsed = JSON.parse(trimmed) as WindowsProcessRow | WindowsProcessRow[]
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  const byName = new Map<string, AudioApp>()
  for (const row of rows) {
    if (!row?.ProcessName || row.Id === process.pid) continue
    const id = row.ProcessName.toLowerCase()
    if (id === 'dreamcode' || byName.has(id)) continue
    const label = row.Description?.trim() || row.ProcessName
    const title = row.MainWindowTitle?.trim()
    byName.set(id, {
      id,
      name: title && title !== label ? `${label} — ${title}` : label,
      pid: row.Id
    })
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export async function listAudioApps(): Promise<AudioApp[]> {
  if (process.platform === 'darwin') return listMacApps()
  if (process.platform === 'win32') return listWindowsApps()
  return []
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/**
 * Converts interleaved PCM at any rate / channel count into 16 kHz mono float32.
 * Integer ratios (48k → 16k) use block averaging, which doubles as a crude low-pass.
 */
class MonoResampler {
  private readonly ratio: number
  private carry: number[] = []

  constructor(
    private readonly inputRate: number,
    private readonly channels: number
  ) {
    this.ratio = inputRate / APP_CAPTURE_SAMPLE_RATE
  }

  push(interleaved: Float32Array): Float32Array {
    const frames = Math.floor(interleaved.length / this.channels)
    const mono = this.carry
    for (let frame = 0; frame < frames; frame += 1) {
      let sum = 0
      for (let channel = 0; channel < this.channels; channel += 1) {
        sum += interleaved[frame * this.channels + channel]
      }
      mono.push(sum / this.channels)
    }

    if (this.inputRate === APP_CAPTURE_SAMPLE_RATE) {
      this.carry = []
      return Float32Array.from(mono)
    }

    const outCount = Math.floor(mono.length / this.ratio)
    const out = new Float32Array(outCount)
    const step = Math.round(this.ratio)
    const integerRatio = Math.abs(this.ratio - step) < 1e-6
    for (let index = 0; index < outCount; index += 1) {
      if (integerRatio) {
        let sum = 0
        for (let offset = 0; offset < step; offset += 1) sum += mono[index * step + offset]
        out[index] = sum / step
      } else {
        const position = index * this.ratio
        const base = Math.floor(position)
        const next = Math.min(base + 1, mono.length - 1)
        out[index] = mono[base] + (mono[next] - mono[base]) * (position - base)
      }
    }
    this.carry = mono.slice(Math.floor(outCount * this.ratio))
    return out
  }
}

/**
 * Keeps the output stream continuous: both helpers go quiet (no packets at all) while the
 * app plays nothing, but the VAD needs to *see* that silence to close an utterance.
 */
class SilencePadder {
  private startedAt = Date.now()
  private emitted = 0
  private readonly timer: ReturnType<typeof setInterval>

  constructor(private readonly onPcm: (samples: Float32Array) => void) {
    this.timer = setInterval(() => this.tick(), PAD_TICK_MS)
  }

  private expected(): number {
    return ((Date.now() - this.startedAt) * APP_CAPTURE_SAMPLE_RATE) / 1000
  }

  push(samples: Float32Array) {
    if (!samples.length) return
    this.onPcm(samples)
    this.emitted += samples.length
    // Source delivered faster than real time (burst after a gap): re-anchor the clock.
    if (this.emitted > this.expected()) {
      this.startedAt = Date.now() - (this.emitted * 1000) / APP_CAPTURE_SAMPLE_RATE
    }
  }

  private tick() {
    const lag = this.expected() - this.emitted
    const lagLimit = (PAD_LAG_MS * APP_CAPTURE_SAMPLE_RATE) / 1000
    if (lag <= lagLimit) return
    const padding = new Float32Array(Math.floor(lag - lagLimit / 3))
    this.onPcm(padding)
    this.emitted += padding.length
  }

  stop() {
    clearInterval(this.timer)
  }
}

/**
 * 只统计 helper 原始输出（SilencePadder 补零不算）的字节数、峰值与 RMS，每秒汇报一次。
 * 补零会让 VAD 收口，但补零帧不是真实采集，所以统计必须挂在 resampler 之前。
 */
class PcmMeter {
  private bytes = 0
  private samples = 0
  private peak = 0
  private square = 0
  private windowSamples = 0
  private windowPeak = 0
  private windowSquare = 0
  private reportedAt = Date.now()

  push(values: Float32Array): void {
    if (!diagEnabled || !values.length) return
    this.bytes += values.length * 4
    this.samples += values.length
    this.windowSamples += values.length
    for (const value of values) {
      const magnitude = Math.abs(value)
      if (magnitude > this.windowPeak) this.windowPeak = magnitude
      if (magnitude > this.peak) this.peak = magnitude
      this.square += value * value
      this.windowSquare += value * value
    }
    if (Date.now() - this.reportedAt < 1000) return
    const seconds = (Date.now() - this.reportedAt) / 1000
    diag('pcm', {
      windowSeconds: Number(seconds.toFixed(2)),
      windowSamples: this.windowSamples,
      windowPeak: Number(this.windowPeak.toFixed(5)),
      windowRms: Number(Math.sqrt(this.windowSquare / Math.max(1, this.windowSamples)).toFixed(5)),
      totalSamples: this.samples,
      totalBytes: this.bytes,
      totalPeak: Number(this.peak.toFixed(5))
    })
    this.reportedAt = Date.now()
    this.windowSamples = 0
    this.windowPeak = 0
    this.windowSquare = 0
  }

  finish(): void {
    if (!diagEnabled) return
    diag('pcm summary', {
      totalSamples: this.samples,
      totalBytes: this.bytes,
      totalPeak: Number(this.peak.toFixed(5)),
      totalRms: Number(Math.sqrt(this.square / Math.max(1, this.samples)).toFixed(5))
    })
  }
}

export interface AppCaptureHandlers {
  onPcm: (samples: Float32Array) => void
  /** The helper exited on its own (app quit, permission revoked, crash). */
  onEnded: (reason: string) => void
  /**
   * The helper switched backends mid-stream: Chrome's VoiceProcessing duplex state hides
   * app-scoped audio, so it falls back once to whole-system output capture.
   */
  onFallback?: (info: { mode: string; reason: string }) => void
}

export interface AppCapture {
  stop: () => Promise<void>
}

function float32FromBytes(bytes: Buffer): Float32Array {
  // Copy: Buffer slices may not be 4-byte aligned.
  const copy = new Uint8Array(bytes.length)
  copy.set(bytes)
  return new Float32Array(copy.buffer, 0, Math.floor(bytes.length / 4))
}

function float32FromPcm16(bytes: Buffer): Float32Array {
  const count = Math.floor(bytes.length / 2)
  const out = new Float32Array(count)
  for (let index = 0; index < count; index += 1) out[index] = bytes.readInt16LE(index * 2) / 32768
  return out
}

/** Buffers stdout so that every decoded chunk holds whole frames. */
function createFrameReader(frameBytes: number, decode: (bytes: Buffer) => void) {
  let pending = Buffer.alloc(0)
  return (chunk: Buffer) => {
    const data = pending.length ? Buffer.concat([pending, chunk]) : chunk
    const usable = data.length - (data.length % frameBytes)
    pending = usable < data.length ? Buffer.from(data.subarray(usable)) : Buffer.alloc(0)
    if (usable > 0) decode(data.subarray(0, usable))
  }
}

async function resolveWindowsPid(appId: string): Promise<number> {
  const apps = await listWindowsApps()
  const match = apps.find((item) => item.id === appId)
  if (!match) throw new Error('所选应用没有在运行，请先打开会议软件，或在设置中重新选择')
  return match.pid
}

const activeChildren = new Set<ChildProcess>()

app.on('will-quit', () => {
  activeChildren.forEach((child) => child.kill())
  activeChildren.clear()
})

/** Starts application capture. Chrome's `started` means armed, not audible or permission-confirmed. */
export async function startAppCapture(
  appId: string,
  handlers: AppCaptureHandlers,
  signal?: AbortSignal
): Promise<AppCapture> {
  if (!isAppCaptureSupported()) throw new Error('当前系统不支持按应用采集音频')
  signal?.throwIfAborted()
  const isMac = process.platform === 'darwin'
  const command = isMac ? getMacHelperPath() : getWindowsLoopbackPath()
  const args = isMac ? ['capture', appId] : [String(await resolveWindowsPid(appId))]
  signal?.throwIfAborted()
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  diag('spawn', { appId, command, args, packaged: app.isPackaged, pid: child.pid })
  activeChildren.add(child)
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  const padder = new SilencePadder((samples) => {
    if (!signal?.aborted) handlers.onPcm(samples)
  })
  const meter = isMac ? new PcmMeter() : null
  let stopped = false
  let started = false
  let stderrText = ''
  let stopPromise: Promise<void> | null = null
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise
    stopped = true
    diag('stop', { appId })
    meter?.finish()
    padder.stop()
    child.stdin?.end()
    child.kill()
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 1000)
    stopPromise = closed.finally(() => {
      clearTimeout(killTimer)
      activeChildren.delete(child)
    })
    return stopPromise
  }

  return new Promise<AppCapture>((resolve, reject) => {
    const settleStarted = (): void => {
      if (started || stopped) return
      started = true
      clearTimeout(startTimer)
      resolve({ stop })
    }
    const failStart = (message: string): void => {
      if (started) return
      started = true
      clearTimeout(startTimer)
      void stop().then(() => reject(new Error(message)))
    }
    const onAbort = (): void => {
      if (!started) failStart('音频采集启动已取消')
      else void stop()
    }
    const startTimer = setTimeout(
      () => {
        if (isMac) {
          void promptCapturePermission()
          failStart('应用音频采集启动超时（请检查「屏幕与系统音频录制」权限）')
        } else settleStarted()
      },
      isMac ? 45_000 : START_TIMEOUT_MS
    )
    signal?.addEventListener('abort', onAbort, { once: true })
    void closed.then(() => {
      clearTimeout(startTimer)
      signal?.removeEventListener('abort', onAbort)
      padder.stop()
      activeChildren.delete(child)
    })

    if (isMac) {
      let resampler = new MonoResampler(APP_CAPTURE_SAMPLE_RATE, 1)
      const read = createFrameReader(4, (bytes) => {
        const samples = float32FromBytes(bytes)
        meter?.push(samples)
        if (!stopped) padder.push(resampler.push(samples))
      })
      child.stdout.on('data', read)
      child.stderr.setEncoding('utf8')
      let pendingLine = ''
      child.stderr.on('data', (text: string) => {
        stderrText = (stderrText + text).slice(-32_768)
        pendingLine += text
        const lines = pendingLine.split('\n')
        pendingLine = lines.pop() ?? ''
        for (const line of lines) {
          try {
            const event = JSON.parse(line)
            if (event.event === 'started') {
              diag('helper armed', { waiting: event.waiting, backend: event.backend })
              settleStarted()
            }
            if (event.event === 'format') {
              diag('helper format', { sampleRate: event.sampleRate, channels: event.channels })
              resampler = new MonoResampler(Number(event.sampleRate), Number(event.channels) || 1)
            }
            if (event.event === 'fallback') {
              diag('helper fallback', { mode: event.mode, reason: event.reason })
              handlers.onFallback?.({
                mode: typeof event.mode === 'string' ? event.mode : 'unknown',
                reason: typeof event.reason === 'string' ? event.reason : ''
              })
            }
            if (event.event === 'diagnostic') {
              diag('helper', event)
            }
            if (event.event === 'error') {
              diag('helper error', { message: event.message })
              if (!started) failStart(String(event.message))
              else if (!stopped) {
                void stop()
                handlers.onEnded(String(event.message))
              }
            }
          } catch {
            // Framework diagnostics may share stderr with the JSON protocol.
          }
        }
        if (pendingLine.length > 32_768) pendingLine = ''
      })
    } else {
      const resampler = new MonoResampler(48000, 2)
      let sniffed = false
      const read = createFrameReader(4, (bytes) => {
        if (!stopped) padder.push(resampler.push(float32FromPcm16(bytes)))
      })
      child.stdout.on('data', (chunk: Buffer) => {
        if (!sniffed) {
          sniffed = true
          if (chunk.subarray(0, 23).toString('latin1').startsWith('Failed to start capture')) {
            const message = `应用音频采集启动失败：${chunk.toString('utf8').trim()}`
            if (!started) failStart(message)
            else if (!stopped) {
              void stop()
              handlers.onEnded(message)
            }
            return
          }
        }
        read(chunk)
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (text: string) => {
        stderrText = (stderrText + text).slice(-32_768)
      })
      const readyTimer = setTimeout(settleStarted, 500)
      void closed.then(() => clearTimeout(readyTimer))
    }
    child.on('error', (error) => {
      diag('helper spawn error', { message: error.message })
      if (!started) failStart(`无法启动音频采集程序：${error.message}`)
      else if (!stopped) {
        void stop()
        handlers.onEnded(error.message)
      }
    })
    child.on('exit', (code, signal) => {
      diag('helper exit', { code, signal, stopped, stderr: stderrText.trim().slice(-2000) })
      if (stopped) return
      const reason =
        parseHelperError(stderrText) ??
        (code === 0
          ? '被监听的应用已退出'
          : `音频采集程序异常退出（${signal ?? code ?? '未知原因'}）`)
      if (!started) failStart(reason)
      else {
        stopped = true
        handlers.onEnded(reason)
      }
    })
    if (signal?.aborted) onAbort()
  })
}
