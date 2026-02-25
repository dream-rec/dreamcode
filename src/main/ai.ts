import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { streamText, type ModelMessage } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { settings, type AppSettings } from './settings'

export const PROMPT_SYSTEM = readFileSync(join(import.meta.dirname, 'prompts.md'), 'utf-8').trim()

function getAnthropicBaseURL(url: string | undefined): string | undefined {
  if (!url) return undefined
  // Align with Claude Code behavior:
  // Claude Code sets ANTHROPIC_BASE_URL=https://example.com
  // and calls https://example.com/v1/messages
  // But @ai-sdk/anthropic expects baseURL to already include /v1
  // and calls ${baseURL}/messages
  // So we need to append /v1 if not present
  const trimmed = url.replace(/\/+$/, '')
  if (trimmed.endsWith('/v1')) return trimmed
  return trimmed + '/v1'
}

function getModelProvider(_settings: AppSettings) {
  if (_settings.apiProvider === 'anthropic') {
    // Anthropic Messages API: POST {baseURL}/messages
    // SDK default baseURL: https://api.anthropic.com/v1
    // Headers: x-api-key, anthropic-version: 2023-06-01
    const anthropic = createAnthropic({
      baseURL: getAnthropicBaseURL(_settings.apiBaseURL) || undefined,
      apiKey: _settings.apiKey
    })
    return anthropic(_settings.model)
  }
  // OpenAI-compatible API: POST {baseURL}/chat/completions
  const openai = createOpenAI({
    baseURL: _settings.apiBaseURL || undefined,
    apiKey: _settings.apiKey
  })
  return openai.chat(_settings.model)
}

function getSystemPrompt(): string {
  return (
    settings.customPrompt || PROMPT_SYSTEM + `\n使用编程语言：${settings.codeLanguage} 解答。`
  )
}

function getMaxOutputTokens(): number | undefined {
  // Anthropic API requires max_tokens; SDK has built-in defaults per model,
  // but we set an explicit fallback for custom/unknown models
  return settings.apiProvider === 'anthropic' ? 8192 : undefined
}

export function getSolutionStream(base64Image: string, abortSignal?: AbortSignal) {
  const { textStream } = streamText({
    model: getModelProvider(settings),
    system: getSystemPrompt(),
    maxOutputTokens: getMaxOutputTokens(),
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `这是屏幕截图`
          },
          {
            type: 'image',
            image: base64Image
          }
        ]
      }
    ],
    abortSignal,
    onError: (err) => {
      throw err.error ?? err
    }
  })
  return textStream
}

export function getFollowUpStream(
  messages: ModelMessage[],
  userQuestion: string,
  abortSignal?: AbortSignal
) {
  const updatedMessages: ModelMessage[] = [
    ...messages,
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: userQuestion
        }
      ]
    }
  ]

  const { textStream } = streamText({
    model: getModelProvider(settings),
    system: getSystemPrompt(),
    maxOutputTokens: getMaxOutputTokens(),
    messages: updatedMessages,
    abortSignal,
    onError: (err) => {
      throw err.error ?? err
    }
  })
  return textStream
}

export function getGeneralStream(messages: ModelMessage[], abortSignal?: AbortSignal) {
  const { textStream } = streamText({
    model: getModelProvider(settings),
    system:
      settings.customPrompt ||
      PROMPT_SYSTEM +
        `\n使用编程语言：${settings.codeLanguage} 解答。\n\n注意：如果有多张截图，请结合所有截图内容进行完整分析，不要遗漏任何部分。`,
    maxOutputTokens: getMaxOutputTokens(),
    messages,
    abortSignal,
    onError: (err) => {
      throw err.error ?? err
    }
  })
  return textStream
}
