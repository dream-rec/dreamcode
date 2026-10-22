/**
 * Speech-to-text wire formats. OpenAI-compatible gateways upload a WAV file.
 * Bailian Qwen ASR does not: it is a chat completion with a Base64 data URL.
 */

export function transcriptionPath(provider: string): string {
  if (provider === 'grok2api') return '/stt'
  if (provider === 'qwen-asr') return '/chat/completions'
  return '/audio/transcriptions'
}

/** Join a base URL and a protocol path without duplicating the path. */
export function joinTranscriptionURL(apiBaseURL: string, provider: string): string {
  const path = transcriptionPath(provider)
  const trimmed = apiBaseURL.trim().replace(/\/+$/, '')
  if (!trimmed) throw new Error('语音识别 Base URL 未配置')
  return trimmed.endsWith(path) ? trimmed : `${trimmed}${path}`
}

export interface QwenAsrRequest {
  model: string
  messages: {
    role: 'user'
    content: {
      type: 'input_audio'
      input_audio: { data: string }
    }[]
  }[]
  stream: false
  asr_options: {
    enable_itn: true
    language?: string
  }
}

/** Bailian Qwen-ASR body. `audioDataUrl` is `data:audio/wav;base64,...`. */
export function qwenAsrRequestBody(input: {
  model: string
  audioDataUrl: string
  language: string
}): QwenAsrRequest {
  const language = input.language.trim()
  return {
    model: input.model.trim(),
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'input_audio',
            input_audio: { data: input.audioDataUrl }
          }
        ]
      }
    ],
    stream: false,
    asr_options: language ? { enable_itn: true, language } : { enable_itn: true }
  }
}

const TEXT_KEYS = ['text', 'transcript', 'formatted_text', 'formattedText'] as const
const NESTED_KEYS = ['result', 'data', 'output'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function joinTextItems(items: unknown[], separator: string): string {
  return items
    .map((item) => {
      if (!isRecord(item)) return ''
      const value = item.text ?? item.word
      return typeof value === 'string' ? value : ''
    })
    .join(separator)
    .trim()
}

function messageContentText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map((item) => {
      if (!isRecord(item) || item.type === 'audio_info') return ''
      return typeof item.text === 'string' ? item.text : ''
    })
    .join('')
    .trim()
}

function choiceText(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return ''
  for (const choice of payload.choices) {
    if (!isRecord(choice) || !isRecord(choice.message)) continue
    const text = messageContentText(choice.message.content)
    if (text) return text
  }
  return ''
}

export function extractTranscriptText(payload: unknown): string {
  if (typeof payload === 'string') return payload.trim()
  if (!isRecord(payload)) return ''
  for (const key of TEXT_KEYS) {
    if (typeof payload[key] === 'string') return payload[key].trim()
  }
  const fromChoices = choiceText(payload)
  if (fromChoices) return fromChoices
  for (const key of NESTED_KEYS) {
    if (isRecord(payload[key])) {
      const text = extractTranscriptText(payload[key])
      if (text) return text
    }
  }
  if (Array.isArray(payload.segments)) return joinTextItems(payload.segments, '')
  if (Array.isArray(payload.words)) return joinTextItems(payload.words, ' ')
  return ''
}
