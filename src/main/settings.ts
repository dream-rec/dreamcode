import { ipcMain } from 'electron'
import { loadConfig, saveConfig, type AppConfig } from './config'

// Load settings from config file on startup
export const settings: AppSettings = {
  ...loadConfig(),
  opacity: 0.8
}

ipcMain.handle('getAppSettings', () => {
  return settings
})

ipcMain.handle('updateAppSettings', (_event, _settings) => {
  Object.assign(settings, _settings)
  // Persist to config file (only config fields, not UI-only fields like opacity)
  const configFields: AppConfig = {
    apiProvider: settings.apiProvider,
    apiBaseURL: settings.apiBaseURL,
    apiKey: settings.apiKey,
    model: settings.model,
    codeLanguage: settings.codeLanguage,
    customPrompt: settings.customPrompt
  }
  saveConfig(configFields)
})

export type AppSettings = AppConfig & {
  opacity: number
}
