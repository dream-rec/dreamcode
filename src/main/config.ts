import { app } from 'electron'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { copyLegacyFile, recoveredSettingsWithCredentials } from './legacy-import'
import { writeJsonAtomic } from './json-file'
import { defaultConfig, normalizeConfig, type AppConfig } from '../shared/settings'

export type { AppConfig } from '../shared/settings'

function getConfigPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

function readConfigFile(configPath: string): AppConfig | null {
  try {
    return normalizeConfig(JSON.parse(readFileSync(configPath, 'utf-8')))
  } catch {
    return null
  }
}

export function loadConfig(): AppConfig {
  const configPath = getConfigPath()
  if (!existsSync(configPath)) {
    // Adopt a previous install's file as-is. Rewriting it here would drop fields
    // this version doesn't know about before the user has edited anything.
    const copied = copyLegacyFile('config.json', app.getPath('userData'))
    const adopted = copied ? readConfigFile(copied) : null
    if (adopted) return adopted
    const recovered = recoveredSettingsWithCredentials()
    if (recovered) {
      const normalized = normalizeConfig(recovered)
      writeJsonAtomic(configPath, normalized)
      return normalized
    }
    return { ...defaultConfig }
  }
  return readConfigFile(configPath) ?? { ...defaultConfig }
}

export function saveConfig(config: AppConfig): void {
  writeJsonAtomic(getConfigPath(), config)
}
