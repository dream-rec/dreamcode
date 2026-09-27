export type ApiProvider = 'openai' | 'anthropic'

export interface ProviderConfig {
  apiProvider: ApiProvider
  apiBaseURL: string
  apiKey: string
  extraHeaders: string
  model: string
  proxyUrl: string
}

export interface PromptConfig {
  codeLanguage: string
  customPrompt: string
}

export interface ProviderGroup extends ProviderConfig {
  id: string
  name: string
}

export interface PromptGroup extends PromptConfig {
  id: string
  name: string
}

export type VoiceAudioSource = 'system' | 'microphone'
export type VoiceLlmMode = 'shared' | 'custom'

/**
 * Speech-to-text service. All but `grok2api` speak the OpenAI-compatible
 * POST {apiBaseURL}/audio/transcriptions; `grok2api` uses POST {apiBaseURL}/stt.
 * Labels carry the path so the dropdown itself shows which endpoint is called.
 */
export type VoiceSttProvider = 'siliconflow' | 'openai' | 'groq' | 'grok2api'

export const VOICE_STT_PROVIDERS: {
  id: VoiceSttProvider
  name: string
  apiBaseURL: string
  model: string
}[] = [
  {
    id: 'siliconflow',
    name: 'SenseVoice（/audio/transcriptions）',
    apiBaseURL: 'https://api.siliconflow.cn/v1',
    model: 'FunAudioLLM/SenseVoiceSmall'
  },
  {
    id: 'openai',
    name: 'OpenAI（/audio/transcriptions）',
    apiBaseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini-transcribe'
  },
  {
    id: 'groq',
    name: 'Groq Whisper（/audio/transcriptions）',
    apiBaseURL: 'https://api.groq.com/openai/v1',
    model: 'whisper-large-v3-turbo'
  },
  {
    id: 'grok2api',
    name: 'grok2api（/stt）',
    apiBaseURL: 'http://127.0.0.1:8000/v1',
    model: 'grok-stt'
  }
]

export interface VoiceSttConfig {
  provider: VoiceSttProvider
  apiBaseURL: string
  apiKey: string
  model: string
  /** ISO-639-1 hint such as "zh" or "en"; empty lets the model auto-detect. */
  language: string
  extraHeaders: string
  proxyUrl: string
}

/** Energy based voice-activity detection used to cut the audio stream at pauses. */
export interface VoiceVadConfig {
  /** Frames louder than this (dBFS) count as speech. */
  thresholdDb: number
  /** Silence longer than this closes the current utterance. */
  silenceMs: number
  /** Speech shorter than this is ignored as noise. */
  minSpeechMs: number
  /** Hard cut so a long monologue still gets transcribed incrementally. */
  maxSegmentMs: number
}

export interface VoiceConfig {
  audioSource: VoiceAudioSource
  /** MediaDevices deviceId when audioSource is "microphone"; empty = system default. */
  audioDeviceId: string
  /** Application to listen to when audioSource is "system"; empty = the whole system mix. */
  audioAppId: string
  /** Display name of `audioAppId`, shown while that app is not running. */
  audioAppName: string
  stt: VoiceSttConfig
  /** "shared" reuses the active Provider group; "custom" uses `llm` below. */
  llmMode: VoiceLlmMode
  llm: ProviderConfig
  /** Overrides the built-in voice system prompt when non-empty. */
  answerPrompt: string
  vad: VoiceVadConfig
  /** Jump to the voice page when listening starts. */
  autoOpenPage: boolean
}

export interface AppConfig extends ProviderConfig, PromptConfig {
  autoCheckUpdate: boolean
  providerGroups: ProviderGroup[]
  promptGroups: PromptGroup[]
  activeProviderGroupId: string
  activePromptGroupId: string
  voice: VoiceConfig
}

export const defaultProviderConfig: ProviderConfig = {
  apiProvider: 'openai',
  apiBaseURL: '',
  apiKey: '',
  extraHeaders: '',
  model: '',
  proxyUrl: ''
}

export const defaultPromptConfig: PromptConfig = {
  codeLanguage: 'typescript',
  customPrompt: ''
}

export const defaultVoiceSttConfig: VoiceSttConfig = {
  provider: 'siliconflow',
  apiBaseURL: '',
  apiKey: '',
  model: '',
  language: '',
  extraHeaders: '',
  proxyUrl: ''
}

export const defaultVoiceVadConfig: VoiceVadConfig = {
  thresholdDb: -45,
  silenceMs: 800,
  minSpeechMs: 200,
  maxSegmentMs: 20000
}

export const defaultVoiceConfig: VoiceConfig = {
  audioSource: 'system',
  audioDeviceId: '',
  audioAppId: '',
  audioAppName: '',
  stt: { ...defaultVoiceSttConfig },
  llmMode: 'shared',
  llm: { ...defaultProviderConfig },
  answerPrompt: '',
  vad: { ...defaultVoiceVadConfig },
  autoOpenPage: true
}

