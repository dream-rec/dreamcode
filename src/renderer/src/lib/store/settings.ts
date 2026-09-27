import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  defaultConfig,
  normalizeVoiceConfig,
  type ProviderGroup,
  type PromptGroup,
  type VoiceConfig
} from '../../../../shared/settings'

export type { ProviderGroup, PromptGroup, VoiceConfig }

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
  voice: VoiceConfig
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
  activePromptGroupId: defaultConfig.activePromptGroupId,
  voice: normalizeVoiceConfig(defaultConfig.voice)
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
      version: 8,
      migrate: (persisted: unknown) => {
        // v8 added the voice assistant block; keep everything else the user had.
        const state = (persisted ?? {}) as Partial<Settings>
        return { ...state, voice: normalizeVoiceConfig(state.voice) } as SettingsStore
      }
    }
  )
)
