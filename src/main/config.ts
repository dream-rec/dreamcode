import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface AppConfig {
  apiProvider: 'openai' | 'anthropic'
  apiBaseURL: string
  apiKey: string
  model: string
  codeLanguage: string
  customPrompt: string
}

const defaultConfig: AppConfig = {
  apiProvider: 'openai',
  apiBaseURL: '',
  apiKey: '',
  model: '',
  codeLanguage: 'typescript',
  customPrompt: ''
}

function getConfigPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

export function loadConfig(): AppConfig {
  const configPath = getConfigPath()
  if (!existsSync(configPath)) {
    return { ...defaultConfig }
  }
  try {
    const raw = readFileSync(configPath, 'utf-8')
    const saved = JSON.parse(raw)
    return { ...defaultConfig, ...saved }
  } catch {
    return { ...defaultConfig }
  }
}

export function saveConfig(config: AppConfig): void {
  const configPath = getConfigPath()
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
}
