import { FormData, ProxyAgent, fetch as undiciFetch } from 'undici'
import type { VoiceSttConfig } from '../shared/settings'
import { getExtraHeaders } from './ai'

const STT_TIMEOUT_MS = 45_000

export class SttConfigError extends Error {}

function getTranscriptionURL(config: VoiceSttConfig): string {
  const trimmed = config.apiBaseURL.trim().replace(/\/+$/, '')
  if (!trimmed) throw new SttConfigError('语音识别 Base URL 未配置')
  // Grok2API: POST {base}/stt; everything else is OpenAI-compatible.
  return config.provider === 'grok2api' ? `${trimmed}/stt` : `${trimmed}/audio/transcriptions`
}

const TEXT_KEYS = ['text', 'transcript', 'formatted_text', 'formattedText'] as const
const NESTED_KEYS = ['result', 'data', 'output'] as const

function joinTextItems(items: unknown[], separator: string): string {
  return items
    .map((item) => {
      if (!item || typeof item !== 'object') return ''
      const record = item as Record<string, unknown>
      const value = record.text ?? record.word
      return typeof value === 'string' ? value : ''
    })
    .join(separator)
    .trim()
}

function extractTranscriptText(payload: unknown): string {
  if (typeof payload === 'string') return payload.trim()
  if (!payload || typeof payload !== 'object') return ''
  const record = payload as Record<string, unknown>
  for (const key of TEXT_KEYS) {
    if (typeof record[key] === 'string') return (record[key] as string).trim()
  }
  // Some gateways nest the result.
  for (const key of NESTED_KEYS) {
    if (record[key] && typeof record[key] === 'object') {
      const text = extractTranscriptText(record[key])
      if (text) return text
    }
  }
  if (Array.isArray(record.segments)) return joinTextItems(record.segments, '')
  // Word-level only (e.g. Grok2API with timestamps): words are space separated.
  if (Array.isArray(record.words)) return joinTextItems(record.words, ' ')
  return ''
}

/**
 * Transcribe one WAV clip with an OpenAI-compatible `/audio/transcriptions` endpoint
 * (OpenAI whisper-1 / gpt-4o-transcribe, SiliconFlow SenseVoice, Groq whisper, ...)
 * or Grok2API's `/stt` endpoint.
 */
export async function transcribeAudio(
  wav: Uint8Array,
  config: VoiceSttConfig,
  signal?: AbortSignal
): Promise<string> {
  if (!config.apiKey.trim()) throw new SttConfigError('语音识别 API Key 未配置')
  if (!config.model.trim()) throw new SttConfigError('语音识别模型未配置')

  const url = getTranscriptionURL(config)
  // Copy into a plain ArrayBuffer-backed view: IPC may hand us a view over a shared buffer.
  const bytes = Uint8Array.from(wav)
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'segment.wav')
  form.append('model', config.model.trim())
  if (config.provider === 'grok2api') {
    // Formatted text carries punctuation, which reads much better for the LLM. Upstream
    // rejects format=true without a language (400), so only ask for it when one is pinned.
    if (config.language.trim()) form.append('format', 'true')
  } else {
    form.append('response_format', 'json')
  }
  if (config.language.trim()) form.append('language', config.language.trim())

  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey.trim()}`,
    ...(getExtraHeaders(config.extraHeaders) ?? {})
  }

  const timeoutSignal = AbortSignal.timeout(STT_TIMEOUT_MS)
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal

  // Always go through undici's fetch so its FormData/Blob implementation and the
  // optional proxy dispatcher are used consistently.
  const proxyUrl = config.proxyUrl.trim()
  const response = await undiciFetch(url, {
    method: 'POST',
    headers,
    body: form,
    signal: combinedSignal,
    dispatcher: proxyUrl ? new ProxyAgent(proxyUrl) : undefined
  })

  const raw = await response.text()
  if (!response.ok) {
    let detail = raw
    try {
      const body = JSON.parse(raw)
      detail = body?.error?.message || body?.message || raw
    } catch {
      // keep raw body
    }
    throw new Error(`语音识别请求失败 (${response.status}): ${String(detail).slice(0, 300)}`)
  }

  try {
    return extractTranscriptText(JSON.parse(raw))
  } catch {
    return raw.trim()
  }
}
