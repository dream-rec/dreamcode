import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface Settings {
  apiProvider: 'openai' | 'anthropic'
  apiBaseURL: string
  apiKey: string
  model: string
  customPrompt: string
  proxyUrl: string

  theme: 'light' | 'dark'
  opacity: number
  fontSize: number
  codeLanguage: string
}

interface SettingsStore extends Settings {
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void
  syncSettings: (settings: Partial<Settings>) => void
}

const defaultSettings: Settings = {
  apiProvider: 'openai',
  apiBaseURL: '',
  apiKey: '',
  model: '',
  customPrompt: '',
  proxyUrl: '',
  codeLanguage: '',

  theme: 'light',
  opacity: 0.8,
  fontSize: 14
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
