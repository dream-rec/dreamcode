import { app } from 'electron'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { configHasCredentials } from '../shared/settings'
import {
  chooseNewestExisting,
  extractZustandStates,
  pickRecoveredStores,
  type RecoveredStores
} from '../shared/legacy-recover'

const LEGACY_DIR_NAMES = ['DreamCode', 'dreamcode', 'DreamCode-dev', 'dreamcode-dev']
const MAX_DUMP_BYTES = 32 * 1024 * 1024

function samePath(left: string, right: string): boolean {
  // Case-insensitive volumes report one real path for both spellings. Comparing the
  // strings alone would hide a real `dreamcode` directory from a new `DreamCode` path
  // on a case-sensitive disk.
  if (existsSync(left) && existsSync(right)) return realpathSync(left) === realpathSync(right)
  return left === right
}

function legacyDirs(): string[] {
  const root = dirname(app.getPath('userData'))
  return LEGACY_DIR_NAMES.map((name) => join(root, name))
}

export function findLegacyFile(fileName: string, destinationDir: string): string | null {
  const entries = legacyDirs().map((dir) => {
    const path = join(dir, fileName)
    if (!existsSync(path)) return null
    try {
      const stat = statSync(path)
      if (!stat.isFile() || stat.size <= 0) return null
      return { path, mtimeMs: stat.mtimeMs, sameAsDestination: samePath(dir, destinationDir) }
    } catch {
      return null
    }
  })
  return chooseNewestExisting(
    entries.filter((entry): entry is NonNullable<typeof entry> => !!entry)
  )
}

export function copyLegacyFile(fileName: string, destinationDir: string): string | null {
  const source = findLegacyFile(fileName, destinationDir)
  if (!source) return null
  const destination = join(destinationDir, fileName)
  if (samePath(source, destination)) return destination
  mkdirSync(destinationDir, { recursive: true })
  copyFileSync(source, destination)
  return destination
}

let recoveredCache: RecoveredStores | null = null

function levelDbDirs(): string[] {
  const dirs = new Set<string>([app.getPath('userData'), ...legacyDirs()])
  return [...dirs].map((dir) => join(dir, 'Local Storage', 'leveldb'))
}

export function recoverLegacyStores(): RecoveredStores {
  if (recoveredCache) return recoveredCache
  const payloads: unknown[] = []
  for (const dir of levelDbDirs()) {
    if (!existsSync(dir)) continue
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.log') && !name.endsWith('.ldb')) continue
      const path = join(dir, name)
      try {
        const stat = statSync(path)
        if (!stat.isFile() || stat.size === 0 || stat.size > MAX_DUMP_BYTES) continue
        payloads.push(...extractZustandStates(readFileSync(path)))
      } catch {
        // A locked or half-written dump must not block startup.
      }
    }
  }
  recoveredCache = pickRecoveredStores(payloads)
  return recoveredCache
}

export function recoveredSettingsWithCredentials(): unknown | null {
  const settings = recoverLegacyStores().settings
  return settings && configHasCredentials(settings) ? settings : null
}
