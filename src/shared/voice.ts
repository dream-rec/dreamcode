import type { VoiceAudioSource, VoiceVadConfig } from './settings'

/** Lifecycle of the renderer-side audio capture. */
export type VoiceCaptureState = 'idle' | 'starting' | 'listening' | 'stopping'

export type TranscriptSegmentStatus = 'pending' | 'done' | 'error'

export interface TranscriptSegment {
  seq: number
  /** Epoch ms when speech started. */
  startedAt: number
  durationMs: number
  text: string
  status: TranscriptSegmentStatus
  error?: string
  /** Already sent to the LLM via "send selected" (kept on screen, excluded from later sends). */
  sent?: boolean
}

/** Contiguous range of transcript lines picked on the voice page, by `seq`. */
export interface TranscriptSelection {
  anchor: number
  focus: number
}

export type VoiceExchangeStatus = 'streaming' | 'done' | 'stopped' | 'error'

export interface VoiceExchange {
  id: string
  askedAt: number
  question: string
  answer: string
  status: VoiceExchangeStatus
  error?: string
}

/** Full voice-assistant state owned by the main process and mirrored to the renderer. */
export interface VoiceSnapshot {
  captureState: VoiceCaptureState
  answering: boolean
  /** Transcript lines captured since the last send. */
  segments: TranscriptSegment[]
  selection: TranscriptSelection | null
  exchanges: VoiceExchange[]
  error: string | null
  /**
   * Non-fatal capture advisory, e.g. the whole-system-sound fallback while the target app uses
   * its microphone. Cleared whenever capture ends; null = no advisory.
   */
  captureNotice: string | null
}

export interface VoiceCaptureConfig {
  source: VoiceAudioSource
  /** Capture only this application's output; empty = the whole system output mix. */
  appId: string
  vad: VoiceVadConfig
}

export type VoiceCaptureOwner = 'voice' | 'test'

/** Commands the main process sends to the renderer capture controller. */
export type VoiceCaptureCommand =
  | { type: 'start'; sessionId: string; requestId: string; config: VoiceCaptureConfig }
  | { type: 'flush'; sessionId: string; requestId: string }
  | { type: 'stop'; sessionId: string; requestId: string; discard: boolean }

export interface VoiceSegmentPayload {
  sessionId: string
  seq: number
  startedAt: number
  durationMs: number
  /** 16 kHz mono PCM16 WAV. */
  wav: Uint8Array
}

/** An application whose audio can be captured on its own. */
export interface AudioApp {
  /** macOS bundle identifier / Windows process name (lower-case, without .exe). */
  id: string
  name: string
  pid: number
}

export const VOICE_MAX_SEGMENTS = 200
export const VOICE_MAX_EXCHANGES = 30
export const VOICE_HISTORY_EXCHANGES = 8