export function createProviderGroup(
  index = 0,
  config: ProviderConfig = defaultProviderConfig
): ProviderGroup {
  return {
    id: `provider-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: `Provider 组 ${index + 1}`,
    ...config
  }
}

export function createPromptGroup(
  index = 0,
  config: PromptConfig = defaultPromptConfig
): PromptGroup {
  return {
    id: `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: `Prompt 组 ${index + 1}`,
    ...config
  }
}

export const defaultConfig: AppConfig = {
  ...defaultProviderConfig,
  ...defaultPromptConfig,
  autoCheckUpdate: true,
  providerGroups: [
    {
      id: 'provider-1',
      name: 'Provider 组 1',
      ...defaultProviderConfig
    }
  ],
  promptGroups: [
    {
      id: 'prompt-1',
      name: 'Prompt 组 1',
      ...defaultPromptConfig
    }
  ],
  activeProviderGroupId: 'provider-1',
  activePromptGroupId: 'prompt-1',
  voice: defaultVoiceConfig
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function normalizeProviderConfig(value: unknown, fallback: ProviderConfig): ProviderConfig {
  const source = isRecord(value) ? value : {}
  return {
    apiProvider:
      source.apiProvider === 'anthropic'
        ? 'anthropic'
        : source.apiProvider === 'openai'
          ? 'openai'
          : fallback.apiProvider,
    apiBaseURL: typeof source.apiBaseURL === 'string' ? source.apiBaseURL : fallback.apiBaseURL,
    apiKey: typeof source.apiKey === 'string' ? source.apiKey : fallback.apiKey,
    extraHeaders:
      typeof source.extraHeaders === 'string' ? source.extraHeaders : fallback.extraHeaders,
    model: typeof source.model === 'string' ? source.model : fallback.model,
    proxyUrl: typeof source.proxyUrl === 'string' ? source.proxyUrl : fallback.proxyUrl
  }
}

function normalizePromptConfig(value: unknown, fallback: PromptConfig): PromptConfig {
  const source = isRecord(value) ? value : {}
  return {
    codeLanguage:
      typeof source.codeLanguage === 'string' ? source.codeLanguage : fallback.codeLanguage,
    customPrompt:
      typeof source.customPrompt === 'string' ? source.customPrompt : fallback.customPrompt
  }
}

function normalizeProviderGroups(value: unknown, fallback: ProviderConfig): ProviderGroup[] {
  if (!Array.isArray(value)) return []
  const ids = new Set<string>()
  return value.slice(0, 12).reduce<ProviderGroup[]>((groups, item, index) => {
    if (!isRecord(item)) return groups
    const id =
      typeof item.id === 'string' && item.id && !ids.has(item.id)
        ? item.id
        : `provider-${index + 1}`
    if (ids.has(id)) return groups
    ids.add(id)
    groups.push({
      id,
      name:
        typeof item.name === 'string' && item.name.trim() ? item.name : `Provider 组 ${index + 1}`,
      ...normalizeProviderConfig(item, fallback)
    })
    return groups
  }, [])
}

function normalizePromptGroups(value: unknown, fallback: PromptConfig): PromptGroup[] {
  if (!Array.isArray(value)) return []
  const ids = new Set<string>()
  return value.slice(0, 12).reduce<PromptGroup[]>((groups, item, index) => {
    if (!isRecord(item)) return groups
    const id =
      typeof item.id === 'string' && item.id && !ids.has(item.id) ? item.id : `prompt-${index + 1}`
    if (ids.has(id)) return groups
    ids.add(id)
    groups.push({
      id,
      name:
        typeof item.name === 'string' && item.name.trim() ? item.name : `Prompt 组 ${index + 1}`,
      ...normalizePromptConfig(item, fallback)
    })
    return groups
  }, [])
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function inferSttProvider(apiBaseURL: string): VoiceSttProvider {
  const match = VOICE_STT_PROVIDERS.find(
    (provider) => provider.apiBaseURL && provider.apiBaseURL === apiBaseURL.trim()
  )
  if (match) return match.id
  // Unknown gateway (or the legacy `custom` value): it speaks the OpenAI-compatible path.
  return apiBaseURL.trim() ? 'openai' : defaultVoiceSttConfig.provider
}

function normalizeVoiceStt(value: unknown, fallback: VoiceSttConfig): VoiceSttConfig {
  const source = isRecord(value) ? value : {}
  const str = (key: Exclude<keyof VoiceSttConfig, 'provider'>) =>
    typeof source[key] === 'string' ? (source[key] as string) : fallback[key]
  const apiBaseURL = str('apiBaseURL')
  const provider = VOICE_STT_PROVIDERS.some((item) => item.id === source.provider)
    ? (source.provider as VoiceSttProvider)
    : inferSttProvider(apiBaseURL)
  return {
    provider,
    apiBaseURL,
    apiKey: str('apiKey'),
    model: str('model'),
    language: str('language'),
    extraHeaders: str('extraHeaders'),
    proxyUrl: str('proxyUrl')
  }
}

function normalizeVoiceVad(value: unknown, fallback: VoiceVadConfig): VoiceVadConfig {
  const source = isRecord(value) ? value : {}
  return {
    thresholdDb: clampNumber(source.thresholdDb, fallback.thresholdDb, -80, -10),
    silenceMs: clampNumber(source.silenceMs, fallback.silenceMs, 200, 5000),
    minSpeechMs: clampNumber(source.minSpeechMs, fallback.minSpeechMs, 50, 2000),
    maxSegmentMs: clampNumber(source.maxSegmentMs, fallback.maxSegmentMs, 3000, 120000)
  }
}

export function normalizeVoiceConfig(value: unknown): VoiceConfig {
  const source = isRecord(value) ? value : {}
  const fallback = defaultVoiceConfig
  return {
    audioSource: source.audioSource === 'microphone' ? 'microphone' : 'system',
    audioDeviceId:
      typeof source.audioDeviceId === 'string' ? source.audioDeviceId : fallback.audioDeviceId,
    audioAppId: typeof source.audioAppId === 'string' ? source.audioAppId : fallback.audioAppId,
    audioAppName:
      typeof source.audioAppName === 'string' ? source.audioAppName : fallback.audioAppName,
    stt: normalizeVoiceStt(source.stt, fallback.stt),
    llmMode: source.llmMode === 'custom' ? 'custom' : 'shared',
    llm: normalizeProviderConfig(source.llm, fallback.llm),
    answerPrompt:
      typeof source.answerPrompt === 'string' ? source.answerPrompt : fallback.answerPrompt,
    vad: normalizeVoiceVad(source.vad, fallback.vad),
    autoOpenPage:
      typeof source.autoOpenPage === 'boolean' ? source.autoOpenPage : fallback.autoOpenPage
  }
}

export function normalizeConfig(value: unknown): AppConfig {
  const source = isRecord(value) ? value : {}
  const legacyProvider = normalizeProviderConfig(source, defaultProviderConfig)
  const legacyPrompt = normalizePromptConfig(source, defaultPromptConfig)
  const providerGroups = normalizeProviderGroups(source.providerGroups, legacyProvider)
  const promptGroups = normalizePromptGroups(source.promptGroups, legacyPrompt)
  const normalizedProviderGroups = providerGroups.length
    ? providerGroups
    : [{ id: 'provider-1', name: 'Provider 组 1', ...legacyProvider }]
  const normalizedPromptGroups = promptGroups.length
    ? promptGroups
    : [{ id: 'prompt-1', name: 'Prompt 组 1', ...legacyPrompt }]
  const activeProviderGroupId =
    typeof source.activeProviderGroupId === 'string' &&
    normalizedProviderGroups.some((group) => group.id === source.activeProviderGroupId)
      ? source.activeProviderGroupId
      : normalizedProviderGroups[0].id
  const activePromptGroupId =
    typeof source.activePromptGroupId === 'string' &&
    normalizedPromptGroups.some((group) => group.id === source.activePromptGroupId)
      ? source.activePromptGroupId
      : normalizedPromptGroups[0].id
  const activeProvider = normalizedProviderGroups.find(
    (group) => group.id === activeProviderGroupId
  )!
  const activePrompt = normalizedPromptGroups.find((group) => group.id === activePromptGroupId)!
  const activeProviderConfig = {
    apiProvider: activeProvider.apiProvider,
    apiBaseURL: activeProvider.apiBaseURL,
    apiKey: activeProvider.apiKey,
    extraHeaders: activeProvider.extraHeaders,
    model: activeProvider.model,
    proxyUrl: activeProvider.proxyUrl
  }
  const activePromptConfig = {
    codeLanguage: activePrompt.codeLanguage,
    customPrompt: activePrompt.customPrompt
  }

  return {
    ...defaultConfig,
    ...activeProviderConfig,
    ...activePromptConfig,
    autoCheckUpdate:
      typeof source.autoCheckUpdate === 'boolean'
        ? source.autoCheckUpdate
        : defaultConfig.autoCheckUpdate,
    providerGroups: normalizedProviderGroups,
    promptGroups: normalizedPromptGroups,
    activeProviderGroupId,
    activePromptGroupId,
    voice: normalizeVoiceConfig(source.voice)
  }
}

/** The ProviderConfig slice of any settings-like object (used to reuse the active Provider group). */
export function pickProviderConfig(source: ProviderConfig): ProviderConfig {
  return {
    apiProvider: source.apiProvider,
    apiBaseURL: source.apiBaseURL,
    apiKey: source.apiKey,
    extraHeaders: source.extraHeaders,
    model: source.model,
    proxyUrl: source.proxyUrl
  }
}
