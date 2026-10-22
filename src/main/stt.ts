import { FormData, fetch as undiciFetch } from 'undici'
import { requestDispatcher } from './direct-fetch'
import type { VoiceSttConfig } from '../shared/settings'
import { extractTranscriptText, joinTranscriptionURL, qwenAsrRequestBody } from '../shared/stt'
import { getExtraHeaders } from './ai'

const STT_TIMEOUT_MS = 45_000

export class SttConfigError extends Error {}

function getTranscriptionURL(config: VoiceSttConfig): string {
  try {
    return joinTranscriptionURL(config.apiBaseURL, config.provider)
  } catch (error) {
    throw new SttConfigError(error instanceof Error ? error.message : '语音识别 Base URL 未配置')
  }
}

function wavDataUrl(wav: Uint8Array): string {
  const bytes = Uint8Array.from(wav)
  return `data:audio/wav;base64,${Buffer.from(bytes).toString('base64')}`
}

/**
 * Transcribe one WAV clip.
 * OpenAI-compatible gateways use multipart `POST /audio/transcriptions`.
 * Grok2API uses multipart `POST /stt`.
 * Bailian Qwen ASR uses JSON `POST /chat/completions` with a Base64 data URL.
 */
export async function transcribeAudio(
  wav: Uint8Array,
  config: VoiceSttConfig,
  signal?: AbortSignal
): Promise<string> {
  if (!config.apiKey.trim()) throw new SttConfigError('语音识别 API Key 未配置')
  if (!config.model.trim()) throw new SttConfigError('语音识别模型未配置')

  const url = getTranscriptionURL(config)
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey.trim()}`,
    ...(getExtraHeaders(config.extraHeaders) ?? {})
  }
  const body =
    config.provider === 'qwen-asr' ? qwenRequestBody(wav, config) : openAiFormBody(wav, config)
  if (config.provider === 'qwen-asr') headers['Content-Type'] = 'application/json'

  const timeoutSignal = AbortSignal.timeout(STT_TIMEOUT_MS)
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal

  // Always pass a dispatcher. With none, undici and Electron follow the system
  // proxy and Tailscale addresses never leave the proxy.
  const response = await undiciFetch(url, {
    method: 'POST',
    headers,
    body,
    signal: combinedSignal,
    dispatcher: requestDispatcher(config.proxyUrl)
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

function qwenRequestBody(wav: Uint8Array, config: VoiceSttConfig): string {
  return JSON.stringify(
    qwenAsrRequestBody({
      model: config.model,
      audioDataUrl: wavDataUrl(wav),
      language: config.language
    })
  )
}

function openAiFormBody(wav: Uint8Array, config: VoiceSttConfig): FormData {
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
  return form
}
