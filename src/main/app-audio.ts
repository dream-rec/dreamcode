import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import type { AudioApp } from '../shared/voice'

/**
 * Per-application audio capture ("only the meeting app, not the whole system").
 *
 * Chromium can only loop back the entire system mix, so this goes through small native helpers:
 *   - macOS 13+: resources/bin/audio-tap (ScreenCaptureKit, see scripts/audio-tap.swift)
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

export function isAppCaptureSupported(): boolean {
  return process.platform === 'darwin' || (process.platform === 'win32' && process.arch === 'x64')
}

function unpackedPath(path: string): string {
  // Executables cannot be spawned from inside app.asar; electron-builder unpacks them next to it.
  return path.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
}

function getMacHelperPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'bin', 'audio-tap')
    : join(__dirname, 'bin', 'audio-tap')
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
  if (!stdout.trim()) throw new Error('应用列表为空，请确认已授予「屏幕录制」权限后重试')
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

export interface AppCaptureHandlers {
  onPcm: (samples: Float32Array) => void
  /** The helper exited on its own (app quit, permission revoked, crash). */
  onEnded: (reason: string) => void
}

export interface AppCapture {
  stop: () => void
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

/** Starts capturing one application's audio; resolves once audio is flowing (or fails). */
export async function startAppCapture(
  appId: string,
  handlers: AppCaptureHandlers
): Promise<AppCapture> {
  if (!isAppCaptureSupported()) throw new Error('当前系统不支持按应用采集音频')

  const isMac = process.platform === 'darwin'
  const command = isMac ? getMacHelperPath() : getWindowsLoopbackPath()
  const args = isMac ? ['capture', appId] : [String(await resolveWindowsPid(appId))]

  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  activeChildren.add(child)

  const padder = new SilencePadder(handlers.onPcm)
  let stopped = false
  let started = false
  let stderrText = ''

  const cleanup = () => {
    padder.stop()
    activeChildren.delete(child)
  }

  const stop = () => {
    if (stopped) return
    stopped = true
    cleanup()
    child.stdin?.end()
    child.kill()
  }

  return new Promise<AppCapture>((resolve, reject) => {
    const settleStarted = () => {
      if (started) return
      started = true
      clearTimeout(startTimer)
      resolve({ stop })
    }
    const failStart = (message: string) => {
      if (started) return
      started = true
      clearTimeout(startTimer)
      stop()
      reject(new Error(message))
    }

    const startTimer = setTimeout(() => {
      if (isMac) {
        failStart('应用音频采集启动超时（请检查「屏幕录制」权限）')
      } else {
        // The Windows helper prints nothing until the app actually plays audio.
        settleStarted()
      }
    }, START_TIMEOUT_MS)

    if (isMac) {
      // audio-tap reports its format before the first samples; default matches what we request.
      let resampler = new MonoResampler(APP_CAPTURE_SAMPLE_RATE, 1)
      const read = createFrameReader(4, (bytes) =>
        padder.push(resampler.push(float32FromBytes(bytes)))
      )
      child.stdout.on('data', read)
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (text: string) => {
        stderrText += text
        for (const line of text.split('\n')) {
          if (!line.trim()) continue
          try {
            const event = JSON.parse(line)
            if (event.event === 'started') settleStarted()
            if (event.event === 'format') {
              resampler = new MonoResampler(Number(event.sampleRate), Number(event.channels) || 1)
            }
            if (event.event === 'error') failStart(String(event.message))
          } catch {
            // ignore framework log noise
          }
        }
      })
    } else {
      // Windows helper: PCM16 stereo 48 kHz; silent packets are dropped (the padder fills them).
      const resampler = new MonoResampler(48000, 2)
      let sniffed = false
      const read = createFrameReader(4, (bytes) =>
        padder.push(resampler.push(float32FromPcm16(bytes)))
      )
      child.stdout.on('data', (chunk: Buffer) => {
        if (!sniffed) {
          sniffed = true
          // Start failures are reported as text on stdout, not as an exit code.
          if (chunk.subarray(0, 23).toString('latin1').startsWith('Failed to start capture')) {
            const message = `应用音频采集启动失败：${chunk.toString('utf8').trim()}`
            if (started) {
              stop()
              handlers.onEnded(message)
            } else {
              failStart(message)
            }
            return
          }
        }
        read(chunk)
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (text: string) => {
        stderrText += text
      })
      // Give an immediate failure (bad pid, missing exe) a moment to surface before resolving.
      setTimeout(() => {
        if (!stopped) settleStarted()
      }, 500)
    }

    child.on('error', (error) => {
      failStart(`无法启动音频采集程序：${error.message}`)
    })

    child.on('exit', (code) => {
      cleanup()
      if (stopped) return
      stopped = true
      const reason =
        parseHelperError(stderrText) ??
        (code === 0 ? '被监听的应用已退出' : `音频采集程序异常退出（${code}）`)
      if (!started) {
        failStart(reason)
      } else {
        handlers.onEnded(reason)
      }
    })
  })
}
