import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { defaultConfig, normalizeConfig, type AppConfig } from '../shared/settings'

export type { AppConfig } from '../shared/settings'

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
    return normalizeConfig(saved)
  } catch {
    return { ...defaultConfig }
  }
}

export function saveConfig(config: AppConfig): void {
  const configPath = getConfigPath()
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
}
