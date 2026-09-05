import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { defaultConfig, type ProviderGroup, type PromptGroup } from '../../../../shared/settings'

export type { ProviderGroup, PromptGroup }

interface Settings {
  apiProvider: 'openai' | 'anthropic'
  apiBaseURL: string
  apiKey: string
  extraHeaders: string
  model: string
  customPrompt: string
  proxyUrl: string

  theme: 'light' | 'dark'
  opacity: number
  fontSize: number
  codeLanguage: string
  autoCheckUpdate: boolean
  providerGroups: ProviderGroup[]
  promptGroups: PromptGroup[]
  activeProviderGroupId: string
  activePromptGroupId: string
}

interface SettingsStore extends Settings {
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void
  syncSettings: (settings: Partial<Settings>) => void
}

const defaultSettings: Settings = {
  apiProvider: 'openai',
  apiBaseURL: '',
  apiKey: '',
  extraHeaders: '',
  model: '',
  customPrompt: '',
  proxyUrl: '',

  theme: 'light',
  opacity: 0.8,
  fontSize: 14,
  codeLanguage: 'typescript',
  autoCheckUpdate: true,
  providerGroups: defaultConfig.providerGroups.map((group) => ({ ...group })),
  promptGroups: defaultConfig.promptGroups.map((group) => ({ ...group })),
  activeProviderGroupId: defaultConfig.activeProviderGroupId,
  activePromptGroupId: defaultConfig.activePromptGroupId
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      ...defaultSettings,
      updateSetting: (key, value) => {
        set({ [key]: value })
      },
      syncSettings: (settings) => {
        set(settings)
      }
    }),
    {
      name: 'dreamcode-settings',
      version: 7
    }
  )
)
