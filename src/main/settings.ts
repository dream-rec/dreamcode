import { ipcMain } from 'electron'
import { loadConfig, saveConfig } from './config'
import { normalizeConfig, type AppConfig } from '../shared/settings'

export type AppSettings = AppConfig & {
  opacity: number
}

let retireCapture: () => Promise<void> = async () => undefined
let settingsWrite: Promise<unknown> = Promise.resolve()

export function onCaptureTargetChange(handler: () => Promise<void>): void {
  retireCapture = handler
}

export const settings: AppSettings = {
  ...loadConfig(),
  opacity: 0.8
}

function saveCurrentSettings() {
  saveConfig(normalizeConfig(settings))
}

function notifySettingsChanged() {
  const mainWindow = global.mainWindow
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('app-settings-changed', settings)
}

function notifyGroupSwitched(type: 'Provider' | 'Prompt', name: string) {
  const mainWindow = global.mainWindow
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('group-switched', `已切换到${name || `${type} 组`}`)
}

export function activateProviderGroup(id: string): boolean {
  const group = settings.providerGroups.find((item) => item.id === id)
  if (!group) return false

  const providerConfig = {
    apiProvider: group.apiProvider,
    apiBaseURL: group.apiBaseURL,
    apiKey: group.apiKey,
    extraHeaders: group.extraHeaders,
    model: group.model,
    proxyUrl: group.proxyUrl
  }
  Object.assign(settings, providerConfig, { activeProviderGroupId: group.id })
  saveCurrentSettings()
  notifySettingsChanged()
  return true
}

export function activatePromptGroup(id: string): boolean {
  const group = settings.promptGroups.find((item) => item.id === id)
  if (!group) return false

  const promptConfig = {
    codeLanguage: group.codeLanguage,
    customPrompt: group.customPrompt
  }
  Object.assign(settings, promptConfig, { activePromptGroupId: group.id })
  saveCurrentSettings()
  notifySettingsChanged()
  return true
}

export function activateProviderGroupAt(index: number): boolean {
  const group = settings.providerGroups[index]
  if (!group || !activateProviderGroup(group.id)) return false
  notifyGroupSwitched('Provider', group.name)
  return true
}

export function activatePromptGroupAt(index: number): boolean {
  const group = settings.promptGroups[index]
  if (!group || !activatePromptGroup(group.id)) return false
  notifyGroupSwitched('Prompt', group.name)
  return true
}

ipcMain.handle('getAppSettings', () => settings)

ipcMain.handle('updateAppSettings', (_event, incoming: Partial<AppSettings>) => {
  const update = async (): Promise<AppSettings> => {
    const next = normalizeConfig({ ...settings, ...incoming })
    if (next.voice.audioAppId !== settings.voice.audioAppId) await retireCapture()
    Object.assign(settings, incoming)
    const activeProvider = settings.providerGroups.find(
      (group) => group.id === settings.activeProviderGroupId
    )
    if (activeProvider) {
      const providerConfig = {
        apiProvider: settings.apiProvider,
        apiBaseURL: settings.apiBaseURL,
        apiKey: settings.apiKey,
        extraHeaders: settings.extraHeaders,
        model: settings.model,
        proxyUrl: settings.proxyUrl
      }
      settings.providerGroups = settings.providerGroups.map((group) =>
        group.id === activeProvider.id ? { ...group, ...providerConfig } : group
      )
    }
    const activePrompt = settings.promptGroups.find(
      (group) => group.id === settings.activePromptGroupId
    )
    if (activePrompt) {
      const promptConfig = {
        codeLanguage: settings.codeLanguage,
        customPrompt: settings.customPrompt
      }
      settings.promptGroups = settings.promptGroups.map((group) =>
        group.id === activePrompt.id ? { ...group, ...promptConfig } : group
      )
    }
    Object.assign(settings, normalizeConfig(settings))
    saveCurrentSettings()
    notifySettingsChanged()
    return settings
  }
  const result = settingsWrite.then(update)
  settingsWrite = result.catch(() => undefined)
  return result
})

ipcMain.handle('activateProviderGroup', (_event, id: string) => activateProviderGroup(id))
ipcMain.handle('activatePromptGroup', (_event, id: string) => activatePromptGroup(id))
