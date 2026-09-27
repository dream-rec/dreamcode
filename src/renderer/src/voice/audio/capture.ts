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

function describeMediaError(error: unknown, source: VoiceCaptureConfig['source']): string {
  const name = error instanceof Error ? error.name : ''
  const message = error instanceof Error ? error.message : String(error)
  const isMac = navigator.userAgent.includes('Mac')

  if (source === 'system') {
    if (name === 'NotAllowedError') {
      return isMac
        ? '系统音频采集被拒绝：请在「系统设置 → 隐私与安全性 → 屏幕录制」中允许 DreamCode，然后重启应用'
        : '系统音频采集被拒绝，请检查系统权限'
    }
    if (
      name === 'NotSupportedError' ||
      name === 'NotFoundError' ||
      /not supported|no audio/i.test(message)
    ) {
      return isMac
        ? '当前系统不支持直接采集系统音频：请安装 BlackHole 等虚拟声卡，把会议软件输出到该设备，并在设置中把音频来源改为「输入设备」'
        : '系统音频采集不可用，请在设置中改用「输入设备」'
    }
    return `系统音频采集失败：${message}`
  }

  if (name === 'NotAllowedError') {
    return isMac
      ? '麦克风权限被拒绝：请在「系统设置 → 隐私与安全性 → 麦克风」中允许 DreamCode'
      : '麦克风权限被拒绝，请检查系统权限'
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return '找不到所选输入设备，请在设置中重新选择'
  }
  return `音频输入采集失败：${message}`
}

async function acquireStream(config: VoiceCaptureConfig): Promise<MediaStream> {
  if (config.source === 'system') {
    // Chromium only exposes system-audio loopback through getDisplayMedia; the main process
    // answers the request with a screen source + "loopback" audio. We discard the video.
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
    stream.getVideoTracks().forEach((track) => track.stop())
    if (stream.getAudioTracks().length === 0) {
      stream.getTracks().forEach((track) => track.stop())
      throw new DOMException('no audio track', 'NotSupportedError')
    }
    // Chromium enables mic-style processing on the loopback track by default; it only
    // degrades already-clean meeting audio. Best effort, some platforms ignore it.
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

  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: config.deviceId ? { exact: config.deviceId } : undefined,
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    }
  })
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
  private release: () => void = () => undefined
  private readonly segmenter: UtteranceSegmenter

  private constructor(
    config: VoiceCaptureConfig,
    private readonly callbacks: CaptureCallbacks
  ) {
    this.segmenter = new UtteranceSegmenter(config.vad, FRAME_MS, callbacks.onSegment)
  }

  private handleFrame(frame: Float32Array) {
    if (this.stopped) return
    const db = this.segmenter.push(frame)
    // Meter at ~10 Hz is plenty and keeps React renders cheap.
    this.levelTick = (this.levelTick + 1) % 5
    if (this.levelTick === 0) this.callbacks.onLevel(db)
  }

  private handleEnded(reason: string) {
    if (this.stopped) return
    this.stop()
    this.callbacks.onEnded(reason)
  }

  static async start(
    config: VoiceCaptureConfig,
    callbacks: CaptureCallbacks
  ): Promise<AudioCaptureSession> {
    const session = new AudioCaptureSession(config, callbacks)
    if (config.source === 'system' && config.appId) {
      await session.startApp(config.appId)
    } else {
      await session.startMedia(config)
    }
    return session
  }

  /** A single application's audio, captured by a native helper in the main process. */
  private async startApp(appId: string) {
    let id: number
    try {
      id = await window.api.voiceAppCaptureStart(appId)
    } catch (error) {
      throw new Error(describeIpcError(error))
    }
    const framer = new Framer((frame) => this.handleFrame(frame))
    const unsubscribe = window.api.onVoiceAppAudio(
      id,
      (samples) => framer.push(samples),
      (reason) => this.handleEnded(`应用音频采集已结束：${reason}`)
    )
    this.release = () => {
      unsubscribe()
      void window.api.voiceAppCaptureStop(id)
    }
  }

  private async startMedia(config: VoiceCaptureConfig) {
    let stream: MediaStream
    try {
      stream = await acquireStream(config)
    } catch (error) {
      throw new Error(describeMediaError(error, config.source))
    }

    const context = new AudioContext({ sampleRate: CAPTURE_SAMPLE_RATE })
    try {
      await context.audioWorklet.addModule(WORKLET_URL)

      const source = context.createMediaStreamSource(stream)
      const node = new AudioWorkletNode(context, 'pcm-forwarder', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        channelCountMode: 'explicit',
        processorOptions: { frameSamples: FRAME_SAMPLES }
      })
      // Keep the node pulled by the graph without making any sound.
      const mute = context.createGain()
      mute.gain.value = 0
      source.connect(node)
      node.connect(mute)
      mute.connect(context.destination)
      if (context.state === 'suspended') await context.resume()

      node.port.onmessage = (event: MessageEvent<Float32Array>) => this.handleFrame(event.data)
      stream.getAudioTracks().forEach((track) => {
        track.addEventListener('ended', () =>
          this.handleEnded('音频源已结束（设备断开或共享被停止）')
        )
      })
      this.release = () => {
        node.port.onmessage = null
        node.disconnect()
        stream.getTracks().forEach((track) => track.stop())
        void context.close().catch(() => undefined)
      }
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop())
      await context.close().catch(() => undefined)
      throw error instanceof Error ? error : new Error(String(error))
    }
  }

  /** Close the in-progress utterance so it gets transcribed right away. */
  flush(): void {
    this.segmenter.flush()
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.release()
  }
}
