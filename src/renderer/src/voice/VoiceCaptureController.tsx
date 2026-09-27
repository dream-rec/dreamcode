import { useEffect, useRef } from 'react'
import { useVoiceStore } from '@/lib/store/voice'
import { AudioCaptureSession, CAPTURE_SAMPLE_RATE } from './audio/capture'
import { encodeWav, floatToPcm16 } from './audio/wav'
import type { UtteranceSegment } from './audio/vad'

/**
 * Route-independent bridge between the main-process voice state machine and the
 * browser audio APIs. Mounted once in App so listening survives page navigation.
 */
export function VoiceCaptureController() {
  const sessionRef = useRef<AudioCaptureSession | null>(null)
  const seqRef = useRef(0)
  const setSnapshot = useVoiceStore((state) => state.setSnapshot)
  const appendAnswer = useVoiceStore((state) => state.appendAnswer)
  const setLevel = useVoiceStore((state) => state.setLevel)

  useEffect(() => {
    window.api.voiceGetSnapshot().then(setSnapshot)
    window.api.onVoiceState(setSnapshot)
    window.api.onVoiceAnswerChunk(({ id, chunk }) => appendAnswer(id, chunk))
    return () => {
      window.api.removeVoiceStateListener()
      window.api.removeVoiceAnswerChunkListener()
    }
  }, [setSnapshot, appendAnswer])

  useEffect(() => {
    const pushSegment = (segment: UtteranceSegment) => {
      seqRef.current += 1
      const wav = encodeWav(floatToPcm16(segment.frames), CAPTURE_SAMPLE_RATE)
      void window.api.voicePushSegment({
        seq: seqRef.current,
        startedAt: segment.startedAt,
        durationMs: segment.durationMs,
        wav
      })
    }

    const stopSession = (flush: boolean) => {
      const session = sessionRef.current
      sessionRef.current = null
      if (!session) return
      if (flush) session.flush()
      session.stop()
      setLevel(-100)
    }

    window.api.onVoiceCaptureCommand(async (command) => {
      switch (command.type) {
        case 'start': {
          stopSession(false)
          try {
            sessionRef.current = await AudioCaptureSession.start(command.config, {
              onSegment: pushSegment,
              onLevel: setLevel,
              onEnded: (reason) => {
                sessionRef.current = null
                setLevel(-100)
                void window.api.voiceCaptureError(reason)
              }
            })
            await window.api.voiceCaptureStarted()
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            await window.api.voiceCaptureError(message)
          }
          break
        }
        case 'flush': {
          sessionRef.current?.flush()
          await window.api.voiceFlushed(command.requestId)
          break
        }
        case 'stop': {
          stopSession(!command.discard)
          await window.api.voiceCaptureStopped(command.requestId)
          break
        }
      }
    })

    return () => {
      window.api.removeVoiceCaptureCommandListener()
      stopSession(false)
    }
  }, [setLevel])

  return null
}
