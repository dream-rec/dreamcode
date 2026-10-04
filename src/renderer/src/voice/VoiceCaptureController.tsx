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
  const sessionRef = useRef<{
    id: string
    controller: AbortController
    session: AudioCaptureSession | null
  } | null>(null)
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
    const stopSession = async (flush: boolean): Promise<void> => {
      const current = sessionRef.current
      if (!current) return
      if (flush) current.session?.flush()
      sessionRef.current = null
      current.controller.abort()
      await (current.session?.stop() ?? window.api.voiceReleaseCapture(current.id))
      setLevel(-100)
    }
    window.api.onVoiceCaptureCommand(async (command) => {
      if (command.type === 'start') {
        const previousStop = stopSession(false)
        const current = {
          id: command.sessionId,
          controller: new AbortController(),
          session: null as AudioCaptureSession | null
        }
        sessionRef.current = current
        try {
          await previousStop
          if (sessionRef.current !== current) return
          const session = await AudioCaptureSession.start(
            command.config,
            {
              onSegment: (segment: UtteranceSegment) => {
                if (sessionRef.current !== current) return
                const wav = encodeWav(floatToPcm16(segment.frames), CAPTURE_SAMPLE_RATE)
                void window.api.voicePushSegment({
                  sessionId: current.id,
                  seq: ++seqRef.current,
                  startedAt: segment.startedAt,
                  durationMs: segment.durationMs,
                  wav
                })
              },
              onLevel: (db) => {
                if (sessionRef.current === current) setLevel(db)
              },
              onEnded: (reason) => {
                if (sessionRef.current !== current) return
                sessionRef.current = null
                setLevel(-100)
                void window.api.voiceCaptureError(current.id, reason)
              }
            },
            { id: current.id, owner: 'voice', signal: current.controller.signal }
          )
          if (sessionRef.current !== current || current.controller.signal.aborted) {
            await session.stop()
            return
          }
          current.session = session
          await window.api.voiceCaptureStarted(current.id)
        } catch (error) {
          if (sessionRef.current !== current || current.controller.signal.aborted) return
          sessionRef.current = null
          await window.api.voiceCaptureError(
            current.id,
            error instanceof Error ? error.message : String(error)
          )
        }
      } else if (command.type === 'flush') {
        if (sessionRef.current?.id === command.sessionId) sessionRef.current.session?.flush()
        await window.api.voiceFlushed(command.sessionId, command.requestId)
      } else {
        if (sessionRef.current?.id === command.sessionId) await stopSession(!command.discard)
        await window.api.voiceCaptureStopped(command.sessionId, command.requestId)
      }
    })
    return () => {
      window.api.removeVoiceCaptureCommandListener()
      void stopSession(false)
    }
  }, [setLevel])
  return null
}
