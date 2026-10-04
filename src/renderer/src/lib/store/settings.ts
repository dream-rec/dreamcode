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

type AppearanceSettings = Pick<Settings, 'theme' | 'opacity' | 'fontSize'>
type MainSettings = Omit<Settings, keyof AppearanceSettings>
const LOCAL_APPEARANCE_KEYS = new Set(['theme', 'opacity', 'fontSize'])

interface SettingsStore extends Settings {
  updateSetting: <K extends keyof AppearanceSettings>(key: K, value: AppearanceSettings[K]) => void
  saveSettings: (settings: Partial<MainSettings>) => Promise<void>
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
    (set, get) => ({
      ...defaultSettings,
      updateSetting: (key, value) => {
        if (get()[key] !== value) set({ [key]: value })
      },
      saveSettings: async (settings) => {
        const saved = await window.api.updateAppSettings(settings)
        get().syncSettings(saved)
      },
      syncSettings: (settings) => {
        // Main notifications are inbound only. Keep local appearance and equal nested references.
        const current = get()
        const changes = Object.fromEntries(
          Object.entries(settings).filter(
            ([key, value]) =>
              Object.hasOwn(defaultSettings, key) &&
              !LOCAL_APPEARANCE_KEYS.has(key) &&
              JSON.stringify(current[key as keyof Settings]) !== JSON.stringify(value)
          )
        )
        if (Object.keys(changes).length) set(changes)
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
