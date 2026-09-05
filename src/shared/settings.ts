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

export interface AppConfig extends ProviderConfig, PromptConfig {
  autoCheckUpdate: boolean
  providerGroups: ProviderGroup[]
  promptGroups: PromptGroup[]
  activeProviderGroupId: string
  activePromptGroupId: string
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
  activePromptGroupId: 'prompt-1'
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
    activePromptGroupId
  }
}
