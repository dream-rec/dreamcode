import type { VoiceCaptureConfig } from '../../../../shared/voice'
import { UtteranceSegmenter, type UtteranceSegment } from './vad'

export const CAPTURE_SAMPLE_RATE = 16000
const FRAME_MS = 20
const FRAME_SAMPLES = (CAPTURE_SAMPLE_RATE * FRAME_MS) / 1000

/**
 * The worklet lives in src/renderer/public so it is served as a same-origin static asset
 * (blob: URLs are rejected by the renderer's `script-src 'self'` CSP). Resolving against
 * document.baseURI works both on the dev server and for the packaged file:// build.
 */
const WORKLET_URL = new URL('pcm-forwarder.worklet.js', document.baseURI).href

export interface CaptureCallbacks {
  onSegment: (segment: UtteranceSegment) => void
  onLevel: (db: number) => void
  /** Fired when the OS ends the stream (device unplugged, share stopped). */
  onEnded: (reason: string) => void
}

function describeMediaError(error: unknown): string {
  const name = error instanceof Error ? error.name : ''
  const message = error instanceof Error ? error.message : String(error)
  const isMac = navigator.userAgent.includes('Mac')

  if (name === 'NotAllowedError') {
    return isMac
      ? '系统音频采集被拒绝：请在「系统设置 → 隐私与安全性 → 屏幕与系统音频录制」中允许 DreamCode，然后重启应用'
      : '系统音频采集被拒绝，请检查系统权限'
  }
  if (
    name === 'NotSupportedError' ||
    name === 'NotFoundError' ||
    /not supported|no audio/i.test(message)
  ) {
    return '当前系统无法采集全部系统声音，请在设置中选择指定应用输出，或检查系统版本与音频录制权限'
  }
  return `系统音频采集失败：${message}`
}

async function acquireSystemOutputStream(): Promise<MediaStream> {
  // Chromium only exposes system-audio loopback through getDisplayMedia; the main process
  // answers the request with a screen source + "loopback" audio. We discard the video.
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
  stream.getVideoTracks().forEach((track) => track.stop())
  if (stream.getAudioTracks().length === 0) {
    stream.getTracks().forEach((track) => track.stop())
    throw new DOMException('no audio track', 'NotSupportedError')
  }
  // Disable voice processing on the output track; it degrades already-clean meeting audio.
  // Best effort: some platforms ignore these constraints.
  await Promise.all(
    stream.getAudioTracks().map((track) =>
      track
        .applyConstraints({
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        })
        .catch(() => undefined)
    )
  )
  return stream
}

function describeIpcError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  // ipcRenderer.invoke wraps main-process errors as "Error invoking remote method 'x': Error: msg".
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}

/** Re-chunks arbitrary-length PCM into the fixed frames the segmenter expects. */
class Framer {
  private frame = new Float32Array(FRAME_SAMPLES)
  private filled = 0

  constructor(private readonly onFrame: (frame: Float32Array) => void) {}

  push(samples: Float32Array) {
    for (let i = 0; i < samples.length; i += 1) {
      this.frame[this.filled++] = samples[i]
      if (this.filled === FRAME_SAMPLES) {
        this.onFrame(this.frame)
        this.frame = new Float32Array(FRAME_SAMPLES)
        this.filled = 0
      }
    }
  }
}

/**
 * One listening session: audio frames in (from Web Audio, or from the main-process
 * per-app helper), VAD-cut utterances and level readings out.
 */
export class AudioCaptureSession {
  private stopped = false
  private levelTick = 0
  private release: () => Promise<void> = async () => undefined
  private stopPromise: Promise<void> | null = null
  private unsubscribe: () => void = () => undefined
  private removeAbort: () => void = () => undefined
  private onPcm: ((samples: Float32Array) => void) | null = null
  private readonly segmenter: UtteranceSegmenter

  private constructor(
    config: VoiceCaptureConfig,
    private readonly callbacks: CaptureCallbacks,
    private readonly id: string
  ) {
    this.segmenter = new UtteranceSegmenter(config.vad, FRAME_MS, callbacks.onSegment)
  }

