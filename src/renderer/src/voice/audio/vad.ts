import type { VoiceVadConfig } from '../../../../shared/settings'

export const SILENCE_DB = -100

/** RMS level of a frame in dBFS. */
export function frameDb(frame: Float32Array): number {
  let sum = 0
  for (let i = 0; i < frame.length; i += 1) sum += frame[i] * frame[i]
  const rms = Math.sqrt(sum / Math.max(1, frame.length))
  if (rms <= 1e-7) return SILENCE_DB
  return Math.max(SILENCE_DB, 20 * Math.log10(rms))
}

export interface UtteranceSegment {
  frames: Float32Array[]
  startedAt: number
  durationMs: number
}

/**
 * Energy-based utterance segmenter.
 *
 * Frames louder than `thresholdDb` are speech. An utterance opens on the first loud frame
 * (with a little pre-roll so the first syllable is not clipped) and closes after
 * `silenceMs` of quiet, or when it reaches `maxSegmentMs`. Utterances whose loud portion
 * is shorter than `minSpeechMs` are discarded as clicks / noise.
 */
export class UtteranceSegmenter {
  private readonly preRoll: Float32Array[] = []
  private readonly preRollFrames: number
  private current: Float32Array[] = []
  private currentStartedAt = 0
  private speechMs = 0
  private silenceMs = 0
  private inSpeech = false

  constructor(
    private readonly config: VoiceVadConfig,
    private readonly frameMs: number,
    private readonly onSegment: (segment: UtteranceSegment) => void
  ) {
    this.preRollFrames = Math.ceil(300 / frameMs)
  }

  /** Feed one frame; returns its level so the caller can drive a meter. */
  push(frame: Float32Array): number {
    const db = frameDb(frame)
    const loud = db >= this.config.thresholdDb

    if (!this.inSpeech) {
      if (loud) {
        this.inSpeech = true
        this.currentStartedAt = Date.now() - this.preRoll.length * this.frameMs
        this.current = [...this.preRoll, frame]
        this.speechMs = this.frameMs
        this.silenceMs = 0
      } else {
        this.preRoll.push(frame)
        if (this.preRoll.length > this.preRollFrames) this.preRoll.shift()
      }
      return db
    }

    this.current.push(frame)
    if (loud) {
      this.speechMs += this.frameMs
      this.silenceMs = 0
    } else {
      this.silenceMs += this.frameMs
    }

    const durationMs = this.current.length * this.frameMs
    if (this.silenceMs >= this.config.silenceMs || durationMs >= this.config.maxSegmentMs) {
      this.close()
    }
    return db
  }

  /** Force-close the current utterance (used on "send now" and on stop). */
  flush(): void {
    if (this.inSpeech) this.close()
  }

  private close(): void {
    const frames = this.current
    const startedAt = this.currentStartedAt
    const speechMs = this.speechMs
    this.current = []
    this.inSpeech = false
    this.speechMs = 0
    this.silenceMs = 0
    this.preRoll.length = 0

    if (speechMs < this.config.minSpeechMs || frames.length === 0) return
    this.onSegment({ frames, startedAt, durationMs: frames.length * this.frameMs })
  }
}
