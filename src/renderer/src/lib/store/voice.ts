import { create } from 'zustand'
import type { VoiceSnapshot } from '../../../../shared/voice'

export type {
  TranscriptSegment,
  TranscriptSelection,
  VoiceExchange,
  VoiceSnapshot
} from '../../../../shared/voice'

interface VoiceStore extends VoiceSnapshot {
  /** Latest input level in dBFS (-100 = silence); only meaningful while listening. */
  level: number
  setSnapshot: (snapshot: VoiceSnapshot) => void
  appendAnswer: (id: string, chunk: string) => void
  setLevel: (level: number) => void
}

export const useVoiceStore = create<VoiceStore>()((set) => ({
  captureState: 'idle',
  answering: false,
  segments: [],
  selection: null,
  exchanges: [],
  error: null,
  level: -100,
  setSnapshot: (snapshot) => set(snapshot),
  appendAnswer: (id, chunk) =>
    set((state) => ({
      exchanges: state.exchanges.map((exchange) =>
        exchange.id === id ? { ...exchange, answer: exchange.answer + chunk } : exchange
      )
    })),
  setLevel: (level) => set({ level })
}))