  private handleFrame(frame: Float32Array): void {
    if (this.stopped) return
    const db = this.segmenter.push(frame)
    this.levelTick = (this.levelTick + 1) % 5
    if (this.levelTick === 0) this.callbacks.onLevel(db)
  }

  private handleEnded(reason: string): void {
    if (this.stopped) return
    void this.stop().then(() => this.callbacks.onEnded(reason))
  }

  static async start(
    config: VoiceCaptureConfig,
    callbacks: CaptureCallbacks,
    options: { id?: string; owner?: 'voice' | 'test'; signal?: AbortSignal } = {}
  ): Promise<AudioCaptureSession> {
    // Reject stale/unsupported IPC payloads instead of silently changing their capture scope.
    if (config.source !== 'system') throw new Error('仅支持系统或指定应用输出，请重新保存音频设置')
    const id = options.id ?? crypto.randomUUID()
    const session = new AudioCaptureSession(config, callbacks, id)
    const onAbort = (): void => {
      void session.stop()
    }
    options.signal?.throwIfAborted()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    session.removeAbort = () => options.signal?.removeEventListener('abort', onAbort)
    session.unsubscribe = window.api.onVoiceAppAudio(
      id,
      (samples) => {
        if (!session.stopped) session.onPcm?.(samples)
      },
      (reason) => session.handleEnded(reason)
    )
    options.signal?.throwIfAborted()
    if (!(await window.api.voiceEnsureCapturePermission())) {
      throw new Error(
        '系统音频录制权限未开启：请在「系统设置 → 隐私与安全性 → 屏幕与系统音频录制」中允许 DreamCode 后重试'
      )
    }
    try {
      await window.api.voiceReserveCapture(id, options.owner ?? 'test')
      if (session.stopped) throw new Error('音频采集启动已取消')
      if (config.appId) await session.startApp(config.appId)
      else await session.startMedia()
      if (session.stopped) throw new Error('音频采集启动已取消')
      return session
    } catch (error) {
      await session.stop()
      throw new Error(describeIpcError(error))
    }
  }

  private async startApp(appId: string): Promise<void> {
    const framer = new Framer((frame) => this.handleFrame(frame))
    this.onPcm = (samples) => framer.push(samples)
    await window.api.voiceAppCaptureStart(appId, this.id)
  }

  private async startMedia(): Promise<void> {
    let stream: MediaStream
    try {
      stream = await acquireSystemOutputStream()
    } catch (error) {
      throw new Error(describeMediaError(error))
    }
    if (this.stopped) {
      stream.getTracks().forEach((track) => track.stop())
      throw new Error('音频采集启动已取消')
    }
    const context = new AudioContext({ sampleRate: CAPTURE_SAMPLE_RATE })
    let node: AudioWorkletNode | null = null
    const release = async (): Promise<void> => {
      if (node) {
        node.port.onmessage = null
        node.disconnect()
      }
      stream.getTracks().forEach((track) => track.stop())
      await context.close().catch(() => undefined)
    }
    this.release = release
    try {
      await context.audioWorklet.addModule(WORKLET_URL)
      if (this.stopped) throw new Error('音频采集启动已取消')
      const source = context.createMediaStreamSource(stream)
      node = new AudioWorkletNode(context, 'pcm-forwarder', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        channelCountMode: 'explicit',
        processorOptions: { frameSamples: FRAME_SAMPLES }
      })
      const mute = context.createGain()
      mute.gain.value = 0
      source.connect(node)
      node.connect(mute)
      mute.connect(context.destination)
      if (context.state === 'suspended') await context.resume()
      if (this.stopped) throw new Error('音频采集启动已取消')
      node.port.onmessage = (event: MessageEvent<Float32Array>) => this.handleFrame(event.data)
      stream.getAudioTracks().forEach((track) => {
        track.addEventListener('ended', () =>
          this.handleEnded('音频源已结束（设备断开或共享被停止）')
        )
      })
    } catch (error) {
      await release()
      throw error
    }
  }

  flush(): void {
    if (!this.stopped) this.segmenter.flush()
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stopped = true
    this.unsubscribe()
    this.removeAbort()
    this.onPcm = null
    this.stopPromise = (async () => {
      await this.release()
      await window.api.voiceReleaseCapture(this.id)
    })()
    return this.stopPromise
  }
}
